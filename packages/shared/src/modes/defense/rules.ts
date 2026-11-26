/**
 * Zombie Defense numbers (docs/modes.md#zombie-defense): phases, waves and
 * scaling, zombie types, turrets, the gold shop. Pure data and small pure
 * functions; `DefenseGame` (game.ts) runs them. Change a number here first,
 * then in the docs.
 */
import type { WeaponId } from '../zombies/weapons.ts';

// ---------------------------------------------------------------------------
// Phases

export type ZdPhase = 'waiting' | 'build' | 'wave' | 'ended';

export const ZD_SIM_HZ = 64;
export const ZD_STEP_MS = 1000 / ZD_SIM_HZ;
/** Build phase before wave 1, and before every later wave (s). */
export const ZD_FIRST_BUILD_SECS = 45;
export const ZD_BUILD_SECS = 30;
/** Summary after the game is lost (s); then a new game starts from wave 1. */
export const ZD_END_SECS = 8;
/** A wave running longer than this kills its remaining zombies (stuck zombies never stall a game). */
export const ZD_WAVE_MAX_SECS = 360;

// ---------------------------------------------------------------------------
// Players

export const ZD_PLAYER_HP = 10;
/** Health regeneration: starts this long after the last damage, then 1 HP per `ZD_REGEN_EVERY_MS`. */
export const ZD_REGEN_DELAY_MS = 6000;
export const ZD_REGEN_EVERY_MS = 1000;
/** After a hit a player cannot be hit again for this long. */
export const ZD_PLAYER_IFRAMES_MS = 300;
/** Repair (hold E): within this distance (XY) of an opening's `inside` node, one plank per `ZD_REPAIR_MS`. */
export const ZD_REPAIR_RANGE = 96;
export const ZD_REPAIR_MS = 600;
/** Pad menu: within this distance (XY) of a pad's centre. */
export const ZD_PAD_RANGE = 96;
/** Weapons a player can own, in key order (suggested keys 1-5); the pistol is free. */
export const ZD_WEAPONS: readonly WeaponId[] = ['pistol', 'smg', 'striker', 'lmg', 'sniper'];
export type ZdWeaponId = 'pistol' | 'smg' | 'striker' | 'lmg' | 'sniper';
export function isZdWeapon(v: unknown): v is ZdWeaponId {
	return typeof v === 'string' && (ZD_WEAPONS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Gold (per player, reset every game; not the account coins)

export const ZD_GOLD = Object.freeze({
	start: 400,
	kill: 10,
	headshotKill: 15,
	/** A kill by a turret, to the player who built it. */
	turretKill: 5,
	plank: 5,
	/** Plank gold per player and wave at most. */
	plankCapPerWave: 60,
	/** Wave cleared: to every player in the game, alive or dead. */
	waveBonus: (wave: number): number => 50 + 25 * wave
});

// ---------------------------------------------------------------------------
// Zombies

export type ZdZombieKind = 'walker' | 'runner' | 'brute' | 'boss';
/** Index in the binary snapshot. */
export const ZD_KINDS: readonly ZdZombieKind[] = ['walker', 'runner', 'brute', 'boss'];

export interface ZdZombieDef {
	kind: ZdZombieKind;
	label: string;
	/** HP at wave 1 (scaled by `zdHpScale`; the boss also by players). */
	hp: number;
	speed: number;
	/** Model and hitbox scale (the movement hull is always the player hull). */
	scale: number;
	/** ms per plank torn off (before reinforcement); the boss smashes the whole barricade after `tearMs`. */
	tearMs: number;
	/** Player HP per hit. */
	damage: number;
	/** Horizontal origin distance at which it can hit a player. */
	reach: number;
	/** Headshots kill outright (else head damage ×ZD_HEAD_MULT). */
	headKill: boolean;
	/** First wave it appears in. */
	fromWave: number;
}

export const ZD_ZOMBIES: Readonly<Record<ZdZombieKind, ZdZombieDef>> = Object.freeze({
	walker: { kind: 'walker', label: 'Walker', hp: 8, speed: 265, scale: 1, tearMs: 1500, damage: 1, reach: 50, headKill: true, fromWave: 1 },
	runner: { kind: 'runner', label: 'Runner', hp: 5, speed: 340, scale: 0.85, tearMs: 1500, damage: 1, reach: 48, headKill: true, fromWave: 3 },
	brute: { kind: 'brute', label: 'Brute', hp: 40, speed: 190, scale: 1.35, tearMs: 600, damage: 2, reach: 62, headKill: false, fromWave: 5 },
	boss: { kind: 'boss', label: 'Behemoth', hp: 300, speed: 160, scale: 1.8, tearMs: 2000, damage: 3, reach: 80, headKill: false, fromWave: 5 }
});

/** Head damage multiplier for zombies a headshot does not kill outright. */
export const ZD_HEAD_MULT = 3;
/** Alive at once at most (server tick, bandwidth, client draw calls). */
export const ZD_MAX_ZOMBIES = 40;
/** Spawn interval for one player; divided by `zdPlayerScale`. */
export const ZD_SPAWN_MS = 1100;
export const ZD_SPAWN_MIN_MS = 200;
/** Every this-many waves one boss joins the wave. */
export const ZD_BOSS_EVERY = 5;
/** Boss HP grows by this share per extra player. */
export const ZD_BOSS_HP_PER_PLAYER = 0.6;
/** Stall breaker: a zombie without progress for this long is put back at a spawn zone. */
export const ZD_STALL_MS = 8000;
export const ZD_ATTACK_WINDUP_MS = 350;
export const ZD_ATTACK_COOLDOWN_MS = 900;
/** Hit slow (player weapons), like Zombie Run. */
export const ZD_SLOW_FACTORS = [1, 0.6, 0.5, 0.42] as const;
export const ZD_SLOW_MS = 600;
export const ZD_HIT_FLASH_MS = 120;

/** Players-in-game factor of the zombie count (and the spawn rate): 1 + 0.5·(players − 1). */
export function zdPlayerScale(players: number): number {
	return 1 + 0.5 * (Math.max(1, players) - 1);
}

/** Zombie HP factor of a wave: 1 + 0.12·(wave − 1). */
export function zdHpScale(wave: number): number {
	return 1 + 0.12 * (Math.max(1, wave) - 1);
}

/** Zombies in a wave (the boss not counted): (8 + 4·wave) × the player factor, rounded. */
export function zdWaveCount(wave: number, players: number): number {
	return Math.round((8 + 4 * Math.max(1, wave)) * zdPlayerScale(players));
}

export function zdIsBossWave(wave: number): boolean {
	return wave > 0 && wave % ZD_BOSS_EVERY === 0;
}

/** Share of runners and brutes in a wave (the rest are walkers). */
export function zdWaveMix(wave: number): { runner: number; brute: number } {
	const runner = wave >= ZD_ZOMBIES.runner.fromWave ? Math.min(0.3, 0.1 + 0.03 * (wave - ZD_ZOMBIES.runner.fromWave)) : 0;
	const brute = wave >= ZD_ZOMBIES.brute.fromWave ? Math.min(0.2, 0.05 + 0.02 * (wave - ZD_ZOMBIES.brute.fromWave)) : 0;
	return { runner, brute };
}

/**
 * The kinds of one wave in spawn order: walkers, runners and brutes spread
 * evenly (deterministic counts, shuffled by `rng`), the boss in the middle.
 */
export function zdWavePlan(wave: number, players: number, rng: () => number): ZdZombieKind[] {
	const n = zdWaveCount(wave, players);
	const mix = zdWaveMix(wave);
	const runners = Math.round(n * mix.runner);
	const brutes = Math.round(n * mix.brute);
	const out: ZdZombieKind[] = [];
	for (let i = 0; i < n; i++) out.push(i < runners ? 'runner' : i < runners + brutes ? 'brute' : 'walker');
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	// No brute among the first three: the wave opens gently.
	for (let i = 0; i < Math.min(3, out.length); i++) {
		if (out[i] !== 'brute') continue;
		const j = out.findIndex((k, idx) => idx >= 3 && k !== 'brute');
		if (j >= 0) [out[i], out[j]] = [out[j]!, out[i]!];
	}
	if (zdIsBossWave(wave)) out.splice(Math.floor(out.length / 2), 0, 'boss');
	return out;
}

/** Full HP of a zombie of `kind` in `wave` with `players` in the game. */
export function zdZombieHp(kind: ZdZombieKind, wave: number, players: number): number {
	const base = ZD_ZOMBIES[kind].hp * zdHpScale(wave);
	return kind === 'boss' ? Math.round(base * (1 + ZD_BOSS_HP_PER_PLAYER * (Math.max(1, players) - 1))) : base;
}

/** Spawn interval (ms) for `players` in the game. */
export function zdSpawnInterval(players: number): number {
	return Math.max(ZD_SPAWN_MIN_MS, ZD_SPAWN_MS / zdPlayerScale(players));
}

// ---------------------------------------------------------------------------
// Barricades

/** Planks of an opening without `planks` in the map. */
export const ZD_DEFAULT_PLANKS = 6;
/** Tear time factor by "Reinforced" level (0..2). */
export const ZD_REINFORCE_FACTORS = [1, 2, 3] as const;
/** Tear time factor in waves 1, 2, ... (1 after the list), so repairing matters while the team has few turrets. */
export const ZD_EARLY_TEAR = [2, 1.5] as const;

// ---------------------------------------------------------------------------
// Turrets

export type ZdTurretType = 'sentry' | 'scatter' | 'mortar' | 'tesla' | 'frost';
/** Index in the binary snapshot. */
export const ZD_TURRET_TYPES: readonly ZdTurretType[] = ['sentry', 'scatter', 'mortar', 'tesla', 'frost'];
export const ZD_TURRET_MAX_LEVEL = 3;
/** Sell refund share of all gold put into the turret. */
export const ZD_SELL_SHARE = 0.5;
/** Height of a turret's muzzle above its pad (line-of-sight traces). */
export const ZD_TURRET_HEIGHT = 48;

export interface ZdTurretLevel {
	/** Zombie HP per hit (per zombie for scatter, mortar and tesla). */
	damage: number;
	/** ms between shots (frost: unused). */
	fireMs: number;
	range: number;
	/** Scatter: cone half-angle (deg). Mortar: splash radius. Tesla: zombies per arc. Frost: speed factor (0.55 = 45 % slower). */
	extra: number;
}

export interface ZdTurretDef {
	type: ZdTurretType;
	label: string;
	/** Build cost; level n+1 costs ×1.5 of level n (`zdTurretCost`). */
	cost: number;
	levels: readonly [ZdTurretLevel, ZdTurretLevel, ZdTurretLevel];
	/** Mortar: no target closer than this. */
	minRange?: number;
	/** Needs line of sight to its target (all but the mortar). */
	los: boolean;
}

export const ZD_TURRETS: Readonly<Record<ZdTurretType, ZdTurretDef>> = Object.freeze({
	sentry: {
		type: 'sentry',
		label: 'Sentry',
		cost: 300,
		los: true,
		levels: [
			{ damage: 1, fireMs: 140, range: 900, extra: 0 },
			{ damage: 1.5, fireMs: 115, range: 1000, extra: 0 },
			{ damage: 2, fireMs: 90, range: 1100, extra: 0 }
		]
	},
	scatter: {
		type: 'scatter',
		label: 'Scattergun',
		cost: 450,
		los: true,
		levels: [
			{ damage: 4, fireMs: 900, range: 500, extra: 15 },
			{ damage: 6, fireMs: 760, range: 560, extra: 17 },
			{ damage: 9, fireMs: 620, range: 620, extra: 19 }
		]
	},
	mortar: {
		type: 'mortar',
		label: 'Mortar',
		cost: 700,
		los: false,
		minRange: 200,
		levels: [
			{ damage: 10, fireMs: 3000, range: 1400, extra: 160 },
			{ damage: 15, fireMs: 2600, range: 1550, extra: 180 },
			{ damage: 22, fireMs: 2200, range: 1700, extra: 200 }
		]
	},
	tesla: {
		type: 'tesla',
		label: 'Tesla coil',
		cost: 900,
		los: true,
		levels: [
			{ damage: 6, fireMs: 1500, range: 600, extra: 3 },
			{ damage: 9, fireMs: 1300, range: 650, extra: 4 },
			{ damage: 13, fireMs: 1100, range: 700, extra: 5 }
		]
	},
	frost: {
		type: 'frost',
		label: 'Frost',
		cost: 500,
		los: false,
		levels: [
			{ damage: 0, fireMs: 0, range: 450, extra: 0.55 },
			{ damage: 0, fireMs: 0, range: 525, extra: 0.5 },
			{ damage: 0, fireMs: 0, range: 600, extra: 0.45 }
		]
	}
});

/** Mortar shell flight speed (units/s, horizontal) and tesla chain jump distance. */
export const ZD_SHELL_SPEED = 700;
export const ZD_TESLA_JUMP = 260;

export function isZdTurretType(v: unknown): v is ZdTurretType {
	return typeof v === 'string' && Object.hasOwn(ZD_TURRETS, v);
}

/** Gold to reach `level` (1 = build) from the level before: cost × 1.5^(level − 1), rounded to 5. */
export function zdTurretCost(type: ZdTurretType, level: number): number {
	return Math.round((ZD_TURRETS[type].cost * 1.5 ** (Math.max(1, level) - 1)) / 5) * 5;
}

/** Sell refund of a turret at `level`: half of all it cost, rounded down to 5. */
export function zdTurretRefund(type: ZdTurretType, level: number): number {
	let sum = 0;
	for (let l = 1; l <= level; l++) sum += zdTurretCost(type, l);
	return Math.floor((sum * ZD_SELL_SHARE) / 5) * 5;
}

// ---------------------------------------------------------------------------
// Shop (key B in the build phase, also from the pad menu)

/**
 * Item ids: `weapon:<id>`, `ammo`, `hp`, `damage`, `reload`,
 * `reinforce:<opening id>`, `repairAll`. Prices below; leveled items take
 * the price of the next level.
 */
export const ZD_SHOP = Object.freeze({
	weapons: Object.freeze({ smg: 600, striker: 900, lmg: 1400, sniper: 1200 } as Record<Exclude<ZdWeaponId, 'pistol'>, number>),
	/** Every owned weapon's magazine and reserve full. */
	ammo: 150,
	/** Max HP +5 per level. */
	hp: Object.freeze([500, 900]),
	hpPerLevel: 5,
	/** Weapon damage +15 % per level. */
	damage: Object.freeze([600, 1100]),
	damagePerLevel: 0.15,
	/** Reloads take ×0.7. */
	reload: Object.freeze([400]),
	reloadFactor: 0.7,
	/** "Reinforced" per opening: planks take 2× / 3× as long to tear off. */
	reinforce: Object.freeze([400, 800]),
	/** Repair all barricades: per missing plank, at least `repairAllMin`. */
	repairAllPerPlank: 10,
	repairAllMin: 50
});

export type ZdShopItem =
	| { kind: 'weapon'; weapon: Exclude<ZdWeaponId, 'pistol'> }
	| { kind: 'ammo' }
	| { kind: 'hp' }
	| { kind: 'damage' }
	| { kind: 'reload' }
	| { kind: 'reinforce'; opening: string }
	| { kind: 'repairAll' };

/** Parse a shop item id (`weapon:smg`, `reinforce:north_window`, ...), or null. */
export function parseZdItem(id: unknown): ZdShopItem | null {
	if (typeof id !== 'string' || id.length > 64) return null;
	if (id === 'ammo' || id === 'hp' || id === 'damage' || id === 'reload' || id === 'repairAll') return { kind: id };
	if (id.startsWith('weapon:')) {
		const w = id.slice(7);
		return isZdWeapon(w) && w !== 'pistol' ? { kind: 'weapon', weapon: w } : null;
	}
	if (id.startsWith('reinforce:')) {
		const o = id.slice(10);
		return o.length > 0 ? { kind: 'reinforce', opening: o } : null;
	}
	return null;
}
