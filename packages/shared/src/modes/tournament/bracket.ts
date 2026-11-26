/**
 * Tournament bracket (docs/modes.md#tournament): single elimination with random
 * seeding. The entrants are padded to the next power of 2; all byes are in
 * round 0, at most one per match, spread over the tree. Matches are stored by
 * round then index, as `TrnBracketView.matches` describes (net.ts).
 *
 * Pure: the caller decides when a duel is won and who left.
 */
import type { TrnBracketView, TrnEntrant, TrnMatchView } from './net.ts';

/** A match as the rules keep it: the view plus whether it is decided. */
export interface TrnMatch extends TrnMatchView {
	/** Decided (a winner, or nobody left to win it). */
	done: boolean;
}

export interface TrnBracket {
	size: number;
	entrants: TrnEntrant[];
	matches: TrnMatch[];
}

/** Slots in round 0 for `n` entrants: the next power of 2, at least 2. */
export function bracketSize(n: number): number {
	let s = 2;
	while (s < n) s *= 2;
	return s;
}

/** Rounds of a bracket of `size` slots. */
export const bracketRounds = (size: number): number => Math.round(Math.log2(size));

/** Index into `matches` of match (round, index). */
export function matchAt(size: number, round: number, index: number): number {
	// Rounds before `round` hold size/2 + size/4 + … matches.
	let start = 0;
	for (let r = 0; r < round; r++) start += size >> (r + 1);
	return start + index;
}

/** `bits`-bit reversal of `i`: 0, half, quarter, three quarters, … spreads picks over a tree. */
function bitReverse(i: number, bits: number): number {
	let r = 0;
	for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
	return r;
}

/**
 * Round-0 match indices that get a bye, for `byes` byes among `matches`
 * matches: spread by bit reversal, so each half of the tree gets its share.
 */
export function byeMatches(matches: number, byes: number): Set<number> {
	const bits = bracketRounds(matches * 2) - 1;
	const out = new Set<number>();
	for (let i = 0; out.size < byes && i < matches; i++) out.add(bitReverse(i, bits));
	return out;
}

/** Fisher–Yates with the given source of [0, 1). */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
	const a = [...items];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.min(i, Math.floor(rng() * (i + 1)));
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a;
}

/** A new bracket of these players (at least 2), seeded at random. Byes are decided at once. */
export function createBracket(players: readonly { id: number; name: string }[], rng: () => number): TrnBracket {
	const order = shuffled(players, rng);
	const size = bracketSize(order.length);
	const first = size / 2;
	const byes = byeMatches(first, size - order.length);
	const entrants: TrnEntrant[] = [];
	const matches: TrnMatch[] = [];
	let next = 0;
	for (let i = 0; i < first; i++) {
		const a = order[next++]!;
		entrants.push({ id: a.id, name: a.name, seed: i * 2, out: false, left: false });
		let b: number | null = null;
		if (!byes.has(i)) {
			const p = order[next++]!;
			entrants.push({ id: p.id, name: p.name, seed: i * 2 + 1, out: false, left: false });
			b = p.id;
		}
		matches.push({ round: 0, index: i, a: a.id, b, winner: null, wins: [0, 0], result: null, done: false });
	}
	for (let r = 1; r < bracketRounds(size); r++) {
		for (let i = 0; i < size >> (r + 1); i++) matches.push({ round: r, index: i, a: null, b: null, winner: null, wins: [0, 0], result: null, done: false });
	}
	return { size, entrants, matches };
}

export function entrantOf(b: TrnBracket, id: number): TrnEntrant | undefined {
	return b.entrants.find((e) => e.id === id);
}

/** The final, or null for a bracket without matches. */
export const finalMatch = (b: TrnBracket): TrnMatch | null => b.matches[b.matches.length - 1] ?? null;

/** Decide match `m`: the winner moves on to (round + 1, index / 2), on side a for an even index. The loser is out. */
export function decide(b: TrnBracket, m: number, winner: number | null, result: TrnMatch['result']): void {
	const match = b.matches[m]!;
	match.done = true;
	match.winner = winner;
	match.result = result;
	for (const id of [match.a, match.b]) {
		if (id === null || id === winner) continue;
		const e = entrantOf(b, id);
		if (e) e.out = true;
	}
	if (winner === null || match.round + 1 >= bracketRounds(b.size)) return;
	const parent = b.matches[matchAt(b.size, match.round + 1, match.index >> 1)]!;
	if (match.index % 2 === 0) parent.a = winner;
	else parent.b = winner;
}

type Side = 'player' | 'left' | 'empty' | 'pending';

function side(b: TrnBracket, match: TrnMatch, s: 'a' | 'b'): Side {
	const id = match[s];
	if (id !== null) return entrantOf(b, id)?.left ? 'left' : 'player';
	if (match.round === 0) return 'empty';
	const feeder = b.matches[matchAt(b.size, match.round - 1, match.index * 2 + (s === 'a' ? 0 : 1))]!;
	return feeder.done ? 'empty' : 'pending';
}

/**
 * Decide every match that needs no duel: a bye (round 0, the other slot
 * empty), a walkover (the opponent left, or nobody can come from the other
 * side) or a match nobody is left to play. `live` (a match being played)
 * is skipped. Returns the decided match indices, in order.
 */
export function resolveBracket(b: TrnBracket, live: number | null = null): number[] {
	const out: number[] = [];
	for (let changed = true; changed; ) {
		changed = false;
		for (let m = 0; m < b.matches.length; m++) {
			const match = b.matches[m]!;
			if (match.done || m === live) continue;
			const sa = side(b, match, 'a');
			const sb = side(b, match, 'b');
			if (sa === 'pending' || sb === 'pending' || (sa === 'player' && sb === 'player')) continue;
			if (sa === 'player' || sb === 'player') {
				const bye = match.round === 0 && (sa === 'empty' || sb === 'empty');
				decide(b, m, sa === 'player' ? match.a : match.b, bye ? 'bye' : 'forfeit');
			} else decide(b, m, null, 'forfeit');
			out.push(m);
			changed = true;
		}
	}
	return out;
}

/** The next match to play, in round then index order: both players there, not decided. Null when none. */
export function nextMatch(b: TrnBracket): number | null {
	for (let m = 0; m < b.matches.length; m++) {
		const match = b.matches[m]!;
		if (!match.done && side(b, match, 'a') === 'player' && side(b, match, 'b') === 'player') return m;
	}
	return null;
}

/** The champion once the final is decided (null: not yet, or nobody was left). */
export function bracketChampion(b: TrnBracket): number | null {
	const f = finalMatch(b);
	return f?.done ? f.winner : null;
}

/** The match an entrant still has to play (or is playing), or null when they are out. */
export function pendingMatchOf(b: TrnBracket, id: number): number | null {
	for (let m = 0; m < b.matches.length; m++) {
		const match = b.matches[m]!;
		if (!match.done && (match.a === id || match.b === id)) return m;
	}
	return null;
}

export function bracketView(b: TrnBracket): TrnBracketView {
	return {
		size: b.size,
		entrants: b.entrants.map((e) => ({ ...e })),
		matches: b.matches.map(({ done: _done, ...m }) => ({ ...m, wins: [m.wins[0], m.wins[1]] }))
	};
}
