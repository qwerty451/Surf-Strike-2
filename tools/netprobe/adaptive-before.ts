// Controller from 9f0a37c. Keep the old constants for repeatable comparisons.
import { SNAPSHOT_HZ } from '@surf/shared';
import type { SnapshotClockObs } from '../../apps/web/src/lib/net/clock.ts';

type AdaptiveSnapshotInput = SnapshotClockObs & { jitterMs: number; rttMs: number };

const RENDER_DELAY_GROW_RATE = 0.35;
const RENDER_DELAY_SHRINK_RATE = 0.006;

const ADAPTIVE_MIN_MS = 50;
const ADAPTIVE_MAX_MS = 200;

/** Clean time required before the stall headroom starts decaying. */
const CLEAN_HOLD_MS = 3000;
/** Rate at which stall headroom decays after CLEAN_HOLD_MS (ms per ms). */
const STALL_DECAY_RATE = 0.006;

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

export class PreviousDelay {
	private readonly minMs: number;
	private readonly maxMs: number;
	private snapMs: number;
	private delayMs: number;
	private jitterTargetMs: number;
	private stallFloorMs = 0;
	private lastStallMs = -Infinity;

	constructor() {
		this.minMs = ADAPTIVE_MIN_MS;
		this.maxMs = ADAPTIVE_MAX_MS;
		this.snapMs = 1000 / SNAPSHOT_HZ;
		const floor = this.cleanFloor();
		this.delayMs = floor;
		this.jitterTargetMs = floor;
	}

	private cleanFloor(): number {
		// Two snapshot periods covers 1 interval + half-rAF/tick-anchor variance cleanly.
		return clamp(this.snapMs * 2, this.minMs, this.maxMs);
	}

	reset(snapshotHz = SNAPSHOT_HZ): void {
		this.snapMs = Number.isFinite(snapshotHz) && snapshotHz > 0 ? 1000 / snapshotHz : 1000 / SNAPSHOT_HZ;
		const floor = this.cleanFloor();
		this.delayMs = floor;
		this.jitterTargetMs = floor;
		this.stallFloorMs = 0;
		this.lastStallMs = -Infinity;
	}

	/** Current active interpolation delay (ms). */
	get currentMs(): number {
		return this.delayMs;
	}

	/** Current target interpolation delay (ms) that `currentMs` is slewing toward. */
	get targetMs(): number {
		return clamp(Math.max(this.jitterTargetMs, this.stallFloorMs), this.minMs, this.maxMs);
	}

	/** Feed each accepted snapshot's clock telemetry. */
	observeSnapshot(nowMs: number, input: AdaptiveSnapshotInput): void {
		const jitter = Math.max(0, Number.isFinite(input.jitterMs) ? input.jitterMs : 0);
		const floor = this.cleanFloor();
		this.jitterTargetMs = clamp(floor + 4 * jitter, this.minMs, this.maxMs);

		const gapStall = input.arrivalGapMs > this.snapMs * 2.2;
		const excessStall = input.transitExcessMs > Math.max(25, 2.5 * jitter);
		const seqLoss = input.seqGap > 0;
		if (gapStall || excessStall || seqLoss) {
			const retransmitMs = this.retransmitHeadroom(input.rttMs);
			const observedMs = Math.max(input.arrivalGapMs, input.transitExcessMs + this.snapMs) * 0.95;
			this.stallFloorMs = clamp(Math.max(this.stallFloorMs, retransmitMs, observedMs), this.minMs, this.maxMs);
			this.lastStallMs = nowMs;
		}
	}

	/** Feed a remote buffer underrun (ignoring idle/paused sources). */
	observeUnderrun(nowMs: number, overrunMs: number, rttMs: number): void {
		if (!(overrunMs > 0)) return;
		const retransmitMs = this.retransmitHeadroom(rttMs);
		const needed = this.delayMs + Math.min(overrunMs, 90);
		this.stallFloorMs = clamp(Math.max(this.stallFloorMs, retransmitMs, needed), this.minMs, this.maxMs);
		this.lastStallMs = nowMs;
	}

	/** Advance the delay smoothly over `dtMs` elapsed wall time. Returns the updated delay (ms). */
	update(nowMs: number, dtMs: number): number {
		const dt = Math.max(0, Math.min(250, dtMs));
		if (this.stallFloorMs > 0 && nowMs - this.lastStallMs >= CLEAN_HOLD_MS) {
			this.stallFloorMs = Math.max(0, this.stallFloorMs - STALL_DECAY_RATE * dt);
		}
		const target = this.targetMs;
		if (target > this.delayMs) {
			this.delayMs = Math.min(target, this.delayMs + dt * RENDER_DELAY_GROW_RATE);
		} else if (target < this.delayMs) {
			this.delayMs = Math.max(target, this.delayMs - dt * RENDER_DELAY_SHRINK_RATE);
		}
		return this.delayMs;
	}

	/** TCP fast-retransmit headroom (~RTT + 60 ms + 1 snapshot) for a single lost segment. */
	private retransmitHeadroom(rttMs: number): number {
		const rtt = Number.isFinite(rttMs) && rttMs >= 0 ? rttMs : 40;
		return clamp(rtt + 60, 45, 145) + this.snapMs;
	}
}
