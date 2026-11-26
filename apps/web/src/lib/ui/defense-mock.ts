/**
 * Zombie Defense scenes of the HUD mock (`?mode=defense&scene=...`, docs/ui.md#hud-mock):
 * build, shop, weapons, upgrades, barricades, pad, turret, wave, breach,
 * boss, dead, ended. Menus come from the real view helpers (defense-view.ts),
 * so number keys and clicks page through them like in the game.
 */
import { getMap, ZD_WEAPONS, type ZdOpeningView, type ZdPadView, type ZdPlayerView, type ZdWeaponId } from '@surf/shared';
import type { DefenseView } from '#lib/game/contract.js';
import { zdPadMenu, zdShopMenu, zdWeaponKeys, type ZdMenu, type ZdShopPage } from '#lib/game/defense-view.js';

export const DEFENSE_MOCK_SCENES = ['build', 'shop', 'weapons', 'upgrades', 'barricades', 'pad', 'turret', 'wave', 'breach', 'boss', 'dead', 'ended'] as const;
export type DefenseMockScene = (typeof DEFENSE_MOCK_SCENES)[number];

export function isDefenseMockScene(v: unknown): v is DefenseMockScene {
	return typeof v === 'string' && (DEFENSE_MOCK_SCENES as readonly string[]).includes(v);
}

const INFO = getMap('defense_blackthorn')!.defense!;

const ME: ZdPlayerView = {
	id: 2,
	status: 'alive',
	hp: 7,
	maxHp: 15,
	gold: 1180,
	kills: 37,
	deaths: 1,
	weapon: 'smg',
	weapons: ['pistol', 'smg', 'sniper'],
	hpLevel: 1,
	damageLevel: 0,
	reloadLevel: 1,
	ready: false
};

const OPENINGS: ZdOpeningView[] = INFO.openings.map((o, i) => ({ planks: [6, 3, 6, 0, 8, 5, 6, 1][i] ?? 6, max: o.planks ?? 6, reinforce: [0, 1, 0, 0, 2, 0, 0, 0][i] ?? 0 }));
const PADS: ZdPadView[] = INFO.pads.map((_, i) => (i === 0 ? { type: 'sentry', level: 2, owner: 2 } : i === 5 ? { type: 'tesla', level: 1, owner: 3 } : { type: null, level: 0, owner: null }));

/** Menu of a scene and its current page (null: none open). */
export function mockMenu(page: ZdShopPage | 'pad' | 'turret' | null): ZdMenu | null {
	if (page === null) return null;
	if (page === 'pad') return zdPadMenu(1, PADS[1]!, ME, false, null);
	if (page === 'turret') return zdPadMenu(0, PADS[0]!, ME, true, 'you');
	return zdShopMenu(page, ME, INFO, OPENINGS);
}

export function mockDefenseView(scene: DefenseMockScene, t0: number, page: ZdShopPage | 'pad' | 'turret' | null = sceneMenu(scene)): DefenseView {
	const wave = scene === 'boss' ? 10 : 7;
	const build = scene === 'build' || sceneMenu(scene) !== null;
	const phase = scene === 'ended' ? 'ended' : build ? 'build' : 'wave';
	const status = scene === 'dead' ? 'dead' : 'alive';
	const menu = mockMenu(page);
	const held = ME.weapon as ZdWeaponId;
	return {
		phase,
		round: 3,
		wave,
		endsAt: phase === 'wave' ? 0 : t0 + 21_000,
		startedAt: phase === 'wave' ? t0 - 74_000 : null,
		left: 23,
		alive: 17,
		teamKills: 212,
		status,
		hp: status === 'dead' ? 0 : ME.hp,
		maxHp: ME.maxHp,
		gold: ME.gold,
		goldPop: { amount: 15, at: t0 },
		myKills: ME.kills,
		weapon: held,
		weaponLabel: 'SMG',
		mag: 11,
		magSize: 30,
		reserve: 90,
		reloadEndsAt: 0,
		reloadMs: 1800,
		weapons: zdWeaponKeys(ZD_WEAPONS.filter((w) => ME.weapons.includes(w as ZdWeaponId)) as ZdWeaponId[], held),
		team: [
			{ id: 1, name: 'glidepath', status: 'alive', ready: true, me: false },
			{ id: 2, name: 'You', status, ready: false, me: true },
			{ id: 3, name: 'cirrus', status: scene === 'dead' ? 'alive' : 'dead', ready: false, me: false },
			{ id: 4, name: 'boreal', status: 'waiting', ready: false, me: false }
		],
		ready: false,
		readyCount: 1,
		livingCount: 3,
		boss: scene === 'boss' ? 0.62 : null,
		openings: OPENINGS.map((o, i) => ({ ...o, name: INFO.openings[i]!.name })),
		prompt: phase === 'build' && !menu ? { text: 'E: build a turret here', active: false } : scene === 'wave' ? { text: 'Repairing the east window · 3/6', active: true } : null,
		flash:
			scene === 'boss'
				? { text: 'A Behemoth is here · it smashes barricades in one go', at: t0, tone: 'boss' }
				: scene === 'build'
					? { text: 'Wave 6 cleared · +200 gold', at: t0, tone: 'good' }
					: null,
		alert: scene === 'breach' || scene === 'boss' ? { text: 'The east window is down!', at: t0 } : null,
		hitMarker: scene === 'wave' ? { at: t0, head: true, kill: true } : null,
		killFeed: [
			{ id: 3, text: 'You · SMG · Runner · headshot', head: true, mine: true, at: t0 },
			{ id: 2, text: 'Your Sentry · Walker', head: false, mine: true, at: t0 },
			{ id: 1, text: "cirrus's Tesla coil · Brute", head: false, mine: false, at: t0 }
		],
		hurtAt: scene === 'breach' ? t0 : 0,
		scoped: false,
		summary: scene === 'ended' ? { wave: 9, kills: 268, secs: 1312, top: 'glidepath (94)' } : null,
		menu: menu ? { ...menu.view, notice: null } : null,
		online: true
	};
}

/** The menu page a scene opens with. */
export function sceneMenu(scene: DefenseMockScene): ZdShopPage | 'pad' | 'turret' | null {
	switch (scene) {
		case 'shop':
		case 'weapons':
		case 'upgrades':
		case 'barricades':
			return scene;
		case 'pad':
		case 'turret':
			return scene;
		default:
			return null;
	}
}

/** Mock state for the score panel. */
export function mockDefenseState(rows: Array<{ id: number }>) {
	return {
		mode: 'defense' as const,
		phase: 'wave' as const,
		round: 3,
		wave: 7,
		timeLeft: 0,
		elapsed: 74,
		toSpawn: 6,
		alive: 17,
		left: 23,
		kills: 212,
		boss: null,
		openings: OPENINGS,
		pads: PADS,
		players: rows.map((r, i) => ({ ...ME, id: r.id, status: i % 4 === 3 ? ('dead' as const) : ('alive' as const), gold: 1200 - i * 90, kills: 90 - i * 9 }))
	};
}
