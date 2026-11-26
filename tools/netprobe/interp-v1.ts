// From a64f384 apps/web/src/lib/net/interp.ts. Only the import path differs.
/**
 * Remote-player interpolation buffer: snapshots are stored with their
 * arrival time and sampled ~100 ms in the past (docs/architecture.md#netcode).
 */
import { INTERP_DELAY_MS, type NetState } from './wire-v1.ts';

/** Shared with the server's lag compensation (packages/shared protocol.ts). */
export { INTERP_DELAY_MS };
const CAPACITY = 32;

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
}

export class SnapshotBuffer {
	private buf: Entry[] = [];
	/** Teleport threshold: larger jumps snap instead of interpolating. */
	snapDistance = 1024;

	push(state: NetState, arrivalMs: number): void {
		const last = this.buf[this.buf.length - 1];
		if (last && arrivalMs < last.t) arrivalMs = last.t;
		this.buf.push({ t: arrivalMs, s: state });
		if (this.buf.length > CAPACITY) this.buf.shift();
	}

	get size(): number {
		return this.buf.length;
	}

	get lastArrival(): number {
		return this.buf.length ? this.buf[this.buf.length - 1].t : -Infinity;
	}

	clear(): void {
		this.buf.length = 0;
	}

	/** Sample at `renderMs` (already delayed). Returns false when empty. */
	sample(renderMs: number, out: Sample): boolean {
		const n = this.buf.length;
		if (n === 0) return false;
		let a = this.buf[0];
		let b = a;
		if (renderMs <= a.t) {
			b = a;
		} else if (renderMs >= this.buf[n - 1].t) {
			a = b = this.buf[n - 1];
		} else {
			for (let i = 1; i < n; i++) {
				if (this.buf[i].t >= renderMs) {
					a = this.buf[i - 1];
					b = this.buf[i];
					break;
				}
			}
		}
		const span = b.t - a.t;
		let t = span > 0 ? (renderMs - a.t) / span : 1;
		const sa = a.s;
		const sb = b.s;
		const dx = sb.x - sa.x;
		const dy = sb.y - sa.y;
		const dz = sb.z - sa.z;
		if (dx * dx + dy * dy + dz * dz > this.snapDistance * this.snapDistance) t = 1;
		out.x = sa.x + dx * t;
		out.y = sa.y + dy * t;
		out.z = sa.z + dz * t;
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
		// Drop entries no longer needed (keep one before renderMs).
		let drop = 0;
		while (drop + 1 < this.buf.length - 1 && this.buf[drop + 1].t <= renderMs) drop++;
		if (drop > 0) this.buf.splice(0, drop);
		return true;
	}
}
