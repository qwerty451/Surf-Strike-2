/**
 * Race gamemodes (surf, bhop): client-run timer and zones, server run
 * validation, personal bests and the per-map leaderboard (docs/gameplay.md).
 */
import { promisify } from 'node:util';
import { deflateRaw } from 'node:zlib';
import type { GameModeId, GhostTrack, MapRecordInfo, NetState, ScoreRow, ServerMessage } from '@surf/shared';
import { decayed, encodeGhostFrame, formatTicks, GhostRecorder, packGhost, RACE_PAY, raceFinish, RECORDS_TOP, REPEAT_MS, sanitizeLoadout, Status } from '@surf/shared';
import type { Db } from '../db.ts';
import type { Command } from '../commands.ts';
import { RunValidator } from '../validation.ts';
import type { ModeHost, ModePlayer, ServerMode, ZoneKind } from './types.ts';

const deflate = promisify(deflateRaw);
const replayQueues = new WeakMap<Db, Map<string, Promise<void>>>();

export async function flushRaceReplays(db: Db): Promise<void> {
	await Promise.all(replayQueues.get(db)?.values() ?? []);
}

export class RaceMode implements ServerMode {
	readonly id: GameModeId;
	private readonly validators = new Map<number, RunValidator>();
	private ranksCache: Map<number, { rank: number; ticks: number }> | null = null;
	/** Ghost recording per player, from the state packets validation sees (docs/gameplay.md#ghosts). */
	private readonly recorders = new Map<number, GhostRecorder>();
	/** Encoded BIN_GHOST frame for this map (undefined = not loaded yet). */
	private ghostFrame: Uint8Array | undefined;

	constructor(private readonly host: ModeHost) {
		this.id = host.map.kind;
	}

	join(p: ModePlayer): void {
		this.validators.set(p.id, new RunValidator(this.host.map));
		this.recorders.set(p.id, new GhostRecorder());
	}

	leave(p: ModePlayer): void {
		this.validators.delete(p.id);
		this.recorders.delete(p.id);
	}

	spectate(p: ModePlayer): void {
		this.validators.get(p.id)?.cancel();
		this.recorders.get(p.id)?.cancel();
	}

	state(p: ModePlayer, s: NetState): void {
		this.validators.get(p.id)?.onState(s);
		// Only timed ticks: the start-zone wait and finish delay are never recorded.
		if (s.status === Status.Running || s.status === Status.Finished) {
			this.recorders.get(p.id)?.push(s.tick, s.x, s.y, s.z, s.pitch, s.yaw, s.flags);
		}
	}

	/** `getGhost`: the record ghost for this map, or a "none" frame. */
	ghost(p: ModePlayer, map: string): void {
		const h = this.host;
		if (map !== h.map.id) {
			h.sendBinary(p, new Uint8Array(encodeGhostFrame({ map, name: '', ticks: 0, samples: 0 }, null)));
			return;
		}
		h.sendBinary(p, this.loadGhostFrame());
		const look = this.ghostLook();
		if (look) h.send(p, look);
	}

	/** What the ghost's holder wears now; null without a ghost. */
	private ghostLook(): ServerMessage | null {
		const r = this.host.db.getReplay(this.host.map.id);
		return r && { type: 'ghostLook', map: this.host.map.id, loadout: sanitizeLoadout(this.host.db.equipped(r.accountId)) };
	}

	private loadGhostFrame(): Uint8Array {
		if (this.ghostFrame) return this.ghostFrame;
		const map = this.host.map.id;
		const r = this.host.db.getReplay(map);
		this.ghostFrame = new Uint8Array(
			encodeGhostFrame(
				{ map, name: r?.name ?? '', ticks: r?.ticks ?? 0, samples: r?.samples ?? 0 },
				r ? new Uint8Array(r.data) : null
			)
		);
		return this.ghostFrame;
	}

	/** Save in finish order per map, including across rotations. */
	private saveGhostAsync(name: string, accountId: number, ticks: number, track: GhostTrack): void {
		const h = this.host;
		const mapId = h.map.id;
		let queue = replayQueues.get(h.db);
		if (!queue) replayQueues.set(h.db, queue = new Map());
		const saved = (queue.get(mapId) ?? Promise.resolve()).then(async () => {
			const existing = h.db.getReplay(mapId);
			if (existing && existing.ticks <= ticks) return;
			const data = await deflate(packGhost(track), { level: 6 });
			if (h.db.saveReplay(mapId, accountId, ticks, track.length, data, Date.now())) {
				h.replaySaved?.(mapId);
				h.log(`ghost ${mapId} ${name} ${formatTicks(ticks)} ${track.length} samples ${data.length} B`);
			}
		}).catch((err: Error) => h.log(`ghost save error ${mapId} ${name}: ${err.message}`));
		queue.set(mapId, saved);
		void saved.then(() => {
			if (queue.get(mapId) === saved) queue.delete(mapId);
		});
	}

	replayChanged(): void {
		this.ghostFrame = undefined;
		this.host.broadcastBinary(this.loadGhostFrame());
		const look = this.ghostLook();
		if (look) this.host.broadcast(look);
	}

	zone(p: ModePlayer, kind: ZoneKind, index: number, tick: number): void {
		const v = this.validators.get(p.id);
		if (p.spectating || !v) return;
		const h = this.host;
		const verdict = v.onZone(kind, index, tick, h.now());
		const rec = this.recorders.get(p.id);
		if (kind === 'start') rec?.start(tick);
		const track = kind === 'end' ? (rec?.finish(tick) ?? null) : null;
		if (!verdict) return;
		if (!verdict.ok) {
			h.send(p, { type: 'runRejected', reason: verdict.reason });
			h.systemTo(p, `Run not saved: ${verdict.reason}.`);
			h.log(`run rejected #${p.id} ${p.name}: ${verdict.reason}`);
			return;
		}
		const map = h.map;
		const time = formatTicks(verdict.ticks);
		// Leaderboard integrity: only logged-in accounts save runs.
		if (p.accountId === null) {
			h.guestRunNotice(p, `Finished in ${time} (guest run, not saved).`);
			h.log(`guest run #${p.id} ${p.name} ${map.id} ${time}`);
			h.economy.award(p.id, raceFinish(map), 'raceFinish'); // shows the login hint
			return;
		}
		const prevRecord = h.db.top(map.id, 1)[0] ?? null;
		const firstEver = h.db.getPb(p.accountId, map.id) === null;
		const saved = h.db.saveRun(p.accountId, map.id, verdict.ticks, verdict.splits, Date.now());
		if (saved.pb) this.ranksCache = null;
		const record = saved.pb && (!prevRecord || verdict.ticks < prevRecord.ticks);
		const rank = h.db.rankFor(map.id, verdict.ticks);
		const resultMsg: ServerMessage = {
			type: 'runResult',
			ticks: verdict.ticks,
			rank,
			pb: saved.pb,
			record,
			splits: verdict.splits,
			records: this.records(p)
		};
		h.send(p, resultMsg);
		const existingReplay = track ? h.db.getReplay(map.id) : null;
		if (track && (!existingReplay || verdict.ticks < existingReplay.ticks)) {
			this.saveGhostAsync(p.name, p.accountId, verdict.ticks, track);
		}
		// The leaderboard changed: everyone else's map record and own rank may be stale.
		if (saved.pb) this.pushRecords(p);
		if (record) {
			h.system(`${p.name} set a new map record on ${map.title}: ${time}!`);
		} else if (saved.pb) {
			const total = h.db.countRuns(map.id);
			h.system(`${p.name} finished in ${time} (new PB, rank ${rank}/${total}).`);
		} else {
			h.systemTo(p, `Finished in ${time}. PB: ${formatTicks(saved.previous ?? verdict.ticks)}.`);
		}
		h.log(`run #${p.id} ${p.name} ${map.id} ${time} pb=${saved.pb} record=${record}`);
		this.pay(p, {
			firstEver,
			pb: saved.pb && !firstEver,
			beatsOther: record && prevRecord !== null && prevRecord.accountId !== p.accountId
		});
	}

	/** Coins for a validated account run (docs/economy.md#race-modes). */
	private pay(p: ModePlayer, run: { firstEver: boolean; pb: boolean; beatsOther: boolean }): void {
		const { economy, map } = this.host;
		const finish = raceFinish(map);
		const before = economy.tally(p.id, 'finish', 'session') - 1;
		const repeats = Math.max(before, economy.paidWithin(p.id, 'raceFinish', REPEAT_MS));
		economy.award(p.id, decayed(finish, RACE_PAY.repeat, repeats), 'raceFinish');
		if (run.firstEver) economy.award(p.id, finish, 'raceFirst');
		if (run.pb) {
			const n = Math.max(economy.tally(p.id, 'pb', 'session') - 1, economy.paidWithin(p.id, 'racePb', REPEAT_MS));
			economy.award(p.id, decayed(RACE_PAY.personalBest, RACE_PAY.personalBestRepeat, n), 'racePb');
		}
		if (run.beatsOther) {
			const since = economy.sinceLastPaid(p.id, 'raceRecord');
			if (since === null || since >= RACE_PAY.recordEveryMs) economy.award(p.id, RACE_PAY.record[map.difficulty], 'raceRecord');
		}
	}

	/** Send every other player on the map their current records (after a PB changed the leaderboard). */
	private pushRecords(except: ModePlayer): void {
		const h = this.host;
		for (const o of h.players()) {
			if (o.id !== except.id) h.send(o, { type: 'records', map: h.map.id, records: this.records(o) });
		}
	}

	records(p: ModePlayer): MapRecordInfo {
		const { db, map } = this.host;
		const pb = p.accountId === null ? null : db.getPb(p.accountId, map.id);
		const top = db.top(map.id, RECORDS_TOP);
		const rec = top[0] ?? null;
		// Ties share the better rank, as in db.rankFor; `top` is sorted by time.
		const rankOf = (ticks: number) => top.findIndex((r) => r.ticks === ticks) + 1;
		return {
			pbTicks: pb?.ticks ?? null,
			pbSplits: pb?.splits ?? null,
			rank: pb ? db.rankFor(map.id, pb.ticks) : null,
			recordTicks: rec?.ticks ?? null,
			recordName: rec?.name ?? null,
			top: top.map((r) => ({
				rank: rankOf(r.ticks),
				name: r.name,
				ticks: r.ticks,
				...(r.accountId === p.accountId ? { self: true } : {})
			}))
		};
	}

	command(p: ModePlayer, cmd: Command): boolean {
		const { db, map } = this.host;
		const h = this.host;
		switch (cmd.cmd) {
			case 'top': {
				const rows = db.top(map.id, 10);
				if (rows.length === 0) {
					h.systemTo(p, `No times on ${map.title} yet.`);
					return true;
				}
				h.systemTo(p, `Top ${rows.length} on ${map.title}:`);
				rows.forEach((r, i) => h.systemTo(p, `${i + 1}. ${r.name}  ${formatTicks(r.ticks)}`));
				return true;
			}
			case 'pb': {
				if (p.accountId === null) {
					h.systemTo(p, 'Guests have no PBs. Log in to save runs to the leaderboard.');
					return true;
				}
				const pb = db.getPb(p.accountId, map.id);
				if (!pb) {
					h.systemTo(p, `No PB on ${map.title} yet.`);
					return true;
				}
				const rank = db.rankFor(map.id, pb.ticks);
				const total = db.countRuns(map.id);
				h.systemTo(p, `Your PB on ${map.title}: ${formatTicks(pb.ticks)} (rank ${rank}/${total}).`);
				return true;
			}
			default:
				return false;
		}
	}

	scoreRows(): ScoreRow[] {
		if (!this.ranksCache) this.ranksCache = this.host.db.ranks(this.host.map.id);
		const ranks = this.ranksCache;
		const rows: ScoreRow[] = [];
		for (const p of this.host.players()) {
			const r = p.accountId === null ? undefined : ranks.get(p.accountId);
			rows.push({
				id: p.id,
				name: p.name,
				rank: r?.rank ?? null,
				pbTicks: r?.ticks ?? null,
				status: p.spectating ? Status.Spectating : (p.state?.status ?? Status.Idle),
				stage: p.state?.stage ?? 0,
				ping: Math.round(p.ping),
				spectating: p.spectating
			});
		}
		rows.sort((a, b) => {
			if (a.pbTicks === null && b.pbTicks === null) return a.name.localeCompare(b.name);
			if (a.pbTicks === null) return 1;
			if (b.pbTicks === null) return -1;
			return a.pbTicks - b.pbTicks;
		});
		return rows;
	}

	tick(): void {}

	dispose(): void {
		this.validators.clear();
		this.recorders.clear();
	}
}
