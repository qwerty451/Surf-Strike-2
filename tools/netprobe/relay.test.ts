import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import test from 'node:test';
import { startRelay } from './relay.ts';

test('relay forwards queued bytes before propagating FIN in either direction', async () => {
	const chunks: Buffer[] = [];
	const upstream = createServer({ allowHalfOpen: true }, (socket) => {
		socket.on('data', (data) => chunks.push(data));
		socket.on('end', () => socket.end('reply'));
	});
	upstream.listen(0, '127.0.0.1');
	await once(upstream, 'listening');
	const { port } = upstream.address() as AddressInfo;
	const relay = await startRelay(new URL(`ws://127.0.0.1:${port}`), {
		lossPct: 100, jitterMs: 0, burst: null, seed: 42
	});
	try {
		const client = createConnection({ host: '127.0.0.1', port: relay.port });
		const received: Buffer[] = [];
		client.on('data', (data) => received.push(data));
		client.end('request');
		await once(client, 'close', { signal: AbortSignal.timeout(2000) });
		assert.equal(Buffer.concat(chunks).toString(), 'request');
		assert.equal(Buffer.concat(received).toString(), 'reply');
		assert.equal(relay.stats.up.lossHolds, 1);
		assert.equal(relay.stats.down.lossHolds, 1);
	} finally {
		await relay.close();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	}
});
