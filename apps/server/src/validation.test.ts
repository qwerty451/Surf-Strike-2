import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FLAG_TELEPORTED, TICK_RATE, withTeleportSeq } from '@surf/shared';
import { RunValidator } from './validation.ts';
import { netState, testMap } from './test-helpers.ts';

const MS = (ticks: number) => (ticks / TICK_RATE) * 1000;

/** Valid run: start at tick 1000, stage at +256, end at +512. */
function goodRun(v: RunValidator, t0 = 50_000) {
	v.onState(netState(998, 150));
	v.onZone('start', 0, 1000, t0);
	for (let t = 1000; t <= 1512; t += 2) v.onState(netState(t, 216 + (t - 1000) * 3.6));
	assert.equal(v.onZone('stage', 2, 1256, t0 + MS(256)), null);
	return v.onZone('end', 0, 1512, t0 + MS(512));
}

describe('RunValidator', () => {
	it('accepts a valid run', () => {
		const r = goodRun(new RunValidator(testMap()));
		assert.deepEqual(r, { ok: true, ticks: 512, splits: [256] });
	});

	it('rejects end without a run', () => {
		const v = new RunValidator(testMap());
		assert.deepEqual(v.onZone('end', 0, 10, 0), { ok: false, reason: 'no run in progress' });
	});

	it('rejects skipped stages and wrong order', () => {
		const v = new RunValidator(testMap());
		v.onZone('start', 0, 0, 0);
		v.onState(netState(512, 2050));
		assert.deepEqual(v.onZone('end', 0, 512, MS(512)), { ok: false, reason: 'zones out of order' });

		const w = new RunValidator(testMap());
		w.onZone('start', 0, 0, 0);
		w.onZone('stage', 3, 100, MS(100));
		w.onState(netState(512, 2050));
		assert.deepEqual(w.onZone('end', 0, 512, MS(512)), { ok: false, reason: 'zones out of order' });

		const x = new RunValidator(testMap());
		x.onZone('start', 0, 0, 0);
		x.onZone('checkpoint', 2, 100, MS(100));
		x.onState(netState(512, 2050));
		assert.equal((x.onZone('end', 0, 512, MS(512)) as { ok: false }).ok, false);
	});

	it('rejects speed above sv_maxvelocity per axis', () => {
		const v = new RunValidator(testMap());
		v.onZone('start', 0, 0, 0);
		v.onState(netState(2, 300, { vx: 3500.5, vy: -3500.5 }));
		v.onState(netState(4, 310, { vx: 3502 }));
		v.onZone('stage', 2, 100, MS(100));
		v.onState(netState(512, 2050));
		assert.deepEqual(v.onZone('end', 0, 512, MS(512)), { ok: false, reason: 'speed above sv_maxvelocity' });
	});

	it('rejects position jumps but allows known teleports', () => {
		const v = new RunValidator(testMap());
		v.onZone('start', 0, 0, 0);
		v.onState(netState(2, 300));
		v.onState(netState(4, 1800)); // 1500 units in 2 ticks
		v.onZone('stage', 2, 100, MS(100));
		v.onState(netState(512, 2050));
		assert.deepEqual(v.onZone('end', 0, 512, MS(512)), { ok: false, reason: 'position jump' });

		const w = new RunValidator(testMap());
		w.onZone('start', 0, 0, 0);
		w.onState(netState(2, 300));
		w.onZone('stage', 2, 100, MS(100));
		w.onState(netState(200, 1500, { z: -500 }));
		w.onState(netState(202, 1050, { z: 10, flags: FLAG_TELEPORTED })); // to stage respawn
		w.onState(netState(204, 1060));
		w.onState(netState(512, 2050));
		assert.equal((w.onZone('end', 0, 512, MS(512)) as { ok: boolean }).ok, true);

		const x = new RunValidator(testMap());
		x.onZone('start', 0, 0, 0);
		x.onState(netState(2, 300));
		x.onState(netState(4, 1900, { flags: FLAG_TELEPORTED })); // not a respawn point
		x.onZone('stage', 2, 100, MS(100));
		x.onState(netState(512, 2050));
		assert.deepEqual(x.onZone('end', 0, 512, MS(512)), { ok: false, reason: 'position jump' });
	});

	it('accepts teleports signalled only by the wrapping teleport counter', () => {
		const w = new RunValidator(testMap());
		w.onZone('start', 0, 0, 0);
		w.onState(netState(2, 300, { flags: withTeleportSeq(0, 1) }));
		w.onZone('stage', 2, 100, MS(100));
		w.onState(netState(200, 1500, { z: -500, flags: withTeleportSeq(0, 1) }));
		// Suppose the single-tick FLAG_TELEPORTED packet was dropped; seq 1 -> 2 still allows the respawn jump.
		w.onState(netState(202, 1050, { z: 10, flags: withTeleportSeq(0, 2) }));
		w.onState(netState(204, 1060, { flags: withTeleportSeq(0, 2) }));
		w.onState(netState(512, 2050, { flags: withTeleportSeq(0, 2) }));
		assert.equal((w.onZone('end', 0, 512, MS(512)) as { ok: boolean }).ok, true);
	});

	it('accepts teleports to a fixed teleporter destination', () => {
		const map = testMap();
		map.zones.push({ type: 'teleport', min: { x: 500, y: -100, z: 0 }, max: { x: 600, y: 100, z: 100 }, to: 'stage', dest: { pos: { x: 1900, y: 0, z: 0 }, yaw: 90 } });
		const v = new RunValidator(map);
		v.onZone('start', 0, 0, 0);
		v.onState(netState(2, 300));
		v.onZone('stage', 2, 100, MS(100));
		v.onState(netState(150, 550));
		v.onState(netState(152, 1900, { flags: FLAG_TELEPORTED }));
		v.onState(netState(512, 2050));
		assert.equal((v.onZone('end', 0, 512, MS(512)) as { ok: boolean }).ok, true);
	});

	it('checks ticks against wall-clock time', () => {
		const mk = () => {
			const v = new RunValidator(testMap());
			v.onZone('start', 0, 0, 0);
			v.onZone('stage', 2, 1000, MS(1000));
			v.onState(netState(640, 2050));
			return v;
		};
		// 640 ticks = 10 s at 64 tick; ±5% + 0.3 s = ±0.8 s
		assert.equal((mk().onZone('end', 0, 640, 10_700) as { ok: boolean }).ok, true);
		assert.equal((mk().onZone('end', 0, 640, 9_300) as { ok: boolean }).ok, true);
		assert.deepEqual(mk().onZone('end', 0, 640, 11_000), {
			ok: false,
			reason: 'timer does not match wall-clock time'
		});
		assert.equal((mk().onZone('end', 0, 640, 8_000) as { ok: boolean }).ok, false);
	});

	it('requires the last state to be near the end zone', () => {
		const v = new RunValidator(testMap());
		v.onZone('start', 0, 0, 0);
		v.onZone('stage', 2, 100, MS(100));
		v.onState(netState(510, 1500));
		assert.deepEqual(v.onZone('end', 0, 512, MS(512)), { ok: false, reason: 'not in the end zone' });
		const w = new RunValidator(testMap());
		w.onZone('start', 0, 0, 0);
		w.onZone('stage', 2, 100, MS(100));
		w.onState(netState(510, 1960)); // hull edge 1976 within 64 of 2000
		assert.equal((w.onZone('end', 0, 512, MS(512)) as { ok: boolean }).ok, true);
	});

	it('a new start resets a failed run', () => {
		const v = new RunValidator(testMap());
		v.onZone('start', 0, 0, 0);
		v.onState(netState(2, 300, { vx: 9000 }));
		assert.deepEqual(goodRun(v, 100_000), { ok: true, ticks: 512, splits: [256] });
	});

	it('cancel drops the run', () => {
		const v = new RunValidator(testMap());
		v.onZone('start', 0, 0, 0);
		v.cancel();
		assert.equal(v.isRunning, false);
		assert.equal((v.onZone('end', 0, 512, MS(512)) as { ok: boolean }).ok, false);
	});
});
