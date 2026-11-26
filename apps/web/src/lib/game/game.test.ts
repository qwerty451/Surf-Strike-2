/**
 * What game.ts asks of the gamemode and when (modes/types.ts), with a recording
 * ClientMode and stubs for the renderer, sound, input and network. The modes
 * have tests of their own.
 */
import { buildCollisionWorld, clampRenderTime, decodeState, getMap, PROTOCOL_VERSION, Status, withTeleportSeq, ZM_HISTORY_MS, type ClientMessage, type CollisionWorld, type PlayerState, type ServerMessage } from '@surf/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMode, ClientModeHost } from './modes/types.js';

type AnyFn = (...args: never[]) => unknown;
/** A mode that records its calls; `n` counts the modes made in a test. */
type FakeMode = { -readonly [K in keyof ClientMode]: ClientMode[K] } & { n: number; host: ClientModeHost; calls: unknown[][]; onTick?: () => void };

const T = vi.hoisted(() => ({
	order: [] as string[],
	made: [] as unknown[],
	/** Members of the next mode made, and what its constructor does. */
	next: {} as Record<string, unknown>,
	construct: null as ((host: unknown) => void) | null,
	conn: null as unknown,
	connection: null as unknown,
	audio: null as unknown,
	renderer: null as unknown,
	mouse: { dx: 0, dy: 0 },
	/** An object whose every member is a mock (and an object again). */
	mocks(own: object = {}): never {
		const members = { ...own } as Record<string | symbol, unknown>;
		return new Proxy(members, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : (t[k] = vi.fn())) }) as never;
	}
}));

vi.mock('../render/renderer.js', () => ({
	GameRenderer: class {
		avatars = new Map<number, { visible: boolean }>();
		players = T.mocks({
			has: (id: number) => this.avatars.has(id),
			upsert: (id: number) => void this.avatars.set(id, { visible: false }),
			remove: (id: number) => void this.avatars.delete(id),
			clear: () => this.avatars.clear(),
			setPose: (id: number, _p: unknown, visible: boolean) => void (this.avatars.get(id)!.visible = visible)
		});
		zombies = T.mocks({ casings: T.mocks() });
		infected = T.mocks();
		cashBag = T.mocks();
		ghost = T.mocks();
		setFov = vi.fn();
		setView = vi.fn();
		render = vi.fn();
		dispose = vi.fn();
		constructor() {
			T.renderer = this;
		}
		loadMap(): void {
			T.order.push('renderer');
			this.avatars.clear();
		}
	}
}));
vi.mock('../audio/audio.js', () => ({
	GameAudio: class {
		constructor() {
			return (T.audio = T.mocks({ jump: vi.fn(), land: vi.fn(), update: vi.fn() })) as object;
		}
	}
}));
vi.mock('../input/input.js', () => ({
	Input: class {
		locked = true;
		consumeMouse(out: { dx: number; dy: number }): void {
			Object.assign(out, T.mouse);
		}
		exitLock(): void {}
		dispose(): void {}
	}
}));
vi.mock('../input/fullscreen.js', () => ({ GameFullscreen: class { supported = false; enter(): void {} exit(): void {} dispose(): void {} } }));
vi.mock('../render/character/preview.js', () => ({ CharacterPreview: class {}, disposeItemPictures: () => {}, itemPicture: () => null, warmItemPictures: () => {} }));
vi.mock('../net/connection.js', () => ({
	Connection: class {
		client: unknown = null;
		constructor(handlers: unknown) {
			T.conn = handlers;
			T.connection = this;
		}
		start(): void {}
		connect(): boolean {
			return true;
		}
		disconnect(): void {}
		holdOff = vi.fn();
		dispose(): void {}
	}
}));
vi.mock('./modes/index.js', () => ({
	startSpawn: (map: { spawn: unknown }) => map.spawn,
	createClientMode: (host: { sv: unknown }) => {
		const n = T.made.length;
		T.order.push(`create ${n}`);
		const calls: unknown[][] = [];
		const note = (name: string) => (...args: unknown[]) => void calls.push([name, ...args]);
		const mode: Record<string, unknown> = {
			n, host, calls, id: 'surf',
			press: note('press'), release: note('release'), command: note('command'), restart: note('restart'), back: note('back'), respawn: note('respawn'),
			frame: note('frame'), message: note('message'), peopleChanged: note('peopleChanged'),
			dress: (_players: unknown, p: { id: number }, visible: boolean) => void calls.push(['dress', p.id, visible]),
			tick: () => (mode.onTick as AnyFn | undefined)?.(),
			moveCvars: () => host.sv,
			isDown: (id: number) => id === 3,
			slot: vi.fn(() => true),
			netState: (s: { status: number }) => void (s.status = 7),
			soloRow: () => ({ status: 7, kills: 3 }),
			dispose: () => void T.order.push(`dispose ${n}`),
			...T.next
		};
		T.construct?.(host);
		T.made.push(mode);
		return mode;
	}
}));

import { MAX_EXTRAP_DISTANCE } from '../net/interp.js';
import { Game } from './game.js';
import { memoryStore, type KeyValueStore } from './storage.js';

/** The private members the tests look at. */
interface Inside {
	frame(now: number): void;
	player: PlayerState;
	yaw: number;
	store: KeyValueStore;
}
interface Handlers {
	open(client: { send(m: ClientMessage): void }, scope: string | null): void;
	message(m: ServerMessage): void;
	snapshot(frame: { seq: number; serverTimeMs: number; entries: object[] }, arrival: number): void;
	closed(wasOpen: boolean, url: string, code: number): void;
}

let clock = 0;
vi.spyOn(performance, 'now').mockImplementation(() => clock);
vi.stubGlobal('requestAnimationFrame', () => 1);
vi.stubGlobal('cancelAnimationFrame', () => {});
afterAll(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const mode = (): FakeMode => T.made.at(-1) as FakeMode;
const called = (): unknown[] => mode().calls.map((c) => c[0]);
const audio = () => T.audio as { jump: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
const renderer = () => T.renderer as { avatars: Map<number, { visible: boolean }>; setFov: ReturnType<typeof vi.fn> };

function setup() {
	const game = new Game({} as HTMLCanvasElement);
	game.hud.authPanelOpen = false;
	const inside = game as unknown as Inside;
	const conn = T.conn as Handlers;
	const sent: ClientMessage[] = [];
	const states: ArrayBuffer[] = [];
	let snapSeq = 0;
	return {
		game, inside, conn, sent, states,
		frames(n: number): void {
			for (let i = 0; i < n; i++) inside.frame((clock += 15.625));
		},
		/** Connected as player 7, with players 2 and 3. */
		online(version: number | null = PROTOCOL_VERSION, map = 'tag_quayside'): void {
			(T.connection as { client: unknown }).client = { url: 'x', send: (m: ClientMessage) => sent.push(m), sendBinary: (b: ArrayBuffer) => states.push(b), close: (code = 0) => conn.closed(true, 'x', code) };
			conn.message({
				type: 'welcome', ...(version === null ? {} : { version }), selfId: 7, map, mode: getMap(map)!.kind, mapTimeLeft: 60, cvars: {}, account: null,
				players: [2, 3].map((id) => ({ id, name: `P${id}`, spectating: false })),
				records: { pbTicks: null, pbSplits: null, rank: null, recordTicks: null, recordName: null }
			} as unknown as ServerMessage);
		},
		snapshot(): void {
			conn.snapshot(
				{
					seq: ++snapSeq,
					serverTimeMs: clock,
					entries: [2, 3].map((id) => ({ id, tick: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0, flags: 0, status: Status.Runner, stage: 0, runTicks: 0 }))
				},
				clock
			);
		}
	};
}

beforeEach(() => {
	clock += 1000;
	T.order.length = T.made.length = 0;
	T.next = {};
	T.construct = null;
	T.mouse = { dx: 0, dy: 0 };
});

it.each([null, 1, 2])('stays solo and backs off on a welcome with version %s', (version) => {
	const { game, online, sent } = setup();
	online(version);
	expect(game.hud.online).toBe(false);
	expect(sent).toEqual([]);
	expect(game.hud.chat.at(-1)?.text).toMatch(/server runs a different version.*reload.*wait/i);
	expect((T.connection as { holdOff: ReturnType<typeof vi.fn> }).holdOff).toHaveBeenCalledWith(60_000);
	game.destroy();
});

it('acknowledges each delivery of the applied spawn and applies it once', () => {
	const { game, conn, online, sent } = setup();
	online();
	const spawn = { type: 'zm', ev: { e: 'spawn', id: 7 }, spawnSeq: 2 } as Extract<ServerMessage, { type: 'zm' }>;
	conn.message(spawn);
	conn.message(spawn);
	conn.message({ ...spawn, spawnSeq: 1 });
	expect(mode().calls.filter(([name]) => name === 'message')).toHaveLength(1);
	expect(sent.slice(1)).toEqual([{ type: 'spawnAck', seq: 2 }, { type: 'spawnAck', seq: 2 }]);
	game.destroy();
});

it('sends a login token in hello only for its identified session scope', () => {
	const { inside, conn, online } = setup();
	inside.store = memoryStore({
		'surf.session:discovery:/api/server': JSON.stringify({ token: 'legacy-token', username: 'Player' })
	});
	const send = vi.fn();
	const first = 'discovery:/api/server:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
	const second = 'discovery:/api/server:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
	conn.open({ send }, first);
	expect(send.mock.lastCall?.[0]).not.toHaveProperty('token');
	online();
	conn.message({ type: 'auth', ok: true, username: 'Player', token: 'new-token' });
	conn.open({ send }, second);
	expect(send.mock.lastCall?.[0]).not.toHaveProperty('token');
	conn.open({ send }, first);
	expect(send.mock.lastCall?.[0]).toMatchObject({ type: 'hello', token: 'new-token' });
	conn.open({ send }, null);
	expect(send.mock.lastCall?.[0]).not.toHaveProperty('token');
});

describe('the mode of a map', () => {
	it('is made after the renderer has the map and the old mode is gone', () => {
		const s = setup();
		T.order.length = 0;
		s.game.changeMap('surf_ember');
		expect(T.order).toEqual(['renderer', 'dispose 0', 'create 1']);
		expect(mode().host.map.id).toBe('surf_ember');
	});

	it('may set the world the player moves in; the next map starts in its own', () => {
		const s = setup();
		const world: CollisionWorld = buildCollisionWorld(getMap('surf_ember')!);
		T.construct = (host) => (host as ClientModeHost).setWorld(world);
		s.game.changeMap('surf_ember');
		expect(mode().host.world).toBe(world);
		const trace = vi.spyOn(world, 'trace');
		s.frames(2);
		expect(trace).toHaveBeenCalled();
		T.construct = null;
		s.game.changeMap('surf_aurora');
		expect(mode().host.world).not.toBe(world);
	});

	it('carries on when the connection is lost if it can, else it is made anew', () => {
		const offline = vi.fn();
		for (const [own, made] of [[{ offline }, 0], [{}, 1]] as const) {
			const s = setup();
			T.next = own;
			s.online();
			const before = T.made.length;
			s.conn.closed(true, 'x', 1006);
			expect(T.made.length - before).toBe(made);
			expect(mode().host.online).toBe(false);
		}
		expect(offline).toHaveBeenCalledTimes(1);
	});

	it('goes with the game', () => {
		const s = setup();
		T.order.length = 0;
		s.game.destroy();
		expect(T.order).toEqual(['dispose 0']);
	});
});

describe('a tick', () => {
	it('moves the player with the cvars of the mode, then ticks the mode', () => {
		const s = setup();
		s.frames(3);
		const before = s.inside.player.tick;
		const seen: number[] = [];
		mode().onTick = () => seen.push(s.inside.player.tick);
		s.frames(1);
		expect(seen).toEqual([before + 1]);
		const sv = mode().host.sv;
		Object.assign(s.inside.player.velocity, { x: 0, y: 0, z: 0 });
		s.inside.player.onGround = false;
		mode().moveCvars = () => ({ ...sv, sv_gravity: 0 });
		s.frames(1);
		expect(s.inside.player.velocity.z).toBe(0);
	});

	it('without movement: no jump again, no footsteps', () => {
		const s = setup();
		s.frames(3);
		expect(audio().update).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ active: true }));
		mode().moveCvars = () => null;
		const { tick } = s.inside.player;
		s.inside.player.jumped = true;
		audio().jump.mockClear();
		s.frames(2);
		expect(s.inside.player.tick).toBe(tick);
		expect(audio().jump).not.toHaveBeenCalled();
		expect(audio().update).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ active: false }));
		mode().moveCvars = () => mode().host.sv;
		s.frames(1);
		expect(audio().update).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ active: true }));
	});
});

const combatPose = { tick: 1, x: 0, y: 0, z: 512, vx: 1000, vy: 0, vz: 0, pitch: 0, yaw: 0, flags: 0, status: Status.Running, stage: 0, runTicks: 0 };

it('draws the confirmed combat position immediately after a large predicted overshoot', () => {
	const s = setup();
	s.online(PROTOCOL_VERSION, 'zombies_lowtide');
	const host = mode().host;
	host.setWorld(buildCollisionWorld({ brushes: [] }));
	const at = clock;
	s.conn.snapshot({ seq: 1, serverTimeMs: at, entries: [{ ...combatPose, id: 2, sampleTimeMs: at }] }, clock);
	for (let seq = 2; seq <= 6; seq++) {
		s.frames(2);
		s.conn.snapshot({ seq, serverTimeMs: clock, entries: [] }, clock);
	}
	const remote = host.remotes.get(2)!;
	expect(remote.sample.x).toBe(MAX_EXTRAP_DISTANCE);
	s.conn.snapshot({ seq: 7, serverTimeMs: clock, entries: [
		{ ...combatPose, id: 2, tick: 7, x: 20, vx: 0, sampleTimeMs: at + 100 }
	] }, clock);
	let maxGap = 0;
	for (let frame = 0; frame < 6; frame++) {
		s.frames(1);
		maxGap = Math.max(maxGap, Math.abs(remote.sample.x - 20));
	}
	expect(maxGap).toBe(0);
	s.game.destroy();
});

it('keeps another combat player past their teleport when a late stop shortens a prediction', () => {
	const s = setup();
	s.online(PROTOCOL_VERSION, 'zombies_lowtide');
	const host = mode().host;
	host.setWorld(buildCollisionWorld({ brushes: [] }));
	mode().isDown = () => false;
	const at = clock;
	const publish = (seq: number, entries: object[]) => s.conn.snapshot({ seq, serverTimeMs: clock, entries }, clock);
	const other = { ...combatPose, id: 3, vx: 0 };
	publish(1, [{ ...combatPose, id: 2, sampleTimeMs: at }, { ...other, sampleTimeMs: at }]);
	s.frames(2);
	publish(2, []);
	s.frames(2);
	const teleported = { ...other, x: 400, flags: withTeleportSeq(0, 1) };
	publish(3, [{ ...teleported, tick: 5, sampleTimeMs: clock }]);
	s.frames(2);
	publish(4, [{ ...teleported, tick: 7, sampleTimeMs: clock }]);
	s.frames(2);
	publish(5, []);
	s.frames(2);
	const beforeStop = host.renderServerTimeMs;
	expect(host.remotes.get(3)?.sample.x).toBe(400);

	publish(6, [{ ...combatPose, id: 2, tick: 3, x: 20, vx: 0, sampleTimeMs: at + 31.25 }]);
	s.frames(1);
	expect(host.renderServerTimeMs).toBeGreaterThan(beforeStop);
	expect(host.remotes.get(2)?.sample.x).toBe(20);
	expect(host.remotes.get(3)?.sample.x).toBe(400);
	s.game.destroy();
});

it('reports the held combat pose while other targets keep playing', () => {
	const s = setup();
	s.online(PROTOCOL_VERSION, 'zombies_lowtide');
	mode().host.setWorld(buildCollisionWorld({ brushes: [] }));
	mode().isDown = () => false;
	const at = clock;
	s.conn.snapshot({ seq: 1, serverTimeMs: at, entries: [
		{ ...combatPose, id: 2, sampleTimeMs: at },
		{ ...combatPose, id: 3, sampleTimeMs: at }
	] }, clock);
	s.frames(16);
	s.conn.snapshot({ seq: 2, serverTimeMs: clock, entries: [
		{ ...combatPose, id: 3, tick: 16, x: clock - at, sampleTimeMs: clock }
	] }, clock);
	s.frames(2);
	const host = mode().host;
	const held = at + MAX_EXTRAP_DISTANCE;
	expect(host.remotes.get(2)?.sample.x).toBeCloseTo(MAX_EXTRAP_DISTANCE);
	expect(host.remotes.get(3)?.sample.x).toBeCloseTo(host.renderServerTimeMs - at);
	expect(host.renderServerTimeMs).toBeGreaterThan(held);
	expect(decodeState(s.states.at(-1)!)?.renderServerTimeMs).toBe(held);
	host.send({ type: 'knife', origin: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 } });
	expect(s.sent.at(-1)).toMatchObject({ type: 'knife', renderServerTimeMs: held });
	s.game.destroy();
});

it.each([
	{ rtt: 40, ms: 272 },
	{ rtt: 220, ms: 382 }
])('bounds stale state and attack claims to $ms ms at $rtt ms RTT', ({ rtt, ms }) => {
	const s = setup();
	s.online(PROTOCOL_VERSION, 'zombies_lowtide');
	const host = mode().host;
	host.setWorld(buildCollisionWorld({ brushes: [] }));
	const downlink = rtt / 2;
	const at = clock - downlink;
	s.conn.message({ type: 'pong', t: clock - rtt, serverTime: at });
	s.conn.snapshot({ seq: 1, serverTimeMs: at, entries: [{ ...combatPose, id: 2, sampleTimeMs: at }] }, clock);
	s.frames(22);
	for (const frames of [2, 32]) {
		s.frames(frames);
		const receivedAt = clock + rtt - downlink;
		const oldest = receivedAt - ms;
		const held = host.remotes.get(2)!;
		expect(held.sample.x).toBe(MAX_EXTRAP_DISTANCE);
		expect(at + MAX_EXTRAP_DISTANCE).toBeLessThan(oldest);
		const stateClaim = decodeState(s.states.at(-1)!)?.renderServerTimeMs;
		expect(stateClaim).toBe(oldest);
		host.send({ type: 'knife', origin: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 } });
		const attack = s.sent.at(-1);
		expect(attack).toMatchObject({ type: 'knife', renderServerTimeMs: oldest });
		expect(clampRenderTime(stateClaim!, receivedAt, Math.min(rtt, 150), ZM_HISTORY_MS)).toBe(oldest);
	}
	s.game.destroy();
});

describe('spectating', () => {
	it('shows in the state packet, keeps commands from the mode and puts the player back after it', () => {
		const s = setup();
		s.online();
		s.frames(2);
		s.snapshot();
		s.frames(12);
		expect(decodeState(s.states.at(-1)!)!.status).toBe(7);
		mode().calls.length = 0;
		s.game.spectate('P2');
		expect(called()).toContain('release');
		expect(mode().host.viewId).toBe(2);
		s.frames(2);
		expect(decodeState(s.states.at(-1)!)!.status).toBe(Status.Spectating);
		mode().calls.length = 0;
		s.game.restart();
		s.game.back();
		s.game.beacon();
		s.game.moab();
		expect(called()).toEqual([]);
		s.game.spectate('');
		expect(called()).toEqual(['release', 'respawn']);
		expect(mode().host.viewId).toBe(7);
		s.game.restart();
		s.game.back();
		s.game.beacon();
		expect(mode().calls.slice(2).map((c) => c.slice(0, c[0] === 'command' ? 2 : 1))).toEqual([['restart'], ['back'], ['command', 'beacon']]);
	});
});

describe('other players', () => {
	it('are dressed by the mode, and not drawn while it says they are down', () => {
		const s = setup();
		s.online();
		s.frames(1);
		s.snapshot();
		s.frames(12);
		s.snapshot();
		s.frames(4);
		expect(mode().calls).toContainEqual(['dress', 2, true]);
		expect(mode().calls.filter((c) => c[0] === 'dress' && c[1] === 3 && c[2] === true)).toEqual([]);
		expect([renderer().avatars.get(2)!.visible, renderer().avatars.get(3)!.visible]).toEqual([true, false]);
	});

	it('the mode gets its messages and hears who leaves', () => {
		const s = setup();
		s.online();
		mode().calls.length = 0;
		const state = { type: 'modeState', mode: 'tag', phase: 'waiting', round: 1, timeLeft: 0, it: [], immune: [], scores: [] } as ServerMessage;
		s.conn.message(state);
		s.conn.message({ type: 'tagged', by: 2, target: 3 } as ServerMessage);
		s.conn.message({ type: 'leave', id: 3 } as ServerMessage);
		expect(mode().calls.map((c) => c.slice(0, 2))).toEqual([['message', state], ['message', { type: 'tagged', by: 2, target: 3 }], ['peopleChanged']]);
		expect(s.game.hud.modeState).toMatchObject({ mode: 'tag' });
	});
});

describe('what the mode decides', () => {
	it('fills the solo row and takes number keys', () => {
		const s = setup();
		s.frames(60);
		expect(s.game.hud.scoreboard[0]).toMatchObject({ status: 7, kills: 3, ping: 0 });
		s.game.vote(1);
		expect(mode().slot).toHaveBeenCalledExactlyOnceWith(1, clock);
	});

	it('zooms: the mouse turns the view less', () => {
		const s = setup();
		s.frames(2);
		T.mouse = { dx: 4, dy: 0 };
		const turn = (): number => {
			const yaw = s.inside.yaw;
			s.frames(1);
			return yaw - s.inside.yaw;
		};
		const plain = turn();
		expect(plain).toBeGreaterThan(0);
		(mode() as { view: ClientMode['view'] }).view = { zoomFov: 20, zoomT: 1, kickPitch: 0, kickYaw: 0, kickRoll: 0 };
		expect(turn()).toBeLessThan(plain * 0.9);
	});

	it('holds a scope through a change of the fov cvar', () => {
		const s = setup();
		mode().scopeFov = 40;
		s.game.cvars.set('fov', 81);
		expect(renderer().setFov).toHaveBeenLastCalledWith(40);
		mode().scopeFov = null;
		s.game.cvars.set('fov', 82);
		expect(renderer().setFov).toHaveBeenLastCalledWith(82);
	});
});
