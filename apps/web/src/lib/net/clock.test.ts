import { describe, expect, it } from 'vitest';
import { ServerClock } from './clock.js';

describe('ServerClock', () => {
	it('locks onto the minimum one-way transit offset and resists jitter spikes and TCP stalls', () => {
		const c = new ServerClock();
		// True clock skew = +5000 ms, min one-way downlink = 10 ms -> true min transit = 5010 ms.
		for (let i = 0; i < 40; i++) {
			const srv = i * 31.25;
			// Inject a big 140 ms TCP stall on snapshot 20 and random +5..15 ms jitter on odd packets.
			const extra = i === 20 ? 140 : i % 2 === 1 ? 12 : 0;
			const arr = srv + 5010 + extra;
			const obs = c.observeSnapshot(arr, srv, i + 1);
			expect(obs.accepted).toBe(true);
			expect(obs.seqGap).toBe(0);
			if (i === 20) expect(obs.transitExcessMs).toBeCloseTo(140, 0);
		}
		// Estimated server time at a clean arrival should match srv closely without drifting into the 140 ms stall.
		expect(c.serverTime(5010 + 1000)).toBeCloseTo(1000, 0);
		expect(c.jitter).toBeGreaterThan(5);
	});

	it('adapts smoothly to a permanent route RTT increase while keeping serverTime monotonic', () => {
		const c = new ServerClock();
		let prevEst = -Infinity;
		for (let i = 0; i < 220; i++) {
			const srv = i * 31.25;
			// At i = 40, base one-way delay jumps permanently by +30 ms.
			const base = i < 40 ? 1000 : 1030;
			const arr = srv + base;
			c.observeSnapshot(arr, srv, i + 1);
			const est = c.serverTime(arr);
			expect(est).toBeGreaterThanOrEqual(prevEst);
			prevEst = est;
		}
		// Converged to the new +30 ms offset.
		expect(c.serverTime(1030 + 5000)).toBeCloseTo(5000, 0);
	});

	it('drops duplicate and out-of-order wrapping 16-bit sequence numbers and reports gaps', () => {
		const c = new ServerClock();
		expect(c.observeSnapshot(1000, 0, 65534).accepted).toBe(true);
		expect(c.observeSnapshot(1031, 31, 65535).accepted).toBe(true);
		// Duplicate
		expect(c.observeSnapshot(1040, 31, 65535).accepted).toBe(false);
		// Out of order
		expect(c.observeSnapshot(1045, 0, 65534).accepted).toBe(false);
		// Wrap around 65535 -> 2 (skipped 0 and 1 -> seqGap = 2)
		const wrapped = c.observeSnapshot(1125, 125, 2);
		expect(wrapped.accepted).toBe(true);
		expect(wrapped.seqGap).toBe(2);
	});

	it('tracks RTT and clock offset from ping/pong replies', () => {
		const c = new ServerClock();
		const rtt = c.observePong(1000, 1024, 500);
		expect(rtt).toBe(24);
		expect(c.rtt).toBe(24);
		expect(c.minRtt).toBe(24);
		expect(c.isSynced).toBe(true);
		// Arrival 1024 corresponded to serverTime 500 -> offset = 524.
		expect(c.serverTime(1524)).toBeCloseTo(1000, 5);
		c.observePong(2000, 2040, 1500);
		expect(c.rtt).toBe(40);
		expect(c.minRtt).toBe(24);
	});

	it('ignores delayed snapshot bursts and congested pongs as clock jump evidence', () => {
		const c = new ServerClock();
		c.seed(1000, 0);
		for (let i = 1; i <= 8; i++) c.observeSnapshot(1700 + i * 31.25, i * 31.25, i);
		for (let i = 0; i < 4; i++) c.observePong(2000 + i * 1000, 2700 + i * 1000, 1000 + i * 1000);
		expect(c.serverTime(6000)).toBe(5000);
	});

	it('re-locks after fresh pongs confirm a shift and keeps render time monotonic', () => {
		const c = new ServerClock();
		c.seed(1000, 0);
		for (let i = 0; i < 3; i++) c.observePong(4000 + i * 1000, 4020 + i * 1000, 1000 + i * 1000);
		const before = c.renderTime(7019, 63);
		c.observePong(7000, 7020, 4000);
		expect(c.serverTime(7020)).toBe(4000);
		expect(c.renderTime(7020, 63)).toBe(before);
		expect(c.renderTime(10020, 63)).toBe(6937);
	});
});
