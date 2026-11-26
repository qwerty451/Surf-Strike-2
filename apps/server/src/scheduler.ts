/**
 * Drift-free absolute-deadline tick scheduler for the game server
 * (docs/architecture.md#netcode).
 *
 * Replaces stacked `setInterval` calls (which truncate fractional ms periods
 * like 1000/32 = 31.25 -> 31 ms and drift out of phase with each other) with a
 * single monotonic deadline loop that runs mode ticks immediately before
 * snapshot sends and recovers from event-loop stalls without burst-sending.
 */
import { performance } from 'node:perf_hooks';

export interface PeriodicTask {
	everyMs: number;
	run: () => void;
}

export interface TickSchedulerOptions {
	/** Primary loop frequency (Hz). */
	hz: number;
	/** Called once per tick in monotonic order. */
	onTick: (now: number, tick: number) => void;
	/** Slower periodic tasks driven from the same scheduler. */
	periodic?: PeriodicTask[];
	/** Monotonic clock in ms (default: `performance.now`). */
	clock?: () => number;
	/** Injectable timers for deterministic tests. */
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

interface ScheduledPeriodic extends PeriodicTask {
	nextAt: number;
}

export class TickScheduler {
	private readonly intervalMs: number;
	private readonly onTick: (now: number, tick: number) => void;
	private readonly clock: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;
	private readonly tasks: ScheduledPeriodic[];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private nextDeadline = 0;
	private tick = 0;
	private running = false;

	constructor(opts: TickSchedulerOptions) {
		this.intervalMs = 1000 / opts.hz;
		this.onTick = opts.onTick;
		this.clock = opts.clock ?? (() => performance.now());
		this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));
		this.tasks = (opts.periodic ?? []).map((t) => ({ ...t, nextAt: 0 }));
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		const now = this.clock();
		this.nextDeadline = now + this.intervalMs;
		for (const t of this.tasks) t.nextAt = now + t.everyMs;
		this.arm(now);
	}

	stop(): void {
		this.running = false;
		if (this.timer !== null) {
			this.clearTimer(this.timer);
			this.timer = null;
		}
	}

	private arm(now: number): void {
		if (!this.running) return;
		const wait = Math.max(0, Math.round(this.nextDeadline - now));
		this.timer = this.setTimer(() => this.step(), wait);
	}

	private step(): void {
		this.timer = null;
		if (!this.running) return;
		const now = this.clock();
		// Guard against an OS timer waking noticeably earlier than requested.
		if (now + 1 < this.nextDeadline) {
			this.arm(now);
			return;
		}

		this.onTick(now, this.tick++);

		for (const task of this.tasks) {
			if (!this.running) return;
			if (now >= task.nextAt) {
				task.run();
				// Fast-forward past stalled periods without burst-firing.
				const skipped = Math.floor((now - task.nextAt) / task.everyMs) + 1;
				task.nextAt += skipped * task.everyMs;
			}
		}

		if (!this.running) return;
		// Advance to the next grid slot strictly after `now` (never burst-send after a stall).
		const after = this.clock();
		const missed = after >= this.nextDeadline ? Math.floor((after - this.nextDeadline) / this.intervalMs) + 1 : 1;
		this.nextDeadline += missed * this.intervalMs;
		this.arm(after);
	}
}
