import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ServerMessage, Vec3, ZmEvent } from '@surf/shared';
import { FLAG_TELEPORTED, getMap, headCentre, Status, VIEW_HEIGHT, ZM_PLAYER_HP } from '@surf/shared';
import { RATE } from './lobby.ts';
import type { ZombiesMode } from './modes/zombies.ts';
import type { GameServer } from './server.ts';
import { startServer } from './server.ts';
import { netState, sleep, TestClient, testMap } from './test-helpers.ts';

type ZmState = Extract<ServerMessage, { type: 'modeState'; mode: 'zombies' }>;
type Ev<K extends ZmEvent['e']> = Extract<ZmEvent, { e: K }>;

const map = getMap('zombies_lowtide')!;
let clock = 2_000_000_000;
let server: GameServer;
const clients: TestClient[] = [];

const mode = () => server.lobby.gameMode as ZombiesMode;
const game = () => mode().game;
const settle = () => sleep(40);
const unit = (x: number, y: number, z: number): Vec3 => {
	const l = Math.hypot(x, y, z);
	return { x: x / l, y: y / l, z: z / l };
};

/** Run mode ticks at 32 Hz of fake time. */
async function run(ms: number): Promise<void> {
	for (let t = 0; t < ms; t += 1000 / 32) {
		clock += 1000 / 32;
		server.lobby.tickMode();
	}
	await settle();
}

function events<K extends ZmEvent['e']>(c: TestClient, e: K, from = 0): Ev<K>[] {
	return c.messages
		.slice(from)
		.filter((m): m is Extract<ServerMessage, { type: 'zm' }> => m.type === 'zm' && m.ev.e === e)
		.map((m) => m.ev as Ev<K>);
}

const lastState = (c: TestClient) => c.of('modeState').at(-1) as ZmState;

async function moveTo(c: TestClient, id: number, p: Vec3) {
	const spawn = [...server.lobby.clients].find((o) => o.id === id)?.pendingSpawn;
	if (spawn) c.sendState(netState(0, spawn.x, { y: spawn.y, z: spawn.z, status: Status.Alive }));
	c.sendState(netState(1, p.x, { y: p.y, z: p.z, status: Status.Alive }));
	const deadline = Date.now() + 2000;
	for (;;) {
		const s = [...server.lobby.clients].find((o) => o.id === id)?.state;
		if (s && s.x === p.x && s.y === p.y && s.z === p.z) return;
		if (Date.now() > deadline) throw new Error('state not stored');
		await sleep(5);
	}
}

before(async () => {
	server = await startServer({
		port: 0,
		host: '127.0.0.1',
		dbPath: ':memory:',
		maps: [map, testMap('surf_b', 'Bravo')],
		initialMap: map.id,
		now: () => clock,
		rng: () => 0.5,
		timers: false,
		log: () => {},
		modes: { zombies: { countdownSecs: 1, endSecs: 2, spawnIntervalScale: 1e9 } }
	});
});

after(async () => {
	for (const c of clients) c.close();
	await server.close();
});

describe('zombies mode', () => {
	let a: TestClient;
	let aId: number;
	let spawn: Vec3;
	const eye = () => ({ x: spawn.x, y: spawn.y, z: spawn.z + VIEW_HEIGHT });

	it('join starts a countdown at the start; the round starts after it', async () => {
		a = new TestClient(server.port);
		clients.push(a);
		const w = await a.hello('Alice');
		aId = w.selfId;
		assert.equal(w.mode, 'zombies');
		await settle();
		assert.equal(lastState(a).phase, 'countdown');
		const sp = events(a, 'spawn').at(-1)!;
		assert.equal(sp.reason, 'round');
		assert.equal(sp.hp, ZM_PLAYER_HP);
		spawn = { x: sp.x, y: sp.y, z: sp.z };
		await moveTo(a, aId, spawn);
		await run(1100);
		const st = lastState(a);
		assert.equal(st.phase, 'playing');
		assert.equal(st.round, 1);
		assert.equal(st.players[0]!.id, aId);
		assert.ok(a.messages.some((m) => m.type === 'chat' && m.system && /Round 1: reach the evac point/.test(m.text)));
		assert.ok(a.zombieFrames.length > 0, 'zombie snapshots are sent');
	});

	it('drops an in-flight unflagged state after a Zombie Run spawn', async () => {
		const b = new TestClient(server.port);
		clients.push(b);
		const w = await b.hello('Bob');
		const msg = await b.waitFor('zm', (m) => m.ev.e === 'spawn');
		assert.equal(msg.ev.e, 'spawn');
		b.sendState(netState(99, msg.ev.x, { y: msg.ev.y, z: msg.ev.z, spawnSeq: 0 }));
		await b.barrier();
		assert.equal([...server.lobby.clients].find((p) => p.id === w.selfId)?.state, null);
		assert.ok(msg.spawnSeq);
		const resendFrom = b.messages.length;
		clock += 251;
		server.lobby.sendSnapshot();
		await b.waitFor('zm', (m) => m.spawnSeq === msg.spawnSeq, resendFrom);
		await moveTo(b, w.selfId, msg.ev);
		b.close();
		await a.waitFor('leave', (m) => m.id === w.selfId);
	});

	it('accepts a spawn ack when the near-spawn states are rate-limited', async () => {
		const b = new TestClient(server.port);
		clients.push(b);
		let token = 0;
		const barrier = async () => {
			const t = ++token;
			b.send({ type: 'ping', t });
			await b.waitFor('pong', (m) => m.t === t);
		};
		const { selfId } = await b.hello('Ack');
		const msg = await b.waitFor('zm', (m) => m.ev.e === 'spawn');
		assert.equal(msg.ev.e, 'spawn');
		assert.ok(msg.spawnSeq);
		const { x, y, z } = msg.ev;
		const peer = [...server.lobby.clients].find((p) => p.id === selfId)!;

		// Exhaust the state window with old in-flight packets before the spawn arrives.
		for (let i = 0; i < RATE.state.limit; i++) b.sendState(netState(i, x, { y, z, spawnSeq: 0 }));
		b.sendState(netState(100, x, { y, z }));
		b.send({ type: 'spawnAck', seq: msg.spawnSeq - 1 });
		await barrier();
		assert.equal(peer.state?.tick, undefined);
		assert.ok(peer.spawnFrame, 'a stale ack leaves the retry active');

		const resendFrom = b.messages.length;
		b.send({ type: 'spawnAck', seq: msg.spawnSeq });
		await barrier();
		assert.equal(peer.spawnFrame, null);
		clock += 251;
		server.lobby.sendSnapshot();
		await barrier();
		assert.equal(b.messages.slice(resendFrom).some((m) => m.type === 'zm' && m.spawnSeq === msg.spawnSeq), false);

		// Once the window has cleared, the player has moved beyond the old 64-unit radius.
		await sleep(1000);
		b.sendState(netState(101, x + 128, { y, z }));
		await barrier();
		assert.equal(peer.state?.tick, 101);
		assert.ok((peer.state?.flags ?? 0) & FLAG_TELEPORTED);
		b.close();
		await a.waitFor('leave', (m) => m.id === selfId);
	});

	it('requires plausible movement for the first pose after a spawn ack', async () => {
		const b = new TestClient(server.port);
		clients.push(b);
		const { selfId } = await b.hello('Spawn pose');
		try {
			const { ev, spawnSeq } = await b.waitFor('zm', (m) => m.ev.e === 'spawn');
			assert.equal(ev.e, 'spawn');
			assert.ok(spawnSeq);
			const peer = [...server.lobby.clients].find((p) => p.id === selfId)!;
			const generation = peer.relayTeleportSeq;
			const { x, y, z } = ev;

			b.send({ type: 'spawnAck', seq: spawnSeq });
			clock += 16;
			b.sendState(netState(1, x + 4096, { y, z, flags: FLAG_TELEPORTED }));
			await b.barrier();
			assert.equal(peer.spawnFrame, null);
			assert.equal(peer.state?.tick, undefined);
			assert.equal(peer.relayTeleportSeq, generation);
			assert.ok(peer.pendingSpawn);

			clock += 250;
			b.sendState(netState(2, x + 128, { y, z }));
			await b.barrier();
			assert.equal(peer.state?.tick, 2);
			assert.equal(peer.pendingSpawn, null);
			assert.equal(peer.relayTeleportSeq, (generation + 1) & 0xff);
		} finally {
			b.close();
			await a.waitFor('leave', (m) => m.id === selfId);
		}
	});

	it('pistol: 4 body hits kill (hit markers, kill feed), a headshot kills at once', async () => {
		const z = game().spawnZombie({ x: spawn.x + 500, y: spawn.y, z: spawn.z })!;
		z.yaw = 180;
		const n = a.messages.length;
		for (let i = 0; i < 4; i++) {
			clock += 200;
			const o = z.body.origin;
			a.send({ type: 'fire', weapon: 'pistol', origin: eye(), dir: unit(o.x - spawn.x, o.y - spawn.y, o.z + 40 - eye().z), tick: game().tick });
			await settle();
		}
		const hits = events(a, 'hit', n);
		assert.deepEqual(hits.map((h) => [h.head, h.kill]), [[false, false], [false, false], [false, false], [false, true]]);
		assert.equal(events(a, 'kill', n)[0]!.zid, z.id);

		const z2 = game().spawnZombie({ x: spawn.x + 500, y: spawn.y + 40, z: spawn.z })!;
		z2.yaw = 180;
		const h = headCentre({ ...z2.body.origin, yaw: 180 });
		clock += 200;
		const m = a.messages.length;
		a.send({ type: 'fire', weapon: 'pistol', origin: eye(), dir: unit(h.x - eye().x, h.y - eye().y, h.z - eye().z), tick: game().tick });
		await settle();
		assert.deepEqual(events(a, 'kill', m).map((k) => [k.zid, k.head]), [[z2.id, true]]);
		assert.equal(game().view(clock).kills, 2);
	});

	it('rejects fire spam, wrong weapons and far-away origins (ammo resync)', async () => {
		clock += 1000;
		const n = a.messages.length;
		const shot = { type: 'fire', weapon: 'pistol', origin: eye(), dir: { x: 1, y: 0, z: 0 }, tick: 0 } as const;
		for (let i = 0; i < 5; i++) a.send(shot); // same instant: only one passes the fire-rate check
		a.send({ ...shot, weapon: 'lmg' });
		a.send({ ...shot, origin: { x: spawn.x + 2000, y: spawn.y, z: spawn.z + 64 } });
		await settle();
		const ammo = events(a, 'ammo', n);
		assert.equal(ammo.length, 6);
		assert.equal(ammo.at(-1)!.weapon, 'pistol');
		assert.equal(ammo.at(-1)!.mag, game().weaponOf(aId)!.mag);
		// 4 + 1 hits earlier, 1 now: 6 rounds spent.
		assert.equal(game().weaponOf(aId)!.mag, 12 - 6);
	});

	it('a zombie kills the player after 5 hits: team wipe → lost → new countdown', async () => {
		const n = a.messages.length;
		game().spawnZombie({ x: spawn.x + 30, y: spawn.y, z: spawn.z });
		for (let i = 0; i < 40 && !events(a, 'down', n).length; i++) await run(250);
		const hurts = events(a, 'hurt', n);
		assert.deepEqual(hurts.map((h) => h.hp), [4, 3, 2, 1, 0]);
		assert.equal(events(a, 'down', n)[0]!.id, aId);
		const end = events(a, 'end', n)[0]!;
		assert.equal(end.won, false);
		assert.equal(end.round, 1);
		assert.ok(a.messages.slice(n).some((m) => m.type === 'chat' && m.system && /Overrun! Round 1 lost/.test(m.text) && /top killer Alice \(2\)/.test(m.text)));
		const rows = mode().scoreRows();
		assert.equal(rows[0]!.status, Status.Down); // turned: zombie team
		assert.equal(rows[0]!.kills, 2);
		assert.equal(rows[0]!.deaths, 1);
		assert.ok(a.messages.slice(n).some((m) => m.type === 'chat' && m.system && /Alice turned!/.test(m.text)));
		// Shots while down are ignored.
		const m = a.messages.length;
		a.send({ type: 'fire', weapon: 'pistol', origin: eye(), dir: { x: 1, y: 0, z: 0 }, tick: 0 });
		await settle();
		assert.equal(events(a, 'shot', m).length + events(a, 'ammo', m).length, 0);

		await run(2100);
		assert.equal(lastState(a).phase, 'countdown');
		assert.equal(game().zombies.size, 0);
		const sp = events(a, 'spawn', n).at(-1)!;
		assert.equal(sp.reason, 'round');
		assert.equal(sp.hp, ZM_PLAYER_HP);
	});

	it('gate countdown starts with the survivor in the unlock area, is announced and opens after 30 s', async () => {
		// New round (countdown → playing); stand in gate 1's unlock area.
		await run(1100);
		assert.equal(lastState(a).phase, 'playing');
		const n = a.messages.length;
		const gate = map.zombies!.gates[0]!;
		const p = { x: (gate.unlock.min.x + gate.unlock.max.x) / 2, y: (gate.unlock.min.y + gate.unlock.max.y) / 2, z: 0.25 };
		await moveTo(a, aId, p);
		await run(300);
		assert.equal(events(a, 'gate', n)[0]!.state, 'counting');
		assert.ok(a.messages.slice(n).some((m) => m.type === 'chat' && m.system && /Gate 1 opens in 30 s/.test(m.text)));
		assert.equal(lastState(a).gates[0]!.state, 'counting');
		await run(30_200);
		assert.equal(events(a, 'gate', n).at(-1)!.state, 'open');
		assert.equal(lastState(a).gates[0]!.state, 'open');
		// Back to a fresh round for the next test.
		game().zombies.clear();
		await moveTo(a, aId, spawn);
		game().spawnZombie({ x: spawn.x + 30, y: spawn.y, z: spawn.z });
		for (let i = 0; i < 40 && lastState(a).phase === 'playing'; i++) await run(250);
		await run(2100);
		assert.equal(lastState(a).phase, 'countdown');
		assert.equal(lastState(a).gates[0]!.state, 'closed');
	});

	it('loadout during the countdown; reaching the evac zone wins', async () => {
		const n = a.messages.length;
		a.send({ type: 'loadout', weapon: 'sniper' });
		await settle();
		assert.equal(events(a, 'ammo', n).at(-1)!.weapon, 'sniper');
		await run(1100);
		assert.equal(lastState(a).phase, 'playing');
		await moveTo(a, aId, { x: 6144, y: 4928, z: 0.25 });
		await run(100);
		const end = events(a, 'end', n)[0]!;
		assert.equal(end.won, true);
		assert.equal(end.by, aId);
		assert.ok(a.messages.slice(n).some((m) => m.type === 'chat' && m.system && /Evacuated! Alice reached the boat/.test(m.text)));
	});
});
