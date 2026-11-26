import { describe, expect, it } from 'vitest';
import { ADAPTIVE_MAX_MS, ADAPTIVE_MIN_MS, AdaptiveDelay } from './adaptive.js';

const clean = { arrivalGapMs: 31.25, transitExcessMs: 0 };
const late = { arrivalGapMs: 160, transitExcessMs: 0 };

describe('AdaptiveDelay', () => {
	it('starts at two snapshot periods within the delay bounds', () => {
		const delay = new AdaptiveDelay({ snapshotHz: 32 });
		expect(delay.currentMs).toBe(62.5);
		delay.reset(64);
		expect(delay.currentMs).toBe(ADAPTIVE_MIN_MS);
		delay.reset(5);
		expect(delay.currentMs).toBe(ADAPTIVE_MAX_MS);
	});

	it('ignores one long stall and the queued flush even across a bucket boundary', () => {
		const delay = new AdaptiveDelay();
		delay.observeSnapshot(499, { arrivalGapMs: 202.6, transitExcessMs: 170 });
		delay.observeSnapshot(501, { arrivalGapMs: 2, transitExcessMs: 140 });
		delay.observeSnapshot(503, { arrivalGapMs: 2, transitExcessMs: 110 });
		delay.update(520, 16);
		expect(delay.targetMs).toBe(62.5);
	});

	it('adds sustained delay for repeated late arrivals, then drops it within a second of the window expiring', () => {
		const delay = new AdaptiveDelay({ snapshotHz: 64 });
		delay.observeSnapshot(1000, late);
		delay.observeSnapshot(1600, late);
		let prevRender = 1600 - delay.currentMs;
		for (let now = 1616; now < 7000; now += 16) {
			delay.observeSnapshot(now, clean);
			const render = now - delay.update(now, 16);
			expect(render).toBeGreaterThan(prevRender);
			prevRender = render;
		}
		expect(delay.currentMs).toBe(62.5);
		for (let now = 7000; now < 8000; now += 16) {
			delay.observeSnapshot(now, clean);
			delay.update(now, 16);
		}
		expect(delay.currentMs).toBe(ADAPTIVE_MIN_MS);
	});

	it.each([32, 64])('settles through recurring 100 ms gaps at %d Hz and reacts when a gap outlasts them', (snapshotHz) => {
		const delay = new AdaptiveDelay({ snapshotHz });
		const values: number[] = [];
		let arrival = 0;
		let gap = 100;
		let next = gap;
		delay.observeSnapshot(0, clean);
		for (let now = 5; now <= 8000; now += 5) {
			if (now === next) {
				delay.observeSnapshot(now, { arrivalGapMs: now - arrival, transitExcessMs: 0 });
				arrival = now;
				gap = gap === 105 ? 95 : 105;
				next += gap;
			}
			const ms = delay.update(now, 5);
			if (now >= 7000) values.push(ms);
		}
		expect(Math.max(...values) - Math.min(...values)).toBeLessThan(0.1);
		expect(delay.currentMs).toBe(62.5);
		expect(delay.update(arrival + 150, 5)).toBeGreaterThan(62.5);
	});

	it('starts slowing after the next snapshot is overdue and recovers as snapshots resume', () => {
		const delay = new AdaptiveDelay();
		delay.observeSnapshot(1000, clean);
		expect(delay.update(1040, 16)).toBe(62.5);
		expect(delay.update(1056, 16)).toBeGreaterThan(62.5);
		expect(delay.targetMs).toBe(ADAPTIVE_MAX_MS);
		delay.observeSnapshot(1120, { arrivalGapMs: 120, transitExcessMs: 80 });
		for (let frame = 0; frame < 8; frame++) {
			const now = 1122 + frame * 16;
			if (frame > 0 && frame % 2 === 0) delay.observeSnapshot(now, clean);
			delay.update(now, 16);
		}
		expect(delay.currentMs).toBe(62.5);
	});
});
