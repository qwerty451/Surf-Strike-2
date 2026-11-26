/**
 * What game.ts asks of the gamemode and when (modes/types.ts), with a recording
 * ClientMode and stubs for the renderer, sound, input and network. The modes
 * have tests of their own.
 */
import { buildCollisionWorld, decodeState, getMap, Status, type ClientMessage, type CollisionWorld, type PlayerState, type ServerMessage } from '@surf/shared';
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
		holdOff(): void {}
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

import { Game } from './game.js';

/** The private members the tests look at. */
interface Inside {
	frame(now: number): void;
	player: PlayerState;
	yaw: number;
}
interface Handlers {
	message(m: ServerMessage): void;
	snapshot(entries: object[], arrival: number): void;
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
	return {
		game, inside, conn, sent, states,
		frames(n: number): void {
			for (let i = 0; i < n; i++) inside.frame((clock += 15.625));
		},
		/** Connected as player 7, with players 2 and 3. */
		online(): void {
			(T.connection as { client: unknown }).client = { url: 'x', send: (m: ClientMessage) => sent.push(m), sendBinary: (b: ArrayBuffer) => states.push(b), close: () => {} };
			conn.message({
				type: 'welcome', selfId: 7, map: 'tag_quayside', mode: 'tag', mapTimeLeft: 60, cvars: {}, account: null,
				players: [2, 3].map((id) => ({ id, name: `P${id}`, spectating: false })),
				records: { pbTicks: null, pbSplits: null, rank: null, recordTicks: null, recordName: null }
			} as unknown as ServerMessage);
		},
		snapshot(): void {
			conn.snapshot([2, 3].map((id) => ({ id, tick: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0, flags: 0, status: Status.Runner, stage: 0, runTicks: 0 })), clock);
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
		s.game.slot(1);
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
