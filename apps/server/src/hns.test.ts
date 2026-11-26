import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { HnsEvent, MapDef, ServerMessage } from '@surf/shared';
import { HNS_FOUND_FREEZE_SECS, HNS_START_SECS, Status } from '@surf/shared';
import type { HnsMode } from './modes/hns.ts';
import type { GameServer } from './server.ts';
import { startServer } from './server.ts';
import { netState, sleep, TestClient, testMap } from './test-helpers.ts';

type ModeState = Extract<ServerMessage, { type: 'modeState'; mode: 'hns' }>;
type HnsMsg = Extract<ServerMessage, { type: 'hns' }>;

const HIDE = 10;
const SEEK = 60;
const END = 8;

function hnsMap(): MapDef {
	const base = testMap('hns_test', 'HNS Test');
	return {
		...base,
		kind: 'hns',
		layout: 'open',
		cvars: {},
		spawns: Array.from({ length: 8 }, (_, i) => ({ pos: { x: 1000 + i * 200, y: 0, z: 0 }, yaw: 0 })),
		hns: {
			hiderSpawns: Array.from({ length: 8 }, (_, i) => ({ pos: { x: 1000 + i * 200, y: 0, z: 0 }, yaw: 90 })),
			seekerSpawns: [{ pos: { x: -800, y: 0, z: 0 }, yaw: 0 }]
		},
		zones: [{ type: 'teleport', min: { x: -5000, y: -5000, z: -1000 }, max: { x: 5000, y: 5000, z: -100 }, to: 'start' }]
	};
}

let clock = 2_000_000_000;
let server: GameServer;
const clients: TestClient[] = [];

async function join(name: string) {
	const c = new TestClient(server.port);
	clients.push(c);
	const welcome = await c.hello(name);
	return { c, welcome, id: welcome.selfId };
}

const settle = () => sleep(40);
const ticks = new Map<TestClient, number>();

/** Send a position and wait until the server has stored it. */
async function moveTo(c: TestClient, x: number, y = 0, z = 0, vx = 0) {
	const tick = (ticks.get(c) ?? 0) + 1;
	ticks.set(c, tick);
	const id = c.of('welcome')[0]!.selfId;
	const stored = () => [...server.lobby.clients].find((o) => o.id === id)?.state;
	c.sendState(netState(tick, x, { y, z, vx, status: Status.Idle }));
	const deadline = Date.now() + 2000;
	while (stored()?.tick !== tick) {
		if (Date.now() > deadline) throw new Error('state not stored');
		await sleep(5);
	}
}

async function tick(c: TestClient): Promise<ModeState> {
	server.lobby.tickMode();
	await settle();
	return c.of('modeState').at(-1) as ModeState;
}

const events = (c: TestClient, from = 0): HnsEvent[] => (c.messages.slice(from).filter((m) => m.type === 'hns') as HnsMsg[]).map((m) => m.ev);

/** Knife swing from 40 units behind (x - 40) a target standing at `x`, facing +X. */
async function knife(c: TestClient, x: number) {
	await moveTo(c, x - 40);
	c.send({ type: 'knife', origin: { x: x - 40, y: 0, z: 64 }, dir: { x: 1, y: 0, z: 0 } });
	await settle();
}

before(async () => {
	server = await startServer({
		port: 0,
		host: '127.0.0.1',
		dbPath: ':memory:',
		maps: [hnsMap(), testMap('surf_b', 'Bravo')],
		initialMap: 'hns_test',
		now: () => clock,
		rng: () => 0,
		timers: false,
		log: () => {},
		modes: { hns: { hideSecs: HIDE, seekSecs: SEEK, endSecs: END } }
	});
});

after(async () => {
	for (const c of clients) c.close();
	await server.close();
});

describe('hide and seek mode', () => {
	let a: TestClient;
	let b: TestClient;
	let aId: number;
	let bId: number;
	let seeker: TestClient;
	let hider: TestClient;
	let seekerId: number;
	let hiderId: number;

	it('welcome carries the mode and the soft bhop cap; a lone player waits', async () => {
		const j = await join('Alice');
		a = j.c;
		aId = j.id;
		assert.equal(j.welcome.mode, 'hns');
		assert.equal(j.welcome.cvars.sv_enablebunnyhopping, 0);
		assert.equal(j.welcome.cvars.sv_air_speed_cap, 0);
		assert.equal(j.welcome.cvars.sv_maxspeed, 250);
		const st = await tick(a);
		assert.equal(st.mode, 'hns');
		assert.equal(st.phase, 'waiting');
	});

	it('a second player starts the round: one seeker, frozen at the seeker spawn', async () => {
		const j = await join('Bob');
		b = j.c;
		bId = j.id;
		await moveTo(a, 1000);
		await moveTo(b, 1200);
		assert.equal((await tick(a)).phase, 'starting');
		clock += HNS_START_SECS * 1000;
		const n = a.messages.length;
		const st = await tick(a);
		assert.equal(st.phase, 'hiding');
		assert.equal(st.round, 1);
		assert.equal(st.timeLeft, HIDE);
		assert.equal(st.seekers.length, 1);
		seekerId = st.seekers[0]!;
		hiderId = seekerId === aId ? bId : aId;
		seeker = seekerId === aId ? a : b;
		hider = seekerId === aId ? b : a;
		const sp = events(seeker).find((e) => e.e === 'spawn')!;
		assert.deepEqual(sp, { e: 'spawn', id: seekerId, role: 'seeker', pos: { x: -800, y: 0, z: 0 }, yaw: 0, freezeSecs: HIDE });
		const hs = events(hider).find((e) => e.e === 'spawn')!;
		assert.equal(hs.e === 'spawn' && hs.role, 'hider');
		// Each player only gets their own spawn.
		assert.equal(events(hider).filter((e) => e.e === 'spawn' && e.id === seekerId).length, 0);
		await a.waitFor('chat', (m) => m.system === true && /^Round 1: .+ is seeking\. Hiders, you have 10 s to hide!$/.test(m.text), n);
		assert.equal(st.players.find((p) => p.id === seekerId)!.frozen, HIDE);
		const rows = server.lobby.scoreRows();
		assert.equal(rows.find((r) => r.id === seekerId)!.status, Status.Seeker);
		assert.equal(rows.find((r) => r.id === hiderId)!.status, Status.Hider);
	});

	it('keeps the spawn pose while an in-flight unflagged hider state arrives', async () => {
		const spawn = events(hider).find((e) => e.e === 'spawn')!;
		assert.equal(spawn.e, 'spawn');
		const game = (server.lobby.gameMode as HnsMode).game;
		hider.sendState(netState(999, 7000));
		await settle();
		assert.equal(game.pos(hiderId)?.x, spawn.pos.x);
		await moveTo(hider, spawn.pos.x, spawn.pos.y, spawn.pos.z);
		assert.equal(game.pos(hiderId)?.x, spawn.pos.x);
	});

	it('a frozen seeker is pulled back and cannot knife', async () => {
		await moveTo(seeker, -800);
		await moveTo(hider, 1600);
		let n = seeker.messages.length;
		clock += 100;
		await tick(seeker);
		assert.equal(events(seeker, n).filter((e) => e.e === 'spawn').length, 0);
		await moveTo(seeker, -400);
		n = seeker.messages.length;
		clock += 600;
		await tick(seeker);
		assert.deepEqual(events(seeker, n).find((e) => e.e === 'spawn'), { e: 'spawn', id: seekerId, role: 'seeker', pos: { x: -800, y: 0, z: 0 }, yaw: 0, freezeSecs: HIDE - 0.7 });
		await moveTo(seeker, -800); // acknowledge the freeze correction before moving again
		n = hider.messages.length;
		await knife(seeker, 1600);
		await tick(hider);
		assert.equal(events(hider, n).filter((e) => e.e === 'found').length, 0);
	});

	it('seekers are released after the hiding phase', async () => {
		clock += HIDE * 1000;
		const n = hider.messages.length;
		const st = await tick(hider);
		assert.equal(st.phase, 'seeking');
		assert.equal(st.timeLeft, SEEK);
		assert.ok(events(hider, n).some((e) => e.e === 'release'));
		await hider.waitFor('chat', (m) => m.system === true && m.text.startsWith('Ready or not'), n);
	});

	it('over-cap speed voids a swing; a knife kill converts the last hider and seekers win', async () => {
		await moveTo(hider, 1600);
		// Seeker state over the speed limit: the next swing is ignored.
		await moveTo(seeker, 1560, 0, 0, 700);
		let n = hider.messages.length;
		seeker.send({ type: 'knife', origin: { x: 1560, y: 0, z: 64 }, dir: { x: 1, y: 0, z: 0 } });
		await settle();
		assert.equal(events(hider, n).filter((e) => e.e === 'found').length, 0);
		clock += 1500;

		await moveTo(seeker, -800); // acknowledge the freeze correction before moving again
		n = hider.messages.length;
		await knife(seeker, 1600);
		const found = events(hider, n).find((e) => e.e === 'found');
		assert.deepEqual(found, { e: 'found', by: seekerId, target: hiderId, hidersLeft: 0 });
		const sp = events(hider, n).find((e) => e.e === 'spawn');
		assert.deepEqual(sp, { e: 'spawn', id: hiderId, role: 'seeker', pos: { x: -800, y: 0, z: 0 }, yaw: 0, freezeSecs: HNS_FOUND_FREEZE_SECS });
		const end = events(hider, n).find((e) => e.e === 'end');
		assert.equal(end?.e === 'end' && end.winner, 'seekers');
		await hider.waitFor('chat', (m) => m.system === true && m.text.startsWith('Round 1: seekers win'), n);
		const st = hider.of('modeState').at(-1) as ModeState;
		assert.equal(st.phase, 'ended');
		assert.equal(st.winner, 'seekers');
		assert.equal(server.lobby.scoreRows().find((r) => r.id === seekerId)!.kills, 1);
	});

	it('next round re-picks the seeker; hiders win at time-out', async () => {
		clock += END * 1000;
		const st = await tick(a);
		assert.equal(st.phase, 'hiding');
		assert.equal(st.round, 2);
		assert.deepEqual(st.seekers, [hiderId], 'the player who has not sought yet seeks');
		clock += HIDE * 1000;
		await tick(a);
		const n = a.messages.length;
		clock += 30_000;
		await tick(a);
		await a.waitFor('chat', (m) => m.system === true && m.text === '30 seconds left!', n);
		clock += 30_000;
		const end = await tick(a);
		assert.equal(end.phase, 'ended');
		assert.equal(end.winner, 'hiders');
		await a.waitFor('chat', (m) => m.system === true && m.text.startsWith('Round 2: hiders win! Survived: '), n);
		assert.equal(server.lobby.scoreRows().find((r) => r.id === seekerId)!.score, SEEK);
	});

	it('a late joiner during a round seeks; dropping below 2 players cancels the round', async () => {
		clock += END * 1000;
		await tick(a); // round 3 hiding
		const j = await join('Carol');
		const st = await tick(j.c);
		assert.ok(st.seekers.includes(j.id));
		await j.c.waitFor('chat', (m) => m.system === true && m.text === 'A round is running: you join as a seeker.');
		assert.ok(events(j.c).some((e) => e.e === 'spawn' && e.id === j.id && e.role === 'seeker'));
		j.c.close();
		b.close();
		await sleep(100);
		const w = await tick(a);
		assert.equal(w.phase, 'waiting');
	});
});
