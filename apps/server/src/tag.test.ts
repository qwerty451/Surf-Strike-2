import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { MapDef, ServerMessage } from '@surf/shared';
import { FLAG_TELEPORTED, Status, TAG_IMMUNITY_SECS, TAG_INTERMISSION_SECS, TAG_MAX_SWEEP_MS, TAG_ROUND_SECS, withTeleportSeq } from '@surf/shared';
import type { GameServer } from './server.ts';
import { startServer } from './server.ts';
import { netState, sleep, TestClient, testMap } from './test-helpers.ts';

type ModeState = Extract<ServerMessage, { type: 'modeState'; mode: 'tag' }>;

function tagMap(): MapDef {
	const base = testMap('tag_test', 'Tag Test');
	return {
		...base,
		kind: 'tag',
		layout: 'open',
		cvars: {},
		spawns: Array.from({ length: 8 }, (_, i) => ({ pos: { x: i * 200, y: 0, z: 0 }, yaw: 0 })),
		zones: [
			{ type: 'teleport', min: { x: -5000, y: -5000, z: -1000 }, max: { x: 5000, y: 5000, z: -100 }, to: 'start' },
			{ type: 'teleport', min: { x: -60, y: 490, z: 0 }, max: { x: -40, y: 510, z: 80 }, to: 'start', dest: { pos: { x: 49, y: 500, z: 0 }, yaw: 0 } }
		]
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

/** Let in-flight frames arrive (loopback; chat barriers would hit the chat rate limit). */
const settle = () => sleep(40);

/** Send a position and wait until the server has stored it. */
async function moveTo(c: TestClient, x: number, y = 0, z = 0, flags = 0) {
	const id = c.of('welcome')[0]!.selfId;
	const stored = () => [...server.lobby.clients].find((o) => o.id === id)?.state;
	c.sendState(netState(1, x, { y, z, flags, status: Status.Idle }));
	const deadline = Date.now() + 2000;
	while (!(stored()?.x === x && stored()?.y === y && stored()?.z === z)) {
		if (Date.now() > deadline) throw new Error('state not stored');
		await sleep(5);
	}
}

/** Run one rules tick; returns the latest mode state `c` has received. */
async function tick(c: TestClient): Promise<ModeState> {
	server.lobby.tickMode();
	await settle();
	return c.of('modeState').at(-1) as ModeState;
}

before(async () => {
	server = await startServer({
		port: 0,
		host: '127.0.0.1',
		dbPath: ':memory:',
		maps: [tagMap(), testMap('surf_b', 'Bravo')],
		initialMap: 'tag_test',
		now: () => clock,
		rng: () => 0,
		timers: false,
		log: () => {}
	});
});

after(async () => {
	for (const c of clients) c.close();
	await server.close();
});

describe('tag mode', () => {
	let a: TestClient;
	let b: TestClient;
	let aId: number;
	let bId: number;

	it('welcome carries the mode; a lone player waits with no IT', async () => {
		const j = await join('Alice');
		a = j.c;
		aId = j.id;
		assert.equal(j.welcome.mode, 'tag');
		assert.equal(j.welcome.cvars.sv_airaccelerate, 150);
		assert.deepEqual(j.welcome.records.pbTicks, null);
		const ms = await a.waitFor('modeState');
		assert.equal(ms.mode, 'tag');
		assert.equal(ms.phase, 'waiting');
		assert.deepEqual(ms.it, []);
		await moveTo(a, 0);
		const st = await tick(a);
		assert.equal(st.phase, 'waiting');
	});

	it('a second player starts the countdown, then a round with one IT', async () => {
		const j = await join('Bob');
		b = j.c;
		bId = j.id;
		await moveTo(b, 1000);
		const cd = await tick(a);
		assert.equal(cd.phase, 'countdown');
		assert.equal(cd.timeLeft, TAG_INTERMISSION_SECS);
		await a.waitFor('chat', (m) => m.system === true && m.text.startsWith('Next tag round starts in 5 s'));
		clock += TAG_INTERMISSION_SECS * 1000;
		const st = await tick(a);
		assert.equal(st.phase, 'playing');
		assert.equal(st.round, 1);
		assert.equal(st.timeLeft, TAG_ROUND_SECS);
		assert.deepEqual(st.it, [aId]); // rng 0 picks the first player
		await b.waitFor('chat', (m) => m.system === true && m.text === 'Round 1: Alice is IT! Run!');
	});

	it('IT tags a touching player; tag-back is blocked by immunity', async () => {
		clock += 10_000;
		await moveTo(a, 970, 0, 20); // 30 units away, hulls overlap vertically
		const n = b.messages.length;
		const st = await tick(a);
		assert.deepEqual(st.it, [bId]);
		assert.deepEqual(st.immune, [aId]);
		const tagged = await b.waitFor('tagged', () => true, n);
		assert.deepEqual({ by: tagged.by, target: tagged.target }, { by: aId, target: bId });
		await b.waitFor('chat', (m) => m.text === 'Alice tagged Bob. Bob is IT!', n);
		// Scores: Bob ran for 10 s, Alice was IT.
		const rows = server.lobby.scoreRows();
		const ra = rows.find((r) => r.id === aId)!;
		const rb = rows.find((r) => r.id === bId)!;
		assert.equal(rb.score, 10);
		assert.equal(ra.score, 0);
		assert.equal(rb.it, true);
		assert.equal(rb.status, Status.Tagger);
		assert.equal(ra.status, Status.Runner);

		clock += 1000;
		assert.deepEqual((await tick(a)).it, [bId], 'immune: no tag back');
		clock += TAG_IMMUNITY_SECS * 1000;
		assert.deepEqual((await tick(a)).it, [aId], 'immunity over: tagged back');
	});

	it('vertical separation prevents a tag', async () => {
		clock += TAG_IMMUNITY_SECS * 1000 + 1;
		await moveTo(b, 980, 0, 200);
		assert.deepEqual((await tick(a)).it, [aId]);
		await moveTo(b, 2000);
	});

	it('remembers a teleport even if another state packet arrives before the tag check', async () => {
		clock += 100;
		await moveTo(a, 0, 500);
		await moveTo(b, -50, 500);
		await tick(a);
		clock += 15.625;
		await moveTo(b, 49, 500, 0, withTeleportSeq(0, 4));
		assert.ok([...server.lobby.clients].find((p) => p.id === bId)!.state!.flags & FLAG_TELEPORTED);
		clock += 15.625;
		await moveTo(b, 50, 500);
		assert.deepEqual((await tick(a)).it, [aId]);
	});

	it('!top and !pb answer with the tag score', async () => {
		const n = b.messages.length;
		b.send({ type: 'chat', text: '!top' });
		const m = await b.waitFor('chat', (x) => x.system === true && x.text.startsWith('No leaderboard in tag'), n);
		assert.match(m.text, /Your score this round: \d+\.\d s/);
	});

	it('mode state is re-sent every second without changes', async () => {
		const n = a.messages.length;
		server.lobby.tickMode(); // same clock: no resend
		await a.barrier();
		assert.equal(a.messages.slice(n).filter((x) => x.type === 'modeState').length, 0);
		clock += 1000;
		server.lobby.tickMode();
		await a.waitFor('modeState', () => true, n);
	});

	it('a third player joins as a runner; when the IT leaves, a runner takes over', async () => {
		const j = await join('Cara');
		const c = j.c;
		await moveTo(c, -3000);
		let st = await tick(c);
		assert.equal(st.it.includes(j.id), false);
		assert.ok(st.scores.some((s) => s.id === j.id && s.score === 0));
		const n = b.messages.length;
		a.close();
		await b.waitFor('leave', (m) => m.id === aId, n);
		st = await tick(b);
		assert.equal(st.it.length, 1);
		assert.notEqual(st.it[0], aId);
		await b.waitFor('chat', (m) => m.system === true && m.text.endsWith('is now IT.'), n);
		// Spectating drops below 2 active players: round cancelled, waiting.
		const k = b.messages.length;
		c.send({ type: 'spectate', targetId: bId });
		await c.waitFor('spectating', (m) => m.id === j.id && m.spectating);
		st = await tick(b);
		assert.equal(st.phase, 'waiting');
		assert.deepEqual(st.it, []);
		await b.waitFor('chat', (m) => m.text.startsWith('Not enough players: round cancelled'), k);
		c.send({ type: 'spectate', targetId: null });
		await c.waitFor('spectating', (m) => m.id === j.id && !m.spectating);
		await moveTo(c, -3000);
		assert.equal((await tick(b)).phase, 'countdown');
	});

	it('round end announces the top 3 and starts the next round after the intermission', async () => {
		clock += TAG_INTERMISSION_SECS * 1000;
		const st = await tick(b);
		assert.equal(st.phase, 'playing');
		const round = st.round;
		const n = b.messages.length;
		clock += TAG_ROUND_SECS * 1000;
		const end = await tick(b);
		assert.equal(end.phase, 'countdown');
		const chat = await b.waitFor('chat', (m) => m.system === true && m.text.startsWith(`Round ${round} over!`), n);
		assert.match(chat.text, /1\. \S+ 180\.0 s/);
		assert.match(chat.text, /2\. \S+ 0\.0 s/);
		clock += TAG_INTERMISSION_SECS * 1000;
		assert.equal((await tick(b)).round, round + 1);
	});
});

describe('tag sweep packet timing', () => {
	async function crossing({ gap = 31.25, flags = 0, wall = false, taggerMoves = false, end = 50 } = {}) {
		let now = 1000;
		const map = tagMap();
		map.zones.push({
			type: 'teleport',
			min: { x: 500, y: 500, z: 0 },
			max: { x: 520, y: 520, z: 80 },
			to: 'start',
			dest: { pos: { x: 50, y: 0, z: 0 }, yaw: 0 }
		});
		if (wall) map.brushes.push({ type: 'box', min: { x: -250, y: -2, z: 0 }, max: { x: 250, y: 2, z: 100 }, material: 'wall' });
		const s = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', maps: [map], now: () => now, rng: () => 0, timers: false, log: () => {} });
		const a = new TestClient(s.port);
		const b = new TestClient(s.port);
		try {
			const wa = await a.hello('Tagger');
			const wb = await b.hello('Runner');
			now += TAG_INTERMISSION_SECS * 1000;
			const tagger = { client: a, id: wa.selfId, y: wall ? -19 : 0 };
			const runner = { client: b, id: wb.selfId, y: wall ? 19 : 0 };
			const [moving, stationary] = taggerMoves ? [tagger, runner] : [runner, tagger];
			const put = async ({ client, id, y }: typeof tagger, tick: number, x: number, stateFlags = 0) => {
				client.sendState(netState(tick, x, { y, flags: stateFlags }));
				await client.until(() => [...s.lobby.clients].find((p) => p.id === id)?.state?.tick === tick);
			};
			let tick = 1;
			await put(stationary, tick, 0);
			await put(moving, tick, -50);
			s.lobby.tickMode();
			for (let elapsed = 31.25; elapsed < gap; elapsed += 31.25) {
				now += 31.25;
				if (taggerMoves) await put(moving, ++tick, -50);
				s.lobby.tickMode();
			}
			now = 1000 + TAG_INTERMISSION_SECS * 1000 + gap;
			await put(moving, ++tick, end, flags);
			s.lobby.tickMode();
			return s.lobby.scoreRows().find((p) => p.it)?.id === wb.selfId;
		} finally {
			a.close();
			b.close();
			await s.close();
		}
	}

	it('a forged teleport flag does not suppress a tag sweep', async () => {
		assert.equal(await crossing({ flags: FLAG_TELEPORTED }), true);
	});

	it('does not sweep a new pose across a 281 ms packet gap', async () => {
		assert.equal(await crossing({ gap: 281 }), false);
	});

	it('does not sweep a fresh tagger across a stalled runner', async () => {
		assert.equal(await crossing({ taggerMoves: true, gap: TAG_MAX_SWEEP_MS + 1 }), false);
	});

	it('tags a stalled runner when the tagger ends in contact', async () => {
		assert.equal(await crossing({ taggerMoves: true, gap: TAG_MAX_SWEEP_MS + 1, end: 30 }), true);
	});

	it('sweeps a fast tagger across a runner with a fresh pose', async () => {
		assert.equal(await crossing({ taggerMoves: true }), true);
	});

	it('sweeps across a runner whose pose is exactly at the age limit', async () => {
		assert.equal(await crossing({ taggerMoves: true, gap: TAG_MAX_SWEEP_MS }), true);
	});

	it('does not tag a runner across a solid wall at contact', async () => {
		assert.equal(await crossing({ wall: true }), false);
	});
});

describe('race mode on the same server API', () => {
	it('race welcome carries mode surf and no mode state', async () => {
		const s = await startServer({
			port: 0,
			host: '127.0.0.1',
			dbPath: ':memory:',
			maps: [testMap('surf_x', 'X')],
			timers: false,
			log: () => {}
		});
		const c = new TestClient(s.port);
		try {
			const w = await c.hello('Racer');
			assert.equal(w.mode, 'surf');
			s.lobby.tickMode();
			await c.barrier();
			assert.equal(c.of('modeState').length, 0);
			assert.equal(s.lobby.scoreRows()[0]!.score, undefined);
		} finally {
			c.close();
			await s.close();
		}
	});
});
