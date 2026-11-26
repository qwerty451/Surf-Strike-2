/**
 * Infected client against the real shared rules: a fake clock drives an
 * `InfectedGame`, its events go through `infEventRoute` to one client per
 * player, and client messages go back into the game. The client's
 * predicted state must match what the server rules say.
 */
import {
	buildCollisionWorld,
	INF_AMMO,
	INF_BEACON_COOLDOWN_MS,
	INF_BEACON_HIT_Z,
	INF_INFECTED_HP,
	INF_INFECTED_SPEED,
	INF_INFECTION_BONUS_SECS,
	INF_MOAB_COUNTDOWN_SECS,
	INF_RESPAWN_SECS,
	INF_SECONDARY,
	INF_SLEIGHT_RELOAD_FACTOR,
	INF_SPECIALIST_CADENCE_FACTOR,
	INF_STEADY_SPEED_FACTOR,
	INF_STEADY_SPREAD_FACTOR,
	INF_SURVIVOR_HP,
	infPerksForStreak,
	INF_KNIFE_GRAVITY,
	INF_PRESETS,
	INF_STEP_MS,
	InfectedGame,
	infEventRoute,
	VIEW_HEIGHT,
	WEAPONS,
	type ClientMessage,
	type InfEvent,
	type InfStateView,
	type MapDef,
	type Vec3,
	type WeaponId
} from '@surf/shared';
import { describe, expect, it } from 'vitest';
import type { BeaconRenderPose, InfectedRenderer, SparkKind } from '../render/infected.js';
import type { ZombieRenderer } from '../render/zombies.js';
import { RECOIL, recoilRestMs, SPREAD } from './gunfeel.js';
import { INF_FIRE_TICK_NOW, INF_PERK_INFO, InfectedClient, infectText, infMaxHp, infRole, pelletTracers, stepKnife, type InfHost } from './infected.js';

const SPAWNS = [
	{ pos: { x: -1000, y: -1000, z: 0.25 }, yaw: 0 },
	{ pos: { x: -1000, y: 1000, z: 0.25 }, yaw: 0 },
	{ pos: { x: 1000, y: -1000, z: 0.25 }, yaw: 180 },
	{ pos: { x: 1000, y: 1000, z: 0.25 }, yaw: 180 }
];

/** Flat floor, four spread spawns, a fall-out box far below. */
function testMap(): MapDef {
	return {
		id: 'inf_client_test',
		title: 'Test',
		kind: 'infected',
		difficulty: 'easy',
		layout: 'open',
		cvars: {},
		spawn: SPAWNS[0]!,
		spawns: SPAWNS,
		brushes: [{ type: 'box', min: { x: -1200, y: -1200, z: -64 }, max: { x: 1200, y: 1200, z: 0 }, material: 'm' }],
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

interface Peer {
	c: InfectedClient;
	sent: ClientMessage[];
	uav: number;
	knifeSyncs: number;
	sparks: Array<{ kind: SparkKind; pos: Vec3; dir?: Vec3 }>;
	/** Last `syncBeacons` call. */
	beacons: BeaconSync | null;
	vm: VmRecord;
}

interface BeaconSync {
	list: BeaconRenderPose[];
	selfId: number;
	team: 'survivor' | 'infected';
}

/** What the fake viewmodel renderer was last told. */
interface VmRecord {
	weapon: WeaponId | null;
	offhand: boolean;
	visible: boolean;
	thrown: number;
	fired: number;
	clears: number;
	tracers: Array<{ from: Vec3; to: Vec3 }>;
}

function fakeZombieRenderer(rec: VmRecord): ZombieRenderer {
	return {
		setWeapon: (w: WeaponId | null) => void (rec.weapon = w),
		setOffhandKnife: (v: boolean) => void (rec.offhand = v),
		thrown: () => void rec.thrown++,
		fired: () => void rec.fired++,
		tracer: (from: Vec3, to: Vec3) => void rec.tracers.push({ from: { ...from }, to: { ...to } }),
		updateViewmodel: (_now: number, visible: boolean) => void (rec.visible = visible),
		clear: () => {
			rec.clears++;
			rec.weapon = null;
			rec.offhand = false;
		}
	} as unknown as ZombieRenderer;
}

const vmRecord = (): VmRecord => ({ weapon: null, offhand: false, visible: false, thrown: 0, fired: 0, clears: 0, tracers: [] });

interface HarnessOpts {
	/** Round preset of the first round (default 'lmg': automatic, deep magazine). */
	loadout?: WeaponId;
	moabKills?: number;
	moabCountdownSecs?: number;
}

function harness(ids: number[], opts: HarnessOpts = {}) {
	const map = testMap();
	const world = buildCollisionWorld(map);
	const clock = { now: 1_000_000 };
	const game = new InfectedGame({
		map,
		world,
		now: clock.now,
		rng: () => 0,
		graceSecs: 1,
		endSecs: 1,
		moabKills: opts.moabKills,
		moabCountdownSecs: opts.moabCountdownSecs
	});
	// The first grace plays round `game.round + 1`: pick the preset by its index.
	const first = INF_PRESETS.indexOf(opts.loadout ?? 'lmg');
	if (first < 0) throw new Error('not a preset');
	game.round = first;
	const pos = new Map<number, Vec3>();
	const peers = new Map<number, Peer>();
	const log: InfEvent[] = [];

	const route = (events: InfEvent[]) => {
		for (const ev of events) {
			log.push(ev);
			const r = infEventRoute(ev);
			for (const [id, p] of peers) {
				if (r.to !== undefined && r.to !== id) continue;
				if (r.except !== undefined && r.except === id) continue;
				p.c.onEvent(ev, clock.now);
			}
		}
	};
	const handle = (id: number, msg: ClientMessage) => {
		const now = clock.now;
		switch (msg.type) {
			case 'fire':
				route(game.fire(id, { weapon: msg.weapon, origin: msg.origin, dir: msg.dir, tick: msg.tick }, now).events);
				break;
			case 'throwKnife':
				route(game.throwKnife(id, msg.origin, msg.dir, now).events);
				break;
			case 'loadout':
				route(game.selectWeapon(id, msg.weapon, now));
				break;
			case 'reload':
				game.reload(id, now);
				break;
			case 'placeBeacon':
				route(game.placeBeacon(id, now).events);
				break;
			case 'callMoab':
				route(game.callMoab(id, now).events);
				break;
		}
	};
	const put = (id: number, x: number, y: number, z = 0.25, yaw = 0) => {
		pos.set(id, { x, y, z });
		game.setPlayerPos(id, { x, y, z, ducked: false, yaw });
	};
	for (const id of ids) {
		const peer: Peer = { c: null as unknown as InfectedClient, sent: [], uav: 0, knifeSyncs: 0, sparks: [], beacons: null, vm: vmRecord() };
		const renderer = {
			syncKnives: () => void peer.knifeSyncs++,
			syncBeacons: (list: readonly BeaconRenderPose[], selfId: number, team: 'survivor' | 'infected') =>
				void (peer.beacons = { list: [...list], selfId, team }),
			uavPulse: () => void peer.uav++,
			spark: (pos: Vec3, kind: SparkKind, _now: number, dir?: Vec3) => void peer.sparks.push({ kind, pos, dir }),
			clear: () => {}
		} as unknown as InfectedRenderer;
		const zr = fakeZombieRenderer(peer.vm);
		const host: InfHost = {
			online: () => true,
			selfId: () => id,
			send: (msg) => {
				peer.sent.push(msg);
				handle(id, msg);
			},
			zombieRenderer: () => zr,
			infectedRenderer: () => renderer,
			name: (pid) => `P${pid}`,
			notice: () => {},
			teleport: (x, y, z, yaw) => put(id, x, y, z, yaw),
			sound: () => {},
			setZoom: () => {},
			push: () => {}
		};
		peer.c = new InfectedClient(host, clock.now, world);
		peers.set(id, peer);
	}
	const state = () => {
		const v = game.view(clock.now);
		for (const p of peers.values()) p.c.onModeState(v, clock.now);
	};
	const step = () => {
		clock.now += INF_STEP_MS;
		route(game.update(clock.now));
	};
	const advance = (ms: number) => {
		const end = clock.now + ms;
		while (clock.now < end) step();
		state();
	};
	const peer = (id: number) => peers.get(id)!;
	const view = (id: number) => peer(id).c.frame(clock.now, false, 0);
	/** View angles from `id`'s eye towards a point. */
	const aim = (id: number, t: Vec3) => {
		const o = pos.get(id)!;
		const dx = t.x - o.x;
		const dy = t.y - o.y;
		const dz = t.z - (o.z + VIEW_HEIGHT);
		return { pitch: (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI, yaw: (Math.atan2(dy, dx) * 180) / Math.PI };
	};
	const tick = (id: number, t: Vec3) => {
		const o = pos.get(id)!;
		const a = aim(id, t);
		peer(id).c.tick(clock.now, o, o.z + VIEW_HEIGHT, a.pitch, a.yaw, false);
	};
	/** Hold attack aimed at `t` until `done()` or `maxMs`. */
	const attack = (id: number, t: Vec3, done: () => boolean, maxMs = 3000) => {
		const c = peer(id).c;
		c.press('attack', true, clock.now);
		const end = clock.now + maxMs;
		while (clock.now < end && !done()) {
			tick(id, t);
			step();
		}
		c.press('attack', false, clock.now);
		state();
	};
	const has = (pred: (e: InfEvent) => boolean) => () => log.some(pred);
	game.syncPlayers(ids, clock.now);
	return { game, clock, peers, peer, view, put, pos, advance, step, state, tick, attack, has, log };
}

/** Round playing; rng 0 makes the first id Patient Zero. Players stand close together. */
function playing(ids = [1, 2, 3], opts: HarnessOpts = {}) {
	const h = harness(ids, opts);
	h.advance(1200);
	expect(h.game.phase).toBe('playing');
	h.put(1, 0, 0);
	h.put(2, 150, 0, 0.25, 180);
	h.put(3, -300, 300);
	h.state();
	return h;
}

const body = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z + 36 });

describe('pure helpers', () => {
	it('stepKnife follows the gravity arc', () => {
		const k = { x: 0, y: 0, z: 100, vx: 1000, vy: 0, vz: 0 };
		for (let i = 0; i < 10; i++) stepKnife(k, 0.05);
		expect(k.x).toBeCloseTo(500, 6);
		expect(k.z).toBeCloseTo(100 - 0.5 * INF_KNIFE_GRAVITY * 0.25, 6);
		expect(k.vz).toBeCloseTo(-INF_KNIFE_GRAVITY * 0.5, 6);
	});

	it('roles come from alpha + team, not alphaId', () => {
		expect(infRole(undefined)).toBe('none');
		expect(infRole({ team: 'survivor', alpha: false })).toBe('none');
		expect(infRole({ team: 'infected', alpha: false })).toBe('infected');
		expect(infRole({ team: 'infected', alpha: true })).toBe('alpha');
	});

	it('kill feed text per infection method', () => {
		expect(infectText('you', 'P1', 'claws')).toBe('P1 · claws › you');
		expect(infectText('P2', 'You', 'bank')).toBe('You · bank-shot knife › P2');
		expect(infectText('P2', null, 'claws')).toBe('P2 turned');
	});
});

describe('offline', () => {
	it('solo: free roam, waiting banner, nothing sent for shots or throws', () => {
		const sent: ClientMessage[] = [];
		const host = {
			online: () => false,
			selfId: () => 1,
			send: (m: ClientMessage) => sent.push(m),
			zombieRenderer: () => null,
			infectedRenderer: () => null,
			name: () => 'me',
			notice: () => {},
			teleport: () => {},
			sound: () => {},
			setZoom: () => {},
			push: () => {}
		} satisfies InfHost;
		const c = new InfectedClient(host, 0);
		const v = c.frame(0, true, 0);
		expect(v.phase).toBe('solo');
		expect(v.team).toBe('survivor');
		expect(c.localFallouts).toBe(true);
		expect(c.maxSpeed(0)).toBe(WEAPONS[INF_PRESETS[0]!].moveSpeed);
		c.press('attack', true, 0);
		c.press('attack2', true, 0);
		c.tick(10, { x: 0, y: 0, z: 0 }, 64, 0, 0, false);
		expect(sent).toEqual([]);
		// Weapon swaps still work locally (no message offline).
		expect(c.slot(2, 20)).toBe(true);
		expect(c.weapon).toBe('pistol');
		expect(c.slot(3, 21)).toBe(true);
		expect(c.weapon).toBe('knife');
		expect(sent).toEqual([]);
	});
});

describe('online round (real InfectedGame)', () => {
	it('grace → playing: Patient Zero has claws and the knife, no gun; survivors see the role', () => {
		const h = playing();
		const v1 = h.view(1);
		expect(v1).toMatchObject({ phase: 'playing', team: 'infected', alpha: true, weapon: 'claws', mag: 0, reserve: 0, magSize: 0, hasKnife: true, hp: INF_INFECTED_HP });
		expect(h.game.playerView(1)).toMatchObject({ alpha: true, weapon: 'claws' });
		expect(h.view(2)).toMatchObject({ phase: 'playing', team: 'survivor', alpha: false, weapon: 'lmg', mag: 100, survivors: 2, infected: 1 });
		expect(h.peer(2).c.roleOf(1)).toBe('alpha');
		expect(h.peer(2).c.roleOf(3)).toBe('none');
		expect(h.peer(1).c.maxSpeed(h.clock.now)).toBe(INF_INFECTED_SPEED);
		expect(h.peer(1).vm).toMatchObject({ weapon: 'claws', offhand: true });
		expect(h.peer(2).c.maxSpeed(h.clock.now)).toBe(WEAPONS.lmg.moveSpeed);
		expect(h.view(2).endsAt).toBeGreaterThan(h.clock.now + 100_000);
	});

	it('Patient Zero cannot switch: the slot keys keep the claws and send nothing', () => {
		const h = playing();
		const c1 = h.peer(1).c;
		const sent = h.peer(1).sent.length;
		for (const n of [1, 2, 3]) {
			expect(c1.slot(n, h.clock.now)).toBe(true);
			expect(c1.weapon).toBe('claws');
		}
		c1.reload(h.clock.now);
		expect(h.peer(1).sent).toHaveLength(sent);
		expect(h.view(1)).toMatchObject({ alpha: true, weapon: 'claws', reloadEndsAt: 0 });
		// Mouse1 from afar swings the claws: nobody is hurt or infected.
		h.attack(1, body(h.pos.get(2)!), () => false, 500);
		expect(h.log.some((e) => e.e === 'shot' && e.by === 1 && e.weapon === 'claws')).toBe(true);
		expect(h.log.some((e) => e.e === 'hurt' || e.e === 'infect')).toBe(false);
		expect(h.view(2)).toMatchObject({ team: 'survivor', hp: INF_SURVIVOR_HP });
		// Mouse2 throws the knife.
		c1.press('attack2', true, h.clock.now);
		h.tick(1, { x: 0, y: 500, z: 64 });
		expect(h.peer(1).sent.at(-1)?.type).toBe('throwKnife');
		expect(h.log.some((e) => e.e === 'knifeThrow' && e.ownerId === 1)).toBe(true);
	});

	it('weapon swap keeps primary ammo and cancels a reload', () => {
		const h = playing();
		const c2 = h.peer(2).c;
		h.attack(2, { x: 0, y: 2000, z: 40 }, () => h.game.primaryOf(2)!.mag <= 95, 2000);
		const mag = h.game.primaryOf(2)!.mag;
		expect(h.view(2).mag).toBe(mag);
		c2.reload(h.clock.now);
		expect(h.view(2).reloadEndsAt).toBeGreaterThan(0);
		expect(c2.slot(3, h.clock.now)).toBe(true);
		expect(c2.weapon).toBe('knife');
		expect(h.game.playerView(2)!.weapon).toBe('knife');
		expect(c2.maxSpeed(h.clock.now)).toBe(WEAPONS.knife.moveSpeed);
		h.advance(3000); // a reload would have finished by now
		c2.slot(1, h.clock.now);
		expect(h.view(2)).toMatchObject({ weapon: 'lmg', mag, reserve: h.game.primaryOf(2)!.reserve, reloadEndsAt: 0 });
		expect(h.game.primaryOf(2)!.mag).toBe(mag);
	});

	it('scavenger refill while holding the knife updates the reserve only', () => {
		const h = playing();
		const c2 = h.peer(2).c;
		c2.slot(3, h.clock.now);
		h.put(2, 40, 0, 0.25, 180);
		h.attack(2, body(h.pos.get(1)!), h.has((e) => e.e === 'kill' && e.targetId === 1));
		const scav = h.log.find((e) => e.e === 'ammo' && e.scavenger);
		expect(scav).toMatchObject({ e: 'ammo', id: 2, weapon: 'lmg', scavenger: true });
		const v = h.view(2);
		expect(v.weapon).toBe('knife');
		expect(v.scavengerAt).toBeGreaterThan(0);
		c2.slot(1, h.clock.now);
		const primary = h.game.primaryOf(2)!;
		expect(h.view(2)).toMatchObject({ weapon: 'lmg', mag: primary.mag, reserve: primary.reserve });
		// Before the scavenger perk a kill gives an emergency share of the refill.
		expect(primary.reserve).toBeGreaterThan(INF_AMMO.lmg!.reserve);
		expect(primary.reserve).toBeLessThanOrEqual(WEAPONS.lmg.reserve);
		// The Alpha is down for everyone and respawns.
		expect(h.view(1).alive).toBe(false);
		expect(h.view(1).respawnAt).toBeGreaterThan(h.clock.now);
		expect(h.peer(1).c.down).toBe(true);
		expect(h.peer(3).c.isDown(1)).toBe(true);
	});

	it('scavenger refill with the gun held matches the server ammo', () => {
		const h = playing();
		h.attack(2, body(h.pos.get(1)!), h.has((e) => e.e === 'kill' && e.targetId === 1));
		expect(h.log.some((e) => e.e === 'kill' && e.targetId === 1)).toBe(true);
		const primary = h.game.primaryOf(2)!;
		expect(h.view(2)).toMatchObject({ weapon: 'lmg', mag: primary.mag, reserve: primary.reserve });
		expect(h.view(2).hitMarker).not.toBeNull();
	});

	it('first infection: survivor turns in place, Patient Zero loses the role, clock +20 s', () => {
		const h = playing();
		const c1 = h.peer(1).c;
		const c2 = h.peer(2).c;
		const endsBefore = h.view(3).endsAt;
		expect(c1.weapon).toBe('claws');
		expect(c1.isAlpha).toBe(true);
		h.put(1, 0, 0);
		h.put(2, 40, 0);
		const at = { ...h.pos.get(2)! };
		h.attack(1, body(h.pos.get(2)!), h.has((e) => e.e === 'infect' && e.id === 2));
		expect(h.log.some((e) => e.e === 'infect' && e.id === 2)).toBe(true);
		// Infected in place: no teleport.
		expect(h.pos.get(2)).toEqual(at);
		expect(h.view(2)).toMatchObject({ team: 'infected', alpha: false, weapon: 'claws', hasKnife: true, hp: INF_INFECTED_HP, magSize: 0 });
		expect(c2.maxSpeed(h.clock.now)).toBe(INF_INFECTED_SPEED);
		// The role ends through an ammo 'claws' event only.
		expect(h.log.some((e) => e.e === 'ammo' && e.id === 1 && e.weapon === 'claws')).toBe(true);
		expect(h.view(1)).toMatchObject({ team: 'infected', alpha: false, weapon: 'claws' });
		expect(h.game.playerView(1)).toMatchObject({ alpha: false, weapon: 'claws' });
		expect(c1.slot(1, h.clock.now)).toBe(true);
		expect(c1.weapon).toBe('claws');
		// Remote roles after the state.
		h.state();
		expect(h.peer(3).c.roleOf(1)).toBe('infected');
		expect(h.peer(3).c.roleOf(2)).toBe('infected');
		const v3 = h.view(3);
		expect(v3.timeBonusAt).toBeGreaterThan(0);
		expect(v3.endsAt).toBeGreaterThan(endsBefore + (INF_INFECTION_BONUS_SECS - 5) * 1000);
		expect(v3.killFeed[0]!.text).toContain('P2');
	});

	it('a rejected throw is reconciled from the state; a real throw flies smoothly and infects', () => {
		const h = playing();
		const c2 = h.peer(2).c;
		h.put(1, 0, 0);
		h.put(2, 40, 0);
		h.attack(1, body(h.pos.get(2)!), h.has((e) => e.e === 'infect' && e.id === 2));
		expect(c2.isInfected).toBe(true);
		expect(c2.knifeReady).toBe(true);

		// Rejected: the origin is far from where the server has the player.
		c2.press('attack2', true, h.clock.now);
		c2.tick(h.clock.now, { x: 900, y: 900, z: 0 }, 64, 0, 0, false);
		c2.press('attack2', false, h.clock.now);
		expect(h.peer(2).sent.at(-1)?.type).toBe('throwKnife');
		expect(h.log.some((e) => e.e === 'knifeThrow')).toBe(false);
		expect(c2.knifeReady).toBe(false);
		h.state(); // stale-state grace: still optimistic
		expect(c2.knifeReady).toBe(false);
		h.advance(700);
		expect(c2.knifeReady).toBe(true);
		expect(h.view(2).hasKnife).toBe(true);

		// Real throw at survivor 3 (aimed a little high for the drop).
		h.put(2, -300, 0);
		h.put(3, -300, 250);
		const target = { x: -300, y: 250, z: 52 };
		c2.press('attack2', true, h.clock.now);
		h.tick(2, target);
		c2.press('attack2', false, h.clock.now);
		expect(h.log.some((e) => e.e === 'knifeThrow' && e.ownerId === 2)).toBe(true);
		expect(c2.knifeReady).toBe(false);
		const v = h.view(2);
		expect(v.hasKnife).toBe(false);
		expect(v.knifeOut).toBe(true);
		h.view(3);
		const k0 = { ...h.peer(3).c.knivesNow()[0]! };
		expect(k0.ownerId).toBe(2);
		h.clock.now += 16;
		h.view(3);
		const k1 = h.peer(3).c.knivesNow()[0]!;
		expect(k1.y).toBeGreaterThan(k0.y);
		expect(k1.vz).toBeLessThan(k0.vz);
		expect(h.peer(3).knifeSyncs).toBeGreaterThan(0);

		const deadline = h.clock.now + 1500;
		while (h.clock.now < deadline && !h.log.some((e) => e.e === 'infect' && e.id === 3)) h.step();
		h.state();
		expect(h.log.find((e) => e.e === 'infect' && e.id === 3)).toMatchObject({ by: 2, method: 'knife' });
		expect(h.view(3)).toMatchObject({ team: 'infected', weapon: 'claws' });
		expect(h.peer(3).c.knivesNow()).toHaveLength(0);
		// Everyone is infected: the round ends with a summary.
		expect(h.view(3).summary).toMatchObject({ winner: 'infected', survivorsLeft: 0 });
	});

	it('UAV: infected see the pulse, the last survivor is flagged', () => {
		const h = playing([1, 2, 3, 4]);
		h.put(4, 600, 600);
		h.put(1, 0, 0);
		h.put(2, 40, 0);
		h.attack(1, body(h.pos.get(2)!), h.has((e) => e.e === 'infect' && e.id === 2));
		h.put(1, -300, 260);
		h.put(3, -300, 300);
		h.attack(1, body(h.pos.get(3)!), h.has((e) => e.e === 'infect' && e.id === 3));
		h.advance(200);
		expect(h.log.some((e) => e.e === 'uav' && e.targetId === 4)).toBe(true);
		expect(h.peer(1).uav).toBeGreaterThan(0);
		expect(h.peer(4).uav).toBe(0);
		expect(h.view(4)).toMatchObject({ lastSurvivor: true, team: 'survivor' });
		expect(h.view(4).uavAt).toBeGreaterThan(0);
	});
});

describe('real round: sparks and the off-hand knife', () => {
	it('a knife thrown into the floor sticks with a spark for everyone; walking over it restores the off-hand knife', () => {
		const h = playing();
		h.put(1, 0, 0);
		h.put(2, 40, 0);
		h.attack(1, body(h.pos.get(2)!), h.has((e) => e.e === 'infect' && e.id === 2));
		const c2 = h.peer(2).c;
		h.view(2);
		expect(h.peer(2).vm).toMatchObject({ weapon: 'claws', offhand: true });
		// The knife shows in the left claw of the former Patient Zero too.
		h.view(1);
		expect(h.peer(1).vm).toMatchObject({ weapon: 'claws', offhand: true });

		h.put(2, -300, -300);
		c2.press('attack2', true, h.clock.now);
		h.tick(2, { x: -200, y: -300, z: 0 });
		c2.press('attack2', false, h.clock.now);
		expect(h.peer(2).vm.thrown).toBe(1);
		h.view(2);
		expect(h.peer(2).vm.offhand).toBe(false);

		const deadline = h.clock.now + 2000;
		while (h.clock.now < deadline && !h.log.some((e) => e.e === 'knifeStick')) h.step();
		const stick = h.log.find((e) => e.e === 'knifeStick');
		expect(stick).toBeDefined();
		for (const id of [1, 2, 3]) expect(h.peer(id).sparks.some((s) => s.kind === 'stick')).toBe(true);
		// The stick glint knows the flight direction (the throw was seen).
		expect(h.peer(3).sparks.find((s) => s.kind === 'stick')!.dir).toBeDefined();
		h.state();
		expect(h.view(2)).toMatchObject({ hasKnife: false, knifeOut: true });

		if (stick?.e !== 'knifeStick') throw new Error('no stick');
		h.put(2, stick.x, stick.y);
		const pickBy = h.clock.now + 3000;
		while (h.clock.now < pickBy && !h.log.some((e) => e.e === 'knifePickup')) h.step();
		expect(h.log.some((e) => e.e === 'knifePickup' && e.ownerId === 2)).toBe(true);
		const v = h.view(2);
		expect(v).toMatchObject({ hasKnife: true, knifeOut: false });
		expect(v.flash?.text).toBe('Throwing knife retrieved');
		expect(h.peer(2).vm.offhand).toBe(true);
		expect(h.peer(3).c.knivesNow()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Synthetic server: one client, hand-built events and states.

type PlayerView = InfStateView['players'][number];

const pv = (id: number, over: Partial<PlayerView> = {}): PlayerView => ({
	id,
	team: 'survivor',
	alpha: false,
	hp: 5,
	alive: true,
	score: 0,
	kills: 0,
	deaths: 0,
	weapon: 'lmg',
	hasKnife: false,
	hasBeacon: false,
	streak: 0,
	perks: [],
	moabReady: false,
	...over
});

const st = (over: Partial<InfStateView> = {}): InfStateView => ({
	phase: 'playing',
	round: 1,
	timeLeft: 120,
	loadout: 'lmg',
	secondary: 'pistol',
	moab: null,
	alphaId: null,
	survivors: 2,
	infected: 1,
	players: [],
	knives: [],
	beacons: [],
	...over
});

const spawnEv = (id: number, over: Partial<Extract<InfEvent, { e: 'spawn' }>> = {}): InfEvent => ({
	e: 'spawn',
	id,
	x: 0,
	y: 0,
	z: 0,
	yaw: 0,
	hp: 5,
	team: 'survivor',
	alpha: false,
	weapon: 'lmg',
	mag: 100,
	reserve: 100,
	hasKnife: false,
	reason: 'round',
	...over
});

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

function unit(selfId = 1) {
	const sent: ClientMessage[] = [];
	const zoom: Array<number | null> = [];
	const sounds: string[] = [];
	const teleports: Vec3[] = [];
	const sparks: Peer['sparks'] = [];
	const counts = { clears: 0, uav: 0 };
	const beacons: { last: BeaconSync | null } = { last: null };
	const vm = vmRecord();
	const zr = fakeZombieRenderer(vm);
	const renderer = {
		syncKnives: () => {},
		syncBeacons: (list: readonly BeaconRenderPose[], selfId: number, team: 'survivor' | 'infected') =>
			void (beacons.last = { list: [...list], selfId, team }),
		uavPulse: () => void counts.uav++,
		spark: (pos: Vec3, kind: SparkKind, _now: number, dir?: Vec3) => void sparks.push({ kind, pos, dir }),
		clear: () => void counts.clears++
	} as unknown as InfectedRenderer;
	const host: InfHost = {
		online: () => true,
		selfId: () => selfId,
		send: (m) => sent.push(m),
		zombieRenderer: () => zr,
		infectedRenderer: () => renderer,
		name: (id) => `P${id}`,
		notice: () => {},
		teleport: (x, y, z) => teleports.push({ x, y, z }),
		sound: (n) => sounds.push(n),
		setZoom: (f) => zoom.push(f),
		push: () => {}
	};
	const c = new InfectedClient(host, 0);
	const sentTypes = () => sent.map((m) => m.type);
	return { c, sent, sentTypes, zoom, sounds, teleports, sparks, counts, vm, beacons };
}

/** Me (id 1) as a playing infected holding claws and the throwing knife. */
function infectedMe(now = 100) {
	const u = unit();
	u.c.onModeState(st({ players: [pv(1, { team: 'infected', weapon: 'claws', hasKnife: true }), pv(2)] }), now);
	u.c.onEvent(spawnEv(1, { team: 'infected', weapon: 'claws', hasKnife: true, mag: 0, reserve: 0, reason: 'respawn' }), now);
	return u;
}

describe('spectating', () => {
	it('shows the target role/HP/score/weapon, hides the viewmodel and unscopes', () => {
		const u = unit();
		u.c.onModeState(st({ loadout: 'sniper', players: [pv(1, { weapon: 'sniper' }), pv(2, { team: 'infected', alpha: true, hp: 3, score: 7, weapon: 'sniper', hasKnife: true })] }), 0);
		u.c.onEvent(spawnEv(1, { weapon: 'sniper', mag: 5, reserve: 20 }), 0);
		u.c.press('attack2', true, 10);
		expect(u.zoom).toEqual([WEAPONS.sniper.zoomFov]);
		expect(u.c.frame(10, true, 0).scoped).toBe(true);

		u.c.setSpectate(true, 2);
		expect(u.zoom.at(-1)).toBeNull();
		const v = u.c.frame(20, true, 0);
		expect(v).toMatchObject({ spectating: true, scoped: false });
		expect(v.spec).toEqual({
			id: 2,
			name: 'P2',
			team: 'infected',
			alpha: true,
			hp: 3,
			maxHp: INF_INFECTED_HP,
			alive: true,
			score: 7,
			weapon: 'sniper',
			weaponLabel: WEAPONS.sniper.label,
			hasKnife: true,
			hasBeacon: false,
			streak: 0,
			perks: [],
			moabReady: false
		});
		expect(u.vm.visible).toBe(false);
		expect(u.c.isSpectating).toBe(true);

		// Switching targets rebuilds the view even without a new state.
		u.c.onModeState(st({ players: [pv(1, { weapon: 'sniper' }), pv(2, { team: 'infected', alpha: true }), pv(3, { score: 4 })] }), 30);
		u.c.setSpectate(true, 3);
		expect(u.c.frame(30, true, 0).spec).toMatchObject({ id: 3, team: 'survivor', score: 4, alpha: false, hasKnife: false });

		// Free-fly: still spectating, no target. Self as "target" is not a spectate target.
		u.c.setSpectate(true, null);
		expect(u.c.frame(40, true, 0)).toMatchObject({ spectating: true, spec: null });
		u.c.setSpectate(true, 1);
		expect(u.c.frame(41, true, 0).spec).toBeNull();

		u.c.setSpectate(false, null);
		const back = u.c.frame(50, true, 0);
		expect(back).toMatchObject({ spectating: false, spec: null });
		expect(u.vm.visible).toBe(true);
	});

	it('ignores local fire, throw, reload and slot input while spectating', () => {
		const u = infectedMe();
		u.c.setSpectate(true, 2);
		u.c.press('attack', true, 200);
		u.c.press('attack2', true, 200);
		u.c.tick(210, ORIGIN, 64, 0, 0, false);
		u.c.reload(220);
		expect(u.c.slot(1, 230)).toBe(false); // number keys fall through (map vote)
		expect(u.sent).toEqual([]);
		expect(u.c.knifeReady).toBe(true);
		// Input pressed before spectating does not fire once it ends.
		u.c.setSpectate(false, null);
		u.c.tick(240, ORIGIN, 64, 0, 0, false);
		expect(u.sent).toEqual([]);
		// Back in control: the throw works again.
		u.c.press('attack2', true, 250);
		u.c.tick(260, ORIGIN, 64, 0, 0, false);
		expect(u.sentTypes()).toEqual(['throwKnife']);
	});
});

describe('throwing knife client', () => {
	it('off-hand knife: shown with claws, gone on the throw, back on pickup', () => {
		const u = infectedMe();
		u.c.frame(110, true, 0);
		expect(u.vm).toMatchObject({ weapon: 'claws', offhand: true, visible: true });
		u.c.press('attack2', true, 120);
		u.c.tick(130, ORIGIN, 64, 0, 0, false);
		expect(u.vm.thrown).toBe(1);
		expect(u.sounds).toContain('throw');
		u.c.frame(131, true, 0);
		expect(u.vm.offhand).toBe(false);
		// A stale state within the grace window does not give the knife back.
		u.c.onModeState(st({ players: [pv(1, { team: 'infected', weapon: 'claws', hasKnife: true })] }), 200);
		expect(u.c.knifeReady).toBe(false);
		u.c.onEvent({ e: 'knifeThrow', id: 5, ownerId: 1, x: 0, y: 0, z: 64, vx: 900, vy: 0, vz: 100 }, 210);
		expect(u.c.frame(220, true, 0)).toMatchObject({ hasKnife: false, knifeOut: true });
		u.c.onEvent({ e: 'knifePickup', id: 5, ownerId: 1 }, 400);
		const v = u.c.frame(410, true, 0);
		expect(v).toMatchObject({ hasKnife: true, knifeOut: false });
		expect(u.vm.offhand).toBe(true);
		expect(u.c.knivesNow()).toHaveLength(0);
	});

	it('the off-hand knife is off for survivors, while down, and with the Alpha gun', () => {
		const u = unit();
		u.c.onModeState(st({ players: [pv(1)] }), 0);
		u.c.frame(1, true, 0);
		expect(u.vm.offhand).toBe(false);
		const i = infectedMe();
		i.c.onEvent({ e: 'kill', by: 2, targetId: 1, weapon: 'lmg', head: false, x: 0, y: 0, z: 0, yaw: 0 }, 300);
		i.c.frame(301, true, 0);
		expect(i.vm).toMatchObject({ offhand: false, visible: false });
		expect(i.c.down).toBe(true);
		i.c.onEvent(spawnEv(1, { team: 'infected', weapon: 'claws', hasKnife: true, reason: 'respawn' }), 3400);
		const v = i.c.frame(3401, true, 0);
		expect(v.flash?.text).toContain('Respawned');
		expect(i.vm.offhand).toBe(true);
		expect(i.teleports).toHaveLength(2);
	});

	it('bounce and stick sparks, drift snap only past 160 units, knifeRemove, missing-knife slack', () => {
		const u = infectedMe();
		u.c.onEvent({ e: 'knifeThrow', id: 7, ownerId: 2, x: 0, y: 0, z: 64, vx: 0, vy: 0, vz: 0 }, 1000);
		u.c.frame(1000, false, 0);
		u.c.onEvent({ e: 'knifeBounce', id: 7, x: 10, y: 0, z: 64, vx: -300, vy: 50, vz: 120 }, 1010);
		expect(u.sparks).toEqual([{ kind: 'bounce', pos: { x: 10, y: 0, z: 64 }, dir: { x: -300, y: 50, z: 120 } }]);
		u.c.onEvent({ e: 'knifeStick', id: 7, ownerId: 2, x: 4, y: 1, z: 60, pitch: 20, yaw: 170 }, 1020);
		expect(u.sparks[1]).toEqual({ kind: 'stick', pos: { x: 4, y: 1, z: 60 }, dir: { x: -300, y: 50, z: 120 } });
		// Bounce/stick for a knife this client never saw: still a spark, the stuck knife appears.
		u.c.onEvent({ e: 'knifeBounce', id: 99, x: 1, y: 2, z: 3, vx: 0, vy: 0, vz: 1 }, 1030);
		u.c.onEvent({ e: 'knifeStick', id: 98, ownerId: 3, x: 50, y: 50, z: 0, pitch: 80, yaw: 0 }, 1030);
		expect(u.sparks.map((s) => s.kind)).toEqual(['bounce', 'stick', 'bounce', 'stick']);
		expect(u.sparks[3]!.dir).toBeUndefined();
		u.c.frame(1030, false, 0);
		expect(u.c.knivesNow().map((k) => k.id).sort()).toEqual([7, 98]);

		// Flying knife drift: small error keeps the local arc, a big one snaps.
		u.c.onEvent({ e: 'knifeThrow', id: 8, ownerId: 2, x: 0, y: 0, z: 200, vx: 0, vy: 0, vz: 0 }, 1040);
		const flying = (x: number) => ({ id: 8, ownerId: 2, x, y: 0, z: 200, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0, stuck: false });
		const stuck7 = { id: 7, ownerId: 2, x: 4, y: 1, z: 60, vx: 0, vy: 0, vz: 0, pitch: 20, yaw: 170, stuck: true };
		const stuck98 = { id: 98, ownerId: 3, x: 50, y: 50, z: 0, vx: 0, vy: 0, vz: 0, pitch: 80, yaw: 0, stuck: true };
		u.c.onModeState(st({ players: [pv(1, { team: 'infected', weapon: 'claws' })], knives: [stuck7, stuck98, flying(150)] }), 1050);
		u.c.frame(1050, false, 0);
		expect(u.c.knivesNow().find((k) => k.id === 8)!.x).toBe(0);
		u.c.onModeState(st({ players: [pv(1, { team: 'infected', weapon: 'claws' })], knives: [stuck7, stuck98, flying(170)] }), 1060);
		u.c.frame(1060, false, 0);
		expect(u.c.knivesNow().find((k) => k.id === 8)!.x).toBe(170);

		u.c.onEvent({ e: 'knifeRemove', id: 8 }, 1070);
		u.c.frame(1070, false, 0);
		expect(u.c.knivesNow().map((k) => k.id).sort()).toEqual([7, 98]);

		// A knife missing from the state is kept for the ordering slack, then dropped.
		u.c.onModeState(st({ knives: [stuck7] }), 1100);
		u.c.frame(1100, false, 0);
		expect(u.c.knivesNow().map((k) => k.id).sort()).toEqual([7, 98]);
		u.c.onModeState(st({ knives: [stuck7] }), 1700);
		u.c.frame(1700, false, 0);
		expect(u.c.knivesNow().map((k) => k.id)).toEqual([7]);
	});

	it('Alpha: claws from the `alpha` event even with a gun in hand; Mouse2 throws the knife and never scopes', () => {
		const u = unit();
		u.c.onModeState(st({ loadout: 'sniper', players: [pv(1, { weapon: 'sniper' }), pv(2)] }), 0);
		u.c.onEvent(spawnEv(1, { weapon: 'sniper', mag: 5, reserve: 20 }), 0);
		u.c.press('attack2', true, 1);
		expect(u.zoom).toEqual([WEAPONS.sniper.zoomFov]);
		u.c.press('attack2', false, 2);
		u.c.onEvent({ e: 'alpha', id: 1 }, 5);
		expect(u.c.isAlpha).toBe(true);
		expect(u.c.weapon).toBe('claws');
		expect(u.zoom.at(-1)).toBeNull(); // the swap unscopes
		expect(u.c.maxSpeed(6)).toBe(INF_INFECTED_SPEED);
		u.c.onModeState(st({ loadout: 'sniper', players: [pv(1, { team: 'infected', alpha: true, weapon: 'claws', hasKnife: true }), pv(2)] }), 8);
		expect(u.c.frame(9, true, 0)).toMatchObject({ alpha: true, weapon: 'claws', hasKnife: true });
		expect(u.vm).toMatchObject({ weapon: 'claws', offhand: true });
		const zooms = u.zoom.length;
		u.c.press('attack2', true, 10);
		u.c.tick(20, ORIGIN, 64, 0, 0, false);
		expect(u.sentTypes()).toEqual(['throwKnife']);
		u.c.frame(21, true, 0);
		expect(u.vm.offhand).toBe(false);
		u.c.press('attack2', false, 30);
		u.c.press('attack2', true, 40);
		expect(u.zoom).toHaveLength(zooms);
		expect(u.c.frame(50, true, 0)).toMatchObject({ scoped: false, hasKnife: false, alpha: true, weapon: 'claws' });
		// Respawning as Patient Zero: claws again.
		u.c.onEvent(spawnEv(1, { team: 'infected', alpha: true, weapon: 'claws', hasKnife: true, mag: 0, reserve: 0, reason: 'respawn' }), 100);
		expect(u.c.frame(110, true, 0)).toMatchObject({ alpha: true, weapon: 'claws', hasKnife: true });
	});

	it('Alpha of an older server: a state or spawn with a gun keeps the gun until the ammo claws event', () => {
		const u = unit();
		u.c.onModeState(st({ loadout: 'sniper', players: [pv(1, { team: 'infected', alpha: true, weapon: 'sniper', hasKnife: true }), pv(2)] }), 0);
		u.c.onEvent(spawnEv(1, { team: 'infected', alpha: true, weapon: 'sniper', hasKnife: true, mag: 5, reserve: 20 }), 0);
		expect(u.c.isAlpha).toBe(true);
		expect(u.c.weapon).toBe('sniper');
		expect(u.c.maxSpeed(1)).toBe(WEAPONS.sniper.moveSpeed);
		u.c.frame(5, true, 0);
		expect(u.vm.offhand).toBe(false); // a gun, not claws
		u.c.press('attack2', true, 10);
		u.c.tick(20, ORIGIN, 64, 0, 0, false);
		expect(u.sentTypes()).toEqual(['throwKnife']);
		expect(u.zoom).toEqual([]);
		u.c.press('attack2', false, 30);
		expect(u.zoom).toEqual([]);
		u.c.press('attack2', true, 40);
		expect(u.zoom).toEqual([WEAPONS.sniper.zoomFov]);
		expect(u.c.frame(50, true, 0)).toMatchObject({ scoped: true, hasKnife: false, alpha: true });
		// Held aim (the default): letting go of Mouse2 brings the scope down.
		u.c.press('attack2', false, 60);
		expect(u.zoom.at(-1)).toBeNull();
		u.c.onEvent({ e: 'ammo', id: 1, weapon: 'claws', mag: 0, reserve: 0 }, 70);
		expect(u.c.weapon).toBe('claws');
		expect(u.c.isAlpha).toBe(false);
	});
});

describe('round flow', () => {
	it('kill feed badges for knife and bank-shot infections only', () => {
		const u = infectedMe();
		u.c.onEvent({ e: 'infect', id: 3, by: 2, method: 'bank', timeAdded: 20 }, 200);
		u.c.onEvent({ e: 'infect', id: 4, by: 1, method: 'knife', timeAdded: 20 }, 210);
		u.c.onEvent({ e: 'infect', id: 5, by: 2, method: 'claws', timeAdded: 20 }, 220);
		u.c.onEvent({ e: 'infect', id: 6, by: null, method: 'claws', timeAdded: 0 }, 230);
		const feed = u.c.frame(240, false, 0).killFeed;
		expect(feed.map((l) => l.badge ?? null)).toEqual([null, null, { kind: 'knife', by: 'You', victim: 'P4' }, { kind: 'bank', by: 'P2', victim: 'P3' }]);
		expect(feed[3]!.text).toBe('P2 · bank-shot knife › P3');
		expect(feed[2]!.mine).toBe(true);
	});

	it('ended → grace → playing resets feed, summary, UAV, slow stacks and knives', () => {
		const u = infectedMe();
		const base = u.c.maxSpeed(150);
		u.c.tick(200, ORIGIN, 64, 0, 0, false);
		u.c.onEvent({ e: 'uav', targetId: 2, x: 300, y: 400, z: 64 }, 210);
		expect(u.counts.uav).toBe(1);
		u.c.onEvent({ e: 'hurt', id: 1, hp: 3, stacks: 3, kx: 0, ky: 0 }, 220);
		expect(u.c.maxSpeed(230)).toBeLessThan(base);
		u.c.onEvent({ e: 'infect', id: 2, by: 1, method: 'knife', timeAdded: 20 }, 230);
		u.c.onEvent({ e: 'knifeThrow', id: 9, ownerId: 1, x: 0, y: 0, z: 64, vx: 100, vy: 0, vz: 0 }, 240);
		u.c.onEvent({ e: 'hit', by: 1, targetId: 2, head: true, kill: false }, 240);
		const mid = u.c.frame(250, false, 0);
		expect(mid).toMatchObject({ uavDist: 500 });
		expect(mid.uavAt).toBeGreaterThan(0);
		expect(mid.killFeed).toHaveLength(1);

		u.c.onEvent({ e: 'end', winner: 'infected', round: 1, secs: 90, survivorsLeft: 0, topId: 1, topScore: 12 }, 300);
		u.c.onEvent({ e: 'phase', phase: 'ended', round: 1, loadout: 'lmg' }, 300);
		const ended = u.c.frame(310, false, 0);
		expect(ended.summary).toEqual({ winner: 'infected', secs: 90, survivorsLeft: 0, top: 'You (12)' });
		expect(ended.flash).toMatchObject({ text: 'Everyone is infected!', tone: 'bonus' });
		expect(u.c.knivesNow()).toHaveLength(0);

		const clears = u.counts.clears;
		u.c.onEvent({ e: 'phase', phase: 'grace', round: 2, loadout: 'sniper' }, 400);
		const grace = u.c.frame(410, false, 0);
		expect(u.counts.clears).toBe(clears + 1);
		expect(grace).toMatchObject({ phase: 'grace', round: 2, loadout: 'sniper', summary: null, uavAt: 0, uavDist: null, hurtAt: 0, hitMarker: null, timeBonusAt: 0 });
		expect(grace.killFeed).toEqual([]);
		expect(grace.flash?.text).toContain('Round 2');
		expect(u.c.maxSpeed(420)).toBe(base);

		u.c.onEvent({ e: 'phase', phase: 'playing', round: 2, loadout: 'sniper' }, 1400);
		expect(u.c.frame(1410, false, 0)).toMatchObject({ phase: 'playing', flash: { text: 'Patient Zero is loose!' } });
	});

	it('waiting ↔ playing toggles local fall-outs; waiting drops knives and the summary', () => {
		const u = unit();
		expect(u.c.frame(0, false, 0).phase).toBe('waiting');
		expect(u.c.localFallouts).toBe(true);
		// Waiting: no shots reach the server.
		u.c.press('attack', true, 1);
		u.c.tick(2, ORIGIN, 64, 0, 0, false);
		expect(u.sent).toEqual([]);
		u.c.press('attack', false, 3);
		u.c.onModeState(st(), 10);
		expect(u.c.localFallouts).toBe(false);
		u.c.onEvent({ e: 'knifeThrow', id: 1, ownerId: 2, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }, 20);
		u.c.onEvent({ e: 'end', winner: 'survivors', round: 1, secs: 120, survivorsLeft: 2, topId: null, topScore: 0 }, 30);
		u.c.onEvent({ e: 'phase', phase: 'waiting', round: 1, loadout: 'lmg' }, 40);
		const v = u.c.frame(50, false, 0);
		expect(v).toMatchObject({ phase: 'waiting', summary: null, endsAt: 0 });
		expect(u.c.knivesNow()).toHaveLength(0);
		expect(u.c.localFallouts).toBe(true);
	});

	it('low time: endsAt counts down from the state and +20 s bumps it', () => {
		const u = unit();
		u.c.onModeState(st({ timeLeft: 14 }), 1000);
		const v = u.c.frame(1000, false, 0);
		expect(v.endsAt).toBe(15_000);
		u.c.onEvent({ e: 'infect', id: 2, by: 3, method: 'claws', timeAdded: 20 }, 1100);
		const b = u.c.frame(1100, false, 0);
		expect(b.endsAt).toBe(35_000);
		expect(b.timeBonusAt).toBe(1100);
	});
});

describe('disposal (map switch)', () => {
	it('unscopes, clears knives and both renderers, drops the off-hand knife', () => {
		const u = infectedMe();
		u.c.onEvent({ e: 'knifeThrow', id: 3, ownerId: 2, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }, 200);
		u.c.frame(210, true, 0);
		expect(u.vm.offhand).toBe(true);
		expect(u.c.knivesNow()).toHaveLength(1);
		u.c.dispose();
		expect(u.counts.clears).toBe(1);
		expect(u.vm).toMatchObject({ clears: 1, offhand: false, weapon: null });
		expect(u.c.knivesNow()).toHaveLength(0);
	});

	it('resets the zoom when disposed while scoped', () => {
		const u = unit();
		u.c.onModeState(st({ loadout: 'sniper', players: [pv(1, { weapon: 'sniper' })] }), 0);
		u.c.onEvent(spawnEv(1, { weapon: 'sniper', mag: 5, reserve: 20 }), 0);
		u.c.press('attack2', true, 10);
		expect(u.zoom).toEqual([WEAPONS.sniper.zoomFov]);
		u.c.dispose();
		expect(u.zoom).toEqual([WEAPONS.sniper.zoomFov, null]);
	});
});

// ---------------------------------------------------------------------------
// Respawn beacons

const placeEv = (id: number, ownerId: number, x = 100, y = 0, z = 0, yaw = 90): InfEvent => ({ e: 'beaconPlace', id, ownerId, x, y, z, yaw });

describe('respawn beacon client (real InfectedGame)', () => {
	it('E plants at the feet, a survivor smashes it: spark, +50 flash, killfeed, owner alert', () => {
		const h = playing();
		const p1 = h.peer(1);
		// Patient Zero plants; the client throttles a second press.
		expect(p1.c.placeBeacon(h.clock.now)).toBe(true);
		expect(p1.c.placeBeacon(h.clock.now + 10)).toBe(false);
		expect(p1.sent.filter((m) => m.type === 'placeBeacon')).toHaveLength(1);
		const placed = h.log.find((e): e is Extract<InfEvent, { e: 'beaconPlace' }> => e.e === 'beaconPlace');
		expect(placed).toMatchObject({ ownerId: 1, x: 0, y: 0 });
		expect(placed!.z).toBeCloseTo(0, 0);
		expect(p1.c.beaconPlanted).toBe(true);
		const v1 = h.view(1);
		expect(v1).toMatchObject({ hasBeacon: true, flash: { text: 'Respawn beacon planted', tone: 'bonus' } });
		// Everyone draws it; the owner's own view marks it as theirs.
		expect(p1.beacons).toMatchObject({ selfId: 1, team: 'infected', list: [{ id: placed!.id, ownerId: 1 }] });
		h.view(2);
		expect(h.peer(2).beacons).toMatchObject({ selfId: 2, team: 'survivor', list: [{ id: placed!.id }] });

		// The owner walks off; survivor 2 shoots the beacon.
		h.put(1, -600, -600);
		h.state();
		expect(h.view(1).hasBeacon).toBe(true);
		const target = { x: placed!.x, y: placed!.y, z: placed!.z + INF_BEACON_HIT_Z };
		h.attack(2, target, h.has((e) => e.e === 'beaconDestroy'));
		const destroyed = h.log.find((e): e is Extract<InfEvent, { e: 'beaconDestroy' }> => e.e === 'beaconDestroy');
		expect(destroyed).toMatchObject({ ownerId: 1, by: 2 });

		const v2 = h.view(2);
		expect(v2.flash).toMatchObject({ text: 'Beacon destroyed! +50', tone: 'survivor' });
		expect(v2.killFeed[0]).toMatchObject({ text: "You · Destroyed P1's beacon (+50)", mine: true });
		expect(h.peer(2).sparks.find((sp) => sp.kind === 'beacon')?.pos).toEqual(target);
		expect(h.peer(2).beacons!.list).toEqual([]);

		const v1b = h.view(1);
		expect(v1b).toMatchObject({ hasBeacon: false, beaconDist: null, flash: { text: 'Your respawn beacon was destroyed!', tone: 'infected' } });
		expect(p1.sparks.some((sp) => sp.kind === 'beacon')).toBe(true);
	});

	it('survivors cannot plant; nothing is sent', () => {
		const h = playing();
		expect(h.peer(2).c.placeBeacon(h.clock.now)).toBe(false);
		expect(h.peer(2).sent.some((m) => m.type === 'placeBeacon')).toBe(false);
	});
});

describe('respawn beacon client (synthetic)', () => {
	it('gates: offline-solo, spectating, dead, survivor, not playing; cooldown mirrors the server', () => {
		const u = infectedMe();
		u.c.setSpectate(true, 2);
		expect(u.c.placeBeacon(200)).toBe(false);
		u.c.setSpectate(false, null);
		expect(u.c.placeBeacon(210)).toBe(true);
		expect(u.c.placeBeacon(210 + INF_BEACON_COOLDOWN_MS - 1)).toBe(false);
		expect(u.c.placeBeacon(210 + INF_BEACON_COOLDOWN_MS)).toBe(true);
		expect(u.sentTypes()).toEqual(['placeBeacon', 'placeBeacon']);
		u.c.onEvent({ e: 'kill', by: 2, targetId: 1, weapon: 'lmg', head: false, x: 0, y: 0, z: 0, yaw: 0 }, 5000);
		expect(u.c.placeBeacon(9000)).toBe(false);

		const s = unit();
		s.c.onModeState(st({ players: [pv(1)] }), 0);
		expect(s.c.placeBeacon(10)).toBe(false);
		const w = unit();
		w.c.onModeState(st({ phase: 'grace', players: [pv(1, { team: 'infected', weapon: 'claws' })] }), 0);
		expect(w.c.placeBeacon(10)).toBe(false);
		expect([...s.sent, ...w.sent]).toEqual([]);
	});

	it('plant, replace (quiet cleanup), distance in metres from my feet', () => {
		const u = infectedMe();
		u.c.tick(150, { x: 0, y: 0, z: 64 }, 128, 0, 0, false);
		// Planted where I stand reads 0 m, not the eye height.
		u.c.onEvent(placeEv(10, 1, 0, 0, 64), 160);
		expect(u.c.frame(170, false, 0).beaconDist).toBe(0);
		u.c.onEvent({ e: 'beaconDestroy', id: 10, ownerId: 1, by: null, x: 0, y: 0, z: 64 }, 200);
		u.c.onEvent(placeEv(1, 1, 3937, 0, 64), 200);
		let v = u.c.frame(210, false, 0);
		expect(v).toMatchObject({ hasBeacon: true, beaconDist: 100, flash: { text: 'Respawn beacon planted' } });
		expect(u.sounds).toContain('beacon');
		expect(u.beacons.last).toMatchObject({ selfId: 1, team: 'infected', list: [{ id: 1, ownerId: 1, x: 3937, yaw: 90 }] });
		// Re-plant: the server cleans the old one (by null: no spark, no alert), then places the new one.
		u.c.onEvent({ e: 'beaconDestroy', id: 1, ownerId: 1, by: null, x: 3937, y: 0, z: 64 }, 300);
		u.c.onEvent(placeEv(2, 1, 0, 787.4, 64), 300);
		v = u.c.frame(310, false, 0);
		expect(u.sparks).toEqual([]);
		expect(v).toMatchObject({ hasBeacon: true, beaconDist: 20 });
		expect(u.beacons.last!.list.map((b) => b.id)).toEqual([2]);
		// Someone else's beacon shows up, but is not mine.
		u.c.onEvent(placeEv(3, 2, 50, 50, 0), 320);
		u.c.frame(330, false, 0);
		expect(u.beacons.last!.list.map((b) => b.id).sort()).toEqual([2, 3]);
		expect(u.c.beaconPlanted).toBe(true);
	});

	it('respawning on the beacon consumes it: beaconUse burst, spawn reason beacon', () => {
		const u = infectedMe();
		u.c.onEvent(placeEv(4, 1, 100, 200, 0), 200);
		u.c.onEvent({ e: 'kill', by: 2, targetId: 1, weapon: 'lmg', head: false, x: 0, y: 0, z: 0, yaw: 0 }, 300);
		expect(u.c.frame(310, false, 0).hasBeacon).toBe(true); // it survives my death
		u.c.onEvent({ e: 'beaconUse', id: 4, ownerId: 1, x: 100, y: 200, z: 0 }, 3300);
		u.c.onEvent(spawnEv(1, { team: 'infected', weapon: 'claws', hasKnife: true, x: 100, y: 200, z: 0.25, reason: 'beacon' }), 3300);
		const v = u.c.frame(3310, false, 0);
		expect(v).toMatchObject({ alive: true, hasBeacon: false, beaconDist: null, flash: { text: 'Respawned at your beacon!', tone: 'bonus' } });
		expect(u.sparks).toEqual([{ kind: 'beacon', pos: { x: 100, y: 200, z: INF_BEACON_HIT_Z }, dir: undefined }]);
		expect(u.teleports.at(-1)).toEqual({ x: 100, y: 200, z: 0.25 });
		expect(u.beacons.last!.list).toEqual([]);
		// A spawn reason 'beacon' alone (beaconUse missed) still clears the flag.
		const m = infectedMe();
		m.c.onEvent(placeEv(5, 1), 200);
		m.c.onEvent(spawnEv(1, { team: 'infected', weapon: 'claws', reason: 'beacon' }), 300);
		expect(m.c.frame(310, false, 0)).toMatchObject({ hasBeacon: false, flash: { text: 'Respawned at your beacon!' } });
	});

	it("someone else's beacon smashed by a third player: spark only, no flash for me", () => {
		const u = infectedMe();
		u.c.onEvent(placeEv(6, 2, 10, 20, 30), 200);
		u.c.onEvent({ e: 'beaconDestroy', id: 6, ownerId: 2, by: 3, x: 10, y: 20, z: 30 }, 300);
		const v = u.c.frame(310, false, 0);
		expect(u.sparks.map((sp) => sp.kind)).toEqual(['beacon']);
		expect(v.flash?.text).not.toContain('eacon');
		expect(v.killFeed).toEqual([]);
	});

	it('modeState syncs beacons and hasBeacon; spectating shows the target and follows its eyes', () => {
		const u = infectedMe();
		const b = { id: 9, ownerId: 2, x: 1, y: 2, z: 3, yaw: 45 };
		u.c.onModeState(st({ players: [pv(1, { team: 'infected', weapon: 'claws' }), pv(2, { team: 'infected', weapon: 'claws', hasBeacon: true })], beacons: [b] }), 200);
		u.c.frame(210, false, 0);
		expect(u.beacons.last).toEqual({ list: [b], selfId: 1, team: 'infected' });
		u.c.setSpectate(true, 2);
		const v = u.c.frame(220, false, 0);
		expect(v.spec).toMatchObject({ id: 2, hasBeacon: true });
		expect(u.beacons.last).toMatchObject({ selfId: 2, team: 'infected' });
		// A survivor target: survivor viewer team, no beacon.
		u.c.onModeState(st({ players: [pv(1, { team: 'infected', weapon: 'claws' }), pv(3)], beacons: [b] }), 230);
		u.c.setSpectate(true, 3);
		expect(u.c.frame(240, false, 0).spec).toMatchObject({ id: 3, hasBeacon: false });
		expect(u.beacons.last).toMatchObject({ selfId: 3, team: 'survivor' });
		// The state wins over stale local beacons.
		u.c.onModeState(st({ players: [pv(1, { team: 'infected', weapon: 'claws', hasBeacon: false })], beacons: [] }), 250);
		u.c.frame(260, false, 0);
		expect(u.beacons.last!.list).toEqual([]);
	});

	it('round end, grace, waiting and dispose (map switch) clear beacons', () => {
		for (const reset of ['ended', 'grace', 'waiting', 'dispose'] as const) {
			const u = infectedMe();
			u.c.onEvent(placeEv(1, 1), 200);
			u.c.onEvent(placeEv(2, 2), 200);
			expect(u.c.frame(210, false, 0).hasBeacon).toBe(true);
			if (reset === 'dispose') u.c.dispose();
			else u.c.onEvent({ e: 'phase', phase: reset, round: 2, loadout: 'lmg' }, 300);
			expect(u.c.beaconPlanted).toBe(false);
			expect(u.c.beaconsNow()).toEqual([]);
			if (reset !== 'dispose') {
				u.c.frame(310, false, 0);
				expect(u.beacons.last!.list).toEqual([]);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Survivor classes: 3 slots, perks, M.O.A.B.

/** Me (id 1) as a playing survivor holding `weapon` (round preset `weapon`). */
function survivorMe(weapon: WeaponId = 'lmg', mag = WEAPONS[weapon].magazine, reserve = 50) {
	const u = unit();
	u.c.onModeState(st({ loadout: weapon, players: [pv(1, { weapon }), pv(2, { team: 'infected', weapon: 'claws' })] }), 0);
	u.c.onEvent(spawnEv(1, { weapon, mag, reserve }), 0);
	return u;
}

/** Unlock perks up to `streak` with the server's `perk` events. */
function streakTo(u: ReturnType<typeof unit>, streak: number, now: number) {
	for (const perk of infPerksForStreak(streak)) {
		if (perk === 'hardline') continue;
		u.c.onEvent({ e: 'perk', id: 1, perk, streak: Math.max(streak, 1) }, now);
	}
}

/** One trigger pull at `now` (eye at 64, looking down +X). */
function pull(u: ReturnType<typeof unit>, now: number) {
	u.c.press('attack', true, now);
	u.c.tick(now, ORIGIN, 64, 0, 0, false);
	u.c.press('attack', false, now);
}

const fires = (u: ReturnType<typeof unit>) => u.sent.filter((m) => m.type === 'fire');

/** Angle (deg) between a tracer end and +X from the eye at (0, 0, 64). */
const tracerDeg = (t: { to: Vec3 }) => {
	const d = { x: t.to.x, y: t.to.y, z: t.to.z - 64 };
	return (Math.acos(Math.max(-1, Math.min(1, d.x / Math.hypot(d.x, d.y, d.z)))) * 180) / Math.PI;
};

describe('3-slot survivor classes (real InfectedGame)', () => {
	it('[1] Barrett, [2] pistol with its own INF_AMMO, [3] knife: swaps keep each magazine', () => {
		const h = playing([1, 2, 3], { loadout: 'barrett' });
		const c2 = h.peer(2).c;
		expect(h.view(2)).toMatchObject({ weapon: 'barrett', mag: INF_AMMO.barrett!.mag, reserve: INF_AMMO.barrett!.reserve, secondary: INF_SECONDARY, secondaryLabel: WEAPONS.pistol.label });
		expect(c2.slot(2, h.clock.now)).toBe(true);
		expect(h.game.playerView(2)!.weapon).toBe('pistol');
		expect(h.view(2)).toMatchObject({ weapon: 'pistol', mag: INF_AMMO.pistol!.mag, reserve: INF_AMMO.pistol!.reserve, magSize: WEAPONS.pistol.magazine });
		expect(c2.maxSpeed(h.clock.now)).toBe(WEAPONS.pistol.moveSpeed);
		// One pistol shot (after the draw): client and server agree on the pistol magazine.
		h.advance(WEAPONS.pistol.deployMs!);
		c2.press('attack', true, h.clock.now);
		h.tick(2, { x: 150, y: 2000, z: 40 });
		c2.press('attack', false, h.clock.now);
		expect(h.game.secondaryOf(2)!.mag).toBe(INF_AMMO.pistol!.mag - 1);
		expect(h.view(2).mag).toBe(INF_AMMO.pistol!.mag - 1);
		c2.slot(3, h.clock.now);
		expect(h.view(2).weapon).toBe('knife');
		expect(c2.maxSpeed(h.clock.now)).toBe(WEAPONS.knife.moveSpeed);
		c2.slot(1, h.clock.now);
		expect(h.view(2)).toMatchObject({ weapon: 'barrett', mag: h.game.primaryOf(2)!.mag, reserve: h.game.primaryOf(2)!.reserve });
		expect(c2.maxSpeed(h.clock.now)).toBe(WEAPONS.barrett.moveSpeed);
		c2.slot(2, h.clock.now);
		expect(h.view(2).mag).toBe(INF_AMMO.pistol!.mag - 1); // the pistol kept its magazine
		expect(h.peer(2).sent.filter((m) => m.type === 'loadout').map((m) => (m as { weapon: WeaponId }).weapon)).toEqual(['pistol', 'knife', 'barrett', 'pistol']);
	});

	it('the pistol reloads (R) like the primary and the server agrees', () => {
		const h = playing([1, 2, 3], { loadout: 'smg' });
		const c2 = h.peer(2).c;
		c2.slot(2, h.clock.now);
		h.advance(WEAPONS.pistol.deployMs!); // the draw
		c2.press('attack', true, h.clock.now);
		h.tick(2, { x: 150, y: 2000, z: 40 });
		c2.press('attack', false, h.clock.now);
		c2.reload(h.clock.now);
		expect(h.view(2).reloadEndsAt).toBe(h.clock.now + WEAPONS.pistol.reloadMs);
		h.advance(WEAPONS.pistol.reloadMs + 100);
		expect(h.view(2)).toMatchObject({ weapon: 'pistol', mag: WEAPONS.pistol.magazine, reloadEndsAt: 0 });
		const sec = h.game.secondaryOf(2)!;
		sec.update(h.clock.now); // the server finishes reloads lazily
		expect(sec.mag).toBe(WEAPONS.pistol.magazine);
	});
});

describe('survivor primaries (client prediction)', () => {
	it('Barrett: Mouse2 scopes (38 FOV), the semi-auto stays scoped after a shot, viewmodel hidden once fully scoped', () => {
		const u = survivorMe('barrett', 10, 20);
		u.c.press('attack2', true, 10);
		expect(u.zoom).toEqual([WEAPONS.barrett.zoomFov]);
		expect(WEAPONS.barrett.zoomFov).toBe(38);
		// The rifle comes up to the eye while the scope zooms in, then the overlay takes over.
		u.c.frame(200, true, 0);
		expect(u.vm.visible).toBe(true);
		u.c.frame(420, true, 0);
		expect(u.vm.visible).toBe(false);
		pull(u, 430);
		expect(fires(u)).toHaveLength(1);
		const v = u.c.frame(440, true, 0);
		expect(v).toMatchObject({ scoped: true, weapon: 'barrett', mag: 9 });
		expect(u.vm.visible).toBe(false);
		// Semi-auto: the next shot after fireMs, still scoped.
		pull(u, 430 + WEAPONS.barrett.fireMs - 5);
		expect(fires(u)).toHaveLength(1);
		pull(u, 430 + WEAPONS.barrett.fireMs + 1);
		expect(fires(u)).toHaveLength(2);
		expect(u.c.frame(900, true, 0).scoped).toBe(true);
		// Letting go of Mouse2 unscopes, a weapon swap unscopes too.
		u.c.press('attack2', false, 910);
		expect(u.zoom.at(-1)).toBeNull();
		u.c.press('attack2', true, 920);
		expect(u.zoom.at(-1)).toBe(38);
		u.c.slot(2, 930);
		expect(u.zoom.at(-1)).toBeNull();
		expect(u.c.frame(940, true, 0)).toMatchObject({ scoped: false, weapon: 'pistol' });
	});

	it('Striker: one trigger pull draws 5-8 scattered pellet tracers inside the pellet cone; the pistol draws one', () => {
		expect(pelletTracers('striker')).toBeGreaterThanOrEqual(5);
		expect(pelletTracers('striker')).toBeLessThanOrEqual(8);
		expect(pelletTracers('lmg')).toBe(1);
		const u = survivorMe('striker', 12, 24);
		pull(u, 10);
		expect(fires(u)).toHaveLength(1); // one fire message: the server rolls the pellets
		expect(u.vm.tracers).toHaveLength(pelletTracers('striker'));
		const cone = WEAPONS.striker.spread + WEAPONS.striker.pelletSpread!;
		for (const t of u.vm.tracers) expect(tracerDeg(t)).toBeLessThanOrEqual(cone + 1e-6);
		// Distinct directions: a visible spray, not one line.
		const ends = new Set(u.vm.tracers.map((t) => `${t.to.y.toFixed(2)},${t.to.z.toFixed(2)}`));
		expect(ends.size).toBeGreaterThan(3);
		expect(u.vm.tracers.every((t) => Math.hypot(t.to.x, t.to.y, t.to.z - 64) <= WEAPONS.striker.range + 1)).toBe(true);
		u.vm.tracers.length = 0;
		u.c.slot(2, 400);
		pull(u, 410 + WEAPONS.pistol.deployMs!); // after the draw
		expect(u.vm.tracers).toHaveLength(1);
	});

	it('SMG: automatic at its fire rate while held', () => {
		const u = survivorMe('smg', 36, 72);
		u.c.press('attack', true, 0);
		for (let t = 0; t <= 650; t += 5) u.c.tick(t, ORIGIN, 64, 0, 0, false);
		expect(fires(u)).toHaveLength(Math.floor(650 / WEAPONS.smg.fireMs) + 1);
		expect(fires(u)[0]).toMatchObject({ weapon: 'smg', tick: INF_FIRE_TICK_NOW });
	});
});

describe('specialist perks (client prediction)', () => {
	it('perk events light the track, toast, play the real chime and keep the HUD view current', () => {
		const u = survivorMe();
		expect(u.c.frame(1, true, 0)).toMatchObject({ streak: 0, perks: [], perkFlash: null });
		// My kills count the streak live, between perk events and states.
		u.c.onEvent({ e: 'kill', by: 1, targetId: 2, weapon: 'lmg', head: false, x: 0, y: 0, z: 0, yaw: 0 }, 50);
		u.c.onEvent({ e: 'kill', by: 3, targetId: 2, weapon: 'lmg', head: false, x: 0, y: 0, z: 0, yaw: 0 }, 60);
		expect(u.c.frame(70, true, 0).streak).toBe(1);
		u.c.onEvent({ e: 'perk', id: 1, perk: 'sleight', streak: 1 }, 100);
		const v = u.c.frame(110, true, 0);
		expect(v).toMatchObject({ streak: 1, perks: ['hardline', 'sleight'], perkFlash: { perk: 'sleight', at: 100 } });
		expect(v.flash).toMatchObject({ text: 'SLEIGHT OF HAND · 2× Reload', tone: 'survivor' });
		expect(u.sounds).toContain('perk');
		u.c.onEvent({ e: 'perk', id: 1, perk: 'scavenger', streak: 3 }, 200);
		expect(u.c.frame(210, true, 0).flash?.text).toBe(INF_PERK_INFO.scavenger.toast);
		u.c.onEvent({ e: 'perk', id: 1, perk: 'steady', streak: 5 }, 300);
		expect(u.c.frame(310, true, 0).flash?.text).toBe('STEADY AIM · Tight Spread + Speed');
		// Someone else's perk: no toast for me.
		u.c.onEvent({ e: 'perk', id: 2, perk: 'sleight', streak: 1 }, 320);
		expect(u.c.frame(330, true, 0).perkFlash?.perk).toBe('steady');
	});

	it('Sleight of hand halves the predicted reload (and the HUD bar duration)', () => {
		const u = survivorMe('lmg', 50, 50);
		u.c.reload(10);
		expect(u.c.frame(11, true, 0)).toMatchObject({ reloadEndsAt: 10 + WEAPONS.lmg.reloadMs, reloadMs: WEAPONS.lmg.reloadMs });
		u.c.slot(3, 20); // swap cancels it
		u.c.slot(1, 30);
		streakTo(u, 1, 40);
		u.c.reload(50);
		const half = WEAPONS.lmg.reloadMs * INF_SLEIGHT_RELOAD_FACTOR;
		expect(u.c.frame(51, true, 0)).toMatchObject({ reloadEndsAt: 50 + half, reloadMs: half });
		u.c.tick(50 + half + 1, ORIGIN, 64, 0, 0, false);
		expect(u.c.frame(50 + half + 2, true, 0)).toMatchObject({ mag: WEAPONS.lmg.magazine, reloadEndsAt: 0 });
	});

	it('Steady aim: faster survivor run speed and every tracer inside the halved cone', () => {
		const u = survivorMe('striker', 12, 24);
		expect(u.c.maxSpeed(0)).toBe(WEAPONS.striker.moveSpeed);
		streakTo(u, 5, 10);
		expect(u.c.activePerks).toContain('steady');
		expect(u.c.maxSpeed(20)).toBeCloseTo(WEAPONS.striker.moveSpeed * INF_STEADY_SPEED_FACTOR, 9);
		u.c.slot(3, 30);
		expect(u.c.maxSpeed(40)).toBeCloseTo(WEAPONS.knife.moveSpeed * INF_STEADY_SPEED_FACTOR, 9);
		u.c.slot(1, 50);
		// After the draw (deployMs).
		// Each pull from rest: the view kick of the last shot is back on the aim point.
		for (let i = 0; i < 10; i++) pull(u, 600 + i * (Math.max(WEAPONS.striker.fireMs, recoilRestMs(RECOIL.striker!)) + 5));
		expect(fires(u)).toHaveLength(10);
		const tight = (SPREAD.striker!.max + WEAPONS.striker.pelletSpread!) * INF_STEADY_SPREAD_FACTOR;
		expect(u.vm.tracers).toHaveLength(10 * pelletTracers('striker'));
		for (const t of u.vm.tracers) expect(tracerDeg(t)).toBeLessThanOrEqual(tight + 1e-6);
		// The aim spread itself is halved too (fire message direction).
		for (const m of fires(u)) {
			const d = (m as { dir: Vec3 }).dir;
			expect((Math.acos(Math.min(1, d.x)) * 180) / Math.PI).toBeLessThanOrEqual(SPREAD.striker!.max * INF_STEADY_SPREAD_FACTOR + 1e-6);
		}
	});

	it('Specialist: all perks, faster cadence, no extra HP; the state and spectators agree', () => {
		const u = survivorMe('lmg', 100, 50);
		// Without specialist the LMG waits its full fireMs.
		u.c.press('attack', true, 1000);
		u.c.tick(1000, ORIGIN, 64, 0, 0, false);
		u.c.tick(1000 + WEAPONS.lmg.fireMs * INF_SPECIALIST_CADENCE_FACTOR + 1, ORIGIN, 64, 0, 0, false);
		expect(fires(u)).toHaveLength(1);
		u.c.tick(1000 + WEAPONS.lmg.fireMs, ORIGIN, 64, 0, 0, false);
		expect(fires(u)).toHaveLength(2);
		u.c.press('attack', false, 1100);
		streakTo(u, 7, 1200);
		const v = u.c.frame(1210, true, 0);
		expect(v).toMatchObject({ hp: INF_SURVIVOR_HP, maxHp: INF_SURVIVOR_HP, streak: 7, perks: ['hardline', 'sleight', 'scavenger', 'steady', 'specialist'] });
		expect(v.flash).toMatchObject({ text: 'SPECIALIST BONUS! All Perks Active +250', tone: 'bonus' });
		expect(v.killFeed[0]!.text).toContain('SPECIALIST');
		const t0 = 2000;
		u.c.press('attack', true, t0);
		u.c.tick(t0, ORIGIN, 64, 0, 0, false);
		u.c.tick(t0 + WEAPONS.lmg.fireMs * INF_SPECIALIST_CADENCE_FACTOR + 1, ORIGIN, 64, 0, 0, false);
		expect(fires(u)).toHaveLength(4);
		// The state reconciles (same perks), a spectator sees the same.
		const perks = infPerksForStreak(7);
		u.c.onModeState(st({ players: [pv(1, { streak: 7, perks }), pv(3, { streak: 7, perks, moabReady: true })] }), 2100);
		expect(u.c.frame(2110, true, 0)).toMatchObject({ maxHp: INF_SURVIVOR_HP, streak: 7, perks });
		u.c.setSpectate(true, 3);
		expect(u.c.frame(2120, true, 0).spec).toMatchObject({ id: 3, maxHp: INF_SURVIVOR_HP, streak: 7, perks, moabReady: true });
		expect(infMaxHp('survivor')).toBe(INF_SURVIVOR_HP);
		expect(infMaxHp('infected')).toBe(INF_INFECTED_HP);
	});

	it('perks end with the survivor life: infection, a new round; a fall-out keeps them', () => {
		const u = survivorMe();
		streakTo(u, 5, 10);
		u.c.onEvent(spawnEv(1, { reason: 'fall' }), 20);
		expect(u.c.frame(21, true, 0).perks).toContain('steady');
		u.c.onEvent({ e: 'infect', id: 1, by: 2, method: 'claws', timeAdded: 20 }, 30);
		expect(u.c.frame(31, true, 0)).toMatchObject({ team: 'infected', streak: 0, perks: [], moabReady: false, maxHp: INF_INFECTED_HP });
		expect(u.c.maxSpeed(40)).toBe(INF_INFECTED_SPEED);
	});

	it('scavenger refills of the pistol and the primary never switch the held weapon', () => {
		const u = survivorMe('barrett', 10, 20);
		u.c.onEvent({ e: 'ammo', id: 1, weapon: 'pistol', mag: 12, reserve: 30, scavenger: true }, 10);
		expect(u.c.frame(11, true, 0)).toMatchObject({ weapon: 'barrett', mag: 10, reserve: 20 });
		u.c.onEvent({ e: 'ammo', id: 1, weapon: 'barrett', mag: 10, reserve: 30, scavenger: true }, 20);
		expect(u.c.frame(21, true, 0)).toMatchObject({ weapon: 'barrett', reserve: 30 });
		u.c.slot(3, 30);
		u.c.onEvent({ e: 'ammo', id: 1, weapon: 'pistol', mag: 12, reserve: 36, scavenger: true }, 40);
		expect(u.c.frame(41, true, 0).weapon).toBe('knife');
		u.c.slot(2, 50);
		expect(u.c.frame(51, true, 0)).toMatchObject({ weapon: 'pistol', mag: INF_AMMO.pistol!.mag, reserve: 36 });
		// The server's swap reply for the pistol does not touch the Barrett.
		u.c.onEvent({ e: 'ammo', id: 1, weapon: 'pistol', mag: 7, reserve: 36 }, 60);
		u.c.slot(1, 70);
		expect(u.c.frame(71, true, 0)).toMatchObject({ weapon: 'barrett', mag: 10, reserve: 30 });
	});
});

describe('M.O.A.B. (synthetic)', () => {
	it('ready → [N]/4 call → inbound countdown → detonation flash survives the end event → grace resets', () => {
		const u = survivorMe();
		expect(u.c.callMoab(5)).toBe(false); // not earned
		u.c.onEvent({ e: 'moabReady', id: 1 }, 10);
		let v = u.c.frame(11, true, 0);
		expect(v).toMatchObject({ moabReady: true, flash: { text: 'M.O.A.B. READY! Press [N] to call it in', tone: 'bonus' } });
		expect(u.sounds).toContain('moabReady');
		expect(u.c.moabAvailable).toBe(true);
		// Key 4 calls it (optimistic), a second press does nothing.
		expect(u.c.slot(4, 20)).toBe(true);
		expect(u.sentTypes()).toEqual(['callMoab']);
		expect(u.c.frame(21, true, 0).moabReady).toBe(false);
		u.c.slot(4, 22);
		expect(u.c.callMoab(23)).toBe(false);
		expect(u.sentTypes()).toEqual(['callMoab']);
		u.c.onEvent({ e: 'moabCall', by: 1, secs: INF_MOAB_COUNTDOWN_SECS }, 100);
		v = u.c.frame(110, true, 0);
		expect(v.moab).toEqual({ callerName: 'You', endsAt: 100 + INF_MOAB_COUNTDOWN_SECS * 1000 });
		expect(v.flash).toMatchObject({ text: 'M.O.A.B. INBOUND!', tone: 'infected' });
		expect(v.killFeed[0]!.text).toContain('M.O.A.B.');
		expect(u.sounds).toContain('moab');
		// A state mid-countdown does not re-anchor (rounded timeLeft would jitter).
		u.c.onModeState(st({ moab: { callerId: 1, timeLeft: 4.9 }, players: [pv(1), pv(2, { team: 'infected', weapon: 'claws' })] }), 5000);
		expect(u.c.frame(5010, true, 0).moab?.endsAt).toBe(100 + INF_MOAB_COUNTDOWN_SECS * 1000);
		u.c.onEvent({ e: 'moabDetonate', by: 1, kills: 3 }, 10100);
		u.c.onEvent({ e: 'end', winner: 'survivors', round: 1, secs: 60, survivorsLeft: 2, topId: 1, topScore: 900 }, 10100);
		u.c.onEvent({ e: 'phase', phase: 'ended', round: 1, loadout: 'lmg' }, 10100);
		v = u.c.frame(10110, true, 0);
		expect(v).toMatchObject({ moab: null, moabDetonatedAt: 10100, flash: { text: 'M.O.A.B. DETONATED! 3 eliminated', tone: 'bonus' } });
		expect(v.summary).toMatchObject({ winner: 'survivors' });
		expect(u.sounds).toContain('moabDetonate');
		u.c.onEvent({ e: 'phase', phase: 'grace', round: 2, loadout: 'barrett' }, 20000);
		expect(u.c.frame(20010, true, 0)).toMatchObject({ moabDetonatedAt: 0, moab: null, moabReady: false, streak: 0, perks: [], perkFlash: null });
	});

	it('someone else calls it: everyone sees the caller; living infected go down on detonation', () => {
		const u = infectedMe();
		u.c.onEvent({ e: 'moabCall', by: 2, secs: 10 }, 200);
		expect(u.c.frame(210, true, 0).moab).toEqual({ callerName: 'P2', endsAt: 10200 });
		expect(u.c.callMoab(220)).toBe(false); // infected cannot call
		u.c.onEvent({ e: 'moabDetonate', by: 2, kills: 1 }, 10200);
		const v = u.c.frame(10210, true, 0);
		expect(v).toMatchObject({ alive: false, moab: null, moabDetonatedAt: 10200 });
		expect(v.killFeed[0]!.text).toBe('P2 · M.O.A.B. › 1 infected');
	});

	it('a state without a M.O.A.B. clears a stale countdown; a phase change drops it', () => {
		const u = survivorMe();
		u.c.onEvent({ e: 'moabCall', by: 2, secs: 10 }, 100);
		u.c.onModeState(st({ moab: null, players: [pv(1)] }), 200);
		expect(u.c.frame(210, true, 0).moab).toBeNull();
		u.c.onModeState(st({ moab: { callerId: 2, timeLeft: 6 }, players: [pv(1)] }), 300);
		expect(u.c.frame(310, true, 0).moab).toEqual({ callerName: 'P2', endsAt: 6300 });
		u.c.onEvent({ e: 'phase', phase: 'waiting', round: 1, loadout: 'lmg' }, 400);
		expect(u.c.frame(410, true, 0).moab).toBeNull();
	});

	it('call gates: spectating, dead, offline, not playing; a rejected call comes back with the state', () => {
		const u = survivorMe();
		u.c.onEvent({ e: 'moabReady', id: 1 }, 10);
		u.c.setSpectate(true, 2);
		expect(u.c.callMoab(20)).toBe(false);
		expect(u.c.slot(4, 21)).toBe(false); // falls through to the map vote while spectating
		u.c.setSpectate(false, null);
		u.c.onModeState(st({ phase: 'grace', players: [pv(1, { moabReady: true })] }), 30);
		expect(u.c.callMoab(40)).toBe(false);
		u.c.onModeState(st({ players: [pv(1, { moabReady: true })] }), 50);
		expect(u.c.callMoab(60)).toBe(true);
		u.c.onModeState(st({ players: [pv(1, { moabReady: true })] }), 70); // the server said no
		expect(u.c.frame(71, true, 0).moabReady).toBe(true);
		u.c.onEvent({ e: 'kill', by: 2, targetId: 1, weapon: 'lmg', head: false, x: 0, y: 0, z: 0, yaw: 0 }, 80);
		expect(u.c.callMoab(90)).toBe(false);
	});
});

describe('M.O.A.B. end to end (real InfectedGame)', () => {
	it('kill streak → perk → moabReady → N → countdown → every infected dies, survivors win', () => {
		const h = playing([1, 2, 3], { loadout: 'lmg', moabKills: 2, moabCountdownSecs: 1 });
		const c2 = h.peer(2).c;
		const kills = () => h.log.filter((e) => e.e === 'kill' && e.by === 2).length;
		h.attack(2, body(h.pos.get(1)!), () => kills() >= 1);
		expect(h.log.find((e) => e.e === 'perk' && e.id === 2)).toMatchObject({ perk: 'sleight', streak: 1 });
		expect(h.view(2)).toMatchObject({ streak: 1, perks: ['hardline', 'sleight'], moabReady: false });
		// The Alpha respawns; bring it back in front of survivor 2.
		h.advance(INF_RESPAWN_SECS * 1000 + 200);
		expect(h.game.playerView(1)!.alive).toBe(true);
		h.put(1, 0, 0);
		h.put(2, 150, 0, 0.25, 180);
		h.state();
		h.attack(2, body(h.pos.get(1)!), () => kills() >= 2);
		expect(h.log.some((e) => e.e === 'moabReady' && e.id === 2)).toBe(true);
		expect(h.view(2).moabReady).toBe(true);
		expect(h.view(3).moabReady).toBe(false); // private
		expect(c2.slot(4, h.clock.now)).toBe(true);
		expect(h.log.find((e) => e.e === 'moabCall')).toMatchObject({ by: 2, secs: 1 });
		expect(h.view(3).moab).toMatchObject({ callerName: 'P2' });
		expect(h.view(1).moab?.endsAt).toBeGreaterThan(h.clock.now);
		h.advance(1100);
		expect(h.log.some((e) => e.e === 'moabDetonate' && e.by === 2)).toBe(true);
		for (const id of [1, 2, 3]) expect(h.view(id).moabDetonatedAt).toBeGreaterThan(0);
		expect(h.view(2).summary).toMatchObject({ winner: 'survivors' });
		expect(h.view(2).flash?.text).toMatch(/^M\.O\.A\.B\. DETONATED! \d+ eliminated$/);
	});
});
