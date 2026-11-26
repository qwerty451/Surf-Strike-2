/**
 * Zombie Run gamemode, id `zombies` (docs/modes.md#zombies). Server-authoritative: the shared
 * `ZombiesGame` (round flow, zombie AI on the real movement code, weapons,
 * lag-compensated hits, player health) runs here on the latest state packets;
 * clients send `fire`/`reload`/`loadout` and display the results.
 */
import type { MapRecordInfo, NetState, ScoreRow, ServerMessage, SnapshotEntry, ZmEvent } from '@surf/shared';
import {
	buildCollisionWorld,
	decayed,
	encodeZombies,
	FLAG_DUCKED,
	FLAG_TELEPORTED,
	mapCvars,
	REPEAT_MS,
	Status,
	WEAPONS,
	WEAPON_IDS,
	ZombiesGame,
	ZM_HISTORY_MS,
	ZOMBIE_HP,
	ZOMBIES_PAY,
	zmEventRoute,
	type ZombieNet,
	type ZombiesGameOptions
} from '@surf/shared';
import type { Command } from '../commands.ts';
import type { ModeClientMessage, ModeHost, ModePlayer, ServerMode } from './types.ts';
import { EMPTY_RECORDS, renderRewindMs } from './types.ts';

/** Mode state is re-sent at least this often (ms), and at most this often on changes. */
export const ZM_STATE_MS = 1000;
export const ZM_STATE_MIN_MS = 250;

export type ZombiesModeOptions = Pick<ZombiesGameOptions, 'countdownSecs' | 'endSecs' | 'maxZombies' | 'spawnIntervalScale'>;


interface ZombieFrameTime {
	tick: number;
	at: number;
}

const LOADOUT_HINT = WEAPON_IDS.map((w) => `${WEAPONS[w].slot} ${WEAPONS[w].label}`).join(' · ');

function clock(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = secs - m * 60;
	return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export class ZombiesMode implements ServerMode {
	readonly id = 'zombies' as const;
	readonly game: ZombiesGame;
	private lastSent = -Infinity;
	private dirty = true;
	private readonly zombieFrameTimes: ZombieFrameTime[] = [];

	constructor(
		private readonly host: ModeHost,
		opts: ZombiesModeOptions = {}
	) {
		const map = host.map;
		this.game = new ZombiesGame({
			...opts,
			map,
			world: buildCollisionWorld(map),
			cvars: mapCvars(map),
			now: host.now(),
			rng: () => host.rng(),
			lenient: true,
			relayedPlayerHistory: true
		});
	}

	join(p: ModePlayer): void {
		this.tick();
		this.host.send(p, this.stateMessage());
		this.host.systemTo(
			p,
			`Zombie Run: open the gates zone by zone (half the survivors in the glowing area starts a 30 s countdown) and reach the evac boat. If you go down you turn into a zombie. Weapon (while the loadout is open): ${LOADOUT_HINT}. R reloads.`
		);
	}

	leave(): void {
		this.tick();
	}

	spectate(): void {
		this.tick();
	}

	state(p: ModePlayer, s: NetState): void {
		this.game.setPlayerPos(p.id, { x: s.x, y: s.y, z: s.z, ducked: (s.flags & FLAG_DUCKED) !== 0, yaw: s.yaw }, (s.flags & FLAG_TELEPORTED) !== 0);
	}

	snapshot(entries: readonly SnapshotEntry[]): void {
		this.game.recordPlayerSnapshot(entries);
	}

	zone(): void {}

	records(): MapRecordInfo {
		return { ...EMPTY_RECORDS };
	}

	/** fire / reload / loadout from a player. */
	message(p: ModePlayer, msg: ModeClientMessage): void {
		if (p.spectating || !this.game.hasPlayer(p.id)) return;
		const now = this.host.now();
		switch (msg.type) {
			case 'fire': {
				const serverNow = this.host.serverNow?.() ?? now;
				const timing = this.shotTiming(msg, serverNow, p);
				const res = this.game.fire(p.id, { weapon: msg.weapon, origin: msg.origin, dir: msg.dir, ...timing }, now);
				this.dispatch(res.events);
				return;
			}
			case 'reload':
				this.game.reload(p.id, now);
				return;
			case 'loadout':
				this.dispatch(this.game.loadout(p.id, msg.weapon, now));
				this.dirty = true;
				return;
		}
	}

	private shotTiming(msg: Extract<ModeClientMessage, { type: 'fire' }>, now: number, p: ModePlayer): { tick: number; playerRenderTime: number } {
		const requested = Number.isFinite(msg.tick) ? this.zombieFrameValue('tick', msg.tick) : undefined;
		const rewind = renderRewindMs(msg.renderServerTimeMs, now, p, ZM_HISTORY_MS, now - (requested ?? now));
		const playerRenderTime = now - rewind;
		const tick = rewind === 0 ? this.game.tick : this.zombieFrameValue('at', playerRenderTime) ?? this.game.tick;
		return { tick, playerRenderTime };
	}

	/** Interpolate between actual BIN_ZOMBIES send times and their fractional sim ticks. */
	private zombieFrameValue(key: keyof ZombieFrameTime, value: number): number | undefined {
		const other = key === 'tick' ? 'at' : 'tick';
		const frames = this.zombieFrameTimes;
		const first = frames[0];
		if (!first || value <= first[key]) return first?.[other];
		for (let i = 1; i < frames.length; i++) {
			const b = frames[i]!;
			if (b[key] < value) continue;
			const a = frames[i - 1]!;
			const f = (value - a[key]) / (b[key] - a[key]);
			return a[other] + (b[other] - a[other]) * f;
		}
		return frames.at(-1)?.[other];
	}

	command(p: ModePlayer, cmd: Command): boolean {
		if (cmd.cmd !== 'top' && cmd.cmd !== 'pb') return false;
		const v = this.game.playerView(p.id);
		this.host.systemTo(p, `No leaderboard in Zombie Run. This round: ${v?.kills ?? 0} kills, ${v?.deaths ?? 0} downs.`);
		return true;
	}

	scoreRows(): ScoreRow[] {
		const rows: ScoreRow[] = [];
		for (const p of this.host.players()) {
			const v = p.spectating ? null : this.game.playerView(p.id);
			rows.push({
				id: p.id,
				name: p.name,
				rank: null,
				pbTicks: null,
				status: p.spectating || !v ? Status.Spectating : v.team === 'survivor' ? Status.Alive : Status.Down,
				stage: this.game.checkpoint,
				ping: Math.round(p.ping),
				spectating: p.spectating,
				kills: v?.kills ?? 0,
				deaths: v?.deaths ?? 0
			});
		}
		rows.sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0) || a.name.localeCompare(b.name));
		return rows;
	}

	/** Dead players wait for their respawn. */
	stillness(p: ModePlayer): 'held' | null {
		const v = this.game.playerView(p.id);
		return v && !v.alive ? 'held' : null;
	}

	tick(): void {
		const now = this.host.now();
		const ids: number[] = [];
		for (const p of this.host.players()) if (!p.spectating) ids.push(p.id);
		this.game.syncPlayers(ids, now);
		this.dispatch(this.game.update(now));
		if ((this.dirty && now - this.lastSent >= ZM_STATE_MIN_MS) || now - this.lastSent >= ZM_STATE_MS) {
			this.lastSent = now;
			this.dirty = false;
			this.host.broadcast(this.stateMessage());
		}
		this.sendZombies();
	}

	/** BIN_ZOMBIES snapshot (every mode tick, 32 Hz; droppable under backlog like player snapshots). */
	sendZombies(now = this.host.serverNow?.() ?? this.host.now()): void {
		const g = this.game;
		if (g.zombies.size === 0 && g.phase !== 'playing' && g.phase !== 'ended') return;
		const times = this.zombieFrameTimes;
		if (times.at(-1)?.tick !== g.tick) {
			times.push({ tick: g.tick, at: now });
			while (times.length > 2 && times[1]!.at < now - ZM_HISTORY_MS) times.shift();
		}
		const list: ZombieNet[] = [];
		for (const z of g.zombies.values()) {
			const o = z.body.origin;
			list.push({ id: z.id, x: o.x, y: o.y, z: o.z, yaw: z.yaw, flags: g.zombieFlags(z), hp: Math.max(0, z.hp) / ZOMBIE_HP });
		}
		this.host.broadcastBinary(encodeZombies(g.tick, list, now), true);
	}

	stateMessage(): Extract<ServerMessage, { type: 'modeState' }> {
		return { type: 'modeState', mode: 'zombies', ...this.game.view(this.host.now()) };
	}

	private name(id: number): string {
		for (const p of this.host.players()) if (p.id === id) return p.name;
		return `Player ${id}`;
	}

	private dispatch(events: ZmEvent[]): void {
		const h = this.host;
		for (const ev of events) {
			if (ev.e === 'pass') {
				this.payGate(ev.id, ev.index + 1);
				continue;
			}
			const route = zmEventRoute(ev);
			const msg: ServerMessage = { type: 'zm', ev };
			if (route.to !== undefined) {
				for (const p of h.players()) if (p.id === route.to) h.send(p, msg);
			} else if (route.except !== undefined) {
				h.broadcast(msg, route.except);
			} else h.broadcast(msg);
			this.announce(ev);
		}
	}

	// ---------------------------------------------------------------------
	// Coins (docs/economy.md#zombie-run). The tallies are per person, so leaving
	// and coming back does not pay a gate twice or undo being turned.

	/** Base after the repeat decay of one award: this map session, and the last hour on this map. */
	private decayedFor(id: number, base: number, key: string, reason: 'zombiesGate' | 'zombiesEvac', label?: string): number {
		const e = this.host.economy;
		const repeats = Math.max(e.tally(id, key, 'session') - 1, e.paidWithin(id, reason, REPEAT_MS, label));
		return decayed(base, ZOMBIES_PAY.repeat, repeats);
	}

	/** Turned in this round: someone who comes back as a survivor (reconnect, spectate) earns nothing for it. */
	private wasTurned(id: number): boolean {
		return this.host.economy.tallied(id, 'turned', 'round') > 0;
	}

	private payGate(id: number, n: number): void {
		const e = this.host.economy;
		if (this.wasTurned(id) || e.tally(id, `gate${n}`, 'round') > 1) return;
		e.tally(id, 'gates', 'round');
		const label = `Gate ${n}`;
		e.award(id, this.decayedFor(id, ZOMBIES_PAY.gate(n), `gate${n}`, 'zombiesGate', label), 'zombiesGate', { label });
	}

	/** Every living survivor who passed the last gate and enough of the others. */
	private payEvac(): void {
		const e = this.host.economy;
		const gates = this.host.map.zombies?.gates.length ?? 0;
		for (const p of this.host.players()) {
			const v = p.spectating ? null : this.game.playerView(p.id);
			if (!v?.alive || v.team !== 'survivor' || this.wasTurned(p.id)) continue;
			if (gates > 0 && e.tallied(p.id, `gate${gates}`, 'round') === 0) continue;
			if (e.tallied(p.id, 'gates', 'round') < gates * ZOMBIES_PAY.evacShare) continue;
			// An account connected twice is evacuated once.
			if (e.tally(p.id, 'evac', 'round') > 1) continue;
			e.award(p.id, this.decayedFor(p.id, ZOMBIES_PAY.evac(gates), 'evac', 'zombiesEvac'), 'zombiesEvac');
		}
	}

	/** A survivor went down, `by` a player-zombie or not. Each survivor pays once per round. */
	private payTurned(id: number, by: number | undefined): void {
		const e = this.host.economy;
		const first = e.tally(id, 'turned', 'round') === 1;
		if (by === undefined) return;
		e.contact(by, id);
		if (first) e.award(by, ZOMBIES_PAY.turnedKill, 'zombiesKill', { against: id });
	}

	private announce(ev: ZmEvent): void {
		const h = this.host;
		const g = this.game;
		switch (ev.e) {
			case 'phase':
				this.dirty = true;
				if (ev.phase === 'playing') h.economy.roundStart();
				else if (ev.phase === 'waiting') h.economy.roundEnd();
				if (ev.phase === 'countdown')
					h.system(`Round ${ev.round} starts in ${Math.round(g.view(h.now()).timeLeft)} s. Pick a weapon: ${LOADOUT_HINT}.`);
				else if (ev.phase === 'playing')
					h.system(`Round ${ev.round}: reach the evac point at the end of the route (${g.checkpoints.length} checkpoints). Go!`);
				break;
			case 'checkpoint':
				this.dirty = true;
				h.system(`${this.name(ev.by)} reached checkpoint ${ev.index}/${g.checkpoints.length}. Survivors healed and resupplied.`);
				break;
			case 'down':
				this.dirty = true;
				this.payTurned(ev.id, ev.by);
				h.system(
					`${this.name(ev.id)} ${ev.by !== undefined ? `was caught by ${this.name(ev.by)} and ` : ''}turned! They hunt the survivors for the rest of the round.`
				);
				break;
			case 'gate':
				this.dirty = true;
				if (ev.state === 'counting') h.system(`Gate ${ev.index + 1} opens in ${ev.secs} s. Hold out!`);
				else if (ev.state === 'open')
					h.system(ev.index === g.view(h.now()).gates.length - 1 ? `Gate ${ev.index + 1} is open: get to the evac boat!` : `Gate ${ev.index + 1} is open!`);
				break;
			case 'hurt':
			case 'kill':
				this.dirty = true;
				break;
			case 'end': {
				this.dirty = true;
				if (ev.won) this.payEvac();
				h.economy.roundEnd();
				const top = ev.topId !== null ? `, top killer ${this.name(ev.topId)} (${ev.topKills})` : '';
				h.system(
					ev.won
						? `Evacuated! ${ev.by !== null ? `${this.name(ev.by)} reached the boat. ` : ''}Round ${ev.round} won in ${clock(ev.secs)}: ${ev.kills} kills${top}.`
						: `Overrun! Round ${ev.round} lost after ${clock(ev.secs)}: ${ev.kills} kills${top}.`
				);
				h.log(`zombies round ${ev.round} ${ev.won ? 'won' : 'lost'} ${ev.secs}s kills=${ev.kills}`);
				break;
			}
		}
	}

	dispose(): void {}
}

