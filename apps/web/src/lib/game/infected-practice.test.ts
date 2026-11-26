/**
 * Practice range (infected-practice.ts) through the real `InfectedClient`:
 * offline, and online against the real shared rules while the server waits
 * for a second player. The avatars are the real `RemotePlayers` (node: a stub
 * `document` stands in for the name-tag canvas). `Math.random` is pinned to
 * 0, so a shot goes exactly where it is aimed and spawn picks are the first
 * of their pool.
 */
import {
	buildCollisionWorld,
	INF_AMMO,
	INF_INFECTED_HP,
	INF_PRESETS,
	INF_SECONDARY,
	INF_STEP_MS,
	InfectedGame,
	infEventRoute,
	playerPoint,
	VIEW_HEIGHT,
	WEAPONS,
	WeaponState,
	type ClientMessage,
	type InfEvent,
	type MapDef,
	type Spawn,
	type Vec3,
	type WeaponId
} from '@surf/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { animate, standing } from '../render/players-testkit.js';
import { HeldAssets } from '../render/character/held.js';
import type { CorpsePose } from '../render/infected-fx.js';
import type { InfectedRenderer } from '../render/infected.js';
import { HIT_FLASH_MS, RemotePlayers } from '../render/players.js';
import type { ZombieRenderer } from '../render/zombies.js';
import { RECOIL, recoilRestMs, SPREAD } from './gunfeel.js';
import {
	InfPractice,
	isPracticeId,
	nextPrimary,
	pickSpawn,
	PRACTICE_FIRST_ID,
	PRACTICE_MIN_DIST,
	PRACTICE_RESPAWN_MS,
	PRACTICE_TARGETS,
	practiceId,
	practiceRefill,
	type PracticeTarget
} from './infected-practice.js';
import { InfectedClient, type InfHost, type InfSound } from './infected.js';

/** The player stands on spawn 0; 1 and 2 are in one line with it; 4 is where a killed target can come back. */
const SPAWNS: Spawn[] = [
	{ pos: { x: 0, y: 0, z: 0.25 }, yaw: 0 },
	{ pos: { x: 400, y: 0, z: 0.25 }, yaw: 180 },
	{ pos: { x: 800, y: 0, z: 0.25 }, yaw: 180 },
	{ pos: { x: 0, y: 700, z: 0.25 }, yaw: 270 },
	{ pos: { x: -600, y: -600, z: 0.25 }, yaw: 0 }
];

type Brush = MapDef['brushes'][number];

/** Flat floor with `spawns`, plus `extra` brushes. */
function testMap(spawns: Spawn[] = SPAWNS, extra: Brush[] = []): MapDef {
	return {
		id: 'inf_practice_test',
		title: 'Test',
		kind: 'infected',
		difficulty: 'easy',
		layout: 'open',
		cvars: {},
		spawn: spawns[0]!,
		spawns,
		brushes: [{ type: 'box', min: { x: -1200, y: -1200, z: -64 }, max: { x: 1200, y: 1200, z: 0 }, material: 'm' }, ...extra],
		zones: [{ type: 'teleport', min: { x: -5000, y: -5000, z: -3000 }, max: { x: 5000, y: 5000, z: -500 }, to: 'start' }],
		theme: {
			skyTop: 0,
			skyHorizon: 0,
			skyBottom: 0,
			fogColor: 0,
			fogNear: 0,
			fogFar: 1,
			sunColor: 0,
			sunIntensity: 1,
			sunDir: { x: 0, y: 0, z: 1 },
			ambientSky: 0,
			ambientGround: 0,
			ambientIntensity: 1,
			materials: { m: { color: 0 } },
			effects: []
		}
	};
}

/** A wall across the line from spawn 0 to spawns 1 and 2. */
const WALL: Brush = { type: 'box', min: { x: 190, y: -150, z: 0 }, max: { x: 210, y: 150, z: 220 }, material: 'm' };

beforeAll(() => {
	// makeTag draws on a canvas; node has none. A context-less canvas keeps the real code path.
	vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
});
afterAll(() => {
	vi.unstubAllGlobals();
});
beforeEach(() => {
	vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
	vi.restoreAllMocks();
});

interface RigOpts {
	online?: boolean;
	map?: MapDef;
	selfId?: number;
	/** Without the avatars (a host that draws no players). */
	noPlayers?: boolean;
	send?: (msg: ClientMessage) => void;
}

/** One real client behind a recording host. */
function rig(opts: RigOpts = {}) {
	const map = opts.map ?? testMap();
	const world = buildCollisionWorld(map);
	const clock = { now: 1_000_000 };
	const origin: Vec3 = { ...map.spawn.pos };
	const sent: ClientMessage[] = [];
	const sounds: Array<{ name: InfSound; at?: Vec3 }> = [];
	const vm = { fired: 0, weapon: null as WeaponId | null, tracers: [] as Array<{ from: Vec3; to: Vec3 }> };
	const fx = { impacts: [] as Vec3[], corpses: [] as Array<{ pose: CorpsePose; look: string }>, turns: 0, clears: 0 };
	const cam = { pitch: 0, yaw: 0 };
	const players = opts.noPlayers ? null : new RemotePlayers(new HeldAssets());
	const zr = {
		setWeapon: (w: WeaponId | null) => void (vm.weapon = w),
		setOffhandKnife: () => {},
		thrown: () => {},
		fired: () => void vm.fired++,
		tracer: (from: Vec3, to: Vec3) => void vm.tracers.push({ from: { ...from }, to: { ...to } }),
		updateViewmodel: () => {},
		clear: () => {}
	} as unknown as ZombieRenderer;
	const ir = {
		syncKnives: () => {},
		syncBeacons: () => {},
		uavPulse: () => {},
		spark: () => {},
		clear: () => void fx.clears++,
		fx: {
			impact: (pos: Vec3) => void fx.impacts.push({ ...pos }),
			corpse: (pose: CorpsePose, look: string) => void fx.corpses.push({ pose: { ...pose }, look }),
			turn: () => void fx.turns++
		}
	} as unknown as InfectedRenderer;
	const host: InfHost = {
		online: () => opts.online ?? false,
		selfId: () => opts.selfId ?? (opts.online ? 1 : -1),
		send: (msg) => {
			sent.push(msg);
			opts.send?.(msg);
		},
		zombieRenderer: () => zr,
		infectedRenderer: () => ir,
		remotePlayers: () => players,
		name: (id) => `P${id}`,
		notice: () => {},
		teleport: (x, y, z) => {
			origin.x = x;
			origin.y = y;
			origin.z = z;
		},
		sound: (name, at) => void sounds.push({ name, at: at ? { ...at } : undefined }),
		setZoom: () => {},
		setViewKick: (pitch, yaw) => {
			cam.pitch = pitch;
			cam.yaw = yaw;
		},
		push: () => {},
		spawns: () => map.spawns ?? [map.spawn]
	};
	const c = new InfectedClient(host, clock.now, world);
	const eye = (): Vec3 => ({ x: origin.x, y: origin.y, z: origin.z + VIEW_HEIGHT });
	/** The point the last tick aimed at (kept between ticks). */
	let aim: Vec3 = { x: origin.x + 1000, y: origin.y, z: origin.z + VIEW_HEIGHT };
	/** One 64 Hz client tick aimed at `at` (default: the last aim point). */
	const tick = (at: Vec3 = aim) => {
		aim = at;
		clock.now += INF_STEP_MS;
		const e = eye();
		const dx = at.x - e.x;
		const dy = at.y - e.y;
		const dz = at.z - e.z;
		c.tick(clock.now, origin, e.z, (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, false);
	};
	const wait = (ms: number) => {
		const end = clock.now + ms;
		while (clock.now < end) tick();
	};
	const waitUntil = (time: number) => {
		while (clock.now < time) tick();
	};
	/**
	 * Pull the trigger once at `at`, then wait out the fire interval and the
	 * recoil: shots follow the kicked view, so the next one starts from rest
	 * again, on its aim point. Returns the time of the shot.
	 */
	const shoot = (at: Vec3): number => {
		const def = RECOIL[c.weapon];
		c.press('attack', true, clock.now);
		tick(at);
		const shotAt = clock.now;
		c.press('attack', false, clock.now);
		wait(WEAPONS[c.weapon].fireMs + 40);
		// The view kick is back on the aim point (recoilRestMs is the longest it can take).
		const rest = shotAt + (def ? recoilRestMs(def) : 0) + 40;
		while (clock.now < rest && (c.frame(clock.now, true, 0), cam.pitch !== 0 || cam.yaw !== 0)) tick();
		return shotAt;
	};
	/** Key `n`, then the draw. */
	const key = (n: number) => {
		c.slot(n, clock.now);
		wait((WEAPONS[c.weapon].deployMs ?? 0) + 20);
	};
	/** Walk (not teleport) to a spot: steps a run could make. */
	const walk = (x: number, y: number) => {
		const n = Math.max(1, Math.ceil(Math.hypot(x - origin.x, y - origin.y) / 50));
		const from = { x: origin.x, y: origin.y };
		for (let i = 1; i <= n; i++) {
			origin.x = from.x + ((x - from.x) * i) / n;
			origin.y = from.y + ((y - from.y) * i) / n;
			tick();
		}
	};
	const view = () => c.frame(clock.now, true, 0);
	const names = () => sounds.map((s) => s.name);
	const targetAt = (spawn: number): PracticeTarget => {
		const t = c.practiceTargets().find((q) => q.spawn === spawn);
		if (!t) throw new Error(`no target on spawn ${spawn}`);
		return t;
	};
	return { c, clock, origin, sent, sounds, names, vm, fx, cam, players, host, world, map, eye, tick, wait, waitUntil, walk, shoot, key, view, targetAt };
}

const chest = (t: PracticeTarget): Vec3 => playerPoint(t.pose, 'ribs');
const head = (t: PracticeTarget): Vec3 => playerPoint(t.pose, 'head');
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('pure helpers', () => {
	it('target ids never name a real player', () => {
		expect(practiceId(0)).toBe(PRACTICE_FIRST_ID);
		expect(practiceId(2)).toBe(PRACTICE_FIRST_ID - 2);
		for (let i = 0; i < PRACTICE_TARGETS; i++) expect(isPracticeId(practiceId(i))).toBe(true);
		// Server ids are 0 and up; -1 is the offline self.
		for (const id of [-1, 0, 1, 31, 255, 65535]) expect(isPracticeId(id)).toBe(false);
	});

	it('nextPrimary walks INF_PRESETS and wraps', () => {
		let w = INF_PRESETS[0]!;
		const seen: WeaponId[] = [];
		for (let i = 0; i < INF_PRESETS.length; i++) {
			w = nextPrimary(w);
			seen.push(w);
		}
		expect(seen).toEqual([...INF_PRESETS.slice(1), INF_PRESETS[0]]);
		expect(nextPrimary('pistol')).toBe(INF_PRESETS[0]);
	});

	it('practiceRefill gives a spent reserve back, and only then', () => {
		const ws = new WeaponState('smg');
		ws.mag = 3;
		ws.reserve = 1;
		expect(practiceRefill(ws)).toBe(false);
		ws.reserve = 0;
		expect(practiceRefill(ws)).toBe(true);
		expect(ws.reserve).toBe(INF_AMMO.smg!.reserve);
		expect(ws.mag).toBe(3);
		expect(practiceRefill(new WeaponState('knife'))).toBe(false);
	});

	it('pickSpawn: away from the player, free, not where the target died, in sight first', () => {
		const feet = SPAWNS[0]!.pos;
		const eye = { x: 0, y: 0, z: 64 };
		const free = () => false;
		// Spawn 0 is under the player: never picked while another is free.
		expect(pickSpawn(SPAWNS, free, -1, feet, eye, null, () => 0)).toBe(1);
		expect(pickSpawn(SPAWNS, free, -1, feet, eye, null, () => 0.999)).toBe(4);
		expect(pickSpawn(SPAWNS, (i) => i === 1, -1, feet, eye, null, () => 0)).toBe(2);
		expect(pickSpawn(SPAWNS, free, 1, feet, eye, null, () => 0)).toBe(2);
		// Behind the wall: spawns 1 and 2 are out of sight, so 3 comes first.
		const walled = buildCollisionWorld(testMap(SPAWNS, [WALL]));
		expect(pickSpawn(SPAWNS, free, -1, feet, eye, walled, () => 0)).toBe(3);
		// Only hidden spawns left: one of them.
		expect(pickSpawn(SPAWNS, (i) => i >= 3, -1, feet, eye, walled, () => 0)).toBe(1);
		// Nothing far enough: the farthest free one. Nothing free: -1.
		const near: Spawn[] = [SPAWNS[0]!, { pos: { x: 100, y: 0, z: 0.25 }, yaw: 0 }, { pos: { x: 0, y: PRACTICE_MIN_DIST - 1, z: 0.25 }, yaw: 0 }];
		expect(pickSpawn(near, free, -1, feet, eye, null, () => 0)).toBe(2);
		expect(pickSpawn(near, () => true, -1, feet, eye, null, () => 0)).toBe(-1);
	});
});

describe('practice range offline (P1, P2)', () => {
	it('opens on the first tick with targets at map spawns away from the player', () => {
		const r = rig();
		expect(r.c.practicing).toBe(false);
		expect(r.view().practice).toBe(false);
		r.tick();
		expect(r.c.practicing).toBe(true);
		expect(r.view()).toMatchObject({ phase: 'solo', practice: true });
		const ts = r.c.practiceTargets();
		expect(ts).toHaveLength(PRACTICE_TARGETS);
		expect(ts.map((t) => t.spawn)).toEqual([1, 2, 3]);
		for (const t of ts) {
			expect(isPracticeId(t.id)).toBe(true);
			expect(t).toMatchObject({ alive: true, hp: INF_INFECTED_HP });
			expect(t.pose).toMatchObject({ ...SPAWNS[t.spawn]!.pos, ducked: false });
			expect(dist(t.pose, r.origin)).toBeGreaterThanOrEqual(PRACTICE_MIN_DIST);
		}
		// They face the player.
		expect(r.targetAt(1).pose.yaw).toBeCloseTo(180, 6);
		expect(r.targetAt(3).pose.yaw).toBeCloseTo(-90, 6);
	});

	it('every gun fires with sound, tracers, impacts, recoil and spread, and nothing is sent', () => {
		const r = rig();
		r.tick();
		const floor: Vec3 = { x: 300, y: -300, z: 0 };
		const guns: WeaponId[] = [];
		const tryGun = () => {
			const w = r.c.weapon;
			guns.push(w);
			const before = { fired: r.vm.fired, tracers: r.vm.tracers.length, impacts: r.fx.impacts.length, mag: r.view().mag, spread: r.view().spreadDeg! };
			r.sounds.length = 0;
			r.c.press('attack', true, r.clock.now);
			r.tick(floor);
			r.c.press('attack', false, r.clock.now);
			const v = r.view();
			// The camera kicks over the next frames; the spread blooms at once.
			r.wait(40);
			r.view();
			expect(Math.hypot(r.cam.pitch, r.cam.yaw), w).toBeGreaterThan(0);
			expect(r.vm.fired, w).toBe(before.fired + 1);
			expect(r.names(), w).toContain(`shot-${w}`);
			expect(r.names(), w).toContain('impact');
			expect(v.mag, w).toBe(before.mag - 1);
			// One tracer per pellet drawn, each ending on the floor with an impact.
			const drawn = r.vm.tracers.length - before.tracers;
			expect(drawn, w).toBe(w === 'striker' ? 8 : 1);
			expect(r.fx.impacts.length - before.impacts, w).toBe(drawn);
			expect(r.vm.tracers.at(-1)!.to.z, w).toBeCloseTo(0, 0);
			// The hip cone grows with the shot (the shotgun's does not).
			if (SPREAD[w]!.fire > 0) expect(v.spreadDeg!, w).toBeGreaterThan(before.spread);
			else expect(v.spreadDeg!, w).toBe(before.spread);
			r.wait(1500);
		};
		tryGun();
		for (let i = 1; i < INF_PRESETS.length; i++) {
			r.key(4);
			tryGun();
		}
		r.key(2);
		tryGun();
		expect(guns).toEqual([...INF_PRESETS, INF_SECONDARY]);
		// The knife swings (no ammo, no tracer).
		r.key(3);
		const fired = r.vm.fired;
		r.c.press('attack', true, r.clock.now);
		r.tick(floor);
		r.c.press('attack', false, r.clock.now);
		expect(r.vm.fired).toBe(fired + 1);
		expect(r.names()).toContain('knife');
		expect(r.sent).toEqual([]);
	});

	it('scope and reload work as in a round', () => {
		const r = rig();
		r.tick();
		expect(r.c.weapon).toBe('barrett');
		r.c.press('attack2', true, r.clock.now);
		expect(r.view().scoped).toBe(true);
		r.shoot({ x: 300, y: -300, z: 0 });
		expect(r.view()).toMatchObject({ scoped: true, mag: 9 });
		r.c.reload(r.clock.now);
		expect(r.view().reloadEndsAt).toBeGreaterThan(r.clock.now);
		expect(r.view().scoped).toBe(false);
		r.wait(WEAPONS.barrett.reloadMs + 50);
		expect(r.view()).toMatchObject({ mag: 10, reserve: INF_AMMO.barrett!.reserve - 1, reloadEndsAt: 0 });
		expect(r.names()).toEqual(expect.arrayContaining(['scope', 'handle', 'magOut', 'magIn']));
		expect(r.sent).toEqual([]);
	});

	it('body hits add up to the infected hit points; a headshot kills', () => {
		const r = rig();
		r.tick();
		// Light machine gun: 1 damage, 5 body hits.
		r.key(4);
		r.key(4);
		expect(r.c.weapon).toBe('lmg');
		const a = r.targetAt(1);
		for (let i = 1; i <= INF_INFECTED_HP; i++) {
			expect(a.alive).toBe(true);
			r.sounds.length = 0;
			r.shoot(chest(a));
			expect(a.hp).toBe(INF_INFECTED_HP - i);
			expect(r.names()).toContain(i < INF_INFECTED_HP ? 'hit' : 'hitKill');
		}
		expect(a.alive).toBe(false);
		// Pistol: 2 damage, 3 body hits.
		r.key(2);
		const b = r.targetAt(2);
		r.shoot(chest(b));
		r.shoot(chest(b));
		expect(b).toMatchObject({ hp: 1, alive: true });
		expect(r.view().hitMarker).toMatchObject({ head: false, kill: false });
		r.shoot(chest(b));
		expect(b.alive).toBe(false);
		expect(r.view().hitMarker).toMatchObject({ head: false, kill: true });
		// Pistol, one headshot.
		const d = r.targetAt(3);
		r.sounds.length = 0;
		r.shoot(head(d));
		expect(d).toMatchObject({ hp: 0, alive: false });
		expect(r.view().hitMarker).toMatchObject({ head: true, kill: true });
		expect(r.names()).toEqual(expect.arrayContaining(['hitKill', 'death']));
		// No score, no kill feed, no streak, no round summary.
		expect(r.view()).toMatchObject({ killFeed: [], myScore: 0, myKills: 0, streak: 0, summary: null });
		expect(r.view().scorePops ?? []).toEqual([]);
		expect(r.sent).toEqual([]);
	});

	it('a hit flashes the avatar; a kill drops a corpse where it stood and hides it until it respawns elsewhere', () => {
		const r = rig();
		r.tick();
		r.view();
		const p = r.players!;
		const t = r.targetAt(1);
		const pose = standing(0, 0, 0);
		expect(p.pose(t.id, pose)).toBe(true);
		expect(pose).toMatchObject({ x: 400, y: 0, z: 0.25 });
		expect(p.feedback(t.id)).toMatchObject({ held: 'claws', flashing: false });
		r.key(2);
		r.shoot(chest(t));
		expect(p.feedback(t.id)!.flashing).toBe(true);
		animate(p, r.clock.now + HIT_FLASH_MS + 1);
		expect(p.feedback(t.id)!.flashing).toBe(false);
		expect(r.fx.corpses).toEqual([]);
		const died = r.shoot(head(t));
		// Down at once: the corpse stands in for the avatar.
		expect(p.pose(t.id, pose)).toBe(false);
		expect(r.fx.corpses).toHaveLength(1);
		expect(r.fx.corpses[0]).toMatchObject({ look: 'infected', pose: { x: 400, y: 0, z: 0.25 } });
		// It falls away from the shooter (+x).
		expect(r.fx.corpses[0]!.pose.fx).toBeGreaterThan(0);
		expect(t.respawnAt).toBe(died + PRACTICE_RESPAWN_MS);
		r.waitUntil(died + PRACTICE_RESPAWN_MS - 100);
		r.view();
		expect(t.alive).toBe(false);
		expect(p.pose(t.id, pose)).toBe(false);
		r.wait(200);
		r.view();
		expect(t).toMatchObject({ alive: true, hp: INF_INFECTED_HP, spawn: 4 });
		expect(p.pose(t.id, pose)).toBe(true);
		expect(pose).toMatchObject({ x: -600, y: -600, z: 0.25 });
		// Still one avatar per target.
		expect([...p.ids()].sort()).toEqual(r.c.practiceTargets().map((q) => q.id).sort());
	});

	it('the map stops bullets', () => {
		const r = rig({ map: testMap(SPAWNS, [WALL]) });
		r.tick();
		// In sight first: spawns 3 and 4; the third target is behind the wall.
		expect(r.c.practiceTargets().map((t) => t.spawn)).toEqual([3, 4, 1]);
		const t = r.targetAt(1);
		r.shoot(chest(t));
		expect(t.hp).toBe(INF_INFECTED_HP);
		expect(r.view().hitMarker).toBeNull();
		expect(r.vm.tracers.at(-1)!.to.x).toBeCloseTo(190, 0);
		// From beside the wall the same target is hit.
		r.walk(0, 400);
		r.shoot(chest(t));
		expect(t.alive).toBe(false);
	});

	it('a knife swing needs a clear line to the target', () => {
		// A thin wall right in front of the target on spawn 1.
		const r = rig({ map: testMap(SPAWNS, [{ type: 'box', min: { x: 368, y: -150, z: 0 }, max: { x: 372, y: 150, z: 220 }, material: 'm' }]) });
		r.tick();
		const t = r.targetAt(1);
		r.key(3);
		r.walk(350, 0);
		r.shoot(chest(t));
		expect(t.alive).toBe(true);
		// Around the wall to the open side. Out of reach: nothing; in reach: one hit kills.
		r.walk(350, 300);
		r.walk(520, 300);
		r.walk(520, 0);
		r.shoot(chest(t));
		expect(t.alive).toBe(true);
		r.walk(440, 0);
		r.shoot(chest(t));
		expect(t).toMatchObject({ alive: false, hp: 0, spawn: 1 });
	});

	it('piercing weapons pierce; other bullets stop in the first target', () => {
		const r = rig();
		r.tick();
		const near = r.targetAt(1);
		const far = r.targetAt(2);
		// Pistol: the far target in line is shielded by the near one.
		r.key(2);
		r.shoot(chest(far));
		expect(near.hp).toBe(INF_INFECTED_HP - WEAPONS.pistol.damage);
		expect(far.hp).toBe(INF_INFECTED_HP);
		// .50 cal rifle: one bullet through both.
		r.key(1);
		r.sounds.length = 0;
		r.shoot(chest(far));
		expect(near.alive).toBe(false);
		expect(far.alive).toBe(false);
		expect(r.names().filter((n) => n === 'hitKill')).toHaveLength(2);
		expect(r.fx.corpses).toHaveLength(2);
	});

	it('shotgun: every pellet is resolved', () => {
		const r = rig();
		r.tick();
		r.key(4);
		expect(r.c.weapon).toBe('striker');
		// Random pinned to 0 puts all 8 pellets on the aim point: 8 damage in one pull.
		const t = r.targetAt(1);
		r.c.press('attack', true, r.clock.now);
		r.tick(chest(t));
		r.c.press('attack', false, r.clock.now);
		expect(t).toMatchObject({ alive: false, hp: 0 });
		expect(r.view().hitMarker).toMatchObject({ kill: true });
	});

	it('shotgun pellets scatter: at range only some of them hit', () => {
		const r = rig();
		// The real spread: a fixed sequence instead of the pinned 0.
		let seed = 7;
		const rng = () => {
			seed = (seed * 16807) % 2147483647;
			return seed / 2147483647;
		};
		const p = new InfPractice(r.host, r.world, rng);
		const eye = r.eye();
		p.start(0, r.origin, eye);
		const t = p.targets().find((q) => q.spawn === 2)!;
		const to = chest(t);
		const len = dist(eye, to);
		const dir = { x: (to.x - eye.x) / len, y: (to.y - eye.y) / len, z: (to.z - eye.z) / len };
		// The target on spawn 1 stands in the line of fire: kill it first (one pull up close does).
		const first = p.targets().find((q) => q.spawn === 1)!;
		const c1 = chest(first);
		expect(p.shot(0, { x: 340, y: 0, z: c1.z }, { x: 1, y: 0, z: 0 }, 'striker', 0, -1)).toMatchObject({ kill: true });
		const hit = p.shot(0, eye, dir, 'striker', WEAPONS.striker.pelletSpread!, -1);
		expect(hit).not.toBeNull();
		const lost = INF_INFECTED_HP - t.hp;
		// 800 units out a 4 degree cone is far wider than the target: the centre pellet hits, most miss.
		expect(lost).toBeGreaterThanOrEqual(1);
		expect(lost).toBeLessThan(WEAPONS.striker.pellets!);
	});

	it('a spent reserve refills, so practice never dead-ends', () => {
		const r = rig();
		r.tick();
		for (let i = 0; i < 3; i++) r.key(4);
		expect(r.c.weapon).toBe('smg');
		const a = INF_AMMO.smg!;
		expect(r.view()).toMatchObject({ mag: a.mag, reserve: a.reserve });
		// Hold the trigger through both reloads: 36 + 72 rounds, then the reserve is fresh.
		r.c.press('attack', true, r.clock.now);
		let empties = 0;
		let shots = 0;
		let mag = a.mag;
		const sky: Vec3 = { x: 0, y: 0, z: 5000 };
		for (let i = 0; i < 64 * 30 && shots < a.mag + a.reserve + 10; i++) {
			r.tick(sky);
			const v = r.view();
			if (v.mag < mag) shots += mag - v.mag;
			mag = v.mag;
			if (v.mag + v.reserve === 0) empties++;
			expect(v.reserve === 0 && v.reloadEndsAt === 0 && v.mag > 0, `tick ${i}`).toBe(false);
		}
		r.c.press('attack', false, r.clock.now);
		expect(shots).toBe(a.mag + a.reserve + 10);
		expect(empties).toBe(0);
		expect(r.names()).not.toContain('dryfire');
		expect(r.view().scavengerAt).toBeGreaterThan(0);
		expect(r.sent).toEqual([]);
	});

	it('key 4 cycles the primary through the presets with fresh ammo and a draw', () => {
		const r = rig();
		r.tick();
		expect(r.view()).toMatchObject({ weapon: 'barrett', loadout: 'barrett', loadoutLabel: WEAPONS.barrett.label });
		const seen: WeaponId[] = [];
		for (let i = 0; i < INF_PRESETS.length; i++) {
			r.sounds.length = 0;
			expect(r.c.slot(4, r.clock.now)).toBe(true);
			const w = r.c.weapon;
			seen.push(w);
			const a = INF_AMMO[w]!;
			expect(r.view()).toMatchObject({ weapon: w, loadout: w, loadoutLabel: WEAPONS[w].label, mag: a.mag, reserve: a.reserve });
			expect(r.vm.weapon).toBe(w);
			expect(r.names()).toContain('draw');
			// No shot before the weapon is drawn; the held trigger fires when it is.
			const fired = r.vm.fired;
			r.c.press('attack', true, r.clock.now);
			r.wait(WEAPONS[w].deployMs! - 40);
			expect(r.vm.fired, w).toBe(fired);
			r.wait(80);
			expect(r.vm.fired, w).toBe(fired + 1);
			r.c.press('attack', false, r.clock.now);
			r.wait(WEAPONS[w].fireMs + 20);
		}
		expect(seen).toEqual([...INF_PRESETS.slice(1), INF_PRESETS[0]]);
		// From the pistol, 4 brings up the next primary; a scope comes down.
		r.c.press('attack2', true, r.clock.now);
		expect(r.view().scoped).toBe(true);
		r.c.slot(4, r.clock.now);
		expect(r.view()).toMatchObject({ weapon: 'striker', scoped: false });
		r.key(2);
		expect(r.c.weapon).toBe('pistol');
		r.c.slot(4, r.clock.now);
		expect(r.c.weapon).toBe('lmg');
		expect(r.view().secondary).toBe('pistol');
		expect(r.sent).toEqual([]);
	});

	it('teleported onto a target (fall-out, !r): the target makes room; walking into one does not move it', () => {
		const r = rig();
		r.tick();
		const t = r.targetAt(1);
		// Walking up to it and through it.
		r.walk(400, 0);
		r.walk(430, 0);
		expect(t.spawn).toBe(1);
		// Thrown back to spawn 0, then put on the target on spawn 2.
		r.origin.x = 0;
		r.tick();
		expect(t.spawn).toBe(1);
		const far = r.targetAt(2);
		r.origin.x = 800;
		r.tick();
		expect(far).toMatchObject({ alive: true, hp: INF_INFECTED_HP });
		expect(far.spawn).not.toBe(2);
		for (const q of r.c.practiceTargets()) expect(Math.hypot(q.pose.x - r.origin.x, q.pose.y - r.origin.y)).toBeGreaterThanOrEqual(PRACTICE_MIN_DIST);
		expect(new Set(r.c.practiceTargets().map((q) => q.spawn)).size).toBe(PRACTICE_TARGETS);
	});

	it('a map with a single spawn has no targets and still fires', () => {
		const r = rig({ map: testMap([SPAWNS[0]!]) });
		r.tick();
		expect(r.c.practicing).toBe(true);
		expect(r.c.practiceTargets()).toEqual([]);
		r.shoot({ x: 300, y: 0, z: 0 });
		expect(r.vm.fired).toBe(1);
		expect(r.view()).toMatchObject({ practice: true, hitMarker: null });
	});

	it('a host without avatars still resolves hits', () => {
		const r = rig({ noPlayers: true });
		r.tick();
		r.view();
		const t = r.targetAt(1);
		r.shoot(chest(t));
		expect(t.alive).toBe(false);
		expect(r.names()).toEqual(expect.arrayContaining(['hitKill', 'death']));
	});

	it('hidden players (cl_hideplayers): the targets cannot be hit', () => {
		const r = rig();
		r.tick();
		r.view();
		r.players!.setHidden(true);
		const t = r.targetAt(1);
		r.shoot(chest(t));
		expect(t.hp).toBe(INF_INFECTED_HP);
		r.players!.setHidden(false);
		r.shoot(chest(t));
		expect(t.alive).toBe(false);
	});

	it('avatars cleared by a map load come back; dispose removes them', () => {
		const r = rig();
		r.tick();
		r.view();
		const ids = r.c.practiceTargets().map((t) => t.id).sort();
		expect([...r.players!.ids()].sort()).toEqual(ids);
		r.players!.clear();
		r.view();
		expect([...r.players!.ids()].sort()).toEqual(ids);
		r.c.dispose();
		expect([...r.players!.ids()]).toEqual([]);
		expect(r.c.practicing).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Online, against the real shared rules.

interface NetOpts {
	/** Round preset of the first round (default 'lmg'). */
	loadout?: WeaponId;
}

/** Player 1 runs the client; the game is `lenient` like the server. Alone, so the server waits. */
function net(opts: NetOpts = {}) {
	const map = testMap();
	const game = new InfectedGame({ map, world: buildCollisionWorld(map), now: 1_000_000, rng: () => 0, graceSecs: 1, endSecs: 1, lenient: true });
	const first = INF_PRESETS.indexOf(opts.loadout ?? 'lmg');
	if (first < 0) throw new Error('not a preset');
	game.round = first;
	/** Results of the `fire` messages that reached the game. */
	const fires: Array<{ ok: boolean; reason?: string }> = [];
	const route = (events: InfEvent[]) => {
		for (const ev of events) {
			const to = infEventRoute(ev);
			if (to.to !== undefined && to.to !== 1) continue;
			if (to.except === 1) continue;
			r.c.onEvent(ev, r.clock.now);
		}
	};
	const r = rig({
		online: true,
		map,
		send: (msg) => {
			const now = r.clock.now;
			if (msg.type === 'fire') {
				const res = game.fire(1, { weapon: msg.weapon, origin: msg.origin, dir: msg.dir, tick: msg.tick }, now);
				fires.push({ ok: res.ok, reason: res.reason });
				route(res.events);
			} else if (msg.type === 'loadout') route(game.selectWeapon(1, msg.weapon, now));
			else if (msg.type === 'reload') game.reload(1, now);
		}
	});
	const state = () => r.c.onModeState(game.view(r.clock.now), r.clock.now);
	/** One step: the server tick, then the client tick. */
	const step = (at?: Vec3) => {
		r.clock.now += INF_STEP_MS;
		route(game.update(r.clock.now));
		game.setPlayerPos(1, { x: r.origin.x, y: r.origin.y, z: r.origin.z, ducked: false, yaw: 0 });
		r.clock.now -= INF_STEP_MS;
		r.tick(at);
	};
	/** Steps with the mode state before and after, as the server sends it. */
	const run = (ms: number, at?: Vec3) => {
		state();
		const end = r.clock.now + ms;
		while (r.clock.now < end) step(at);
		state();
	};
	const join = (ids: number[]) => {
		game.syncPlayers(ids, r.clock.now);
		for (const id of ids) if (id !== 1) game.setPlayerPos(id, { x: -900, y: 900, z: 0.25, ducked: false, yaw: 0 });
	};
	join([1]);
	return { ...r, game, fires, state, step, run, join };
}

describe('practice range online while waiting (P1, P3, P4, P5)', () => {
	it('starts once the server says it waits, and sends nothing for shots, reloads or swaps', () => {
		const n = net();
		// Before the first state the phase is only the client's guess: no practice, no shots.
		n.c.press('attack', true, n.clock.now);
		n.tick();
		n.c.press('attack', false, n.clock.now);
		expect(n.c.practicing).toBe(false);
		expect(n.vm.fired).toBe(0);
		expect(n.view().practice).toBe(false);
		n.run(100);
		expect(n.game.phase).toBe('waiting');
		expect(n.c.practicing).toBe(true);
		expect(n.view()).toMatchObject({ phase: 'waiting', practice: true, weapon: 'barrett' });
		expect(n.c.practiceTargets()).toHaveLength(PRACTICE_TARGETS);
		const before = n.sent.length;
		const server = { mag: n.game.primaryOf(1)!.mag, reserve: n.game.primaryOf(1)!.reserve };
		const t = n.c.practiceTargets()[0]!;
		n.shoot(chest(t));
		expect(t.alive).toBe(false);
		expect(n.view().mag).toBe(INF_AMMO.barrett!.mag - 1);
		n.c.reload(n.clock.now);
		n.key(2);
		n.shoot({ x: 300, y: 300, z: 0 });
		n.key(4);
		n.key(3);
		n.shoot({ x: 300, y: 300, z: 0 });
		expect(n.sent.slice(before)).toEqual([]);
		expect(n.fires).toEqual([]);
		// The server never heard of any of it.
		expect(n.game.weaponOf(1)!.weapon).toBe('barrett');
		expect(n.game.primaryOf(1)).toMatchObject(server);
	});

	const STATES = ['fresh', 'pistol held', 'primary cycled', 'mid-reload', 'scoped', 'trigger held', 'knife held'] as const;

	for (const loadout of ['lmg', 'barrett'] as const) {
		for (const was of STATES) {
			it(`grace (${loadout}) after practice "${was}": targets gone, the server's guns, the first real shot is accepted`, () => {
				const n = net({ loadout });
				n.run(100);
				expect(n.c.practicing).toBe(true);
				const sky: Vec3 = { x: 0, y: 0, z: 5000 };
				// Use the practice guns: spend rounds from both, kill a target.
				n.shoot(chest(n.c.practiceTargets()[0]!));
				n.shoot(sky);
				n.key(2);
				n.shoot(sky);
				n.key(1);
				if (was === 'pistol held') n.key(2);
				else if (was === 'knife held') n.key(3);
				else if (was === 'primary cycled') n.key(4);
				else if (was === 'mid-reload') {
					n.c.reload(n.clock.now);
					expect(n.view().reloadEndsAt).toBeGreaterThan(0);
				} else if (was === 'scoped') {
					n.c.press('attack2', true, n.clock.now);
					expect(n.view().scoped).toBe(true);
				} else if (was === 'trigger held') {
					for (let i = 0; i < 2; i++) n.key(4);
					expect(n.c.weapon).toBe('lmg');
					n.c.press('attack', true, n.clock.now);
					n.run(300, sky);
				}
				expect(n.sent).toEqual([]);
				const ids = n.c.practiceTargets().map((t) => t.id);
				n.view();
				expect([...n.players!.ids()].sort()).toEqual([...ids].sort());

				// A second player joins: the server starts the grace period on its next tick.
				n.join([1, 2]);
				n.step(sky);
				expect(n.game.phase).toBe('grace');
				expect(n.c.practicing).toBe(false);
				expect(n.c.practiceTargets()).toEqual([]);
				expect([...n.players!.ids()]).toEqual([]);
				const prim = n.game.primaryOf(1)!;
				const sec = n.game.secondaryOf(1)!;
				const held = was === 'trigger held' && loadout === 'lmg';
				// A held trigger already fired its first real shot in that tick.
				const v = n.view();
				expect(v).toMatchObject({
					phase: 'grace',
					practice: false,
					weapon: loadout,
					loadout,
					loadoutLabel: WEAPONS[loadout].label,
					mag: prim.mag,
					reserve: prim.reserve,
					reloadEndsAt: 0,
					scoped: false,
					hitMarker: null,
					scavengerAt: 0
				});
				expect(prim.mag).toBe(INF_AMMO[loadout]!.mag - (held ? 1 : 0));
				expect(prim.reserve).toBe(INF_AMMO[loadout]!.reserve);
				expect(v.slotAmmo).toEqual([prim.mag + prim.reserve, sec.mag + sec.reserve]);
				expect(sec.mag).toBe(INF_AMMO.pistol!.mag);
				expect(n.game.weaponOf(1)!.weapon).toBe(loadout);
				if (held) expect(n.fires).toEqual([{ ok: true, reason: undefined }]);
				else {
					expect(n.fires).toEqual([]);
					n.c.press('attack', false, n.clock.now);
					n.c.press('attack', true, n.clock.now);
					n.step(sky);
					n.c.press('attack', false, n.clock.now);
					expect(n.fires).toEqual([{ ok: true, reason: undefined }]);
				}
				expect(n.sent.filter((m) => m.type === 'fire')).toHaveLength(1);
				expect(n.view().mag).toBe(n.game.primaryOf(1)!.mag);
				expect(n.game.primaryOf(1)!.mag).toBe(INF_AMMO[loadout]!.mag - 1);
				// Swaps and reloads go to the server again.
				n.c.press('attack', false, n.clock.now);
				n.run(700, sky);
				n.c.slot(2, n.clock.now);
				expect(n.sent.at(-1)).toEqual({ type: 'loadout', weapon: 'pistol' });
				expect(n.game.weaponOf(1)!.weapon).toBe('pistol');
				// Key 4 is the M.O.A.B. key again: nothing to call, nothing cycles.
				n.c.slot(4, n.clock.now);
				expect(n.c.weapon).toBe('pistol');
				expect(n.view().loadout).toBe(loadout);
			});
		}
	}

	it('a missed phase event: the state alone ends the practice before it applies', () => {
		const n = net();
		n.run(100);
		n.key(4);
		n.key(2);
		expect(n.c.practicing).toBe(true);
		n.join([1, 2]);
		n.clock.now += INF_STEP_MS;
		// The events of this update are lost; only the state arrives.
		n.game.update(n.clock.now);
		n.state();
		expect(n.c.practicing).toBe(false);
		expect(n.c.practiceTargets()).toEqual([]);
		expect(n.view()).toMatchObject({ phase: 'grace', practice: false, weapon: 'lmg', loadout: 'lmg', mag: INF_AMMO.lmg!.mag, reserve: INF_AMMO.lmg!.reserve });
		expect([...n.players!.ids()]).toEqual([]);
	});

	it('a joining second player is never a target, replaced by one or hidden by one (P4)', () => {
		const n = net();
		n.run(100);
		n.view();
		const p = n.players!;
		const targets = n.c.practiceTargets().map((t) => t.id).sort();
		expect(targets).toHaveLength(PRACTICE_TARGETS);
		// game.ts on `join`: the new player's avatar, posed from its snapshots.
		const pose = standing(0, 0, 0);
		const drawJoiner = () => {
			if (!p.has(2)) p.upsert(2, 'P2');
			p.setPose(2, standing(400, 0, 0.25, 90), true);
			p.setInfected(2, n.c.roleOf(2));
		};
		drawJoiner();
		// The joiner stands exactly where a target does: still its own avatar, and the target stays a target.
		n.view();
		expect([...p.ids()].sort()).toEqual([...targets, 2].sort());
		expect(targets.includes(2)).toBe(false);
		expect(p.pose(2, pose)).toBe(true);
		expect(pose).toMatchObject({ x: 400, y: 0, z: 0.25, yaw: 90 });
		// My shots still land on the target, not on the joiner's avatar.
		const t = n.targetAt(1);
		n.key(2);
		n.shoot(chest(t));
		expect(p.feedback(t.id)!.flashing).toBe(true);
		expect(p.feedback(2)!.flashing).toBe(false);
		// The server takes the joiner in: grace starts, the targets go, the joiner stays.
		n.join([1, 2]);
		n.step();
		n.state();
		drawJoiner();
		n.view();
		expect(n.game.phase).toBe('grace');
		expect([...p.ids()]).toEqual([2]);
		expect(p.pose(2, pose)).toBe(true);
		expect(pose).toMatchObject({ x: 400, y: 0, z: 0.25, yaw: 90 });
		expect(p.feedback(2)).toMatchObject({ held: 'lmg', flashing: false });
		expect(n.fx.clears).toBeGreaterThan(0);
	});

	it('back to waiting when the second player leaves: the practice opens again', () => {
		const n = net();
		n.run(100);
		n.join([1, 2]);
		n.run(1500);
		expect(n.game.phase).toBe('playing');
		expect(n.view().practice).toBe(false);
		expect(n.c.practicing).toBe(false);
		n.join([1]);
		n.run(100);
		expect(n.game.phase).toBe('waiting');
		expect(n.c.practicing).toBe(true);
		expect(n.view()).toMatchObject({ phase: 'waiting', practice: true, team: 'survivor' });
		expect(n.c.practiceTargets()).toHaveLength(PRACTICE_TARGETS);
		const fires = n.fires.length;
		n.shoot(chest(n.c.practiceTargets()[0]!));
		expect(n.fires).toHaveLength(fires);
	});

	it('the practice flag follows the phase (P5)', () => {
		const n = net();
		n.run(100);
		expect(n.view().practice).toBe(true);
		n.join([1, 2]);
		n.run(200);
		expect(n.view()).toMatchObject({ phase: 'grace', practice: false });
		n.run(1200);
		expect(n.view()).toMatchObject({ phase: 'playing', practice: false });
		// Player 1 is Patient Zero (rng 0): claws its way to the end of the round.
		n.join([1]);
		n.run(100);
		expect(n.view()).toMatchObject({ phase: 'waiting', practice: true });
	});

	it('no practice while spectating', () => {
		const n = net();
		n.run(100);
		n.view();
		expect(n.c.practicing).toBe(true);
		n.key(4);
		n.c.setSpectate(true, null);
		expect(n.c.practicing).toBe(false);
		expect(n.c.practiceTargets()).toEqual([]);
		expect([...n.players!.ids()]).toEqual([]);
		const fired = n.vm.fired;
		n.c.press('attack', true, n.clock.now);
		n.run(200);
		expect(n.vm.fired).toBe(fired);
		expect(n.c.slot(4, n.clock.now)).toBe(false);
		expect(n.view()).toMatchObject({ phase: 'waiting', practice: false, spectating: true });
		expect(n.c.practiceTargets()).toEqual([]);
		// Back in play: the range opens again with the round's gun.
		n.c.setSpectate(false, null);
		n.run(100);
		expect(n.c.practicing).toBe(true);
		expect(n.view()).toMatchObject({ practice: true, weapon: 'barrett' });
		expect(n.sent).toEqual([]);
	});
});
