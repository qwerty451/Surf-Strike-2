/**
 * Infected weapon handling over a delayed link: one client against the real
 * shared rules (`lenient` like the server), with client messages and server
 * events each arriving `latency` ms late. Client and server must agree on
 * the held weapon, the ammo and the reload, and no predicted shot may be
 * rejected.
 */
import {
	buildCollisionWorld,
	INF_PRESETS,
	INF_STEADY_SPREAD_FACTOR,
	INF_STEP_MS,
	InfectedGame,
	infEventRoute,
	infPerksForStreak,
	VIEW_HEIGHT,
	WEAPONS,
	ZM_FIRE_TOLERANCE,
	type ClientMessage,
	type InfEvent,
	type InfStateView,
	type MapDef,
	type Vec3,
	type WeaponId
} from '@surf/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FP_RELOADS } from '../render/fp-clips.js';
import type { InfectedRenderer } from '../render/infected.js';
import type { ZombieRenderer } from '../render/zombies.js';
import { AIM, AIM_GUN_KICK, GUN_KICK, RECOIL, SPREAD, VM_DRY_MS, VM_LAND_MS, ZOOM_MS, type VmFeel } from './gunfeel.js';
import { InfectedClient, type InfHost, type InfSound } from './infected.js';
import { FIRE_BUFFER_MS, forwardDir } from './zombies-view.js';

const SPAWNS = [
	{ pos: { x: -1000, y: -1000, z: 0.25 }, yaw: 0 },
	{ pos: { x: -1000, y: 1000, z: 0.25 }, yaw: 0 },
	{ pos: { x: 1000, y: -1000, z: 0.25 }, yaw: 180 },
	{ pos: { x: 1000, y: 1000, z: 0.25 }, yaw: 180 }
];

/** Flat floor, four spread spawns, a fall-out box far below. */
function testMap(): MapDef {
	return {
		id: 'inf_handling_test',
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

/** The client under test: a survivor (rng 0 makes player 1 Patient Zero). */
const ME = 2;
const FAR: Vec3 = { x: 0, y: 2000, z: 40 };

interface WireOpts {
	/** One-way delay of client messages and of server events (ms). */
	latency?: number;
	/** Round preset (default 'lmg'). */
	loadout?: WeaponId;
}

/**
 * Round playing with players 1-3; player `ME` runs a real client behind a
 * link with `latency` ms each way. The game is `lenient` (server tolerances).
 */
function wire(opts: WireOpts = {}) {
	const map = testMap();
	const world = buildCollisionWorld(map);
	const clock = { now: 1_000_000 };
	const game = new InfectedGame({ map, world, now: clock.now, rng: () => 0, graceSecs: 1, endSecs: 1, lenient: true });
	const first = INF_PRESETS.indexOf(opts.loadout ?? 'lmg');
	if (first < 0) throw new Error('not a preset');
	game.round = first;
	const latency = opts.latency ?? 0;
	const up: Array<{ at: number; msg: ClientMessage }> = [];
	const down: Array<{ at: number; ev: InfEvent }> = [];
	/** Reasons of rejected `fire` messages. */
	const rejects: string[] = [];
	const sounds: InfSound[] = [];
	const sent: ClientMessage[] = [];
	const origin: Vec3 = { x: 150, y: 0, z: 0.25 };

	const route = (events: InfEvent[]) => {
		for (const ev of events) {
			const r = infEventRoute(ev);
			if (r.to !== undefined && r.to !== ME) continue;
			if (r.except === ME) continue;
			down.push({ at: clock.now + latency, ev });
		}
	};
	const handle = (msg: ClientMessage) => {
		const now = clock.now;
		switch (msg.type) {
			case 'fire': {
				const res = game.fire(ME, { weapon: msg.weapon, origin: msg.origin, dir: msg.dir, tick: msg.tick }, now);
				if (!res.ok) rejects.push(res.reason ?? '?');
				route(res.events);
				break;
			}
			case 'loadout':
				route(game.selectWeapon(ME, msg.weapon, now));
				break;
			case 'reload':
				game.reload(ME, now);
				break;
		}
	};
	const pump = () => {
		while (up.length > 0 && up[0]!.at <= clock.now) handle(up.shift()!.msg);
		while (down.length > 0 && down[0]!.at <= clock.now) c.onEvent(down.shift()!.ev, clock.now);
	};
	const host: InfHost = {
		online: () => true,
		selfId: () => ME,
		send: (msg) => {
			sent.push(msg);
			up.push({ at: clock.now + latency, msg });
			if (latency === 0) pump();
		},
		zombieRenderer: () => null,
		infectedRenderer: () => ({ syncKnives: () => {}, syncBeacons: () => {}, uavPulse: () => {}, spark: () => {}, clear: () => {} }) as unknown as InfectedRenderer,
		name: (id) => `P${id}`,
		notice: () => {},
		teleport: (x, y, z) => {
			origin.x = x;
			origin.y = y;
			origin.z = z;
		},
		sound: (n) => void sounds.push(n),
		setZoom: () => {},
		push: () => {}
	};
	const c = new InfectedClient(host, clock.now, world);
	const state = () => c.onModeState(game.view(clock.now), clock.now);
	/** One 64 Hz step: deliveries, the server tick, then the client tick aimed at `aim`. */
	const step = (aim: Vec3 = FAR) => {
		clock.now += INF_STEP_MS;
		pump();
		route(game.update(clock.now));
		pump();
		game.setPlayerPos(ME, { x: origin.x, y: origin.y, z: origin.z, ducked: false, yaw: 0 });
		const dx = aim.x - origin.x;
		const dy = aim.y - origin.y;
		const dz = aim.z - (origin.z + VIEW_HEIGHT);
		const pitch = (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI;
		const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
		c.tick(clock.now, origin, origin.z + VIEW_HEIGHT, pitch, yaw, false);
	};
	const advance = (ms: number) => {
		const end = clock.now + ms;
		while (clock.now < end) step();
		state();
	};
	const view = () => c.frame(clock.now, false, 0);
	const fires = () => sent.filter((m) => m.type === 'fire');

	game.syncPlayers([1, 2, 3], clock.now);
	advance(1200);
	if (game.phase !== 'playing') throw new Error('round not playing');
	// Apart, so nobody is hit or infected by accident.
	game.setPlayerPos(1, { x: -900, y: -900, z: 0.25, ducked: false, yaw: 0 });
	game.setPlayerPos(3, { x: -900, y: 900, z: 0.25, ducked: false, yaw: 0 });
	origin.x = 150;
	origin.y = 0;
	origin.z = 0.25;
	advance(latency * 2 + 100);
	return { game, clock, c, sent, rejects, sounds, step, advance, view, fires, state, latency };
}

// ---------------------------------------------------------------------------
// One client, hand-built events and states (no server).

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
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

const degBetween = (a: Vec3, b: Vec3) => (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) * 180) / Math.PI;

/** Me (id 1) as a living survivor holding `weapon`, round playing; the host records what the client tells it. */
function solo(weapon: WeaponId = 'lmg', mag = WEAPONS[weapon].magazine, reserve = 50, hostOver: Partial<InfHost> = {}) {
	const sent: ClientMessage[] = [];
	const sounds: InfSound[] = [];
	const zoom: Array<number | null> = [];
	/** Camera kick and eased zoom last reported. */
	const cam = { pitch: 0, yaw: 0, roll: 0, fov: 0, t: 0, zooms: 0 };
	const vm: { weapon: WeaponId | null; visible: boolean; feel: VmFeel | null } = { weapon: null, visible: false, feel: null };
	const zr = {
		setWeapon: (w: WeaponId | null) => void (vm.weapon = w),
		setOffhandKnife: () => {},
		thrown: () => {},
		fired: () => {},
		tracer: () => {},
		updateViewmodel: (_now: number, visible: boolean, _reload: number, _speed: number, feel?: VmFeel) => {
			vm.visible = visible;
			vm.feel = feel ? { ...feel } : null;
		},
		clear: () => {}
	} as unknown as ZombieRenderer;
	const host: InfHost = {
		online: () => true,
		selfId: () => 1,
		send: (m) => void sent.push(m),
		zombieRenderer: () => zr,
		infectedRenderer: () => null,
		name: (id) => `P${id}`,
		notice: () => {},
		teleport: () => {},
		sound: (n) => void sounds.push(n),
		setZoom: (f) => void zoom.push(f),
		push: () => {},
		zoomProgress: (fov, t) => {
			cam.fov = fov;
			cam.t = t;
			cam.zooms++;
		},
		setViewKick: (pitch, yaw, roll) => {
			cam.pitch = pitch;
			cam.yaw = yaw;
			cam.roll = roll;
		},
		...hostOver
	};
	const c = new InfectedClient(host, 0);
	c.onModeState(st({ loadout: weapon, players: [pv(1, { weapon }), pv(2, { team: 'infected', weapon: 'claws' })] }), 0);
	c.onEvent(spawnEv(1, { weapon, mag, reserve }), 0);
	const fires = () => sent.filter((m) => m.type === 'fire');
	return { c, sent, sounds, zoom, cam, vm, fires };
}

describe('rapid weapon swap (N5)', () => {
	it('2, 1, R inside one round trip: no flip to the pistol, the reload survives, both sides agree', () => {
		const w = wire({ latency: 80 });
		const { c, game } = w;
		// A few shots so the primary can reload.
		c.press('attack', true, w.clock.now);
		while (game.primaryOf(ME)!.mag > 95) w.step();
		c.press('attack', false, w.clock.now);
		w.advance(400);
		expect(w.rejects).toEqual([]);
		const mag = game.primaryOf(ME)!.mag;
		expect(w.view()).toMatchObject({ weapon: 'lmg', mag });

		// Pistol and back two ticks later, then reload: all three messages are in flight together.
		c.slot(2, w.clock.now);
		w.step();
		w.step();
		c.slot(1, w.clock.now);
		w.step();
		c.reload(w.clock.now);
		expect(c.weapon).toBe('lmg');
		const reloadEndsAt = w.view().reloadEndsAt;
		expect(reloadEndsAt).toBeGreaterThan(0);

		// While the acks come back the client never leaves the primary and keeps reloading.
		const held = new Set<WeaponId>();
		let reloadKept = true;
		const end = w.clock.now + w.latency * 2 + 60;
		while (w.clock.now < end) {
			w.step();
			held.add(c.weapon);
			if (w.view().reloadEndsAt !== reloadEndsAt) reloadKept = false;
		}
		expect({ held: [...held], reloadKept }).toEqual({ held: ['lmg'], reloadKept: true });
		expect(game.playerView(ME)!.weapon).toBe('lmg');
		expect(game.primaryOf(ME)!.reloading(w.clock.now)).toBe(true);

		// After the reload both sides hold the same weapon with the same ammo, and shots are accepted.
		w.advance(WEAPONS.lmg.reloadMs + 200);
		const prim = game.primaryOf(ME)!;
		prim.update(w.clock.now);
		expect(w.view()).toMatchObject({ weapon: 'lmg', mag: prim.mag, reserve: prim.reserve, reloadEndsAt: 0 });
		expect(prim.mag).toBe(WEAPONS.lmg.magazine);
		const before = w.fires().length;
		c.press('attack', true, w.clock.now);
		for (let i = 0; i < 20; i++) w.step();
		c.press('attack', false, w.clock.now);
		w.advance(400);
		expect(w.fires().length).toBeGreaterThan(before);
		expect(w.rejects).toEqual([]);
		expect(w.view().mag).toBe(game.primaryOf(ME)!.mag);
	});
});

describe('deploy time (N6)', () => {
	it('every weapon: the trigger held through the draw fires when it ends, and the server accepts the shot', () => {
		for (const latency of [0, 40, 120]) {
			for (const [key, weapon] of [
				[2, 'pistol'],
				[3, 'knife'],
				[1, 'lmg']
			] as const) {
				const w = wire({ latency });
				const { c } = w;
				// Away from the weapon first, so the key press is a real swap.
				c.slot(key === 1 ? 2 : 1, w.clock.now);
				c.slot(key === 1 ? 2 : key === 2 ? 3 : 2, w.clock.now);
				w.advance(800);
				const before = w.fires().length;
				const at = w.clock.now;
				expect(c.slot(key, at)).toBe(true);
				expect(c.weapon).toBe(weapon);
				c.press('attack', true, at);
				while (w.fires().length === before && w.clock.now < at + 2000) w.step();
				c.press('attack', false, w.clock.now);
				const draw = WEAPONS[weapon].deployMs!;
				expect(draw).toBeGreaterThan(0);
				// Not before the draw is over, and at the first tick after it.
				expect(w.clock.now - at, `${weapon} @${latency}`).toBeGreaterThanOrEqual(draw);
				expect(w.clock.now - at).toBeLessThan(draw + 2 * INF_STEP_MS);
				expect(w.fires().at(-1)).toMatchObject({ weapon });
				w.advance(latency * 2 + 100);
				expect(w.rejects, `${weapon} @${latency}`).toEqual([]);
				expect(w.game.playerView(ME)!.weapon).toBe(weapon);
				const ws = w.game.weaponOf(ME)!;
				expect(w.view()).toMatchObject({ weapon, mag: ws.mag, reserve: ws.reserve });
			}
		}
	});

	it('the server holds a shot back for deployMs × the fire tolerance, like the fire rate', () => {
		const w = wire();
		const { game } = w;
		const o = { x: 150, y: 0, z: 0.25 + VIEW_HEIGHT };
		const dir = { x: 0, y: 1, z: 0 };
		const at = w.clock.now;
		expect(game.selectWeapon(ME, 'pistol', at)).toHaveLength(1);
		const ready = at + WEAPONS.pistol.deployMs! * ZM_FIRE_TOLERANCE;
		expect(game.fire(ME, { weapon: 'pistol', origin: o, dir, tick: 0 }, ready - 1)).toMatchObject({ ok: false, reason: 'too fast' });
		expect(game.fire(ME, { weapon: 'pistol', origin: o, dir, tick: 0 }, ready).ok).toBe(true);
	});

	it('a tap early in the draw is dropped, a tap in its last moments is buffered, and nothing is sent early', () => {
		const u = solo('lmg');
		const draw = WEAPONS.pistol.deployMs!;
		u.c.slot(2, 1000);
		// Tap at the start of the draw: forgotten long before the gun is up.
		u.c.press('attack', true, 1010);
		u.c.press('attack', false, 1020);
		for (let t = 1000; t <= 1000 + draw + 200; t += 5) u.c.tick(t, ORIGIN, 64, 0, 0, false);
		expect(u.fires()).toHaveLength(0);
		// Tap inside the buffer before the draw ends: fires as the draw ends.
		u.c.slot(1, 2000);
		u.c.slot(2, 3000);
		const tap = 3000 + draw - FIRE_BUFFER_MS + 20;
		for (let t = 3000; t <= 3000 + draw + 100; t += 5) {
			if (t === tap) u.c.press('attack', true, t);
			if (t === tap + 10) u.c.press('attack', false, t);
			u.c.tick(t, ORIGIN, 64, 0, 0, false);
			if (t < 3000 + draw) expect(u.fires()).toHaveLength(0);
		}
		expect(u.fires()).toHaveLength(1);
		expect(u.fires()[0]).toMatchObject({ weapon: 'pistol' });
	});

	it('the draw animation lasts exactly the deploy time; a server spawn has none', () => {
		const u = solo('lmg');
		const draw = WEAPONS.pistol.deployMs!;
		u.c.frame(900, true, 0);
		expect(u.vm.feel!.lower).toBe(0);
		u.c.slot(2, 1000);
		u.c.frame(1000, true, 0);
		expect(u.vm.weapon).toBe('pistol');
		expect(u.vm.feel!.lower).toBe(1); // starts out of view: no pop
		u.c.frame(1000 + draw / 2, true, 0);
		expect(u.vm.feel!.lower).toBeGreaterThan(-0.2);
		expect(u.vm.feel!.lower).toBeLessThan(0.5);
		u.c.frame(1000 + draw - 1, true, 0);
		expect(Math.abs(u.vm.feel!.lower)).toBeLessThan(0.05);
		u.c.frame(1000 + draw, true, 0);
		expect(u.vm.feel!.lower).toBe(0);
		// The server puts a weapon in my hands (round spawn while holding the pistol): no draw, ready at once.
		u.c.onEvent(spawnEv(1, { weapon: 'lmg', mag: 100, reserve: 100 }), 5000);
		u.c.frame(5001, true, 0);
		expect(u.vm.weapon).toBe('lmg');
		expect(u.vm.feel!.lower).toBe(0);
		u.c.press('attack', true, 5002);
		u.c.tick(5002, ORIGIN, 64, 0, 0, false);
		expect(u.fires()).toHaveLength(1);
	});
});

describe('dry fire (G6)', () => {
	it('empty magazine and reserve: one click per press, a viewmodel nudge, nothing sent', () => {
		const u = solo('pistol', 0, 0);
		u.c.press('attack', true, 100);
		for (let t = 100; t < 400; t += 5) u.c.tick(t, ORIGIN, 64, 0, 0, false);
		expect(u.sounds.filter((s) => s === 'dryfire')).toHaveLength(1);
		u.c.frame(100 + VM_DRY_MS / 4, true, 0);
		expect(u.vm.feel!.dry).toBeGreaterThan(0.5);
		u.c.frame(100 + VM_DRY_MS + 1, true, 0);
		expect(u.vm.feel!.dry).toBe(0);
		u.c.press('attack', false, 400);
		u.c.press('attack', true, 500);
		u.c.tick(500, ORIGIN, 64, 0, 0, false);
		expect(u.sounds.filter((s) => s === 'dryfire')).toHaveLength(2);
		expect(u.sent).toEqual([]);
		expect(u.sounds).not.toContain('reload');
	});

	it('an automatic gun running dry mid-spray clicks once', () => {
		const u = solo('lmg', 3, 0);
		u.c.press('attack', true, 0);
		for (let t = 0; t < 1500; t += 5) u.c.tick(t, ORIGIN, 64, 0, 0, false);
		expect(u.fires()).toHaveLength(3);
		expect(u.sounds.filter((s) => s === 'dryfire')).toHaveLength(1);
		expect(u.c.frame(1500, true, 0)).toMatchObject({ mag: 0, reserve: 0, reloadEndsAt: 0 });
	});

	it('with reserve left the empty gun reloads instead', () => {
		const u = solo('pistol', 0, 24);
		u.c.press('attack', true, 100);
		u.c.tick(100, ORIGIN, 64, 0, 0, false);
		expect(u.sounds).toContain('handle');
		expect(u.sounds).not.toContain('dryfire');
		expect(u.sent.map((m) => m.type)).toEqual(['reload']);
		expect(u.c.frame(110, true, 0).reloadEndsAt).toBe(100 + WEAPONS.pistol.reloadMs);
	});
});

describe('handling sounds', () => {
	it("'draw' on a swap, not when the server hands out a weapon", () => {
		const u = solo('lmg');
		expect(u.sounds).not.toContain('draw');
		u.c.slot(2, 100);
		u.c.slot(3, 900);
		expect(u.sounds.filter((s) => s === 'draw')).toHaveLength(2);
		u.c.slot(3, 950); // already held
		expect(u.sounds.filter((s) => s === 'draw')).toHaveLength(2);
		u.c.onEvent(spawnEv(1, { weapon: 'lmg', mag: 100, reserve: 100 }), 2000);
		expect(u.sounds.filter((s) => s === 'draw')).toHaveLength(2);
	});

	it("'scope' when Mouse2 puts a rifle's scope up or down", () => {
		const u = solo('barrett', 10, 20);
		// Held aim (the default): up on the press, down on the release.
		u.c.press('attack2', true, 100);
		expect(u.sounds.filter((s) => s === 'scope')).toHaveLength(1);
		u.c.press('attack2', false, 110);
		expect(u.sounds.filter((s) => s === 'scope')).toHaveLength(2);
		u.c.press('attack2', true, 400);
		expect(u.sounds.filter((s) => s === 'scope')).toHaveLength(3);
		// A swap unscopes without the scope sound; a gun without a scope makes none.
		u.c.slot(2, 700);
		u.c.press('attack2', false, 1200);
		u.c.press('attack2', true, 1300);
		u.c.press('attack2', false, 1400);
		expect(u.sounds.filter((s) => s === 'scope')).toHaveLength(3);
		expect(u.zoom).toEqual([38, null, 38, null]);
	});

	it('a reload sounds as its moves are seen: magazine out, in, and the slide of an empty gun; the rest is not heard when a swap cancels it', () => {
		const u = solo('pistol', 0, 24);
		const heard: [string, number][] = [];
		const run = (from: number, to: number) => {
			for (let t = from; t < to; t += 5) {
				const n = u.sounds.length;
				// The frame may finish the reload first (lazy update).
				u.c.frame(t, true, 0);
				u.c.tick(t, ORIGIN, 64, 0, 0, false);
				for (const s of u.sounds.slice(n)) heard.push([s, t]);
			}
		};
		u.c.reload(1000);
		expect(u.sounds).toContain('handle');
		const ms = WEAPONS.pistol.reloadMs;
		run(1000, 1000 + ms + 200);
		const cues = FP_RELOADS.pistol.empty.cues.filter((c) => c.sound !== 'handle');
		expect(cues.map((c) => c.sound)).toEqual(['magOut', 'magIn', 'reloadDone']);
		expect(heard.map(([s]) => s)).toEqual(['magOut', 'magIn', 'reloadDone']);
		cues.forEach((c, i) => expect(Math.abs(heard[i]![1] - 1000 - c.t * ms), c.sound).toBeLessThan(60));
		expect(u.c.frame(1000 + ms + 200, true, 0).mag).toBe(WEAPONS.pistol.magazine);

		// With a round left the slide stays where it is: no `reloadDone`.
		u.c.press('attack', true, 5000);
		u.c.tick(5000, ORIGIN, 64, 0, 0, false);
		u.c.press('attack', false, 5001);
		heard.length = 0;
		u.c.reload(5200);
		run(5200, 5200 + ms + 200);
		expect(heard.map(([s]) => s)).toEqual(['magOut', 'magIn']);

		u.c.press('attack', true, 8000);
		u.c.tick(8000, ORIGIN, 64, 0, 0, false);
		u.c.press('attack', false, 8001);
		heard.length = 0;
		u.c.reload(8200);
		run(8200, 8500);
		u.c.slot(1, 8500);
		run(8505, 8500 + ms + 500);
		expect(heard.map(([s]) => s)).toEqual(['magOut']);
	});
});

describe('scope (G4)', () => {
	it('the FOV eases in and out over the last ZOOM_MS of the aim; the host gets the FOV and progress every frame', () => {
		const u = solo('barrett', 10, 20);
		// The first frame clears any zoom a replaced client left on the host; then nothing until the scope moves.
		u.c.frame(900, true, 0);
		expect(u.cam).toMatchObject({ t: 0, zooms: 1 });
		expect(u.c.frame(1000, true, 0)).toMatchObject({ scoped: false, scopeT: 0 });
		expect(u.cam.zooms).toBe(1);
		u.c.press('attack2', true, 1000);
		expect(u.zoom).toEqual([38]); // the toggle itself still reports the target
		const up: number[] = [];
		for (let t = 1010; t <= 1000 + AIM.barrett!.aimMs + 10; t += 10) {
			const v = u.c.frame(t, true, 0);
			up.push(u.cam.t);
			expect(u.cam.fov).toBe(38);
			expect(v.scoped).toBe(true);
			// The overlay comes in over the last part of the aim, after the zoom has started.
			expect(v.scopeT!).toBeLessThanOrEqual(u.cam.t + 0.05);
		}
		// The gun comes up first; the FOV then moves within 100 to 200 ms.
		expect(up[0]).toBe(0);
		for (let i = 1; i < up.length; i++) expect(up[i]!).toBeGreaterThanOrEqual(up[i - 1]!);
		const moving = up.filter((t) => t > 0 && t < 1).length * 10;
		expect(moving).toBeGreaterThanOrEqual(100);
		expect(moving).toBeLessThanOrEqual(ZOOM_MS + 10);
		expect(up.at(-1)).toBe(1);
		expect(u.c.frame(1500, true, 0).scopeT).toBe(1);

		u.c.press('attack2', false, 2000);
		const down: number[] = [];
		for (let t = 2010; t <= 2000 + AIM.barrett!.aimMs + 10; t += 10) {
			u.c.frame(t, true, 0);
			down.push(u.cam.t);
		}
		for (let i = 1; i < down.length; i++) expect(down[i]!).toBeLessThanOrEqual(down[i - 1]!);
		expect(down[0]).toBeLessThan(1);
		expect(down[0]).toBeGreaterThan(0.8);
		expect(down.at(-1)).toBe(0);
		expect(u.c.frame(2500, true, 0)).toMatchObject({ scoped: false, scopeT: 0 });
		// Back at 0 the reports stop (the cvar FOV is the host's again).
		const n = u.cam.zooms;
		u.c.frame(2600, true, 0);
		expect(u.cam.zooms).toBe(n);
	});

	it('a scoped .50 cal shot kicks the camera and stays scoped; the bolt-action sniper stays scoped too', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1);
		const u = solo('barrett', 10, 20);
		u.c.tick(990, ORIGIN, 64, 0, 0, false);
		expect(u.c.frame(990, true, 0).spreadDeg).toBeCloseTo(SPREAD.barrett!.min, 6);
		u.c.press('attack2', true, 1000);
		// The scope comes up over the aim time; the crosshair gap keeps the hip cone (the crosshair is hidden).
		const early = u.c.frame(1010, true, 0);
		expect(early.scopeT).toBeLessThan(0.5);
		expect(early.spreadDeg).toBeCloseTo(SPREAD.barrett!.min, 6);
		u.c.frame(1300, true, 0);
		u.c.tick(1300, ORIGIN, 64, 0, 0, false);
		u.c.frame(1420, true, 0);
		u.c.tick(1420, ORIGIN, 64, 0, 0, false);
		expect(u.c.frame(1420, true, 0).scopeT).toBe(1);
		// Fully aimed: pinpoint.
		u.c.press('attack', true, 1430);
		u.c.tick(1430, ORIGIN, 64, 0, 0, false);
		u.c.press('attack', false, 1431);
		expect(u.fires()).toHaveLength(1);
		const d = (u.fires()[0] as { dir: Vec3 }).dir;
		expect(d.x).toBeCloseTo(1, 9);
		// Scoped view kick: up (a negative pitch) and to the left, rolled counter-clockwise.
		u.c.frame(1470, true, 0);
		expect(u.cam.pitch).toBeLessThan(-3);
		expect(u.cam.yaw).toBeGreaterThan(3);
		expect(u.cam.roll).toBeGreaterThan(0);
		expect(u.c.frame(1470, true, 0).scoped).toBe(true);
		// Still kicked when the next shot can leave: the follow-up goes where the kicked view looks (pinpoint).
		const next = 1430 + WEAPONS.barrett.fireMs;
		u.c.frame(next, true, 0);
		expect(Math.hypot(u.cam.pitch, u.cam.yaw)).toBeGreaterThan(0);
		const cam = forwardDir(u.cam.pitch, u.cam.yaw);
		u.c.press('attack', true, next);
		u.c.tick(next, ORIGIN, 64, 0, 0, false);
		expect(degBetween((u.fires()[1] as { dir: Vec3 }).dir, cam)).toBeLessThan(1e-4);
		// The scoped set is the one that kicked.
		expect(RECOIL.barrett!.scoped).not.toBeNull();

		// The bolt action stays scoped while the bolt cycles, and the next shot leaves scoped.
		const s = solo('sniper', 5, 20);
		s.c.press('attack2', true, 1000);
		s.c.frame(1420, true, 0);
		s.c.press('attack', true, 1430);
		s.c.tick(1430, ORIGIN, 64, 0, 0, false);
		s.c.press('attack', false, 1431);
		expect(s.fires()).toHaveLength(1);
		s.c.frame(1470, true, 0);
		expect(s.cam.pitch).toBeLessThan(-1);
		expect(s.c.frame(1700, true, 0)).toMatchObject({ scoped: true, scopeT: 1 });
		const bolt = 1430 + WEAPONS.sniper.fireMs;
		s.c.frame(bolt, true, 0);
		s.c.press('attack', true, bolt);
		s.c.tick(bolt, ORIGIN, 64, 0, 0, false);
		expect(s.fires()).toHaveLength(2);
		expect(s.zoom).toEqual([40]);
		expect(s.c.frame(bolt + 10, true, 0)).toMatchObject({ scoped: true, scopeT: 1 });
	});

	it('fully scoped the rifles are pinpoint even moving or airborne; the crosshair gap keeps the hip cone', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1);
		const u = solo('barrett', 10, 20);
		u.c.tick(100, ORIGIN, 64, 0, 0, false);
		expect(u.c.frame(100, true, 0).spreadDeg).toBeCloseTo(SPREAD.barrett!.min, 6);
		u.c.press('attack2', true, 100);
		u.c.frame(600, true, 0);
		u.c.tick(600, ORIGIN, 64, 0, 0, false, { x: WEAPONS.barrett.moveSpeed, y: 0, z: 0 }, true);
		expect(u.c.frame(600, true, 0).spreadDeg).toBeCloseTo(SPREAD.barrett!.max, 6);
		u.c.press('attack', true, 610);
		u.c.tick(610, ORIGIN, 64, 0, 0, false, { x: 100, y: 0, z: 200 }, false);
		u.c.press('attack', false, 611);
		expect(u.c.frame(610, true, 0).spreadDeg).toBeCloseTo(SPREAD.barrett!.max, 6);
		expect(u.fires()).toHaveLength(1);
		expect(degBetween((u.fires()[0] as { dir: Vec3 }).dir, forwardDir(0, 0))).toBeLessThan(1e-6);
	});
});

describe('view recoil in the client (G1, G7)', () => {
	// Seeded randomness: the kicks are random by design, the test must not be.
	beforeEach(() => {
		let a = 11;
		vi.spyOn(Math, 'random').mockImplementation(() => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Hold the trigger from `t0` for `ms` with frames and ticks at 64 Hz; returns each shot with the camera at that moment. */
	const sprayed = (u: ReturnType<typeof solo>, t0: number, ms: number, pitch = 0, yaw = 0) => {
		const shots: Array<{ dir: Vec3; cam: Vec3; spread: number; kick: number }> = [];
		u.c.press('attack', true, t0);
		for (let t = t0; t < t0 + ms; t += INF_STEP_MS) {
			const spread = u.c.frame(t, true, 0).spreadDeg!;
			const n = u.fires().length;
			u.c.tick(t, ORIGIN, 64, pitch, yaw, false);
			if (u.fires().length > n) {
				shots.push({ dir: (u.fires().at(-1) as { dir: Vec3 }).dir, cam: forwardDir(pitch + u.cam.pitch, yaw + u.cam.yaw), spread, kick: Math.hypot(u.cam.pitch, u.cam.yaw) });
			}
		}
		u.c.press('attack', false, t0 + ms);
		return shots;
	};

	it('shots follow the kicked camera: the spray climbs off the aim line, each bullet inside the spread around the view', () => {
		for (const weapon of ['lmg', 'smg'] as const) {
			const u = solo(weapon, 100, 0);
			const aim = forwardDir(3, 20);
			const shots = sprayed(u, 1000, 2500, 3, 20);
			expect(shots.length).toBeGreaterThan(12);
			// First shot from rest: no offset yet, on the aim point within the first-shot spread.
			expect(shots[0]!.kick).toBe(0);
			expect(degBetween(shots[0]!.dir, aim)).toBeLessThanOrEqual(SPREAD[weapon]!.min + 1e-6);
			for (const s of shots) expect(degBetween(s.dir, s.cam), weapon).toBeLessThanOrEqual(s.spread + 0.03);
			const late = shots.slice(-8);
			expect(Math.max(...late.map((s) => s.kick))).toBeGreaterThan(1);
			// The spread bloomed with the spray.
			expect(late[0]!.spread).toBeGreaterThan(shots[0]!.spread + (SPREAD[weapon]!.max - SPREAD[weapon]!.min) * 0.8);

			// Firing stops: the camera returns to the aim point exactly and the bloom recovers.
			let v = u.c.frame(3500, true, 0);
			for (let t = 3500; t < 5500; t += INF_STEP_MS) {
				v = u.c.frame(t, true, 0);
				u.c.tick(t, ORIGIN, 64, 3, 20, false);
			}
			expect(u.cam.pitch).toBe(0);
			expect(u.cam.yaw).toBe(0);
			expect(v.spreadDeg).toBeCloseTo(shots[0]!.spread, 6);

			// Aimed down sights there is no aim spread: every bullet goes where the kicked view looks, turned only
			// by the share of the gun kick the sights show (AIM_GUN_KICK), so the camera's climb takes the bullets
			// off the aim line.
			const a = solo(weapon, 100, 0);
			a.c.press('attack2', true, 400);
			for (let t = 400; t < 1000; t += INF_STEP_MS) {
				a.c.frame(t, true, 0);
				a.c.tick(t, ORIGIN, 64, 3, 20, false);
			}
			const aimed = sprayed(a, 1000, 2500, 3, 20);
			expect(aimed.length).toBeGreaterThan(12);
			expect(degBetween(aimed[0]!.dir, aim)).toBeLessThan(1e-4);
			const gk = GUN_KICK[weapon]!;
			for (const s of aimed) expect(degBetween(s.dir, s.cam), weapon).toBeLessThan(AIM_GUN_KICK * Math.hypot(gk.maxPitch, gk.maxYaw) + 1e-4);
			const aimedLate = aimed.slice(-8);
			expect(Math.max(...aimedLate.map((s) => s.kick))).toBeGreaterThan(1);
			const off = aimed.filter((s) => s.kick > 0.5);
			expect(off.length).toBeGreaterThan(0);
			for (const s of off) expect(degBetween(s.dir, aim)).toBeGreaterThanOrEqual(s.kick * 0.98 - AIM_GUN_KICK * Math.hypot(gk.maxPitch, gk.maxYaw));
			// It climbs on average: the pitch range points up.
			expect(aimedLate.reduce((n, s) => n + s.dir.z, 0) / aimedLate.length).toBeGreaterThan(aim.z);
		}
	});

	it('dying resets the kick', () => {
		const u = solo('lmg', 100, 0);
		sprayed(u, 1000, 600);
		expect(Math.hypot(u.cam.pitch, u.cam.yaw)).toBeGreaterThan(0.5);
		u.c.onEvent({ e: 'kill', by: 2, targetId: 1, weapon: 'claws', head: false, x: 0, y: 0, z: 0, yaw: 0 }, 1610);
		u.c.frame(1620, true, 0);
		expect(u.cam.pitch).toBe(0);
		expect(u.cam.yaw).toBe(0);
	});
});

describe('spread in the HUD view (G2, G3)', () => {
	it('standing, ducked, running, airborne; Steady Aim halves it; melee and the dead have none', () => {
		const u = solo('lmg', 100, 100);
		const f = SPREAD.lmg!;
		const q = (v: number) => Math.round(v * 20) / 20;
		const at = (t: number, ducked: boolean, vel: Vec3, onGround: boolean) => {
			u.c.tick(t, ORIGIN, 64, 0, 0, ducked, vel, onGround);
			return u.c.frame(t, true, 0).spreadDeg;
		};
		const run = { x: 0, y: WEAPONS.lmg.moveSpeed, z: 0 };
		expect(at(100, false, ZERO, true)).toBe(q(f.min));
		expect(at(120, true, ZERO, true)).toBe(q(f.duckMin));
		expect(at(140, false, run, true)).toBe(q(f.max));
		expect(at(160, false, { x: 0, y: 300, z: 150 }, false)).toBe(q(f.max));
		expect(at(180, false, { x: 20, y: 0, z: 0 }, true)).toBe(q(f.min));
		for (const perk of infPerksForStreak(5)) if (perk !== 'hardline') u.c.onEvent({ e: 'perk', id: 1, perk, streak: 5 }, 190);
		expect(u.c.activePerks).toContain('steady');
		expect(at(200, false, run, true)).toBe(q(f.max * INF_STEADY_SPREAD_FACTOR));
		expect(at(210, false, ZERO, true)).toBe(q(f.min * INF_STEADY_SPREAD_FACTOR));
		u.c.slot(3, 300);
		expect(at(320, false, run, true)).toBe(0);
		u.c.onEvent({ e: 'kill', by: 2, targetId: 1, weapon: 'claws', head: false, x: 0, y: 0, z: 0, yaw: 0 }, 400);
		expect(u.c.frame(410, true, 0).spreadDeg).toBe(0);
	});

	it('the fired direction uses the same spread: running and airborne shots scatter wider than standing ones', () => {
		const worst = (vel: Vec3, onGround: boolean) => {
			let max = 0;
			for (let i = 0; i < 60; i++) {
				const u = solo('pistol', 12, 0);
				u.c.press('attack', true, 100);
				u.c.tick(100, ORIGIN, 64, 0, 0, false, vel, onGround);
				max = Math.max(max, degBetween((u.fires()[0] as { dir: Vec3 }).dir, forwardDir(0, 0)));
			}
			return max;
		};
		const stand = worst(ZERO, true);
		const run = worst({ x: WEAPONS.pistol.moveSpeed, y: 0, z: 0 }, true);
		const air = worst({ x: WEAPONS.pistol.moveSpeed, y: 0, z: 100 }, false);
		const f = SPREAD.pistol!;
		expect(stand).toBeLessThanOrEqual(f.min + 1e-6);
		expect(run).toBeLessThanOrEqual(f.max + 1e-6);
		expect(run).toBeGreaterThan(f.min);
		expect(air).toBeLessThanOrEqual(f.max + 1e-6);
		expect(air).toBeGreaterThan(f.min);
	});
});

describe('viewmodel motion from the player (G5)', () => {
	it('mouse turns and strafing sway the gun, and it settles back', () => {
		const u = solo('lmg');
		let t = 1000;
		const run = (ms: number, turn: number, vel: Vec3 = ZERO, yaw0 = 0) => {
			let yaw = yaw0;
			for (const end = t + ms; t < end; t += INF_STEP_MS) {
				yaw += turn;
				u.c.tick(t, ORIGIN, 64, 0, yaw, false, vel, true);
				u.c.frame(t, true, 0);
			}
			return yaw;
		};
		run(100, 0);
		expect(u.vm.feel).toMatchObject({ x: 0, y: 0, roll: 0, yaw: 0, pitch: 0, land: 0, dry: 0, lower: 0 });
		// Turning left at 5° per tick (320°/s): the gun trails on the right.
		run(300, 5);
		expect(u.vm.feel!.x).toBeGreaterThan(0.4);
		expect(u.vm.feel!.yaw).toBeLessThan(0);
		run(700, 0, ZERO, 100);
		expect(Math.abs(u.vm.feel!.x)).toBeLessThan(0.01);
		// Crossing ±180° is a small turn, not a spin the other way.
		u.c.tick(t, ORIGIN, 64, 0, 179, false);
		u.c.tick(t + INF_STEP_MS, ORIGIN, 64, 0, -179, false);
		u.c.frame(t + INF_STEP_MS, true, 0);
		expect(u.vm.feel!.x).toBeGreaterThan(0);
		expect(u.vm.feel!.x).toBeLessThan(0.1);
		t += 1000;
		run(600, 0, ZERO, -179);
		// Strafing right (yaw 0: right is −y): the gun shifts and leans against the move.
		run(400, 0, { x: 0, y: -250, z: 0 });
		expect(u.vm.feel!.x).toBeLessThan(-0.25);
		expect(u.vm.feel!.roll).toBeLessThan(-0.02);
		// Running straight ahead does not lean it.
		run(700, 0, { x: 250, y: 0, z: 0 });
		expect(Math.abs(u.vm.feel!.x)).toBeLessThan(0.01);
		expect(Math.abs(u.vm.feel!.roll)).toBeLessThan(0.001);
	});

	it('a hard landing dips the gun for a moment, a small hop does not', () => {
		const u = solo('lmg');
		const land = (t0: number, fall: number) => {
			u.c.tick(t0, ORIGIN, 64, 0, 0, false, ZERO, true);
			for (let i = 1; i <= 5; i++) u.c.tick(t0 + i * INF_STEP_MS, ORIGIN, 64, 0, 0, false, { x: 0, y: 0, z: -fall }, false);
			const at = t0 + 6 * INF_STEP_MS;
			u.c.tick(at, ORIGIN, 64, 0, 0, false, ZERO, true);
			return at;
		};
		const at = land(1000, 500);
		u.c.frame(at + VM_LAND_MS / 4, true, 0);
		expect(u.vm.feel!.land).toBeGreaterThan(0.6);
		u.c.frame(at + VM_LAND_MS * 0.8, true, 0);
		expect(u.vm.feel!.land).toBeGreaterThan(0);
		expect(u.vm.feel!.land).toBeLessThan(0.6);
		u.c.frame(at + VM_LAND_MS + 1, true, 0);
		expect(u.vm.feel!.land).toBe(0);
		const soft = land(3000, 80);
		u.c.frame(soft + VM_LAND_MS / 4, true, 0);
		expect(u.vm.feel!.land).toBe(0);
	});
});
