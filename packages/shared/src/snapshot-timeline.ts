import { TICK_RATE } from './units.ts';

const TICK_MS = 1000 / TICK_RATE;
const ANCHOR_WINDOW = 32;
/** Discontinuity threshold (ms) between observed `serverTime - tick*TICK_MS` and the current anchor. */
const ANCHOR_JUMP_MS = 250;
const ANCHOR_JUMP_CONFIRM = 3;
/** No sender progress across this much server time indicates a slow or paused sender. */
const SOURCE_STALL_MS = 125;

function medianOf(values: readonly number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) * 0.5;
}

/**
 * Assign a server time to each sample of a remote player. Use the sender's tick
 * spacing to remove aliasing and uplink jitter from the relay cadence.
 */
export class SnapshotTimeline {
	private lastTick = -1;
	private tickProgressed = false;
	private tickAnchor = 0;
	private readonly obsWin: number[] = [];
	private obsIdx = 0;
	private obsCount = 0;
	private anchorJumpStreak = 0;
	private latestServerTime = -Infinity;
	private tickSeenAt = -Infinity;
	private slowSender = false;
	private lastSampleAt = -Infinity;

	/** Return the sample's time, or null if the receiver should drop this tick. */
	push(tick: number, serverTimeMs: number, allowInitialRepeat = false): number | null {
		this.latestServerTime = Math.max(this.latestServerTime, serverTimeMs);

		let sampleTime = serverTimeMs;
		if (this.lastTick < 0) {
			this.lastTick = tick;
			this.resetAnchor(serverTimeMs - tick * TICK_MS);
			this.tickSeenAt = serverTimeMs;
		} else {
			const dt = tick - this.lastTick;
			if (dt === 0) {
				if (!allowInitialRepeat || this.tickProgressed || this.sourceIdle) return null;
			} else if (dt < 0) {
				if (dt < -64) {
					// Sender tick counter reset (reconnect/respawn/test reset): re-anchor cleanly.
					this.lastTick = tick;
					this.tickSeenAt = serverTimeMs;
					this.slowSender = false;
					this.resetAnchor(serverTimeMs - tick * TICK_MS);
				} else {
					// Out-of-order / late tick: drop.
					return null;
				}
			} else {
				this.tickProgressed = true;
				this.lastTick = tick;
				this.slowSender = serverTimeMs - this.tickSeenAt >= SOURCE_STALL_MS;
				this.tickSeenAt = serverTimeMs;

				const obs = serverTimeMs - tick * TICK_MS;
				const err = obs - this.tickAnchor;
				if (Math.abs(err) > ANCHOR_JUMP_MS) {
					this.anchorJumpStreak++;
					if (this.anchorJumpStreak >= ANCHOR_JUMP_CONFIRM || Math.abs(err) > 1000) {
						this.resetAnchor(obs);
					}
				} else {
					this.anchorJumpStreak = 0;
				}

				if (this.anchorJumpStreak === 0) {
					if (this.obsWin.length < ANCHOR_WINDOW) this.obsWin.push(obs);
					else this.obsWin[this.obsIdx] = obs;
					this.obsIdx = (this.obsIdx + 1) % ANCHOR_WINDOW;
					this.obsCount++;

					const med = medianOf(this.obsWin);
					const delta = med - this.tickAnchor;
					if (Math.abs(delta) > 0.01) {
						// Slew faster while priming the first few samples, then cap to <=5% speed skew.
						const priming = this.obsCount <= 8;
						const maxRate = priming ? 0.35 : 0.05;
						const maxStep = Math.min(priming ? 15 : 1.5, dt * TICK_MS * maxRate);
						const gain = priming ? 0.35 : 0.08;
						const step = Math.max(-maxStep, Math.min(maxStep, delta * gain));
						this.tickAnchor += step;
					}
				}
				sampleTime = this.tickAnchor + tick * TICK_MS;
			}
		}

		this.lastSampleAt = Math.max(sampleTime, this.lastSampleAt);
		return this.lastSampleAt;
	}

	private resetAnchor(anchor: number): void {
		this.tickAnchor = anchor;
		this.obsWin.length = 0;
		this.obsWin.push(anchor);
		this.obsIdx = 1 % ANCHOR_WINDOW;
		this.obsCount = 1;
		this.anchorJumpStreak = 0;
	}

	/** True when this remote player's sim tick has stopped advancing (e.g. backgrounded tab). */
	get sourceIdle(): boolean {
		return this.slowSender || this.latestServerTime - this.tickSeenAt >= SOURCE_STALL_MS;
	}

	clear(): void {
		this.lastTick = -1;
		this.tickProgressed = false;
		this.tickAnchor = 0;
		this.obsWin.length = 0;
		this.obsIdx = 0;
		this.obsCount = 0;
		this.anchorJumpStreak = 0;
		this.latestServerTime = -Infinity;
		this.tickSeenAt = -Infinity;
		this.slowSender = false;
		this.lastSampleAt = -Infinity;
	}
}
