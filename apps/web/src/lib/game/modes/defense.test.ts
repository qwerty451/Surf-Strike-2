/** DefenseMode: keys, menus, repair hold, server state and events between game.ts and DefenseClient. */
import { getMap, Status, ZDF_FROSTED, type NetState, type ZdEvent, type ZdPlayerView, type ZdStateView } from '@surf/shared';
import { describe, expect, it } from 'vitest';
import { zombiePose } from '../defense.js';
import { fakeHost } from './armed-test-host.js';
import { DefenseMode } from './defense.js';

const MAP = getMap('defense_blackthorn')!;
const INFO = MAP.defense!;

const player = (id: number, over: Partial<ZdPlayerView> = {}): ZdPlayerView => ({
	id,
	status: 'alive',
	hp: 10,
	maxHp: 10,
	gold: 400,
	kills: 0,
	deaths: 0,
	weapon: 'pistol',
	weapons: ['pistol'],
	hpLevel: 0,
	damageLevel: 0,
	reloadLevel: 0,
	ready: false,
	...over
});

function setup(online = true) {
	const f = fakeHost(MAP, 'defense');
	f.host.online = online;
	if (!online) f.host.selfId = -1;
	const mode = new DefenseMode(f.host);
	const now = performance.now();
	const sent = () => (f.host.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0]);
	return {
		...f,
		mode,
		now,
		sent,
		ev: (ev: ZdEvent, at = now) => mode.message({ type: 'zd', ev }, at),
		state: (over: Partial<ZdStateView> = {}, at = now) =>
			mode.message(
				{
					type: 'modeState',
					mode: 'defense',
					phase: 'build',
					round: 1,
					wave: 1,
					timeLeft: 30,
					elapsed: 0,
					toSpawn: 0,
					alive: 0,
					left: 0,
					kills: 0,
					boss: null,
					openings: INFO.openings.map((o) => ({ planks: o.planks ?? 6, max: o.planks ?? 6, reinforce: 0 })),
					pads: INFO.pads.map(() => ({ type: null, level: 0, owner: null })),
					players: [player(7)],
					...over
				},
				at
			),
		at: (x: number, y: number, z: number) => {
			f.host.player.origin.x = x;
			f.host.player.origin.y = y;
			f.host.player.origin.z = z;
			mode.tick(now, now);
		}
	};
}

const lastView = (s: ReturnType<typeof setup>) => s.hudWrites.at(-1) as import('../contract.js').DefenseView;

describe('DefenseMode', () => {
	it('solo: runs DefenseGame locally, build phase with the start gold; F starts the wave', () => {
		const s = setup(false);
		s.mode.frame(s.now);
		expect(lastView(s)).toMatchObject({ phase: 'build', gold: 400, status: 'alive', online: false });
		s.mode.command('ready', s.now + 10);
		s.mode.tick(s.now + 20, s.now + 20);
		s.mode.frame(s.now + 20);
		expect(lastView(s).phase).toBe('wave');
	});
	it('number keys swap to owned weapons only and tell the server', () => {
		const s = setup();
		s.state({ players: [player(7, { weapons: ['pistol', 'smg', 'lmg'] })] });
		expect(s.mode.slot(2, s.now)).toBe(true);
		expect(s.sent()).toContainEqual({ type: 'zd', act: { a: 'weapon', weapon: 'smg' } });
		s.mode.slot(3, s.now); // shotgun not owned
		expect(s.sent().filter((m) => (m as { type: string }).type === 'zd')).toHaveLength(1);
		s.mode.frame(s.now);
		expect(lastView(s).weapon).toBe('smg');
	});
	it('a bought weapon arrives with its ammo and is held at once', () => {
		const s = setup();
		s.state();
		s.ev({ e: 'ammo', id: 7, weapon: 'sniper', mag: 5, reserve: 30 });
		s.mode.frame(s.now);
		expect(lastView(s)).toMatchObject({ weapon: 'sniper', mag: 5, reserve: 30 });
		expect(lastView(s).weapons.map((w) => w.key)).toEqual([1, 5]);
	});
	it('E on a pad opens the pad menu; number keys pick its rows, E closes', () => {
		const s = setup();
		s.state();
		const p = INFO.pads[6]!.pos;
		s.at(p.x, p.y, p.z);
		s.mode.frame(s.now);
		expect(lastView(s).prompt?.text).toBe('E: build a turret here');
		s.mode.command('beacon', s.now);
		expect(lastView(s).menu?.kind).toBe('pad');
		s.mode.slot(1, s.now);
		expect(s.sent()).toContainEqual({ type: 'zd', act: { a: 'pad', pad: 6, op: 'build', turret: 'sentry' } });
		s.mode.slot(3, s.now); // mortar: too expensive, refused locally
		expect(s.sent().filter((m) => (m as { type: string }).type === 'zd')).toHaveLength(1);
		s.mode.command('beacon', s.now);
		expect(lastView(s).menu).toBeNull();
	});
	it('B opens the shop in the build phase only; B goes back a page, then closes', () => {
		const s = setup();
		s.state({ phase: 'wave' });
		s.mode.command('shop', s.now);
		expect(lastView(s).menu).toBeNull();
		s.state({ phase: 'build' });
		s.mode.command('shop', s.now);
		expect(lastView(s).menu?.kind).toBe('shop');
		s.mode.slot(3, s.now);
		s.mode.frame(s.now);
		expect(lastView(s).menu?.kind).toBe('barricades');
		s.mode.command('shop', s.now);
		expect(lastView(s).menu?.kind).toBe('shop');
		s.mode.command('shop', s.now);
		expect(lastView(s).menu).toBeNull();
		s.mode.command('shop', s.now);
		s.state({ phase: 'wave' });
		s.mode.frame(s.now);
		expect(lastView(s).menu).toBeNull(); // the wave closes it
	});
	it('holding E at a damaged barricade repairs until the key is let go', () => {
		const s = setup();
		const openings = INFO.openings.map((o) => ({ planks: o.planks ?? 6, max: o.planks ?? 6, reinforce: 0 }));
		openings[0]!.planks = 2;
		s.state({ phase: 'wave', openings });
		const n = INFO.nav.nodes[INFO.openings[0]!.inside]!;
		s.at(n.x, n.y, n.z);
		s.mode.command('beacon', s.now);
		expect(s.sent()).toContainEqual({ type: 'zd', act: { a: 'repair', on: true } });
		s.mode.commandUp('beacon', s.now);
		expect(s.sent().at(-1)).toEqual({ type: 'zd', act: { a: 'repair', on: false } });
	});
	it('a broken barricade opens the local collision; a plank event closes it again', () => {
		const s = setup();
		const openings = INFO.openings.map((o) => ({ planks: o.planks ?? 6, max: o.planks ?? 6, reinforce: 0 }));
		openings[1]!.planks = 0;
		s.state({ openings });
		const o = INFO.openings[1]!;
		const mid = { x: (o.min.x + o.max.x) / 2, y: (o.min.y + o.max.y) / 2, z: o.min.z + 40 };
		const solid = () => s.host.world.trace(mid, mid, { x: -1, y: -1, z: -1 }, { x: 1, y: 1, z: 1 }).startsolid;
		expect(solid()).toBe(false);
		s.ev({ e: 'plank', opening: 1, planks: 1, by: 7 });
		expect(solid()).toBe(true);
	});
	it('dead or waiting players do not move and report Down', () => {
		const s = setup();
		s.state();
		expect(s.mode.moveCvars()).not.toBeNull();
		s.ev({ e: 'death', id: 7, zid: 3 });
		expect(s.mode.moveCvars()).toBeNull();
		const ns = { status: Status.Alive, stage: 0, runTicks: 0 } as NetState;
		s.mode.netState(ns);
		expect(ns.status).toBe(Status.Down);
	});
	it('zombie kinds are drawn at their size and colour; frost tints them', () => {
		const walker = zombiePose({ id: 1, x: 0, y: 0, z: 0, yaw: 0, flags: 0, hp: 1, kind: 'walker' });
		const boss = zombiePose({ id: 2, x: 0, y: 0, z: 0, yaw: 0, flags: 0, hp: 1, kind: 'boss' });
		const frosty = zombiePose({ id: 3, x: 0, y: 0, z: 0, yaw: 0, flags: ZDF_FROSTED, hp: 1, kind: 'runner' });
		expect(walker.scale).toBe(1);
		expect(boss.scale).toBeGreaterThan(1.5);
		expect(boss.glow).toBeDefined();
		expect(frosty.tint).not.toBe(zombiePose({ id: 4, x: 0, y: 0, z: 0, yaw: 0, flags: 0, hp: 1, kind: 'runner' }).tint);
	});
});
