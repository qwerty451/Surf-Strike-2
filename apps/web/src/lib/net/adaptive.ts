/** Adaptive remote interpolation delay on the server clock. */
import { MAX_RENDER_INTERPOLATION_MS, RENDER_DELAY_GROW_RATE, RENDER_DELAY_SHRINK_RATE, SNAPSHOT_HZ } from '@surf/shared';
import type { SnapshotClockObs } from './clock.js';

export const ADAPTIVE_MIN_MS = 50;
export const ADAPTIVE_MAX_MS = MAX_RENDER_INTERPOLATION_MS;

const WINDOW_MS = 6000;
const BUCKET_MS = 500;
const BUCKET_COUNT = WINDOW_MS / BUCKET_MS;
/** Bound the steady delay on links with frequent stalls. */
const MAX_SUSTAINED_MS = 62.5;
/** Allow for pose age behind the snapshot header and for display-frame quantization. */
const BUFFER_MARGIN_MS = 16;
/** Budget only part of the extrapolation horizon in the sustained estimate. */
const SUSTAINED_EXTRAP_MS = 50;
/** Allow for delivery variation before treating an arrival as overdue. */
const STALL_LATE_MS = 12;
const STALL_MAX_MS = 500;
const RECURRING_GAP_COUNT = 3;

export interface AdaptiveDelayOptions {
	minMs?: number;
	maxMs?: number;
	snapshotHz?: number;
}

type ArrivalTiming = Pick<SnapshotClockObs, 'arrivalGapMs' | 'transitExcessMs'>;

export class AdaptiveDelay {
	private readonly minMs: number;
	private readonly maxMs: number;
	private snapMs: number;
	private delayMs: number;
	private target: number;
	private lastArrivalMs = -Infinity;
	private lastTransitExcessMs = 0;
	private consecutiveBufferedGaps = 0;
	private readonly peaks = Array.from({ length: BUCKET_COUNT }, () => ({ bucket: -Infinity, ageMs: 0 }));

	constructor(opts: AdaptiveDelayOptions = {}) {
		this.minMs = opts.minMs ?? ADAPTIVE_MIN_MS;
		this.maxMs = opts.maxMs ?? ADAPTIVE_MAX_MS;
		this.snapMs = 1000 / (opts.snapshotHz ?? SNAPSHOT_HZ);
		this.delayMs = this.target = this.cleanFloor();
	}

	private cleanFloor(): number {
		return Math.min(this.maxMs, Math.max(this.minMs, this.snapMs * 2));
	}

	reset(snapshotHz = SNAPSHOT_HZ): void {
		this.snapMs = 1000 / (Number.isFinite(snapshotHz) && snapshotHz > 0 ? snapshotHz : SNAPSHOT_HZ);
		this.delayMs = this.target = this.cleanFloor();
		this.lastArrivalMs = -Infinity;
		this.lastTransitExcessMs = 0;
		this.consecutiveBufferedGaps = 0;
		for (const peak of this.peaks) peak.bucket = -Infinity;
	}

	get currentMs(): number {
		return this.delayMs;
	}

	get targetMs(): number {
		return this.target;
	}

	observeSnapshot(nowMs: number, { arrivalGapMs, transitExcessMs }: ArrivalTiming): void {
		// Measure the age of the previous snapshot immediately before this arrival.
		// A TCP flush contributes its long gap once instead of counting every queued frame as a stall.
		const ageMs = arrivalGapMs + this.lastTransitExcessMs;
		this.lastTransitExcessMs = transitExcessMs;
		this.lastArrivalMs = nowMs;
		// Ignore packets in a TCP flush when recognizing a regular late cadence.
		if (arrivalGapMs >= this.snapMs / 2) {
			const sustainedLimit = Math.max(this.cleanFloor(), Math.min(MAX_SUSTAINED_MS, this.maxMs));
			const buffered = arrivalGapMs >= this.snapMs + STALL_LATE_MS
				&& ageMs <= sustainedLimit + SUSTAINED_EXTRAP_MS;
			this.consecutiveBufferedGaps = buffered ? this.consecutiveBufferedGaps + 1 : 0;
		}
		if (arrivalGapMs < this.snapMs) return;

		const bucket = Math.floor(nowMs / BUCKET_MS);
		const peak = this.peaks[bucket % BUCKET_COUNT]!;
		if (peak.bucket !== bucket) {
			peak.bucket = bucket;
			peak.ageMs = ageMs;
		} else {
			peak.ageMs = Math.max(peak.ageMs, ageMs);
		}
	}

	update(nowMs: number, dtMs: number): number {
		const bucket = Math.floor(nowMs / BUCKET_MS);
		let highest = 0;
		let second = 0;
		for (const peak of this.peaks) {
			if (peak.bucket <= bucket - BUCKET_COUNT) continue;
			if (peak.ageMs >= highest) {
				second = highest;
				highest = peak.ageMs;
			} else {
				second = Math.max(second, peak.ageMs);
			}
		}

		// An isolated high bucket cannot set the sustained delay. Extrapolation supplies some of the headroom.
		const bufferedAge = second + BUFFER_MARGIN_MS - SUSTAINED_EXTRAP_MS;
		const sustained = Math.max(this.cleanFloor(), Math.min(MAX_SUSTAINED_MS, bufferedAge));
		// Let extrapolation cover recurrent gaps within its budget. Slow playback
		// sooner for unexpected gaps and for gaps beyond that budget.
		const expectedGap = this.consecutiveBufferedGaps >= RECURRING_GAP_COUNT
			? Math.min(second, sustained + SUSTAINED_EXTRAP_MS)
			: this.snapMs;
		const gap = nowMs - this.lastArrivalMs;
		const stalled = gap >= Math.max(this.snapMs, expectedGap) + STALL_LATE_MS && gap < STALL_MAX_MS;
		this.target = stalled ? this.maxMs : Math.min(this.maxMs, sustained);

		const dt = Math.max(0, Math.min(250, dtMs));
		this.delayMs += Math.max(-dt * RENDER_DELAY_SHRINK_RATE, Math.min(dt * RENDER_DELAY_GROW_RATE, this.target - this.delayMs));
		return this.delayMs;
	}
}
