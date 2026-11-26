/**
 * Zombie interpolation (docs/modes.md#zombies): BIN_ZOMBIES frames are kept
 * on the server timeline and sampled at the same render time as remote
 * players. A zombie present in one bracketing frame uses that frame's pose.
 */
import type { ZombieFrame, ZombieNet } from '@surf/shared';
import { lerpAngle } from './interp.js';

const CAPACITY = 16;
/** Larger jumps snap instead of interpolating (respawned ids). */
const SNAP = 512;

interface Entry {
	t: number;
	tick: number;
	byId: Map<number, ZombieNet>;
}

export interface ZombieSample extends ZombieNet {}

export class ZombieBuffer {
	private buf: Entry[] = [];
	/** Interpolated sim tick of the last sample (lag compensation). */
	tick = 0;

	push(frame: ZombieFrame, arrivalMs: number): void {
		let at = frame.serverTimeMs ?? arrivalMs;
		const last = this.buf[this.buf.length - 1];
		if (last && frame.tick <= last.tick) return; // late or duplicate frame
		if (last && at < last.t) at = last.t;
		this.buf.push({ t: at, tick: frame.tick, byId: new Map(frame.zombies.map((z) => [z.id, z])) });
		if (this.buf.length > CAPACITY) this.buf.shift();
	}

	clear(): void {
		this.buf.length = 0;
		this.tick = 0;
	}

	get size(): number {
		return this.buf.length;
	}

	/** Zombies at `renderMs` (already delayed), written into `out` (reused). */
	sample(renderMs: number, out: ZombieSample[]): ZombieSample[] {
		out.length = 0;
		const n = this.buf.length;
		if (n === 0) return out;
		let a = this.buf[0]!;
		let b = a;
		if (renderMs >= this.buf[n - 1]!.t) a = b = this.buf[n - 1]!;
		else if (renderMs > a.t) {
			for (let i = 1; i < n; i++) {
				if (this.buf[i]!.t >= renderMs) {
					a = this.buf[i - 1]!;
					b = this.buf[i]!;
					break;
				}
			}
		}
		const span = b.t - a.t;
		const f = span > 0 ? Math.max(0, Math.min(1, (renderMs - a.t) / span)) : 1;
		this.tick = a.tick + (b.tick - a.tick) * f;
		// Zombies in the newer frame (killed ones vanish once it is reached).
		const src = f >= 0.5 ? b : a;
		for (const [id, zb] of b.byId) {
			const za = a.byId.get(id);
			if (!za) {
				if (src === b) out.push({ ...zb });
				continue;
			}
			const dx = zb.x - za.x;
			const dy = zb.y - za.y;
			const dz = zb.z - za.z;
			const t = dx * dx + dy * dy + dz * dz > SNAP * SNAP ? 1 : f;
			out.push({
				id,
				x: za.x + dx * t,
				y: za.y + dy * t,
				z: za.z + dz * t,
				yaw: lerpAngle(za.yaw, zb.yaw, t),
				flags: t < 0.5 ? za.flags : zb.flags,
				hp: t < 0.5 ? za.hp : zb.hp
			});
		}
		if (src === a) for (const [id, za] of a.byId) if (!b.byId.has(id)) out.push({ ...za });
		// Drop frames no longer needed (keep one before renderMs).
		let drop = 0;
		while (drop + 1 < this.buf.length - 1 && this.buf[drop + 1]!.t <= renderMs) drop++;
		if (drop > 0) this.buf.splice(0, drop);
		return out;
	}
}
