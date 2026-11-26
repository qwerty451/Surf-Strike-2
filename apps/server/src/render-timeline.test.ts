import assert from 'node:assert/strict';
import { it } from 'node:test';
import { renderTimeBudgetMs } from '@surf/shared';
import { AdaptiveDelay } from '../../web/src/lib/net/adaptive.ts';
import { ServerClock } from '../../web/src/lib/net/clock.ts';
import { observeRenderTime, renderRewindMs, type ModePlayer } from './modes/types.ts';

const history = 400;
const peer = () => ({ ping: 80, hasRttSample: true }) as ModePlayer;

it('keeps timestamp and legacy attacks on one slowly changing timeline', () => {
	const p = peer();
	const now = 1000;
	assert.equal(renderRewindMs(now - 110, now, p, history, 0), 110);
	for (let i = 1; i <= 6; i++) {
		const at = now + 200 * i;
		const modern = i % 2 === 0;
		const result = renderRewindMs(modern ? at - 290 : undefined, at, p, history, 0);
		assert.ok(result !== undefined && result >= 60 && result <= 180, String(result));
	}
});

it('keeps an invalid timestamp on the established timeline', () => {
	const p = peer();
	assert.equal(renderRewindMs(890, 1000, p, history, 0), 110);
	assert.equal(renderRewindMs(800, 1400, p, history, 0), 110);
});

it('uses recent states to bound attacks even when the shooter changes claim formats', () => {
	const p = peer();
	for (let now = 1000; now <= 2000; now += 20) {
		observeRenderTime(now - 110, now, p);
		assert.equal(renderRewindMs(now - 290, now, p, history, 0), 142);
		assert.equal(renderRewindMs(undefined, now, p, history, 0), 78);
	}
});

it('reanchors rewind after a 130 ms to 10 ms downlink correction', () => {
	const p = { ping: 140, hasRttSample: true } as ModePlayer;
	const clock = new ServerClock();
	const delay = new AdaptiveDelay();
	const step = 1000 / 64;
	const uplink = 10;
	let seq = 0;
	let maxSettledError = 0;
	for (let i = 0; i < 128; i++) {
		const local = 1000 + i * step;
		const downlink = i < 64 ? 130 : 10;
		if (i % 2 === 0) {
			const obs = clock.observeSnapshot(local, local - downlink, ++seq);
			delay.observeSnapshot(local, obs);
		}
		const claim = clock.renderTime(local, delay.update(local, step));
		const now = local + uplink;
		observeRenderTime(claim, now, p);
		const rewind = renderRewindMs(claim, now, p, history, 0);
		assert.ok(rewind <= renderTimeBudgetMs(p.ping));
		if (i >= 64 + 20) maxSettledError = Math.max(maxSettledError, Math.abs(rewind - (now - claim)));
	}
	assert.ok(maxSettledError < 2, `rewind still differs by ${maxSettledError} ms after 313 ms`);
});

it('follows the client delay as it grows and recovers between combat states', () => {
	const p = peer();
	const clock = new ServerClock();
	const delay = new AdaptiveDelay();
	const step = 1000 / 64;
	clock.seed(1000, 970);
	const initialDelay = delay.currentMs;
	let peakDelay = initialDelay;
	for (let i = 0; i < 128; i++) {
		const local = 1000 + i * step;
		if (i === 0 || (i >= 32 && i % 2 === 0)) delay.observeSnapshot(local, { arrivalGapMs: 31.25, transitExcessMs: 0 });
		const claim = clock.renderTime(local, delay.update(local, step));
		const now = local + 20 + [0, 6, 0, 8][i % 4]!;
		// Shots can use a newer render timestamp than the latest state.
		assert.ok(Math.abs(renderRewindMs(claim, now, p, history, 0) - (now - claim)) < 0.01);
		observeRenderTime(claim, now, p);
		peakDelay = Math.max(peakDelay, delay.currentMs);
	}
	assert.ok(peakDelay >= 190);
	assert.equal(delay.currentMs, initialDelay);
});

it('discards the old rewind window after a gap in combat states', () => {
	const p = peer();
	observeRenderTime(780, 1000, p);
	assert.equal(renderRewindMs(780, 1000, p, history, 0), 220);

	assert.equal(renderRewindMs(2031, 2101, p, history, 84), 84);
	observeRenderTime(2031, 2101, p);
	assert.equal(renderRewindMs(2031, 2101, p, history, 0), 70);
});
