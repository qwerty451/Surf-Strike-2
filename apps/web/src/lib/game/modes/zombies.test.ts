/** ZombiesMode: what the adapter decides between game.ts and ZombiesClient. */
import {
	buildCollisionWorld,
	DUCK_VIEW_HEIGHT,
	getMap,
	Status,
	WEAPONS,
	ZM_SLOW_MS,
	ZM_ZOMBIE_SPEED,
	type NetState,
	type WeaponId,
	type ZmEvent,
	type ZmPlayerView,
	type ZmStateView
} from '@surf/shared';
import { describe, expect, it, vi } from 'vitest';
import { fakeHost, mocks, remote } from './armed-test-host.js';
import type { ModeServerMessage } from './types.js';
import { ZombiesMode } from './zombies.js';

const MAP = getMap('zombies_lowtide')!;
const GATE = MAP.zombies!.gates[0]!;
const IN_GATE = { x: (GATE.min.x + GATE.max.x) / 2, y: (GATE.min.y + GATE.max.y) / 2, z: (GATE.min.z + GATE.max.z) / 2 };
const ZERO = { x: 0, y: 0, z: 0 };

const player = (id: number, over: Partial<ZmPlayerView> = {}): ZmPlayerView => ({ id, team: 'survivor', hp: 100, alive: true, kills: 0, deaths: 0, weapon: 'pistol', ...over });

function setup(online = true, opts: { spectating?: number } = {}) {
	const f = fakeHost(MAP, 'zombies');
	f.host.online = online;
	if (!online) f.host.selfId = -1;
	if (opts.spectating !== undefined) {
		f.host.spec = { targetId: opts.spectating, freeFly: false, pos: { x: 500, y: 0, z: 64 } };
		f.host.remotes = new Map([[opts.spectating, remote(opts.spectating)]]);
	}
	const mode = new ZombiesMode(f.host);
	const now = performance.now();
	return {
		...f,
		mode,
		now,
		ev: (ev: ZmEvent, at = now) => mode.message({ type: 'zm', ev }, at),
		state: (over: Partial<ZmStateView> = {}, at = now) =>
			mode.message(
				{
					type: 'modeState', mode: 'zombies', phase: 'playing', round: 1, timeLeft: 0, elapsed: 0, checkpoint: 0, checkpoints: 5, progress: 0,
					zombies: 0, kills: 0, gates: [], players: [player(7)], ...over
				},
				at
			)
	};
}

type Setup = ReturnType<typeof setup>;
const hold = (s: Setup, weapon: WeaponId, mag = 5) => s.ev({ e: 'ammo', id: 7, weapon, mag, reserve: 10 });

describe('ZombiesMode', () => {
	it('solo: the player is put at the start during construction and moves in the solo game, closed gates solid', () => {
		const { mode, host } = setup(false);
		expect(host.teleport).toHaveBeenCalledTimes(1);
		const s = vi.mocked(host.teleport).mock.calls[0]![0];
		expect(Math.hypot(s.pos.x - MAP.spawn.pos.x, s.pos.y - MAP.spawn.pos.y)).toBeLessThan(200);
		expect(host.world).toBe(mode.client.world);
		expect(buildCollisionWorld(MAP).trace(IN_GATE, IN_GATE, ZERO, ZERO).startsolid).toBe(false);
		expect(host.world.trace(IN_GATE, IN_GATE, ZERO, ZERO).startsolid).toBe(true);
	});

	it('solo: after a restart the player moves in the world of the new round', () => {
		const s = setup(false);
		const solid = () => s.host.world.trace(IN_GATE, IN_GATE, ZERO, ZERO).startsolid;
		s.mode.client.world.setOpen(0, true);
		expect(solid()).toBe(false);
		s.mode.chatRestart(s.now);
		expect(solid()).toBe(true);
		s.mode.client.world.setOpen(0, true);
		expect(solid()).toBe(false);
	});

	it('online: the gates of the mode state are the gates of the world', () => {
		const s = setup();
		const solid = () => s.host.world.trace(IN_GATE, IN_GATE, ZERO, ZERO).startsolid;
		expect(solid()).toBe(true);
		s.state({ gates: [{ state: 'open', secsLeft: 0 }] });
		expect(solid()).toBe(false);
	});

	it('a spawn event teleports the player and turns the view', () => {
		const s = setup();
		s.ev({ e: 'spawn', id: 7, x: 1, y: 2, z: 3, yaw: 45, hp: 100, team: 'survivor', reason: 'join' });
		expect(s.host.teleport).toHaveBeenCalledExactlyOnceWith({ pos: { x: 1, y: 2, z: 3 }, yaw: 45 });
	});

	it('moves with the physics cvars of now at the speed of the held weapon, and not at all while down', () => {
		const s = setup();
		hold(s, 'lmg');
		const own = s.host.sv.sv_maxspeed;
		s.host.sv = { ...s.host.sv, sv_gravity: 321 };
		expect(s.mode.moveCvars(s.now)).toEqual({ ...s.host.sv, sv_maxspeed: WEAPONS.lmg.moveSpeed });
		expect(s.host.sv.sv_maxspeed).toBe(own);
		s.ev({ e: 'down', id: 7 });
		expect(s.mode.moveCvars(s.now)).toBeNull();
	});

	it('a hit slows until its time is over at the end of the tick, and its knockback replaces the horizontal velocity', () => {
		const s = setup();
		s.ev({ e: 'spawn', id: 7, x: 0, y: 0, z: 0, yaw: 0, hp: 100, team: 'zombie', reason: 'zombie' });
		Object.assign(s.host.player.velocity, { x: 50, y: 60, z: 70 });
		s.ev({ e: 'zhurt', id: 7, hp: 50, stacks: 1, kx: -300, ky: 10 });
		expect(s.host.player.velocity).toEqual({ x: -300, y: 10, z: 70 });
		expect(s.mode.moveCvars(s.now + ZM_SLOW_MS - 1)!.sv_maxspeed).toBeLessThan(ZM_ZOMBIE_SPEED);
		expect(s.mode.moveCvars(s.now + ZM_SLOW_MS)!.sv_maxspeed).toBe(ZM_ZOMBIE_SPEED);
	});

	it('a tick fires from the ducked eye at the end of the tick and never runs the teleport zones', () => {
		const s = setup();
		s.state();
		Object.assign(s.host.player, { ducked: true, duckAmount: 1 });
		Object.assign(s.host, { pitch: 0, yaw: 90 });
		s.mode.press('attack', true, s.now);
		// A click is kept 150 ms: `now` of the frame is far past it, the tick's end is not.
		s.mode.tick(s.now + 5000, s.now + 10);
		const o = s.host.player.origin;
		expect(s.host.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'fire', weapon: 'pistol', origin: { x: o.x, y: o.y, z: o.z + DUCK_VIEW_HEIGHT } }));
		const shot = vi.mocked(s.host.send).mock.calls[0]![0] as { dir: { x: number; y: number } };
		expect(shot.dir.y).toBeGreaterThan(0.9);
		expect(s.host.teleportZones).not.toHaveBeenCalled();
	});

	it('R reloads; chat restart starts the solo round over, online it only explains', () => {
		const s = setup();
		hold(s, 'pistol', 1);
		s.mode.restart(s.now);
		expect(s.host.send).toHaveBeenCalledWith({ type: 'reload' });
		s.mode.chatRestart(s.now);
		expect(s.host.notice).toHaveBeenCalledWith(expect.stringMatching(/restart by themselves/));

		const solo = setup(false);
		solo.mode.chatRestart(solo.now);
		expect(solo.host.teleport).toHaveBeenCalledTimes(2);
		expect(solo.host.notice).toHaveBeenCalledWith('Round restarted.');
	});

	it('back into play after spectating: a map spawn', () => {
		const s = setup();
		s.mode.respawn();
		expect(MAP.spawns ?? [MAP.spawn]).toContain(vi.mocked(s.host.teleport).mock.calls[0]![0]);
	});

	it('number keys pick a weapon', () => {
		const s = setup();
		s.state({ phase: 'countdown' });
		const lmg = WEAPONS.lmg.slot;
		expect(s.mode.slot(lmg, s.now)).toBe(true);
		expect(s.host.send).toHaveBeenCalledWith({ type: 'loadout', weapon: 'lmg' });
	});

	it('letting go of every button stops automatic fire', () => {
		const s = setup();
		s.state();
		hold(s, 'lmg', 90);
		const shots = () => vi.mocked(s.host.send).mock.calls.length;
		s.mode.press('attack', true, s.now);
		for (let t = 0; t < 1000; t += 16) s.mode.tick(s.now + t, s.now + t);
		const fired = shots();
		expect(fired).toBeGreaterThan(3);
		s.mode.release(s.now + 1000);
		for (let t = 1300; t < 2300; t += 16) s.mode.tick(s.now + t, s.now + t);
		expect(shots()).toBe(fired);
	});

	it('the scope sets the FOV; unscoping and disposing set the FOV cvar back', () => {
		const s = setup();
		hold(s, 'sniper');
		s.mode.press('attack2', true, s.now);
		expect(s.renderer.setFov).toHaveBeenLastCalledWith(WEAPONS.sniper.zoomFov);
		s.mode.press('attack2', true, s.now);
		expect(s.renderer.setFov).toHaveBeenLastCalledWith(101);
		s.mode.press('attack2', true, s.now);
		s.cvars.fov = 88;
		s.mode.dispose();
		expect(s.renderer.setFov).toHaveBeenLastCalledWith(88);
	});

	it('says which FOV the scope holds, for a change of the fov cvar meanwhile', () => {
		const s = setup();
		hold(s, 'sniper');
		expect(s.mode.scopeFov).toBe(null);
		s.mode.press('attack2', true, s.now);
		expect(s.mode.scopeFov).toBe(WEAPONS.sniper.zoomFov);
		s.mode.press('attack2', true, s.now);
		expect(s.mode.scopeFov).toBe(null);
	});

	it('publishes its HUD view on construction, then only when it changed, and takes it back on dispose', () => {
		const s = setup();
		expect(s.hudWrites).toHaveLength(1);
		s.mode.frame(s.now);
		s.mode.frame(s.now + 1);
		expect(s.hudWrites).toHaveLength(1);
		s.ev({ e: 'down', id: 9 });
		s.mode.frame(s.now + 2);
		expect(s.hudWrites).toHaveLength(2);
		expect(s.host.hud.zombies!.killFeed[0]!.text).toBe('P9 turned');
		s.mode.dispose();
		expect(s.hudWrites.at(-1)).toBeNull();
	});

	it('the viewmodel sways with the horizontal speed and is off while spectating', () => {
		const s = setup();
		const vm = vi.mocked(s.renderer.zombies.updateViewmodel);
		Object.assign(s.host.player.velocity, { x: 30, y: 40, z: 900 });
		s.mode.frame(s.now);
		expect(vm.mock.lastCall!.slice(1, 4)).toEqual([true, expect.any(Number), 50]);
		s.host.spec = { targetId: null, freeFly: true, pos: ZERO };
		s.mode.frame(s.now + 1);
		expect(vm.mock.lastCall![1]).toBe(false);
	});

	it('dresses remote players: survivors hold their weapon, zombies are zombies with empty hands', () => {
		const s = setup();
		s.state({ players: [player(8, { weapon: 'sniper' }), player(9, { team: 'zombie', weapon: 'claws', alive: false })] });
		const players = mocks<Parameters<ZombiesMode['dress']>[0]>();
		for (const id of [8, 9, 10]) s.mode.dress(players, remote(id));
		expect(vi.mocked(players.setHeld).mock.calls).toEqual([[8, 'sniper'], [9, null], [10, null]]);
		expect(vi.mocked(players.setZombie).mock.calls).toEqual([[8, false], [9, true], [10, false]]);
		expect([8, 9, 10].map((id) => s.mode.isDown(id))).toEqual([false, true, false]);
	});

	it.each<[WeaponId, 'fire' | 'swing']>([['pistol', 'fire'], ['knife', 'swing'], ['claws', 'swing']])('a %s shot of another player: their avatar %ss', (weapon, action) => {
		const s = setup();
		s.ev({ e: 'shot', by: 9, weapon, o: ZERO, d: { x: 1, y: 0, z: 0 }, len: 0 });
		expect(vi.mocked(s.host.avatarAct).mock.calls).toEqual([[9, action]]);
		s.ev({ e: 'hurt', id: 9, hp: 1, zid: 1 });
		expect(s.host.avatarAct).toHaveBeenCalledTimes(1);
	});

	it('ignores the messages of other modes', () => {
		const s = setup();
		const state = vi.spyOn(s.mode.client, 'onModeState');
		const event = vi.spyOn(s.mode.client, 'onEvent');
		const tag: ModeServerMessage = { type: 'modeState', mode: 'tag', phase: 'waiting', round: 0, timeLeft: 0, it: [], immune: [], scores: [] };
		s.mode.message(tag, s.now);
		s.mode.message({ type: 'inf', ev: { e: 'shot', by: 9, weapon: 'pistol', o: ZERO, d: ZERO, len: 0 } }, s.now);
		expect(state).not.toHaveBeenCalled();
		expect(event).not.toHaveBeenCalled();
		expect(s.host.avatarAct).not.toHaveBeenCalled();
	});

	it('zombie frames are drawn', () => {
		const s = setup();
		s.mode.zombies({ tick: 1, zombies: [{ id: 3, x: 1, y: 2, z: 3, yaw: 0, flags: 0, hp: 1 }] }, s.now - 1000);
		s.mode.frame(s.now);
		expect(vi.mocked(s.renderer.zombies.sync).mock.lastCall![0]).toMatchObject([{ id: 3, x: 1, y: 2, z: 3 }]);
	});

	it('shots are heard from my eye; spectating from the camera, the target\'s own without a position', () => {
		const shot: ZmEvent = { e: 'shot', by: 9, weapon: 'lmg', o: { x: 500, y: 0, z: 64 }, d: ZERO, len: 0 };
		const me = setup();
		me.ev(shot);
		expect(me.host.audio.zombies).toHaveBeenLastCalledWith('shot-lmg', shot.o, { x: 1, y: 2, z: 3 }, 30);
		const spec = setup(true, { spectating: 9 });
		spec.ev(shot);
		expect(spec.host.audio.zombies).toHaveBeenLastCalledWith('shot-lmg', undefined, spec.host.spec!.pos, 30);
	});

	it('cases are heard where they land: shells, and everything else as brass', () => {
		const s = setup(true, { spectating: 9 });
		const at = { x: 500, y: 0, z: 0 };
		s.mode.caseLanded('shell', at);
		expect(s.host.audio.zombies).toHaveBeenLastCalledWith('shell', at, s.host.spec!.pos, 30);
		s.mode.caseLanded('fifty', at);
		expect(s.host.audio.zombies).toHaveBeenLastCalledWith('casing', at, s.host.spec!.pos, 30);
	});

	it('network status is Alive or Down, without a stage or run', () => {
		const s = setup();
		const net = { stage: 4, runTicks: 99 } as NetState;
		s.mode.netState(net);
		expect(net).toEqual({ status: Status.Alive, stage: 0, runTicks: 0 });
		s.ev({ e: 'down', id: 7 });
		s.mode.netState(net);
		expect(net.status).toBe(Status.Down);
	});

	it('the solo scoreboard has kills and downs, no tag score, and the solo round as its state', () => {
		const { mode } = setup(false);
		expect(mode.soloRow()).toStrictEqual({ status: Status.Alive, kills: 0, deaths: 0, score: undefined, it: undefined });
		expect(mode.soloState()).toMatchObject({ mode: 'zombies', phase: 'countdown', players: [{ id: 1 }] });
		vi.spyOn(mode.client, 'soloRow').mockReturnValue({ kills: 3, deaths: 1, alive: false });
		expect(mode.soloRow()).toMatchObject({ status: Status.Down, kills: 3, deaths: 1 });
		const online = setup();
		online.state();
		expect(online.mode.soloState()).toBeNull();
	});

	it('names: mine in solo, where every player is me; the game\'s online', () => {
		const kill: ZmEvent = { e: 'kill', by: 9, zid: 1, weapon: 'pistol', head: false, x: 0, y: 0, z: 0, yaw: 0 };
		const online = setup();
		online.ev(kill);
		online.mode.frame(online.now);
		expect(online.host.hud.zombies!.killFeed[0]!.text).toMatch(/^P9 /);
		const solo = setup(false);
		(solo.mode.client as unknown as { handle(e: ZmEvent[], now: number): void }).handle([kill], solo.now);
		solo.mode.frame(solo.now);
		expect(solo.host.hud.zombies!.killFeed[0]!.text).toMatch(/^Me /);
	});
});
