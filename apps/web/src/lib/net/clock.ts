/**
 * Client-side estimate of the server's monotonic clock (ms) and link transit
 * telemetry (docs/architecture.md#netcode).
 *
 * Tracks `offset = localMs - serverTimeMs` (`= clockSkew + oneWayDownlink`)
 * with a sliding minimum envelope so downlink jitter spikes and TCP stalls
 * never pull the estimated server clock backward or into the stall, while
 * genuine clock drift or route shifts converge smoothly.
 */
import { SNAPSHOT_HZ } from '@surf/shared';

const OFFSET_WINDOW = 64; // ~2 s at 32 Hz
const RTT_WINDOW = 16;
/** Consecutive fresh pong offsets >500 ms away before snapping the clock (e.g. background tab resume). */
const SNAP_THRESHOLD_MS = 500;
const SNAP_CONFIRM_COUNT = 4;

export interface SnapshotClockObs {
	/** False when `seq` is a duplicate or older than the latest accepted snapshot. */
	accepted: boolean;
	/** Missing snapshot sequence numbers before this one (0 = contiguous). */
	seqGap: number;
	/** Downlink transit delay above the current minimum path (ms). */
	transitExcessMs: number;
	/** Inter-arrival gap since the previous accepted snapshot (ms). */
	arrivalGapMs: number;
}

export class ServerClock {
	private synced = false;
	private offset = 0;
	private readonly offsetWin: number[] = [];
	private offsetIdx = 0;
	private jumpStreak = 0;
	private jumpDirection = 0;
	private lastPongSent = -Infinity;
	private lastRenderMs = -Infinity;

	private lastSeq = -1;
	private lastArrivalMs = -Infinity;
	private lastTransitMs = NaN;
	private jitterMs = 0;

	private lastRttMs = -1;
	private readonly rttWin: number[] = [];
	private rttIdx = 0;
	private nominalSnapMs = 1000 / SNAPSHOT_HZ;

	reset(): void {
		this.synced = false;
		this.offset = 0;
		this.offsetWin.length = 0;
		this.offsetIdx = 0;
		this.jumpStreak = 0;
		this.jumpDirection = 0;
		this.lastPongSent = -Infinity;
		this.lastRenderMs = -Infinity;
		this.lastSeq = -1;
		this.lastArrivalMs = -Infinity;
		this.lastTransitMs = NaN;
		this.jitterMs = 0;
		this.lastRttMs = -1;
		this.rttWin.length = 0;
		this.rttIdx = 0;
		this.nominalSnapMs = 1000 / SNAPSHOT_HZ;
	}

	setNominalSnapHz(hz: number): void {
		if (Number.isFinite(hz) && hz > 0) this.nominalSnapMs = 1000 / hz;
	}

	get isSynced(): boolean {
		return this.synced;
	}

	/** Estimated current server monotonic time (ms) at client `localMs`. */
	serverTime(localMs: number): number {
		return this.synced ? localMs - this.offset : localMs;
	}

	/** Render timestamps cannot move backwards if a confirmed shift moves the estimate back. */
	renderTime(localMs: number, delayMs: number): number {
		return this.lastRenderMs = Math.max(this.lastRenderMs, this.serverTime(localMs) - delayMs);
	}

	/** RFC 3550 smoothed downlink transit jitter (ms). */
	get jitter(): number {
		return this.jitterMs;
	}

	/** Latest measured round-trip time (ms); -1 when unknown. */
	get rtt(): number {
		return this.lastRttMs;
	}

	/** Minimum recent RTT (ms), or `rtt` if only one sample exists; -1 when unknown. */
	get minRtt(): number {
		if (this.rttWin.length === 0) return this.lastRttMs;
		let m = Infinity;
		for (let i = 0; i < this.rttWin.length; i++) if (this.rttWin[i]! < m) m = this.rttWin[i]!;
		return m;
	}

	/** Observe a client->server `ping` / `pong` reply carrying `serverTimeMs`. */
	observePong(sentLocalMs: number, arrivalLocalMs: number, serverTimeMs: number): number {
		const rtt = arrivalLocalMs - sentLocalMs;
		if (Number.isFinite(rtt) && rtt >= 0 && rtt < 60_000 && sentLocalMs > this.lastPongSent) {
			this.lastPongSent = sentLocalMs;
			const minRtt = this.minRtt;
			const fresh = rtt <= 250 && (minRtt < 0 || rtt <= minRtt + Math.max(50, minRtt / 4));
			this.lastRttMs = rtt;
			if (this.rttWin.length < RTT_WINDOW) this.rttWin.push(rtt);
			else this.rttWin[this.rttIdx] = rtt;
			this.rttIdx = (this.rttIdx + 1) % RTT_WINDOW;
			if (fresh && Number.isFinite(serverTimeMs)) this.observeOffset(arrivalLocalMs - serverTimeMs, true);
		}
		return rtt;
	}

	/** Seed the clock from `welcome.serverTime` before the first snapshot or pong arrives. */
	seed(arrivalLocalMs: number, serverTimeMs: number): void {
		if (!this.synced && Number.isFinite(serverTimeMs)) this.observeOffset(arrivalLocalMs - serverTimeMs);
	}

	/**
	 * Observe a `BIN_SNAPSHOT` header. Rejects out-of-order / duplicate wrapping
	 * 16-bit sequence numbers and updates the min-filtered offset and RFC 3550 jitter.
	 */
	observeSnapshot(arrivalLocalMs: number, serverTimeMs: number, seq: number): SnapshotClockObs {
		let seqGap = 0;
		if (this.lastSeq >= 0) {
			const diff = ((seq - this.lastSeq) << 16) >> 16;
			if (diff <= 0) {
				return { accepted: false, seqGap: 0, transitExcessMs: 0, arrivalGapMs: 0 };
			}
			seqGap = diff - 1;
		}
		this.lastSeq = seq & 0xffff;

		const arrivalGapMs = Number.isFinite(this.lastArrivalMs) ? Math.max(0, arrivalLocalMs - this.lastArrivalMs) : this.nominalSnapMs;
		this.lastArrivalMs = arrivalLocalMs;

		const transit = arrivalLocalMs - serverTimeMs;
		if (Number.isFinite(this.lastTransitMs)) {
			const d = Math.abs(transit - this.lastTransitMs);
			this.jitterMs += (d - this.jitterMs) / 16;
		}
		this.lastTransitMs = transit;

		this.observeOffset(transit);
		return {
			accepted: true,
			seqGap,
			transitExcessMs: Math.max(0, transit - this.offset),
			arrivalGapMs
		};
	}

	private observeOffset(transit: number, freshPong = false): void {
		if (!this.synced) {
			this.synced = true;
			this.offset = transit;
			this.offsetWin.length = 0;
			this.offsetWin.push(transit);
			this.offsetIdx = 1 % OFFSET_WINDOW;
			this.jumpStreak = 0;
			return;
		}

		const delta = transit - this.offset;
		if (Math.abs(delta) > SNAP_THRESHOLD_MS) {
			if (!freshPong) return;
			const direction = Math.sign(delta);
			this.jumpStreak = direction === this.jumpDirection ? this.jumpStreak + 1 : 1;
			this.jumpDirection = direction;
			if (this.jumpStreak < SNAP_CONFIRM_COUNT) return;
			this.offset = transit;
			this.offsetWin.length = 0;
			this.offsetIdx = 0;
		}
		if (freshPong) this.jumpStreak = 0;

		if (this.offsetWin.length < OFFSET_WINDOW) this.offsetWin.push(transit);
		else this.offsetWin[this.offsetIdx] = transit;
		this.offsetIdx = (this.offsetIdx + 1) % OFFSET_WINDOW;

		let winMin = Infinity;
		for (let i = 0; i < this.offsetWin.length; i++) {
			const v = this.offsetWin[i]!;
			if (v < winMin) winMin = v;
		}

		if (transit < this.offset) {
			// Faster path sample: pull offset down quickly (estimated server time moves forward).
			this.offset += (transit - this.offset) * 0.25;
		} else if (winMin > this.offset) {
			// Entire sliding window rose (route change or clock drift): slew up slowly so serverTime stays monotonic.
			const step = Math.min(2, (winMin - this.offset) * 0.05);
			this.offset += step;
		}
	}
}
