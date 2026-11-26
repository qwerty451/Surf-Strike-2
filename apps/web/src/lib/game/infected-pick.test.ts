/**
 * Patient Zero pick with the real renderers (InfectedRenderer with its
 * effects, RemotePlayers; a stub `document` stands in for the name-tag
 * canvas): the picked player gets the same transition as an infected
 * survivor, a burst at the body and the avatar easing into its new look.
 */
import { INF_STEP_MS, InfectedGame, buildCollisionWorld, infEventRoute, type InfEvent, type MapDef } from '@surf/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { animate, standing } from '../render/players-testkit.js';
import { HeldAssets } from '../render/character/held.js';
import { InfectedRenderer } from '../render/infected.js';
import { RemotePlayers, TURN_EASE_MS } from '../render/players.js';
import { InfectedClient, type InfHost, type InfSound } from './infected.js';

beforeAll(() => {
	vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
});
afterAll(() => {
	vi.unstubAllGlobals();
});

const SPAWNS = [
	{ pos: { x: -1000, y: -1000, z: 0.25 }, yaw: 0 },
	{ pos: { x: 1000, y: 1000, z: 0.25 }, yaw: 180 }
];

function testMap(): MapDef {
	return {
		id: 'inf_pick_test',
		title: 'Test',
		kind: 'infected',
		difficulty: 'easy',
		layout: 'open',
		cvars: {},
		spawn: SPAWNS[0]!,
		spawns: SPAWNS,
		brushes: [{ type: 'box', min: { x: -1200, y: -1200, z: -64 }, max: { x: 1200, y: 1200, z: 0 }, material: 'm' }],
		zones: [],
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

/**
 * Players 1 and 2 against the real rules (rng 0 picks player 1 as Patient
 * Zero); `me` runs the client and sees the other one as an avatar at (100, 150, 8).
 */
function setup(me: number) {
	const map = testMap();
	const game = new InfectedGame({ map, world: buildCollisionWorld(map), now: 1_000_000, rng: () => 0, graceSecs: 1, endSecs: 1 });
	const other = me === 1 ? 2 : 1;
	const ir = new InfectedRenderer(new HeldAssets());
	const players = new RemotePlayers(new HeldAssets());
	const sounds: InfSound[] = [];
	const log: InfEvent[] = [];
	let now = 1_000_000;
	const host: InfHost = {
		online: () => true,
		selfId: () => me,
		send: () => {},
		zombieRenderer: () => null,
		infectedRenderer: () => ir,
		remotePlayers: () => players,
		name: (id) => `P${id}`,
		notice: () => {},
		teleport: () => {},
		sound: (name) => void sounds.push(name),
		setZoom: () => {},
		push: () => {}
	};
	const c = new InfectedClient(host, now, null);
	/** One frame as game.ts runs it: the remote pose and role, the avatar update, the client frame. */
	const frame = (dt = 16) => {
		now += dt;
		if (!players.has(other)) players.upsert(other, `P${other}`);
		players.setPose(other, standing(100, 150, 8), !c.isDown(other));
		players.setInfected(other, c.roleOf(other), now);
		animate(players, now);
		c.frame(now, true, 0);
		ir.update(now);
	};
	/** Server ticks until `until`; events reach the client, the state follows them (unless withheld). */
	const run = (until: () => boolean, state = true) => {
		for (let i = 0; i < 400 && !until(); i++) {
			now += INF_STEP_MS;
			for (const ev of game.update(now)) {
				log.push(ev);
				const r = infEventRoute(ev);
				if ((r.to === undefined || r.to === me) && r.except !== me) c.onEvent(ev, now);
			}
		}
		if (state) c.onModeState(game.view(now), now);
	};
	game.syncPlayers([1, 2], now);
	run(() => game.phase === 'grace');
	frame();
	return { c, game, ir, fx: ir.fx, players, sounds, log, other, frame, run, state: () => c.onModeState(game.view(now), now) };
}

describe('Patient Zero pick', () => {
	it('the picked player bursts at the body and eases into the Patient Zero look', () => {
		const u = setup(2);
		expect(u.c.roleOf(1)).toBe('none');
		expect(u.fx.stats.turns).toBe(0);
		// The pick arrives; the state that flips the role comes after it.
		u.run(() => u.game.phase === 'playing', false);
		expect(u.log.some((e) => e.e === 'alpha' && e.id === 1)).toBe(true);
		expect(u.fx.stats.turns).toBe(1);
		const burst = u.fx.group.children.find((o) => o.type === 'Group' && o.visible)!;
		expect(burst.position.toArray()).toEqual([100, 8, -150]);
		// The pick's own sound only: no infection sound on top.
		expect(u.sounds.filter((s) => s === 'alpha')).toHaveLength(1);
		expect(u.sounds).not.toContain('infect');
		expect(u.players.feedback(1)!.easing).toBe(false);
		u.state();
		expect(u.c.roleOf(1)).toBe('alpha');
		u.frame();
		expect(u.players.feedback(1)).toMatchObject({ easing: true });
		u.frame(TURN_EASE_MS + 50);
		expect(u.players.feedback(1)!.easing).toBe(false);
		u.frame(2000);
		expect(u.fx.stats.turns).toBe(0);
	});

	it('the state before the event: the avatar still eases, from its survivor look', () => {
		const u = setup(2);
		u.run(() => u.game.phase === 'playing');
		// run() delivered the events first; replay the order the other way round on a fresh avatar.
		u.players.remove(1);
		u.frame();
		expect(u.players.feedback(1)!.easing).toBe(false);
		u.c.onEvent({ e: 'alpha', id: 1 }, 1_100_000);
		animate(u.players, 1_100_000);
		expect(u.players.feedback(1)!.easing).toBe(true);
	});

	it('my own pick has no burst; hidden players burst nothing', () => {
		const me = setup(1);
		me.run(() => me.game.phase === 'playing');
		expect(me.c.isAlpha).toBe(true);
		expect(me.fx.stats.turns).toBe(0);
		expect(me.sounds.filter((s) => s === 'alpha')).toHaveLength(1);
		me.frame();
		expect(me.players.feedback(2)!.easing).toBe(false);

		const hidden = setup(2);
		hidden.players.setHidden(true);
		hidden.run(() => hidden.game.phase === 'playing');
		expect(hidden.fx.stats.turns).toBe(0);
		// Shown again, the avatar is in its new look.
		hidden.players.setHidden(false);
		hidden.frame();
		expect(hidden.c.roleOf(1)).toBe('alpha');
	});
});
