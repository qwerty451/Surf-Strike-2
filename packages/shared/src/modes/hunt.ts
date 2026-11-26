/**
 * Who chases and who sees whom (docs/economy.md#chase-and-view): shared by the
 * awards of tag and hide and seek. Pure, clock-injected, and cheap with 32
 * players: it samples a few times per second, filters by distance and angle
 * before tracing, keeps trace results for a moment and never does more than
 * `maxTraces` per sample.
 *
 * Speeds come from the positions themselves, never from the velocity a client
 * claims.
 */
import { buildCollisionWorld } from '../collision/world.ts';
import { ABUSE } from '../economy.ts';
import type { BrushDef, MapDef } from '../maps/types.ts';
import type { Vec3 } from '../types.ts';

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/** Line of sight on a map. */
export interface Sight {
	/** Nothing to look through in between: fake walls (`solid: false`) block, glass does not. */
	visible(a: Vec3, b: Vec3): boolean;
	/** Nothing solid in between: fake walls do not block, glass does. */
	clear(a: Vec3, b: Vec3): boolean;
}

export function buildSight(map: Pick<MapDef, 'brushes'> & { theme: Pick<MapDef['theme'], 'materials'> }): Sight {
	const seeThrough = (b: BrushDef) => {
		const m = map.theme.materials[b.material];
		return !!m && (!!m.glass || (m.opacity ?? 1) < 1);
	};
	const fake = map.brushes.some((b) => b.solid === false);
	const solid = buildCollisionWorld(map);
	const visual =
		fake || map.brushes.some(seeThrough)
			? buildCollisionWorld({ brushes: map.brushes.filter((b) => !seeThrough(b)).map((b) => (b.solid === false ? { ...b, solid: true } : b)) })
			: solid;
	const free = (w: typeof solid) => (a: Vec3, b: Vec3) => w.trace(a, b, ZERO, ZERO).fraction >= 1;
	return {
		visible: free(visual),
		clear: (a, b) => {
			const trace = solid.trace(a, b, ZERO, ZERO);
			return !trace.startsolid && trace.fraction >= 1;
		}
	};
}

/** A player as the tracker needs it: feet position, view angles (degrees, pitch down positive). */
export interface HuntBody {
	id: number;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	ducked?: boolean;
}

export interface HuntOptions {
	sight: Sight;
	/** Chase range in units. */
	chaseRange: number;
	/** A chase needs the hunter to close in or run towards the target (hide and seek). */
	pursuit?: boolean;
	/** Range of `seen`; 0 or absent: views are not tracked. */
	viewRange?: number;
	/** Samples per second (default 4). */
	hz?: number;
	/** Traces per sample at most (default 96). */
	maxTraces?: number;
}

export interface HuntPair {
	hunter: number;
	target: number;
}
export interface HuntEntry {
	/** Time to credit for this sample. */
	ms: number;
	/** The other player (the nearest when there are several). */
	by: number;
}
/** What happened since the last sample. */
export interface HuntSample {
	/** Targets being chased. */
	chased: Map<number, HuntEntry>;
	/** Hunters chasing someone. */
	chasing: Map<number, HuntEntry>;
	/** Targets in view of a hunter. */
	seen: Map<number, HuntEntry>;
	/** Hunters that stood next to the same target, looking at it, without an attempt (abuse signal `shadow`). */
	shadows: HuntPair[];
}

/** Slower than this (units/s) is not moving. */
export const HUNT_MOVING = 60;
/** Half angle of the view cone (degrees): the 90° field of view on a 16:9 screen. */
export const HUNT_VIEW_HALF_DEG = 53;
/** A step longer than this within one sample is a teleport, not a run (units/s). */
const TELEPORT_SPEED = 4000;
/** Trace results older than this are not used any more. */
const TRACE_TTL_MS = 1000;
/** Gaps in a shadow shorter than this do not end it. */
const SHADOW_GAP_MS = 1000;

const EYE = 64;
const EYE_DUCKED = 46;
const CHEST = 40;
const CHEST_DUCKED = 28;

const eye = (b: HuntBody): Vec3 => ({ x: b.x, y: b.y, z: b.z + (b.ducked ? EYE_DUCKED : EYE) });
const chest = (b: HuntBody): Vec3 => ({ x: b.x, y: b.y, z: b.z + (b.ducked ? CHEST_DUCKED : CHEST) });

/** Is `t` inside the view cone of `h`? */
export function inViewCone(h: HuntBody, t: HuntBody, halfDeg = HUNT_VIEW_HALF_DEG): boolean {
	const e = eye(h);
	const c = chest(t);
	const dx = c.x - e.x;
	const dy = c.y - e.y;
	const dz = c.z - e.z;
	const len = Math.hypot(dx, dy, dz);
	if (len < 1) return true;
	const p = (h.pitch * Math.PI) / 180;
	const y = (h.yaw * Math.PI) / 180;
	const dot = (dx * Math.cos(p) * Math.cos(y) + dy * Math.cos(p) * Math.sin(y) - dz * Math.sin(p)) / len;
	return dot >= Math.cos((halfDeg * Math.PI) / 180);
}

interface Motion {
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	speed: number;
	stamp: number;
}
interface Link {
	visible: boolean;
	tracedAt: number;
	dist: number;
	stamp: number;
	shadowMs: number;
	shadowAt: number;
}

export class HuntTracker {
	private readonly motion = new Map<number, Motion>();
	private readonly links = new Map<number, Link>();
	private lastAt = -Infinity;
	private stamp = 0;
	private turn = 0;
	private readonly everyMs: number;
	private readonly maxTraces: number;
	/** Traces of the last sample (tests, tuning). */
	traces = 0;

	constructor(private readonly o: HuntOptions) {
		this.everyMs = 1000 / (o.hz ?? 4);
		this.maxTraces = o.maxTraces ?? 96;
	}

	/** A swing, tag attempt or hit of this hunter: they are playing, not standing by. */
	attempt(hunter: number): void {
		for (const [key, l] of this.links) if (Math.floor(key / 65536) === hunter) l.shadowMs = 0;
	}

	/** Round start, respawn of everyone: forget positions and shadows. */
	reset(): void {
		this.motion.clear();
		this.links.clear();
		this.lastAt = -Infinity;
	}

	/**
	 * Call as often as you like (every mode tick); returns null between samples.
	 * `hunters`: seekers or ITs, `targets`: hiders or runners.
	 */
	update(now: number, hunters: readonly HuntBody[], targets: readonly HuntBody[]): HuntSample | null {
		if (now - this.lastAt < this.everyMs) return null;
		const ms = Number.isFinite(this.lastAt) ? Math.min(1000, now - this.lastAt) : 0;
		this.lastAt = now;
		this.stamp++;
		for (const b of hunters) this.move(b, ms);
		for (const b of targets) this.move(b, ms);
		for (const [id, m] of this.motion) if (m.stamp !== this.stamp) this.motion.delete(id);

		const out: HuntSample = { chased: new Map(), chasing: new Map(), seen: new Map(), shadows: [] };
		const best = { chased: new Map<number, number>(), chasing: new Map<number, number>(), seen: new Map<number, number>() };
		const put = (k: 'chased' | 'chasing' | 'seen', id: number, by: number, dist: number) => {
			if (dist >= (best[k].get(id) ?? Infinity)) return;
			best[k].set(id, dist);
			out[k].set(id, { ms, by });
		};
		this.traces = 0;
		const total = hunters.length * targets.length;
		// A different pair first each time, so the trace budget is shared fairly.
		const first = total > 0 ? this.turn++ % total : 0;
		for (let k = 0; k < total; k++) {
			const i = (first + k) % total;
			const h = hunters[Math.floor(i / targets.length)]!;
			const t = targets[i % targets.length]!;
			if (h.id === t.id) continue;
			this.pair(now, ms, h, t, put, out);
		}
		for (const [key, l] of this.links) if (l.stamp !== this.stamp) this.links.delete(key);
		return out;
	}

	private move(b: HuntBody, ms: number): void {
		const m = this.motion.get(b.id);
		if (!m) {
			this.motion.set(b.id, { x: b.x, y: b.y, z: b.z, vx: 0, vy: 0, speed: 0, stamp: this.stamp });
			return;
		}
		const s = ms > 0 ? 1000 / ms : 0;
		const vx = (b.x - m.x) * s;
		const vy = (b.y - m.y) * s;
		const speed = Math.hypot(vx, vy);
		const ok = speed <= TELEPORT_SPEED;
		m.vx = ok ? vx : 0;
		m.vy = ok ? vy : 0;
		m.speed = ok ? speed : 0;
		m.x = b.x;
		m.y = b.y;
		m.z = b.z;
		m.stamp = this.stamp;
	}

	private pair(
		now: number,
		ms: number,
		h: HuntBody,
		t: HuntBody,
		put: (k: 'chased' | 'chasing' | 'seen', id: number, by: number, dist: number) => void,
		out: HuntSample
	): void {
		const o = this.o;
		const dist = Math.hypot(t.x - h.x, t.y - h.y, t.z - h.z);
		const reach = Math.max(o.chaseRange, o.viewRange ?? 0, ABUSE.shadowRange);
		if (dist > reach) return;
		const key = h.id * 65536 + t.id;
		const l = this.links.get(key);
		const before = l?.dist ?? dist;
		const mh = this.motion.get(h.id)!;
		const mt = this.motion.get(t.id)!;
		const inCone = inViewCone(h, t);
		const near = dist <= ABUSE.shadowRange;
		const view = !!o.viewRange && dist <= o.viewRange && inCone;
		let chase = dist <= o.chaseRange && mh.speed >= HUNT_MOVING && mt.speed >= HUNT_MOVING;
		if (chase && o.pursuit) {
			const d = Math.hypot(t.x - h.x, t.y - h.y) || 1;
			const towards = (mh.vx * (t.x - h.x) + mh.vy * (t.y - h.y)) / (d * mh.speed);
			chase = dist < before - 1 || towards >= 0.5;
		}
		const link: Link = l ?? { visible: false, tracedAt: -Infinity, dist, stamp: 0, shadowMs: 0, shadowAt: -Infinity };
		if (!l) this.links.set(key, link);
		link.dist = dist;
		link.stamp = this.stamp;
		if (!chase && !view && !(near && inCone)) return;
		if (this.traces < this.maxTraces) {
			const e = eye(h);
			this.traces++;
			link.visible = o.sight.visible(e, eye(t));
			if (!link.visible) {
				this.traces++;
				link.visible = o.sight.visible(e, chest(t));
			}
			link.tracedAt = now;
		} else if (now - link.tracedAt > TRACE_TTL_MS) link.visible = false;
		if (!link.visible) return;
		if (chase) {
			put('chased', t.id, h.id, dist);
			put('chasing', h.id, t.id, dist);
		}
		if (view) put('seen', t.id, h.id, dist);
		// Within reach: no glass between them, so an attempt would have been possible.
		if (near && inCone && o.sight.clear(eye(h), chest(t))) {
			link.shadowMs = now - link.shadowAt > SHADOW_GAP_MS ? 0 : link.shadowMs + ms;
			link.shadowAt = now;
			if (link.shadowMs >= ABUSE.shadowMs) {
				link.shadowMs = 0;
				out.shadows.push({ hunter: h.id, target: t.id });
			}
		}
	}
}

/** Collects milliseconds per key and gives out whole units ("1 point per 20 s"). */
export class TimeMeter<K = number> {
	private readonly ms = new Map<K, number>();
	constructor(private readonly unitMs: number) {}

	/** Add time; returns the units completed by it. */
	add(key: K, ms: number): number {
		const t = (this.ms.get(key) ?? 0) + Math.max(0, ms);
		const n = Math.floor(t / this.unitMs);
		this.ms.set(key, t - n * this.unitMs);
		return n;
	}

	value(key: K): number {
		return this.ms.get(key) ?? 0;
	}

	/** Start over for one key, or for all. */
	reset(key?: K): void {
		if (key === undefined) this.ms.clear();
		else this.ms.delete(key);
	}
}
