/**
 * Points and coins (docs/economy.md): every payout number, the player
 * multiplier and the pure helpers around them. The server decides and pays;
 * the client only uses the labels and the formatting.
 *
 * Amounts are integers in tenths of a point everywhere (`pts(3)` is 30).
 * Multipliers are integers in tenths too (12 is ×1.2).
 */
import { getCosmetic } from './cosmetics.ts';
import type { GameModeId } from './modes/index.ts';

/** Tenths of a point in one point. */
export const POINTS_SCALE = 10;

/** Whole points → tenths. */
export const pts = (points: number): number => Math.round(points * POINTS_SCALE);

// ---------------------------------------------------------------------------
// Player multiplier
// ---------------------------------------------------------------------------

/** Modes whose awards grow with the active players (never surf, bhop or playtime). */
export const MULTIPLIER_MODES: readonly GameModeId[] = ['zombies', 'infected', 'hns', 'tag', 'defense'];

/** ×1.0 in tenths. */
export const MULT_ONE = 10;
export const MULT_MAX = 20;

/** Multiplier in tenths for a number of active players: 1–2 ×1.0, 3 ×1.2, then +0.1 each, ×2.0 from 11. */
export function playerMultiplier(active: number): number {
	const n = Math.floor(active);
	return n <= 2 ? MULT_ONE : Math.min(MULT_MAX, n + 9);
}

/** The multiplier of a mode: ×1.0 where it does not apply. */
export function modeMultiplier(mode: GameModeId, active: number): number {
	return MULTIPLIER_MODES.includes(mode) ? playerMultiplier(active) : MULT_ONE;
}

/** Base (tenths) × multiplier (tenths) in tenths of a point. */
export const applyMultiplier = (base: number, mult: number): number => Math.round((base * mult) / MULT_ONE);

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

/**
 * Award left after `repeats` earlier ones, rounded up to whole points.
 * `percents[i]` is what the i-th repeat pays; after the last entry it stays at
 * the last one.
 */
export function decayed(base: number, percents: readonly number[], repeats: number): number {
	const p = percents[Math.min(Math.max(0, Math.floor(repeats)), percents.length - 1)] ?? 0;
	return Math.ceil((base * p) / 100 / POINTS_SCALE) * POINTS_SCALE;
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

/** Balance of a newly registered account (no lifetime points). */
export const START_COINS = pts(100);
/** point_log reason of it. */
export const WELCOME_REASON = 'welcome';

/**
 * Finishes, gates and evacs of the same map decay over this time too, not only
 * within a map session: a lone player can change the map at any time.
 */
export const REPEAT_MS = 3600_000;

/** Playtime: points per stretch of active online time, carried over between sessions. */
export const PLAYTIME = Object.freeze({ points: pts(10), everyMs: 15 * 60_000 });

/** Surf and bhop. */
export const RACE_PAY = Object.freeze({
	finish: Object.freeze({
		surf: Object.freeze({ easy: pts(4), hard: pts(15) }),
		bhop: Object.freeze({ easy: pts(5), hard: pts(12) })
	}),
	/** Finishes of the same map in one map session, and within `REPEAT_MS`, percent (stays at the last). */
	repeat: Object.freeze([100, 50, 25, 10]),
	personalBest: pts(2),
	/** Personal bests on the same map in one map session, and within `REPEAT_MS`, percent (stays at the last). */
	personalBestRepeat: Object.freeze([100, 10]),
	record: Object.freeze({ easy: pts(5), hard: pts(15) }),
	/** One record award per map and account in this time. */
	recordEveryMs: 24 * 3600_000
});

/** Finish award of a race map; the first finish ever pays the same again. */
export function raceFinish(map: { kind: GameModeId; difficulty: 'easy' | 'hard' }): number {
	return map.kind === 'surf' || map.kind === 'bhop' ? RACE_PAY.finish[map.kind][map.difficulty] : 0;
}

export const ZOMBIES_PAY = Object.freeze({
	/** Passing gate n (1-based) alive, before the repeat decay. */
	gate: (n: number): number => pts(n),
	/** Reaching the evac alive, before the repeat decay. */
	evac: (gates: number): number => pts(gates + 3),
	/** The same gate (or the evac) of the same map in one map session, and within `REPEAT_MS`, percent (stays at the last). */
	repeat: Object.freeze([100, 50, 25, 10]),
	/** Share of the gates a player must have passed in the round for the evac (besides the last one). */
	evacShare: 0.5,
	/** As a player-zombie, per survivor killed. */
	turnedKill: pts(1)
});

/** Zombie Defense (docs/economy.md#zombie-defense): account coins per wave cleared, not the in-mode gold. */
export const DEFENSE_PAY = Object.freeze({
	/** Clearing wave n (1-based) while in the game, before the repeat decay: 1 for waves 1-3, +1 every 4 waves, at most 5 (wave 16 on). */
	wave: (n: number): number => pts(Math.min(5, 1 + Math.floor(Math.max(1, n) / 4))),
	/** The same wave number on the same map in one map session, and within `REPEAT_MS`, percent (stays at the last). */
	repeat: Object.freeze([100, 50, 25, 10])
});

export const TAG_PAY = Object.freeze({
	chased: Object.freeze({ points: pts(1), everyMs: 20_000 }),
	tag: pts(1),
	/** First, second and third place. */
	placement: Object.freeze([pts(3), pts(2), pts(1)]),
	/** No placement for a runner chased for less than this in the round (never IT either): hiding. */
	placeChasedMs: 10_000
});

/**
 * Tag placement: most time not IT first; tied (as shown, 0.1 s) by time chased;
 * still tied players share the places' points, rounded down to whole ones, at least 1.
 */
export function tagPlacements(
	rows: readonly { id: number; score: number; chasedMs: number }[]
): { id: number; place: number; base: number }[] {
	const shown = (r: { score: number }) => Math.round(r.score * 10);
	const order = [...rows].sort((a, b) => shown(b) - shown(a) || b.chasedMs - a.chasedMs || a.id - b.id);
	const out: { id: number; place: number; base: number }[] = [];
	for (let i = 0; i < order.length && i < TAG_PAY.placement.length; ) {
		const tied = order.slice(i).filter((r) => shown(r) === shown(order[i]!) && r.chasedMs === order[i]!.chasedMs);
		const sum = tied.reduce((n, _, k) => n + (TAG_PAY.placement[i + k] ?? 0), 0);
		const base = pts(Math.max(1, Math.floor(sum / tied.length / POINTS_SCALE)));
		for (const r of tied) out.push({ id: r.id, place: i + 1, base });
		i += tied.length;
	}
	return out;
}

export const HNS_PAY = Object.freeze({
	seekerChase: Object.freeze({ points: pts(1), everyMs: 20_000 }),
	hiderChased: Object.freeze({ points: pts(1), everyMs: 10_000 }),
	find: pts(3),
	plainView: Object.freeze({ points: pts(2), everyMs: 30_000, area: 128 }),
	surviveSeen: pts(5),
	surviveUnseen: pts(2),
	/** Seconds seen in total that make a survival "seen". */
	seenMs: 5_000,
	seekersWin: pts(3),
	/** Cash bag: whole points, both ends included. */
	bagMin: pts(4),
	bagMax: pts(10)
});

export const INFECTED_PAY = Object.freeze({
	/** The same infected counts for at most `perVictim` kills of one survivor and round. */
	kills: Object.freeze({ points: pts(1), every: 4, perVictim: 4 }),
	infect: pts(1),
	/** Infections (and bank shots) the lobby can still be paid for: a stock that refills while a round is played. */
	infectStock: Object.freeze({ max: 16, everyMs: 15_000 }),
	bankShot: pts(1),
	survive: pts(4),
	/** Fewer than half of the first survivors were infected, or the survivor killed no infected. */
	surviveEasy: pts(2),
	lastSurvivor: pts(3),
	/** The streak needs kills of at least `victims` different infected. */
	specialist: pts(2),
	specialistVictims: 2,
	moab: pts(8),
	/** M.O.A.B.s of one player in one map session, percent (stays at the last). */
	moabRepeat: Object.freeze([100, 10]),
	beacon: pts(1),
	winPatientZero: pts(2),
	winInfected: pts(1),
	/** Share of the round clock that must have been played for the infected win, and for survive / last survivor (a M.O.A.B. can end a round early). */
	winShare: 0.5,
	surviveShare: 1
});

/** Chase and view ranges (units) for `HuntTracker` (modes/hunt.ts). */
export const HUNT_RANGE = Object.freeze({ tagChase: 500, hnsChase: 600, hnsView: 2000 });

/** Active players a mode needs before it pays anything but playtime. */
export const MIN_ACTIVE: Readonly<Partial<Record<GameModeId, number>>> = Object.freeze({ tag: 3, hns: 3, infected: 4, defense: 1 });

export interface AwardDef {
	/** Shown in the popup and the Coins view. */
	label: string;
	/** Base paid per round at most (tenths); enforced by the server's `award`. */
	perRound?: number;
	/** Base paid per map session at most (tenths). */
	perSession?: number;
	/** Active players needed, when more than the mode's own minimum. */
	minActive?: number;
	/** Not counted towards the hourly backstop. */
	exempt?: boolean;
	/** Chase or view points: concentration on one other account is an abuse signal. */
	pair?: boolean;
}

const defs = {
	playtime: { label: 'Playtime' },

	raceFinish: { label: 'Map finished' },
	raceFirst: { label: 'First finish', exempt: true },
	racePb: { label: 'Personal best' },
	raceRecord: { label: 'Server record', exempt: true },

	zombiesGate: { label: 'Gate passed' },
	zombiesEvac: { label: 'Evacuated' },
	zombiesKill: { label: 'Survivor caught', perRound: pts(3) },

	defenseWave: { label: 'Wave cleared' },

	tagChased: { label: 'Being chased', perRound: pts(3), pair: true },
	tagTag: { label: 'Tag', perRound: pts(3) },
	tagPlace: { label: 'Placement', minActive: 4 },

	hnsChase: { label: 'Chasing', perRound: pts(4), pair: true },
	hnsChased: { label: 'Being chased', perRound: pts(8), pair: true },
	hnsFind: { label: 'Found a hider' },
	hnsView: { label: 'Hiding in plain view', perRound: pts(6), pair: true },
	hnsSurvive: { label: 'Survived' },
	hnsSeekersWin: { label: 'Seekers win' },
	hnsBag: { label: 'Cash bag', perRound: HNS_PAY.bagMax },

	infKills: { label: 'Infected killed', perRound: pts(4) },
	infInfect: { label: 'Survivor infected', perRound: pts(5) },
	infBank: { label: 'Bank shot', perRound: pts(1) },
	infSurvive: { label: 'Survived', perRound: INFECTED_PAY.survive },
	infLast: { label: 'Last survivor', perRound: INFECTED_PAY.lastSurvivor },
	infSpecialist: { label: 'Specialist', perRound: INFECTED_PAY.specialist },
	infMoab: { label: 'M.O.A.B.' },
	infBeacon: { label: 'Beacon smashed', perRound: INFECTED_PAY.beacon },
	infWin: { label: 'Infected win', perRound: INFECTED_PAY.winPatientZero }
} satisfies Record<string, AwardDef>;

export type AwardReason = keyof typeof defs;
export const AWARDS: Readonly<Record<AwardReason, AwardDef>> = Object.freeze(defs);

/** Display label of a logged reason (also shop purchases and ids from a newer server). */
export function awardLabel(reason: string): string {
	if (Object.hasOwn(AWARDS, reason)) return AWARDS[reason as AwardReason].label;
	if (reason === WELCOME_REASON) return 'Welcome bonus';
	if (!reason.startsWith('shop:')) return reason;
	const id = reason.slice(5);
	return `Shop: ${getCosmetic(id)?.name ?? id}`;
}

// ---------------------------------------------------------------------------
// Activity and abuse
// ---------------------------------------------------------------------------

export const ACTIVITY = Object.freeze({
	/** Still for longer: AFK (multiplier, minimum counts, awards). */
	stillMs: 30_000,
	/** No varied input for longer: no playtime. */
	idleMs: 3 * 60_000,
	/** Spectating counts as playtime for this long in a row. */
	spectateMs: 5 * 60_000,
	/** Awards are rejected this long after an impossible speed or teleport. */
	suspectMs: 5_000
});

/**
 * Horizontal speed (units/s) no normal play reaches: above it awards are
 * rejected for `ACTIVITY.suspectMs`. A sanity limit, not the movement cap:
 * hide and seek, Infected and Zombie Run only have a soft cap (286 u/s per
 * jump), tag has surf sections, and race runs are validated anyway.
 */
export const SPEED_LIMIT: Readonly<Record<GameModeId, number>> = Object.freeze({
	surf: 16_384,
	bhop: 16_384,
	tag: 3_500,
	zombies: 1_000,
	infected: 1_000,
	hns: 600,
	defense: 1_000
});

/** Base points per rolling hour and account, exempt reasons aside. */
export const BACKSTOP = Object.freeze({ points: pts(250), windowMs: 3600_000 });

export type AbuseSignal = 'shadow' | 'concentration' | 'contact' | 'ipFeed' | 'macro' | 'impossible';

export const ABUSE = Object.freeze({
	weight: Object.freeze({ shadow: 2, concentration: 1, contact: 1, ipFeed: 2, macro: 2, impossible: 1 } as Record<AbuseSignal, number>),
	/** The same signal about the same account again only after this long. */
	cooldownMs: Object.freeze({
		shadow: 60_000,
		concentration: 600_000,
		contact: 600_000,
		ipFeed: 60_000,
		macro: 60_000,
		impossible: 60_000
	} as Record<AbuseSignal, number>),
	/** One strike less per this long. */
	decayMs: 600_000,
	warnAt: 3,
	pauseMs: 5 * 60_000,
	banAt: 5,
	banMs: 5 * 60_000,
	/** A warning must be at least this old before a ban. */
	warnLeadMs: 30_000,
	/** Strikes after a ban. */
	afterBan: 2,
	/** shadow: range (units) and time next to the same target. */
	shadowRange: 100,
	shadowMs: 20_000,
	/** concentration: share of pair points from one account, over this many rounds, with this many active, from this total on. */
	pairShare: 0.7,
	pairRounds: 3,
	pairActive: 5,
	pairMin: pts(6),
	/** contact: events of one pair within this time (and `pairActive` players). */
	contactCount: 4,
	contactMs: 60_000,
	/** ipFeed: rounds in a row, and points per round from the idle account. */
	feedRounds: 3,
	feedMin: pts(2),
	/** macro: window, fewest inputs in it and the share of different ones that is suspicious. */
	macroMs: 600_000,
	macroMin: 100,
	macroShare: 0.05
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+$)/g, ',');

/** Tenths → `4`, `4.5`, `-12`: one decimal only when needed. */
export function formatTenths(tenths: number): string {
	const t = Math.round(Math.abs(tenths));
	const s = t % 10 === 0 ? thousands(t / 10) : `${thousands(Math.floor(t / 10))}.${t % 10}`;
	return tenths < 0 && t > 0 ? `-${s}` : s;
}

/** Tenths → whole points, rounded down (totals and the balance). */
export function formatWhole(tenths: number): string {
	return thousands(Math.max(0, Math.floor(tenths / POINTS_SCALE)));
}

/** Multiplier in tenths → `×1.5`. */
export function formatMultiplier(mult: number): string {
	const m = Math.round(mult);
	return `×${Math.floor(m / 10)}.${m % 10}`;
}
