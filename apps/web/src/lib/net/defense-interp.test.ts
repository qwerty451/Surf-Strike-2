/** DefenseBuffer: interpolated zombies (with their kind) and turrets, and turret shots reported once. */
import { ZDT_ACTIVE, ZDT_FIRED, type DefenseFrame, type ZdTurretNet, type ZdZombieNet } from '@surf/shared';
import { describe, expect, it } from 'vitest';
import { DefenseBuffer, type TurretShot } from './defense-interp.js';

const z = (id: number, x: number, over: Partial<ZdZombieNet> = {}): ZdZombieNet => ({ id, x, y: 0, z: 0, yaw: 0, flags: 0, hp: 1, kind: 'walker', ...over });
const t = (pad: number, yaw: number, flags = 0, target = 0): ZdTurretNet => ({ pad, yaw, pitch: 0, flags, target });
const frame = (tick: number, zombies: ZdZombieNet[], turrets: ZdTurretNet[] = []): DefenseFrame => ({ tick, zombies, turrets });

function sample(b: DefenseBuffer, ms: number) {
	const zs: ZdZombieNet[] = [];
	const ts: ZdTurretNet[] = [];
	const shots: TurretShot[] = [];
	b.sample(ms, zs, ts, shots);
	return { zs, ts, shots };
}

describe('DefenseBuffer', () => {
	it('interpolates zombies between frames and keeps their kind; the tick follows', () => {
		const b = new DefenseBuffer();
		b.push(frame(10, [z(1, 0, { kind: 'brute' })]), 1000);
		b.push(frame(12, [z(1, 100, { kind: 'brute' })]), 1031.25);
		const { zs } = sample(b, 1015.625);
		expect(zs).toHaveLength(1);
		expect(zs[0]!.x).toBeCloseTo(50);
		expect(zs[0]!.kind).toBe('brute');
		expect(b.tick).toBeCloseTo(11);
	});
	it('snaps a stall-breaker teleport instead of sliding across the map', () => {
		const b = new DefenseBuffer();
		b.push(frame(10, [z(1, 0)]), 1000);
		b.push(frame(12, [z(1, 3000)]), 1032);
		expect(sample(b, 1008).zs[0]!.x).toBe(3000);
	});
	it('interpolates turret yaw the short way round and keeps flags of the nearer frame', () => {
		const b = new DefenseBuffer();
		b.push(frame(10, [], [t(0, 170, ZDT_ACTIVE)]), 1000);
		b.push(frame(12, [], [t(0, -170, 0)]), 1032);
		const { ts } = sample(b, 1008);
		expect(Math.abs(ts[0]!.yaw)).toBeGreaterThan(170);
		expect(ts[0]!.flags & ZDT_ACTIVE).toBe(ZDT_ACTIVE);
	});
	it('reports each fired frame once as playback passes it, whatever the render rate', () => {
		const b = new DefenseBuffer();
		b.push(frame(10, [], [t(0, 0)]), 1000);
		b.push(frame(12, [], [t(0, 0, ZDT_FIRED, 5)]), 1032);
		b.push(frame(14, [], [t(0, 0, ZDT_FIRED, 6)]), 1064);
		b.push(frame(16, [], [t(0, 0)]), 1096);
		const seen: TurretShot[] = [];
		for (let ms = 1000; ms <= 1110; ms += 4) seen.push(...sample(b, ms).shots);
		expect(seen).toEqual([
			{ pad: 0, target: 5 },
			{ pad: 0, target: 6 }
		]);
	});
	it('drops late frames and empties on clear', () => {
		const b = new DefenseBuffer();
		b.push(frame(10, [z(1, 0)]), 1000);
		b.push(frame(9, [z(1, 50)]), 1010);
		expect(b.size).toBe(1);
		b.clear();
		expect(sample(b, 2000).zs).toEqual([]);
	});
});
