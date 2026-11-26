import assert from 'node:assert/strict';
import { it } from 'node:test';
import { MAX_REWIND_RTT_MS } from '@surf/shared';
import { INITIAL_RTT_MS, PeerRtt } from './peer-rtt.ts';
import { startServer } from './server.ts';
import { TestClient, testMap } from './test-helpers.ts';

it('measures transport RTT independently of JSON pongs and caps combat rewind', async ({ mock }) => {
	const map = testMap();
	const server = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', maps: [map], initialMap: map.id, timers: false, log: () => {} });
	const client = new TestClient(server.port);
	try {
		const welcome = await client.hello('Alice');
		const peer = [...server.lobby.clients].find((p) => p.id === welcome.selfId)!;
		const probe = await client.waitFor('ping');
		const measured = await client.until(() => peer.ping !== INITIAL_RTT_MS && peer.ping);
		assert.ok(measured > 0);
		client.send({ type: 'pong', t: probe.t });
		await client.barrier();
		assert.equal(peer.ping, measured);

		mock.method(peer.rtt, 'estimate', () => 400);
		assert.equal(peer.ping, MAX_REWIND_RTT_MS);
		assert.equal(server.lobby.scoreRows().find((row) => row.id === peer.id)?.ping, 400);
	} finally {
		client.close();
		await server.close();
	}
});

it('ignores a short run of delayed pongs and expires silent peers', () => {
	const peer = new PeerRtt();
	const sample = (sent: number, rtt: number) => peer.pong(peer.probe(sent), sent + rtt);
	assert.equal(sample(1000, 25), 25);
	for (const sent of [1500, 2000, 2500, 3000]) assert.equal(sample(sent, 400), 25);
	assert.equal(peer.estimate(6500), 400);
	assert.equal(peer.estimate(10_000), INITIAL_RTT_MS);
});

it('can measure an older pending probe but discards expired echoes', () => {
	const peer = new PeerRtt();
	const first = peer.probe(1000);
	const second = peer.probe(1500);
	assert.equal(peer.pong(first, 1600), 600);
	assert.equal(peer.pong(first, 1601), null);
	peer.probe(3600);
	assert.equal(peer.pong(second, 3610), null);
});
