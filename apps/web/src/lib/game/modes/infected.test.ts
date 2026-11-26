/** InfectedMode: what the adapter decides between game.ts and InfectedClient. */
import {
	getMap,
	DUCK_VIEW_HEIGHT,
	INF_INFECTED_SPEED,
	Status,
	WEAPONS,
	ZM_SLOW_MS,
	type InfEvent,
	type InfPhase,
	type InfPlayerView,
	type InfStateView,
	type NetState,
	type WeaponId
} from '@surf/shared';
import { describe, expect, it, vi } from 'vitest';
import { emptyPose } from '../../render/players.js';
import { addKnockback, aimFov, zoomFov } from '../gunfeel.js';
import { fakeHost, mocks, remote } from './armed-test-host.js';
import { InfectedMode } from './infected.js';

const MAP = getMap('infected_outpost')!;
const SPAWNS = MAP.spawns!;
const ZERO = { x: 0, y: 0, z: 0 };
const TICK = 1000 / 64;

const player = (id: number, over: Partial<InfPlayerView> = {}): InfPlayerView => ({
	id, team: 'survivor', alpha: false, hp: 100, alive: true, score: 0, kills: 0, deaths: 0, weapon: 'pistol', hasKnife: false, hasBeacon: false,
	streak: 0, perks: [], moabReady: false, ...over
});

function setup(online = true) {
	const f = fakeHost(MAP, 'infected');
	f.host.online = online;
	if (!online) f.host.selfId = f.host.viewId = -1;
	const mode = new InfectedMode(f.host);
	const now = performance.now();
	const ev = (e: InfEvent, at = now) => mode.message({ type: 'inf', ev: e }, at);
	return {
		...f,
		mode,
		now,
		ev,
		phase: (phase: InfPhase) => ev({ e: 'phase', phase, round: 1, loadout: 'lmg' }),
		state: (over: Partial<InfStateView> = {}, at = now) =>
			mode.message(
				{
					type: 'modeState', mode: 'infected', phase: 'playing', round: 1, timeLeft: 60, loadout: 'lmg', secondary: 'pistol', moab: null, alphaId: null,
					survivors: 1, infected: 0, players: [player(7, { weapon: 'lmg' })], knives: [], beacons: [], ...over
				},
				at
			),
		/** Ticks and frames for `ms`, from `at` on; returns the time after them. */
		run(at: number, ms: number): number {
			for (const until = at + ms; at < until; at += TICK) {
				mode.tick(at, at);
				mode.frame(at);
			}
			return at;
		}
	};
}

type Setup = ReturnType<typeof setup>;
const infect = (s: Setup) => s.ev({ e: 'infect', id: 7, by: null, method: 'claws', timeAdded: 0 });
const hold = (s: Setup, weapon: WeaponId, mag = 5) => s.ev({ e: 'ammo', id: 7, weapon, mag, reserve: 10 });

describe('InfectedMode', () => {
	it('a spawn event teleports the player and turns the view', () => {
		const s = setup();
		s.ev({ e: 'spawn', id: 7, x: 1, y: 2, z: 3, yaw: 45, hp: 100, team: 'survivor', alpha: false, weapon: 'lmg', mag: 1, reserve: 1, hasKnife: false, reason: 'join' });
		expect(s.host.teleport).toHaveBeenCalledExactlyOnceWith({ pos: { x: 1, y: 2, z: 3 }, yaw: 45 });
	});

	it('moves with the physics cvars of now at the speed of the held weapon, and not at all while down', () => {
		const s = setup();
		s.phase('playing');
		hold(s, 'lmg');
		const own = s.host.sv.sv_maxspeed;
		s.host.sv = { ...s.host.sv, sv_gravity: 321 };
		expect(s.mode.moveCvars(s.now)).toEqual({ ...s.host.sv, sv_maxspeed: WEAPONS.lmg.moveSpeed });
		expect(s.host.sv.sv_maxspeed).toBe(own);
		infect(s);
		expect(s.mode.moveCvars(s.now)!.sv_maxspeed).toBe(INF_INFECTED_SPEED);
		s.ev({ e: 'kill', by: 9, targetId: 7, weapon: 'lmg', head: false, x: 0, y: 0, z: 0, yaw: 0 });
		expect(s.mode.moveCvars(s.now)).toBeNull();
	});

	it('a hit slows until its time is over at the end of the tick, and its knockback adds to the velocity', () => {
		const s = setup();
		s.phase('playing');
		infect(s);
		Object.assign(s.host.player.velocity, { x: 50, y: 60, z: 70 });
		const want = { ...s.host.player.velocity };
		addKnockback(want, -30, 10);
		s.ev({ e: 'hurt', id: 7, hp: 50, stacks: 1, kx: -30, ky: 10 });
		expect(s.host.player.velocity).toEqual(want);
		expect(s.mode.moveCvars(s.now + ZM_SLOW_MS - 1)!.sv_maxspeed).toBeLessThan(INF_INFECTED_SPEED);
		expect(s.mode.moveCvars(s.now + ZM_SLOW_MS)!.sv_maxspeed).toBe(INF_INFECTED_SPEED);
	});

	it('a tick hands the client the end of the tick, the ducked eye and the movement after it', () => {
		const s = setup();
		const tick = vi.spyOn(s.mode.client, 'tick');
		const p = s.host.player;
		Object.assign(p, { ducked: true, duckAmount: 1, onGround: false });
		Object.assign(s.host, { pitch: 12, yaw: 34 });
		s.mode.tick(s.now + 5000, s.now + 10);
		expect(tick).toHaveBeenCalledExactlyOnceWith(s.now + 10, p.origin, p.origin.z + DUCK_VIEW_HEIGHT, 12, 34, true, p.velocity, false);
	});

	it('teleport zones run after the client\'s tick, and only without a server round', () => {
		const s = setup();
		const tick = vi.spyOn(s.mode.client, 'tick');
		const zones = vi.mocked(s.host.teleportZones);
		s.mode.tick(s.now, s.now);
		expect(zones).toHaveBeenCalledTimes(1);
		expect(zones.mock.invocationCallOrder[0]).toBeGreaterThan(tick.mock.invocationCallOrder[0]!);
		expect(SPAWNS).toContain(zones.mock.calls[0]![0]());
		s.phase('playing');
		s.mode.tick(s.now, s.now);
		expect(zones).toHaveBeenCalledTimes(1);
	});

	it('chat restart: a random spawn without a round, else a notice, also while spectating', () => {
		const s = setup();
		s.mode.chatRestart();
		expect(SPAWNS).toContain(vi.mocked(s.host.teleport).mock.calls[0]![0]);
		expect(s.host.notice).not.toHaveBeenCalled();
		s.phase('playing');
		s.host.spec = { targetId: 9, freeFly: false, pos: ZERO };
		s.mode.chatRestart();
		expect(s.host.teleport).toHaveBeenCalledTimes(1);
		expect(s.host.notice).toHaveBeenCalledWith('Infected rounds restart by themselves (Esc › Servers to change map).');
	});

	it('chat restart leaves a spectator where they are, as R does', () => {
		const s = setup();
		s.phase('waiting');
		s.host.spec = { targetId: 9, freeFly: false, pos: ZERO };
		s.mode.chatRestart();
		expect(s.host.teleport).not.toHaveBeenCalled();
		expect(s.host.notice).not.toHaveBeenCalled();
	});

	it('back into play after spectating: a map spawn, also during a round', () => {
		const s = setup();
		s.phase('playing');
		s.mode.respawn();
		expect(SPAWNS).toContain(vi.mocked(s.host.teleport).mock.calls[0]![0]);
	});

	it('R reloads', () => {
		const s = setup();
		s.phase('playing');
		hold(s, 'lmg', 1);
		s.mode.restart(s.now);
		expect(s.host.send).toHaveBeenCalledExactlyOnceWith({ type: 'reload' });
	});

	it('beacon and moab are separate commands', () => {
		const s = setup();
		s.phase('playing');
		s.ev({ e: 'moabReady', id: 7 });
		s.mode.command('beacon', s.now);
		expect(s.host.send).not.toHaveBeenCalled();
		s.mode.command('moab', s.now);
		expect(s.host.send).toHaveBeenLastCalledWith({ type: 'callMoab' });
		infect(s);
		s.mode.command('moab', s.now);
		expect(s.host.send).toHaveBeenCalledTimes(1);
		s.mode.command('beacon', s.now);
		expect(s.host.send).toHaveBeenLastCalledWith({ type: 'placeBeacon' });
	});

	it('number keys swap weapons', () => {
		const s = setup();
		s.phase('playing');
		expect(s.mode.slot(2, s.now)).toBe(true);
		expect(s.host.send).toHaveBeenCalledExactlyOnceWith({ type: 'loadout', weapon: 'pistol' });
	});

	it('aiming zooms the view and the FOV, and letting go of every button ends a held aim', () => {
		const s = setup(false);
		let at = s.run(s.now, 100);
		s.mode.press('attack2', true, at);
		at = s.run(at, 1000);
		expect(s.mode.view).toMatchObject({ zoomFov: aimFov(101, s.mode.client.weapon), zoomT: 1 });
		expect(s.renderer.setFov).toHaveBeenLastCalledWith(zoomFov(101, s.mode.view.zoomFov, 1));
		s.mode.release(at);
		s.run(at, 1000);
		expect(s.mode.view.zoomT).toBe(0);
		expect(s.renderer.setFov).toHaveBeenLastCalledWith(101);
	});

	it('letting go of every button stops automatic fire', () => {
		const s = setup();
		s.phase('playing');
		s.state();
		s.ev({ e: 'ammo', id: 7, weapon: 'lmg', mag: 90, reserve: 200 });
		const shots = () => vi.mocked(s.host.send).mock.calls.filter(([m]) => m.type === 'fire').length;
		let at = s.run(s.now, 1500);
		s.mode.press('attack', true, at);
		at = s.run(at, 1000);
		const fired = shots();
		expect(fired).toBeGreaterThan(3);
		s.mode.release(at);
		s.run(at + 300, 1000);
		expect(shots()).toBe(fired);
	});

	it('with cl_aimtoggle the aim stays after the button, also when every button is let go', () => {
		const s = setup(false);
		s.cvars.cl_aimtoggle = 1;
		let at = s.run(s.now, 100);
		s.mode.press('attack2', true, at);
		s.mode.press('attack2', false, at);
		s.mode.release(at);
		at = s.run(at, 1000);
		expect(s.mode.view.zoomT).toBe(1);
	});

	it('a shot kicks the view, never the aim angles', () => {
		const s = setup(false);
		const at = s.run(s.now, 100);
		s.mode.press('attack', true, at);
		s.run(at, 60);
		const v = s.mode.view;
		expect([v.kickPitch, v.kickYaw, v.kickRoll].some((k) => Math.abs(k) > 0.01)).toBe(true);
		expect(s.host.setAngles).not.toHaveBeenCalled();
	});

	it('each part of the kick is its own axis', () => {
		const s = setup();
		const host = (s.mode.client as unknown as { host: { setViewKick(p: number, y: number, r: number): void } }).host;
		host.setViewKick(1, 2, 3);
		expect(s.mode.view).toMatchObject({ kickPitch: 1, kickYaw: 2, kickRoll: 3 });
	});

	it('the client knows the view and the aim cvars of the frame before it builds it', () => {
		const s = setup();
		const seen: unknown[] = [];
		const c = s.mode.client;
		vi.spyOn(c, 'frame').mockImplementation(() => {
			seen.push([c.viewYaw, c.fov, c.aimToggle]);
			return s.host.hud.infected!;
		});
		s.cvars.cl_aimtoggle = 1;
		s.mode.frame(s.now);
		expect(seen).toEqual([[30, 101, true]]);
	});

	it('the HUD follows a spectated player, and nobody in free-fly', () => {
		const s = setup();
		s.state({ players: [player(7), player(9, { score: 5 })] });
		const spec = { targetId: 9, freeFly: false, pos: ZERO };
		s.host.spec = spec;
		s.host.viewId = 9;
		Object.assign(s.host.player.velocity, { x: 30, y: 40, z: 900 });
		s.mode.frame(s.now);
		expect(s.host.hud.infected).toMatchObject({ spectating: true, focusId: 9, spec: { id: 9, name: 'P9', score: 5 } });
		expect(vi.mocked(s.renderer.zombies.updateViewmodel).mock.lastCall![1]).toBe(false);
		spec.freeFly = true;
		s.mode.frame(s.now);
		expect(s.host.hud.infected).toMatchObject({ spectating: true, focusId: 7, spec: null });
		s.host.spec = null;
		s.mode.frame(s.now);
		expect(s.host.hud.infected).toMatchObject({ spectating: false, focusId: 7 });
		expect(vi.mocked(s.renderer.zombies.updateViewmodel).mock.lastCall!.slice(1, 4)).toEqual([true, expect.any(Number), 50]);
	});

	it('publishes its HUD view on construction, then only when it changed, and takes it back on dispose', () => {
		const s = setup();
		expect(s.hudWrites).toHaveLength(1);
		s.mode.frame(s.now);
		s.mode.frame(s.now + 1);
		expect(s.hudWrites).toHaveLength(1);
		s.ev({ e: 'alpha', id: 9 });
		s.mode.frame(s.now + 2);
		expect(s.hudWrites).toHaveLength(2);
		expect(s.host.hud.infected!.flash!.text).toBe('P9 is Patient Zero · run!');
		s.mode.dispose();
		expect(s.hudWrites.at(-1)).toBeNull();
	});

	it('disposing while zoomed in clears the renderers and sets the FOV cvar back', () => {
		const s = setup(false);
		const at = s.run(s.now, 100);
		s.mode.press('attack2', true, at);
		s.run(at, 1000);
		expect(s.renderer.setFov).not.toHaveBeenLastCalledWith(101);
		s.mode.dispose();
		expect(s.renderer.setFov).toHaveBeenLastCalledWith(101);
		expect(s.renderer.infected.clear).toHaveBeenCalled();
		expect(s.renderer.zombies.clear).toHaveBeenCalled();
	});

	it('practice targets stand at the map spawns, seen in the world of the map', () => {
		const s = setup(false);
		const trace = vi.spyOn(s.host.world, 'trace');
		s.run(s.now, 50);
		const at = s.mode.client.practiceTargets().map((t) => t.spawn);
		expect(at.length).toBeGreaterThan(0);
		for (const t of s.mode.client.practiceTargets()) expect(t.pose).toMatchObject(SPAWNS[t.spawn]!.pos);
		expect(trace).toHaveBeenCalled();
	});

	it('remote players: the role only (the client sets what they hold), hidden while down, speed capped as on the server', () => {
		const s = setup();
		s.state({ players: [player(8, { team: 'infected', alive: false }), player(9, { team: 'infected', alpha: true })] });
		const set = vi.fn();
		const players = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => set(k, ...a) }) as Parameters<InfectedMode['dress']>[0];
		for (const id of [8, 9, 10]) s.mode.dress(players, remote(id), true, 55);
		expect(s.renderer.players.setHeld).not.toHaveBeenCalled();
		s.mode.frame(s.now);
		expect(s.renderer.players.setHeld).toHaveBeenCalled();
		expect(s.renderer.infected.syncKnives).toHaveBeenCalled();
		expect(set.mock.calls).toEqual([['setInfected', 8, 'infected', 55], ['setInfected', 9, 'alpha', 55], ['setInfected', 10, 'none', 55]]);
		expect([8, 9, 10].map((id) => s.mode.isDown(id))).toEqual([true, false, false]);
		const pose = { ...emptyPose(), vx: 3000, vy: 4000 };
		s.mode.adjustPose(pose);
		expect(Math.hypot(pose.vx, pose.vy)).toBeLessThan(4000);
		expect(pose.vy / pose.vx).toBeCloseTo(4 / 3);
	});

	it('ignores the messages of other modes', () => {
		const s = setup();
		const state = vi.spyOn(s.mode.client, 'onModeState');
		const event = vi.spyOn(s.mode.client, 'onEvent');
		s.mode.message({ type: 'modeState', mode: 'tag', phase: 'waiting', round: 0, timeLeft: 0, it: [], immune: [], scores: [] }, s.now);
		s.mode.message({ type: 'zm', ev: { e: 'shot', by: 9, weapon: 'pistol', o: ZERO, d: ZERO, len: 0 } }, s.now);
		expect(state).not.toHaveBeenCalled();
		expect(event).not.toHaveBeenCalled();
	});

	it('shots are heard from my eye; spectating from the camera, the target\'s own without a position', () => {
		const shot: InfEvent = { e: 'shot', by: 9, weapon: 'lmg', o: { x: 500, y: 0, z: 64 }, d: { x: 1, y: 0, z: 0 }, len: 10 };
		const s = setup();
		s.phase('playing');
		s.ev(shot);
		expect(s.host.audio.infected).toHaveBeenCalledWith('shot-lmg', shot.o, { x: 1, y: 2, z: 3 }, 30);
		s.host.spec = { targetId: 9, freeFly: false, pos: { x: 500, y: 0, z: 64 } };
		s.host.remotes = new Map([[9, remote(9)]]);
		s.ev(shot);
		expect(s.host.audio.infected).toHaveBeenCalledWith('shot-lmg', undefined, s.host.spec.pos, 30);
	});

	it('cases are heard where they land: shells, and everything else as brass', () => {
		const s = setup();
		s.host.spec = { targetId: 9, freeFly: false, pos: { x: 500, y: 0, z: 64 } };
		const at = { x: 500, y: 0, z: 0 };
		s.mode.caseLanded('shell', at);
		expect(s.host.audio.infected).toHaveBeenLastCalledWith('shell', at, s.host.spec.pos, 30);
		s.mode.caseLanded('fifty', at);
		expect(s.host.audio.infected).toHaveBeenLastCalledWith('casing', at, s.host.spec.pos, 30);
	});

	it('network status is Alive, Infected or Alpha, without a stage or run', () => {
		const s = setup();
		const net = { stage: 4, runTicks: 99 } as NetState;
		s.mode.netState(net);
		expect(net).toEqual({ status: Status.Alive, stage: 0, runTicks: 0 });
		s.ev({ e: 'alpha', id: 7 });
		s.mode.netState(net);
		expect(net.status).toBe(Status.Alpha);
		infect(s);
		s.mode.netState(net);
		expect(net.status).toBe(Status.Infected);
	});

	it('the solo scoreboard row is an Alive row without the tag mark', () => {
		const { mode } = setup(false);
		vi.spyOn(mode.client, 'soloRow').mockReturnValue({ kills: 3, deaths: 1, score: 50 });
		expect(mode.soloRow()).toStrictEqual({ status: Status.Alive, kills: 3, deaths: 1, score: 50, it: undefined });
	});

	it('offline my name is the game\'s, as for every player', () => {
		const s = setup(false);
		const host = (s.mode.client as unknown as { host: { name(id: number): string } }).host;
		expect(host.name(-1)).toBe('P-1');
	});

	it('without WebGL it runs, kicks and disposes', () => {
		const f = fakeHost(MAP, 'infected');
		Object.assign(f.host, { renderer: null, online: false, selfId: -1 });
		const mode = new InfectedMode(f.host);
		const now = performance.now();
		mode.tick(now, now);
		mode.frame(now);
		mode.dispose();
		expect(f.host.hud.infected).toBeNull();
	});
});
