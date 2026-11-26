/**
 * Casino (docs/economy.md#casino): bets, odds and the pure rules of the three
 * games. The server rolls and pays; the client only shows the result. Coins are
 * virtual, earned by playing and never bought.
 *
 * Bets are whole coins; payouts are tenths of a coin like every other amount.
 */
import { POINTS_SCALE, pts } from './economy.ts';

export const CASINO_GAMES = ['coinflip', 'crash', 'slots'] as const;
export type CasinoGame = (typeof CASINO_GAMES)[number];
export const isCasinoGame = (v: unknown): v is CasinoGame => CASINO_GAMES.includes(v as CasinoGame);

/** Smallest and largest bet, whole coins. */
export const CASINO_MIN: Readonly<Record<CasinoGame, number>> = Object.freeze({ coinflip: 10, crash: 5, slots: 1 });
export const CASINO_MAX_BET = 500;
/** Latest results in the `casino` message and kept per account, all games together. */
export const CASINO_RECENT = 30;

/** Uniform in [0, 1). */
export type RandomSource = () => number;

/** Why a bet is refused on its own, or null. Balance and limits of the account come after it. */
export function betError(game: CasinoGame, bet: unknown): 'whole' | 'min' | 'max' | null {
	if (typeof bet !== 'number' || !Number.isInteger(bet)) return 'whole';
	if (bet < CASINO_MIN[game]) return 'min';
	return bet > CASINO_MAX_BET ? 'max' : null;
}

// ---------------------------------------------------------------------------
// Coinflip

export const COIN_SIDES = ['heads', 'tails'] as const;
export type CoinSide = (typeof COIN_SIDES)[number];
export const isCoinSide = (v: unknown): v is CoinSide => v === 'heads' || v === 'tails';
/** Won bets pay this many times the bet. */
export const COINFLIP_PAYS = 2;

export const rollCoin = (rand: RandomSource): CoinSide => (rand() < 0.5 ? 'heads' : 'tails');

/** Tenths. */
export const coinflipPayout = (bet: number, picked: CoinSide, side: CoinSide): number => (picked === side ? pts(bet) * COINFLIP_PAYS : 0);

// ---------------------------------------------------------------------------
// Crash. Multipliers are integers in hundredths (200 is 2.00×).

export const CRASH = Object.freeze({
	/** 1.00×. */
	one: 100,
	/** Cashed out by itself here, at the same odds. */
	cap: 10_000,
	/** The multiplier doubles every this many ms. */
	doubleMs: 6000
});

/** P(reaching m) = 1/m for every m in hundredths. Never above the cap. */
export function rollCrash(rand: RandomSource): number {
	// The tiny addition undoes float errors such as 100 / (1 - 0.75) = 399.999….
	return Math.min(CRASH.cap, Math.floor(CRASH.one / (1 - rand()) + 1e-9));
}

/** Chance that a round reaches `m` hundredths. */
export const crashChance = (m: number): number => Math.min(1, CRASH.one / m);

/** The multiplier (hundredths, not rounded) after `ms`. */
export const crashCurve = (ms: number): number => Math.min(CRASH.cap, CRASH.one * 2 ** (Math.max(0, ms) / CRASH.doubleMs));

/** The multiplier as counted: whole hundredths, rounded down. */
export const crashAt = (ms: number): number => Math.floor(crashCurve(ms) + 1e-9);

/** ms until the curve reaches `m` hundredths. */
export const crashTime = (m: number): number => Math.log2(m / CRASH.one) * CRASH.doubleMs;

/** Tenths, rounded down. */
export const crashPayout = (bet: number, m: number): number => Math.floor((bet * m * POINTS_SCALE) / CRASH.one);

/** A usable auto cash-out (hundredths): 1.01× up to the cap; null: none. */
export function isCrashAuto(v: unknown): v is number | null {
	return v === null || (typeof v === 'number' && Number.isInteger(v) && v > CRASH.one && v <= CRASH.cap);
}

/**
 * What has happened `ms` into a round that crashes at `crash`: still running, paid
 * out at `at`, or crashed. `cashout`: the player asks for it now. The automatic
 * cash-out wins a tie with the crash: "reaching" its value is enough.
 */
export function crashState(crash: number, auto: number | null, ms: number, cashout = false): { at: number } | 'running' | 'crashed' {
	const target = Math.min(auto ?? CRASH.cap, CRASH.cap);
	if (crash >= target && ms >= crashTime(target)) return { at: target };
	if (ms >= crashTime(crash)) return 'crashed';
	return cashout ? { at: crashAt(ms) } : 'running';
}

// ---------------------------------------------------------------------------
// Slots

export interface SlotSymbolDef {
	id: string;
	name: string;
	/** Stops per reel (of SLOT_STOPS). */
	weight: number;
	/** Pays this many times the bet for exactly two on the line, anywhere. */
	two: number;
	/** …and for three. */
	three: number;
}

/** Three equal, independent reels; most common symbol first. */
export const SLOT_SYMBOLS = [
	{ id: 'wave', name: 'Wave', weight: 9, two: 1, three: 4 },
	{ id: 'shell', name: 'Shell', weight: 7, two: 1, three: 6 },
	{ id: 'palm', name: 'Palm', weight: 6, two: 2, three: 10 },
	{ id: 'fin', name: 'Fin', weight: 4, two: 2, three: 15 },
	{ id: 'board', name: 'Board', weight: 3, two: 3, three: 25 },
	{ id: 'sun', name: 'Sun', weight: 2, two: 5, three: 50 },
	{ id: 'pearl', name: 'Pearl', weight: 1, two: 10, three: 250 }
] as const satisfies readonly SlotSymbolDef[];
export type SlotSymbolId = (typeof SLOT_SYMBOLS)[number]['id'];
export type SlotReels = [SlotSymbolId, SlotSymbolId, SlotSymbolId];

export const SLOT_STOPS: number = SLOT_SYMBOLS.reduce((n, s) => n + s.weight, 0);
export const slotSymbol = (id: string): SlotSymbolDef | undefined => SLOT_SYMBOLS.find((s) => s.id === id);

function rollSymbol(rand: RandomSource): SlotSymbolId {
	let stop = Math.floor(rand() * SLOT_STOPS);
	for (const s of SLOT_SYMBOLS) {
		stop -= s.weight;
		if (stop < 0) return s.id;
	}
	return SLOT_SYMBOLS[0].id;
}

export const rollSlots = (rand: RandomSource): SlotReels => [rollSymbol(rand), rollSymbol(rand), rollSymbol(rand)];

/** The line of three: its multiplier (0: nothing) and the symbol that pays. */
export function slotWin(reels: readonly string[]): { mult: number; symbol: SlotSymbolDef | null; count: number } {
	for (const s of SLOT_SYMBOLS) {
		const count = reels.filter((r) => r === s.id).length;
		if (count >= 2) return { mult: count === 2 ? s.two : s.three, symbol: s, count };
	}
	return { mult: 0, symbol: null, count: 0 };
}

/** Tenths. */
export const slotPayout = (bet: number, reels: readonly string[]): number => pts(bet) * slotWin(reels).mult;

/** Exact odds over all stops: any payout, more than the bet, and the average payback. */
export function slotOdds(): { hit: number; profit: number; payback: number } {
	let hit = 0;
	let profit = 0;
	let payback = 0;
	for (const a of SLOT_SYMBOLS)
		for (const b of SLOT_SYMBOLS)
			for (const c of SLOT_SYMBOLS) {
				const p = (a.weight * b.weight * c.weight) / SLOT_STOPS ** 3;
				const { mult } = slotWin([a.id, b.id, c.id]);
				if (mult > 0) hit += p;
				if (mult > 1) profit += p;
				payback += p * mult;
			}
	return { hit, profit, payback };
}

// ---------------------------------------------------------------------------
// Big wins, announced to everyone

/** A win that pays at least the first of these (payout divided by bet) is announced; the highest one reached sets the size. */
export const CASINO_NEWS_TIERS = [5, 10, 20, 50, 100] as const;
export type CasinoNewsTier = (typeof CASINO_NEWS_TIERS)[number];

/** Tier of a settled bet (same unit for both), null: not announced. */
export function casinoNewsTier(bet: number, payout: number): CasinoNewsTier | null {
	return bet > 0 ? (CASINO_NEWS_TIERS.findLast((t) => payout >= bet * t) ?? null) : null;
}

/** `casino_log` games of tournament bets and their Coins view labels. */
export const TRN_BET_LABELS = Object.freeze({ trnBet: 'Tournament bet', trnWin: 'Tournament bet won', trnRefund: 'Tournament bet refunded' });

/** Text of a settled bet in the Coins view: `Coinflip won`. `net`: payout minus bet, tenths. */
export function casinoLabel(game: string, net: number): string {
	// Tournament bets (docs/economy.md#tournament) share the casino log: stake, win, refund rows.
	if (Object.hasOwn(TRN_BET_LABELS, game)) return TRN_BET_LABELS[game as keyof typeof TRN_BET_LABELS];
	const name = isCasinoGame(game) ? { coinflip: 'Coinflip', crash: 'Crash', slots: 'Slots' }[game] : game;
	return `${name} ${net > 0 ? 'won' : net < 0 ? 'lost' : 'bet returned'}`;
}
