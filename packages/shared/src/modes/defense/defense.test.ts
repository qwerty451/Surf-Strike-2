import { describe, expect, it } from 'vitest';
import { buildCollisionWorld } from '../../collision/world.ts';
import { HULL_MAX, HULL_MIN, VIEW_HEIGHT } from '../../movement/api.ts';
import type { Vec3 } from '../../types.ts';
import { GAME_MODES, mapCvars } from '../index.ts';
import { WEAPONS } from '../zombies/weapons.ts';
import { defenseFixtureMap } from './fixture.ts';
import { DefenseGame, defenseWorld, zdEventRoute, type DefenseGameOptions, type ZdEvent } from './game.ts';
import { NavGraph } from './nav.ts';
import { ZD_EARLY_TEAR } from './rules.ts';
import { BIN_DEFENSE, decodeDefense, encodeDefense, ZDF_FROSTED, ZDF_TEARING, ZDT_FIRED } from './net.ts';
import {
	parseZdItem,
	ZD_GOLD,
	ZD_MAX_ZOMBIES,
	ZD_PLAYER_HP,
	ZD_REPAIR_MS,
	ZD_SHOP,
	ZD_TURRETS,
	ZD_ZOMBIES,
	zdHpScale,
	zdAliveCap,
	zdBossCount,
	zdIsBossWave,
	ZD_SPAWN_MIN_MS,
	zdSpawnInterval,
	zdTurretCost,
	zdTurretRefund,
	zdWaveCount,
	zdWaveMix,
	zdWavePlan,
	zdZombieHp,
	type ZdZombieKind
} from './rules.ts';

const map = defenseFixtureMap();
const world = buildCollisionWorld(map);
const T0 = 1_000_000;
const STEP = 1000 / 32;
const unit = (x: number, y: number, z: number): Vec3 => {
	const l = Math.hypot(x, y, z);
	return { x: x / l, y: y / l, z: z / l };
};
const lcg = (seed = 7) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** A game on the fixture map with a fake clock. `plan` defaults to empty waves. */
function setup(opts: Partial<DefenseGameOptions> = {}, players: number[] = [1]) {
	let now = T0;
	const g = new DefenseGame({
		map,
		world,
		cvars: mapCvars(map),
		now,
		rng: lcg(),
		firstBuildSecs: 5,
		buildSecs: 5,
		endSecs: 2,
		plan: () => [],
		earlyTear: [],
		...opts
	});
	const pos = new Map<number, Vec3>();
	const events: ZdEvent[] = [];
	const place = (id: number, p: Vec3) => {
		pos.set(id, p);
		g.setPlayerPos(id, { ...p, ducked: false });
	};
	g.syncPlayers(players, now);
	events.push(...g.update(now));
	for (const [i, id] of players.entries()) place(id, map.spawns![i % 4]!.pos);
	const run = (ms: number) => {
		const out: ZdEvent[] = [];
		for (let t = 0; t < ms; t += STEP) {
			now += STEP;
			for (const [id, p] of pos) g.setPlayerPos(id, { ...p, ducked: false });
			out.push(...g.update(now));
		}
		events.push(...out);
		return out;
	};
	return { g, run, place, events, now: () => now, pos };
}
const of = <K extends ZdEvent['e']>(evs: ZdEvent[], e: K) => evs.filter((x): x is Extract<ZdEvent, { e: K }> => x.e === e);

/** Start the first wave right away (everyone ready). */
function toWave(s: ReturnType<typeof setup>, ids: number[] = [1]) {
	for (const id of ids) s.g.act(id, { a: 'ready' }, s.now());
	s.run(STEP);
	expect(s.g.phase).toBe('wave');
}

describe('rules', () => {
	it('mode registered', () => {
		expect(GAME_MODES.defense.family).toBe('defense');
		expect(GAME_MODES.defense.minPlayers).toBe(1);
	});

	it('wave size, hp and spawn rate scale with the wave and the players', () => {
		expect(zdWaveCount(1, 1)).toBe(12);
		expect(zdWaveCount(5, 1)).toBe(37);
		expect(zdWaveCount(10, 1)).toBe(83);
		expect(zdWaveCount(1, 3)).toBe(25);
		// Alive at once grows with the wave, so the team is overwhelmed in the end.
		expect(zdAliveCap(1, 1)).toBe(18);
		expect(zdAliveCap(10, 1)).toBe(54);
		expect(zdAliveCap(25, 1)).toBe(ZD_MAX_ZOMBIES);
		expect(zdAliveCap(10, 4)).toBe(85);
		expect(zdSpawnInterval(1, 1)).toBe(1100);
		expect(zdSpawnInterval(1, 11)).toBe(550);
		expect(zdSpawnInterval(8, 30)).toBe(ZD_SPAWN_MIN_MS);
		expect(zdHpScale(1)).toBe(1);
		expect(zdHpScale(11)).toBeCloseTo(2.2);
		expect(zdZombieHp('walker', 1, 4)).toBe(8);
		expect(zdZombieHp('boss', 5, 1)).toBe(Math.round(ZD_ZOMBIES.boss.hp * zdHpScale(5)));
		expect(zdZombieHp('boss', 5, 3)).toBeGreaterThan(zdZombieHp('boss', 5, 1) * 2);
		expect(zdSpawnInterval(3)).toBeLessThan(zdSpawnInterval(1));
	});

	it('runners from wave 3, brutes from wave 5, a boss every 5th wave', () => {
		expect(zdWaveMix(2)).toEqual({ runner: 0, brute: 0 });
		expect(zdWaveMix(3).runner).toBeGreaterThan(0);
		expect(zdWaveMix(4).brute).toBe(0);
		expect(zdWaveMix(5).brute).toBeGreaterThan(0);
		expect(zdWaveMix(40)).toEqual({ runner: 0.3, brute: 0.2 });
		const w4 = zdWavePlan(4, 1, lcg());
		expect(w4).toHaveLength(zdWaveCount(4, 1));
		expect(w4).not.toContain('boss');
		const w5 = zdWavePlan(5, 1, lcg());
		expect(w5.filter((k) => k === 'boss')).toHaveLength(1);
		expect(w5).toHaveLength(zdWaveCount(5, 1) + 1);
		expect(w5.slice(0, 3)).not.toContain('brute');
		expect(zdIsBossWave(10)).toBe(true);
		expect(zdIsBossWave(11)).toBe(false);
		// One more boss every 5 waves, spread through the wave.
		expect([4, 5, 10, 15, 20].map(zdBossCount)).toEqual([0, 1, 2, 3, 4]);
		const w15 = zdWavePlan(15, 1, lcg());
		const at = w15.flatMap((k, i) => (k === 'boss' ? [i] : []));
		expect(at).toHaveLength(3);
		expect(w15).toHaveLength(zdWaveCount(15, 1) + 3);
		expect(at[1]! - at[0]!).toBeGreaterThan(20);
		expect(at[2]! - at[1]!).toBeGreaterThan(20);
	});

	it('turret costs ×1.5 per level, sell refunds half', () => {
		expect(zdTurretCost('sentry', 1)).toBe(300);
		expect(zdTurretCost('sentry', 2)).toBe(450);
		expect(zdTurretCost('sentry', 3)).toBe(675);
		expect(zdTurretCost('tesla', 1)).toBe(900);
		expect(zdTurretRefund('sentry', 1)).toBe(150);
		expect(zdTurretRefund('sentry', 2)).toBe(375);
		for (const t of Object.values(ZD_TURRETS)) {
			const [a, b, c] = t.levels;
			expect(b.range).toBeGreaterThan(a.range);
			expect(c.range).toBeGreaterThan(b.range);
		}
	});

	it('shop item ids', () => {
		expect(parseZdItem('weapon:smg')).toEqual({ kind: 'weapon', weapon: 'smg' });
		expect(parseZdItem('weapon:pistol')).toBeNull();
		expect(parseZdItem('weapon:knife')).toBeNull();
		expect(parseZdItem('reinforce:north_door')).toEqual({ kind: 'reinforce', opening: 'north_door' });
		expect(parseZdItem('repairAll')).toEqual({ kind: 'repairAll' });
		expect(parseZdItem('reinforce:')).toBeNull();
		expect(parseZdItem(42)).toBeNull();
	});
});

describe('nav graph', () => {
	const nav = new NavGraph(map.defense!.nav);
	it('A* and closed links', () => {
		expect(nav.path(9, 0)).toEqual([9, 5, 1, 0]);
		// North door closed: round the corner to the east door.
		const p = nav.path(9, 0, (a, b) => (a === 5 && b === 1) || (a === 1 && b === 5));
		expect(p).toEqual([9, 5, 13, 6, 2, 0]);
		expect(nav.path(9, 0, () => true)).toBeNull();
		expect(nav.nearest({ x: 10, y: 600, z: 0 })).toBe(5);
	});
});

describe('BIN_DEFENSE', () => {
	it('round trip', () => {
		const buf = encodeDefense(
			1234,
			[{ id: 7, x: 100.5, y: -200, z: 3, yaw: 90, flags: ZDF_TEARING | ZDF_FROSTED, hp: 0.5, kind: 'brute' }],
			[{ pad: 2, yaw: -45, pitch: 10, flags: ZDT_FIRED, target: 7 }]
		);
		expect(buf[0]).toBe(BIN_DEFENSE);
		const f = decodeDefense(buf)!;
		expect(f.tick).toBe(1234);
		expect(f.zombies[0]).toMatchObject({ id: 7, x: 100.5, y: -200, z: 3, flags: ZDF_TEARING | ZDF_FROSTED, kind: 'brute' });
		expect(f.zombies[0]!.yaw).toBeCloseTo(90, 0);
		expect(f.zombies[0]!.hp).toBeCloseTo(0.5, 1);
		expect(f.turrets[0]).toMatchObject({ pad: 2, pitch: 10, flags: ZDT_FIRED, target: 7 });
		expect(f.turrets[0]!.yaw).toBeCloseTo(-45, 0);
		expect(decodeDefense(buf.slice(0, buf.length - 1))).toBeNull();
		expect(decodeDefense(new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0]))).toBeNull();
	});
});

describe('game flow', () => {
	it('waiting → build → wave → cleared (bonus gold) → build; ready ends the build phase early', () => {
		const s = setup({ plan: () => ['walker'] });
		expect(s.g.phase).toBe('build');
		expect(s.g.view(s.now())).toMatchObject({ phase: 'build', wave: 1, round: 1, timeLeft: 5 });
		expect(of(s.events, 'spawn')[0]).toMatchObject({ id: 1, reason: 'game', hp: ZD_PLAYER_HP });
		const r = s.g.act(1, { a: 'ready' }, s.now());
		expect(of(r, 'result')[0]).toMatchObject({ ok: true, act: 'ready' });
		expect(of(r, 'ready')).toHaveLength(1);
		s.run(STEP);
		expect(s.g.phase).toBe('wave');
		s.run(1100);
		expect(s.g.zombies.size).toBe(1);
		s.g.zombies.clear();
		const evs = s.run(STEP * 2);
		expect(of(evs, 'cleared')[0]).toMatchObject({ wave: 1, bonus: ZD_GOLD.waveBonus(1), ids: [1] });
		expect(s.g.phase).toBe('build');
		expect(s.g.view(s.now()).wave).toBe(2);
		expect(s.g.playerView(1)!.gold).toBe(ZD_GOLD.start + ZD_GOLD.waveBonus(1));
		// The build phase also ends at its timer.
		s.run(5100);
		expect(s.g.phase).toBe('wave');
		expect(s.g.wave).toBe(2);
	});

	it('the game is lost when every player is dead; a new game starts from wave 1 with everything reset', () => {
		const s = setup({ plan: () => ['walker'] });
		s.g.act(1, { a: 'buy', item: 'weapon:smg' }, s.now()); // 600 > 250: refused
		expect(s.g.playerView(1)!.weapons).toEqual(['pistol']);
		toWave(s);
		s.run(1100);
		const z = [...s.g.zombies.values()][0]!;
		// Stand right next to it.
		const o = z.body.origin;
		s.place(1, { x: o.x + 30, y: o.y, z: o.z });
		let evs: ZdEvent[] = [];
		for (let i = 0; i < 60 && s.g.phase === 'wave'; i++) evs = evs.concat(s.run(500));
		expect(of(evs, 'hurt').length).toBeGreaterThan(0);
		expect(of(evs, 'death')[0]).toMatchObject({ id: 1 });
		const end = of(evs, 'end')[0]!;
		expect(end).toMatchObject({ wave: 1, round: 1, kills: 0, topId: null });
		expect(s.g.phase).toBe('ended');
		expect(s.g.playerView(1)!.status).toBe('dead');
		s.run(2100);
		expect(s.g.phase).toBe('build');
		expect(s.g.round).toBe(2);
		expect(s.g.zombies.size).toBe(0);
		expect(s.g.playerView(1)).toMatchObject({ status: 'alive', hp: ZD_PLAYER_HP, gold: ZD_GOLD.start, weapons: ['pistol'] });
		expect(s.g.view(s.now()).openings.map((x) => x.planks)).toEqual([6, 6, 6, 4]);
	});

	it('a player joining during a wave waits and plays from the next build phase; a dead player respawns there', () => {
		const s = setup({ plan: () => ['walker'] }, [1, 2]);
		toWave(s, [1, 2]);
		s.g.syncPlayers([1, 2, 3], s.now());
		expect(s.g.playerView(3)!.status).toBe('waiting');
		expect(s.g.act(3, { a: 'ready' }, s.now())[0]).toMatchObject({ e: 'result', ok: false });
		expect(s.g.fire(3, { weapon: 'pistol', origin: { x: 0, y: 0, z: 64 }, dir: { x: 1, y: 0, z: 0 }, tick: 0 }, s.now()).ok).toBe(false);
		s.run(1100);
		// Kill player 2 by hand: a brute next to them.
		const p2 = map.spawns![1]!.pos;
		s.g.spawnZombie('brute', { x: p2.x + 40, y: p2.y, z: 0.25 });
		let evs: ZdEvent[] = [];
		for (let i = 0; i < 40 && s.g.playerView(2)!.status === 'alive'; i++) evs = evs.concat(s.run(250));
		expect(s.g.playerView(2)!.status).toBe('dead');
		expect(of(evs, 'hurt').find((h) => h.id === 2)!.hp).toBe(ZD_PLAYER_HP - ZD_ZOMBIES.brute.damage);
		expect(s.g.phase).toBe('wave'); // player 1 lives
		s.g.zombies.clear();
		evs = s.run(STEP * 2);
		expect(s.g.phase).toBe('build');
		expect(of(evs, 'cleared')[0]!.ids.sort()).toEqual([1, 2]);
		const spawns = of(evs, 'spawn');
		expect(spawns.find((e) => e.id === 2)!.reason).toBe('respawn');
		expect(spawns.find((e) => e.id === 3)!.reason).toBe('join');
		expect(spawns.find((e) => e.id === 1)).toBeUndefined();
		expect(s.g.playerView(3)!.status).toBe('alive');
	});

	it('leaving and coming back in the same game (spectate toggle) keeps gold, weapons and kills', () => {
		const s = setup({ startGold: 2000, plan: () => ['walker'] }, [1, 2]);
		const pad = map.defense!.pads[0]!.pos;
		s.place(1, { x: pad.x, y: pad.y, z: 0 });
		s.g.act(1, { a: 'pad', pad: 0, op: 'build', turret: 'sentry' }, s.now());
		s.g.act(1, { a: 'buy', item: 'weapon:smg' }, s.now());
		const gold = s.g.playerView(1)!.gold;
		expect(gold).toBe(2000 - 300 - ZD_SHOP.weapons.smg);
		s.g.syncPlayers([2], s.now());
		s.run(STEP);
		s.g.syncPlayers([1, 2], s.now());
		const evs = s.run(STEP);
		expect(s.g.playerView(1)).toMatchObject({ status: 'alive', gold, weapons: ['pistol', 'smg'] });
		expect(of(evs, 'spawn').find((e) => e.id === 1)!.reason).toBe('join');
		// During a wave: waits, then comes back with the same gold.
		toWave(s, [1, 2]);
		s.g.syncPlayers([2], s.now());
		s.run(STEP);
		s.g.syncPlayers([1, 2], s.now());
		s.run(STEP);
		expect(s.g.playerView(1)!.status).toBe('waiting');
		s.g.zombies.clear();
		s.run(1200);
		s.g.zombies.clear();
		s.run(STEP * 2);
		expect(s.g.phase).toBe('build');
		// Back from the next build phase with the same gold; the wave's bonus went to player 2 only (still in the game).
		expect(s.g.playerView(1)).toMatchObject({ status: 'alive', gold, weapons: ['pistol', 'smg'] });
		expect(s.g.playerView(2)!.gold).toBe(2000 + ZD_GOLD.waveBonus(1));
	});

	it('everyone leaves: waiting', () => {
		const s = setup();
		s.g.syncPlayers([], s.now());
		const evs = s.run(STEP);
		expect(s.g.phase).toBe('waiting');
		expect(of(evs, 'phase')[0]!.phase).toBe('waiting');
	});

	it('a wave over the time cap removes its remaining zombies and counts as cleared', () => {
		const s = setup({ waveMaxSecs: 3, plan: () => ['walker', 'walker', 'walker'], spawnIntervalScale: 1e9 });
		toWave(s);
		const evs = s.run(3200);
		expect(of(evs, 'timeout')[0]).toMatchObject({ wave: 1, removed: 3 });
		expect(of(evs, 'cleared')).toHaveLength(1);
		expect(s.g.phase).toBe('build');
	});
});

describe('spawning', () => {
	it('spawns walk round the sides, at most ZD_MAX_ZOMBIES alive', () => {
		const s = setup({ plan: () => Array<ZdZombieKind>(8).fill('walker'), maxZombies: 6 });
		toWave(s);
		s.run(1100 + 3 * 1100 + 50);
		const sides = new Set([...s.g.zombies.values()].map((z) => `${Math.sign(Math.round(z.body.origin.x / 1000))},${Math.sign(Math.round(z.body.origin.y / 1000))}`));
		expect(sides.size).toBe(4);
		s.run(10_000);
		expect(s.g.zombies.size).toBeLessThanOrEqual(6);
		expect(ZD_MAX_ZOMBIES).toBe(96);
	});

	it('boss spawn announces itself; HP of the wave', () => {
		const s = setup({ plan: () => ['boss'] });
		toWave(s);
		const evs = s.run(1100);
		const b = of(evs, 'boss')[0]!;
		expect(b.hp).toBe(zdZombieHp('boss', 1, 1));
		expect(s.g.view(s.now()).boss).toBe(1);
	});
});

describe('barricades and AI', () => {
	it('boarded openings are solid for movement (not for bullets); open when the last plank is gone', () => {
		const s = setup();
		const o = map.defense!.openings[0]!; // north door
		const a = { x: 0, y: 450, z: 1 };
		const b = { x: 0, y: 650, z: 1 };
		expect(s.g.world.trace(a, b, HULL_MIN, HULL_MAX).fraction).toBeLessThan(1);
		expect(s.g.base.trace(a, b, HULL_MIN, HULL_MAX).fraction).toBe(1);
		// The client's world from the same data.
		const cw = defenseWorld(world, map.defense!);
		expect(cw.trace(a, b, HULL_MIN, HULL_MAX).fraction).toBeLessThan(1);
		cw.setOpen(0, true);
		expect(cw.trace(a, b, HULL_MIN, HULL_MAX).fraction).toBe(1);
		expect(o.id).toBe('north_door');
	});

	it('a walker walks to an opening, tears a plank per 1.5 s, gets in and goes for the player', () => {
		const s = setup({ plan: () => ['walker'], spawnIntervalScale: 1e9 });
		toWave(s);
		s.run(1100);
		const z = [...s.g.zombies.values()][0]!;
		expect(z.state).toBe('approach');
		const torn: Array<{ t: number; i: number }> = [];
		let t = 0;
		let breach: number | null = null;
		for (; t < 40_000 && z.state !== 'inside'; t += 100) {
			for (const ev of s.run(100)) {
				if (ev.e === 'plank' && ev.by === null) torn.push({ t: s.now(), i: ev.opening });
				if (ev.e === 'breach') breach = ev.opening;
			}
		}
		expect(breach).not.toBeNull();
		const op = map.defense!.openings[breach!]!;
		expect(torn.filter((x) => x.i === breach)).toHaveLength(op.planks ?? 6);
		const gaps = torn.slice(1).map((x, i) => x.t - torn[i]!.t);
		for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1400);
		for (const gap of gaps) expect(gap).toBeLessThanOrEqual(1600);
		expect(z.state).toBe('inside');
		// Chases the player at their spawn and hurts them.
		let hurt = false;
		for (let i = 0; i < 100 && !hurt; i++) hurt = of(s.run(100), 'hurt').length > 0;
		expect(hurt).toBe(true);
	});

	it('only one zombie tears at an opening at a time; brutes tear 2.5× as fast; reinforced planks take 2×', () => {
		const tearTimes = (kind: ZdZombieKind, reinforce: boolean) => {
			const s = setup({ plan: () => ['walker'], spawnIntervalScale: 1e9, startGold: 5000 });
			if (reinforce) expect(of(s.g.act(1, { a: 'buy', item: 'reinforce:north_door' }, s.now()), 'result')[0]!.ok).toBe(true);
			toWave(s);
			s.run(1100);
			s.g.zombies.clear();
			const a = s.g.spawnZombie(kind, { x: -20, y: 640, z: 0.25 })!;
			const b = s.g.spawnZombie(kind, { x: 20, y: 660, z: 0.25 })!;
			const times: number[] = [];
			let t = 0;
			for (; t < 30_000 && s.g.planks(0) > 3; t += 50) for (const ev of s.run(50)) if (ev.e === 'plank' && ev.opening === 0) times.push(s.now());
			const tearing = [a, b].filter((z) => s.g.isTearing(z));
			return { times, tearing: tearing.length };
		};
		const w = tearTimes('walker', false);
		expect(w.tearing).toBe(1);
		const gap = (x: number[]) => x[2]! - x[1]!;
		expect(gap(w.times)).toBeGreaterThanOrEqual(1400);
		expect(gap(w.times)).toBeLessThanOrEqual(1600);
		const br = tearTimes('brute', false);
		expect(gap(br.times)).toBeLessThanOrEqual(700);
		const rf = tearTimes('walker', true);
		expect(gap(rf.times)).toBeGreaterThanOrEqual(2900);
	});

	it('the boss smashes a whole barricade at once', () => {
		const s = setup({ plan: () => ['walker'], spawnIntervalScale: 1e9 });
		toWave(s);
		s.run(1100);
		s.g.zombies.clear();
		s.g.spawnZombie('boss', { x: 0, y: 650, z: 0.25 });
		let evs: ZdEvent[] = [];
		for (let i = 0; i < 40 && s.g.planks(0) > 0; i++) evs = evs.concat(s.run(250));
		const planks = of(evs, 'plank').filter((p) => p.opening === 0);
		expect(planks).toHaveLength(1);
		expect(planks[0]!.planks).toBe(0);
		expect(of(evs, 'breach')[0]!.opening).toBe(0);
	});

	it('stall breaker: a zombie with no way to an opening is put back at a spawn zone after 8 s', () => {
		const s = setup({ plan: () => ['walker'], spawnIntervalScale: 1e9 });
		toWave(s);
		s.run(1100);
		s.g.zombies.clear();
		// Inside the base but still "approaching": no outside route from here, so it stands.
		s.place(1, { x: 2000, y: 2000, z: 0 }); // far away, out of sight
		const z = s.g.spawnZombie('walker', { x: -450, y: -450, z: 0.25 })!;
		s.run(7000);
		expect(Math.hypot(z.body.origin.x + 450, z.body.origin.y + 450)).toBeLessThan(60);
		s.run(2500);
		expect(Math.hypot(z.body.origin.x, z.body.origin.y)).toBeGreaterThan(1000);
		expect(z.state).toBe('approach');
	});
});

describe('repairs', () => {
	it('hold E at an opening: one plank per 0.6 s, 5 gold each up to the per-wave cap; nothing at full', () => {
		const s = setup({ plan: () => ['walker'], spawnIntervalScale: 1e9 });
		toWave(s);
		s.run(1100);
		s.g.zombies.clear();
		s.g.spawnZombie('boss', { x: 0, y: 650, z: 0.25 });
		for (let i = 0; i < 40 && s.g.planks(0) > 0; i++) s.run(250);
		s.g.zombies.clear();
		s.g.spawnZombie('walker', { x: 1900, y: 1900, z: 0.25 }); // keeps the wave going
		const inside = map.defense!.nav.nodes[map.defense!.openings[0]!.inside]!;
		s.place(1, { x: inside.x + 30, y: inside.y, z: 0 });
		const gold0 = s.g.playerView(1)!.gold;
		s.g.act(1, { a: 'repair', on: true }, s.now());
		const evs = s.run(ZD_REPAIR_MS * 3 + 50);
		expect(of(evs, 'plank').filter((p) => p.by === 1).map((p) => p.planks)).toEqual([1, 2, 3]);
		expect(s.g.playerView(1)!.gold).toBe(gold0 + 3 * ZD_GOLD.plank);
		s.g.act(1, { a: 'repair', on: false }, s.now());
		expect(of(s.run(2000), 'plank')).toHaveLength(0);
		// Out of range: nothing.
		s.place(1, { x: inside.x, y: inside.y - 200, z: 0 });
		s.g.act(1, { a: 'repair', on: true }, s.now());
		expect(of(s.run(2000), 'plank')).toHaveLength(0);
	});

	it('no plank goes back while someone stands in the doorway', () => {
		const s = setup({ plan: () => ['walker'], spawnIntervalScale: 1e9 }, [1, 2]);
		toWave(s, [1, 2]);
		s.run(1100);
		s.g.zombies.clear();
		s.g.spawnZombie('boss', { x: 0, y: 650, z: 0.25 });
		for (let i = 0; i < 40 && s.g.planks(0) > 0; i++) s.run(250);
		s.g.zombies.clear();
		s.g.spawnZombie('walker', { x: 0, y: -700, z: 0.25 }); // south door: keeps the wave going
		const inside = map.defense!.nav.nodes[map.defense!.openings[0]!.inside]!;
		s.place(1, { x: inside.x, y: inside.y, z: 0 });
		s.place(2, { x: 0, y: 528, z: 0 }); // in the north doorway
		s.g.act(1, { a: 'repair', on: true }, s.now());
		expect(of(s.run(1500), 'plank').filter((p) => p.opening === 0)).toHaveLength(0);
		s.place(2, { x: 0, y: 300, z: 0 });
		expect(of(s.run(700), 'plank').filter((p) => p.opening === 0).length).toBeGreaterThanOrEqual(1);
	});

	it('plank gold is capped per wave', () => {
		expect(ZD_GOLD.plankCapPerWave / ZD_GOLD.plank).toBe(12);
	});
});

describe('weapons', () => {
	function shoot(s: ReturnType<typeof setup>, from: Vec3, at: Vec3, weapon = 'pistol' as const) {
		const o = { x: from.x, y: from.y, z: from.z + VIEW_HEIGHT };
		return s.g.fire(1, { weapon, origin: o, dir: unit(at.x - o.x, at.y - o.y, at.z - o.z), tick: s.g.tick }, s.now());
	}

	it('pistol: 4 body hits kill a walker (10 gold); a headshot kills at once (15); bullets pass through planks', () => {
		const s = setup({ plan: () => ['walker'], spawnIntervalScale: 1e9 });
		toWave(s);
		s.run(1100);
		s.g.zombies.clear();
		const me = { x: 0, y: 300, z: 0 };
		s.place(1, me);
		// Outside the boarded north door, tearing at it.
		const z = s.g.spawnZombie('walker', { x: 0, y: 660, z: 0.25 })!;
		const gold0 = s.g.playerView(1)!.gold;
		let kills = 0;
		for (let i = 0; i < 4; i++) {
			s.run(200);
			const o = z.body.origin;
			const r = shoot(s, me, { x: o.x, y: o.y, z: o.z + 30 });
			expect(r.ok).toBe(true);
			kills += of(r.events, 'kill').length;
			if (i < 3) expect(of(r.events, 'hit')[0]).toMatchObject({ zid: z.id, kill: false, head: false });
		}
		expect(kills).toBe(1);
		expect(s.g.playerView(1)!.gold).toBe(gold0 + ZD_GOLD.kill);
		expect(s.g.playerView(1)!.kills).toBe(1);
		const z2 = s.g.spawnZombie('walker', { x: 30, y: 660, z: 0.25 })!;
		s.run(200);
		const h = z2.body.origin;
		const r = shoot(s, me, { x: h.x + 7.5 * Math.cos((z2.yaw * Math.PI) / 180), y: h.y + 7.5 * Math.sin((z2.yaw * Math.PI) / 180), z: h.z + 65 });
		expect(of(r.events, 'kill')[0]).toMatchObject({ head: true, gold: ZD_GOLD.headshotKill, kind: 'walker' });
	});

	it('brutes survive a pistol headshot (×3 damage instead)', () => {
		const s = setup({ plan: () => ['walker'], spawnIntervalScale: 1e9 });
		toWave(s);
		s.run(1100);
		s.g.zombies.clear();
		const me = { x: 0, y: 0, z: 0 };
		s.place(1, me);
		const z = s.g.spawnZombie('brute', { x: 300, y: 0, z: 0.25 })!;
		z.yaw = 180;
		const sc = ZD_ZOMBIES.brute.scale;
		const head = { x: 300 - 7.5 * sc, y: 0, z: 0.25 + 65 * sc };
		const r = shoot(s, me, head);
		expect(of(r.events, 'hit')[0]).toMatchObject({ head: true, kill: false });
		expect(z.hp).toBeCloseTo(z.maxHp - WEAPONS.pistol.damage * 3);
	});

	it('weapon swap keeps each weapon’s ammo; wrong weapon is rejected; bought weapons only', () => {
		const s = setup({ startGold: 2000 });
		expect(of(s.g.act(1, { a: 'weapon', weapon: 'smg' }, s.now()), 'result')[0]).toMatchObject({ ok: false, reason: 'not owned' });
		const buy = s.g.act(1, { a: 'buy', item: 'weapon:smg' }, s.now());
		expect(of(buy, 'result')[0]).toMatchObject({ ok: true, gold: 2000 - ZD_SHOP.weapons.smg });
		expect(of(buy, 'ammo')[0]).toMatchObject({ weapon: 'smg', mag: WEAPONS.smg.magazine });
		expect(s.g.playerView(1)!.weapons).toEqual(['pistol', 'smg']);
		expect(s.g.playerView(1)!.weapon).toBe('smg');
		s.run(1000);
		const me = map.spawns![0]!.pos;
		expect(shoot(s, me, { x: 1000, y: 1000, z: 40 }, 'smg' as never).ok).toBe(true);
		expect(s.g.weaponOf(1)!.mag).toBe(WEAPONS.smg.magazine - 1);
		s.g.act(1, { a: 'weapon', weapon: 'pistol' }, s.now());
		expect(shoot(s, me, { x: 1000, y: 1000, z: 40 }, 'smg' as never).reason).toBe('wrong weapon');
		s.g.act(1, { a: 'weapon', weapon: 'smg' }, s.now());
		expect(s.g.weaponOf(1)!.mag).toBe(WEAPONS.smg.magazine - 1);
	});

	it('shotgun: pellets add up per zombie', () => {
		const s = setup({ startGold: 2000, plan: () => ['walker'], spawnIntervalScale: 1e9 });
		s.g.act(1, { a: 'buy', item: 'weapon:striker' }, s.now());
		toWave(s);
		s.run(1100);
		s.g.zombies.clear();
		const me = { x: 0, y: 0, z: 0 };
		s.place(1, me);
		const z = s.g.spawnZombie('brute', { x: 120, y: 0, z: 0.25 })!;
		const r = shoot(s, me, { x: 120, y: 0, z: 40 }, 'striker' as never);
		expect(r.ok).toBe(true);
		expect(of(r.events, 'hit')).toHaveLength(1);
		expect(z.maxHp - z.hp).toBeGreaterThan(WEAPONS.striker.damage * 3);
		expect(of(r.events, 'shot')[0]!.pellets!.length).toBe((WEAPONS.striker.pellets! - 1) * 4);
	});
});

describe('shop', () => {
	it('upgrades, levels, ammo, repair all; only in the build phase', () => {
		const s = setup({ startGold: 10_000, plan: () => ['walker'] });
		const buy = (item: string) => of(s.g.act(1, { a: 'buy', item }, s.now()), 'result')[0]!;
		expect(buy('hp').ok).toBe(true);
		expect(s.g.playerView(1)).toMatchObject({ maxHp: 15, hp: 15, hpLevel: 1 });
		expect(buy('hp').ok).toBe(true);
		expect(buy('hp')).toMatchObject({ ok: false, reason: 'max level' });
		expect(buy('damage').ok).toBe(true);
		expect(buy('reload').ok).toBe(true);
		expect(buy('reload').ok).toBe(false);
		expect(buy('ammo')).toMatchObject({ ok: false, reason: 'full' });
		expect(buy('reinforce:north_door').ok).toBe(true);
		expect(buy('reinforce:north_door').ok).toBe(true);
		expect(buy('reinforce:north_door').reason).toBe('max level');
		expect(buy('reinforce:nope').reason).toBe('unknown opening');
		expect(buy('repairAll').reason).toBe('nothing to repair');
		expect(buy('bogus').reason).toBe('unknown item');
		expect(s.g.view(s.now()).openings[0]!.reinforce).toBe(2);
		const spent = 500 + 900 + 600 + 400 + 400 + 800;
		expect(s.g.playerView(1)!.gold).toBe(10_000 - spent);
		toWave(s);
		expect(buy('ammo').reason).toBe('not build phase');
	});

	it('ammo refills every owned weapon', () => {
		const s = setup({ startGold: 1000 });
		s.run(1000);
		const me = map.spawns![0]!.pos;
		s.g.fire(1, { weapon: 'pistol', origin: { x: me.x, y: me.y, z: me.z + VIEW_HEIGHT }, dir: { x: 1, y: 0, z: 0 }, tick: s.g.tick }, s.now());
		expect(s.g.weaponOf(1)!.mag).toBe(WEAPONS.pistol.magazine - 1);
		const r = s.g.act(1, { a: 'buy', item: 'ammo' }, s.now());
		expect(of(r, 'result')[0]!.ok).toBe(true);
		expect(s.g.weaponOf(1)!.mag).toBe(WEAPONS.pistol.magazine);
	});
});

describe('turrets', () => {
	function withTurret(type: 'sentry' | 'scatter' | 'mortar' | 'tesla' | 'frost', pad = 0) {
		const s = setup({ startGold: 10_000, plan: () => ['walker'], spawnIntervalScale: 1e9 });
		const p = map.defense!.pads[pad]!.pos;
		s.place(1, { x: p.x + 20, y: p.y, z: 0 });
		const r = s.g.act(1, { a: 'pad', pad, op: 'build', turret: type }, s.now());
		expect(of(r, 'result')[0]).toMatchObject({ ok: true });
		expect(of(r, 'turret')[0]).toMatchObject({ pad, type, level: 1, by: 1, op: 'build' });
		s.place(1, { x: 0, y: 0, z: 0 });
		toWave(s);
		s.run(1100);
		s.g.zombies.clear();
		return s;
	}

	it('build, upgrade (any player), sell (the builder) for half; only on the pad and in the build phase', () => {
		const s = setup({ startGold: 5000, plan: () => ['walker'] }, [1, 2]);
		const pad = map.defense!.pads[0]!.pos;
		const act = (id: number, op: 'build' | 'upgrade' | 'sell') =>
			of(s.g.act(id, { a: 'pad', pad: 0, op, turret: 'sentry' }, s.now()), 'result')[0]!;
		s.place(1, { x: 0, y: 0, z: 0 });
		expect(act(1, 'build').reason).toBe('too far');
		s.place(1, { x: pad.x, y: pad.y, z: 0 });
		s.place(2, { x: pad.x + 50, y: pad.y, z: 0 });
		expect(act(1, 'build').ok).toBe(true);
		expect(act(2, 'build').reason).toBe('occupied');
		expect(act(2, 'upgrade').ok).toBe(true);
		expect(act(2, 'upgrade').ok).toBe(true);
		expect(act(2, 'upgrade').reason).toBe('max level');
		expect(s.g.view(s.now()).pads[0]).toEqual({ type: 'sentry', level: 3, owner: 1 });
		expect(s.g.playerView(2)!.gold).toBe(5000 - zdTurretCost('sentry', 2) - zdTurretCost('sentry', 3));
		expect(act(2, 'sell').reason).toBe('not yours');
		const g1 = s.g.playerView(1)!.gold;
		expect(act(1, 'sell').ok).toBe(true);
		expect(s.g.playerView(1)!.gold).toBe(g1 + zdTurretRefund('sentry', 3));
		expect(s.g.view(s.now()).pads[0]).toEqual({ type: null, level: 0, owner: null });
		expect(of(s.g.act(1, { a: 'pad', pad: 9, op: 'build', turret: 'sentry' }, s.now()), 'result')[0]!.reason).toBe('unknown pad');
		toWave(s, [1, 2]);
		expect(act(1, 'build').reason).toBe('not build phase');
	});

	it('sentry shoots zombies in range and sight; kills pay its builder 5 gold', () => {
		const s = withTurret('sentry');
		const pad = map.defense!.pads[0]!.pos;
		s.g.spawnZombie('walker', { x: 0, y: 700, z: 0.25 }); // tears at the north door, out of the turret's sight: the wave goes on
		const gold0 = s.g.playerView(1)!.gold;
		s.place(1, { x: 0, y: -400, z: 0 });
		const z = s.g.spawnZombie('walker', { x: pad.x + 150, y: pad.y + 50, z: 0.25 })!;
		z.state = 'inside';
		let evs: ZdEvent[] = [];
		for (let i = 0; i < 40 && s.g.zombies.has(z.id); i++) {
			evs = evs.concat(s.run(50));
			if (s.g.zombies.has(z.id)) expect(s.g.snapshot().turrets[0]!.target === z.id || i < 2).toBe(true);
		}
		const kill = of(evs, 'kill')[0]!;
		expect(kill).toMatchObject({ by: 0, pad: 0, zid: z.id, gold: ZD_GOLD.turretKill });
		expect(s.g.playerView(1)!.gold).toBe(gold0 + ZD_GOLD.turretKill);
		expect(s.g.playerView(1)!.kills).toBe(0);
		// Out of range: ignored.
		const far = s.g.spawnZombie('walker', { x: -2000, y: -2000, z: 0.25 })!;
		s.run(500);
		expect(far.hp).toBe(far.maxHp);
	});

	it('mortar lobs a shell that splashes several zombies, not closer than its minimum range', () => {
		const s = withTurret('mortar');
		const pad = map.defense!.pads[0]!.pos;
		// Two brutes at the north door: one tears, the other waits its turn.
		const a = s.g.spawnZombie('brute', { x: -20, y: 650, z: 0.25 })!;
		const b = s.g.spawnZombie('brute', { x: 30, y: 690, z: 0.25 })!;
		let evs: ZdEvent[] = [];
		for (let i = 0; i < 40 && of(evs, 'boom').length === 0; i++) evs = evs.concat(s.run(100));
		expect(of(evs, 'shell')[0]).toMatchObject({ pad: 0 });
		expect(of(evs, 'boom')[0]!.r).toBe(ZD_TURRETS.mortar.levels[0].extra);
		expect(a.hp).toBeLessThan(a.maxHp);
		expect(b.hp).toBeLessThan(b.maxHp);
		s.g.zombies.clear();
		s.place(1, { x: pad.x + 30, y: pad.y, z: 0 });
		s.g.spawnZombie('walker', { x: pad.x + 100, y: pad.y, z: 0.25 })!.state = 'inside';
		evs = s.run(3000);
		expect(of(evs, 'shell')).toHaveLength(0);
	});

	it('tesla chains to up to 3 zombies', () => {
		const s = withTurret('tesla');
		const pad = map.defense!.pads[0]!.pos;
		s.place(1, { x: 0, y: -350, z: 0 });
		const zs = [0, 1, 2, 3].map((i) => s.g.spawnZombie('brute', { x: 150 + i * 100, y: 150, z: 0.25 })!);
		for (const z of zs) z.state = 'inside';
		let evs: ZdEvent[] = [];
		for (let i = 0; i < 30 && of(evs, 'arc').length === 0; i++) evs = evs.concat(s.run(100));
		const arc = of(evs, 'arc')[0]!;
		expect(arc.ids).toHaveLength(3);
		expect(arc.pts).toHaveLength(9);
		expect(zs.filter((z) => z.hp < z.maxHp)).toHaveLength(3);
	});

	it('frost slows zombies in range by 45 %', () => {
		const s = withTurret('frost');
		const pad = map.defense!.pads[0]!.pos;
		const z = s.g.spawnZombie('walker', { x: pad.x + 100, y: pad.y, z: 0.25 })!;
		s.place(1, { x: pad.x + 100, y: pad.y - 400, z: 0 });
		z.state = 'inside';
		s.run(1500);
		expect(s.g.zombieFlags(z) & ZDF_FROSTED).toBeTruthy();
		expect(z.frost).toBeCloseTo(0.55);
		const sp = Math.hypot(z.body.velocity.x, z.body.velocity.y);
		expect(sp).toBeLessThanOrEqual(ZD_ZOMBIES.walker.speed * 0.56 + 1);
		expect(sp).toBeGreaterThan(50);
	});
});

describe('players', () => {
	it('health regenerates after 6 s without damage', () => {
		const s = setup({ plan: () => ['walker'], spawnIntervalScale: 1e9 });
		toWave(s);
		s.run(1100);
		s.g.zombies.clear();
		const me = { x: 0, y: 0, z: 0 };
		s.place(1, me);
		const z = s.g.spawnZombie('walker', { x: 40, y: 0, z: 0.25 })!;
		z.state = 'inside';
		let hurt = 0;
		for (let i = 0; i < 40 && hurt === 0; i++) hurt = of(s.run(100), 'hurt').length;
		s.g.zombies.delete(z.id);
		s.g.spawnZombie('walker', { x: 0, y: 700, z: 0.25 }); // tears at the north door: the wave goes on
		const hp = s.g.playerView(1)!.hp;
		expect(hp).toBe(ZD_PLAYER_HP - 1);
		s.run(5500);
		expect(s.g.playerView(1)!.hp).toBe(hp);
		const evs = s.run(1000);
		expect(of(evs, 'heal')[0]).toMatchObject({ id: 1, hp: ZD_PLAYER_HP });
	});

	it('event routing', () => {
		expect(zdEventRoute({ e: 'result', id: 3, act: 'ready', ok: true, gold: 0 })).toEqual({ to: 3 });
		expect(zdEventRoute({ e: 'shot', by: 2, weapon: 'pistol', o: { x: 0, y: 0, z: 0 }, d: { x: 1, y: 0, z: 0 }, len: 1 })).toEqual({ except: 2 });
		expect(zdEventRoute({ e: 'hit', by: 2, zid: 1, head: false, kill: false })).toEqual({ to: 2 });
		expect(zdEventRoute({ e: 'plank', opening: 0, planks: 3, by: null })).toEqual({});
	});

	it('snapshot holds every zombie and every built turret', () => {
		const s = setup({ startGold: 5000, plan: () => ['walker'], spawnIntervalScale: 1e9 });
		const pad = map.defense!.pads[1]!.pos;
		s.place(1, { x: pad.x, y: pad.y, z: 0 });
		s.g.act(1, { a: 'pad', pad: 1, op: 'build', turret: 'frost' }, s.now());
		toWave(s);
		s.run(1100);
		const snap = s.g.snapshot();
		expect(snap.zombies).toHaveLength(1);
		expect(snap.zombies[0]).toMatchObject({ kind: 'walker', hp: 1 });
		expect(snap.turrets).toEqual([expect.objectContaining({ pad: 1 })]);
		const f = decodeDefense(encodeDefense(snap.tick, snap.zombies, snap.turrets))!;
		expect(f.zombies[0]!.id).toBe(snap.zombies[0]!.id);
	});
});

describe('tuning', () => {
	it('tearing is slower in waves 1 and 2', () => {
		expect(ZD_EARLY_TEAR[0]).toBe(2);
		expect(ZD_EARLY_TEAR[1]).toBe(1.5);
		const g = new DefenseGame({ map, world, cvars: mapCvars(map), now: T0 });
		const tear = (wave: number) => {
			(g as unknown as { wave: number }).wave = wave;
			return (g as unknown as { tearMs(z: { kind: string }, op: { reinforce: number }): number }).tearMs({ kind: 'walker' }, { reinforce: 0 });
		};
		expect(tear(1)).toBe(3000);
		expect(tear(2)).toBe(2250);
		expect(tear(3)).toBe(1500);
	});

	it('the pistol reserve is topped up at the start of each build phase', () => {
		const s = setup();
		const ws = (s.g as unknown as { players: Map<number, { weapons: Map<string, { reserve: number; def: { reserve: number } }> }> }).players.get(1)!.weapons.get('pistol')!;
		ws.reserve = 3;
		s.g.act(1, { a: 'ready' }, s.now());
		s.run(3000);
		expect(s.g.phase).toBe('build');
		expect(ws.reserve).toBe(ws.def.reserve);
		expect(s.events.some((e) => e.e === 'ammo' && e.reserve === ws.def.reserve)).toBe(true);
	});
});

