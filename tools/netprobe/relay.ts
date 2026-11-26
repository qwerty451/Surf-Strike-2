import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';

export interface Impairment {
	lossPct: number;
	jitterMs: number;
	burst: { durationMs: number; periodMs: number } | null;
	seed: number;
}

export const RETRANSMIT_MS = 100;
const CHUNK_BYTES = 1200;
const MAX_QUEUED_BYTES = 1 << 20;

export function randomSource(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

export async function startRelay(remote: URL, profile: Impairment) {
	const sockets = new Set<Socket>();
	const epoch = performance.now();
	const stats = {
		up: { chunks: 0, lossHolds: 0, burstHolds: 0 },
		down: { chunks: 0, lossHolds: 0, burstHolds: 0 }
	};
	let seed = profile.seed;
	const server = createServer({ allowHalfOpen: true }, (local) => {
		const remoteHost = remote.hostname.replace(/^\[|\]$/g, '');
		const upstream = createConnection({
			host: remoteHost,
			allowHalfOpen: true,
			port: Number(remote.port || (remote.protocol === 'wss:' ? 443 : 80))
		});
		for (const socket of [local, upstream]) {
			sockets.add(socket);
			socket.setNoDelay(true);
			socket.on('error', () => socket.destroy());
			socket.once('close', () => sockets.delete(socket));
		}
		forward(local, upstream, stats.up);
		forward(upstream, local, stats.down);
	});

	function forward(from: Socket, to: Socket, counts: typeof stats.up): void {
		const random = randomSource(seed++);
		const queue: { data: Buffer; due: number }[] = [];
		let timer: NodeJS.Timeout | undefined;
		let queuedBytes = 0;
		let drained = true;
		let ended = false;

		function flush(): void {
			clearTimeout(timer);
			timer = undefined;
			while (drained && queue.length && !to.destroyed) {
				const first = queue[0];
				const wait = first.due - performance.now();
				if (wait > 0) {
					timer = setTimeout(flush, Math.ceil(wait));
					return;
				}
				queue.shift();
				queuedBytes -= first.data.length;
				drained = to.write(first.data);
			}
			if (ended && queue.length === 0 && !to.destroyed && !to.writableEnded) to.end();
		}

		from.on('data', (data: Buffer) => {
			const now = performance.now();
			const burst = profile.burst;
			const phase = burst ? (now - epoch) % burst.periodMs : Infinity;
			const burstHold = burst && phase < burst.durationMs ? burst.durationMs - phase : 0;
			for (let at = 0; at < data.length; at += CHUNK_BYTES) {
				const chunk = data.subarray(at, at + CHUNK_BYTES);
				const loss = random() * 100 < profile.lossPct;
				const jitter = random() * profile.jitterMs;
				counts.chunks++;
				if (loss) counts.lossHolds++;
				if (burstHold) counts.burstHolds++;
				// The relay sees encrypted TLS bytes. Delay selected chunks as if
				// retransmitted and keep later bytes behind them in stream order.
				const due = now + Math.max(burstHold, loss ? RETRANSMIT_MS : 0) + jitter;
				queue.push({ data: chunk, due });
				queuedBytes += chunk.length;
			}
			if (queuedBytes > MAX_QUEUED_BYTES) from.destroy(new Error('Netprobe relay backlog exceeded 1 MiB'));
			else if (timer === undefined) flush();
		});
		to.on('drain', () => {
			drained = true;
			flush();
		});
		// The peer can send a TLS close record and FIN in the same read. Forward
		// the queued record before ending the destination's writable side.
		from.once('end', () => {
			ended = true;
			flush();
		});
		from.once('close', (hadError) => {
			if (hadError || !ended) to.destroy();
		});
		to.once('close', () => clearTimeout(timer));
	}

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const { port } = server.address() as AddressInfo;
	return {
		port,
		stats,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	};
}

export type Relay = Awaited<ReturnType<typeof startRelay>>;
