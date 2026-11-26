import { describe, expect, it } from 'vitest';
import { buildCollisionWorld } from '../../collision/world.ts';
import { getMap } from '../../maps/index.ts';
import type { MapDef } from '../../maps/types.ts';
import { VIEW_HEIGHT } from '../../movement/api.ts';
import type { Vec3 } from '../../types.ts';
import { GAME_MODES, mapCvars, ZOMBIES_CVARS } from '../index.ts';
import {
	eligibleSpawnZones,
	ZM_ATTACK_COOLDOWN_MS,
	ZM_PLAYER_HP,
	ZM_PZ_RESPAWN_SECS,
	ZM_TURN_SECS,
	ZM_ZOMBIE_SPEED,
	zmEventRoute,
	zmSlowFactor,
	ZM_MAX_ZOMBIES,
	ZM_SPAWN_MIN_MS,
	zmSpawnInterval,
	zmZombieCap,
	ZombiesGame,
	type ZmEvent,
	type ZombiesGameOptions
} from './game.ts';
import { headCentre, meleeZombie, rayCylinder, raySphere, rayZombie, ZOMBIE_BODY, ZOMBIE_HEAD } from './hitbox.ts';
import { decodeZombies, encodeZombies } from './net.ts';
import { gateFarSide, unlockReached, ZM_GATE_COUNTDOWN_SECS } from './gates.ts';
import { HULL_MAX, HULL_MIN } from '../../movement/api.ts';
import { ZombiePath } from './path.ts';
import { hitDamage, shotsToKill, weaponForSlot, WEAPONS, WeaponState, WEAPON_IDS, ZOMBIE_HP } from './weapons.ts';

const unit = (x: number, y: number, z: number): Vec3 => {
	const l = Math.hypot(x, y, z);
	return { x: x / l, y: y / l, z: z / l };
};

describe('weapons', () => {
	it('shots to kill on the body: LMG 8, pistol 4, sniper 1, knife 1', () => {
		expect(shotsToKill('lmg')).toBe(8);
		expect(shotsToKill('pistol')).toBe(4);
		expect(shotsToKill('sniper')).toBe(1);
		expect(shotsToKill('knife')).toBe(1);
	});

	it('any headshot is an instant kill', () => {
		for (const w of WEAPON_IDS) {
			expect(shotsToKill(w, true)).toBe(1);
			expect(hitDamage(w, true)).toBeGreaterThanOrEqual(ZOMBIE_HP);
			expect(hitDamage(w, false)).toBe(WEAPONS[w].damage);
		}
	});

	it('move speeds: knife > pistol > sniper > LMG, all slower than zombies', () => {
		const s = (w: keyof typeof WEAPONS) => WEAPONS[w].moveSpeed;
		expect(s('knife')).toBe(250);
		expect(s('knife')).toBeGreaterThan(s('pistol'));
		expect(s('pistol')).toBeGreaterThan(s('sniper'));
		expect(s('sniper')).toBeGreaterThan(s('lmg'));
		for (const w of WEAPON_IDS) expect(ZM_ZOMBIE_SPEED).toBeGreaterThan(s(w));
		// ... but only slightly: a hit slow puts them well below every weapon.
		expect(ZM_ZOMBIE_SPEED * zmSlowFactor(1)).toBeLessThan(s('lmg'));
	});

	it('loadout keys 1-4 map to the four weapons', () => {
		expect([1, 2, 3, 4].map(weaponForSlot)).toEqual(['lmg', 'pistol', 'knife', 'sniper']);
		expect(weaponForSlot(5)).toBeNull();
	});

	it('fire rate, magazine and reload', () => {
		const w = new WeaponState('pistol');
		expect(w.mag).toBe(12);
		expect(w.fire(0)).toBe(true);
		expect(w.fire(10)).toBe(false); // faster than 150 ms
		expect(w.fire(150)).toBe(true);
		for (let t = 300; w.mag > 0; t += 150) expect(w.fire(t)).toBe(true);
		expect(w.fire(10_000)).toBe(false); // empty
		expect(w.startReload(10_000)).toBe(true);
		expect(w.reloading(10_100)).toBe(true);
		expect(w.fire(10_100)).toBe(false);
		expect(w.reloading(10_000 + WEAPONS.pistol.reloadMs)).toBe(false);
		expect(w.mag).toBe(12);
		expect(w.reserve).toBe(96 - 12);
		w.reserve = 0;
		w.refill();
		expect(w.reserve).toBe(96);
	});

	it('the knife needs no ammo; the server tolerance loosens timing', () => {
		const k = new WeaponState('knife');
		for (let i = 0; i < 50; i++) expect(k.fire(i * 450)).toBe(true);
		expect(k.startReload(0)).toBe(false);
		const lenient = new WeaponState('sniper', 0.75, 0.85);
		expect(lenient.fire(0)).toBe(true);
		expect(lenient.fire(WEAPONS.sniper.fireMs * 0.75)).toBe(true);
	});
});

describe('hitboxes', () => {
	const pose = { x: 500, y: 0, z: 0, yaw: 180 }; // facing the shooter at the origin
	const eye = { x: 0, y: 0, z: VIEW_HEIGHT };

	it('ray primitives', () => {
		expect(raySphere({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 10, 0, 0, 2)).toBeCloseTo(8);
		expect(raySphere({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 10, 5, 0, 2)).toBe(-1);
		expect(raySphere({ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, 10, 0, 0, 2)).toBe(-1);
		expect(rayCylinder({ x: 0, y: 0, z: 5 }, { x: 1, y: 0, z: 0 }, 10, 0, 0, 10, 2)).toBeCloseTo(8);
		expect(rayCylinder({ x: 0, y: 0, z: 15 }, { x: 1, y: 0, z: 0 }, 10, 0, 0, 10, 2)).toBe(-1);
		expect(rayCylinder({ x: 10, y: 0, z: 20 }, { x: 0, y: 0, z: -1 }, 10, 0, 0, 10, 2)).toBeCloseTo(10); // top cap
	});

	it('aiming at the head is a headshot, at the chest a body hit', () => {
		const h = headCentre(pose);
		const toHead = unit(h.x - eye.x, h.y - eye.y, h.z - eye.z);
		const headHit = rayZombie(eye, toHead, pose, 8192);
		expect(headHit?.head).toBe(true);
		const toChest = unit(pose.x - eye.x, 0, 40 - eye.z);
		const body = rayZombie(eye, toChest, pose, 8192);
		expect(body).not.toBeNull();
		expect(body!.head).toBe(false);
		expect(body!.t).toBeCloseTo(Math.hypot(500 - ZOMBIE_BODY.radius, 40 - eye.z) - 0.4, 0);
	});

	it('misses: wide, over the head, beyond range, behind the shooter', () => {
		expect(rayZombie(eye, unit(1, 0.2, 0), pose, 8192)).toBeNull();
		expect(rayZombie(eye, unit(500, 0, ZOMBIE_HEAD.z + ZOMBIE_HEAD.radius + 4 - eye.z), pose, 8192)).toBeNull();
		expect(rayZombie(eye, unit(1, 0, -0.05), pose, 100)).toBeNull();
		expect(rayZombie(eye, unit(-1, 0, 0), pose, 8192)).toBeNull();
	});

	it('a ray from below through the body first is not a headshot', () => {
		const below = { x: 500 - 20, y: 0, z: 2 };
		const h = headCentre(pose);
		const hit = rayZombie(below, unit(h.x - below.x, h.y - below.y, h.z - below.z), pose, 8192);
		expect(hit?.head).toBe(false);
	});

	it('melee: in reach and in the cone only', () => {
		const near = { x: 60, y: 0, z: 0, yaw: 180 };
		const fwd = unit(1, 0, -0.2);
		expect(meleeZombie(eye, fwd, near, WEAPONS.knife.range, WEAPONS.knife.coneDeg)).not.toBeNull();
		expect(meleeZombie(eye, unit(-1, 0, 0), near, WEAPONS.knife.range, WEAPONS.knife.coneDeg)).toBeNull();
		expect(meleeZombie(eye, fwd, { ...near, x: 200 }, WEAPONS.knife.range, WEAPONS.knife.coneDeg)).toBeNull();
	});
});

describe('route and spawner', () => {
	it('path progress and points', () => {
		const p = new ZombiePath([
			{ x: 0, y: 0, z: 0 },
			{ x: 100, y: 0, z: 0 },
			{ x: 100, y: 100, z: 0 }
		]);
		expect(p.length).toBe(200);
		expect(p.project(50, 10)).toBeCloseTo(50);
		expect(p.project(120, 60)).toBeCloseTo(160);
		expect(p.pointAt(150)).toEqual({ x: 100, y: 50, z: 0 });
		expect(p.segmentAt(150)).toBe(1);
		expect(p.pointAt(-5)).toEqual({ x: 0, y: 0, z: 0 });
	});

	it('spawn rate and alive cap by survivors (the table in docs/modes.md)', () => {
		const rows = [1, 2, 4, 8, 16, 32].map((n) => [n, zmZombieCap(n), +(60_000 / zmSpawnInterval(n, 0)).toFixed(0), +(60_000 / zmSpawnInterval(n, 1)).toFixed(0)]);
		expect(rows).toEqual([
			[1, 18, 40, 62],
			[2, 25, 72, 111],
			[4, 36, 130, 200],
			[8, 51, 234, 360],
			[16, 72, 422, 650],
			[32, 96, 761, 1171]
		]);
	});

	it('spawn rate and cap: more survivors always meet more zombies, sub-linearly, with hard limits', () => {
		for (let n = 1; n < 32; n++) {
			for (const p of [0, 0.5, 1]) {
				const a = zmSpawnInterval(n, p);
				const b = zmSpawnInterval(n + 1, p);
				expect(b).toBeLessThan(a); // more zombies in total ...
				expect(b * (n + 1)).toBeGreaterThan(a * n); // ... fewer per survivor
			}
			expect(zmZombieCap(n + 1)).toBeGreaterThanOrEqual(zmZombieCap(n));
			expect(zmZombieCap(n + 1) / (n + 1)).toBeLessThan(zmZombieCap(n) / n);
		}
		// Doubling the survivors is clearly busier all the way up to a full lobby.
		for (const n of [1, 2, 4, 8, 16]) {
			expect(zmSpawnInterval(n, 0) / zmSpawnInterval(2 * n, 0)).toBeGreaterThan(1.7);
			expect(zmZombieCap(2 * n) / zmZombieCap(n)).toBeGreaterThan(1.3);
		}
		expect(zmSpawnInterval(1, 1)).toBeLessThan(zmSpawnInterval(1, 0));
		expect(zmSpawnInterval(1000, 1)).toBe(ZM_SPAWN_MIN_MS);
		expect(zmZombieCap(1000)).toBe(ZM_MAX_ZOMBIES);
		expect(ZM_MAX_ZOMBIES).toBeLessThanOrEqual(255); // BIN_ZOMBIES count is a u8
		expect(zmZombieCap(32, 10)).toBe(10);
		expect([zmSpawnInterval(0, 0), zmZombieCap(0)]).toEqual([zmSpawnInterval(1, 0), zmZombieCap(1)]);
	});

	it('eligible spawn areas: near the front, away from players', () => {
		const zone = (x: number, node: number) => ({ min: { x, y: 0, z: 0 }, max: { x: x + 100, y: 100, z: 128 }, node });
		const zones = [zone(0, 0), zone(1000, 1), zone(2000, 2), zone(9000, 9)];
		const at = (x: number) => [{ x, y: 50, z: 0 }];
		expect(eligibleSpawnZones(zones, 1, at(1050))).toEqual([zones[0], zones[2]]);
		expect(eligibleSpawnZones(zones, 1, [])).toEqual([]);
		expect(eligibleSpawnZones(zones, 9, at(1050))).toEqual([]);
	});

	it('event routing', () => {
		expect(zmEventRoute({ e: 'hit', by: 3, zid: 1, head: true, kill: true })).toEqual({ to: 3 });
		expect(zmEventRoute({ e: 'shot', by: 3, weapon: 'lmg', o: { x: 0, y: 0, z: 0 }, d: { x: 1, y: 0, z: 0 }, len: 5 })).toEqual({ except: 3 });
		expect(zmEventRoute({ e: 'down', id: 3 })).toEqual({});
	});

	it('zombie snapshot round-trips', () => {
		const frame = encodeZombies(1234, [{ id: 7, x: 100.5, y: -2000.5, z: 64, yaw: -90, flags: 5, hp: 0.5 }], 12456.25);
		expect(frame.byteLength).toBe(15 + 11);
		const d = decodeZombies(frame)!;
		expect(d.tick).toBe(1234);
		expect(d.serverTimeMs).toBe(12456.25);
		expect(d.zombies[0]!).toMatchObject({ id: 7, x: 100.5, y: -2000.5, z: 64, flags: 5 });
		expect(d.zombies[0]!.yaw).toBeCloseTo(-90, 0);
		expect(d.zombies[0]!.hp).toBeCloseTo(0.5, 1);
		expect(decodeZombies(frame.slice(0, 10))).toBeNull();
	});
});

/** Flat corridor along +x: start at x 0, checkpoint 1 at x 1000, end zone at x 2600. */
function testMap(): MapDef {
	return {
		id: 'zombies_test',
		title: 'Test',
		kind: 'zombies',
		difficulty: 'easy',
		layout: 'linear',
		cvars: {},
		spawn: { pos: { x: 0, y: 0, z: 0.25 }, yaw: 0 },
		spawns: [{ pos: { x: 0, y: 0, z: 0.25 }, yaw: 0 }],
		zombies: {
			path: [
				{ x: 0, y: 0, z: 0 },
				{ x: 1400, y: 0, z: 0 },
				{ x: 2800, y: 0, z: 0 }
			],
			spawnZones: [{ min: { x: 1500, y: -200, z: 0 }, max: { x: 1700, y: 200, z: 128 }, node: 1 }],
			gates: [{ min: { x: 1300, y: -400, z: 0 }, max: { x: 1316, y: 400, z: 200 }, unlock: { min: { x: 1150, y: -400, z: 0 }, max: { x: 1290, y: 400, z: 160 } }, node: 0 }]
		},
		brushes: [{ type: 'box', min: { x: -400, y: -400, z: -64 }, max: { x: 3000, y: 400, z: 0 }, material: 'm' }],
		zones: [
			{ type: 'checkpoint', index: 1, min: { x: 1000, y: -400, z: 0 }, max: { x: 1100, y: 400, z: 200 }, respawn: { pos: { x: 1050, y: 0, z: 0.25 }, yaw: 0 } },
			{ type: 'end', min: { x: 2600, y: -400, z: 0 }, max: { x: 2800, y: 400, z: 200 } },
			{ type: 'teleport', min: { x: -5000, y: -5000, z: -3000 }, max: { x: 5000, y: 5000, z: -500 }, to: 'stage' }
		],
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

function newGame(map: MapDef, opts: Partial<ZombiesGameOptions> = {}) {
	const clock = { now: 1_000_000 };
	const game = new ZombiesGame({
		map,
		world: buildCollisionWorld(map),
		cvars: mapCvars(map),
		now: clock.now,
		rng: () => 0.5,
		countdownSecs: 1,
		endSecs: 5,
		spawnIntervalScale: 1e9, // no automatic spawns unless a test wants them
		...opts
	});
	const events: ZmEvent[] = [];
	const advance = (ms: number) => {
		const end = clock.now + ms;
		while (clock.now < end) {
			clock.now = Math.min(end, clock.now + 1000 / 64);
			events.push(...game.update(clock.now));
		}
	};
	return { game, clock, events, advance };
}

describe('round flow (fake clock)', () => {
	it('waiting → countdown → playing; a zombie kills the player in 5 hits → lost → restart', () => {
		const { game, clock, events, advance } = newGame(testMap());
		expect(game.update(clock.now)).toEqual([]);
		expect(game.phase).toBe('waiting');
		game.syncPlayers([1], clock.now);
		game.setPlayerPos(1, { x: 0, y: 0, z: 0, ducked: false });
		advance(10);
		expect(game.phase).toBe('countdown');
		expect(events.some((e) => e.e === 'spawn' && e.id === 1 && e.reason === 'round')).toBe(true);
		advance(1000);
		expect(game.phase).toBe('playing');
		expect(game.round).toBe(1);

		const z = game.spawnZombie({ x: 40, y: 0, z: 0.25 })!;
		expect(z).not.toBeNull();
		// The player stands still; the zombie hits every wind-up + cooldown.
		advance((ZM_ATTACK_COOLDOWN_MS + 400) * (ZM_PLAYER_HP + 1));
		const hurts = events.filter((e) => e.e === 'hurt');
		expect(hurts.map((e) => (e as { hp: number }).hp)).toEqual([4, 3, 2, 1, 0]);
		expect(events.some((e) => e.e === 'down' && e.id === 1)).toBe(true);
		const end = events.find((e) => e.e === 'end') as Extract<ZmEvent, { e: 'end' }>;
		expect(end).toMatchObject({ won: false, round: 1 });
		expect(game.phase).toBe('ended');
		expect(game.view(clock.now).players[0]).toMatchObject({ hp: 0, alive: false, deaths: 1 });

		events.length = 0;
		for (let i = 0; i < 60 && game.phase === 'ended'; i++) advance(100);
		expect(game.phase).toBe('countdown');
		expect(game.zombies.size).toBe(0);
		expect(game.view(clock.now).players[0]).toMatchObject({ hp: ZM_PLAYER_HP, alive: true });
		expect(events.some((e) => e.e === 'spawn' && e.reason === 'round')).toBe(true);
	});

	it('a downed survivor turns into a zombie: claws, shootable, respawns; a wipe still loses', () => {
		const { game, clock, events, advance } = newGame(testMap());
		game.syncPlayers([1, 2], clock.now);
		advance(1100);
		expect(game.phase).toBe('playing');
		// Player 2 goes down (5 AI zombie hits), player 1 stays away.
		game.setPlayerPos(2, { x: 0, y: 100, z: 0, ducked: false });
		game.setPlayerPos(1, { x: 600, y: 0, z: 0, ducked: false });
		game.spawnZombie({ x: 0, y: 140, z: 0.25 });
		for (let i = 0; i < 80 && game.playerView(2)!.team === 'survivor'; i++) advance(100);
		expect(game.playerView(2)).toMatchObject({ team: 'zombie', alive: false, deaths: 1, weapon: 'claws' });
		expect(events.some((e) => e.e === 'down' && e.id === 2)).toBe(true);
		expect(game.phase).toBe('playing'); // a survivor is left
		game.zombies.clear();
		events.length = 0;
		advance(ZM_TURN_SECS * 1000 + 100);
		const rise = events.find((e) => e.e === 'spawn' && e.id === 2) as Extract<ZmEvent, { e: 'spawn' }>;
		expect(rise).toMatchObject({ team: 'zombie', reason: 'zombie', hp: ZOMBIE_HP });
		expect(game.playerView(2)).toMatchObject({ team: 'zombie', alive: true, hp: ZOMBIE_HP });

		// The player-zombie claws the survivor: one hit per swing, same i-frames.
		game.setPlayerPos(2, { x: 560, y: 0, z: 0, ducked: false, yaw: 0 });
		const swing = game.fire(2, { weapon: 'claws', origin: { x: 560, y: 0, z: VIEW_HEIGHT }, dir: { x: 1, y: 0, z: -0.2 }, tick: game.tick }, clock.now);
		expect(swing.ok).toBe(true);
		expect(swing.events.find((e) => e.e === 'hurt')).toMatchObject({ id: 1, hp: 4, by: 2 });
		expect(game.fire(2, { weapon: 'pistol', origin: { x: 560, y: 0, z: VIEW_HEIGHT }, dir: { x: 1, y: 0, z: 0 }, tick: 0 }, clock.now + 1000).reason).toBe('wrong weapon');
		expect(game.loadout(2, 'lmg', clock.now)).toEqual([]);

		// Survivors can shoot it like an AI zombie: a headshot kills; it respawns later.
		game.setPlayerPos(2, { x: 900, y: 0, z: 0, ducked: false, yaw: 180 });
		const eye = { x: 600, y: 0, z: VIEW_HEIGHT };
		const h = headCentre({ x: 900, y: 0, z: 0, yaw: 180 });
		advance(50);
		const seenTick = game.tick;
		// About 40 units of motion at 265 u/s during the 156 ms between seeing and firing.
		game.setPlayerPos(2, { x: 900, y: 41, z: 0, ducked: false, yaw: 180 });
		advance(156);
		const dir = unit(h.x - eye.x, h.y - eye.y, h.z - eye.z);
		const live = game.fire(1, { weapon: 'pistol', origin: eye, dir, tick: game.tick }, clock.now);
		expect(live.events.some((e) => e.e === 'hit')).toBe(false);
		clock.now += 200;
		const shot = game.fire(1, { weapon: 'pistol', origin: eye, dir, tick: seenTick }, clock.now);
		expect(shot.events.find((e) => e.e === 'kill')).toMatchObject({ pid: 2, head: true, by: 1 });
		expect(game.playerView(2)!.alive).toBe(false);
		events.length = 0;
		advance(ZM_PZ_RESPAWN_SECS * 1000 + 100);
		expect(events.some((e) => e.e === 'spawn' && e.id === 2 && e.team === 'zombie')).toBe(true);

		game.setPlayerPos(2, { x: 900, y: 0, z: 0, ducked: false, yaw: 180 });
		advance(50);
		const beforeTeleport = game.tick;
		game.setPlayerPos(2, { x: 900, y: 300, z: 0, ducked: false, yaw: 180 }, true);
		advance(50);
		const afterTeleport = game.fire(1, { weapon: 'pistol', origin: eye, dir, tick: beforeTeleport }, clock.now);
		expect(afterTeleport.ok).toBe(true);
		expect(afterTeleport.events.some((e) => e.e === 'hit')).toBe(false);

		// The last survivor goes down: lost, even though a player-zombie is alive.
		game.setPlayerPos(1, { x: 0, y: 0, z: 0, ducked: false });
		game.spawnZombie({ x: 30, y: 0, z: 0.25 });
		for (let i = 0; i < 80 && game.phase === 'playing'; i++) advance(100);
		expect(events.find((e) => e.e === 'end')).toMatchObject({ won: false });
		// Next round: everyone is a survivor again.
		for (let i = 0; i < 80 && game.phase !== 'countdown'; i++) advance(100);
		expect(game.playerView(2)).toMatchObject({ team: 'survivor', alive: true, hp: ZM_PLAYER_HP });
	});

	it('the end zone wins; checkpoints heal survivors', () => {
		const { game, clock, events, advance } = newGame(testMap(), { gatesOpen: true });
		game.syncPlayers([1], clock.now);
		advance(1100);
		game.setPlayerPos(1, { x: 0, y: 0, z: 0, ducked: false });
		game.spawnZombie({ x: 30, y: 0, z: 0.25 });
		for (let i = 0; i < 40 && game.playerView(1)!.hp > 3; i++) advance(100);
		game.zombies.clear();
		game.setPlayerPos(1, { x: 1050, y: 0, z: 0, ducked: false });
		advance(50);
		expect(events.find((e) => e.e === 'checkpoint')).toMatchObject({ index: 1, by: 1 });
		expect(game.playerView(1)!.hp).toBe(ZM_PLAYER_HP);
		game.setPlayerPos(1, { x: 2700, y: 0, z: 0, ducked: false });
		advance(50);
		expect(events.find((e) => e.e === 'end')).toMatchObject({ won: true, by: 1 });
		expect(game.phase).toBe('ended');
	});

	it('falling out costs 1 HP and teleports back to the checkpoint', () => {
		const { game, clock, events, advance } = newGame(testMap());
		game.syncPlayers([1], clock.now);
		advance(1100);
		advance(1100); // past the spawn grace
		game.setPlayerPos(1, { x: 500, y: 0, z: -800, ducked: false });
		advance(20);
		expect(events.find((e) => e.e === 'hurt')).toMatchObject({ id: 1, hp: 4 });
		expect(events.find((e) => e.e === 'spawn' && e.reason === 'fall')).toMatchObject({ x: 0 });
	});
});

describe('gates (fake clock)', () => {
	it('unlock rule: at least half of the living survivors, never below', () => {
		expect(unlockReached(1, 1)).toBe(true);
		expect(unlockReached(1, 2)).toBe(true); // exactly 50%
		expect(unlockReached(1, 3)).toBe(false); // 33%
		expect(unlockReached(2, 3)).toBe(true);
		expect(unlockReached(1, 4)).toBe(false);
		expect(unlockReached(2, 4)).toBe(true); // exactly 50%
		expect(unlockReached(0, 0)).toBe(false);
	});

	function gameWith(n: number) {
		const g = newGame(testMap());
		const ids = Array.from({ length: n }, (_, i) => i + 1);
		g.game.syncPlayers(ids, g.clock.now);
		g.advance(1100);
		for (const id of ids) g.game.setPlayerPos(id, { x: 200, y: (id - 2) * 60, z: 0, ducked: false });
		return { ...g, ids };
	}
	const inArea = { x: 1220, y: 0, z: 0, ducked: false };

	it('starts the countdown at exactly 50% of the survivors and not below', () => {
		const three = gameWith(3);
		three.game.setPlayerPos(1, inArea);
		three.advance(100);
		expect(three.game.gateState(0)).toBe('closed'); // 1 of 3
		three.game.setPlayerPos(2, inArea);
		three.advance(100);
		expect(three.game.gateState(0)).toBe('counting'); // 2 of 3
		const two = gameWith(2);
		two.game.setPlayerPos(1, inArea);
		two.advance(100);
		expect(two.game.gateState(0)).toBe('counting'); // 1 of 2 = 50%
		expect(two.events.find((e) => e.e === 'gate')).toMatchObject({ index: 0, state: 'counting', secs: ZM_GATE_COUNTDOWN_SECS });
		expect(two.game.view(two.clock.now).gates[0]).toMatchObject({ state: 'counting' });
	});

	it('blocks while closed; the countdown persists after leaving the area; opens after 30 s', () => {
		const { game, clock, events, advance } = gameWith(1);
		const across = () => game.world.trace({ x: 1200, y: 0, z: 1 }, { x: 1400, y: 0, z: 1 }, HULL_MIN, HULL_MAX).fraction;
		expect(across()).toBeLessThan(1);
		game.setPlayerPos(1, inArea);
		advance(100);
		const start = clock.now;
		expect(game.gateState(0)).toBe('counting');
		game.setPlayerPos(1, { x: 200, y: 0, z: 0, ducked: false }); // walk away: not cancelled
		while (clock.now - start < ZM_GATE_COUNTDOWN_SECS * 1000 - 300) advance(100);
		expect(game.gateState(0)).toBe('counting');
		expect(game.view(clock.now).gates[0]!.secsLeft).toBeGreaterThan(0);
		expect(across()).toBeLessThan(1);
		advance(400);
		expect(game.gateState(0)).toBe('open');
		expect(events.some((e) => e.e === 'gate' && e.state === 'open' && e.index === 0)).toBe(true);
		expect(across()).toBe(1);
	});

	it('the far side of a gate is on the side the route leads to', () => {
		const g = { min: { x: 0, y: 100, z: 0 }, max: { x: 200, y: 116, z: 190 } };
		const gate = { ...g, unlock: g, node: 0 };
		expect(gateFarSide(gate, { x: 0, y: 1 })).toEqual({ min: { x: 0, y: 132, z: -64 }, max: { x: 200, y: 644, z: 254 } });
		expect(gateFarSide(gate, { x: 0, y: -1 })).toEqual({ min: { x: 0, y: -428, z: -64 }, max: { x: 200, y: 84, z: 254 } });
	});

	it('walking the route of a real map passes every gate once, in order; closed gates are skipped', () => {
		const map = getMap('zombies_lowtide')!;
		const walk = (gatesOpen: boolean) => {
			const { game, events, advance, clock } = newGame(map, { gatesOpen });
			game.syncPlayers([1], clock.now);
			advance(1100);
			for (let s = 0; s < game.path.length - 200; s += 8) {
				const q = game.path.pointAt(s);
				game.setPlayerPos(1, { x: q.x, y: q.y, z: 0.25, ducked: false });
				advance(1000 / 64);
			}
			return events.filter((e) => e.e === 'pass');
		};
		expect(walk(true)).toEqual(map.zombies!.gates.map((_, index) => ({ e: 'pass', id: 1, index })));
		expect(walk(false)).toEqual([]);
	});

	it('only living survivors pass, and not while a teleport is fresh', () => {
		const g = newGame(testMap(), { gatesOpen: true });
		g.game.syncPlayers([1, 2], g.clock.now);
		g.advance(1100);
		const behind = { x: 1340, y: 0, z: 0, ducked: false };
		g.game.setPlayerPos(2, { x: 200, y: 0, z: -600, ducked: false }); // falls out
		g.advance(50);
		g.game.setPlayerPos(2, behind); // a packet from before the teleport
		g.advance(100);
		g.game.setPlayerPos(2, { x: 200, y: 0, z: 0, ducked: false });
		g.advance(1100);
		expect(g.events.filter((e) => e.e === 'pass')).toEqual([]);
		for (let i = 0; i < 4; i++) {
			g.game.setPlayerPos(1, { x: 200, y: 0, z: -600, ducked: false });
			g.advance(1100);
		}
		g.game.setPlayerPos(1, { x: 200, y: 0, z: -600, ducked: false });
		g.advance(1100);
		expect(g.game.playerView(1)!.team).toBe('zombie');
		g.game.setPlayerPos(1, behind);
		g.game.setPlayerPos(2, behind);
		g.advance(100);
		expect(g.events.filter((e) => e.e === 'pass')).toEqual([{ e: 'pass', id: 2, index: 0 }]);
	});

	it('no zombies spawn behind a closed gate', () => {
		const { game, advance } = newGame(testMap(), { spawnIntervalScale: 0.01 });
		game.syncPlayers([1], 1_000_000);
		advance(1100);
		game.setPlayerPos(1, { x: 200, y: 0, z: 0, ducked: false });
		advance(3000);
		expect(game.zombies.size).toBe(0); // the only spawn area is past the gate
	});
});

describe('zombie count by living survivors (fake clock)', () => {
	function start(ids: number[], opts: Partial<ZombiesGameOptions> = {}) {
		const g = newGame(testMap(), { gatesOpen: true, ...opts });
		g.game.syncPlayers(ids, g.clock.now);
		for (const id of ids) g.game.setPlayerPos(id, { x: 200, y: 0, z: 0, ducked: false });
		g.advance(1050);
		expect(g.game.phase).toBe('playing');
		return g;
	}
	/** Take a survivor out of the round (turned player-zombie). */
	const turn = (game: ZombiesGame, id: number) => {
		(game as unknown as { players: Map<number, { team: string }> }).players.get(id)!.team = 'zombie';
	};

	it('spawns at the rate of the living survivors', () => {
		const spawnedIn2s = (n: number) => {
			const { game, advance } = start(Array.from({ length: n }, (_, i) => i + 1), { spawnIntervalScale: 1 });
			advance(1500); // first spawn
			const from = game.zombies.size;
			expect(from).toBeGreaterThan(0);
			advance(2000);
			return game.zombies.size - from;
		};
		const got = [1, 4, 16, 32].map(spawnedIn2s);
		expect(got[0]).toBe(1);
		for (const [i, n] of [1, 4, 16, 32].entries()) expect(Math.abs(got[i]! - 2000 / zmSpawnInterval(n, 0.07))).toBeLessThan(1.5);
	});

	it('the alive cap follows survivors who turn, join or leave mid-round, not everyone connected', () => {
		const { game, advance, clock } = start([1, 2, 3, 4], { spawnIntervalScale: 0.001 });
		advance(1500);
		expect(game.zombies.size).toBe(zmZombieCap(4));
		for (const id of [2, 3, 4]) turn(game, id);
		for (const id of [...game.zombies.keys()].slice(0, 30)) game.zombies.delete(id);
		advance(1000);
		expect(game.zombies.size).toBe(zmZombieCap(1));
		// A late joiner is a survivor.
		game.syncPlayers([1, 2, 3, 4, 5], clock.now);
		game.setPlayerPos(5, { x: 200, y: 0, z: 0, ducked: false });
		advance(400);
		expect(game.zombies.size).toBe(zmZombieCap(2));
		// Fewer survivors: nothing is removed, but the spawner waits until it is below the new cap.
		game.syncPlayers([1, 2, 3, 4], clock.now);
		advance(400);
		expect(game.zombies.size).toBe(zmZombieCap(2));
		game.zombies.delete([...game.zombies.keys()][0]!);
		advance(400);
		expect(game.zombies.size).toBe(zmZombieCap(2) - 1);
	});

	it('zombie HP and the gate rule do not depend on the survivor count', () => {
		const hp = [1, 32].map((n) => start(Array.from({ length: n }, (_, i) => i + 1)).game.spawnZombie({ x: 1000, y: 0, z: 0.25 })!.hp);
		expect(hp).toEqual([ZOMBIE_HP, ZOMBIE_HP]);
		expect([unlockReached(1, 2), unlockReached(16, 32), unlockReached(15, 32)]).toEqual([true, true, false]);
	});
});

describe('shooting (fake clock)', () => {
	function ready() {
		const g = newGame(testMap());
		g.game.syncPlayers([1], g.clock.now);
		g.game.setPlayerPos(1, { x: 0, y: 0, z: 0, ducked: false });
		g.advance(1100);
		return g;
	}
	const eye = { x: 0, y: 0, z: VIEW_HEIGHT };

	it('pistol: 4 body hits kill, a headshot kills at once', () => {
		const { game, clock } = ready();
		const z = game.spawnZombie({ x: 600, y: 0, z: 0.25 })!;
		z.yaw = 180;
		const chest = () => unit(z.body.origin.x - eye.x, z.body.origin.y - eye.y, z.body.origin.z + 40 - eye.z);
		let kills = 0;
		for (let i = 0; i < 4; i++) {
			clock.now += 200;
			const r = game.fire(1, { weapon: 'pistol', origin: eye, dir: chest(), tick: game.tick }, clock.now);
			expect(r.ok).toBe(true);
			const hit = r.events.find((e) => e.e === 'hit') as Extract<ZmEvent, { e: 'hit' }>;
			expect(hit).toMatchObject({ head: false, kill: i === 3 });
			kills += r.events.filter((e) => e.e === 'kill').length;
			if (i < 3) expect(z.slowUntil).toBeGreaterThan(game.simTime); // hits slow
		}
		expect(kills).toBe(1);
		expect(game.zombies.has(z.id)).toBe(false);

		const z2 = game.spawnZombie({ x: 600, y: 0, z: 0.25 })!;
		z2.yaw = 180;
		const h = headCentre({ ...z2.body.origin, yaw: 180 });
		clock.now += 200;
		const r = game.fire(1, { weapon: 'pistol', origin: eye, dir: unit(h.x - eye.x, h.y - eye.y, h.z - eye.z), tick: game.tick }, clock.now);
		expect(r.events.find((e) => e.e === 'kill')).toMatchObject({ zid: z2.id, head: true, weapon: 'pistol', by: 1 });
		expect(game.view(clock.now).kills).toBe(2);
	});

	it('LMG needs 8 body hits; the sniper pierces a line of zombies', () => {
		const { game, clock } = ready();
		expect(game.loadout(1, 'lmg', clock.now)[0]).toMatchObject({ e: 'ammo', weapon: 'lmg', mag: 100 });
		const z = game.spawnZombie({ x: 600, y: 0, z: 0.25 })!;
		const dir = unit(600, 0, 40 - eye.z);
		let shots = 0;
		while (game.zombies.has(z.id) && shots < 20) {
			clock.now += 100;
			z.body.origin.x = 600;
			z.body.origin.y = 0;
			expect(game.fire(1, { weapon: 'lmg', origin: eye, dir, tick: game.tick }, clock.now).ok).toBe(true);
			shots++;
		}
		expect(shots).toBe(8);

		game.loadout(1, 'sniper', clock.now);
		const line = [400, 500, 600].map((x) => game.spawnZombie({ x, y: 0, z: 0.25 })!);
		clock.now += 2000;
		const r = game.fire(1, { weapon: 'sniper', origin: eye, dir: unit(1, 0, -0.03), tick: game.tick }, clock.now);
		expect(r.events.filter((e) => e.e === 'kill').length).toBe(3);
		for (const q of line) expect(game.zombies.has(q.id)).toBe(false);
	});

	it('walls stop bullets; rejects spam, wrong weapon, bad origin, empty magazine', () => {
		const { game, clock } = ready();
		game.world.solids; // the test map has only the floor: shoot through the floor instead
		const z = game.spawnZombie({ x: 300, y: 0, z: 0.25 })!;
		clock.now += 200;
		const down = game.fire(1, { weapon: 'pistol', origin: eye, dir: unit(1, 0, -1), tick: game.tick }, clock.now);
		expect(down.ok).toBe(true);
		expect(down.events.some((e) => e.e === 'hit')).toBe(false); // hits the floor first
		expect(game.zombies.has(z.id)).toBe(true);

		const dir = unit(1, 0, 0);
		const first = game.fire(1, { weapon: 'pistol', origin: eye, dir, tick: game.tick }, clock.now + 200);
		expect(first.ok).toBe(true);
		const spam = game.fire(1, { weapon: 'pistol', origin: eye, dir, tick: game.tick }, clock.now + 201);
		expect(spam).toMatchObject({ ok: false, reason: 'too fast' });
		expect(spam.events[0]).toMatchObject({ e: 'ammo', weapon: 'pistol' });
		expect(game.fire(1, { weapon: 'lmg', origin: eye, dir, tick: 0 }, clock.now + 1000).reason).toBe('wrong weapon');
		expect(game.fire(1, { weapon: 'pistol', origin: { x: 900, y: 0, z: 64 }, dir, tick: 0 }, clock.now + 1000).reason).toBe('bad origin');
		expect(game.fire(1, { weapon: 'pistol', origin: eye, dir: { x: 3, y: 0, z: 0 }, tick: 0 }, clock.now + 1000).reason).toBe('bad direction');
		const ws = game.weaponOf(1)!;
		ws.mag = 0;
		expect(game.fire(1, { weapon: 'pistol', origin: eye, dir, tick: 0 }, clock.now + 2000).reason).toBe('empty');
		expect(game.reload(1, clock.now + 2000)).toBe(true);
		expect(game.fire(1, { weapon: 'pistol', origin: eye, dir, tick: 0 }, clock.now + 2100).reason).toBe('reloading');
	});

	it('lag compensation: a shot at where the zombie was hits it', () => {
		const { game, clock, advance } = ready();
		const z = game.spawnZombie({ x: 800, y: 0, z: 0.25 })!;
		advance(50);
		const seenTick = game.tick;
		const seen = { ...z.body.origin };
		// The zombie moves on (sideways, so the old line misses it now).
		z.body.origin.y = 120;
		advance(100);
		const dir = unit(seen.x - eye.x, seen.y - eye.y, seen.z + 40 - eye.z);
		clock.now += 200;
		const late = game.fire(1, { weapon: 'pistol', origin: eye, dir, tick: game.tick }, clock.now);
		expect(late.events.some((e) => e.e === 'hit')).toBe(false);
		clock.now += 200;
		const comp = game.fire(1, { weapon: 'pistol', origin: eye, dir, tick: seenTick }, clock.now);
		expect(comp.events.some((e) => e.e === 'hit' && e.zid === z.id)).toBe(true);
	});

	it('the knife one-shots a zombie in reach', () => {
		const { game, clock } = ready();
		game.loadout(1, 'knife', clock.now);
		const z = game.spawnZombie({ x: 60, y: 0, z: 0.25 })!;
		clock.now += 500;
		const r = game.fire(1, { weapon: 'knife', origin: eye, dir: unit(1, 0, -0.3), tick: game.tick }, clock.now);
		expect(r.events.find((e) => e.e === 'kill')).toMatchObject({ zid: z.id, weapon: 'knife' });
	});

	it('loadout locks after the window during a round', () => {
		const { game, clock } = ready();
		expect(game.loadout(1, 'sniper', clock.now).length).toBe(1);
		expect(game.loadout(1, 'lmg', clock.now + 16_000)).toEqual([]);
		expect(game.weaponOf(1)!.weapon).toBe('sniper');
	});
});

describe('zombies_lowtide AI with the real map physics', () => {
	const map = getMap('zombies_lowtide')!;

	it('uses the zombies mode profile', () => {
		expect(map.kind).toBe('zombies');
		expect(GAME_MODES.zombies.cvars).toBe(ZOMBIES_CVARS);
		expect(mapCvars(map).sv_enablebunnyhopping).toBe(0);
	});

	it('a zombie from every spawn area follows the route to a player at the evac point', () => {
		const { game, clock, advance } = newGame(map, { despawnBehind: Infinity, gatesOpen: true });
		game.syncPlayers([1], clock.now);
		advance(1100);
		expect(game.phase).toBe('playing');
		// Just short of the evac zone (standing in it would win the round).
		const goal = { x: 6144, y: 4600, z: 0.25 };
		game.setPlayerPos(1, { ...goal, ducked: false });
		const zs = map.zombies!.spawnZones.map((sz) => {
			const z = game.spawnZombie({ x: (sz.min.x + sz.max.x) / 2, y: (sz.min.y + sz.max.y) / 2, z: sz.min.z + 0.25 });
			expect(z, `spawn area at node ${sz.node} is blocked`).not.toBeNull();
			return { z: z!, node: sz.node };
		});
		const reached = new Set<number>();
		for (let s = 0; s < 90 && reached.size < zs.length; s++) {
			game.setPlayerPos(1, { ...goal, ducked: false });
			// Keep the player alive (this test is about navigation).
			advance(1000);
			const pv = game.playerView(1)!;
			if (!pv.alive) break;
			for (const { z } of zs) {
				const o = z.body.origin;
				if (Math.hypot(o.x - goal.x, o.y - goal.y) < 200) reached.add(z.id);
			}
			// Any zombie that reached the player is removed so it stops hitting.
			for (const id of reached) game.zombies.delete(id);
		}
		const missing = zs.filter(({ z }) => !reached.has(z.id)).map(({ z, node }) => `node ${node} at ${Math.round(z.body.origin.x)},${Math.round(z.body.origin.y)} (${game.zombies.has(z.id) ? 'alive' : 'removed'})`);
		expect(missing).toEqual([]);
	}, 60_000);
});
