/**
 * Rolling client network telemetry for the `net_graph` overlay
 * (docs/ui.md#developer-console). Pure TypeScript, no DOM or Three.js.
 */
import { INTERP_DELAY_MS, SNAPSHOT_HZ } from '@surf/shared';

/** One bar of the `net_graph 2` sparkline. */
export interface NetGraphSample {
	/** Snapshot inter-arrival gap (ms). */
	gapMs: number;
	/** At least one remote buffer underran since the previous snapshot. */
	underrun: boolean;
	/** Most recent RTT estimate (ms) when this snapshot arrived. */
	rttMs: number;
}

/** Snapshot of rolling network stats published to the HUD. */
export interface NetGraphView {
	/** Latest round-trip time (ms); -1 when unknown. */
	rttMs: number;
	/** RFC 3550 smoothed snapshot transit / arrival jitter (ms). */
	jitterMs: number;
	/** Current remote interpolation delay (ms). */
	interpMs: number;
	/** Measured inbound snapshot rate (snapshots/s over the last 1 s). */
	snapHz: number;
	/** Distinct underrun episodes in the last 10 s. */
	underruns: number;
	/** Total time spent starved (past the newest sample) in the last 10 s (ms). */
	underrunMs: number;
	/** Total time spent extrapolating in the last 10 s (ms). */
	extrapMs: number;
	/** Percentage of remote player entries that repeated the previous sim tick (0..100). */
	dupPct: number;
	/** Out-of-order, late, or duplicate snapshots / entries in the last 10 s. */
	lateCount: number;
	/** Inbound bytes/s over the last 1 s (JSON + binary). */
	inBytesPerSec: number;
	/** Outbound bytes/s over the last 1 s (JSON + binary). */
	outBytesPerSec: number;
	/** Recent snapshot inter-arrival history (newest last), populated for `net_graph 2`. */
	samples: readonly NetGraphSample[];
}

const SPARKLINE_MAX = 120;
const TRAFFIC_BUCKETS = 10; // 10 × 100 ms = 1 s window
const TRAFFIC_BUCKET_MS = 100;
const EVENT_BUCKETS = 20; // 20 × 500 ms = 10 s window
const EVENT_BUCKET_MS = 500;

interface TrafficBucket {
	slot: number;
	bytesIn: number;
	bytesOut: number;
	snaps: number;
}

interface EventBucket {
	slot: number;
	underruns: number;
	underrunMs: number;
	extrapMs: number;
	entries: number;
	dupEntries: number;
	lateCount: number;
}

/** Rolling 1 s (rates) and 10 s (underruns, duplicates, late frames) network statistics. */
export class NetStats {
	private rttMs = -1;
	private jitterMs = 0;
	private interpMs = INTERP_DELAY_MS;
	private nominalSnapMs = 1000 / SNAPSHOT_HZ;

	private lastArrivalMs = -Infinity;
	private lastTransitMs = NaN;
	private lastSeq = -1;
	private pendingUnderrun = false;
	private wasUnderrun = false;

	/** Per remote player: last seen sim tick and whether tick has ever progressed. */
	private readonly playerTicks = new Map<number, { tick: number; progressed: boolean }>();

	private readonly traffic: TrafficBucket[] = Array.from({ length: TRAFFIC_BUCKETS }, () => ({
		slot: -1,
		bytesIn: 0,
		bytesOut: 0,
		snaps: 0
	}));
	private readonly events: EventBucket[] = Array.from({ length: EVENT_BUCKETS }, () => ({
		slot: -1,
		underruns: 0,
		underrunMs: 0,
		extrapMs: 0,
		entries: 0,
		dupEntries: 0,
		lateCount: 0
	}));
	private readonly sparkline: NetGraphSample[] = [];

	reset(): void {
		this.rttMs = -1;
		this.jitterMs = 0;
		this.interpMs = INTERP_DELAY_MS;
		this.nominalSnapMs = 1000 / SNAPSHOT_HZ;
		this.lastArrivalMs = -Infinity;
		this.lastTransitMs = NaN;
		this.lastSeq = -1;
		this.pendingUnderrun = false;
		this.wasUnderrun = false;
		this.playerTicks.clear();
		for (const b of this.traffic) b.slot = -1;
		for (const b of this.events) b.slot = -1;
		this.sparkline.length = 0;
	}

	/** Reset per-player tick tracking (e.g. on map change). */
	resetPlayers(): void {
		this.playerTicks.clear();
		this.wasUnderrun = false;
	}

	setNominalSnapHz(hz: number): void {
		if (Number.isFinite(hz) && hz > 0) this.nominalSnapMs = 1000 / hz;
	}

	setInterpDelay(ms: number): void {
		if (Number.isFinite(ms) && ms >= 0) this.interpMs = ms;
	}

	recordRtt(rttMs: number): void {
		if (Number.isFinite(rttMs) && rttMs >= 0 && rttMs < 60_000) this.rttMs = rttMs;
	}

	recordTraffic(dir: 'in' | 'out', bytes: number, now: number): void {
		if (!(bytes > 0)) return;
		const b = this.trafficBucket(now);
		if (dir === 'in') b.bytesIn += bytes;
		else b.bytesOut += bytes;
	}

	/**
	 * Record an inbound snapshot frame.
	 * Pass `serverTimeMs` and `seq` when available (protocol v2+) for true RFC 3550
	 * transit jitter and out-of-order / duplicate sequence detection.
	 */
	recordSnapshot(
		arrivalMs: number,
		opts: {
			serverTimeMs?: number;
			seq?: number;
			selfId?: number;
			entries?: readonly { id: number; tick: number }[];
		} = {}
	): void {
		const tb = this.trafficBucket(arrivalMs);
		tb.snaps++;
		const eb = this.eventBucket(arrivalMs);

		// Sequence-level duplicate / out-of-order check (16-bit wrapping).
		let lateFrame = false;
		if (opts.seq !== undefined) {
			if (this.lastSeq >= 0) {
				const diff = ((opts.seq - this.lastSeq) << 16) >> 16;
				if (diff <= 0) {
					lateFrame = true;
					eb.lateCount++;
				} else {
					this.lastSeq = opts.seq;
				}
			} else {
				this.lastSeq = opts.seq;
			}
		}

		// Inter-arrival gap and RFC 3550 jitter.
		const hasPrev = Number.isFinite(this.lastArrivalMs);
		const gapMs = hasPrev ? Math.max(0, arrivalMs - this.lastArrivalMs) : this.nominalSnapMs;
		this.lastArrivalMs = arrivalMs;

		if (!lateFrame) {
			if (opts.serverTimeMs !== undefined) {
				const transit = arrivalMs - opts.serverTimeMs;
				if (Number.isFinite(this.lastTransitMs)) {
					const d = Math.abs(transit - this.lastTransitMs);
					this.jitterMs += (d - this.jitterMs) / 16;
				}
				this.lastTransitMs = transit;
			} else if (hasPrev) {
				const d = Math.abs(gapMs - this.nominalSnapMs);
				this.jitterMs += (d - this.jitterMs) / 16;
			}
		}

		// Per-player tick deltas (detects 64->32 Hz relayed duplicate ticks and late ticks).
		if (opts.entries) {
			const selfId = opts.selfId ?? -1;
			for (const e of opts.entries) {
				if (e.id === selfId) continue;
				const prev = this.playerTicks.get(e.id);
				if (!prev) {
					this.playerTicks.set(e.id, { tick: e.tick, progressed: false });
					continue;
				}
				eb.entries++;
				const dt = e.tick - prev.tick;
				if (dt > 0) {
					prev.tick = e.tick;
					prev.progressed = true;
				} else if (dt === 0) {
					if (prev.progressed) {
						eb.dupEntries++;
						eb.lateCount++;
					}
				} else {
					// Tick went backwards (late or sender reset).
					eb.lateCount++;
					if (dt < -64) prev.tick = e.tick;
				}
			}
		}

		this.sparkline.push({
			gapMs,
			underrun: this.pendingUnderrun,
			rttMs: this.rttMs >= 0 ? this.rttMs : 0
		});
		if (this.sparkline.length > SPARKLINE_MAX) this.sparkline.shift();
		this.pendingUnderrun = false;
	}

	/**
	 * Record one render frame's remote interpolation result.
	 * `frameDtMs`: elapsed ms since the previous render frame (clamped).
	 * `underrun`: true if at least one remote player's sample time exceeded its newest buffered sample.
	 * `extrapolating`: true if velocity extrapolation actively covered this frame (rather than freezing).
	 */
	recordFrame(now: number, frameDtMs: number, underrun: boolean, extrapolating = false): void {
		const dt = Math.max(0, Math.min(250, frameDtMs));
		if (underrun) {
			const eb = this.eventBucket(now);
			if (!this.wasUnderrun) eb.underruns++;
			eb.underrunMs += dt;
			if (extrapolating) eb.extrapMs += dt;
			this.pendingUnderrun = true;
		}
		this.wasUnderrun = underrun;
	}

	get jitter(): number {
		return this.jitterMs;
	}

	get rtt(): number {
		return this.rttMs;
	}

	view(now: number, includeSamples = false): NetGraphView {
		const tSlot = Math.floor(now / TRAFFIC_BUCKET_MS);
		const tMin = tSlot - TRAFFIC_BUCKETS + 1;
		let bytesIn = 0;
		let bytesOut = 0;
		let snaps = 0;
		for (const b of this.traffic) {
			if (b.slot >= tMin && b.slot <= tSlot) {
				bytesIn += b.bytesIn;
				bytesOut += b.bytesOut;
				snaps += b.snaps;
			}
		}

		const eSlot = Math.floor(now / EVENT_BUCKET_MS);
		const eMin = eSlot - EVENT_BUCKETS + 1;
		let underruns = 0;
		let underrunMs = 0;
		let extrapMs = 0;
		let entries = 0;
		let dupEntries = 0;
		let lateCount = 0;
		for (const b of this.events) {
			if (b.slot >= eMin && b.slot <= eSlot) {
				underruns += b.underruns;
				underrunMs += b.underrunMs;
				extrapMs += b.extrapMs;
				entries += b.entries;
				dupEntries += b.dupEntries;
				lateCount += b.lateCount;
			}
		}

		const windowSec = (TRAFFIC_BUCKETS * TRAFFIC_BUCKET_MS) / 1000;
		return {
			rttMs: this.rttMs,
			jitterMs: this.jitterMs,
			interpMs: this.interpMs,
			snapHz: snaps / windowSec,
			underruns,
			underrunMs,
			extrapMs,
			dupPct: entries > 0 ? (dupEntries / entries) * 100 : 0,
			lateCount,
			inBytesPerSec: bytesIn / windowSec,
			outBytesPerSec: bytesOut / windowSec,
			samples: includeSamples ? this.sparkline.slice() : []
		};
	}

	private trafficBucket(now: number): TrafficBucket {
		const slot = Math.floor(now / TRAFFIC_BUCKET_MS);
		const b = this.traffic[((slot % TRAFFIC_BUCKETS) + TRAFFIC_BUCKETS) % TRAFFIC_BUCKETS]!;
		if (b.slot !== slot) {
			b.slot = slot;
			b.bytesIn = 0;
			b.bytesOut = 0;
			b.snaps = 0;
		}
		return b;
	}

	private eventBucket(now: number): EventBucket {
		const slot = Math.floor(now / EVENT_BUCKET_MS);
		const b = this.events[((slot % EVENT_BUCKETS) + EVENT_BUCKETS) % EVENT_BUCKETS]!;
		if (b.slot !== slot) {
			b.slot = slot;
			b.underruns = 0;
			b.underrunMs = 0;
			b.extrapMs = 0;
			b.entries = 0;
			b.dupEntries = 0;
			b.lateCount = 0;
		}
		return b;
	}
}
