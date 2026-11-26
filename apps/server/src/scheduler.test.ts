import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TickScheduler } from './scheduler.ts';

function fakeEnv() {
	let now = 0;
	let nextId = 1;
	const pending = new Map<number, { at: number; fn: () => void }>();

	return {
		get now() {
			return now;
		},
		clock: () => now,
		setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
			const id = nextId++;
			// Simulate Node's integer-ms timer truncation.
			const delay = Math.max(0, Math.trunc(ms));
			pending.set(id, { at: now + delay, fn });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer(id: ReturnType<typeof setTimeout>): void {
			pending.delete(id as unknown as number);
		},
		/** Advance virtual clock to `targetMs`, running timers in order. */
		advanceTo(targetMs: number): void {
			while (true) {
				let bestId = -1;
				let bestAt = Infinity;
				for (const [id, entry] of pending) {
					if (entry.at <= targetMs && entry.at < bestAt) {
						bestAt = entry.at;
						bestId = id;
					}
				}
				if (bestId < 0) break;
				const entry = pending.get(bestId)!;
				pending.delete(bestId);
				now = Math.max(now, entry.at);
				entry.fn();
			}
			now = targetMs;
		},
		/** Jump clock forward instantaneously (simulating an event-loop stall), then fire due timers once. */
		stall(ms: number): void {
			now += ms;
			this.advanceTo(now);
		},
		get pendingCount(): number {
			return pending.size;
		}
	};
}

describe('TickScheduler', () => {
	it('maintains exact fractional 32 Hz and 64 Hz cadence with zero cumulative drift', () => {
		for (const hz of [32, 64]) {
			const env = fakeEnv();
			const times: number[] = [];
			const sched = new TickScheduler({
				hz,
				clock: env.clock,
				setTimer: env.setTimer,
				clearTimer: env.clearTimer,
				onTick: (t) => times.push(t)
			});
			sched.start();
			env.advanceTo(10_000);
			sched.stop();

			// 10 s at 32 Hz = 320 ticks (exact; setInterval(31) would have fired 322 ticks and drifted 80 ms!).
			assert.equal(times.length, hz * 10);
			assert.equal(times[times.length - 1], 10_000);
			assert.equal(env.pendingCount, 0);
		}
	});

	it('recovers from an event-loop stall without burst-sending missed ticks', () => {
		const env = fakeEnv();
		let ticks = 0;
		let slow = 0;
		const sched = new TickScheduler({
			hz: 32,
			clock: env.clock,
			setTimer: env.setTimer,
			clearTimer: env.clearTimer,
			onTick: () => {
				ticks++;
			},
			periodic: [{ everyMs: 100, run: () => slow++ }]
		});
		sched.start();
		// Normal 100 ms -> 3 ticks, 1 slow run.
		env.advanceTo(100);
		const ticksBefore = ticks;
		const slowBefore = slow;

		// 300 ms stall: only ONE tick and ONE slow run should execute on wake, never a burst of 9!
		env.stall(300);
		assert.equal(ticks - ticksBefore, 1);
		assert.equal(slow - slowBefore, 1);

		// Normal grid resumes cleanly after the stall (grid slots at 406.25, 437.5, 468.75, 500.0 ms = 4 more ticks).
		env.advanceTo(500);
		assert.equal(ticks - ticksBefore, 5);
		sched.stop();
	});

	it('runs periodic slow tasks at the expected rate and stops cleanly', () => {
		const env = fakeEnv();
		let rot = 0;
		let sb = 0;
		const sched = new TickScheduler({
			hz: 32,
			clock: env.clock,
			setTimer: env.setTimer,
			clearTimer: env.clearTimer,
			onTick: () => {},
			periodic: [
				{ everyMs: 100, run: () => rot++ },
				{ everyMs: 1000, run: () => sb++ }
			]
		});
		sched.start();
		env.advanceTo(5_000);
		sched.stop();

		assert.equal(rot, 50);
		assert.equal(sb, 5);
		assert.equal(env.pendingCount, 0);
	});
});
