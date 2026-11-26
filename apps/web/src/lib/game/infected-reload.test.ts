/**
 * Other players hear and see a reload (docs/modes.md#infected), with the client
 * against the real shared rules: one `InfectedGame` on a fake clock, one
 * `InfectedClient` per player, events routed with `infEventRoute` and
 * client messages fed back into the game the way the server mode does.
 * Every client has real remote avatars to take the position from.
 */
import {
	buildCollisionWorld,
	INF_PRESETS,
	INF_SLEIGHT_RELOAD_FACTOR,
	INF_STEP_MS,
	InfectedGame,
	infEventRoute,
	VIEW_HEIGHT,
	WEAPONS,
	type ClientMessage,
	type InfEvent,
	type MapDef,
	type Vec3
} from '@surf/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { animate, standing } from '../render/players-testkit.js';
import { HeldAssets } from '../render/character/held.js';
import { RemotePlayers } from '../render/players.js';
import { BODY_SOUND_Z } from './infected-feedback.js';
import { InfectedClient, type InfHost, type InfSound } from './infected.js';

beforeAll(() => {
	// The avatars' name tags draw on a canvas; node has none.
	vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
});
afterAll(() => {
	vi.unstubAllGlobals();
});

const SPAWNS = [
	{ pos: { x: -1000, y: -1000, z: 0.25 }, yaw: 0 },
	{ pos: { x: -1000, y: 1000, z: 0.25 }, yaw: 0 },
	{ pos: { x: 1000, y: -1000, z: 0.25 }, yaw: 180 },
	{ pos: { x: 1000, y: 1000, z: 0.25 }, yaw: 180 }
];

/** Flat floor, four spread spawns, a fall-out box far below. */
function testMap(): MapDef {
	return {
		id: 'inf_reload_test',
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

interface Heard {
	name: InfSound;
	at?: Vec3;
}

interface Peer {
	c: InfectedClient;
	sent: ClientMessage[];
	sounds: Heard[];
	/** This client's avatars of the other players. */
	avatars: RemotePlayers;
}

/** Players 1 (Patient Zero), 2 and 3 in a playing LMG round, standing apart. */
function playing() {
	const ids = [1, 2, 3];
	const map = testMap();
	const world = buildCollisionWorld(map);
	const clock = { now: 1_000_000 };
	const game = new InfectedGame({ map, world, now: clock.now, rng: () => 0, graceSecs: 1, endSecs: 1 });
	game.round = INF_PRESETS.indexOf('lmg');
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
	/** A client message, handled like apps/server modes/infected.ts does. */
	const handle = (id: number, msg: ClientMessage) => {
		const now = clock.now;
		if (msg.type === 'fire') route(game.fire(id, { weapon: msg.weapon, origin: msg.origin, dir: msg.dir, tick: msg.tick }, now).events);
		else if (msg.type === 'loadout') route(game.selectWeapon(id, msg.weapon, now));
		else if (msg.type === 'reload' && game.reload(id, now)) route(game.takeEvents());
	};
	for (const id of ids) {
		const peer: Peer = { c: null as unknown as InfectedClient, sent: [], sounds: [], avatars: new RemotePlayers(new HeldAssets()) };
		const host: InfHost = {
			online: () => true,
			selfId: () => id,
			send: (msg) => {
				peer.sent.push(msg);
				handle(id, msg);
			},
			zombieRenderer: () => null,
			infectedRenderer: () => null,
			remotePlayers: () => peer.avatars,
			name: (pid) => `P${pid}`,
			notice: () => {},
			teleport: () => {},
			sound: (name, at) => void peer.sounds.push(at ? { name, at: { ...at } } : { name }),
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
	/** Place a player; every other client draws its avatar there (or hides it). */
	const put = (id: number, x: number, y: number, drawn = true) => {
		const p = { x, y, z: 0.25 };
		pos.set(id, p);
		game.setPlayerPos(id, { ...p, ducked: false, yaw: 0 });
		for (const [other, peer] of peers) {
			if (other === id) continue;
			peer.avatars.upsert(id, `P${id}`);
			peer.avatars.setPose(id, standing(p.x, p.y, p.z), drawn);
		}
	};
	/** `id` pulls the trigger once, aiming level along +y. */
	const shoot = (id: number) => {
		const c = peers.get(id)!.c;
		const o = pos.get(id)!;
		c.press('attack', true, clock.now);
		c.tick(clock.now, o, o.z + VIEW_HEIGHT, 0, 90, false);
		c.press('attack', false, clock.now);
		advance(150);
	};
	/** `id` picks a weapon (the server's answer, as the loadout message gives it). */
	const swap = (id: number, weapon: string) => route(game.selectWeapon(id, weapon, clock.now));
	const heard = (id: number, name: InfSound) => peers.get(id)!.sounds.filter((s) => s.name === name);
	const dispose = () => {
		for (const p of peers.values()) p.avatars.dispose();
	};
	game.syncPlayers(ids, clock.now);
	advance(1200);
	expect(game.phase).toBe('playing');
	expect(game.alphaId).toBe(1);
	put(1, -400, 0);
	put(2, 0, 0);
	put(3, 300, 200);
	advance(50);
	return { game, clock, peers, log, put, shoot, advance, heard, dispose, swap, route, state };
}

describe('other players hear a reload', () => {
	it('a second player hears the first one reload from where their avatar stands; the reloader hears only their own', () => {
		const h = playing();
		h.shoot(2);
		expect(h.log.filter((e) => e.e === 'shot' && e.by === 2)).toHaveLength(1);
		for (const id of [1, 2, 3]) expect(h.heard(id, 'reload')).toEqual([]);
		h.peers.get(2)!.c.reload(h.clock.now);
		expect(h.peers.get(2)!.sent.map((m) => m.type)).toContain('reload');
		expect(h.log.filter((e) => e.e === 'reload')).toEqual([{ e: 'reload', id: 2, weapon: 'lmg', ms: WEAPONS.lmg.reloadMs }]);
		// The reloader: the moves of their own gun, without a position, and not the sound the others hear.
		expect(h.heard(2, 'handle')).toEqual([{ name: 'handle' }]);
		expect(h.heard(2, 'reload')).toEqual([]);
		// The others: one each, at chest height of player 2's avatar.
		const at = { x: 0, y: 0, z: 0.25 + BODY_SOUND_Z };
		expect(h.heard(1, 'reload')).toEqual([{ name: 'reload', at }]);
		expect(h.heard(3, 'reload')).toEqual([{ name: 'reload', at }]);
		// The event went out with the reload: later frames add nothing.
		h.advance(300);
		for (const id of [1, 2, 3]) expect(h.heard(id, 'reload')).toHaveLength(id === 2 ? 0 : 1);
		h.dispose();
	});

	it('the sound follows the avatar: it comes from where this client draws the reloader', () => {
		const h = playing();
		h.shoot(3);
		// Client 1 draws player 3 somewhere else than client 2 does (each interpolates its own snapshots).
		h.peers.get(1)!.avatars.setPose(3, standing(280, 190, 0.25), true);
		h.peers.get(3)!.c.reload(h.clock.now);
		expect(h.heard(1, 'reload')).toEqual([{ name: 'reload', at: { x: 280, y: 190, z: 0.25 + BODY_SOUND_Z } }]);
		expect(h.heard(2, 'reload')).toEqual([{ name: 'reload', at: { x: 300, y: 200, z: 0.25 + BODY_SOUND_Z } }]);
		h.dispose();
	});

	it('without a position there is no sound: an avatar that is not in play, a host without avatars', () => {
		const h = playing();
		h.shoot(2);
		// Client 3 does not draw player 2 (no snapshot yet); client 1 does.
		h.peers.get(3)!.avatars.setPose(2, standing(0, 0, 0.25), false);
		h.peers.get(2)!.c.reload(h.clock.now);
		expect(h.heard(1, 'reload')).toHaveLength(1);
		expect(h.heard(3, 'reload')).toEqual([]);
		expect(h.heard(2, 'handle')).toEqual([{ name: 'handle' }]);
		h.dispose();
		// A client whose host has no avatars at all ignores the event.
		const sounds: string[] = [];
		const bare = new InfectedClient(
			{
				online: () => true,
				selfId: () => 1,
				send: () => {},
				zombieRenderer: () => null,
				infectedRenderer: () => null,
				name: () => 'x',
				notice: () => {},
				teleport: () => {},
				sound: (n) => void sounds.push(n),
				setZoom: () => {},
				push: () => {}
			},
			0
		);
		bare.onEvent({ e: 'reload', id: 2, weapon: 'lmg' }, 10);
		expect(sounds).toEqual([]);
	});

	it('a reload the rules refuse makes no sound for anyone else', () => {
		const h = playing();
		// Full magazine: the client does not even ask.
		h.peers.get(2)!.c.reload(h.clock.now);
		expect(h.peers.get(2)!.sent).toEqual([]);
		// A client that asks anyway (its prediction was off): the server refuses, nobody hears it.
		expect(h.game.reload(2, h.clock.now)).toBe(false);
		h.advance(100);
		for (const id of [1, 2, 3]) expect(h.heard(id, 'reload')).toEqual([]);
		h.dispose();
	});
});

describe('other players see a reload', () => {
	/** Player 2 has fired and starts to reload; the others' avatars of 2 hold the gun. */
	function reloading() {
		const h = playing();
		h.state();
		h.shoot(2);
		const frames = (n: number) => {
			for (let i = 0; i < n; i++) {
				h.clock.now += 1000 / 60;
				for (const [id, p] of h.peers) {
					p.c.frame(h.clock.now, false, 0);
					if (id !== 2) animate(p.avatars, h.clock.now);
				}
			}
		};
		frames(60);
		const start = () => h.peers.get(2)!.c.reload(h.clock.now);
		const ms = (viewer: number) => h.peers.get(viewer)!.avatars.reloading(2);
		const parts = (viewer: number) => h.peers.get(viewer)!.avatars.model(2)!.partsShown;
		return { ...h, frames, start, ms, parts };
	}

	it('the avatar reloads for the time in the event, then holds the gun again', () => {
		const h = reloading();
		h.start();
		for (const v of [1, 3]) expect(h.ms(v)).toBe(WEAPONS.lmg.reloadMs);
		expect(h.peers.get(2)!.avatars.reloading(2)).toBe(0);
		// The server's own time is shorter only for jitter; the avatar takes the whole of it.
		h.frames(Math.floor((WEAPONS.lmg.reloadMs / 1000) * 60 * 0.4));
		for (const v of [1, 3]) expect(h.parts(v)).toContain('mag');
		h.frames(Math.ceil((WEAPONS.lmg.reloadMs / 1000) * 60 * 0.6) + 20);
		for (const v of [1, 3]) expect([h.ms(v), h.parts(v)]).toEqual([0, []]);
		h.dispose();
	});

	it('sleight of hand: the event carries the halved time', () => {
		const h = reloading();
		const ms = WEAPONS.lmg.reloadMs * INF_SLEIGHT_RELOAD_FACTOR;
		h.peers.get(1)!.c.onEvent({ e: 'reload', id: 2, weapon: 'lmg', ms }, h.clock.now);
		expect(h.ms(1)).toBe(ms);
		h.frames(Math.ceil((ms / 1000) * 60) + 2);
		expect(h.ms(1)).toBe(0);
		h.dispose();
	});

	it('an event without a time (or with a malformed one) reloads for the weapon\'s own; a knife never does', () => {
		const h = reloading();
		const c = h.peers.get(1)!.c;
		for (const ms of [undefined, NaN, -5, 1e9, '900' as unknown as number]) {
			c.onEvent(ms === undefined ? { e: 'reload', id: 2, weapon: 'lmg' } : { e: 'reload', id: 2, weapon: 'lmg', ms }, h.clock.now);
			expect(h.ms(1)).toBe(WEAPONS.lmg.reloadMs);
			h.peers.get(1)!.avatars.stopReload(2);
		}
		c.onEvent({ e: 'reload', id: 2, weapon: 'knife', ms: 900 }, h.clock.now);
		c.onEvent({ e: 'reload', id: 99, weapon: 'lmg', ms: 900 }, h.clock.now);
		expect(h.ms(1)).toBe(0);
		h.dispose();
	});

	it('a swap ends it at once for everyone, without a sound and before the mode state names the new weapon', () => {
		const h = reloading();
		h.start();
		h.frames(60);
		const heard = h.heard(1, 'reload').length;
		h.swap(2, 'knife');
		h.swap(2, 'lmg'); // and back: the mode state never shows the knife
		for (const v of [1, 3]) expect(h.ms(v)).toBe(0);
		expect(h.heard(1, 'reload')).toHaveLength(heard);
		h.frames(10);
		expect(h.parts(1)).toEqual([]);
		h.dispose();
	});

	it('a death, an infection, the Patient Zero pick, a shot, a new round and a round called off end it', () => {
		const events: InfEvent[] = [
			{ e: 'kill', by: 3, targetId: 2, weapon: 'lmg', head: false, x: 0, y: 0, z: 0, yaw: 0 } as InfEvent,
			{ e: 'infect', id: 2, by: 1, method: 'claws', timeAdded: 0 },
			{ e: 'alpha', id: 2 },
			{ e: 'shot', by: 2, weapon: 'lmg', o: { x: 0, y: 0, z: 64 }, d: { x: 0, y: 1, z: 0 }, len: 100 },
			{ e: 'phase', phase: 'grace', round: 2, loadout: 'lmg' },
			{ e: 'phase', phase: 'waiting', round: 2, loadout: 'lmg' },
			{ e: 'moabDetonate', by: 3, kills: 1 }
		];
		for (const ev of events) {
			const h = reloading();
			h.start();
			expect(h.ms(1)).toBeGreaterThan(0);
			if (ev.e === 'moabDetonate') h.peers.get(1)!.c.onModeState({ ...h.game.view(h.clock.now), players: h.game.view(h.clock.now).players.map((p) => (p.id === 2 ? { ...p, team: 'infected' as const, alpha: true } : p)) }, h.clock.now);
			h.peers.get(1)!.c.onEvent(ev, h.clock.now);
			expect(h.ms(1), ev.e).toBe(0);
			h.dispose();
		}
	});

	it('the round being played out does not end it: the guns stay', () => {
		const h = reloading();
		h.start();
		h.peers.get(1)!.c.onEvent({ e: 'phase', phase: 'ended', round: 1, loadout: 'lmg' }, h.clock.now);
		expect(h.ms(1)).toBe(WEAPONS.lmg.reloadMs);
		h.dispose();
	});

	it('a player the mode state no longer lists (spectating) or lists as down has none', () => {
		for (const gone of [true, false]) {
			const h = reloading();
			h.start();
			const v = h.game.view(h.clock.now);
			h.peers.get(1)!.c.onModeState({ ...v, players: gone ? v.players.filter((p) => p.id !== 2) : v.players.map((p) => (p.id === 2 ? { ...p, alive: false } : p)) }, h.clock.now);
			expect(h.ms(1)).toBe(0);
			h.dispose();
		}
	});

	it('a late joiner, and a client that starts to draw the player late, see the plain hold or the running reload', () => {
		const h = reloading();
		h.start();
		// No event reached them: nothing.
		const late = new RemotePlayers(new HeldAssets());
		late.upsert(2, 'P2');
		late.setPose(2, standing(0, 0, 0.25), true);
		late.setHeld(2, 'lmg');
		for (let i = 0; i < 60; i++) animate(late, h.clock.now + i);
		expect([late.reloading(2), late.model(2)!.partsShown]).toEqual([0, []]);
		late.dispose();
		// Hidden while it runs (watching through their eyes), then shown: in the middle of it.
		const a = h.peers.get(1)!.avatars;
		a.setPose(2, standing(0, 0, 0.25), false);
		h.frames(100);
		a.setPose(2, standing(0, 0, 0.25), true);
		h.frames(8);
		expect(h.parts(1)).toContain('mag');
		h.dispose();
	});
});
