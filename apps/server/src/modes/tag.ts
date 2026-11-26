/**
 * Tag gamemode (docs/modes.md#tag). Server-authoritative: the shared
 * `TagGame` rules run here on the latest state packets of every
 * non-spectating player; clients only display the result.
 */
import type { MapRecordInfo, NetState, ScoreRow, ServerMessage, TagEvent, TagPos } from '@surf/shared';
import {
	buildSight,
	FLAG_DUCKED,
	FLAG_TELEPORTED,
	HUNT_RANGE,
	HuntTracker,
	mapCvars,
	MAX_VELOCITY_HARD,
	Status,
	TAG_MAX_SWEEP_MS,
	TAG_PAY,
	TAG_PODIUM,
	TagGame,
	tagPlacements,
	TICK_RATE,
	TimeMeter,
	type HuntBody,
	type TagGameOptions,
	type TagScore
} from '@surf/shared';
import type { Command } from '../commands.ts';
import type { ModeHost, ModePlayer, ServerMode } from './types.ts';
import { EMPTY_RECORDS } from './types.ts';

/** Mode state is re-sent at least this often (ms). */
export const MODE_STATE_MS = 1000;

/**
 * An IT this close to a runner (units) is trying to tag them: there is no swing
 * in tag, and a close chase between equally fast players is normal play.
 */
const ATTEMPT_RANGE = 64;
const ATTEMPT_HEIGHT = 72;

export type TagModeOptions = Pick<TagGameOptions, 'roundSecs' | 'intermissionSecs' | 'immunitySecs'>;

const fmtScore = (s: number) => `${s.toFixed(1)} s`;

export class TagMode implements ServerMode {
	readonly id = 'tag' as const;
	readonly game: TagGame;
	private lastSent = -Infinity;
	private readonly discontinuous = new Set<number>();
	private readonly poses = new Map<number, { state: NetState; at: number }>();
	private readonly maxVelocity: number;
	/** Chases of the running round (docs/economy.md#chase-and-view). */
	private readonly hunt: HuntTracker;
	/** By playerId: an id can go to someone else. */
	private readonly chased = new TimeMeter<string>(TAG_PAY.chased.everyMs);
	/** Time chased this round (ms), by playerId: placement. */
	private readonly chasedMs = new Map<string, number>();
	/** Id → playerId of everyone who has played the running round from its start. */
	private readonly starters = new Map<number, string>();
	/** PlayerIds that have been IT this round. */
	private readonly wasIt = new Set<string>();

	constructor(
		private readonly host: ModeHost,
		opts: TagModeOptions = {}
	) {
		const sight = buildSight(host.map);
		this.game = new TagGame({ ...opts, now: host.now(), rng: () => host.rng(), clearLine: sight.clear });
		this.hunt = new HuntTracker({ sight, chaseRange: HUNT_RANGE.tagChase });
		this.maxVelocity = Math.min(mapCvars(host.map).sv_maxvelocity, MAX_VELOCITY_HARD);
	}

	join(p: ModePlayer): void {
		this.tick(); // add the player to the rules (may start a countdown)
		this.host.send(p, this.stateMessage());
		this.host.systemTo(p, 'Tag: whoever is IT tags someone by touching them. Score = seconds you are not IT.');
	}

	leave(p: ModePlayer): void {
		this.poses.delete(p.id);
		this.tick();
	}

	spectate(p: ModePlayer): void {
		this.poses.delete(p.id);
		this.tick();
	}

	state(p: ModePlayer, s: NetState): void {
		const now = this.host.now();
		const before = this.poses.get(p.id);
		if (s.flags & FLAG_TELEPORTED) this.discontinuous.add(p.id);
		if (before) {
			const gap = now - before.at;
			const distance = Math.max(Math.abs(s.x - before.state.x), Math.abs(s.y - before.state.y), Math.abs(s.z - before.state.z));
			// Packets may arrive together. Allow a movement tick plus the clock resolution of the receipt times.
			const travel = (this.maxVelocity * Math.max(1000 / TICK_RATE, gap)) / 1000 + 8;
			if (distance > 0 && (gap > TAG_MAX_SWEEP_MS || distance > travel)) this.discontinuous.add(p.id);
		}
		this.poses.set(p.id, { state: s, at: now });
	}

	zone(): void {}

	records(): MapRecordInfo {
		return { ...EMPTY_RECORDS };
	}

	command(p: ModePlayer, cmd: Command): boolean {
		if (cmd.cmd !== 'top' && cmd.cmd !== 'pb') return false;
		const mine = this.game.scores().find((s) => s.id === p.id);
		this.host.systemTo(p, `No leaderboard in tag. Your score this round: ${fmtScore(mine?.score ?? 0)}.`);
		return true;
	}

	scoreRows(): ScoreRow[] {
		const rows: ScoreRow[] = [];
		for (const p of this.host.players()) {
			const it = !p.spectating && this.game.isIt(p.id);
			rows.push({
				id: p.id,
				name: p.name,
				rank: null,
				pbTicks: null,
				status: p.spectating ? Status.Spectating : it ? Status.Tagger : Status.Runner,
				stage: 0,
				ping: Math.round(p.ping),
				spectating: p.spectating,
				score: p.spectating ? 0 : this.game.score(p.id),
				it
			});
		}
		rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name));
		return rows;
	}

	tick(): void {
		const now = this.host.now();
		const active = new Map<number, TagPos | null>();
		const playing = new Map<number, ModePlayer>();
		for (const p of this.host.players()) {
			if (p.spectating) continue;
			playing.set(p.id, p);
			const s = p.state;
			const pose = this.poses.get(p.id);
			if (s && (!pose || now - pose.at > TAG_MAX_SWEEP_MS)) this.discontinuous.add(p.id);
			active.set(p.id, s ? { x: s.x, y: s.y, z: s.z, ducked: (s.flags & FLAG_DUCKED) !== 0 } : null);
		}
		const events = this.game.update(now, active, this.discontinuous);
		this.discontinuous.clear();
		// Leaving or spectating ends "played from the start", also when coming back.
		for (const [id, key] of this.starters) if (playing.get(id)?.playerId !== key) this.starters.delete(id);
		for (const e of events) {
			this.announce(e);
			this.pay(e, playing);
		}
		if (this.game.phase === 'playing') this.payChases(now, playing);
		if (events.length > 0 || now - this.lastSent >= MODE_STATE_MS) {
			this.lastSent = now;
			this.host.broadcast(this.stateMessage());
		}
	}

	/** Coins of a rules event (docs/economy.md#tag). */
	private pay(e: TagEvent, playing: ReadonlyMap<number, ModePlayer>): void {
		const eco = this.host.economy;
		switch (e.type) {
			case 'roundStart':
				eco.roundStart();
				this.hunt.reset();
				this.chased.reset();
				this.chasedMs.clear();
				this.wasIt.clear();
				this.starters.clear();
				for (const p of playing.values()) this.starters.set(p.id, p.playerId);
				break;
			case 'tag': {
				this.hunt.attempt(e.by);
				const target = playing.get(e.target);
				const key = target && (target.accountId !== null ? `a${target.accountId}` : `g${target.playerId}`);
				if (key && eco.tally(e.by, `tag:${key}`, 'round') === 1) eco.award(e.by, TAG_PAY.tag, 'tagTag', { against: e.target });
				eco.contact(e.by, e.target);
				break;
			}
			case 'roundEnd':
				this.payPlaces(e.ranking, playing);
				eco.roundEnd();
				break;
			case 'waiting': // cancelled: no placement
				eco.roundEnd();
				break;
		}
	}

	/** Placement among those who played the whole round and met the action. */
	private payPlaces(ranking: readonly TagScore[], playing: ReadonlyMap<number, ModePlayer>): void {
		const rows = [];
		for (const s of ranking) {
			const key = playing.get(s.id)?.playerId;
			if (key === undefined || this.starters.get(s.id) !== key) continue;
			const chasedMs = this.chasedMs.get(key) ?? 0;
			if (chasedMs < TAG_PAY.placeChasedMs && !this.wasIt.has(key)) continue;
			rows.push({ id: s.id, score: s.score, chasedMs });
		}
		for (const { id, base, place } of tagPlacements(rows)) this.host.economy.award(id, base, 'tagPlace', { label: `Place ${place}` });
	}

	/** Runners near an IT, and ITs that only stand by. */
	private payChases(now: number, playing: ReadonlyMap<number, ModePlayer>): void {
		const its: HuntBody[] = [];
		const runners: HuntBody[] = [];
		for (const p of playing.values()) {
			const it = this.game.isIt(p.id);
			if (it) this.wasIt.add(p.playerId);
			const s = p.state;
			if (!s) continue;
			const body = { id: p.id, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, ducked: (s.flags & FLAG_DUCKED) !== 0 };
			(it ? its : runners).push(body);
		}
		for (const a of its)
			if (runners.some((b) => Math.hypot(a.x - b.x, a.y - b.y) <= ATTEMPT_RANGE && Math.abs(a.z - b.z) <= ATTEMPT_HEIGHT)) this.hunt.attempt(a.id);
		const sample = this.hunt.update(now, its, runners);
		if (!sample) return;
		for (const [id, e] of sample.chased) {
			const key = playing.get(id)!.playerId;
			this.chasedMs.set(key, (this.chasedMs.get(key) ?? 0) + e.ms);
			if (this.chased.add(key, e.ms) > 0) this.host.economy.award(id, TAG_PAY.chased.points, 'tagChased', { against: e.by });
		}
		for (const { hunter, target } of sample.shadows) this.host.economy.report('shadow', [hunter, target], '20 s without a tag attempt');
	}

	stateMessage(): Extract<ServerMessage, { type: 'modeState' }> {
		const g = this.game;
		const now = this.host.now();
		return {
			type: 'modeState',
			mode: 'tag',
			phase: g.phase,
			round: g.round,
			timeLeft: Math.round(g.timeLeft(now) * 10) / 10,
			it: g.it,
			immune: g.immune(now),
			scores: g.scores()
		};
	}

	private name(id: number): string {
		for (const p of this.host.players()) if (p.id === id) return p.name;
		return `Player ${id}`;
	}

	private announce(e: TagEvent): void {
		const h = this.host;
		switch (e.type) {
			case 'waiting':
				if (e.cancelled) h.system('Not enough players: round cancelled. Tag needs 2+ players.');
				break;
			case 'countdown':
				h.system(`Next tag round starts in ${Math.round((e.endsAt - h.now()) / 1000)} s.`);
				break;
			case 'roundStart': {
				const names = e.it.map((id) => this.name(id)).join(' and ');
				h.system(`Round ${e.round}: ${names} ${e.it.length > 1 ? 'are' : 'is'} IT! Run!`);
				h.log(`tag round ${e.round} it=${e.it.join(',')}`);
				break;
			}
			case 'tag':
				h.broadcast({ type: 'tagged', by: e.by, target: e.target });
				h.system(`${this.name(e.by)} tagged ${this.name(e.target)}. ${this.name(e.target)} is IT!`);
				break;
			case 'newIt':
				h.system(`${this.name(e.id)} is now IT.`);
				break;
			case 'roundEnd': {
				const top = e.ranking.slice(0, TAG_PODIUM).map((s, i) => `${i + 1}. ${this.name(s.id)} ${fmtScore(s.score)}`);
				h.system(`Round ${e.round} over! ${top.join('  ')}`);
				h.log(`tag round ${e.round} end`);
				break;
			}
		}
	}

	dispose(): void {}
}
