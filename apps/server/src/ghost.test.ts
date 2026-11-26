/** Record ghosts (docs/gameplay.md#ghosts): server recording, storage and delivery. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { FLAG_DUCKED, Status, TICK_RATE, unpackGhost } from '@surf/shared';
import type { GameServer } from './server.ts';
import { startServer } from './server.ts';
import { netState, sleep, TestClient, testMap } from './test-helpers.ts';

const MS = (ticks: number) => (ticks / TICK_RATE) * 1000;
const STEP = 16;
const MAPS = [testMap('surf_a', 'Alpha'), testMap('surf_b', 'Bravo')];

let clock = 2_000_000_000;
let server: GameServer;
const clients: TestClient[] = [];

async function join(name: string) {
	const c = new TestClient(server.port);
	clients.push(c);
	await c.hello(name);
	return c;
}

/** A valid run of `total` ticks (a multiple of 16), one state per 16 ticks (state rate limit). */
async function run(c: TestClient, total: number, switchTo?: string) {
	const t0 = 20_000;
	c.sendState(netState(t0 - 1, 150, { status: Status.StartZone }));
	c.send({ type: 'zone', kind: 'start', index: 0, tick: t0 });
	await c.barrier();
	const startClock = clock;
	for (let t = t0; t <= t0 + total; t += STEP) {
		const x = 216 + ((t - t0) * 1850) / total;
		c.sendState(netState(t, x, { vx: 400, yaw: 45, runTicks: t - t0, flags: t - t0 > total / 2 ? FLAG_DUCKED : 0 }));
		if (t - t0 === Math.floor(total / 2)) c.send({ type: 'zone', kind: 'stage', index: 2, tick: t });
	}
	// Finish-delay states after the end are not part of the run.
	clock = startClock + MS(total);
	const n = c.messages.length;
	c.send({ type: 'zone', kind: 'end', index: 0, tick: t0 + total });
	c.sendState(netState(t0 + total + 1, 9999, { status: Status.Finished }));
	if (switchTo) c.send({ type: 'changeMap', mapId: switchTo });
	return c.waitFor('runResult', () => true, n);
}

before(async () => {
	server = await startServer({
		port: 0,
		host: '127.0.0.1',
		dbPath: ':memory:',
		maps: MAPS,
		initialMap: 'surf_a',
		now: () => clock,
		rng: () => 0,
		log: () => {}
	});
});

after(async () => {
	for (const c of clients) c.close();
	await server.close();
});

describe('record ghosts', () => {
	it('getGhost answers "none" before any record', async () => {
		const c = await join('Asker');
		c.send({ type: 'getGhost', map: 'surf_a' });
		const f = await c.until(() => c.ghosts.find((g) => g.map === 'surf_a'));
		assert.equal(f.has, false);
		c.close();
	});

	it('a validated record run stores a replay, pushes it, and getGhost returns it; slower runs do not replace it', async () => {
		const watcher = await join('Watcher');
		const c = await join('Racer');
		assert.equal((await c.auth('register', 'Racer', 'secret1')).ok, true);
		const res = await run(c, 640);
		assert.equal(res.record, true);

		const row = await c.until(() => server.db.getReplay('surf_a'));
		assert.ok(row);
		assert.equal(row.name, 'Racer');
		assert.equal(row.ticks, 640);
		assert.equal(row.samples, 41, 'zone{start} tick through zone{end} tick');
		const track = unpackGhost(new Uint8Array(inflateRawSync(row.data)))!;
		assert.equal(track.length, 41);
		assert.equal(track.tick[0], 0);
		assert.equal(track.tick[40], 640);
		assert.equal(track.x[0], 216 * 8);
		assert.equal(track.x[40], (216 + 1850) * 8, 'the Finished state after the end is not recorded');
		assert.equal(track.flags[40] & FLAG_DUCKED, FLAG_DUCKED);

		// Pushed to everyone on the map.
		const pushed = await watcher.until(() => watcher.ghosts.find((g) => g.has && g.map === 'surf_a'));
		assert.equal(pushed.name, 'Racer');
		assert.equal(pushed.ticks, 640);
		assert.equal(pushed.samples, 41);
		assert.deepEqual([...pushed.payload], [...row.data]);

		// Slower run: replay unchanged.
		await sleep(1100);
		const slow = await run(c, 800);
		assert.equal(slow.pb, false);
		assert.equal(server.db.getReplay('surf_a')?.ticks, 640);

		// getGhost returns the stored record; another map's ghost is "none".
		const asker = await join('Late');
		asker.send({ type: 'getGhost', map: 'surf_a' });
		asker.send({ type: 'getGhost', map: 'surf_b' });
		const got = await asker.until(() => asker.ghosts.find((g) => g.has && g.map === 'surf_a'));
		assert.equal(got.name, 'Racer');
		assert.equal(got.ticks, 640);
		const none = await asker.until(() => asker.ghosts.find((g) => g.map === 'surf_b'));
		assert.equal(none.has, false);

		// Faster run replaces it.
		await sleep(1100);
		const fast = await run(c, 576);
		assert.equal(fast.record, true);
		await c.until(() => server.db.getReplay('surf_a')?.ticks === 576);
		c.close();
		watcher.close();
		asker.close();
	});

	it('sends the result before a map change and saves the replay for the original map', async () => {
		const c = await join('Racer');
		await c.until(() => server.lobby.playerCount === 1);
		assert.equal((await c.auth('login', 'Racer', 'secret1')).ok, true);
		const n = c.messages.length;
		const res = await run(c, 512, 'surf_b');
		const change = await c.waitFor('mapChange', (m) => m.map === 'surf_b', n);
		assert.ok(c.messages.indexOf(res) < c.messages.indexOf(change));
		await c.until(() => server.db.getReplay('surf_a')?.ticks === 512);
		assert.equal(c.ghosts.some((g) => g.map === 'surf_a' && g.ticks === 512), false);
		c.send({ type: 'changeMap', mapId: 'surf_a' });
		await c.waitFor('mapChange', (m) => m.map === 'surf_a', n);
		c.close();
	});

	it('guest runs never store a replay', async () => {
		const before = server.db.getReplay('surf_a')?.ticks;
		const c = await join('Guesty');
		const t0 = 30_000;
		c.send({ type: 'zone', kind: 'start', index: 0, tick: t0 });
		await c.barrier();
		const startClock = clock;
		for (let t = t0; t <= t0 + 320; t += STEP) c.sendState(netState(t, 216 + ((t - t0) * 1850) / 320, { vx: 400 }));
		c.send({ type: 'zone', kind: 'stage', index: 2, tick: t0 + 160 });
		clock = startClock + MS(320);
		c.send({ type: 'zone', kind: 'end', index: 0, tick: t0 + 320 });
		await c.barrier();
		assert.equal(server.db.getReplay('surf_a')?.ticks, before);
		c.close();
	});
});
