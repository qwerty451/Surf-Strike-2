import { describe, expect, it } from 'vitest';
import { clampRenderTime, MAX_RENDER_INTERPOLATION_MS, RENDER_TIME_SLACK_MS } from './lag-compensation.ts';

describe('clampRenderTime', () => {
	const now = 10_000;
	const rtt = 35;
	const allowedAge = rtt + MAX_RENDER_INTERPOLATION_MS + RENDER_TIME_SLACK_MS;

	it('accepts a claim within the measured budget, including its endpoints', () => {
		expect(clampRenderTime(now, now, rtt, 400)).toBe(now);
		expect(clampRenderTime(now - 100.5, now, rtt, 400)).toBe(now - 100.5);
		expect(clampRenderTime(now - allowedAge, now, rtt, 400)).toBe(now - allowedAge);
	});

	it('clamps a plausible claim to the history that is available', () => {
		expect(clampRenderTime(now - allowedAge, now, rtt, 200)).toBe(now - 200);
		expect(clampRenderTime(now - 500, now, 350, 400)).toBe(now - 400);
	});

	it('rejects future, implausibly old or invalid inputs before clamping', () => {
		expect(clampRenderTime(now + 0.01, now, rtt, 400)).toBeNull();
		expect(clampRenderTime(now - allowedAge - 0.01, now, rtt, 200)).toBeNull();
		expect(clampRenderTime(NaN, now, rtt, 400)).toBeNull();
		expect(clampRenderTime(now, Infinity, rtt, 400)).toBeNull();
		expect(clampRenderTime(now, now, 0, 400)).toBeNull();
		expect(clampRenderTime(now, now, NaN, 400)).toBeNull();
		expect(clampRenderTime(now, now, rtt, -1)).toBeNull();
		expect(clampRenderTime(now, now, rtt, Infinity)).toBeNull();
	});
});
