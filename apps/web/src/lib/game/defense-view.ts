/**
 * Pure helpers of the Zombie Defense client and HUD (docs/modes.md#zombie-defense,
 * docs/ui.md#zombie-defense-hud): weapon keys, what E does where you stand,
 * and the rows of the shop and the pad menu with their prices and states.
 * Unit-tested (defense-view.test.ts).
 */
import {
	WEAPONS,
	ZD_PAD_RANGE,
	ZD_REPAIR_RANGE,
	ZD_SHOP,
	ZD_TURRET_MAX_LEVEL,
	ZD_TURRET_TYPES,
	ZD_TURRETS,
	ZD_WEAPONS,
	ZD_ZOMBIES,
	zdBossCount,
	zdTurretCost,
	zdTurretRefund,
	type DefenseMapInfo,
	type Vec3,
	type ZdAction,
	type ZdOpeningView,
	type ZdPadView,
	type ZdPhase,
	type ZdPlayerView,
	type ZdTurretType,
	type ZdWeaponId
} from '@surf/shared';
import type { DefenseMenuRow, DefenseMenuView } from './contract.js';

/** Height difference (units) within which a barricade or pad counts as "here". */
export const ZD_USE_DZ = 96;

/** Weapon of number key `n` (1-5 in ZD_WEAPONS order) if owned, else null. */
export function zdSlotWeapon(n: number, owned: readonly ZdWeaponId[]): ZdWeaponId | null {
	const w = ZD_WEAPONS[n - 1] as ZdWeaponId | undefined;
	return w && owned.includes(w) ? w : null;
}

/** Owned weapons with their keys, in key order. */
export function zdWeaponKeys(owned: readonly ZdWeaponId[], held: ZdWeaponId): Array<{ key: number; label: string; held: boolean }> {
	const out: Array<{ key: number; label: string; held: boolean }> = [];
	for (const [i, w] of ZD_WEAPONS.entries()) if (owned.includes(w as ZdWeaponId)) out.push({ key: i + 1, label: WEAPONS[w].label, held: w === held });
	return out;
}

export type ZdUseTarget = { kind: 'repair'; opening: number; dist: number } | { kind: 'pad'; pad: number; dist: number };

/**
 * What E does at feet position `pos`: repair the nearest barricade that is
 * missing planks (any phase), or open the nearest pad (build phase only),
 * whichever is closer. Null: nothing in reach.
 */
export function zdUseTarget(
	pos: Vec3,
	info: Pick<DefenseMapInfo, 'openings' | 'pads' | 'nav'>,
	openings: readonly ZdOpeningView[],
	phase: ZdPhase
): ZdUseTarget | null {
	let best: ZdUseTarget | null = null;
	for (const [i, o] of info.openings.entries()) {
		const st = openings[i];
		if (!st || st.planks >= st.max || (phase !== 'build' && phase !== 'wave')) continue;
		const n = info.nav.nodes[o.inside];
		if (!n || Math.abs(n.z - pos.z) > ZD_USE_DZ) continue;
		const d = Math.hypot(n.x - pos.x, n.y - pos.y);
		if (d <= ZD_REPAIR_RANGE && (!best || d < best.dist)) best = { kind: 'repair', opening: i, dist: d };
	}
	if (phase === 'build') {
		for (const [i, p] of info.pads.entries()) {
			if (Math.abs(p.pos.z - pos.z) > ZD_USE_DZ) continue;
			const d = Math.hypot(p.pos.x - pos.x, p.pos.y - pos.y);
			if (d <= ZD_PAD_RANGE && (!best || d < best.dist)) best = { kind: 'pad', pad: i, dist: d };
		}
	}
	return best;
}

/** The E prompt for a target. */
export function zdPromptText(
	t: ZdUseTarget,
	info: Pick<DefenseMapInfo, 'openings'>,
	openings: readonly ZdOpeningView[],
	pads: readonly ZdPadView[],
	repairing: boolean
): string {
	if (t.kind === 'repair') {
		const o = openings[t.opening]!;
		const name = info.openings[t.opening]?.name ?? 'barricade';
		return repairing ? `Repairing the ${name} · ${o.planks}/${o.max}` : `Hold E to repair the ${name} · ${o.planks}/${o.max}`;
	}
	const p = pads[t.pad];
	return p?.type ? `E: ${ZD_TURRETS[p.type].label} L${p.level} (upgrade / sell)` : 'E: build a turret here';
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** One line of what a turret does at `level` (1-3). */
export function zdTurretStats(type: ZdTurretType, level: number): string {
	const l = ZD_TURRETS[type].levels[Math.max(1, Math.min(ZD_TURRET_MAX_LEVEL, level)) - 1]!;
	const every = `every ${fmt(Math.round(l.fireMs / 100) / 10)} s`;
	switch (type) {
		case 'sentry':
			return `${fmt(l.damage)} dmg · ${fmt(Math.round(10000 / l.fireMs) / 10)}/s · range ${l.range}`;
		case 'scatter':
			return `${fmt(l.damage)} dmg each · ${l.extra * 2}° cone · ${every} · range ${l.range}`;
		case 'mortar':
			return `${fmt(l.damage)} splash dmg · radius ${l.extra} · ${every} · range ${l.range}`;
		case 'tesla':
			return `${fmt(l.damage)} dmg · chains ${l.extra} · ${every} · range ${l.range}`;
		case 'frost':
			return `slows ${Math.round((1 - l.extra) * 100)} % · range ${l.range}`;
	}
}

/** What a pick of a menu row does. */
export type ZdMenuAct = { t: 'zd'; act: ZdAction } | { t: 'page'; page: ZdShopPage } | { t: 'close' };
export type ZdShopPage = 'shop' | 'weapons' | 'upgrades' | 'barricades';
export interface ZdMenu {
	view: DefenseMenuView;
	acts: ZdMenuAct[];
}

const WEAPON_DETAIL: Readonly<Record<Exclude<ZdWeaponId, 'pistol'>, string>> = {
	smg: 'fast, light, small magazine',
	striker: 'shotgun: 8 pellets, close range',
	lmg: '100-round belt, slow to move',
	sniper: 'pierces 3 · scope (mouse2)'
};

const affordable = (gold: number, price: number): DefenseMenuRow['state'] => (gold >= price ? 'buy' : 'poor');

class Rows {
	rows: DefenseMenuRow[] = [];
	acts: ZdMenuAct[] = [];
	add(row: Omit<DefenseMenuRow, 'key'>, act: ZdMenuAct): void {
		if (this.rows.length >= 9) return;
		this.rows.push({ key: this.rows.length + 1, ...row });
		this.acts.push(act);
	}
}

const leveled = (prices: readonly number[], level: number) => (level >= prices.length ? null : prices[level]!);

/**
 * The shop (B) on `page`. `me`: my player view; `openings` the barricade
 * states with their map names. Rows past nine are dropped (number keys).
 */
export function zdShopMenu(
	page: ZdShopPage,
	me: ZdPlayerView,
	info: Pick<DefenseMapInfo, 'openings'>,
	openings: readonly ZdOpeningView[]
): ZdMenu {
	const r = new Rows();
	const gold = me.gold;
	const buy = (item: string): ZdMenuAct => ({ t: 'zd', act: { a: 'buy', item } });
	let title = 'Shop';
	let hint = 'B close · 1-9 pick';
	if (page === 'shop') {
		r.add({ label: 'Weapons', detail: `${me.weapons.length - 1}/4 bought`, price: null, state: 'page' }, { t: 'page', page: 'weapons' });
		r.add({ label: 'Upgrades', detail: 'max HP, damage, reload', price: null, state: 'page' }, { t: 'page', page: 'upgrades' });
		r.add({ label: 'Barricades', detail: 'repair all, reinforce', price: null, state: 'page' }, { t: 'page', page: 'barricades' });
		r.add({ label: 'Ammo refill', detail: 'every owned weapon full', price: ZD_SHOP.ammo, state: affordable(gold, ZD_SHOP.ammo) }, buy('ammo'));
		r.add(
			me.ready
				? { label: 'Ready', detail: 'waiting for the others', price: null, state: 'owned' }
				: { label: 'Ready', detail: 'start the wave sooner (F)', price: null, state: 'action' },
			{ t: 'zd', act: { a: 'ready' } }
		);
	} else if (page === 'weapons') {
		title = 'Shop · Weapons';
		hint = 'B back · 1-4 buy · bought guns stay all game';
		for (const w of ['smg', 'striker', 'lmg', 'sniper'] as const) {
			const price = ZD_SHOP.weapons[w];
			const owned = me.weapons.includes(w);
			const key = ZD_WEAPONS.indexOf(w) + 1;
			r.add(
				{ label: WEAPONS[w].label, detail: `${WEAPON_DETAIL[w]} · key ${key}`, price, state: owned ? 'owned' : affordable(gold, price) },
				buy(`weapon:${w}`)
			);
		}
	} else if (page === 'upgrades') {
		title = 'Shop · Upgrades';
		hint = 'B back · 1-3 buy';
		const up = (label: string, detail: string, prices: readonly number[], level: number, item: string) => {
			const price = leveled(prices, level);
			r.add(
				{ label, detail, price, state: price === null ? 'max' : affordable(gold, price), note: `${level}/${prices.length}` },
				buy(item)
			);
		};
		up('Max HP', `+${ZD_SHOP.hpPerLevel} max HP`, ZD_SHOP.hp, me.hpLevel, 'hp');
		up('Damage', `+${Math.round(ZD_SHOP.damagePerLevel * 100)} % weapon damage`, ZD_SHOP.damage, me.damageLevel, 'damage');
		up('Fast hands', `reloads ${Math.round((1 - ZD_SHOP.reloadFactor) * 100)} % faster`, ZD_SHOP.reload, me.reloadLevel, 'reload');
	} else {
		title = 'Shop · Barricades';
		hint = 'B back · 1 repair all · 2-9 reinforce';
		const missing = openings.reduce((n, o) => n + Math.max(0, o.max - o.planks), 0);
		const cost = Math.max(ZD_SHOP.repairAllMin, ZD_SHOP.repairAllPerPlank * missing);
		r.add(
			{
				label: 'Repair all',
				detail: missing > 0 ? `${missing} planks missing` : 'every barricade is whole',
				price: missing > 0 ? cost : null,
				state: missing > 0 ? affordable(gold, cost) : 'max'
			},
			buy('repairAll')
		);
		for (const [i, o] of info.openings.entries()) {
			const st = openings[i];
			if (!st) continue;
			const price = leveled(ZD_SHOP.reinforce, st.reinforce);
			const next = st.reinforce + 1;
			r.add(
				{
					label: `Reinforce ${o.name}`,
					detail: price === null ? 'planks take ×3 to tear off' : `planks take ×${next + 1} to tear off`,
					price,
					state: price === null ? 'max' : affordable(gold, price),
					note: `${st.reinforce}/${ZD_SHOP.reinforce.length}`
				},
				buy(`reinforce:${o.id}`)
			);
		}
	}
	return { view: { kind: page, title, subtitle: `${gold} gold`, rows: r.rows, hint, notice: null }, acts: r.acts };
}

/**
 * The pad menu (E on pad `pad`): build one of the five turrets, or upgrade
 * (with the next level's numbers) and sell (the builder, or anyone once the
 * builder has left: `ownerHere` false).
 */
export function zdPadMenu(pad: number, padView: ZdPadView, me: ZdPlayerView, ownerHere: boolean, ownerName: string | null): ZdMenu {
	const r = new Rows();
	const gold = me.gold;
	const act = (a: ZdAction): ZdMenuAct => ({ t: 'zd', act: a });
	if (!padView.type) {
		for (const type of ZD_TURRET_TYPES) {
			const price = zdTurretCost(type, 1);
			r.add({ label: ZD_TURRETS[type].label, detail: zdTurretStats(type, 1), price, state: affordable(gold, price) }, act({ a: 'pad', pad, op: 'build', turret: type }));
		}
		r.add({ label: 'Shop', detail: 'weapons, upgrades, barricades (B)', price: null, state: 'page' }, { t: 'page', page: 'shop' });
		return { view: { kind: 'pad', title: 'Turret pad', subtitle: `${gold} gold · build a turret`, rows: r.rows, hint: 'E close · 1-5 build', notice: null }, acts: r.acts };
	}
	const type = padView.type;
	const level = padView.level;
	if (level >= ZD_TURRET_MAX_LEVEL) r.add({ label: 'Upgrade', detail: 'fully upgraded', price: null, state: 'max', note: `L${level}` }, act({ a: 'pad', pad, op: 'upgrade' }));
	else {
		const price = zdTurretCost(type, level + 1);
		r.add(
			{ label: `Upgrade to level ${level + 1}`, detail: zdTurretStats(type, level + 1), price, state: affordable(gold, price), note: `L${level}` },
			act({ a: 'pad', pad, op: 'upgrade' })
		);
	}
	const mine = padView.owner === me.id || padView.owner === null || !ownerHere;
	const refund = zdTurretRefund(type, level);
	r.add(
		mine
			? { label: 'Sell', detail: 'half of all gold put into it', price: -refund, state: 'action' }
			: { label: 'Sell', detail: `only ${ownerName ?? 'its builder'} can sell it`, price: -refund, state: 'locked', note: 'not yours' },
		act({ a: 'pad', pad, op: 'sell' })
	);
	r.add({ label: 'Shop', detail: 'weapons, upgrades, barricades (B)', price: null, state: 'page' }, { t: 'page', page: 'shop' });
	const by = ownerName ? ` · built by ${ownerName}` : '';
	return {
		view: {
			kind: 'pad',
			title: `${ZD_TURRETS[type].label} · level ${level}`,
			subtitle: `${zdTurretStats(type, level)}${by}`,
			rows: r.rows,
			hint: `E close · 1 upgrade · 2 sell · ${gold} gold`,
			notice: null
		},
		acts: r.acts
	};
}

/** Readable text of a refused action (the `result` reasons of docs/modes.md#client-api). */
export function zdReasonText(reason: string | undefined): string {
	switch (reason) {
		case 'gold':
			return 'Not enough gold';
		case 'owned':
			return 'You already own that';
		case 'full':
			return 'Ammo is already full';
		case 'max level':
			return 'Already at the top level';
		case 'not build phase':
			return 'Only in the build phase';
		case 'too far':
			return 'Too far from the pad';
		case 'occupied':
			return 'Someone built here first';
		case 'empty':
			return 'Nothing is built here';
		case 'not yours':
			return 'Only its builder can sell it';
		case 'nothing to repair':
			return 'Nothing to repair';
		case 'not owned':
			return 'You do not own that weapon';
		case 'not playing':
			return 'You are not in the game right now';
		default:
			return reason ? `Refused (${reason})` : 'Refused';
	}
}

/** Wave start banner: "Wave 10 · 2 Behemoths are coming". */
export function bossWaveText(wave: number): string {
	const n = zdBossCount(wave);
	if (n === 0) return `Wave ${wave}`;
	return n === 1 ? `Wave ${wave} · a ${ZD_ZOMBIES.boss.label} is coming` : `Wave ${wave} · ${n} ${ZD_ZOMBIES.boss.label}s are coming`;
}

/** "a", "a and b", "a, b and c". */
export function joinNames(names: readonly string[]): string {
	return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Wave banner part naming the attacked openings: " · from the north door and east window". */
export function attackText(from: readonly number[] | undefined, total: number, name: (i: number) => string): string {
	if (!Array.isArray(from) || from.length === 0) return '';
	if (from.length >= total) return ' · from every side';
	if (from.length > 3) return ` · from ${from.length} openings`;
	return ` · from the ${joinNames(from.map(name))}`;
}
