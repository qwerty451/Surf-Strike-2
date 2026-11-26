/**
 * Remote-player interpolation buffer on the server's monotonic timeline
 * (docs/architecture.md#netcode). Untimed snapshots use the sender's tick
 * spacing to remove aliasing and uplink jitter.
 */
import { DUCK_HULL_MAX, FLAG_DUCKED, FLAG_TELEPORTED, HULL_MAX, HULL_MIN, INTERP_DELAY_MS, teleportSeq, SnapshotTimeline, type CollisionWorld, type NetState, type SnapshotEntry, type Vec3 } from '@surf/shared';

/** Shared with the server's lag compensation (packages/shared protocol.ts). */
export { INTERP_DELAY_MS };
/** Max velocity extrapolation horizon (ms) when a stall outruns the interpolation buffer. */
export const MAX_EXTRAP_MS = 90;
/** Limit spatial error at surf speeds while keeping more time for slower movement. */
export const MAX_EXTRAP_DISTANCE = 80;
const CAPACITY = 32;
const CORRECTION_MS = 80;
const CONTACT_SLIDE_MS = 24;
const UNSTEADY_EXTRAP_MS = 25;

export interface Sample {
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	pitch: number;
	yaw: number;
	flags: number;
	status: number;
	stage: number;
	runTicks: number;
}

export function emptySample(): Sample {
	return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0, flags: 0, status: 0, stage: 0, runTicks: 0 };
}

/** Shortest-path angle lerp in degrees. */
export function lerpAngle(a: number, b: number, t: number): number {
	let d = (b - a) % 360;
	if (d > 180) d -= 360;
	else if (d < -180) d += 360;
	return a + d * t;
}

interface Entry {
	t: number;
	s: NetState;
	epoch: number;
}

export class SnapshotBuffer {
	private buf: Entry[] = [];
	/** Local client arrival timestamp (ms) of the last pushed snapshot, used for visibility timeouts. */
	private lastLocalArrival = -Infinity;
	private readonly timeline = new SnapshotTimeline();
	private serverSourceIdle: boolean | undefined;
	private readonly predicted = { x: 0, y: 0, z: 0 };
	private readonly previousRaw = { x: 0, y: 0, z: 0 };
	private readonly revised = emptySample();
	private readonly correction = { x: 0, y: 0, z: 0 };
	private correctionLeftMs = 0;
	private readAt = -Infinity;
	private readEpoch = -1;
	private frameAt = -Infinity;
	private frameEpoch = -1;
	private frameNewest: NetState | undefined;
	private framePredicted = false;
	private frameHeld = false;

	/** Server time of the pose last sampled, including only the extrapolation used. */
	lastRenderMs = -Infinity;

	/** Teleport threshold: larger jumps snap instead of interpolating. */
	snapDistance = 1024;
	/** Max linear velocity extrapolation past the newest buffered sample (ms). */
	maxExtrapMs = MAX_EXTRAP_MS;
	/** True when the last `sample` ran past the newest buffered snapshot. */
	lastUnderrun = false;
	/** How many ms the last `sample` actively extrapolated past the newest snapshot (0 when holding/frozen past cap). */
	lastExtrapMs = 0;
	/** How many ms `renderMs` exceeded the newest buffered snapshot on the last `sample`. */
	lastOverrunMs = 0;

	/**
	 * Push a remote player's state from a snapshot stamped `serverTimeMs`.
	 * Pass `localArrivalMs` when `serverTimeMs` is on the server timeline so
	 * `lastArrival` stays in the caller's local clock domain.
	 */
	push(state: Omit<SnapshotEntry, 'id'>, serverTimeMs: number, localArrivalMs = serverTimeMs): void {
		this.lastLocalArrival = localArrivalMs;
		this.serverSourceIdle = state.sourceIdle;
		const t = state.sampleTimeMs ?? this.timeline.push(state.tick, serverTimeMs, true);
		if (t === null) return;
		const last = this.buf.at(-1);
		if (last && t < last.t) return;
		const epoch = last ? last.epoch + Number(this.isSnap(last.s, state)) : 0;
		const entry = { t, s: state, epoch };
		if (state.sampleTimeMs !== undefined && last?.t === t) this.buf[this.buf.length - 1] = entry;
		else this.buf.push(entry);
		if (this.buf.length > CAPACITY) this.buf.shift();
	}

	get size(): number {
		return this.buf.length;
	}

	/** Local arrival timestamp (ms) of the latest snapshot containing this player. */
	get lastArrival(): number {
		return this.lastLocalArrival;
	}

	/** True when this remote player's sim tick has stopped advancing (e.g. backgrounded tab). */
	get sourceIdle(): boolean {
		return this.serverSourceIdle ?? this.timeline.sourceIdle;
	}

	clear(): void {
		this.buf.length = 0;
		this.lastLocalArrival = -Infinity;
		this.timeline.clear();
		this.serverSourceIdle = undefined;
		this.lastUnderrun = false;
		this.lastExtrapMs = 0;
		this.lastOverrunMs = 0;
		this.lastRenderMs = -Infinity;
		this.frameAt = -Infinity;
		this.frameEpoch = -1;
		this.frameNewest = undefined;
		this.framePredicted = false;
		this.frameHeld = false;
		this.correctionLeftMs = 0;
	}

	private isSnap(a: NetState, b: NetState): boolean {
		return teleportSeq(a.flags) !== teleportSeq(b.flags)
			|| ((a.flags & FLAG_TELEPORTED) === 0 && (b.flags & FLAG_TELEPORTED) !== 0)
			|| (b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2 > this.snapDistance ** 2;
	}

	private predict(entry: Entry, prev: Entry | undefined, overMs: number, out: Vec3, world?: CollisionWorld): number {
		const { s } = entry;
		out.x = s.x;
		out.y = s.y;
		out.z = s.z;
		if (this.sourceIdle) return 0;
		const speed = Math.hypot(s.vx, s.vy, s.vz);
		let cap = Math.min(this.maxExtrapMs, 1000 * MAX_EXTRAP_DISTANCE / speed);
		if (prev) {
			const p = prev.s;
			const velocityChange = Math.hypot(s.vx - p.vx, s.vy - p.vy, s.vz - p.vz);
			const pairSpeed = Math.max(speed, Math.hypot(p.vx, p.vy, p.vz));
			if (prev.epoch !== entry.epoch || velocityChange > Math.max(160, pairSpeed * 0.4)) {
				cap = Math.min(cap, UNSTEADY_EXTRAP_MS);
			}
		}
		const used = Math.min(overMs, cap);
		const seconds = used / 1000;
		out.x += s.vx * seconds;
		out.y += s.vy * seconds;
		out.z += s.vz * seconds;
		if (!world || used === 0 || (s.vx === 0 && s.vy === 0 && s.vz === 0)) return used;

		const hull = (s.flags & FLAG_DUCKED) !== 0 ? DUCK_HULL_MAX : HULL_MAX;
		const hit = world.trace(s, out, HULL_MIN, hull);
		if (hit.startsolid) {
			out.x = s.x;
			out.y = s.y;
			out.z = s.z;
			return 0;
		}
		if (hit.fraction === 1) return used;

		const contactMs = used * hit.fraction;
		const slideMs = Math.min(CONTACT_SLIDE_MS, used - contactMs);
		const { normal } = hit.plane;
		const into = s.vx * normal.x + s.vy * normal.y + s.vz * normal.z;
		const vx = s.vx - into * normal.x;
		const vy = s.vy - into * normal.y;
		const vz = s.vz - into * normal.z;
		const end = hit.endpos;
		out.x = end.x;
		out.y = end.y;
		out.z = end.z;
		if (slideMs <= 0 || vx * vx + vy * vy + vz * vz < 1) return contactMs;

		const slide = world.trace(end, {
			x: end.x + vx * slideMs / 1000,
			y: end.y + vy * slideMs / 1000,
			z: end.z + vz * slideMs / 1000
		}, HULL_MIN, hull);
		if (slide.startsolid) return contactMs;
		out.x = slide.endpos.x;
		out.y = slide.endpos.y;
		out.z = slide.endpos.z;
		return contactMs + slideMs * slide.fraction;
	}

	/** Sample at `renderMs` (server time, already delayed). Returns false when empty. */
	sample(renderMs: number, out: Sample, world?: CollisionWorld, frameMs = renderMs, blendCorrections = true): boolean {
		const newest = this.buf.at(-1);
		if (!newest) return false;

		this.readPose(renderMs, out, world);
		const sampledAt = this.readAt;
		const previousRenderMs = this.lastRenderMs;
		this.lastRenderMs = sampledAt;
		this.lastOverrunMs = Math.max(0, renderMs - newest.t);
		this.lastUnderrun = this.lastOverrunMs > 0;
		this.lastExtrapMs = this.lastUnderrun && sampledAt >= renderMs - 1e-6 ? sampledAt - newest.t : 0;
		if (!blendCorrections) return true;

		const epoch = this.readEpoch;
		const dt = Math.max(0, frameMs - this.frameAt);
		const offset = this.correction;
		if (this.frameEpoch !== epoch) {
			this.correctionLeftMs = 0;
			offset.x = offset.y = offset.z = 0;
		} else if (this.framePredicted && this.frameNewest !== newest.s) {
			// Reevaluate the previous frame on the updated timeline to isolate the prediction error.
			this.readPose(previousRenderMs, this.revised, world);
			if (this.readEpoch === epoch) {
				let dx = this.previousRaw.x - this.revised.x;
				let dy = this.previousRaw.y - this.revised.y;
				let dz = this.previousRaw.z - this.revised.z;
				// A released hold can also skip a span of valid motion.
				if (this.frameHeld && sampledAt > previousRenderMs + dt * 1.5) {
					this.readPose(previousRenderMs + dt, this.revised, world);
					if (this.readEpoch === epoch) {
						dx += this.revised.x - out.x;
						dy += this.revised.y - out.y;
						dz += this.revised.z - out.z;
					}
				}
				if (dx * dx + dy * dy + dz * dz > 0.01 ** 2) {
					offset.x += dx;
					offset.y += dy;
					offset.z += dz;
					this.correctionLeftMs = CORRECTION_MS;
				}
			}
		}
		this.frameEpoch = epoch;
		this.frameNewest = newest.s;
		this.frameAt = frameMs;
		this.frameHeld = this.lastUnderrun && this.lastExtrapMs === 0;
		this.framePredicted = this.lastUnderrun || sampledAt > newest.t;
		this.previousRaw.x = out.x;
		this.previousRaw.y = out.y;
		this.previousRaw.z = out.z;

		if (this.correctionLeftMs > 0) {
			const remaining = Math.max(0, this.correctionLeftMs - dt);
			const weight = remaining / this.correctionLeftMs;
			offset.x *= weight;
			offset.y *= weight;
			offset.z *= weight;
			this.correctionLeftMs = remaining;
			if (remaining > 0) {
				const end = { x: out.x + offset.x, y: out.y + offset.y, z: out.z + offset.z };
				const hull = (out.flags & FLAG_DUCKED) !== 0 ? DUCK_HULL_MAX : HULL_MAX;
				const trace = world?.trace(out, end, HULL_MIN, hull);
				if (!trace?.startsolid) {
					const pos = trace?.endpos ?? end;
					out.x = pos.x;
					out.y = pos.y;
					out.z = pos.z;
				}
			}
		}
		return true;
	}

	private readPose(renderMs: number, out: Sample, world?: CollisionWorld): void {
		const n = this.buf.length;
		const newest = this.buf[n - 1]!;
		let aIndex = 0;
		let a = this.buf[aIndex]!;
		let b = a;
		if (renderMs > a.t && renderMs >= newest.t) {
			aIndex = n - 1;
			a = b = newest;
		} else if (renderMs > a.t) {
			for (let i = n - 2; i >= 0; i--) {
				if (this.buf[i]!.t < renderMs) {
					aIndex = i;
					a = this.buf[i]!;
					b = this.buf[i + 1]!;
					break;
				}
			}
		}
		// Stay on the old side until playback reaches the teleport sample.
		if (a.epoch !== b.epoch && renderMs < b.t) b = a;
		const span = b.t - a.t;
		const t = span > 0 ? (renderMs - a.t) / span : 1;
		const sa = a.s;
		const sb = b.s;
		this.readAt = a.t + span * t;
		this.readEpoch = b.epoch;
		if (a === b && renderMs > a.t) {
			this.readAt += this.predict(a, this.buf[aIndex - 1], renderMs - a.t, out, world);
		} else {
			out.x = sa.x + (sb.x - sa.x) * t;
			out.y = sa.y + (sb.y - sa.y) * t;
			out.z = sa.z + (sb.z - sa.z) * t;
		}
		out.vx = sa.vx + (sb.vx - sa.vx) * t;
		out.vy = sa.vy + (sb.vy - sa.vy) * t;
		out.vz = sa.vz + (sb.vz - sa.vz) * t;
		out.pitch = sa.pitch + (sb.pitch - sa.pitch) * t;
		out.yaw = lerpAngle(sa.yaw, sb.yaw, t);
		const disc = t < 0.5 ? sa : sb;
		out.flags = disc.flags;
		out.status = disc.status;
		out.stage = disc.stage;
		out.runTicks = Math.round(sa.runTicks + (sb.runTicks - sa.runTicks) * t);
	}
}
