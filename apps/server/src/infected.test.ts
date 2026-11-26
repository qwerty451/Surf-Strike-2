import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { InfEvent, MapDef, ServerMessage, Spawn, Vec3, WeaponId } from '@surf/shared';
import {
	getMap,
	headCentre,
	INF_AMMO,
	INF_INFECTED_HP,
	INF_INFECTION_BONUS_SECS,
	INF_SCORE_BANK_BONUS,
	INF_SCORE_INFECT,
	INF_SCORE_KNIFE_BONUS,
	INF_SCORE_MOAB,
	INF_SCORE_SURVIVE_WIN,
	INF_SURVIVOR_HP,
	INF_UAV_INTERVAL_MS,
	Status,
	VIEW_HEIGHT,
	WEAPONS
} from '@surf/shared';
import { AdaptiveDelay } from '../../web/src/lib/net/adaptive.ts';
import type { InfectedMode } from './modes/infected.ts';
import type { GameServer } from './server.ts';
import { startServer } from './server.ts';
import { netState, sleep, TestClient, testMap } from './test-helpers.ts';

type InfState = Extract<ServerMessage, { type: 'modeState'; mode: 'infected' }>;
type Ev<K extends InfEvent['e']> = Extract<InfEvent, { e: K }>;

const SPAWNS: Spawn[] = [
	{ pos: { x: -1000, y: -1000, z: 0.25 }, yaw: 45 },
	{ pos: { x: 1000, y: -1000, z: 0.25 }, yaw: 135 },
	{ pos: { x: -1000, y: 1000, z: 0.25 }, yaw: -45 },
	{ pos: { x: 1000, y: 1000, z: 0.25 }, yaw: 180 },
	{ pos: { x: 0, y: -1000, z: 0.25 }, yaw: 90 }
];

/** Floor, one thin wall at x 400..404 (bank shots), a fall-out box far below. */
function infectedMap(): MapDef {
	const base = testMap('inf_test', 'Infected Test');
	return {
		...base,
		kind: 'infected',
		layout: 'open',
		cvars: {},
		spawn: SPAWNS[0]!,
		spawns: SPAWNS,
		brushes: [
			{ type: 'box', min: { x: -1200, y: -1200, z: -64 }, max: { x: 1200, y: 1200, z: 0 }, material: 'm' },
			{ type: 'box', min: { x: 400, y: -300, z: 0 }, max: { x: 404, y: 300, z: 256 }, material: 'm' }
		],
		zones: [{ type: 'teleport', min: { x: -5000, y: -5000, z: -3000 }, max: { x: 5000, y: 5000, z: -500 }, to: 'start' }]
	};
}

const GRACE = 3;
const ROUND = 30;
let clock = 2_000_000_000;
let server: GameServer;
const clients: TestClient[] = [];

const mode = () => server.lobby.gameMode as InfectedMode;
const game = () => mode().game;
const settle = () => sleep(40);
const unit = (x: number, y: number, z: number): Vec3 => {
	const l = Math.hypot(x, y, z);
	return { x: x / l, y: y / l, z: z / l };
};

/** Checked after every mode tick when set (soak invariants). */
let invariant: (() => void) | null = null;

/** Run mode ticks at 32 Hz of fake time. */
async function run(ms: number): Promise<void> {
	for (let t = 0; t < ms; t += 1000 / 32) {
		clock += 1000 / 32;
		server.lobby.tickMode();
		invariant?.();
	}
	await settle();
}

/** One mode tick at a time until `pred` holds (or `maxMs` of fake time). */
async function runUntil<T>(pred: () => T | undefined | null | false, maxMs: number): Promise<T> {
	for (let t = 0; t < maxMs; t += 1000 / 32) {
		clock += 1000 / 32;
		server.lobby.tickMode();
		invariant?.();
		await sleep(5);
		const v = pred();
		if (v) return v;
	}
	await settle();
	const v = pred();
	if (v) return v;
	throw new Error('condition not reached');
}

function events<K extends InfEvent['e']>(c: TestClient, e: K, from = 0): Ev<K>[] {
	return c.messages
		.slice(from)
		.filter((m): m is Extract<ServerMessage, { type: 'inf' }> => m.type === 'inf' && m.ev.e === e)
		.map((m) => m.ev as Ev<K>);
}

const chats = (c: TestClient, re: RegExp, from = 0) =>
	c.messages.slice(from).filter((m) => m.type === 'chat' && m.system && re.test(m.text)) as Extract<ServerMessage, { type: 'chat' }>[];

const lastState = (c: TestClient) => c.of('modeState').at(-1) as InfState;

interface P {
	c: TestClient;
	id: number;
	name: string;
	pos: Vec3;
}
const ps: Record<string, P> = {};

async function join(name: string): Promise<P> {
	const c = new TestClient(server.port);
	clients.push(c);
	const w = await c.hello(name);
	await settle();
	const p = { c, id: w.selfId, name, pos: { x: 0, y: 0, z: 0 } };
	ps[name] = p;
	return p;
}

/** Send a position and wait until the server stored it (the mode reads it at once). */
async function moveTo(p: P, x: number, y: number, z = 0): Promise<void> {
	const spawn = [...server.lobby.clients].find((o) => o.id === p.id)?.pendingSpawn;
	if (spawn) p.c.sendState(netState(0, spawn.x, { y: spawn.y, z: spawn.z, status: Status.Alive }));
	p.c.sendState(netState(1, x, { y, z, status: Status.Alive }));
	const deadline = Date.now() + 2000;
	for (;;) {
		const s = [...server.lobby.clients].find((o) => o.id === p.id)?.state;
		if (s && s.x === x && s.y === y && s.z === z) break;
		if (Date.now() > deadline) throw new Error('state not stored');
		await sleep(5);
	}
	p.pos = { x, y, z };
}

const eye = (p: P): Vec3 => ({ x: p.pos.x, y: p.pos.y, z: p.pos.z + VIEW_HEIGHT });
const headOf = (p: P) => headCentre({ ...p.pos, yaw: 0 });

function fireAt(p: P, aim: Vec3, weapon: WeaponId): void {
	const o = eye(p);
	p.c.send({ type: 'fire', weapon, origin: o, dir: unit(aim.x - o.x, aim.y - o.y, aim.z - o.z), tick: game().tick });
}

function throwKnife(p: P, dir: Vec3): void {
	p.c.send({ type: 'throwKnife', origin: eye(p), dir });
}

async function closeAll(): Promise<void> {
	for (const c of clients.splice(0)) c.close();
	for (const k of Object.keys(ps)) delete ps[k];
	await server.close();
}

describe('infected mode', () => {
	before(async () => {
		server = await startServer({
			port: 0,
			host: '127.0.0.1',
			dbPath: ':memory:',
			maps: [infectedMap(), testMap('surf_b', 'Bravo')],
			initialMap: 'inf_test',
			now: () => clock,
			rng: () => 0,
			timers: false,
			log: () => {},
			modes: { infected: { graceSecs: GRACE, roundSecs: ROUND, endSecs: 1 } }
		});
	});
	after(closeAll);

	let loadout: WeaponId;

	it('waits for 2 players; a second player starts the grace period; dropping to 1 cancels it', async () => {
		const a = await join('Alice');
		assert.equal(a.c.of('welcome')[0]!.mode, 'infected');
		assert.equal(lastState(a.c).phase, 'waiting');
		assert.equal(chats(a.c, /^Infected: during the grace period.*infected have no guns, only claws/).length, 1);
		assert.equal(chats(a.c, /keeps? the(ir)? gun/).length, 0);
		assert.equal(chats(a.c, /^Waiting for more players/).length, 1);

		const b = await join('Bob');
		assert.equal(lastState(a.c).phase, 'grace');
		assert.equal(chats(a.c, /grace period, spread out!/).length, 1);

		const n = a.c.messages.length;
		b.c.send({ type: 'spectate', targetId: a.id });
		await a.c.waitFor('modeState', (m) => m.mode === 'infected' && m.phase === 'waiting', n);
		assert.equal(chats(a.c, /round cancelled\. Infected needs 2\+ players/, n).length, 1);
		assert.equal(mode().scoreRows().find((r) => r.id === b.id)!.status, Status.Spectating);

		const rejoinFrom = a.c.messages.length;
		b.c.send({ type: 'spectate', targetId: null });
		await a.c.waitFor('modeState', (m) => m.mode === 'infected' && m.phase === 'grace', rejoinFrom);
		// The cancelled grace did not use up round 1.
		assert.equal(lastState(a.c).round, 1);
		assert.equal(lastState(a.c).loadout, 'barrett');
		assert.equal(lastState(a.c).secondary, 'pistol');
	});

	it('grace: everyone is a survivor with the preset + knife; 1-2 switches; countdown; Patient Zero is picked', async () => {
		for (const name of ['Carol', 'Dave', 'Erin', 'Frank']) await join(name);
		const { Alice: a, Carol: c } = ps;
		const st = lastState(a!.c);
		assert.equal(st.phase, 'grace');
		loadout = st.loadout;
		assert.equal(st.players.length, 6);
		assert.ok(st.players.every((p) => p.team === 'survivor' && p.weapon === loadout));
		// Late joiners during grace spawn as survivors.
		assert.equal(events(c!.c, 'spawn').at(-1)!.team, 'survivor');

		// 1-2 weapon switch (primary ↔ knife); other weapons are refused.
		let n = c!.c.messages.length;
		c!.c.send({ type: 'loadout', weapon: 'knife' });
		await settle();
		assert.equal(events(c!.c, 'ammo', n).at(-1)!.weapon, 'knife');
		assert.equal(game().weaponOf(c!.id)!.weapon, 'knife');
		c!.c.send({ type: 'loadout', weapon: loadout });
		c!.c.send({ type: 'loadout', weapon: 'claws' });
		await settle();
		assert.equal(game().weaponOf(c!.id)!.weapon, loadout);
		// Survivors cannot throw knives.
		n = a!.c.messages.length;
		throwKnife(c!, { x: 1, y: 0, z: 0 });
		await settle();
		assert.equal(events(a!.c, 'knifeThrow', n).length, 0);

		n = a!.c.messages.length;
		await run(GRACE * 1000 + 100);
		assert.ok(chats(a!.c, /Patient Zero is picked in 2\.\.\./, n).length === 1);
		assert.ok(chats(a!.c, /Patient Zero is picked in 1\.\.\./, n).length === 1);
		const pz = lastState(a!.c);
		assert.equal(pz.phase, 'playing');
		assert.equal(pz.alphaId, a!.id); // rng 0: first player
		assert.deepEqual(events(a!.c, 'alpha', n), [{ e: 'alpha', id: a!.id }]);
		assert.equal(chats(a!.c, /^Alice is Patient Zero! Survive!$/, n).length, 1);
		const me = pz.players.find((p) => p.id === a!.id)!;
		assert.deepEqual([me.team, me.alpha, me.weapon, me.hasKnife], ['infected', true, 'claws', true]);
		assert.equal(mode().scoreRows().find((r) => r.id === a!.id)!.status, Status.Alpha);
	});

	it('Patient Zero has no gun and cannot switch to one', async () => {
		const { Alice: a, Bob: b } = ps;
		await moveTo(a!, -800, 0);
		await moveTo(b!, -400, 0);
		const n = a!.c.messages.length;
		const nb = b!.c.messages.length;
		for (const weapon of [loadout, 'pistol', 'knife'] as const) {
			a!.c.send({ type: 'loadout', weapon });
			await settle();
			assert.equal(game().weaponOf(a!.id)!.weapon, 'claws');
			fireAt(a!, headOf(b!), weapon);
			await settle();
		}
		assert.equal(events(b!.c, 'shot', nb).length, 0);
		assert.equal(events(b!.c, 'hurt', nb).length, 0);
		assert.equal(events(a!.c, 'hit', n).length, 0);
		assert.equal(events(a!.c, 'infect', n).length, 0);
		assert.ok(events(a!.c, 'ammo', n).length > 0);
		assert.ok(events(a!.c, 'ammo', n).every((x) => x.weapon === 'claws'));
		const me = game().playerView(a!.id)!;
		assert.deepEqual([me.team, me.alpha, me.weapon], ['infected', true, 'claws']);
		assert.deepEqual([game().playerView(b!.id)!.team, game().playerView(b!.id)!.hp], ['survivor', 5]);
	});

	it("Patient Zero's claws infect a survivor (+20 s) and end the role", async () => {
		const { Alice: a, Bob: b, Carol: c, Dave: d, Erin: e, Frank: f } = ps;
		await moveTo(c!, 0, 800);
		await moveTo(d!, -1000, -900);
		await moveTo(e!, 800, 800);
		await moveTo(f!, 800, -800);
		await moveTo(b!, -400, 0);
		await moveTo(a!, -440, 0);
		const endsAt = game().endsAt;
		const n = a!.c.messages.length;
		fireAt(a!, { x: -400, y: 0, z: 30 }, 'claws');
		await settle();
		const inf = events(a!.c, 'infect', n);
		assert.deepEqual(inf, [{ e: 'infect', id: b!.id, by: a!.id, method: 'claws', timeAdded: INF_INFECTION_BONUS_SECS }]);
		assert.equal(game().endsAt - endsAt, INF_INFECTION_BONUS_SECS * 1000);
		assert.equal(chats(a!.c, /^Alice infected Bob! \+20 s/, n).length, 1);
		assert.equal(chats(a!.c, /the gun|\bshot\b/, n).length, 0);
		// The Alpha's own ammo event: claws, no longer Patient Zero.
		assert.equal(events(a!.c, 'ammo', n).at(-1)!.weapon, 'claws');
		const st = lastState(a!.c);
		const alpha = st.players.find((p) => p.id === a!.id)!;
		assert.deepEqual([alpha.alpha, alpha.weapon, alpha.hasKnife], [false, 'claws', true]);
		assert.equal(st.alphaId, a!.id);
		assert.equal(st.players.find((p) => p.id === b!.id)!.team, 'infected');
		// Still no gun to pick.
		a!.c.send({ type: 'loadout', weapon: loadout });
		await settle();
		assert.equal(game().weaponOf(a!.id)!.weapon, 'claws');
	});

	it('a knife thrown at the floor bounces, sticks and is picked up by walking over it', async () => {
		const { Alice: a, Bob: b } = ps;
		await moveTo(b!, -800, 800);
		await moveTo(a!, -600, 600);
		const n = a!.c.messages.length;
		throwKnife(a!, { x: 0, y: 0, z: -1 });
		await settle();
		assert.equal(events(a!.c, 'knifeThrow', n).filter((k) => k.ownerId === a!.id).length, 1);
		assert.equal(game().playerView(a!.id)!.hasKnife, false);
		await moveTo(a!, -600, 900); // step away so the pickup waits
		const bounce = await runUntil(() => events(a!.c, 'knifeBounce', n)[0], 500);
		assert.ok(bounce.vz > 0);
		const stick = await runUntil(() => events(a!.c, 'knifeStick', n)[0], 3000);
		assert.equal(stick.ownerId, a!.id);
		await settle();
		const k = lastState(a!.c).knives[0]!;
		assert.equal(k.stuck, true);
		await run(200);
		assert.equal(events(a!.c, 'knifePickup', n).length, 0);
		assert.equal(lastState(a!.c).knives.length, 1);
		await moveTo(a!, k.x + 20, k.y);
		await run(40);
		assert.deepEqual(events(a!.c, 'knifePickup', n), [{ e: 'knifePickup', id: k.id, ownerId: a!.id }]);
		assert.equal(lastState(a!.c).knives.length, 0);
		assert.equal(lastState(a!.c).players.find((q) => q.id === a!.id)!.hasKnife, true);
	});

	it('a throwing knife hits directly and infects', async () => {
		const { Alice: a, Carol: c } = ps;
		await moveTo(a!, -800, 0);
		await moveTo(c!, -400, 0);
		const n = a!.c.messages.length;
		const before = game().playerView(a!.id)!.score;
		throwKnife(a!, { x: 1, y: 0, z: 0 });
		await settle();
		const thrown = events(a!.c, 'knifeThrow', n);
		assert.equal(thrown.length, 1);
		assert.equal(thrown[0]!.ownerId, a!.id);
		assert.equal(lastState(a!.c).knives.length, 1);
		const inf = await runUntil(() => events(a!.c, 'infect', n)[0], 500);
		// Thrown along +x: the event carries the way the knife travelled.
		assert.deepEqual(inf, { e: 'infect', id: c!.id, by: a!.id, method: 'knife', timeAdded: INF_INFECTION_BONUS_SECS, dx: 1, dy: 0 });
		assert.equal(events(a!.c, 'knifeRemove', n).length, 1);
		assert.equal(game().playerView(a!.id)!.score - before, INF_SCORE_INFECT + INF_SCORE_KNIFE_BONUS);
		assert.equal(chats(a!.c, /Alice infected Carol with a throwing knife! \+20 s/, n).length, 1);
		await settle();
		assert.equal(lastState(a!.c).knives.length, 0);
		// No knife until it is picked up again or the thrower respawns.
		const m = a!.c.messages.length;
		throwKnife(a!, { x: 1, y: 0, z: 0 });
		await settle();
		assert.equal(events(a!.c, 'knifeThrow', m).length, 0);
		await moveTo(c!, 0, 800);
	});

	it('a survivor kills an infected (scavenger ammo refill); the infected respawns after 3 s with a knife', async () => {
		const { Alice: a, Erin: e } = ps;
		await moveTo(a!, 800, 400);
		const reserve = game().primaryOf(e!.id)!.reserve;
		const n = e!.c.messages.length;
		const na = a!.c.messages.length;
		fireAt(e!, headOf(a!), loadout);
		await settle();
		const kill = events(e!.c, 'kill', n);
		assert.equal(kill.length, 1);
		assert.deepEqual([kill[0]!.by, kill[0]!.targetId, kill[0]!.head], [e!.id, a!.id, true]);
		const scav = events(e!.c, 'ammo', n).find((x) => x.scavenger)!;
		// First kill (no scavenger perk yet): an emergency refill of 40 % of the preset's scavenger ammo.
		const expected = Math.min(WEAPONS[loadout].reserve, reserve + Math.ceil(INF_AMMO[loadout]!.scavenger * 0.4));
		assert.ok(expected > reserve);
		assert.equal(scav.reserve, expected);
		assert.equal(game().primaryOf(e!.id)!.reserve, expected);
		assert.equal(game().playerView(a!.id)!.alive, false);
		assert.equal(game().playerView(e!.id)!.kills, 1);
		// Dead infected cannot attack.
		fireAt(a!, headOf(e!), 'claws');
		await settle();
		assert.equal(events(a!.c, 'infect', na).length, 0);

		await run(2800);
		assert.equal(events(a!.c, 'spawn', na).filter((s) => s.reason === 'respawn').length, 0);
		await run(400);
		const sp = events(a!.c, 'spawn', na).filter((s) => s.reason === 'respawn');
		assert.equal(sp.length, 1);
		assert.deepEqual([sp[0]!.team, sp[0]!.alpha, sp[0]!.weapon, sp[0]!.hasKnife], ['infected', false, 'claws', true]);
		assert.equal(game().playerView(a!.id)!.alive, true);
	});

	it('a bank shot off a wall infects (BANK SHOT!)', async () => {
		const { Alice: a, Dave: d } = ps;
		await moveTo(a!, 300, 0);
		const n = a!.c.messages.length;
		const before = game().playerView(a!.id)!.score;
		throwKnife(a!, { x: 1, y: 0, z: 0 });
		await settle();
		await moveTo(a!, 300, -200);
		// Spot the bounce on the server (no wire latency), then put Dave in the knife's path.
		let k: ReturnType<InfectedMode['game']['knifeViews']>[number] | undefined;
		for (let i = 0; i < 20 && !k; i++) {
			clock += 1000 / 32;
			server.lobby.tickMode();
			k = game().knifeViews().find((v) => v.vx < 0);
		}
		assert.ok(k, 'knife bounced off the wall');
		const t = 0.08;
		await moveTo(d!, Math.round(k.x + k.vx * t), Math.round(k.y + k.vy * t), Math.round(k.z + k.vz * t - 30));
		const inf = await runUntil(() => events(a!.c, 'infect', n)[0], 400);
		const b = events(a!.c, 'knifeBounce', n);
		assert.equal(b.length, 1);
		assert.ok(b[0]!.vx < 0 && b[0]!.x < 400);
		// Thrown along +x, it came back off the wall: the direction after the bounce.
		assert.deepEqual(inf, { e: 'infect', id: d!.id, by: a!.id, method: 'bank', timeAdded: INF_INFECTION_BONUS_SECS, dx: -1, dy: 0 });
		assert.equal(game().playerView(a!.id)!.score - before, INF_SCORE_INFECT + INF_SCORE_KNIFE_BONUS + INF_SCORE_BANK_BONUS);
		assert.equal(chats(a!.c, /BANK SHOT! Alice infected Dave with a throwing knife off the wall! \+20 s/, n).length, 1);
		await moveTo(d!, -1000, -900);
	});

	it('the last survivor against 2+ infected gets a UAV pulse every 5 s', async () => {
		const { Alice: a, Erin: e, Frank: f } = ps;
		await moveTo(a!, e!.pos.x - 40, e!.pos.y);
		const n = f!.c.messages.length;
		fireAt(a!, { x: e!.pos.x, y: e!.pos.y, z: e!.pos.z + 30 }, 'claws');
		await settle();
		assert.deepEqual(events(f!.c, 'infect', n), [{ e: 'infect', id: e!.id, by: a!.id, method: 'claws', timeAdded: INF_INFECTION_BONUS_SECS }]);
		await run(100);
		assert.equal(chats(f!.c, /Frank is the LAST SURVIVOR!/, n).length, 1);
		const st = lastState(f!.c);
		assert.deepEqual([st.survivors, st.infected], [1, 5]);
		let uav = events(a!.c, 'uav', n);
		assert.equal(uav.length, 1);
		assert.deepEqual(uav[0], { e: 'uav', targetId: f!.id, x: f!.pos.x, y: f!.pos.y, z: f!.pos.z });
		await run(INF_UAV_INTERVAL_MS - 300);
		assert.equal(events(a!.c, 'uav', n).length, 1);
		await run(400);
		uav = events(a!.c, 'uav', n);
		assert.equal(uav.length, 2);
		// Announced once.
		assert.equal(chats(f!.c, /LAST SURVIVOR/, n).length, 1);
	});

	it('a late joiner spawns as infected', async () => {
		const g = await join('Gina');
		const sp = events(g.c, 'spawn').at(-1)!;
		assert.deepEqual([sp.reason, sp.team, sp.alpha, sp.weapon, sp.hasKnife], ['join', 'infected', false, 'claws', true]);
		assert.equal(lastState(g.c).infected, 6);
		assert.equal(lastState(g.c).survivors, 1);
	});

	it('scoreboard rows: statuses, score/kills/deaths, sorted by score', async () => {
		const rows = mode().scoreRows();
		assert.equal(rows.length, 7);
		const by = (name: string) => rows.find((r) => r.name === name)!;
		assert.equal(by('Frank').status, Status.Alive);
		for (const name of ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Gina']) assert.equal(by(name).status, Status.Infected);
		assert.equal(rows[0]!.name, 'Alice');
		assert.equal(by('Alice').kills, 4);
		assert.equal(by('Alice').score, game().playerView(ps.Alice!.id)!.score);
		assert.equal(by('Alice').deaths, 1); // killed by Erin
		assert.equal(by('Bob').deaths, 1); // infected
		for (let i = 1; i < rows.length; i++) {
			const [p, q] = [rows[i - 1]!, rows[i]!];
			assert.ok(p.score! > q.score! || (p.score === q.score && (p.kills! > q.kills! || (p.kills === q.kills && p.name.localeCompare(q.name) <= 0))));
		}
		const n = ps.Alice!.c.messages.length;
		ps.Alice!.c.send({ type: 'chat', text: '!top' });
		await ps.Alice!.c.waitFor('chat', (m) => m.system === true && /No leaderboard in infected\. This round: \d+ points, 4 kills, 1 deaths/.test(m.text), n);
	});

	it('infected win when the last survivor turns; the next round starts after the summary', async () => {
		const { Alice: a, Frank: f } = ps;
		await moveTo(a!, f!.pos.x - 40, f!.pos.y);
		const n = a!.c.messages.length;
		fireAt(a!, { x: f!.pos.x, y: f!.pos.y, z: f!.pos.z + 30 }, 'claws');
		await settle();
		assert.equal(events(a!.c, 'infect', n)[0]!.id, f!.id);
		await run(40); // the next rules update ends the round
		const end = events(a!.c, 'end', n);
		assert.equal(end.length, 1);
		assert.deepEqual([end[0]!.winner, end[0]!.survivorsLeft, end[0]!.topId], ['infected', 0, a!.id]);
		assert.equal(lastState(a!.c).phase, 'ended');
		assert.equal(chats(a!.c, /^Infected win round \d+: everyone turned after .*Top player: Alice/, n).length, 1);
		await run(1100);
		const st = lastState(a!.c);
		assert.equal(st.phase, 'grace');
		assert.notEqual(st.loadout, loadout);
		assert.ok(st.players.every((p) => p.team === 'survivor' && p.score === 0));
	});

	it('survivors win when the clock runs out (+250 each)', async () => {
		const { Alice: a } = ps;
		const n = a!.c.messages.length;
		await run(GRACE * 1000 + 100);
		const st = lastState(a!.c);
		assert.equal(st.phase, 'playing');
		assert.equal(st.alphaId, a!.id);
		await run(ROUND * 1000 + 100);
		const end = events(a!.c, 'end', n);
		assert.equal(end.length, 1);
		assert.deepEqual([end[0]!.winner, end[0]!.survivorsLeft], ['survivors', 6]);
		assert.equal(chats(a!.c, /^Survivors win round \d+! 6 held out/, n).length, 1);
		const rows = mode().scoreRows();
		assert.equal(rows.find((r) => r.name === 'Alice')!.score, 0);
		for (const r of rows) if (r.name !== 'Alice') assert.equal(r.score, INF_SCORE_SURVIVE_WIN);
	});
});

/** Lobby-side client of a test player (ping is set here for lag compensation). */
const lobbyClient = (p: P) => [...server.lobby.clients].find((o) => o.id === p.id)!;

describe('infected soak on infected_outpost: 3 rounds, 4 players + a late joiner', () => {
	const logs: string[] = [];
	before(async () => {
		clock = 3_000_000_000;
		const outpost = getMap('infected_outpost');
		assert.ok(outpost, 'infected_outpost is registered');
		server = await startServer({
			port: 0,
			host: '127.0.0.1',
			dbPath: ':memory:',
			maps: [outpost, testMap('surf_b', 'Bravo')],
			initialMap: 'infected_outpost',
			now: () => clock,
			rng: () => 0,
			timers: false,
			log: (line: string) => logs.push(line),
			modes: { infected: { graceSecs: 2, roundSecs: 20, endSecs: 1 } }
		});
		// Every tick: finite, consistent state; knives only for infected (one per life, plus an old one in flight).
		invariant = () => {
			const g = game();
			const v = g.view(clock);
			assert.equal(v.survivors + v.infected, v.players.length, `team counts in ${v.phase}`);
			assert.ok(Number.isFinite(v.timeLeft) && v.timeLeft >= 0);
			const owners = new Map<number, number>();
			for (const k of v.knives) {
				assert.ok([k.x, k.y, k.z, k.vx, k.vy, k.vz].every(Number.isFinite), 'finite knife');
				assert.equal(v.players.find((p) => p.id === k.ownerId)?.team, 'infected', 'knife owner is infected');
				owners.set(k.ownerId, (owners.get(k.ownerId) ?? 0) + 1);
			}
			for (const n of owners.values()) assert.ok(n <= 2, 'at most one knife per life in flight');
			for (const p of v.players) {
				assert.ok(Number.isFinite(p.hp) && p.hp >= 0 && p.hp <= (p.team === 'infected' ? INF_INFECTED_HP : INF_SURVIVOR_HP));
				if (p.team === 'survivor') assert.ok(p.alive && !p.alpha);
				if (p.alpha) assert.equal(p.id, v.alphaId);
			}
			if (v.phase !== 'playing') assert.equal(v.knives.length, 0, `knives cleared in ${v.phase}`);
		};
	});
	after(async () => {
		invariant = null;
		await closeAll();
	});

	const byId = (id: number) => Object.values(ps).find((p) => p.id === id)!;
	const survivorsOf = () => lastState(ps.Ann!.c).players.filter((p) => p.team === 'survivor').map((p) => byId(p.id));
	const toPhase = (phase: InfState['phase'], maxMs: number) => runUntil(() => game().phase === phase, maxMs);

	it('round 1 (barrett): adaptive delay under jitter still lands the seen hit, gun kill + scavenger, Patient Zero infects', async ({ mock }) => {
		for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) await join(name);
		const { Ann: a, Ben: b, Cat: c, Dan: d } = ps as Record<string, P>;
		assert.equal(a!.c.of('welcome')[0]!.mode, 'infected');
		assert.equal(lastState(a!.c).phase, 'grace');
		assert.equal(lastState(a!.c).loadout, 'barrett');
		await toPhase('playing', 3000);
		await settle();
		assert.equal(lastState(a!.c).alphaId, a!.id);

		// The open north lane (y 1350) of the outpost.
		await moveTo(a!, -400, 1350);
		await moveTo(b!, -100, 1350);
		await moveTo(c!, 300, 1350);
		await moveTo(d!, 1400, -1400);
		await run(300);
		// Ann moves on; Ben shoots where he saw her with the live client's tick 2^31-1.
		// He uses his pistol (slot 2): a body hit that does not kill.
		// Without ping his screen is 116 ms behind (interpolation delay + allowance): after 250 ms he sees the new spot.
		b!.c.send({ type: 'loadout', weapon: 'pistol' });
		await settle();
		await run(200); // the draw (deployMs × the fire tolerance)
		await moveTo(a!, -400, 1500);
		await run(250);
		const n = b!.c.messages.length;
		let simulatedRtt = 0;
		mock.method(lobbyClient(b!).rtt, 'estimate', () => simulatedRtt);
		mock.method(lobbyClient(b!).rtt, 'sample', () => simulatedRtt || 1);
		const o = eye(b!);
		const aimOld = { x: -400, y: 1350, z: 30 };
		const dir = unit(aimOld.x - o.x, aimOld.y - o.y, aimOld.z - o.z);
		b!.c.send({ type: 'fire', weapon: 'pistol', origin: o, dir, tick: 0x7fffffff });
		await settle();
		assert.equal(game().weaponOf(b!.id)!.weapon, 'pistol');
		assert.equal(game().secondaryOf(b!.id)!.mag, 11, 'the pistol fired');
		assert.equal(events(b!.c, 'hit', n).length, 0, 'no ping: misses the old spot');
		await run(200);
		// Start with a clean 100 ms RTT, then let the real client delay grow during a snapshot stall.
		await moveTo(a!, -400, 1350);
		simulatedRtt = 100;
		const delay = new AdaptiveDelay();
		const frameMs = 1000 / 64;
		const reportView = async (first: number, last: number) => {
			for (let tick = first; tick <= last; tick++) {
				clock += frameMs;
				if (tick % 2 === 0) server.lobby.tickMode();
				const previousDelay = delay.currentMs;
				delay.update(clock, frameMs);
				const { x, y, z } = b!.pos;
				const uplinkJitter = tick % 3 === 0 ? 8 : 0;
				const renderServerTimeMs = clock - simulatedRtt - frameMs - previousDelay - uplinkJitter;
				b!.c.sendState(netState(tick, x, { y, z, renderServerTimeMs }));
				b!.c.send({ type: 'ping', t: tick });
				await b!.c.waitFor('pong', (p) => p.t === tick);
				assert.equal(lobbyClient(b!).state?.renderServerTimeMs, renderServerTimeMs);
			}
		};
		await reportView(10, 41);
		await moveTo(a!, -400, 1500);
		delay.observeSnapshot(clock - 62.5, { arrivalGapMs: 31.25, transitExcessMs: 0 });
		await reportView(42, 57);
		assert.ok(delay.currentMs > 140 && delay.currentMs < delay.targetMs, 'the client is still increasing its delay');
		const m = b!.c.messages.length;
		b!.c.send({ type: 'fire', weapon: 'pistol', origin: o, dir, tick: 0x7fffffff, renderServerTimeMs: clock - simulatedRtt - frameMs - delay.currentMs });
		await settle();
		assert.deepEqual(
			events(b!.c, 'hit', m).map((h) => [h.targetId, h.kill]),
			[[a!.id, false]],
			'the rewind to what he saw lands the hit'
		);
		simulatedRtt = 0;
		b!.c.send({ type: 'loadout', weapon: 'barrett' });
		await settle();
		await run(500); // fire rate and the draw
		assert.equal(game().weaponOf(b!.id)!.weapon, 'barrett');
		assert.equal(game().primaryOf(b!.id)!.mag, 10, 'the primary kept its magazine');

		// Gun kill (headshot) with scavenger ammo; the Alpha respawns as the Alpha.
		const reserve = game().primaryOf(b!.id)!.reserve;
		const k = b!.c.messages.length;
		fireAt(b!, headOf(a!), 'barrett');
		await settle();
		assert.equal(events(b!.c, 'kill', k).length, 1);
		assert.equal(
			events(b!.c, 'ammo', k).find((e) => e.scavenger)!.reserve,
			Math.min(WEAPONS.barrett.reserve, reserve + Math.ceil(INF_AMMO.barrett!.scavenger * 0.4))
		);
		assert.deepEqual(events(b!.c, 'perk', k), [{ e: 'perk', id: b!.id, perk: 'sleight', streak: 1 }]);
		assert.equal(chats(b!.c, /^1-kill streak: Sleight of Hand/, k).length, 1);
		assert.equal(chats(a!.c, /kill streak: Sleight of Hand/, k).length, 0, 'perk chat is private');
		await runUntil(() => game().playerView(a!.id)!.alive, 3500);
		assert.equal(game().playerView(a!.id)!.alpha, true);

		// Patient Zero claws Cat.
		await moveTo(c!, -100, 1350);
		await moveTo(a!, -140, 1350);
		await moveTo(b!, 1400, 1400);
		const i = a!.c.messages.length;
		fireAt(a!, { x: -100, y: 1350, z: 30 }, 'claws');
		await settle();
		assert.deepEqual(events(a!.c, 'infect', i)[0], { e: 'infect', id: c!.id, by: a!.id, method: 'claws', timeAdded: INF_INFECTION_BONUS_SECS });
		assert.equal(chats(a!.c, /the gun/, i).length, 0);
		assert.equal(game().weaponOf(a!.id)!.weapon, 'claws');
	});

	it('round 1: knife bounce + pickup, a bank shot off the radar deck, UAV on the last survivor, spectate toggle, late joiner', async () => {
		const { Ann: a, Ben: b, Cat: c, Dan: d } = ps as Record<string, P>;
		// Cat throws at the floor beside her, steps away, then walks over to pick it up.
		await moveTo(c!, -100, 1350);
		let n = c!.c.messages.length;
		throwKnife(c!, { x: 0, y: 0, z: -1 });
		await settle();
		await moveTo(c!, -100, 1500);
		const bounce = await runUntil(() => events(c!.c, 'knifeBounce', n)[0], 500);
		assert.ok(bounce.vz > 0);
		const stick = await runUntil(() => events(c!.c, 'knifeStick', n)[0], 3000);
		await run(100);
		assert.equal(events(c!.c, 'knifePickup', n).length, 0);
		await moveTo(c!, stick.x + 20, stick.y);
		await runUntil(() => events(c!.c, 'knifePickup', n)[0], 500);
		assert.equal(game().playerView(c!.id)!.hasKnife, true);

		// Bank shot: Cat throws at the radar deck's west face; Dan steps into the rebound.
		await moveTo(c!, 480, 800);
		n = a!.c.messages.length;
		const nb = b!.c.messages.length;
		throwKnife(c!, { x: 1, y: 0, z: 0 });
		await settle();
		await moveTo(c!, 480, 600);
		let kv: ReturnType<InfectedMode['game']['knifeViews']>[number] | undefined;
		for (let t = 0; t < 30 && !kv; t++) {
			clock += 1000 / 32;
			server.lobby.tickMode();
			invariant?.();
			kv = game().knifeViews().find((v) => v.ownerId === c!.id && v.vx < 0);
		}
		assert.ok(kv, 'bounced off the deck');
		await moveTo(d!, Math.round(kv.x + kv.vx * 0.08), Math.round(kv.y + kv.vy * 0.08), Math.max(0, Math.round(kv.z + kv.vz * 0.08 - 30)));
		const inf = await runUntil(() => events(a!.c, 'infect', n)[0], 400);
		assert.deepEqual(inf, { e: 'infect', id: d!.id, by: c!.id, method: 'bank', timeAdded: INF_INFECTION_BONUS_SECS, dx: -1, dy: 0 });
		assert.equal(chats(a!.c, /BANK SHOT! Cat infected Dan/, n).length, 1);

		// Ben is the last survivor against three infected: UAV pulses, announced once.
		await run(100);
		assert.equal(chats(b!.c, /Ben is the LAST SURVIVOR!/, nb).length, 1);
		assert.ok(events(a!.c, 'uav', n).length >= 1);
		await run(INF_UAV_INTERVAL_MS + 100);
		assert.ok(events(a!.c, 'uav', n).length >= 2);
		assert.equal(chats(b!.c, /LAST SURVIVOR/, nb).length, 1);

		// Cat toggles spectate: back as infected, stats kept, never a survivor.
		const before = game().playerView(c!.id)!;
		c!.c.send({ type: 'spectate', targetId: a!.id });
		await settle();
		assert.equal(game().hasPlayer(c!.id), false);
		c!.c.send({ type: 'spectate', targetId: null });
		await settle();
		await run(40);
		const back = game().playerView(c!.id)!;
		assert.deepEqual([back.team, back.alpha, back.score, back.kills, back.deaths], ['infected', false, before.score, before.kills, before.deaths]);

		// A late joiner spawns infected.
		const e = await join('Eve');
		const sp = events(e.c, 'spawn').at(-1)!;
		assert.deepEqual([sp.reason, sp.team, sp.weapon, sp.hasKnife], ['join', 'infected', 'claws', true]);

		// Ann claws Ben: infected win; the next round is the Striker.
		await moveTo(a!, b!.pos.x - 40, b!.pos.y);
		n = a!.c.messages.length;
		fireAt(a!, { x: b!.pos.x, y: b!.pos.y, z: b!.pos.z + 30 }, 'claws');
		await settle();
		await run(60);
		assert.deepEqual(events(a!.c, 'end', n).map((x) => [x.winner, x.round, x.survivorsLeft]), [['infected', 1, 0]]);
		await toPhase('grace', 2000);
		await settle();
		const st = lastState(a!.c);
		assert.deepEqual([st.round, st.loadout, st.alphaId, st.knives.length, st.moab], [2, 'striker', null, 0, null]);
		assert.ok(
			st.players.every(
				(p) => p.team === 'survivor' && p.score === 0 && p.kills === 0 && p.deaths === 0 && p.hp === 5 && p.streak === 0 && !p.moabReady
			)
		);
		assert.ok(events(a!.c, 'spawn', n).filter((s) => s.reason === 'round' && s.id === a!.id).every((s) => s.weapon === 'striker' && s.mag === 12 && s.reserve === 24));
	});

	it('round 2 (striker): one shell of pellets kills the Alpha, survivors win on the clock', async () => {
		await toPhase('playing', 3000);
		await settle();
		const st = lastState(ps.Ann!.c);
		assert.equal(st.loadout, 'striker');
		const alpha = byId(st.alphaId!);
		const shooter = survivorsOf().find((p) => p.id !== alpha.id)!;
		await moveTo(alpha, -400, 1350);
		await moveTo(shooter, 200, 1350);
		const n = shooter.c.messages.length;
		const witnessedFrom = alpha.c.messages.length;
		fireAt(shooter, headOf(alpha), 'striker');
		await settle();
		assert.equal(events(shooter.c, 'kill', n).length, 1);
		assert.equal(events(shooter.c, 'hit', n).length, 1, 'pellets add up to one hit');
		assert.equal(events(alpha.c, 'shot', witnessedFrom).length, 1, 'one shot event for the other player');
		assert.equal(events(shooter.c, 'shot', n).length, 0, 'the shooter plays its own shot locally');
		assert.equal(game().primaryOf(shooter.id)!.mag, 11);
		assert.equal(
			events(shooter.c, 'ammo', n).find((e) => e.scavenger)!.reserve,
			Math.min(WEAPONS.striker.reserve, 24 + Math.ceil(INF_AMMO.striker!.scavenger * 0.4))
		);
		// Keep everyone apart until the clock runs out.
		const spots: Array<[number, number]> = [[-1400, 1400], [1400, 1400], [1400, -1400], [-1400, -1400], [0, -700]];
		for (const [i, p] of Object.values(ps).entries()) if (p.id !== alpha.id) await moveTo(p, ...spots[i]!);
		const m = ps.Ann!.c.messages.length;
		await run(21_000);
		const end = events(ps.Ann!.c, 'end', m);
		assert.deepEqual(end.map((x) => [x.winner, x.round, x.survivorsLeft]), [['survivors', 2, 4]]);
		assert.equal(chats(ps.Ann!.c, /^Survivors win round 2! 4 held out/, m).length, 1);
	});

	it('round 3 (lmg): a survivor who spectates comes back infected; the clock ends it; round 4 is the SMG', async () => {
		await toPhase('playing', 4000);
		await settle();
		const st = lastState(ps.Ann!.c);
		assert.deepEqual([st.round, st.loadout], [3, 'lmg']);
		const alpha = byId(st.alphaId!);
		assert.equal(game().weaponOf(alpha.id)!.weapon, 'claws');
		const quitter = survivorsOf()[0]!;
		quitter.c.send({ type: 'spectate', targetId: alpha.id });
		await settle();
		quitter.c.send({ type: 'spectate', targetId: null });
		await settle();
		await run(40);
		const q = game().playerView(quitter.id)!;
		assert.deepEqual([q.team, q.alpha, q.weapon, q.hasKnife, game().infections], ['infected', false, 'claws', true, 0]);
		// The Alpha keeps the role (no infection happened) and claws a survivor.
		assert.equal(game().playerView(alpha.id)!.alpha, true);
		const target = survivorsOf()[0]!;
		await moveTo(target, -100, 1350);
		await moveTo(alpha, -140, 1350);
		const n = alpha.c.messages.length;
		fireAt(alpha, { x: -100, y: 1350, z: 30 }, 'claws');
		await settle();
		const turned = events(alpha.c, 'infect', n)[0]!;
		assert.deepEqual([turned.id, turned.by, turned.method], [target.id, alpha.id, 'claws']);
		assert.equal(game().playerView(alpha.id)!.alpha, false);
		const m = ps.Ann!.c.messages.length;
		for (let t = 0; t < 45 && game().phase !== 'ended'; t++) await run(1000);
		assert.equal(game().phase, 'ended');
		const end = events(ps.Ann!.c, 'end', m);
		assert.deepEqual(end.map((x) => [x.winner, x.round]), [['survivors', 3]]);
		await toPhase('grace', 2000);
		await settle();
		assert.deepEqual([lastState(ps.Ann!.c).round, lastState(ps.Ann!.c).loadout], [4, 'smg']);
		assert.deepEqual(
			events(ps.Ann!.c, 'phase').map((x) => `${x.phase}:${x.round}:${x.loadout}`).filter((x) => x.startsWith('grace')),
			['grace:1:barrett', 'grace:2:striker', 'grace:3:lmg', 'grace:4:smg']
		);
	});

	it('no errors were logged during the soak', () => {
		assert.deepEqual(logs.filter((l) => /error|exception|uncaught/i.test(l)), []);
		assert.ok(logs.some((l) => /infected round 3 start/.test(l)));
	});
});

describe('infected respawn beacon', () => {
	before(async () => {
		clock = 4_000_000_000;
		server = await startServer({
			port: 0,
			host: '127.0.0.1',
			dbPath: ':memory:',
			maps: [infectedMap(), testMap('surf_b', 'Bravo')],
			initialMap: 'inf_test',
			now: () => clock,
			rng: () => 0,
			timers: false,
			log: () => {},
			modes: { infected: { graceSecs: GRACE, roundSecs: ROUND, endSecs: 1 } }
		});
	});
	after(closeAll);

	it('place → a survivor shoots it (+50) → re-place → the owner dies and respawns on it', async () => {
		for (const name of ['Ivy', 'Jon', 'Kim']) await join(name);
		assert.equal(chats(ps.Ivy!.c, /\[E\] to drop a Respawn Beacon/).length, 1);
		await run(GRACE * 1000 + 100);
		assert.equal(game().phase, 'playing');
		const inf = Object.values(ps).find((p) => p.id === game().alphaId)!;
		const [s1] = Object.values(ps).filter((p) => p !== inf);
		const weapon = game().roundLoadout;

		// A survivor cannot place one.
		const n0 = s1!.c.messages.length;
		s1!.c.send({ type: 'placeBeacon' });
		await settle();
		assert.equal(events(s1!.c, 'beaconPlace', n0).length, 0);

		// The infected places one: everyone sees it, state goes out at once.
		await moveTo(inf, -600, 600);
		const n = s1!.c.messages.length;
		const ni = inf.c.messages.length;
		inf.c.send({ type: 'placeBeacon' });
		await settle();
		const placed = events(s1!.c, 'beaconPlace', n);
		assert.equal(placed.length, 1);
		assert.deepEqual([placed[0]!.ownerId, placed[0]!.x, placed[0]!.y], [inf.id, -600, 600]);
		assert.equal(lastState(s1!.c).beacons.length, 1);
		assert.equal(lastState(s1!.c).players.find((p) => p.id === inf.id)!.hasBeacon, true);

		// A survivor shoots it: +50, hitmarker, the owner is told.
		await moveTo(inf, 600, -600);
		await moveTo(s1!, -600, 300);
		const score = game().playerView(s1!.id)!.score;
		const o = eye(s1!);
		const b = placed[0]!;
		s1!.c.send({ type: 'fire', weapon, origin: o, dir: unit(b.x - o.x, b.y - o.y, b.z + 10 - o.z), tick: game().tick });
		await settle();
		assert.deepEqual(events(s1!.c, 'beaconDestroy', n).map((x) => [x.id, x.ownerId, x.by]), [[b.id, inf.id, s1!.id]]);
		assert.equal(events(inf.c, 'beaconDestroy', ni).length, 1);
		assert.ok(events(s1!.c, 'hit', n).some((x) => x.targetId === 0 && x.kill));
		assert.equal(game().playerView(s1!.id)!.score, score + 50);
		assert.equal(chats(inf.c, new RegExp(`^${s1!.name} destroyed your Respawn Beacon`), ni).length, 1);
		assert.equal(lastState(s1!.c).beacons.length, 0);

		// Re-place after the cooldown somewhere else.
		await run(1600);
		await moveTo(inf, 600, 600);
		const n2 = s1!.c.messages.length;
		inf.c.send({ type: 'placeBeacon' });
		await settle();
		const again = events(s1!.c, 'beaconPlace', n2);
		assert.equal(again.length, 1);
		assert.deepEqual([again[0]!.x, again[0]!.y], [600, 600]);

		// The owner is killed far away and respawns on the beacon, which is used up.
		await moveTo(inf, -600, -600);
		await moveTo(s1!, -600, -900);
		const n3 = inf.c.messages.length;
		fireAt(s1!, headOf(inf), weapon);
		await settle();
		assert.equal(game().playerView(inf.id)!.alive, false);
		await run(3200);
		const sp = events(inf.c, 'spawn', n3);
		assert.equal(sp.length, 1);
		assert.deepEqual([sp[0]!.reason, sp[0]!.x, sp[0]!.y, sp[0]!.team], ['beacon', 600, 600, 'infected']);
		assert.equal(events(s1!.c, 'beaconUse', n2).length, 1);
		assert.equal(lastState(s1!.c).beacons.length, 0);
		assert.equal(game().playerView(inf.id)!.alive, true);
	});

	const noRoom = /^No room for a Respawn Beacon here/;
	const infected = () => Object.values(ps).find((p) => p.id === game().alphaId)!;

	it('no floor in reach or no room: refused, and only the player is told', async () => {
		const inf = infected();
		const other = Object.values(ps).find((p) => p !== inf)!;
		await run(1600); // past the respawn grace and the cooldown
		const n = other.c.messages.length;
		const place = async (x: number, y: number, z: number) => {
			await moveTo(inf, x, y, z);
			const k = inf.c.messages.length;
			inf.c.send({ type: 'placeBeacon' });
			await settle();
			assert.equal(events(inf.c, 'beaconPlace', k).length, 0);
			return chats(inf.c, noRoom, k).length;
		};
		assert.equal(await place(600, 600, 400), 1, 'too high');
		assert.equal(await place(1500, 0, 100), 1, 'over the void');
		assert.equal(await place(402, 0, 0), 1, 'in the wall');
		assert.equal(chats(other.c, noRoom, n).length, 0);
		assert.equal(game().playerView(inf.id)!.hasBeacon, false);
		// Other refusals (a survivor, the cooldown) stay silent.
		const k = other.c.messages.length;
		other.c.send({ type: 'placeBeacon' });
		await settle();
		assert.equal(chats(other.c, noRoom, k).length, 0);
	});

	it('placed in mid-air it lands on the floor; a fall out of the map spawns on it once', async () => {
		const inf = infected();
		const other = Object.values(ps).find((p) => p !== inf)!;
		await moveTo(inf, -600, 600, 120);
		const n = other.c.messages.length;
		const k = inf.c.messages.length;
		inf.c.send({ type: 'placeBeacon' });
		await settle();
		const placed = events(other.c, 'beaconPlace', n);
		assert.equal(placed.length, 1);
		assert.deepEqual([placed[0]!.ownerId, placed[0]!.x, placed[0]!.y], [inf.id, -600, 600]);
		assert.ok(placed[0]!.z >= 0 && placed[0]!.z < 0.25, 'on the floor');
		// A second press within the cooldown is refused without a chat line.
		inf.c.send({ type: 'placeBeacon' });
		await settle();
		assert.equal(events(other.c, 'beaconPlace', n).length, 1);
		assert.equal(chats(inf.c, noRoom, k).length, 0);

		const deaths = game().playerView(inf.id)!.deaths;
		await moveTo(inf, 0, 0, -1000);
		await run(100);
		let sp = events(inf.c, 'spawn', k);
		assert.equal(sp.length, 1);
		assert.deepEqual([sp[0]!.reason, sp[0]!.x, sp[0]!.y, sp[0]!.team, sp[0]!.weapon], ['beacon', -600, 600, 'infected', 'claws']);
		assert.deepEqual(events(other.c, 'beaconUse', n).map((x) => [x.id, x.ownerId]), [[placed[0]!.id, inf.id]]);
		assert.equal(lastState(other.c).beacons.length, 0);
		assert.equal(game().playerView(inf.id)!.deaths, deaths);

		// Used up: the next fall is the far spawn.
		await moveTo(inf, -600, 600);
		await run(1100);
		await moveTo(inf, 0, 0, -1000);
		await run(100);
		sp = events(inf.c, 'spawn', k);
		assert.equal(sp.at(-1)!.reason, 'fall');
		assert.equal(events(inf.c, 'spawn', k).filter((s) => s.reason === 'beacon').length, 1);
		assert.equal(events(other.c, 'beaconUse', n).length, 1);
	});
});

describe('infected kill streaks, three slots and the M.O.A.B. over the wire', () => {
	before(async () => {
		clock = 5_000_000_000;
		server = await startServer({
			port: 0,
			host: '127.0.0.1',
			dbPath: ':memory:',
			maps: [infectedMap(), testMap('surf_b', 'Bravo')],
			initialMap: 'inf_test',
			now: () => clock,
			rng: () => 0,
			timers: false,
			log: () => {},
			modes: { infected: { graceSecs: GRACE, roundSecs: 60, endSecs: 1, moabKills: 2 } }
		});
	});
	after(closeAll);

	it('join help, pistol slot, perk unlocks, moabReady (private), callMoab → INBOUND → detonation → survivors win', async () => {
		for (const name of ['Lia', 'Max', 'Ned']) await join(name);
		const { Lia: l, Max: m, Ned: d } = ps as Record<string, P>;
		assert.equal(chats(l!.c, /1-3 switches primary\/pistol\/knife/).length, 1);
		assert.equal(chats(l!.c, /press \[N\] to call it/).length, 1);
		assert.equal(chats(l!.c, /Loadout: \.50 cal rifle \+ pistol \+ knife \(1-3 to switch\)/).length, 1);
		await run(GRACE * 1000 + 100);
		assert.equal(game().phase, 'playing');
		assert.equal(game().alphaId, l!.id);

		// Slot 2 over the wire: the pistol, then back to the primary.
		let n = m!.c.messages.length;
		m!.c.send({ type: 'loadout', weapon: 'pistol' });
		await settle();
		assert.deepEqual(events(m!.c, 'ammo', n).at(-1), { e: 'ammo', id: m!.id, weapon: 'pistol', mag: 12, reserve: 36 });
		await run(300);
		assert.equal(lastState(d!.c).players.find((p) => p.id === m!.id)!.weapon, 'pistol');
		m!.c.send({ type: 'loadout', weapon: 'barrett' });
		await settle();
		assert.equal(game().weaponOf(m!.id)!.weapon, 'barrett');
		await run(500); // the draw

		// Nothing to call yet.
		n = d!.c.messages.length;
		m!.c.send({ type: 'callMoab' });
		await settle();
		assert.equal(events(d!.c, 'moabCall', n).length, 0);

		await moveTo(d!, 1000, 1000);
		await moveTo(m!, -600, 900);
		const killAlpha = async () => {
			await runUntil(() => game().playerView(l!.id)!.alive, 4000);
			await moveTo(l!, -600, 400);
			await run(400);
			const k = m!.c.messages.length;
			fireAt(m!, headOf(l!), 'barrett');
			await settle();
			assert.equal(events(m!.c, 'kill', k).length, 1);
			return k;
		};
		await killAlpha();
		assert.deepEqual(events(d!.c, 'perk', 0).at(-1), { e: 'perk', id: m!.id, perk: 'sleight', streak: 1 });
		const nd = d!.c.messages.length;
		const k2 = await killAlpha();
		assert.deepEqual(events(m!.c, 'moabReady', k2), [{ e: 'moabReady', id: m!.id }]);
		assert.equal(events(d!.c, 'moabReady', nd).length, 0, 'moabReady is private');
		assert.equal(chats(m!.c, /^M\.O\.A\.B\. ready! Press \[N\]/, k2).length, 1);
		await run(40);
		const me = lastState(d!.c).players.find((p) => p.id === m!.id)!;
		assert.deepEqual([me.streak, me.perks, me.moabReady], [2, ['hardline', 'sleight'], true]);
		assert.equal(lastState(d!.c).secondary, 'pistol');

		// Ned (no streak) cannot call it; Max can, once.
		n = d!.c.messages.length;
		d!.c.send({ type: 'callMoab' });
		m!.c.send({ type: 'callMoab' });
		m!.c.send({ type: 'callMoab' });
		await settle();
		assert.deepEqual(events(d!.c, 'moabCall', n), [{ e: 'moabCall', by: m!.id, secs: 10 }]);
		assert.equal(chats(d!.c, /^M\.O\.A\.B\. INBOUND! Detonating in 10 s! Called in by Max\./, n).length, 1);
		assert.deepEqual(lastState(d!.c).moab, { callerId: m!.id, timeLeft: 10 });

		const before = game().playerView(m!.id)!;
		const ned = game().playerView(d!.id)!.score;
		await runUntil(() => game().playerView(l!.id)!.alive, 4000);
		await moveTo(l!, 1000, -1000);
		const det = await runUntil(() => events(d!.c, 'moabDetonate', n)[0], 11_000);
		assert.deepEqual(det, { e: 'moabDetonate', by: m!.id, kills: 1 });
		await run(40);
		assert.equal(chats(d!.c, /^M\.O\.A\.B\. detonated! Max wiped out 1 infected/, n).length, 1);
		assert.deepEqual(events(d!.c, 'end', n).map((x) => [x.winner, x.survivorsLeft]), [['survivors', 2]]);
		assert.equal(chats(d!.c, /^Survivors win round 1!/, n).length, 1);
		const after = game().playerView(m!.id)!;
		assert.equal(after.kills, before.kills + 1);
		assert.equal(after.score, before.score + INF_SCORE_MOAB + INF_SCORE_SURVIVE_WIN);
		assert.equal(game().playerView(d!.id)!.score, ned + INF_SCORE_SURVIVE_WIN);
		assert.equal(lastState(d!.c).moab, null);
	});
});
