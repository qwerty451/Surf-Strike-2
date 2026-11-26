/**
 * Zombie Defense interpolation (docs/modes.md#zombie-defense): BIN_DEFENSE
 * frames are kept with their arrival time and sampled INTERP_DELAY_MS in the
 * past, like Zombie Run's (zombie-interp.ts), with the zombie kind and the
 * turrets' aim. Turret shots (ZDT_FIRED) are reported once per frame as
 * playback passes it, so a flash or tracer never repeats or skips with the
 * render rate. The sampled sim tick is sent with shots for lag compensation.
 */
import { ZDT_FIRED, type DefenseFrame, type ZdTurretNet, type ZdZombieNet } from '@surf/shared';
import { lerpAngle } from './interp.js';

const CAPACITY = 16;
/** Larger jumps snap instead of interpolating (stall-breaker teleports). */
const SNAP = 512;

interface Entry {
	t: number;
	tick: number;
	byId: Map<number, ZdZombieNet>;
	turrets: ZdTurretNet[];
}

/** A turret shot that playback reached: pad, and the zombie it fired at (0 = none). */
export interface TurretShot {
	pad: number;
	target: number;
}

export class DefenseBuffer {
	private buf: Entry[] = [];
	/** Interpolated sim tick of the last sample (lag compensation). */
	tick = 0;
	/** Tick of the newest frame whose shots were reported. */
	private shotTick = -1;

	push(frame: DefenseFrame, arrivalMs: number): void {
		const last = this.buf[this.buf.length - 1];
		if (last && frame.tick <= last.tick) return; // late or duplicate frame
		if (last && arrivalMs < last.t) arrivalMs = last.t;
		this.buf.push({ t: arrivalMs, tick: frame.tick, byId: new Map(frame.zombies.map((z) => [z.id, z])), turrets: frame.turrets });
		if (this.buf.length > CAPACITY) this.buf.shift();
	}

	clear(): void {
		this.buf.length = 0;
		this.tick = 0;
		this.shotTick = -1;
	}

	get size(): number {
		return this.buf.length;
	}

	/**
	 * Zombies and turrets at `renderMs` (already delayed), into `zombies` and
	 * `turrets` (reused); turret shots of every frame reached since the last
	 * call go into `shots`.
	 */
	sample(renderMs: number, zombies: ZdZombieNet[], turrets: ZdTurretNet[], shots: TurretShot[] = []): void {
		zombies.length = 0;
		turrets.length = 0;
		shots.length = 0;
		const n = this.buf.length;
		if (n === 0) return;
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
		// Shots: every frame up to the one being played (a) whose shots were not reported yet.
		const reached = f >= 1 ? b.tick : a.tick;
		if (this.shotTick < 0) this.shotTick = reached - 1;
		for (const e of this.buf) {
			if (e.tick <= this.shotTick || e.tick > reached) continue;
			for (const t of e.turrets) if (t.flags & ZDT_FIRED) shots.push({ pad: t.pad, target: t.target });
		}
		if (reached > this.shotTick) this.shotTick = reached;
		const src = f >= 0.5 ? b : a;
		for (const [id, zb] of b.byId) {
			const za = a.byId.get(id);
			if (!za) {
				if (src === b) zombies.push({ ...zb });
				continue;
			}
			const dx = zb.x - za.x;
			const dy = zb.y - za.y;
			const dz = zb.z - za.z;
			const t = dx * dx + dy * dy + dz * dz > SNAP * SNAP ? 1 : f;
			zombies.push({
				id,
				x: za.x + dx * t,
				y: za.y + dy * t,
				z: za.z + dz * t,
				yaw: lerpAngle(za.yaw, zb.yaw, t),
				flags: t < 0.5 ? za.flags : zb.flags,
				hp: t < 0.5 ? za.hp : zb.hp,
				kind: zb.kind
			});
		}
		if (src === a) for (const [id, za] of a.byId) if (!b.byId.has(id)) zombies.push({ ...za });
		for (const tb of b.turrets) {
			const ta = a.turrets.find((x) => x.pad === tb.pad);
			if (!ta) {
				turrets.push({ ...tb });
				continue;
			}
			turrets.push({
				pad: tb.pad,
				yaw: lerpAngle(ta.yaw, tb.yaw, f),
				pitch: ta.pitch + (tb.pitch - ta.pitch) * f,
				flags: src.turrets.find((x) => x.pad === tb.pad)?.flags ?? tb.flags,
				target: tb.target
			});
		}
		// Drop frames no longer needed (keep one before renderMs).
		let drop = 0;
		while (drop + 1 < this.buf.length - 1 && this.buf[drop + 1]!.t <= renderMs) drop++;
		if (drop > 0) this.buf.splice(0, drop);
	}
}
