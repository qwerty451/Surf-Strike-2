import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { it } from 'node:test';
import { startServer } from './server.ts';
import { TestClient, testMap } from './test-helpers.ts';

function startTestServer() {
	return startServer({
		port: 0,
		host: '127.0.0.1',
		dbPath: ':memory:',
		maps: [testMap()],
		timers: false,
		maxPerIp: 2,
		log: () => {}
	});
}

async function healthPlayers(port: number): Promise<number> {
	const response = await fetch(`http://127.0.0.1:${port}/health`);
	assert.equal(response.status, 200);
	return (await response.json() as { players: number }).players;
}

it('reaps a half-open player within ten seconds and releases its lobby and per-IP slots', async ({ mock }) => {
	let clock = 0;
	// Distinct timestamps for ping and pong even between explicit clock advances.
	mock.method(performance, 'now', () => clock += 0.001);
	const server = await startTestServer();
	let relayClient: Socket | undefined;
	let relayUpstream: Socket | undefined;
	const relay = createServer((socket) => {
		relayClient = socket;
		relayUpstream = createConnection({ host: '127.0.0.1', port: server.port });
		socket.pipe(relayUpstream).pipe(socket);
	});
	relay.listen(0, '127.0.0.1');
	await once(relay, 'listening');
	const broken = new TestClient((relay.address() as AddressInfo).port);
	const witness = new TestClient(server.port);

	try {
		const { selfId } = await broken.hello('Lost player');
		await witness.hello('Witness');
		assert.equal(await healthPlayers(server.port), 2);

		// Application traffic can still be fresh when the pong path disappears.
		clock = 5000;
		broken.send({ type: 'ping', t: 5000 });
		await broken.waitFor('pong', (m) => m.t === 5000);

		// The client loses TCP without a WebSocket Close frame. The relay
		// withholds that EOF and drains server writes, as a broken proxy can.
		relayClient!.unpipe(relayUpstream);
		relayUpstream!.unpipe(relayClient);
		relayUpstream!.resume();
		relayClient!.destroy();
		await witness.until(() => broken.closed);
		assert.equal(broken.closeCode, 1006);

		witness.send({ type: 'spectate', targetId: selfId });
		await witness.waitFor('spectating', (m) => m.spectating);
		server.lobby.sendPings();
		clock = 9999;
		server.lobby.sendPings();
		assert.equal(await healthPlayers(server.port), 2);

		clock = 10_001;
		server.lobby.sendPings();
		await witness.waitFor('leave', (m) => m.id === selfId);
		assert.equal(await healthPlayers(server.port), 1);
		assert.ok(!server.lobby.scoreRows().some((row) => row.id === selfId));

		const replacement = new TestClient(server.port);
		try {
			await replacement.hello('Replacement');
			assert.equal(await healthPlayers(server.port), 2);
		} finally {
			replacement.close();
		}
	} finally {
		relayClient?.destroy();
		relayUpstream?.destroy();
		await new Promise<void>((resolve) => relay.close(() => resolve()));
		witness.close();
		await server.close();
	}
});

it('expires application-idle players that still pong and keeps responsive spectators', async ({ mock }) => {
	let clock = 0;
	// Distinct timestamps for ping and pong even between explicit clock advances.
	mock.method(performance, 'now', () => clock += 0.001);
	const server = await startTestServer();
	const idle = new TestClient(server.port);
	const watcher = new TestClient(server.port);

	try {
		const { selfId } = await idle.hello('Idle player');
		await watcher.hello('Spectator');
		watcher.send({ type: 'spectate', targetId: selfId });
		await watcher.waitFor('spectating', (m) => m.spectating);

		clock = 5000;
		const nextPing = once(idle.ws, 'ping');
		const spectatorPing = once(watcher.ws, 'ping');
		server.lobby.sendPings();
		await Promise.all([nextPing, spectatorPing]);

		// Order the previous automatic pongs before advancing the game clock.
		const replies = [idle, watcher].map(({ ws }) => {
			const reply = once(ws, 'pong');
			ws.ping('barrier');
			return reply;
		});
		await Promise.all(replies);
		clock = 10_001;
		server.lobby.sendPings();
		await watcher.waitFor('leave', (m) => m.id === selfId);
		assert.equal(await healthPlayers(server.port), 1);
	} finally {
		idle.close();
		watcher.close();
		await server.close();
	}
});
