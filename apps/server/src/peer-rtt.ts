import { randomBytes } from 'node:crypto';

/** Conservative RTT used while no recent transport probe has been answered. */
export const INITIAL_RTT_MS = 50;

const PROBE_TIMEOUT_MS = 2000;
const SAMPLE_WINDOW_MS = 5000;

export class PeerRtt {
	private readonly pending = new Map<string, number>();
	private readonly samples = new Map<number, number>();

	probe(now: number): string {
		for (const [nonce, sentAt] of this.pending) if (now - sentAt >= PROBE_TIMEOUT_MS) this.pending.delete(nonce);
		const nonce = randomBytes(16).toString('hex');
		this.pending.set(nonce, now);
		return nonce;
	}

	pong(echo: unknown, now: number): number | null {
		if (typeof echo !== 'string') return null;
		const sentAt = this.pending.get(echo);
		if (sentAt === undefined) return null;
		this.pending.delete(echo);
		const rtt = now - sentAt;
		if (rtt <= 0 || rtt >= PROBE_TIMEOUT_MS) return null;
		this.samples.set(sentAt, rtt);
		return this.estimate(now);
	}

	estimate(now: number): number {
		return this.sample(now) ?? INITIAL_RTT_MS;
	}

	sample(now: number): number | null {
		let min = Infinity;
		for (const [sentAt, rtt] of this.samples) {
			if (now - sentAt >= SAMPLE_WINDOW_MS) this.samples.delete(sentAt);
			else min = Math.min(min, rtt);
		}
		return min === Infinity ? null : min;
	}
}
