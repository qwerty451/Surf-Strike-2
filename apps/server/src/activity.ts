/**
 * Who is really playing (docs/economy.md#player-multiplier, #playtime), worked
 * out from the state packets alone; no client flag can add activity.
 *
 * - **Active** (multiplier, minimum counts, awards): moved by itself in the
 *   last 30 s. A mode can hold the clock (`stillness` 'held': frozen,
 *   respawning) or let looking around count ('look': hiders).
 * - **Input** (playtime): varied input in the last 3 minutes. View movements,
 *   changes of run direction and ducks become tokens; a pair of tokens that
 *   was already seen in the last 10 minutes is not new input, so a held key
 *   makes no tokens and a looping macro no new ones.
 * - **Suspect**: an impossible speed or a teleport to nowhere the map or the
 *   mode sends players blocks awards for 5 s.
 *
 * All times come from the caller's clock; `tick` adds them up, so a stalled
 * process never adds a long stretch.
 */
import type { MapDef, NetState } from '@surf/shared';
import { ACTIVITY, ABUSE, FLAG_DUCKED, FLAG_ON_GROUND, FLAG_TELEPORTED, teleportSeq, TICK_RATE } from '@surf/shared';

/** How a mode explains that a player is not moving. */
export type Stillness = 'held' | 'look' | null;

/** Longest stretch one tick may add (ms). */
const MAX_STEP_MS = 5_000;
/** Horizontal distance that counts as having moved. */
const MOVE_DIST = 24;
/** View movement (degrees, added up) that counts as looking around. */
const LOOK_DEG = 10;
/** Waiting for the first state packet on a new map holds the clock this long at most. */
const MAP_GRACE_MS = 15_000;
/** A teleport announced by the mode is expected this long. */
const EXPECT_TELEPORT_MS = 4_000;
/** Landing this close to a known spawn or destination is a normal teleport. */
const KNOWN_POINT_DIST = 200;
/** A token pair counts as seen for this long, and at most this many are kept. */
const SEEN_MS = 10 * 60_000;
const SEEN_MAX = 2000;

interface Point {
	x: number;
	y: number;
	z: number;
}

/** Everywhere the map itself sends players. */
export function knownPoints(map: MapDef): Point[] {
	const out: Point[] = [map.spawn.pos];
	for (const s of map.spawns ?? []) out.push(s.pos);
	for (const s of map.hns ? [...map.hns.hiderSpawns, ...map.hns.seekerSpawns] : []) out.push(s.pos);
	for (const z of map.zones) {
		if ((z.type === 'stage' || z.type === 'checkpoint') && z.respawn) out.push(z.respawn.pos);
		if (z.type === 'teleport' && z.dest) out.push(z.dest.pos);
	}
	return out;
}

const wrapDeg = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;

/** One view axis: a movement in one direction becomes one token. */
class Gesture {
	private mag = 0;
	private ticks = 0;
	private pause = 0;

	constructor(private readonly name: string) {}

	push(d: number, dt: number, emit: (token: string) => void): void {
		if (Math.abs(d) < 0.02) {
			this.pause += dt;
			if (this.mag !== 0 && this.pause >= 8) this.flush(emit);
			return;
		}
		if (this.mag !== 0 && Math.sign(d) !== Math.sign(this.mag)) this.flush(emit);
		this.pause = 0;
		this.mag += d;
		this.ticks += dt;
		if (this.ticks >= 128) this.flush(emit);
	}

	private flush(emit: (token: string) => void): void {
		if (Math.abs(this.mag) >= 2) emit(`${this.name}${Math.round(this.mag / 5)}:${Math.min(8, Math.floor(this.ticks / 16))}`);
		this.mag = 0;
		this.ticks = 0;
		this.pause = 0;
	}

	reset(): void {
		this.mag = 0;
		this.ticks = 0;
		this.pause = 0;
	}
}

/** A finished 10-minute window of suspiciously repetitive input. */
export interface MacroWindow {
	from: number;
	inputs: number;
	different: number;
}

export class PlayerActivity {
	/** Time without moving (ms); Infinity until the first movement. */
	stillMs = Infinity;
	/** Time without varied input (ms); Infinity until the first. */
	idleMs = Infinity;
	/** Time spectating in a row, until real input resets it. */
	spectateMs = 0;
	/** Clock of the last varied input. */
	lastInputAt = -Infinity;
	private suspectUntil = -Infinity;
	private expectUntil = -Infinity;
	private graceMs = 0;
	private anchor: Point | null = null;
	private lookDeg = 0;
	private prev: NetState | null = null;
	private prevAt = 0;
	private readonly yaw = new Gesture('y');
	private readonly pitch = new Gesture('p');
	private sector = -1;
	private lastToken = '';
	/** Token pair → last seen; oldest first. */
	private readonly seen = new Map<string, number>();
	private win = { from: -Infinity, inputs: 0, first: 0, last: 0, pairs: new Set<string>() };

	/** Is a suspect speed or teleport still blocking awards? */
	suspect(now: number): boolean {
		return now < this.suspectUntil;
	}

	get still(): boolean {
		return this.stillMs >= ACTIVITY.stillMs;
	}

	/** The server moved this player (spawn, respawn): the next jump is fine. */
	expectTeleport(now: number): void {
		this.expectUntil = now + EXPECT_TELEPORT_MS;
	}

	/** The mode saw the player act (fired a gun): as good as moving, but not before the first movement. */
	acted(): void {
		if (Number.isFinite(this.stillMs)) this.stillMs = 0;
	}

	/** New map: the position starts over; waiting for the first packet holds the clock. */
	newMap(): void {
		this.forget();
		this.graceMs = MAP_GRACE_MS;
		this.suspectUntil = -Infinity;
	}

	/** Spectating starts or ends: activity has to be shown again. */
	spectate(): void {
		this.forget();
		this.stillMs = Infinity;
		this.graceMs = 0;
	}

	private forget(): void {
		this.prev = null;
		this.anchor = null;
		this.lookDeg = 0;
		this.sector = -1;
		this.yaw.reset();
		this.pitch.reset();
	}

	state(s: NetState, now: number, opts: { limit: number; points: readonly Point[]; stillness: Stillness }): void {
		this.graceMs = 0;
		const p = this.prev;
		this.prev = { ...s };
		const arrival = now - this.prevAt;
		this.prevAt = now;
		if (!p || !this.anchor) {
			this.anchor = { x: s.x, y: s.y, z: s.z };
			return;
		}
		const ticks = Math.max(1, Math.min(TICK_RATE, s.tick - p.tick));
		// Packets arrive late in bursts: the larger of the two times counts.
		const secs = Math.max(ticks / TICK_RATE, Math.min(2000, arrival) / 1000);
		const step = Math.hypot(s.x - p.x, s.y - p.y);
		const jumped = step > opts.limit * 1.3 * secs + 96;
		if (jumped && now >= this.expectUntil && !opts.points.some((k) => Math.hypot(k.x - s.x, k.y - s.y, k.z - s.z) <= KNOWN_POINT_DIST)) {
			this.suspectUntil = now + ACTIVITY.suspectMs;
		}
		if (Math.hypot(s.vx, s.vy) > opts.limit) this.suspectUntil = now + ACTIVITY.suspectMs;

		// Teleports move and turn the player without any input.
		if (jumped || (s.flags & FLAG_TELEPORTED) !== 0 || teleportSeq(s.flags) !== teleportSeq(p.flags)) {
			this.anchor = { x: s.x, y: s.y, z: s.z };
			this.sector = -1;
			this.yaw.reset();
			this.pitch.reset();
			return;
		}
		if (Math.hypot(s.x - this.anchor.x, s.y - this.anchor.y) >= MOVE_DIST) {
			this.anchor = { x: s.x, y: s.y, z: s.z };
			this.stillMs = 0;
		}
		const dy = wrapDeg(s.yaw - p.yaw);
		const dp = s.pitch - p.pitch;
		if (opts.stillness === 'look') {
			this.lookDeg += Math.abs(dy) + Math.abs(dp);
			if (this.lookDeg >= LOOK_DEG) {
				this.lookDeg = 0;
				this.stillMs = 0;
			}
		}
		const emit = (t: string) => this.token(t, now);
		this.yaw.push(dy, ticks, emit);
		this.pitch.push(dp, ticks, emit);
		if ((s.flags & FLAG_DUCKED) !== (p.flags & FLAG_DUCKED)) emit('d');
		const speed = Math.hypot(s.vx, s.vy);
		const grounded = (s.flags & FLAG_ON_GROUND) !== 0 && (p.flags & FLAG_ON_GROUND) !== 0;
		if (speed < 10) this.sector = -1;
		else if (grounded && speed > 60) {
			const sector = Math.round(wrapDeg((Math.atan2(s.vy, s.vx) * 180) / Math.PI - s.yaw) / 45) & 7;
			if (sector !== this.sector) emit(`m${sector}`);
			this.sector = sector;
		}
	}

	private token(t: string, now: number): void {
		const pair = `${this.lastToken} ${t}`;
		this.lastToken = t;
		const at = this.seen.get(pair);
		this.seen.delete(pair);
		this.seen.set(pair, now);
		if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
		const w = this.win;
		if (w.inputs === 0) w.first = now;
		w.inputs++;
		w.last = now;
		w.pairs.add(pair);
		if (at !== undefined && now - at < SEEN_MS) return;
		this.idleMs = 0;
		this.spectateMs = 0;
		this.lastInputAt = now;
	}

	/** Let `ms` pass. Returns true when the time counts as playtime. */
	advance(ms: number, spectating: boolean, stillness: Stillness): boolean {
		if (this.graceMs > 0) this.graceMs -= ms;
		else if (spectating || stillness !== 'held') this.stillMs += ms;
		if (spectating) {
			// No packets while spectating: the idle clock waits, the spectating one runs.
			this.spectateMs += ms;
			return this.idleMs < ACTIVITY.idleMs && this.spectateMs <= ACTIVITY.spectateMs;
		}
		this.idleMs += ms;
		return this.idleMs < ACTIVITY.idleMs;
	}

	/** Called regularly: the last 10 minutes of input when they look automated, else null. */
	macro(now: number): MacroWindow | null {
		const w = this.win;
		if (!Number.isFinite(w.from)) w.from = now;
		if (now - w.from < ABUSE.macroMs) return null;
		const found =
			w.inputs >= ABUSE.macroMin && w.last - w.first >= ABUSE.macroMs * 0.8 && w.pairs.size <= w.inputs * ABUSE.macroShare
				? { from: w.from, inputs: w.inputs, different: w.pairs.size }
				: null;
		this.win = { from: now, inputs: 0, first: 0, last: 0, pairs: new Set() };
		return found;
	}
}

/** Time since the last call, capped (a suspended host adds nothing). */
export class StepClock {
	private last: number | null = null;
	step(now: number): number {
		const ms = this.last === null ? 0 : Math.min(MAX_STEP_MS, Math.max(0, now - this.last));
		this.last = now;
		return ms;
	}
}
