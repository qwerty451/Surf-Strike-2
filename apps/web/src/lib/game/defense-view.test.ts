/** Zombie Defense view helpers: weapon keys, the E target and the shop / pad menu rows. */
import { defenseFixtureMap, getMap, ZD_SHOP, zdTurretCost, zdTurretRefund, type ZdOpeningView, type ZdPlayerView } from '@surf/shared';
import { describe, expect, it } from 'vitest';
import { zdPadMenu, zdPromptText, zdReasonText, zdShopMenu, zdSlotWeapon, zdTurretStats, zdUseTarget, zdWeaponKeys } from './defense-view.js';

const INFO = getMap('defense_blackthorn')!.defense!;
const full = (): ZdOpeningView[] => INFO.openings.map((o) => ({ planks: o.planks ?? 6, max: o.planks ?? 6, reinforce: 0 }));
const me = (over: Partial<ZdPlayerView> = {}): ZdPlayerView => ({
	id: 7,
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

describe('weapon keys', () => {
	it('1-5 follow ZD_WEAPONS and only pick owned weapons', () => {
		const owned = ['pistol', 'lmg'] as const;
		expect(zdSlotWeapon(1, owned)).toBe('pistol');
		expect(zdSlotWeapon(2, owned)).toBeNull(); // smg not owned
		expect(zdSlotWeapon(4, owned)).toBe('lmg');
		expect(zdSlotWeapon(6, owned)).toBeNull();
		expect(zdWeaponKeys(owned, 'lmg')).toEqual([
			{ key: 1, label: 'Pistol', held: false },
			{ key: 4, label: expect.any(String), held: true }
		]);
	});
});

describe('E target', () => {
	const o = INFO.openings[0]!;
	const inside = INFO.nav.nodes[o.inside]!;
	it('repairs a damaged barricade within reach of its inside node, in build and wave phases', () => {
		const st = full();
		st[0] = { ...st[0]!, planks: 2 };
		expect(zdUseTarget(inside, INFO, st, 'wave')).toMatchObject({ kind: 'repair', opening: 0 });
		expect(zdUseTarget(inside, INFO, st, 'build')).toMatchObject({ kind: 'repair', opening: 0 });
		expect(zdUseTarget(inside, INFO, st, 'ended')).toBeNull();
		expect(zdUseTarget(inside, INFO, full(), 'wave')).toBeNull(); // nothing missing
		expect(zdUseTarget({ ...inside, z: inside.z + 300 }, INFO, st, 'wave')).toBeNull(); // other floor
	});
	it('opens a pad only in the build phase; the closer target wins', () => {
		const pad = INFO.pads[6]!.pos;
		expect(zdUseTarget(pad, INFO, full(), 'build')).toMatchObject({ kind: 'pad', pad: 6 });
		expect(zdUseTarget(pad, INFO, full(), 'wave')).toBeNull();
		const fx = defenseFixtureMap().defense!;
		const st = fx.openings.map((x) => ({ planks: 0, max: x.planks ?? 6, reinforce: 0 }));
		const at = fx.pads[0]!.pos;
		const t = zdUseTarget(at, fx, st, 'build');
		expect(t?.kind === 'pad' || t?.kind === 'repair').toBe(true);
		if (t) expect(t.dist).toBeLessThanOrEqual(96);
	});
	it('prompts name the barricade and its planks, or the pad', () => {
		const st = full();
		st[0] = { ...st[0]!, planks: 3 };
		expect(zdPromptText({ kind: 'repair', opening: 0, dist: 10 }, INFO, st, [], false)).toBe(`Hold E to repair the ${o.name} · 3/6`);
		expect(zdPromptText({ kind: 'repair', opening: 0, dist: 10 }, INFO, st, [], true)).toBe(`Repairing the ${o.name} · 3/6`);
		expect(zdPromptText({ kind: 'pad', pad: 0, dist: 10 }, INFO, st, [{ type: null, level: 0, owner: null }], false)).toBe('E: build a turret here');
		expect(zdPromptText({ kind: 'pad', pad: 0, dist: 10 }, INFO, st, [{ type: 'mortar', level: 2, owner: 1 }], false)).toBe('E: Mortar L2 (upgrade / sell)');
	});
});

describe('shop menu', () => {
	it('main page: pages, ammo with its price, ready', () => {
		const m = zdShopMenu('shop', me({ gold: 100 }), INFO, full());
		expect(m.view.rows.map((r) => r.label)).toEqual(['Weapons', 'Upgrades', 'Barricades', 'Ammo refill', 'Ready']);
		expect(m.view.rows[3]).toMatchObject({ key: 4, price: ZD_SHOP.ammo, state: 'poor' });
		expect(m.acts[0]).toEqual({ t: 'page', page: 'weapons' });
		expect(m.acts[4]).toEqual({ t: 'zd', act: { a: 'ready' } });
		expect(zdShopMenu('shop', me({ ready: true }), INFO, full()).view.rows[4]!.state).toBe('owned');
	});
	it('weapons: owned, affordable and too expensive', () => {
		const m = zdShopMenu('weapons', me({ gold: 700, weapons: ['pistol', 'smg'] }), INFO, full());
		expect(m.view.rows.map((r) => r.state)).toEqual(['owned', 'poor', 'poor', 'poor']);
		expect(zdShopMenu('weapons', me({ gold: 5000 }), INFO, full()).view.rows.every((r) => r.state === 'buy')).toBe(true);
		expect(m.acts[1]).toEqual({ t: 'zd', act: { a: 'buy', item: 'weapon:striker' } });
	});
	it('upgrades take the next level price and show max at the top', () => {
		const rows = zdShopMenu('upgrades', me({ gold: 5000, hpLevel: 1, damageLevel: 2, reloadLevel: 0 }), INFO, full()).view.rows;
		expect(rows[0]).toMatchObject({ label: 'Max HP', price: ZD_SHOP.hp[1], state: 'buy', note: '1/2' });
		expect(rows[1]).toMatchObject({ price: null, state: 'max', note: '2/2' });
		expect(rows[2]).toMatchObject({ price: ZD_SHOP.reload[0], state: 'buy' });
	});
	it('barricades: repair all priced by missing planks, one reinforce row per opening (at most 9 rows)', () => {
		const st = full();
		st[2] = { ...st[2]!, planks: 1 };
		st[3] = { ...st[3]!, reinforce: 2 };
		const m = zdShopMenu('barricades', me({ gold: 5000 }), INFO, st);
		expect(m.view.rows.length).toBeLessThanOrEqual(9);
		expect(m.view.rows[0]).toMatchObject({ label: 'Repair all', price: Math.max(ZD_SHOP.repairAllMin, 5 * ZD_SHOP.repairAllPerPlank), state: 'buy' });
		expect(m.view.rows[4]).toMatchObject({ state: 'max', note: '2/2' });
		expect(m.acts[1]).toEqual({ t: 'zd', act: { a: 'buy', item: `reinforce:${INFO.openings[0]!.id}` } });
		expect(zdShopMenu('barricades', me(), INFO, full()).view.rows[0]!.state).toBe('max');
	});
});

describe('pad menu', () => {
	it('empty pad: the five turrets with their level-1 numbers, then the shop', () => {
		const m = zdPadMenu(2, { type: null, level: 0, owner: null }, me({ gold: 450 }), false, null);
		expect(m.view.rows.map((r) => r.label)).toEqual(['Sentry', 'Scattergun', 'Mortar', 'Tesla coil', 'Frost', 'Shop']);
		expect(m.view.rows.map((r) => r.state)).toEqual(['buy', 'buy', 'poor', 'poor', 'poor', 'page']);
		expect(m.acts[2]).toEqual({ t: 'zd', act: { a: 'pad', pad: 2, op: 'build', turret: 'mortar' } });
		expect(m.view.rows[0]!.detail).toBe(zdTurretStats('sentry', 1));
	});
	it('built: upgrade previews the next level, sell pays the refund; max at level 3', () => {
		const m = zdPadMenu(0, { type: 'sentry', level: 1, owner: 7 }, me({ gold: 1000 }), true, 'you');
		expect(m.view.rows[0]).toMatchObject({ price: zdTurretCost('sentry', 2), detail: zdTurretStats('sentry', 2), state: 'buy' });
		expect(m.view.rows[1]).toMatchObject({ label: 'Sell', price: -zdTurretRefund('sentry', 1), state: 'action' });
		expect(zdPadMenu(0, { type: 'sentry', level: 3, owner: 7 }, me(), true, 'you').view.rows[0]!.state).toBe('max');
	});
	it("only the builder sells while they are here; anyone once they left", () => {
		expect(zdPadMenu(0, { type: 'tesla', level: 2, owner: 3 }, me(), true, 'P3').view.rows[1]!.state).toBe('locked');
		expect(zdPadMenu(0, { type: 'tesla', level: 2, owner: 3 }, me(), false, 'P3').view.rows[1]!.state).toBe('action');
	});
	it('turret stats read like the table in the docs', () => {
		expect(zdTurretStats('sentry', 1)).toBe('1 dmg · 7.1/s · range 900');
		expect(zdTurretStats('frost', 3)).toBe('slows 55 % · range 600');
		expect(zdTurretStats('tesla', 2)).toBe('9 dmg · chains 4 · every 1.3 s · range 650');
	});
	it('refusals read as text', () => {
		expect(zdReasonText('gold')).toBe('Not enough gold');
		expect(zdReasonText('weird')).toBe('Refused (weird)');
	});
});
