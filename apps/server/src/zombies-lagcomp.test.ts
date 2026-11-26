import assert from 'node:assert/strict';
import { it } from 'node:test';
import { headCentre, INTERP_DELAY_MS, VIEW_HEIGHT, ZM_PLAYER_HP, ZM_ZOMBIE_SPEED, type MapDef, type Vec3 } from '@surf/shared';
import { emptySample, SnapshotBuffer } from '../../web/src/lib/net/interp.ts';
import { ZombieBuffer } from '../../web/src/lib/net/zombie-interp.ts';
import type { ZombiesMode } from './modes/zombies.ts';
import { startServer } from './server.ts';
import { netState, TestClient, testMap } from './test-helpers.ts';

const period = 31.25;
const movementPerFrame = ZM_ZOMBIE_SPEED * period / 1000;
const origin = { x: 0, y: 0, z: VIEW_HEIGHT };
const targetPos = (y: number) => ({ x: 300, y, z: 0 });

function arena(): MapDef {
	const map = testMap('zombies_timeline');
	map.kind = 'zombies';
	map.layout = 'linear';
	map.spawn = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
	map.spawns = [map.spawn, { pos: targetPos(0), yaw: 0 }];
	map.zones = [{ type: 'teleport', min: { x: -1000, y: -1000, z: -2000 }, max: { x: 1000, y: 1000, z: -100 }, to: 'start' }];
	map.zombies = { path: [map.spawn.pos, { x: 2000, y: 0, z: 0 }], spawnZones: [], gates: [] };
	return map;
}

async function shotOnTimeline({ stale = false, repeatTick = false, lateJoin = false } = {}): Promise<boolean> {
	let now = 1000;
	let stateTick = 0;
	const server = await startServer({
		port: 0, host: '127.0.0.1', dbPath: ':memory:', maps: [arena()], timers: false, now: () => now, log: () => {},
		modes: { zombies: { countdownSecs: 1, spawnIntervalScale: 1e9 } }
	});
	const { lobby } = server;
	const shooter = new TestClient(server.port);
	const target = new TestClient(server.port);
	let observer: TestClient | undefined;
	try {
		const a = (await shooter.hello('Shooter')).selfId;
		await shooter.until(() => [...lobby.clients].find((p) => p.id === a)?.hasRttSample);
		const b = (await target.hello('Target')).selfId;
		const game = (lobby.gameMode as ZombiesMode).game;
		const put = async (c: TestClient, id: number, pos: Vec3) => {
			const tick = ++stateTick;
			c.sendState(netState(tick, pos.x, { y: pos.y, z: pos.z }));
			await c.until(() => [...lobby.clients].find((p) => p.id === id)?.state?.tick === tick);
		};
		await put(shooter, a, { ...origin, z: 0 });
		await put(target, b, targetPos(0));
		const advance = (ms: number) => {
			const end = now + ms;
			while (now < end) {
				now = Math.min(now + period, end);
				lobby.tickMode();
			}
		};
		advance(1100);
		// Falling outside the map turns a survivor after enough falls.
		for (let fall = 1; fall <= ZM_PLAYER_HP; fall++) {
			const start = target.messages.length;
			await put(target, b, { ...targetPos(0), z: -200 });
			advance(1100);
			if (fall < ZM_PLAYER_HP) {
				const { ev } = await target.waitFor('zm', (m) => m.ev.e === 'spawn' && m.ev.reason === 'fall', start);
				assert.equal(ev.e, 'spawn');
				await put(target, b, ev);
			}
		}
		assert.equal(game.playerView(b)?.team, 'zombie');
		advance(3100);
		assert.equal(game.playerView(b)?.alive, true);
		const risen = await target.waitFor('zm', (m) => m.ev.e === 'spawn' && m.ev.team === 'zombie');
		assert.equal(risen.ev.e, 'spawn');
		await put(target, b, risen.ev);

		const players = new SnapshotBuffer();
		const zombies = new ZombieBuffer();
		const delivery = 15;
		const playerFrame = async (receiver = shooter, drop = false) => {
			const n = receiver.snapshotFrames.length;
			lobby.sendSnapshot();
			const frame = await receiver.until(() => receiver.snapshotFrames[n]);
			const entry = frame.entries.find((p) => p.id === b)!;
			if (!drop) players.push(entry, frame.serverTimeMs, now + delivery);
			return entry;
		};
		const zombieFrame = async () => {
			const next = game.tick + 1;
			lobby.tickMode();
			zombies.push(await shooter.until(() => shooter.zombieFrames.find((f) => f.tick >= next)), now + delivery);
		};
		let aimAt: number;
		if (lateJoin) {
			await put(target, b, targetPos(-240));
			await playerFrame();
			players.clear();

			observer = new TestClient(server.port);
			await observer.hello('Observer');
			now += period;
			stateTick += 3;
			await put(target, b, targetPos(-120));
			await playerFrame(observer, true);

			now += period;
			stateTick++;
			await put(target, b, targetPos(0));
			await playerFrame(observer);
			now += period;
			stateTick++;
			await put(target, b, targetPos(120));
			await playerFrame(observer);
			aimAt = now + 1.25;
		} else if (repeatTick) {
			await put(target, b, targetPos(-120));
			await playerFrame();
			now += period;
			stateTick++;
			await put(target, b, targetPos(0));
			const previous = await playerFrame();

			// No state arrives for one relay, then the sender returns four ticks ahead.
			now += period;
			const repeated = await playerFrame();
			assert.equal(repeated.sampleTimeMs, previous.sampleTimeMs);
			aimAt = now + 0.25 * period;
			now += period;
			stateTick += 3;
			await put(target, b, targetPos(120));
			await playerFrame();
		} else {
			await put(target, b, targetPos(0));
			now += period - 0.25;
			await playerFrame();
			// The pose changes after the player frame and before the AI frame.
			if (!stale) await put(target, b, targetPos(movementPerFrame));
			now += 0.25;
			await zombieFrame();
			aimAt = now + (stale ? -0.25 : 0.5);
			if (stale) await put(target, b, targetPos(96));
			now += period - 0.25;
			await playerFrame();
			if (!stale) await put(target, b, targetPos(2 * movementPerFrame));
			now += 0.25;
			await zombieFrame();
		}

		const rendered = emptySample();
		assert.ok(players.sample(aimAt, rendered));
		zombies.sample(aimAt, []);
		if (repeatTick) assert.equal(rendered.y, 75);
		else if (!lateJoin) assert.ok(Math.abs(rendered.y) < 1);
		if (!stale && !repeatTick && !lateJoin) assert.ok(!Number.isInteger(zombies.tick));
		const seen = headCentre(rendered);
		const delta = { x: seen.x - origin.x, y: seen.y - origin.y, z: seen.z - origin.z };
		const len = Math.hypot(delta.x, delta.y, delta.z);

		advance(aimAt + (stale ? 400 : INTERP_DELAY_MS + 2 * delivery) - now);
		const n = shooter.messages.length;
		shooter.send({ type: 'fire', weapon: 'pistol', origin, dir: { x: delta.x / len, y: delta.y / len, z: delta.z / len }, tick: zombies.tick, renderServerTimeMs: aimAt });
		await shooter.barrier();
		return shooter.messages.slice(n).some((m) => m.type === 'zm' && m.ev.e === 'hit' && m.ev.pid === b);
	} finally {
		shooter.close();
		target.close();
		observer?.close();
		await server.close();
	}
}

it('rewinds the player-zombie pose drawn by staggered snapshot buffers', async () => {
	assert.equal(await shotOnTimeline(), true);
});

it('hits the interpolated player-zombie between samples after a repeated relay tick', async () => {
	assert.equal(await shotOnTimeline({ repeatTick: true }), true);
});

it('bounds a Zombie Run shot sampled outside the RTT budget', async () => {
	assert.equal(await shotOnTimeline({ stale: true }), false);
});

it('rewinds to the pose seen by a late observer after a dropped snapshot', async () => {
	assert.equal(await shotOnTimeline({ lateJoin: true }), true);
});
