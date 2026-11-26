/**
 * Server-side run validation (docs/architecture.md#netcode).
 *
 * One validator per player per map. Feed it every received state and zone
 * event with the server wall-clock time; it returns a verdict on `end`.
 */
import type { MapDef, NetState, Spawn, Vec3 } from '@surf/shared';
import { DUCK_HULL_MAX, FLAG_DUCKED, FLAG_TELEPORTED, HULL_MAX, HULL_MIN, hnsSpawns, hullInBox, mapCvars, MAX_VELOCITY_HARD, SURF_CVARS, tagSpawns, teleportSeq, TICK_RATE } from '@surf/shared';

/** Allowed relative error between run ticks and wall-clock time. */
export const TIME_TOLERANCE = 0.05;
/** Extra absolute slack (ms) for short runs and network jitter. */
export const TIME_SLACK_MS = 300;
/** Extra units allowed per position step. */
export const JUMP_SLACK = 64;
/** Teleport destinations within this distance are accepted. */
export const TELEPORT_RADIUS = 128;
/** End-zone tolerance for the last state before `end`. */
export const END_SLACK = 64;

export type ZoneKind = 'start' | 'stage' | 'checkpoint' | 'end';

export type Verdict =
	| { ok: true; ticks: number; splits: number[] }
	| { ok: false; reason: string };

interface Box {
	min: Vec3;
	max: Vec3;
}

export function nearPose(a: Vec3, b: Vec3, radius: number): boolean {
	return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 <= radius * radius;
}

/** A client-side map teleport must lead from an eligible trigger to one of its landings. */
export function mapTeleport(map: MapDef, prev: NetState | null, state: NetState): boolean {
	if (!prev) return false;
	// The client applies the teleport in the same movement tick as entry. Its
	// immediately preceding pose can be up to a movement step outside the box.
	const maxvel = Math.min(mapCvars(map).sv_maxvelocity, MAX_VELOCITY_HARD);
	const ticks = Math.max(1, Math.min(4, (state.tick - prev.tick) >>> 0));
	const step = (v: number) => Math.max(-maxvel, Math.min(maxvel, v)) / TICK_RATE;
	const reach = (v: number) => 8 + (ticks - 1) * Math.abs(step(v));
	const dx = reach(prev.vx), dy = reach(prev.vy), dz = reach(prev.vz);
	const landingRadius = 16 + (ticks - 1) * Math.hypot(step(state.vx), step(state.vy), step(state.vz));
	const projected = { x: prev.x + step(prev.vx), y: prev.y + step(prev.vy), z: prev.z + step(prev.vz) };
	const stance = (state.flags & FLAG_DUCKED) !== 0;
	for (const zone of map.zones) {
		if (zone.type !== 'teleport') continue;
		// Allow acceleration, a crouch change, and wire quantization around the trigger.
		const box = {
			min: { x: zone.min.x - dx, y: zone.min.y - dy, z: zone.min.z - dz },
			max: { x: zone.max.x + dx, y: zone.max.y + dy, z: zone.max.z + dz }
		};
		if (!hullInBox(prev, stance, box) && !hullInBox(projected, stance, box)) continue;
		let destinations: readonly Spawn[];
		if (zone.dest) destinations = [zone.dest];
		else if (map.kind === 'hns') {
			const { hiders, seekers } = hnsSpawns(map);
			destinations = [...hiders, ...seekers];
		} else if (map.kind === 'tag' || map.kind === 'infected' || map.kind === 'zombies') destinations = tagSpawns(map);
		else continue;
		// Movement already at the landing cannot renew the discontinuity.
		if (destinations.some(({ pos }) => nearPose(state, pos, landingRadius) && !nearPose(prev, pos, 16))) return true;
	}
	return false;
}

export class RunValidator {
	private readonly maxvel: number;
	private readonly progressKind: 'stage' | 'checkpoint';
	private readonly firstIndex: number;
	private readonly lastIndex: number;
	private readonly ends: Box[];
	private readonly respawns: Vec3[];

	private running = false;
	private startWall = 0;
	private startTick = 0;
	private nextIndex = 0;
	private splits: number[] = [];
	private failure: string | null = null;
	private last: NetState | null = null;

	constructor(map: MapDef) {
		// The movement clamps each axis to sv_maxvelocity, never past CS2's 16384 hard limit.
		this.maxvel = Math.min(map.cvars.sv_maxvelocity ?? SURF_CVARS.sv_maxvelocity, MAX_VELOCITY_HARD);
		const staged = map.layout === 'staged';
		this.progressKind = staged ? 'stage' : 'checkpoint';
		this.firstIndex = staged ? 2 : 1;
		let last = this.firstIndex - 1;
		const respawns: Vec3[] = [map.spawn.pos];
		const ends: Box[] = [];
		for (const z of map.zones) {
			if (z.type === 'end') ends.push(z);
			// Fixed-destination teleporters: a FLAG_TELEPORTED jump to `dest` is legal.
			else if (z.type === 'teleport' && z.dest) respawns.push(z.dest.pos);
			else if (z.type === 'stage' || z.type === 'checkpoint') {
				respawns.push((z.respawn as Spawn).pos);
				if (z.type === this.progressKind) last = Math.max(last, z.index);
			}
		}
		this.lastIndex = last;
		this.ends = ends;
		this.respawns = respawns;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Cancel the current run (spectate, map change). */
	cancel(): void {
		this.running = false;
		this.failure = null;
		this.splits = [];
	}

	/** Process a received state. */
	onState(s: NetState): void {
		const prev = this.last;
		this.last = s;
		if (!this.running || this.failure) return;

		if (Math.abs(s.vx) > this.maxvel + 1 || Math.abs(s.vy) > this.maxvel + 1) {
			this.failure = 'speed above sv_maxvelocity';
			return;
		}
		if (!prev) return;
		const dt = s.tick - prev.tick;
		const d = Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z);
		if ((s.flags & FLAG_TELEPORTED) !== 0 || teleportSeq(s.flags) !== teleportSeq(prev.flags)) {
			if (this.nearRespawn(s)) return;
		}
		if (dt <= 0) {
			// Duplicate/out-of-order tick: only a tiny move is plausible.
			if (d > JUMP_SLACK) this.failure = 'position jump';
			return;
		}
		const allowed = ((this.maxvel * Math.SQRT2 * dt) / TICK_RATE) * 1.25 + JUMP_SLACK;
		if (d > allowed) this.failure = 'position jump';
	}

	/** Process a zone event. Returns a verdict for `end` events of a tracked run. */
	onZone(kind: ZoneKind, index: number, tick: number, wallMs: number): Verdict | null {
		if (kind === 'start') {
			this.running = true;
			this.startWall = wallMs;
			this.startTick = tick;
			this.nextIndex = this.firstIndex;
			this.splits = [];
			this.failure = null;
			return null;
		}
		if (!this.running) return kind === 'end' ? { ok: false, reason: 'no run in progress' } : null;

		if (kind === 'stage' || kind === 'checkpoint') {
			if (this.failure) return null;
			if (kind !== this.progressKind || index !== this.nextIndex || index > this.lastIndex) {
				this.failure = 'zones out of order';
				return null;
			}
			const t = tick - this.startTick;
			if (t < 0 || (this.splits.length > 0 && t < this.splits[this.splits.length - 1])) {
				this.failure = 'zones out of order';
				return null;
			}
			this.splits.push(t);
			this.nextIndex++;
			return null;
		}

		// end
		this.running = false;
		if (this.failure) return { ok: false, reason: this.failure };
		if (this.nextIndex <= this.lastIndex) return { ok: false, reason: 'zones out of order' };
		const ticks = tick - this.startTick;
		if (ticks <= 0) return { ok: false, reason: 'invalid time' };
		const expected = (ticks / TICK_RATE) * 1000;
		const wall = wallMs - this.startWall;
		if (Math.abs(wall - expected) > expected * TIME_TOLERANCE + TIME_SLACK_MS) {
			return { ok: false, reason: 'timer does not match wall-clock time' };
		}
		if (!this.last || !this.inEnd(this.last)) return { ok: false, reason: 'not in the end zone' };
		return { ok: true, ticks, splits: this.splits.slice() };
	}

	private nearRespawn(s: NetState): boolean {
		return this.respawns.some((pos) => nearPose(s, pos, TELEPORT_RADIUS));
	}

	private inEnd(s: NetState): boolean {
		const maxs = s.flags & FLAG_DUCKED ? DUCK_HULL_MAX : HULL_MAX;
		const e = END_SLACK;
		for (const z of this.ends) {
			if (
				s.x + HULL_MIN.x < z.max.x + e &&
				s.x + maxs.x > z.min.x - e &&
				s.y + HULL_MIN.y < z.max.y + e &&
				s.y + maxs.y > z.min.y - e &&
				s.z + HULL_MIN.z < z.max.z + e &&
				s.z + maxs.z > z.min.z - e
			)
				return true;
		}
		return false;
	}
}
