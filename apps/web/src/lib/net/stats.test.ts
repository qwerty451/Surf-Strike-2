import { describe, expect, it } from 'vitest';
import { NetStats } from './stats.js';

describe('NetStats', () => {
	it('measures snapshot rate, rolling bytes/s and RFC 3550 jitter', () => {
		const s = new NetStats();
		s.recordRtt(24);
		s.setInterpDelay(100);
		for (let i = 0; i < 32; i++) {
			const serverT = i * 31.25;
			// Alternating +0 / +16 ms downlink jitter -> |dTransit| = 16 ms every snapshot.
			const arr = 1000 + serverT + (i % 2 === 0 ? 0 : 16);
			s.recordTraffic('in', 500, arr);
			s.recordTraffic('out', 44, arr);
			s.recordSnapshot(arr, { serverTimeMs: serverT, seq: i, selfId: 1, entries: [{ id: 2, tick: i * 2 }] });
		}
		const v = s.view(1999, true);
		expect(v.rttMs).toBe(24);
		expect(v.interpMs).toBe(100);
		expect(v.snapHz).toBe(32);
		expect(v.inBytesPerSec).toBe(32 * 500);
		expect(v.outBytesPerSec).toBe(32 * 44);
		expect(v.jitterMs).toBeGreaterThan(10);
		expect(v.jitterMs).toBeLessThanOrEqual(16);
		expect(v.dupPct).toBe(0);
		expect(v.lateCount).toBe(0);
		expect(v.samples.length).toBe(32);
	});

	it('counts duplicate remote ticks, late sequence numbers, underruns and extrapolation', () => {
		const s = new NetStats();
		s.recordSnapshot(1000, { serverTimeMs: 0, seq: 10, selfId: 1, entries: [{ id: 2, tick: 100 }] });
		s.recordSnapshot(1031.25, { serverTimeMs: 31.25, seq: 11, selfId: 1, entries: [{ id: 2, tick: 102 }] });
		// Duplicate relayed tick (102 again).
		s.recordSnapshot(1062.5, { serverTimeMs: 62.5, seq: 12, selfId: 1, entries: [{ id: 2, tick: 102 }] });
		// Late / out-of-order snapshot seq.
		s.recordSnapshot(1070, { serverTimeMs: 50, seq: 11, selfId: 1, entries: [{ id: 2, tick: 101 }] });

		// One underrun episode lasting 3 frames (2 extrapolated, 1 frozen).
		s.recordFrame(1080, 16, true, true);
		s.recordFrame(1096, 16, true, true);
		s.recordFrame(1112, 16, true, false);
		s.recordFrame(1128, 16, false, false);
		// Second distinct underrun episode.
		s.recordFrame(1144, 16, true, false);

		const v = s.view(1150, true);
		expect(v.underruns).toBe(2);
		expect(v.underrunMs).toBe(64);
		expect(v.extrapMs).toBe(32);
		// Entries after first sample: tick 102 (ok), tick 102 (dup), tick 101 (late) -> 1/3 dup.
		expect(v.dupPct).toBeCloseTo(33.33, 1);
		// Late seq (1) + dup tick (1) + backwards tick (1) = 3.
		expect(v.lateCount).toBe(3);
	});

	it('expires old samples outside the rolling windows', () => {
		const s = new NetStats();
		s.recordTraffic('in', 1000, 1000);
		s.recordFrame(1000, 16, true, true);
		expect(s.view(1500).inBytesPerSec).toBe(1000);
		expect(s.view(1500).underruns).toBe(1);
		// After >1 s traffic expires; after >10 s events expire.
		expect(s.view(2500).inBytesPerSec).toBe(0);
		expect(s.view(2500).underruns).toBe(1);
		expect(s.view(12000).underruns).toBe(0);
	});
});
