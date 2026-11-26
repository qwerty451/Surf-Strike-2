/** Zombie Defense on a real server (docs/modes.md#zombie-defense), on the shared test arena. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ServerMessage, Vec3, ZdEvent } from '@surf/shared';
import { defenseFixtureMap, Status, VIEW_HEIGHT, ZD_GOLD, ZD_PLAYER_HP, ZD_SHOP, zdTurretCost } from '@surf/shared';
import { parseZdInput } from './modes/defense-input.ts';
import type { DefenseMode } from './modes/defense.ts';
import type { GameServer } from './server.ts';
import { startServer } from './server.ts';
import { netState, sleep, TestClient, testMap } from './test-helpers.ts';

type ZdState = Extract<ServerMessage, { type: 'modeState'; mode: 'defense' }>;
type Ev<K extends ZdEvent['e']> = Extract<ZdEvent, { e: K }>;

const map = defenseFixtureMap();
let clock = 2_000_000_000;
let server: GameServer;
const clients: TestClient[] = [];

const mode = () => server.lobby.gameMode as DefenseMode;
const game = () => mode().game;
const settle = () => sleep(40);
const unit = (x: number, y: number, z: number): Vec3 => {
	const l = Math.hypot(x, y, z);
	return { x: x / l, y: y / l, z: z / l };
};

async function run(ms: number): Promise<void> {
	for (let t = 0; t < ms; t += 1000 / 32) {
		clock += 1000 / 32;
		server.lobby.tickMode();
	}
	await settle();
}

function events<K extends ZdEvent['e']>(c: TestClient, e: K, from = 0): Ev<K>[] {
	return c.messages
		.slice(from)
		.filter((m): m is Extract<ServerMessage, { type: 'zd' }> => m.type === 'zd' && m.ev.e === e)
		.map((m) => m.ev as Ev<K>);
}

const lastState = (c: TestClient) => c.of('modeState').at(-1) as ZdState;

async function moveTo(c: TestClient, id: number, p: Vec3) {
	// Settle the server spawn first (netcode v3 spawn handshake), then move.
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
		modes: { defense: { firstBuildSecs: 30, buildSecs: 30, endSecs: 2, spawnIntervalScale: 1e9, startGold: 1000, plan: () => ['walker', 'walker'] } }
	});
});

after(async () => {
	for (const c of clients) c.close();
	await server.close();
});

describe('defense mode', () => {
	let a: TestClient;
	let aId: number;
	let spawn: Vec3;
	const eye = () => ({ x: spawn.x, y: spawn.y, z: spawn.z + VIEW_HEIGHT });

	it('join starts a game: build phase, spawn inside, mode state with openings, pads and players', async () => {
		a = new TestClient(server.port);
		clients.push(a);
		const w = await a.hello('Alice');
		aId = w.selfId;
		assert.equal(w.mode, 'defense');
		await settle();
		const st = lastState(a);
		assert.equal(st.phase, 'build');
		assert.equal(st.wave, 1);
		assert.equal(st.round, 1);
		assert.deepEqual(
			st.openings.map((o) => o.planks),
			[6, 6, 6, 4]
		);
		assert.equal(st.pads.length, 4);
		assert.deepEqual(st.players[0], {
			id: aId,
			status: 'alive',
			hp: ZD_PLAYER_HP,
			maxHp: ZD_PLAYER_HP,
			gold: 1000,
			kills: 0,
			deaths: 0,
			weapon: 'pistol',
			weapons: ['pistol'],
			hpLevel: 0,
			damageLevel: 0,
			reloadLevel: 0,
			ready: false
		});
		const sp = events(a, 'spawn').at(-1)!;
		assert.equal(sp.reason, 'game');
		spawn = { x: sp.x, y: sp.y, z: sp.z };
		await moveTo(a, aId, spawn);
		assert.ok(a.messages.some((m) => m.type === 'chat' && m.system && /Zombie Defense: hold the base/.test(m.text)));
	});

	it('zd messages: buy (result to the buyer), pad build next to a pad, malformed ones are dropped', async () => {
		const n = a.messages.length;
		a.send({ type: 'zd', act: { a: 'buy', item: 'hp' } });
		a.send({ type: 'zd', act: { a: 'buy', item: 'weapon:lmg' } }); // 1400 gold: refused
		a.send({ type: 'zd', act: { a: 'pad', pad: 0, op: 'build', turret: 'nuke' } }); // dropped
		a.send({ type: 'zd', act: { a: 'repair', on: 'yes' } }); // dropped
		a.send({ type: 'zd', act: 'ready' }); // dropped
		await settle();
		const res = events(a, 'result', n);
		assert.deepEqual(
			res.map((r) => [r.act, r.ok, r.reason ?? null]),
			[
				['buy:hp', true, null],
				['buy:weapon:lmg', false, 'gold']
			]
		);
		// Enough gold for a sentry: stand on pad 0.
		const pad = map.defense!.pads[0]!.pos;
		await moveTo(a, aId, { x: pad.x + 10, y: pad.y, z: 0 });
		a.send({ type: 'zd', act: { a: 'pad', pad: 0, op: 'build', turret: 'sentry' } });
		await settle();
		const r = events(a, 'result', n).at(-1)!;
		assert.deepEqual([r.act, r.ok, r.gold], ['pad:build', true, 1000 - ZD_SHOP.hp[0]! - zdTurretCost('sentry', 1)]);
		assert.deepEqual(events(a, 'turret', n)[0], { e: 'turret', pad: 0, type: 'sentry', level: 1, by: aId, op: 'build' });
		await run(300);
		assert.deepEqual(lastState(a).pads[0], { type: 'sentry', level: 1, owner: aId });
		await moveTo(a, aId, spawn);
	});

	it('ready starts the wave; BIN_DEFENSE frames carry zombies and turrets; a pistol kill pays gold', async () => {
		a.send({ type: 'zd', act: { a: 'ready' } });
		await settle();
		await run(1100);
		assert.equal(lastState(a).phase, 'wave');
		assert.ok(a.messages.some((m) => m.type === 'chat' && m.system && /Wave 1: 2 zombies/.test(m.text)));
		const f = a.defenseFrames.at(-1)!;
		assert.ok(f, 'defense snapshots are sent');
		assert.equal(f.zombies.length, 1);
		assert.equal(f.zombies[0]!.kind, 'walker');
		assert.deepEqual(
			f.turrets.map((t) => t.pad),
			[0]
		);
		// A walker of our own, right in front: 4 pistol body hits.
		const z = game().spawnZombie('walker', { x: spawn.x + 300, y: spawn.y, z: 0.25 })!;
		z.yaw = 180;
		const gold0 = game().playerView(aId)!.gold;
		const n = a.messages.length;
		for (let i = 0; i < 4; i++) {
			clock += 200;
			const o = z.body.origin;
			a.send({ type: 'fire', weapon: 'pistol', origin: eye(), dir: unit(o.x - spawn.x, o.y - spawn.y, o.z + 30 - eye().z), tick: game().tick });
			await settle();
		}
		const kills = events(a, 'kill', n).filter((k) => k.zid === z.id);
		if (game().zombies.has(z.id)) assert.fail('walker survived 4 pistol hits');
		// The sentry may have taken it first.
		if (kills[0]!.by === aId) assert.equal(game().playerView(aId)!.gold, gold0 + ZD_GOLD.kill);
		else assert.equal(kills[0]!.pad, 0);
		// Malformed fire: dropped, no ammo resync.
		const m = a.messages.length;
		a.send({ type: 'fire', weapon: 'pistol', origin: eye(), dir: { x: 1, y: 0, z: 0 } }); // no tick
		await settle();
		assert.equal(events(a, 'ammo', m).length, 0);
	});

	it('clearing the wave pays the bonus and starts the build phase; Tab rows show gold', async () => {
		game().zombies.clear();
		// The second walker of the plan is due only after 1e9 × the interval: drop it.
		const g = game() as unknown as { queue: unknown[] };
		g.queue = [];
		const n = a.messages.length;
		await run(100);
		const cleared = events(a, 'cleared', n)[0]!;
		assert.equal(cleared.wave, 1);
		assert.deepEqual(cleared.ids, [aId]);
		assert.equal(lastState(a).phase, 'build');
		assert.equal(lastState(a).wave, 2);
		const row = mode()
			.scoreRows()
			.find((r) => r.id === aId)!;
		assert.equal(row.score, game().playerView(aId)!.gold);
		assert.equal(row.status, Status.Alive);
		assert.equal(mode().stillness({ id: aId } as never), null);
	});

	it('a second player joining during a wave waits (held) and spawns at the next build phase', async () => {
		a.send({ type: 'zd', act: { a: 'ready' } });
		await settle();
		await run(100);
		assert.equal(game().phase, 'wave');
		const b = new TestClient(server.port);
		clients.push(b);
		const w = await b.hello('Bob');
		await settle();
		await run(100);
		assert.equal(game().playerView(w.selfId)!.status, 'waiting');
		assert.equal(mode().stillness({ id: w.selfId } as never), 'held');
		assert.ok(b.messages.some((m) => m.type === 'chat' && m.system && /next build phase/.test(m.text)));
		game().zombies.clear();
		(game() as unknown as { queue: unknown[] }).queue = [];
		await run(100);
		assert.equal(game().phase, 'build');
		assert.equal(events(b, 'spawn').at(-1)!.reason, 'join');
		assert.equal(game().playerView(w.selfId)!.status, 'alive');
		assert.ok(ZD_SHOP.ammo > 0);
	});
});

describe('defense input validation', () => {
	it('keeps well-formed messages (fresh copies) and drops malformed ones whole', () => {
		const o = { x: 1, y: 2, z: 3, evil: true };
		const fire = parseZdInput({ type: 'fire', weapon: 'smg', origin: o, dir: { x: 1, y: 0, z: 0 }, tick: 5 });
		assert.deepEqual(fire, { type: 'fire', weapon: 'smg', origin: { x: 1, y: 2, z: 3 }, dir: { x: 1, y: 0, z: 0 }, tick: 5 });
		assert.equal(parseZdInput({ type: 'fire', weapon: 'smg', origin: o, dir: { x: 1, y: 0, z: 0 } }), null);
		assert.equal(parseZdInput({ type: 'fire', weapon: 'bazooka', origin: o, dir: { x: 1, y: 0, z: 0 }, tick: 1 }), null);
		assert.equal(parseZdInput({ type: 'fire', weapon: 'smg', origin: { x: NaN, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 }, tick: 1 }), null);
		assert.deepEqual(parseZdInput({ type: 'reload', junk: 1 }), { type: 'reload' });
		assert.deepEqual(parseZdInput({ type: 'zd', act: { a: 'ready', x: 1 } }), { type: 'zd', act: { a: 'ready' } });
		assert.deepEqual(parseZdInput({ type: 'zd', act: { a: 'repair', on: false } }), { type: 'zd', act: { a: 'repair', on: false } });
		assert.equal(parseZdInput({ type: 'zd', act: { a: 'repair', on: 1 } }), null);
		assert.deepEqual(parseZdInput({ type: 'zd', act: { a: 'weapon', weapon: 'lmg' } }), { type: 'zd', act: { a: 'weapon', weapon: 'lmg' } });
		assert.equal(parseZdInput({ type: 'zd', act: { a: 'weapon', weapon: 'knife' } }), null);
		assert.deepEqual(parseZdInput({ type: 'zd', act: { a: 'buy', item: 'ammo' } }), { type: 'zd', act: { a: 'buy', item: 'ammo' } });
		assert.equal(parseZdInput({ type: 'zd', act: { a: 'buy', item: 'x'.repeat(65) } }), null);
		assert.equal(parseZdInput({ type: 'zd', act: { a: 'buy', item: '' } }), null);
		assert.deepEqual(parseZdInput({ type: 'zd', act: { a: 'pad', pad: 2, op: 'build', turret: 'tesla' } }), {
			type: 'zd',
			act: { a: 'pad', pad: 2, op: 'build', turret: 'tesla' }
		});
		assert.deepEqual(parseZdInput({ type: 'zd', act: { a: 'pad', pad: 2, op: 'sell' } }), { type: 'zd', act: { a: 'pad', pad: 2, op: 'sell' } });
		assert.equal(parseZdInput({ type: 'zd', act: { a: 'pad', pad: 2, op: 'build' } }), null);
		assert.equal(parseZdInput({ type: 'zd', act: { a: 'pad', pad: 2.5, op: 'sell' } }), null);
		assert.equal(parseZdInput({ type: 'zd', act: { a: 'pad', pad: -1, op: 'sell' } }), null);
		assert.equal(parseZdInput({ type: 'zd', act: { a: 'pad', pad: 1, op: 'sell', turret: 'sentry' } }), null);
		assert.equal(parseZdInput({ type: 'zd', act: { a: 'pad', pad: 1, op: 'explode' } }), null);
		assert.equal(parseZdInput({ type: 'zd', act: { a: 'fly' } }), null);
		assert.equal(parseZdInput({ type: 'loadout', weapon: 'lmg' }), null);
		assert.equal(parseZdInput(null), null);
	});
});
