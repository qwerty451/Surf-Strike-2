/**
 * Tournament wire contract (docs/modes.md#tournament): the mode state the
 * server broadcasts (`modeState { mode: 'tournament' }`), the events it sends
 * (`{ type: 'trn', ev }`) and the few constants both sides need.
 *
 * Shape of the mode: 1v1 duels in a small arena, single elimination, random
 * seeding. Everyone else watches from a glass deck above the arena. A duel is
 * first to `TRN_ROUND_WINS` round wins (best of 2, a third round breaks a 1-1).
 * Players who join after a tournament started watch until the next one.
 *
 * Fields may be added; existing names and meanings stay as written here.
 */
import type { Vec3 } from '../../types.ts';
import type { WeaponId } from '../zombies/weapons.ts';
import type { PlayerPart } from '../zombies/hitbox.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Round wins that take a duel (so at most 3 rounds). */
export const TRN_ROUND_WINS = 2;
/** Seconds per duel round; at the end the duelist with more HP wins it (equal HP: replay the round). */
export const TRN_ROUND_SECS = 90;
/** Coins a spectator stakes on one duel. */
export const TRN_BET = 20;
/** Betting needs a bracket of at least this many entrants. */
export const TRN_BET_MIN_ENTRANTS = 4;
/** Seconds from the end of a tournament to the start of the next one. */
export const TRN_NEXT_SECS = 15;
/** Duelists carry all three, always. */
export const TRN_WEAPONS: readonly WeaponId[] = ['sniper', 'pistol', 'knife'];
/** Hits a spectator's knife needs to drop another spectator (no rewards, instant respawn on the deck). */
export const TRN_DECK_KNIFE_HITS = 3;

/** Whole coins the champion gets for a bracket of `entrants`: 1, 2, 4, … doubling per entrant above 2, max 32. */
export function trnPrize(entrants: number): number {
	const n = Math.floor(entrants);
	if (n < 2) return 0;
	return Math.min(32, 2 ** (n - 2));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * waiting: fewer than 2 players. starting: countdown to the first duel.
 * duel: a duel round is on (or its short freeze / round-end pause).
 * bracket: the tree is shown between two duels (bets open for the next one).
 * ended: champion shown; the next tournament starts after `TRN_NEXT_SECS`.
 */
export type TrnPhase = 'waiting' | 'starting' | 'duel' | 'bracket' | 'ended';

export type TrnRole = 'duelist' | 'spectator';

/** One bracket entrant. `seed` is the slot in round 0 (0..size-1). */
export interface TrnEntrant {
	id: number;
	name: string;
	seed: number;
	/** Knocked out (lost a duel, forfeited or left). */
	out: boolean;
	/** Left the server during this tournament. */
	left: boolean;
}

/**
 * One match of the tree. `round` 0 is the first round; matches of round r
 * have `index` 0..size/2^(r+1)-1, and the winner of (r, i) plays in
 * (r+1, floor(i/2)), on side a when i is even.
 */
export interface TrnMatchView {
	round: number;
	index: number;
	/** Player ids; null: a bye (round 0) or not decided yet. */
	a: number | null;
	b: number | null;
	winner: number | null;
	/** Round wins [a, b]. */
	wins: [number, number];
	/** How it was decided: by rounds, a forfeit (leave) or a bye. */
	result: 'rounds' | 'forfeit' | 'bye' | null;
}

export interface TrnBracketView {
	/** Slots in round 0: entrants rounded up to a power of 2 (byes fill the rest). */
	size: number;
	entrants: TrnEntrant[];
	/** All matches, by round then index. */
	matches: TrnMatchView[];
}

export interface TrnDuelView {
	/** Index into `bracket.matches`. */
	match: number;
	/** Round of the duel, 1-based (1..3). */
	round: number;
	/** HP [a, b], 0..100. */
	hp: [number, number];
	/** Seconds of freeze left before the round goes live (0 when live). */
	freeze: number;
}

/** Bets on the current or next duel. Absent when the bracket is too small. */
export interface TrnBetsView {
	/** Index into `bracket.matches`. */
	match: number;
	/** Bets are accepted (before the duel's first round goes live). */
	open: boolean;
	/** Number of bets on [a, b]. */
	count: [number, number];
}

/** Tournament state for the HUD and scoreboard (`modeState { mode: 'tournament' }`). */
export interface TrnStateView {
	phase: TrnPhase;
	/** Tournament counter on this map (1-based; 0 while waiting for the first). */
	tournament: number;
	/** Bracket round of the live or next duel, 1-based (0 outside a tournament); the score panel shows it. */
	round: number;
	/** Seconds left of the current phase or duel round. */
	timeLeft: number;
	bracket: TrnBracketView | null;
	/** The live duel. */
	duel: TrnDuelView | null;
	bets: TrnBetsView | null;
	/** Champion of the tournament that just ended. */
	champion: number | null;
}

// ---------------------------------------------------------------------------
// Events (`{ type: 'trn', ev }`)
// ---------------------------------------------------------------------------

export type TrnEvent =
	/** To that player: place yourself here (duel start, round start, deck respawn). */
	| { e: 'spawn'; id: number; role: TrnRole; pos: Vec3; yaw: number; freezeSecs: number }
	| { e: 'start'; tournament: number; entrants: number; prize: number }
	| { e: 'duelStart'; match: number; a: number; b: number }
	| { e: 'roundStart'; match: number; round: number }
	| { e: 'roundEnd'; match: number; round: number; winner: number | null; reason: 'kill' | 'time' | 'draw'; wins: [number, number] }
	| { e: 'duelEnd'; match: number; winner: number; loser: number | null; result: 'rounds' | 'forfeit' | 'bye' }
	/** A hit, to the shooter (hit marker) and the target (hurt). */
	| { e: 'hit'; by: number; target: number; part: PlayerPart; dmg: number; hp: number }
	/** Kill feed. `deck`: a spectator knife fight on the glass. */
	| { e: 'kill'; by: number; target: number; weapon: WeaponId; head: boolean; deck: boolean }
	/** Tracer of a shot, to everyone but the shooter. */
	| { e: 'shot'; id: number; weapon: WeaponId; origin: Vec3; end: Vec3 }
	/** To that player: magazine / reserve after a shot or reload. */
	| { e: 'ammo'; weapon: WeaponId; mag: number; reserve: number }
	/** To the bettor: bet accepted or refused (reason: 'closed' | 'small' | 'duelist' | 'coins' | 'twice' | 'pick'). */
	| { e: 'bet'; ok: boolean; match: number; pick: number | null; reason?: string }
	/** To the bettor: outcome of their bet. `payout`: whole coins back (2× stake on a win, stake on a refund, 0 on a loss). */
	| { e: 'betResult'; match: number; outcome: 'won' | 'lost' | 'refund'; payout: number }
	| { e: 'champion'; tournament: number; id: number; entrants: number; prize: number };
