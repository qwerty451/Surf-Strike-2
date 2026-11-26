/**
 * Hit and kill feedback of the infected client with the real renderers
 * (InfectedRenderer with its effects, RemotePlayers, the tracer renderer; a
 * stub `document` stands in for the name-tag canvas): server events go into
 * an InfectedClient and the scene objects and sound triggers must follow.
 */
import {
	buildCollisionWorld,
	INF_BEACON_HIT_Z,
	VIEW_HEIGHT,
	WEAPONS,
	type ClientMessage,
	type CollisionWorld,
	type InfEvent,
	type InfPlayerView,
	type InfStateView,
	type Vec3,
	type WeaponId
} from '@surf/shared';
import * as THREE from 'three';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { animate, bonePoint, roleTop, standing, topColor } from '../render/players-testkit.js';
import { HeldAssets } from '../render/character/held.js';
import { InfectedRenderer } from '../render/infected.js';
import { CORPSE_FALL_MS, IMPACT_SPARKS } from '../render/infected-fx.js';
import { RemotePlayers } from '../render/players.js';
import { MAX_TRACERS, ZombieRenderer } from '../render/zombies.js';
import { AIM, aimFov, ease, zoomFov, zoomStep } from './gunfeel.js';
import { BODY_SOUND_Z, hitSound } from './infected-feedback.js';
import { InfectedClient, pelletTracers, type InfHost, type InfSound } from './infected.js';

const ME = 1;
const T0 = 100_000;
const WALL_X = 500;

beforeAll(() => {
	vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
});
afterEach(() => void vi.restoreAllMocks());
afterAll(() => {
	vi.unstubAllGlobals();
});

/** A floor at z 0 and a wall facing −X at x 500. */
function testWorld(): CollisionWorld {
	return buildCollisionWorld({
		brushes: [
			{ type: 'box', min: { x: -2000, y: -2000, z: -64 }, max: { x: 2000, y: 2000, z: 0 }, material: 'm' },
			{ type: 'box', min: { x: WALL_X, y: -2000, z: 0 }, max: { x: WALL_X + 32, y: 2000, z: 600 }, material: 'm' }
		]
	});
}

const pv = (id: number, over: Partial<InfPlayerView> = {}): InfPlayerView => ({
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
const infected = (id: number, over: Partial<InfPlayerView> = {}) => pv(id, { team: 'infected', weapon: 'claws', hasKnife: true, ...over });

interface RemotePose {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch?: number;
}

function setup(opts: { me?: number; world?: boolean } = {}) {
	const me = opts.me ?? ME;
	const world = opts.world === false ? null : testWorld();
	const ir = new InfectedRenderer(new HeldAssets());
	const zr = new ZombieRenderer(new HeldAssets());
	const players = new RemotePlayers(new HeldAssets());
	const sounds: Array<{ name: InfSound; at?: Vec3 }> = [];
	const sent: ClientMessage[] = [];
	const tracers: Array<{ from: Vec3; to: Vec3 }> = [];
	// The real tracer pool, with a record of what it was asked to draw.
	const draw = zr.tracer.bind(zr);
	zr.tracer = (from, to, now) => {
		tracers.push({ from: { ...from }, to: { ...to } });
		draw(from, to, now);
	};
	const host: InfHost = {
		online: () => true,
		selfId: () => me,
		send: (m) => void sent.push(m),
		zombieRenderer: () => zr,
		infectedRenderer: () => ir,
		remotePlayers: () => players,
		name: (id) => `P${id}`,
		notice: () => {},
		teleport: () => {},
		sound: (name, at) => void sounds.push({ name, at: at && { ...at } }),
		setZoom: () => {},
		push: () => {}
	};
	const c = new InfectedClient(host, T0, world);
	const remotes = new Map<number, RemotePose>();
	let now = T0;
	const u = {
		c,
		ir,
		fx: ir.fx,
		zr,
		players,
		sounds,
		sent,
		tracers,
		world,
		get now() {
			return now;
		},
		state(list: InfPlayerView[], over: Partial<InfStateView> = {}) {
			c.onModeState(
				{
					phase: 'playing',
					round: 1,
					timeLeft: 100,
					loadout: 'lmg',
					secondary: 'pistol',
					moab: null,
					alphaId: null,
					survivors: list.filter((p) => p.team === 'survivor' && p.alive).length,
					infected: list.filter((p) => p.team === 'infected').length,
					players: list,
					knives: [],
					beacons: [],
					...over
				},
				now
			);
		},
		remote(id: number, pose: RemotePose) {
			remotes.set(id, pose);
		},
		/** One frame as game.ts runs it: remote poses, roles and aim, the avatar update, the client frame, the render updates. */
		frame(dt = 16) {
			now += dt;
			for (const [id, s] of remotes) {
				if (!players.has(id)) players.upsert(id, `P${id}`);
				players.setPose(id, standing(s.x, s.y, s.z, s.yaw, false, s.pitch ?? 0), !c.isDown(id));
				players.setInfected(id, c.roleOf(id), now);
			}
			animate(players, now);
			c.frame(now, true, 0);
			ir.update(now);
			zr.update(now);
		},
		ev(ev: InfEvent) {
			c.onEvent(ev, now);
		},
		/** Fire my gun once from the origin with these view angles. */
		shoot(pitch: number, yaw: number) {
			c.press('attack', true, now);
			c.tick(now, { x: 0, y: 0, z: 0 }, VIEW_HEIGHT, pitch, yaw, false);
			c.press('attack', false, now);
		},
		named(name: InfSound) {
			return sounds.filter((s) => s.name === name);
		},
		dispose() {
			c.dispose();
			ir.dispose();
			zr.dispose();
			players.dispose();
		}
	};
	return u;
}

/** Visible corpse and burst roots (the Groups under the effects group). */
const fxRoots = (u: ReturnType<typeof setup>) => u.fx.group.children.filter((c): c is THREE.Group => c.type === 'Group' && c.visible);
const corpseHead = (root: THREE.Object3D) => bonePoint(root, 'head');
const shot = (by: number, weapon: WeaponId, o: Vec3, d: Vec3, len: number, pellets?: number[]): InfEvent => ({ e: 'shot', by, weapon, o, d, len, ...(pellets ? { pellets } : {}) });
/** What the server sends as `len`: the distance to the first surface along the ray. */
const serverLen = (w: CollisionWorld, o: Vec3, d: Vec3, range: number) =>
	w.trace(o, { x: o.x + d.x * range, y: o.y + d.y * range, z: o.z + d.z * range }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }).fraction * range;
const unit = (x: number, y: number, z: number): Vec3 => {
	const l = Math.hypot(x, y, z);
	return { x: x / l, y: y / l, z: z / l };
};

describe('F1 death effect', () => {
	it('a killed infected is down at once and collapses at the death pose in its look, away from the killer', () => {
		const u = setup();
		u.state([pv(ME), infected(2)]);
		u.remote(2, { x: 300, y: 0, z: 0, yaw: 180 });
		for (let i = 0; i < 5; i++) u.frame();
		u.c.tick(u.now, { x: 0, y: 0, z: 0 }, VIEW_HEIGHT, 0, 0, false); // my eye: the corpse falls away from it
		const lean = standing(0, 0, 0);
		expect(u.players.pose(2, lean)).toBe(true);
		const alive = bonePoint(u.players.group, 'head');
		u.ev({ e: 'kill', by: ME, targetId: 2, weapon: 'lmg', head: false, x: 310, y: 6, z: 2, yaw: 170 });
		expect(u.fx.stats.corpses).toBe(1);
		// Down before the next state: the avatar must not stand next to its corpse.
		expect(u.c.isDown(2)).toBe(true);
		const root = fxRoots(u)[0]!;
		expect(root.position.toArray()).toEqual([310, 2, -6]);
		expect(topColor(root)).toBe(roleTop('infected'));
		// The corpse takes over the avatar's pose: the hunched head, as far above and in front of the feet (yaw 180, then 170).
		const dead = corpseHead(root);
		expect(dead.y - 2).toBeCloseTo(alive.y, 3);
		expect(Math.hypot(dead.x - 310, dead.z + 6)).toBeCloseTo(Math.hypot(alive.x - 300, alive.z), 3);
		expect(Math.hypot(alive.x - 300, alive.z)).toBeGreaterThan(4);
		expect(u.named('death')).toEqual([{ name: 'death', at: { x: 310, y: 6, z: 2 + BODY_SOUND_Z } }]);
		u.frame();
		expect(u.players.pose(2, lean)).toBe(false); // hidden in the same frame the corpse shows
		u.frame(CORPSE_FALL_MS);
		expect(corpseHead(root).x).toBeGreaterThan(310 + 50);
		u.frame(5000);
		expect(u.fx.stats.corpses).toBe(0);
		u.dispose();
	});

	it('Patient Zero dies in its own look; a remote killer sets the fall direction', () => {
		const u = setup();
		u.state([pv(ME), pv(2), infected(3, { alpha: true, weapon: 'barrett' })]);
		u.remote(2, { x: 0, y: -400, z: 0, yaw: 90 });
		u.remote(3, { x: 0, y: 0, z: 0, yaw: 0 });
		u.frame();
		u.ev({ e: 'kill', by: 2, targetId: 3, weapon: 'lmg', head: true, x: 0, y: 0, z: 0, yaw: 0 });
		const root = fxRoots(u)[0]!;
		expect(topColor(root)).toBe(roleTop('alpha'));
		u.frame(CORPSE_FALL_MS);
		// Shot from −Y: falls towards +Y (Three −Z).
		expect(corpseHead(root).z).toBeLessThan(-50);
		u.dispose();
	});

	it('no corpse for the view player (me, or the player I spectate) or with hidden players; the death still sounds', () => {
		const mine = setup({ me: 2 });
		mine.state([pv(1), infected(2)]);
		mine.ev({ e: 'kill', by: 1, targetId: 2, weapon: 'lmg', head: false, x: 0, y: 0, z: 0, yaw: 0 });
		expect(mine.fx.stats.corpses).toBe(0);
		expect(mine.named('death')).toHaveLength(1);
		mine.dispose();

		const spec = setup();
		spec.state([pv(ME), pv(3), infected(2)]);
		spec.remote(2, { x: 100, y: 0, z: 0, yaw: 0 });
		spec.frame();
		spec.c.setSpectate(true, 2);
		spec.ev({ e: 'kill', by: 3, targetId: 2, weapon: 'lmg', head: false, x: 100, y: 0, z: 0, yaw: 0 });
		expect(spec.fx.stats.corpses).toBe(0);
		expect(spec.c.isDown(2)).toBe(true);
		spec.dispose();

		const hid = setup();
		hid.state([pv(ME), infected(2)]);
		hid.remote(2, { x: 100, y: 0, z: 0, yaw: 0 });
		hid.frame();
		hid.players.setHidden(true);
		hid.ev({ e: 'kill', by: ME, targetId: 2, weapon: 'lmg', head: false, x: 100, y: 0, z: 0, yaw: 0 });
		expect(hid.fx.stats.corpses).toBe(0);
		expect(hid.named('death')).toHaveLength(1);
		hid.dispose();
	});

	it('a M.O.A.B. drops every living infected where its avatar stands', () => {
		const u = setup();
		u.state([pv(ME), infected(2), infected(3, { alpha: true, weapon: 'smg' }), infected(4, { alive: false }), pv(5)]);
		u.remote(2, { x: 100, y: 0, z: 0, yaw: 0 });
		u.remote(3, { x: 0, y: 200, z: 16, yaw: 90 });
		u.remote(4, { x: -100, y: 0, z: 0, yaw: 0 });
		u.remote(5, { x: 0, y: -200, z: 0, yaw: 0 });
		u.frame();
		u.ev({ e: 'moabDetonate', by: ME, kills: 2 });
		expect(u.fx.stats.corpses).toBe(2);
		expect([2, 3, 4, 5].map((id) => u.c.isDown(id))).toEqual([true, true, true, false]);
		const roots = fxRoots(u);
		expect(roots.map((r) => r.position.toArray())).toEqual([
			[100, 0, -0],
			[0, 16, -200]
		]);
		expect(roots.map(topColor)).toEqual([roleTop('infected'), roleTop('alpha')]);
		u.frame();
		const out = standing(0, 0, 0);
		expect([2, 3, 5].map((id) => u.players.pose(id, out))).toEqual([false, false, true]);
		u.dispose();
	});

	it('a wiped infected sees the others fall, not itself', () => {
		const u = setup({ me: 2 });
		u.state([pv(1), infected(2), infected(3)]);
		u.remote(3, { x: 100, y: 0, z: 0, yaw: 0 });
		u.frame();
		u.ev({ e: 'moabDetonate', by: 1, kills: 2 });
		expect(u.fx.stats.corpses).toBe(1);
		expect(u.c.down).toBe(true);
		u.dispose();
	});
});

describe('F2 infection effect', () => {
	it('a survivor who turns bursts at the body and eases into the infected look', () => {
		const u = setup();
		u.state([pv(ME), infected(2), pv(3)]);
		u.remote(3, { x: 100, y: 150, z: 8, yaw: 0 });
		u.frame();
		u.ev({ e: 'infect', id: 3, by: 2, method: 'claws', timeAdded: 20 });
		expect(u.fx.stats.turns).toBe(1);
		expect(fxRoots(u)[0]!.position.toArray()).toEqual([100, 8, -150]);
		expect(u.named('infect')).toEqual([{ name: 'infect', at: { x: 100, y: 150, z: 8 + BODY_SOUND_Z } }]);
		// The role flips with the next state: the look eases in instead of switching.
		u.state([pv(ME), infected(2), infected(3)]);
		u.frame();
		expect(u.players.feedback(3)).toMatchObject({ easing: true, held: 'claws', knife: true });
		u.frame(2000);
		expect(u.players.feedback(3)!.easing).toBe(false);
		expect(u.fx.stats.turns).toBe(0);
		u.dispose();
	});

	it('my own infection sounds without a position and has no burst; hidden players burst nothing', () => {
		const u = setup();
		u.state([pv(ME), infected(2), pv(3)]);
		u.remote(3, { x: 100, y: 0, z: 0, yaw: 0 });
		u.frame();
		u.ev({ e: 'infect', id: ME, by: 2, method: 'knife', timeAdded: 20 });
		expect(u.named('infect')).toEqual([{ name: 'infect', at: undefined }]);
		expect(u.fx.stats.turns).toBe(0);
		u.players.setHidden(true);
		u.ev({ e: 'infect', id: 3, by: 2, method: 'claws', timeAdded: 20 });
		expect(u.fx.stats.turns).toBe(0);
		expect(u.named('infect')).toHaveLength(2);
		expect(u.named('infect')[1]!.at).toEqual({ x: 100, y: 0, z: BODY_SOUND_Z });
		u.dispose();
	});
});

describe('F3 hit flash', () => {
	it('my hit flashes the victim and sounds by the event flags', () => {
		const u = setup();
		u.state([pv(ME), infected(2)]);
		u.remote(2, { x: 100, y: 0, z: 0, yaw: 0 });
		u.frame();
		u.ev({ e: 'hit', by: ME, targetId: 2, head: false, kill: false });
		u.frame();
		expect(u.players.feedback(2)!.flashing).toBe(true);
		u.frame(150);
		expect(u.players.feedback(2)!.flashing).toBe(false);
		u.ev({ e: 'hit', by: ME, targetId: 2, head: true, kill: false });
		u.ev({ e: 'hit', by: ME, targetId: 2, head: true, kill: true });
		u.ev({ e: 'hit', by: ME, targetId: 2, head: false, kill: true });
		u.ev({ e: 'hit', by: ME, targetId: 0, head: false, kill: true }); // a beacon
		expect(u.sounds.map((s) => s.name)).toEqual(['hit', 'hitHead', 'hitKill', 'hitKill', 'hit']);
		expect(u.sounds.every((s) => s.at === undefined)).toBe(true);
		// Someone else's hit is not mine to show.
		u.frame(150);
		u.ev({ e: 'hit', by: 3, targetId: 2, head: false, kill: false });
		u.frame();
		expect(u.players.feedback(2)!.flashing).toBe(false);
		expect(u.sounds).toHaveLength(5);
		u.dispose();
	});

	it('hitSound: a kill beats a headshot; a beacon keeps the plain hit', () => {
		const h = (targetId: number, head: boolean, kill: boolean) => hitSound({ e: 'hit', by: 1, targetId, head, kill });
		expect([h(2, false, false), h(2, true, false), h(2, false, true), h(2, true, true), h(0, false, true)]).toEqual(['hit', 'hitHead', 'hitKill', 'hitKill', 'hit']);
	});
});

describe('F4 bullet impacts', () => {
	it('my shot leaves an impact where its tracer ends on the map, with one sound', () => {
		const u = setup();
		u.state([pv(ME)]);
		u.shoot(60, 0); // into the floor
		expect(u.tracers).toHaveLength(1);
		expect(u.fx.stats.impacts).toBe(1);
		const end = u.tracers[0]!.to;
		expect(end.z).toBeCloseTo(0, 0);
		const s = u.named('impact');
		expect(s).toHaveLength(1);
		expect(Math.hypot(s[0]!.at!.x - end.x, s[0]!.at!.y - end.y, s[0]!.at!.z - end.z)).toBeLessThan(1);
		u.dispose();
	});

	it('a shot into the sky leaves nothing', () => {
		const u = setup();
		u.state([pv(ME)]);
		u.shoot(-80, 0);
		expect(u.tracers).toHaveLength(1);
		expect(u.fx.stats.impacts).toBe(0);
		expect(u.named('impact')).toHaveLength(0);
		u.dispose();
	});

	it('my tracers start at the muzzle as it is drawn: beside the aim from the hip, at the barrel end when aimed (every gun)', () => {
		for (const w of ['pistol', 'smg', 'lmg', 'striker'] as const) {
			const u = setup();
			u.state([pv(ME, { weapon: w }), infected(2)]);
			u.ev({ e: 'spawn', id: ME, x: 0, y: 0, z: 0, yaw: 0, hp: 5, team: 'survivor', alpha: false, weapon: w, mag: WEAPONS[w].magazine, reserve: 50, hasKnife: false, reason: 'round' });
			for (let i = 0; i < 80; i++) u.frame();
			const eye = { x: 0, y: 0, z: VIEW_HEIGHT };
			u.shoot(0, 0);
			const hip = u.tracers[0]!.from;
			expect(hip.y, w).toBeCloseTo(-7, 6); // right of the aim (yaw 0 looks along +x)
			expect(hip.z - eye.z, w).toBeCloseTo(-6, 6);
			// Aimed and at rest again (recoil gone): on the screen line of the drawn muzzle.
			u.c.press('attack2', true, u.now);
			for (let i = 0; i < 120; i++) {
				u.frame();
				u.c.tick(u.now, { x: 0, y: 0, z: 0 }, VIEW_HEIGHT, 0, 0, false);
			}
			const at = { right: 0, down: 0 };
			expect(u.zr.muzzleScreen(at), w).toBe(true);
			const n = u.tracers.length;
			u.shoot(0, 0);
			const from = u.tracers[n]!.from;
			const tan = Math.tan((aimFov(90, w) * Math.PI) / 360) * 0.75;
			const ahead = from.x - eye.x;
			expect(ahead, w).toBeGreaterThan(0);
			expect(-(from.y - eye.y) / (ahead * tan), w).toBeCloseTo(at.right, 2);
			expect(-(from.z - eye.z) / (ahead * tan), w).toBeCloseTo(at.down, 2);
			// In the middle of the screen, below the sights.
			expect(Math.abs(at.right), w).toBeLessThan(0.08);
			expect(at.down, w).toBeGreaterThan(0);
			u.dispose();
		}
	});

	it('my tracers: half aimed they start on the way, in a burst they follow the kicked view, scoped they come from below', () => {
		const held = (w: WeaponId) => {
			const u = setup();
			u.state([pv(ME, { weapon: w }), infected(2)]);
			u.ev({ e: 'spawn', id: ME, x: 0, y: 0, z: 0, yaw: 0, hp: 5, team: 'survivor', alpha: false, weapon: w, mag: WEAPONS[w].magazine, reserve: 50, hasKnife: false, reason: 'round' });
			for (let i = 0; i < 80; i++) u.frame();
			const aimed = (frames: number) => {
				u.c.press('attack2', true, u.now);
				for (let i = 0; i < frames; i++) {
					u.frame();
					u.c.tick(u.now, { x: 0, y: 0, z: 0 }, VIEW_HEIGHT, 0, 0, false);
				}
			};
			const fire = () => {
				const n = u.tracers.length;
				u.shoot(0, 0);
				return u.tracers[n]!.from;
			};
			return { u, aimed, fire };
		};
		{
			// About halfway up (100 of 200 ms): between the hip start (7 right, 6 down) and the middle of the screen.
			const { u, aimed, fire } = held('smg');
			aimed(6);
			const aimT = (u.c as unknown as { aimT: number }).aimT;
			expect(aimT).toBeGreaterThan(0.3);
			expect(aimT).toBeLessThan(0.7);
			const at = { right: 0, down: 0 };
			expect(u.zr.muzzleScreen(at)).toBe(true);
			expect(at.right).toBeGreaterThan(0.05);
			const from = fire();
			const k = 18 * Math.tan((zoomFov(90, aimFov(90, 'smg'), ease(zoomStep(aimT, AIM.smg!.aimMs))) * Math.PI) / 360) * 0.75;
			expect(from.y).toBeCloseTo(-7 + (7 - at.right * k) * ease(aimT), 2);
			expect(from.z - VIEW_HEIGHT).toBeCloseTo(-6 + (6 - at.down * k) * ease(aimT), 2);
			u.dispose();
		}
		// The widest random kick, so both axes are off the aim point.
		vi.spyOn(Math, 'random').mockReturnValue(0.95);
		let pitched = 0;
		let turned = 0;
		for (const w of ['lmg', 'smg', 'striker', 'pistol'] as const) {
			const { u, aimed, fire } = held(w);
			aimed(120);
			fire();
			// Until the gun may fire again: the view is still kicked.
			for (let t = 0; t <= WEAPONS[w].fireMs; t += 16) {
				u.frame();
				u.c.tick(u.now, { x: 0, y: 0, z: 0 }, VIEW_HEIGHT, 0, 0, false);
			}
			const kick = (u.c as unknown as { viewKick: { pitch: number; yaw: number } }).viewKick;
			pitched = Math.max(pitched, Math.abs(kick.pitch));
			turned = Math.max(turned, Math.abs(kick.yaw));
			const at = { right: 0, down: 0 };
			expect(u.zr.muzzleScreen(at)).toBe(true);
			const from = fire();
			// Seen from the kicked view, the start is where the muzzle is drawn.
			const p = (kick.pitch * Math.PI) / 180;
			const y = (kick.yaw * Math.PI) / 180;
			const d = { x: from.x, y: from.y, z: from.z - VIEW_HEIGHT };
			const fwd = d.x * Math.cos(p) * Math.cos(y) + d.y * Math.cos(p) * Math.sin(y) - d.z * Math.sin(p);
			const right = d.x * Math.sin(y) - d.y * Math.cos(y);
			const down = -(d.x * Math.sin(p) * Math.cos(y) + d.y * Math.sin(p) * Math.sin(y) + d.z * Math.cos(p));
			const tan = Math.tan((aimFov(90, w) * Math.PI) / 360) * 0.75;
			expect(right / (fwd * tan), w).toBeCloseTo(at.right, 2);
			expect(down / (fwd * tan), w).toBeCloseTo(at.down, 2);
			u.dispose();
		}
		expect(pitched).toBeGreaterThan(0.5);
		expect(turned).toBeGreaterThan(0.5);
		vi.restoreAllMocks();
		for (const w of ['sniper', 'barrett'] as const) {
			const { u, aimed, fire } = held(w);
			aimed(120);
			expect(u.zr.muzzleScreen({ right: 0, down: 0 }), w).toBe(false);
			const from = fire();
			expect(Math.abs(from.y), w).toBeLessThan(0.1);
			expect(from.z - VIEW_HEIGHT, w).toBeCloseTo(-6, 1);
			u.dispose();
		}
	});

	it('my shotgun: an impact per pellet tracer, one impact sound per trigger pull', () => {
		const u = setup();
		u.state([pv(ME)]);
		u.ev({ e: 'spawn', id: ME, x: 0, y: 0, z: 0, yaw: 0, hp: 5, team: 'survivor', alpha: false, weapon: 'striker', mag: 12, reserve: 24, hasKnife: false, reason: 'round' });
		u.shoot(60, 0);
		expect(u.tracers).toHaveLength(pelletTracers('striker'));
		expect(u.fx.stats.impacts).toBe(pelletTracers('striker'));
		expect(u.named('impact')).toHaveLength(1);
		u.dispose();
	});

	it('a remote shot that reached the map leaves an impact off the surface, with a sound there', () => {
		const u = setup();
		u.state([pv(ME), pv(2)]);
		const o = { x: 0, y: 0, z: 64 };
		const d = { x: 1, y: 0, z: 0 };
		u.ev(shot(2, 'lmg', o, d, serverLen(u.world!, o, d, WEAPONS.lmg.range)));
		expect(u.fx.stats.impacts).toBe(1);
		const at = u.named('impact')[0]!.at!;
		expect(at.x).toBeCloseTo(WALL_X, 0);
		expect([at.y, at.z]).toEqual([0, 64]);
		// The sparks leave the wall along its normal (−X).
		u.frame(40);
		const lines = u.fx.group.children.find((c): c is THREE.LineSegments => c instanceof THREE.LineSegments)!;
		const pos = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
		for (let i = 0; i < IMPACT_SPARKS; i++) expect(pos.getX(i * 2)).toBeLessThan(WALL_X);
		u.dispose();
	});

	it('a remote shot that ended on a player or ran out of range leaves no impact; melee neither', () => {
		const u = setup();
		u.state([pv(ME), pv(2), infected(3)]);
		const o = { x: 0, y: 0, z: 64 };
		u.ev(shot(2, 'lmg', o, { x: 1, y: 0, z: 0 }, 200)); // stopped by a body in mid-air
		u.ev(shot(2, 'lmg', o, { x: 0, y: 0, z: 1 }, WEAPONS.lmg.range)); // into the sky
		expect(u.tracers).toHaveLength(2);
		u.ev(shot(3, 'claws', o, { x: 1, y: 0, z: 0 }, 0));
		u.ev(shot(2, 'knife', o, { x: 0, y: 0, z: -1 }, 0));
		expect(u.tracers).toHaveLength(2);
		expect(u.fx.stats.impacts).toBe(0);
		expect(u.named('impact')).toHaveLength(0);
		// The shots themselves still sound, from the shooter.
		expect(u.sounds.map((s) => s.name)).toEqual(['shot-lmg', 'shot-lmg', 'claws', 'knife']);
		u.dispose();
	});

	it('without a collision world every shot shorter than the range counts', () => {
		const u = setup({ world: false });
		u.state([pv(ME), pv(2)]);
		const o = { x: 0, y: 0, z: 64 };
		u.ev(shot(2, 'lmg', o, { x: 1, y: 0, z: 0 }, 200));
		u.ev(shot(2, 'lmg', o, { x: 1, y: 0, z: 0 }, WEAPONS.lmg.range));
		expect(u.fx.stats.impacts).toBe(1);
		expect(u.named('impact')).toEqual([{ name: 'impact', at: { x: 200, y: 0, z: 64 } }]);
		u.dispose();
	});
});

describe('F5 remote weapons, muzzle flash, tracer from the gun', () => {
	it('remote players hold what the state says: guns, claws and the throwing knife', () => {
		const u = setup();
		u.state([pv(ME), pv(2, { weapon: 'barrett' }), pv(3, { weapon: 'pistol' }), infected(4), infected(5, { hasKnife: false }), infected(6, { alpha: true, weapon: 'striker' })]);
		for (const id of [2, 3, 4, 5, 6]) u.remote(id, { x: id * 100, y: 0, z: 0, yaw: 0 });
		u.frame();
		const held = (id: number) => {
			const f = u.players.feedback(id)!;
			return [f.held, f.knife];
		};
		expect([2, 3, 4, 5, 6].map(held)).toEqual([
			['barrett', false],
			['pistol', false],
			['claws', true],
			['claws', false],
			['striker', true]
		]);
		expect(u.players.has(ME)).toBe(false);
		// A swap shows with the next state.
		u.state([pv(ME), pv(2, { weapon: 'knife' })]);
		u.frame();
		expect(held(2)).toEqual(['knife', false]);
		u.dispose();
	});

	it('a remote shot flashes at the muzzle of the held gun and its tracer starts there', () => {
		const u = setup();
		u.state([pv(ME), pv(2, { weapon: 'lmg' })]);
		u.remote(2, { x: 0, y: 0, z: 0, yaw: 0 });
		for (let i = 0; i < 30; i++) u.frame(); // the weapon comes up
		const muzzle = { x: 0, y: 0, z: 0 };
		expect(u.players.muzzle(2, muzzle)).toBe(true);
		const o = { x: 0, y: 0, z: VIEW_HEIGHT };
		u.ev(shot(2, 'lmg', o, { x: 1, y: 0, z: 0 }, 300));
		expect(u.players.feedback(2)!.muzzleFlash).toBe(true);
		expect(u.tracers).toHaveLength(1);
		// The recoil lifts the muzzle a little right after the shot: compare with the muzzle as drawn now.
		u.players.muzzle(2, muzzle);
		expect(u.tracers[0]!.from).toEqual(muzzle);
		expect(muzzle.x).toBeGreaterThan(25); // in front of the body, not at the eye
		expect(u.tracers[0]!.to).toEqual({ x: 300, y: 0, z: VIEW_HEIGHT });
		u.frame(200);
		expect(u.players.feedback(2)!.muzzleFlash).toBe(false);
		u.dispose();
	});

	it('an undrawn shooter (no avatar, hidden players, far from the shot origin) keeps the tracer below the eye', () => {
		const u = setup();
		u.state([pv(ME), pv(2), pv(3)]);
		const o = { x: 0, y: 0, z: 64 };
		const below = { x: 0, y: 0, z: 58 };
		u.ev(shot(3, 'lmg', o, { x: 1, y: 0, z: 0 }, 300));
		expect(u.tracers[0]!.from).toEqual(below);
		u.remote(2, { x: 0, y: 0, z: 0, yaw: 0 });
		u.frame();
		u.players.setHidden(true);
		u.ev(shot(2, 'lmg', o, { x: 1, y: 0, z: 0 }, 300));
		expect(u.tracers[1]!.from).toEqual(below);
		u.players.setHidden(false);
		// The avatar is drawn ~100 ms in the past: a shot from a spot far from it does not start at its gun.
		const far = { x: 400, y: 0, z: 64 };
		u.ev(shot(2, 'lmg', far, { x: 0, y: 1, z: 0 }, 300));
		expect(u.tracers[2]!.from).toEqual({ x: 400, y: 0, z: 58 });
		u.dispose();
	});

	it('a remote claw swing slashes with the right arm, with no flash and no tracer', () => {
		const u = setup();
		u.state([pv(ME), infected(2)]);
		u.remote(2, { x: 0, y: 0, z: 0, yaw: 0 });
		for (let i = 0; i < 30; i++) u.frame();
		const rest = bonePoint(u.players.group, 'handR');
		const left = bonePoint(u.players.group, 'handL');
		u.ev(shot(2, 'claws', { x: 0, y: 0, z: 64 }, { x: 1, y: 0, z: 0 }, 0));
		u.frame(160);
		u.frame(160);
		u.frame();
		expect(bonePoint(u.players.group, 'handR').distanceTo(rest)).toBeGreaterThan(6);
		expect(bonePoint(u.players.group, 'handL').distanceTo(left)).toBeLessThan(2);
		expect(u.players.feedback(2)!.muzzleFlash).toBe(false);
		expect(u.tracers).toHaveLength(0);
		u.dispose();
	});
});

describe('F6 remote shotgun pellets', () => {
	it('one tracer and one impact per pellet, all from the gun, one impact sound', () => {
		const u = setup();
		u.state([pv(ME), pv(2, { weapon: 'striker' })]);
		u.remote(2, { x: 0, y: 0, z: 0, yaw: 0, pitch: 45 });
		u.frame();
		const o = { x: 0, y: 0, z: VIEW_HEIGHT };
		const range = WEAPONS.striker.range;
		const dirs = [unit(1, 0, -1), unit(1, 0.05, -1), unit(1, -0.05, -1), unit(1, 0.02, -0.95), unit(1, -0.03, -1.05), unit(1, 0.06, -0.98), unit(1, -0.06, -1.02), unit(1, 0.01, -1.04)];
		const lens = dirs.map((d) => serverLen(u.world!, o, d, range));
		const pellets = dirs.slice(1).flatMap((d, i) => [d.x, d.y, d.z, lens[i + 1]!]);
		u.ev(shot(2, 'striker', o, dirs[0]!, lens[0]!, pellets));
		expect(u.tracers).toHaveLength(8);
		expect(u.fx.stats.impacts).toBe(8);
		expect(u.named('impact')).toHaveLength(1);
		const from = u.tracers[0]!.from;
		expect(u.tracers.every((t) => t.from.x === from.x && t.from.y === from.y && t.from.z === from.z)).toBe(true);
		u.tracers.forEach((t, i) => {
			expect(t.to.x).toBeCloseTo(o.x + dirs[i]!.x * lens[i]!, 6);
			expect(t.to.y).toBeCloseTo(o.y + dirs[i]!.y * lens[i]!, 6);
			expect(t.to.z).toBeCloseTo(0, 0); // on the floor
		});
		// All eight are on screen in the real pool.
		u.frame(10);
		expect(u.zr.group.children.filter((c) => c instanceof THREE.Line && c.visible)).toHaveLength(8);
		expect(MAX_TRACERS).toBeGreaterThanOrEqual(64);
		u.dispose();
	});

	it('no pellets (older server) draws the one tracer; malformed pellet data is ignored', () => {
		const u = setup();
		u.state([pv(ME), pv(2, { weapon: 'striker' })]);
		const o = { x: 0, y: 0, z: 64 };
		const d = { x: 1, y: 0, z: 0 };
		u.ev(shot(2, 'striker', o, d, 300));
		expect(u.tracers).toHaveLength(1);
		u.ev(shot(2, 'striker', o, d, 300, [0, 1, 0, 200, 1, 0])); // a trailing partial pellet
		expect(u.tracers).toHaveLength(3);
		u.ev(shot(2, 'striker', o, d, 300, [Number.NaN, 0, 0, 200, 0, 1, 0, -5, 0, 0, 1, 100]));
		expect(u.tracers).toHaveLength(5);
		u.ev({ e: 'shot', by: 2, weapon: 'striker', o, d, len: 300, pellets: 'x' as unknown as number[] });
		expect(u.tracers).toHaveLength(6);
		u.dispose();
	});
});

describe('F7 effects are cleared on round reset and dispose', () => {
	it('the grace phase of the next round clears corpses, bursts and impacts', () => {
		const u = setup();
		u.state([pv(ME), infected(2), pv(3)]);
		u.remote(2, { x: 100, y: 0, z: 0, yaw: 0 });
		u.remote(3, { x: 200, y: 0, z: 0, yaw: 0 });
		u.frame();
		u.ev({ e: 'infect', id: 3, by: 2, method: 'claws', timeAdded: 20 });
		u.ev({ e: 'kill', by: ME, targetId: 2, weapon: 'lmg', head: false, x: 100, y: 0, z: 0, yaw: 0 });
		u.shoot(60, 0);
		expect(u.fx.stats).toMatchObject({ corpses: 1, turns: 1, impacts: 1 });
		u.ev({ e: 'phase', phase: 'grace', round: 2, loadout: 'striker' });
		expect(u.fx.stats).toMatchObject({ corpses: 0, turns: 0, impacts: 0 });
		u.frame();
		expect(fxRoots(u)).toHaveLength(0);
		u.dispose();
	});

	it('the grace phase clears the casings on the ground too', () => {
		const u = setup();
		u.zr.casings.reduced = false;
		u.state([pv(ME), infected(2)]);
		u.frame();
		const cam = new THREE.PerspectiveCamera(60, 16 / 9, 1, 1000);
		u.shoot(0, 0);
		u.frame();
		u.zr.updateCasings(u.now, cam);
		expect(u.zr.casings.stats.live).toBe(1);
		u.ev({ e: 'phase', phase: 'grace', round: 2, loadout: 'striker' });
		expect(u.zr.casings.stats.live).toBe(0);
		u.dispose();
	});

	it('disposing the client (map change) clears them too', () => {
		const u = setup();
		u.state([pv(ME), infected(2)]);
		u.ev({ e: 'kill', by: ME, targetId: 2, weapon: 'lmg', head: false, x: 100, y: 0, z: 0, yaw: 0 });
		expect(u.fx.stats.corpses).toBe(1);
		u.c.dispose();
		expect(u.fx.stats.corpses).toBe(0);
		u.dispose();
	});
});

describe('sound triggers', () => {
	it('knife bounce and stick sound where they happen; a pickup where the knife lay, mine without a position', () => {
		const u = setup({ me: 2 });
		u.state([pv(1), infected(2), infected(3)]);
		u.ev({ e: 'knifeThrow', id: 7, ownerId: 3, x: 0, y: 0, z: 60, vx: 900, vy: 0, vz: 0 });
		u.ev({ e: 'knifeBounce', id: 7, x: 400, y: 0, z: 50, vx: -300, vy: 0, vz: 100 });
		u.ev({ e: 'knifeStick', id: 7, ownerId: 3, x: 250, y: 10, z: 1, pitch: 80, yaw: 180 });
		u.ev({ e: 'knifePickup', id: 7, ownerId: 3 });
		u.ev({ e: 'knifeThrow', id: 8, ownerId: 2, x: 0, y: 0, z: 60, vx: 900, vy: 0, vz: 0 });
		u.ev({ e: 'knifeStick', id: 8, ownerId: 2, x: 300, y: 0, z: 1, pitch: 80, yaw: 0 });
		u.ev({ e: 'knifePickup', id: 8, ownerId: 2 });
		u.ev({ e: 'knifePickup', id: 99, ownerId: 3 }); // a knife I never saw: nowhere to play it
		expect(u.sounds).toEqual([
			{ name: 'knifeBounce', at: { x: 400, y: 0, z: 50 } },
			{ name: 'knifeStick', at: { x: 250, y: 10, z: 1 } },
			{ name: 'knifePickup', at: { x: 250, y: 10, z: 1 } },
			{ name: 'knifeStick', at: { x: 300, y: 0, z: 1 } },
			{ name: 'knifePickup', at: undefined }
		]);
		expect(u.c.knifeReady).toBe(true);
		u.dispose();
	});

	it('a smashed beacon and a used beacon sound at the beacon; a cleanup is silent', () => {
		const u = setup();
		u.state([pv(ME), infected(2)]);
		const z = 4 + INF_BEACON_HIT_Z;
		u.ev({ e: 'beaconPlace', id: 5, ownerId: 2, x: 10, y: 20, z: 4, yaw: 0 });
		u.ev({ e: 'beaconDestroy', id: 5, ownerId: 2, by: null, x: 10, y: 20, z: 4 });
		u.ev({ e: 'beaconPlace', id: 6, ownerId: 2, x: 10, y: 20, z: 4, yaw: 0 });
		u.ev({ e: 'beaconDestroy', id: 6, ownerId: 2, by: ME, x: 10, y: 20, z: 4 });
		u.ev({ e: 'beaconPlace', id: 7, ownerId: 2, x: 30, y: 40, z: 4, yaw: 0 });
		u.ev({ e: 'beaconUse', id: 7, ownerId: 2, x: 30, y: 40, z: 4 });
		expect(u.sounds).toEqual([
			{ name: 'beaconSmash', at: { x: 10, y: 20, z } },
			{ name: 'beaconUse', at: { x: 30, y: 40, z } }
		]);
		u.dispose();
	});
});

describe('hosts without the newer members', () => {
	it('fake renderers and a host without avatars take every event without throwing', () => {
		const sounds: string[] = [];
		const tracers: Array<{ from: Vec3; to: Vec3 }> = [];
		// The shape other test harnesses use: only the members that existed before this feedback.
		const renderer = { syncKnives: () => {}, syncBeacons: () => {}, uavPulse: () => {}, spark: () => {}, clear: () => {} };
		const vm = {
			setWeapon: () => {},
			setOffhandKnife: () => {},
			thrown: () => {},
			fired: () => {},
			tracer: (from: Vec3, to: Vec3) => void tracers.push({ from: { ...from }, to: { ...to } }),
			updateViewmodel: () => {},
			clear: () => {}
		};
		const host: InfHost = {
			online: () => true,
			selfId: () => ME,
			send: () => {},
			zombieRenderer: () => vm as unknown as ZombieRenderer,
			infectedRenderer: () => renderer as unknown as InfectedRenderer,
			name: (id) => `P${id}`,
			notice: () => {},
			teleport: () => {},
			sound: (name) => void sounds.push(name),
			setZoom: () => {},
			push: () => {}
		};
		const run = (h: InfHost) => {
			const c = new InfectedClient(h, T0, testWorld());
			c.onModeState(
				{ phase: 'playing', round: 1, timeLeft: 100, loadout: 'lmg', secondary: 'pistol', moab: null, alphaId: null, survivors: 2, infected: 2, players: [pv(ME), pv(2), infected(3), infected(4)], knives: [], beacons: [] },
				T0
			);
			const o = { x: 0, y: 0, z: 64 };
			const events: InfEvent[] = [
				{ e: 'hit', by: ME, targetId: 3, head: true, kill: false },
				{ e: 'kill', by: ME, targetId: 3, weapon: 'lmg', head: true, x: 0, y: 0, z: 0, yaw: 0 },
				{ e: 'infect', id: 2, by: 4, method: 'claws', timeAdded: 20 },
				shot(2, 'striker', o, { x: 1, y: 0, z: 0 }, 400, [0, 0, -1, 64]),
				shot(4, 'claws', o, { x: 1, y: 0, z: 0 }, 0),
				{ e: 'moabDetonate', by: ME, kills: 1 }
			];
			for (const ev of events) c.onEvent(ev, T0);
			c.press('attack', true, T0);
			c.tick(T0, { x: 0, y: 0, z: 0 }, VIEW_HEIGHT, 60, 0, false);
			c.frame(T0 + 16, true, 0);
			expect(c.isDown(3)).toBe(true);
			expect(c.isDown(4)).toBe(true);
			c.dispose();
		};
		run(host);
		// The old tracer start (below the eye), two pellets, then my own shot.
		expect(tracers.slice(0, 2).map((t) => t.from)).toEqual([
			{ x: 0, y: 0, z: 58 },
			{ x: 0, y: 0, z: 58 }
		]);
		expect(tracers).toHaveLength(3);
		// No 'infect': without avatars the victim's position is unknown, and a sound without one would read as my own infection.
		expect(sounds).toEqual(['hitHead', 'death', 'impact', 'shot-striker', 'claws', 'moabDetonate', 'shot-barrett', 'impact']);
		// No renderers at all.
		sounds.length = 0;
		run({ ...host, zombieRenderer: () => null, infectedRenderer: () => null });
		expect(sounds).toContain('death');
	});
});
