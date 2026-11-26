/**
 * Tournament bracket tree (docs/ui.md#tournament-hud): where every match box,
 * connector and the champion slot go, and what each box says. Pure: the
 * Svelte overlay (Bracket.svelte) only draws the result as one SVG.
 *
 * Layout is a classic left-to-right tree. Round r is column r; its matches
 * sit centred on the two matches that feed them, so match (r, i) is at
 * y = (i + 0.5) · 2^r · slot, where `slot` is the height one round-0 match
 * takes. The champion slot is column `rounds`, centred on the final.
 */
import { trnRoundLabel, type TrnBracketView, type TrnEntrant, type TrnMatchView, type TrnStateView } from '@surf/shared';

export interface BracketMetrics {
	/** Match box size. */
	boxW: number;
	boxH: number;
	/** Horizontal space between two columns (connectors run here). */
	gapX: number;
	/** Vertical space between two round-0 boxes. */
	gapY: number;
	/** Space above the boxes for the round labels. */
	headH: number;
}

export const BRACKET_METRICS: Readonly<BracketMetrics> = Object.freeze({ boxW: 168, boxH: 46, gapX: 30, gapY: 12, headH: 24 });
/** Narrow screens: shorter names, tighter columns. */
export const BRACKET_METRICS_COMPACT: Readonly<BracketMetrics> = Object.freeze({ boxW: 124, boxH: 42, gapX: 16, gapY: 8, headH: 22 });

export interface BoxPos {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Rounds of a bracket with `size` slots (size 2 → 1 round). */
export function bracketRounds(size: number): number {
	return Math.max(1, Math.ceil(Math.log2(Math.max(2, Math.floor(size)))));
}

/** Matches in round `round` (0-based) of a bracket with `size` slots. */
export function matchesInRound(size: number, round: number): number {
	return Math.max(1, Math.floor(2 ** bracketRounds(size) / 2 ** (round + 1)));
}

/** Top-left of match (round, index). */
export function matchPos(size: number, round: number, index: number, m: BracketMetrics = BRACKET_METRICS): BoxPos {
	const slot = m.boxH + m.gapY;
	const cy = m.headH + (index + 0.5) * 2 ** round * slot;
	return { x: round * (m.boxW + m.gapX), y: cy - m.boxH / 2, w: m.boxW, h: m.boxH };
}

/** The champion slot, right of the final and level with it. */
export function championPos(size: number, m: BracketMetrics = BRACKET_METRICS): BoxPos {
	const rounds = bracketRounds(size);
	const final = matchPos(size, rounds - 1, 0, m);
	const h = Math.round(m.boxH * 0.75);
	return { x: rounds * (m.boxW + m.gapX), y: final.y + (m.boxH - h) / 2, w: m.boxW, h };
}

/** Whole tree size (the SVG viewBox). */
export function bracketSize(size: number, m: BracketMetrics = BRACKET_METRICS): { width: number; height: number } {
	const rounds = bracketRounds(size);
	const slot = m.boxH + m.gapY;
	return { width: rounds * (m.boxW + m.gapX) + m.boxW, height: m.headH + (2 ** rounds / 2) * slot };
}

/** Elbow from the right edge of child (round, index) to the left edge of its parent (the champion slot after the final). */
export function connectorPath(size: number, round: number, index: number, m: BracketMetrics = BRACKET_METRICS): string {
	const rounds = bracketRounds(size);
	const from = matchPos(size, round, index, m);
	const to = round + 1 >= rounds ? championPos(size, m) : matchPos(size, round + 1, Math.floor(index / 2), m);
	const x0 = from.x + from.w;
	const y0 = from.y + from.h / 2;
	const x1 = to.x;
	const y1 = to.y + to.h / 2;
	const mx = x0 + (x1 - x0) / 2;
	return `M${x0} ${y0}H${mx}V${y1}H${x1}`;
}

// ---------------------------------------------------------------------------
// What the boxes say

export type SlotState =
	/** Won the match. */
	| 'won'
	/** Lost it (knocked out here). */
	| 'lost'
	/** Playing it, or waiting for it. */
	| 'live'
	/** A free pass (round 0, no opponent). */
	| 'bye'
	/** Not decided yet (a later round). */
	| 'tbd';

export interface BracketSlot {
	id: number | null;
	name: string;
	state: SlotState;
	/** Round wins in this match; null when there is nothing to count (bye, not decided). */
	wins: number | null;
	/** Left the server during the tournament. */
	left: boolean;
	/** Out of the tournament (lost here or later, or left), and still in a box that is not their loss. */
	out: boolean;
	self: boolean;
}

export interface BracketBox {
	key: string;
	round: number;
	index: number;
	pos: BoxPos;
	a: BracketSlot;
	b: BracketSlot;
	/** The live duel, or (between duels) the next one. */
	current: boolean;
	/** Decided by a bye (greyed out). */
	bye: boolean;
	/** Decided by a forfeit. */
	forfeit: boolean;
	done: boolean;
}

export interface BracketModel {
	size: number;
	rounds: number;
	width: number;
	height: number;
	columns: { round: number; x: number; w: number; label: string }[];
	boxes: BracketBox[];
	/** One per match: to its parent (or the champion slot). `lit`: the winner's path. */
	connectors: { key: string; d: string; lit: boolean }[];
	champion: { pos: BoxPos; id: number | null; name: string; self: boolean };
	/** The box of the current/next match (the overlay scrolls to it). */
	focus: BoxPos | null;
}

/** Name shown in a box: cut to `max` characters with an ellipsis. */
export function fitName(name: string, max: number): string {
	const chars = [...name];
	return chars.length <= max ? name : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/**
 * The live duel's match, or between duels the next one (the bets' match, else
 * the first match of the lowest round with two players and no winner).
 */
export function currentMatch(s: Pick<TrnStateView, 'phase' | 'duel' | 'bets' | 'bracket'>): number | null {
	if (!s.bracket || s.phase === 'ended' || s.phase === 'waiting') return null;
	if (s.duel) return s.duel.match;
	if (s.bets) return s.bets.match;
	let best: number | null = null;
	s.bracket.matches.forEach((m, i) => {
		if (m.a === null || m.b === null || m.winner !== null) return;
		const b = best === null ? null : s.bracket!.matches[best]!;
		if (!b || m.round < b.round || (m.round === b.round && m.index < b.index)) best = i;
	});
	return best;
}

/** The champion: the state's, else the final's winner. */
export function bracketChampion(s: Pick<TrnStateView, 'bracket' | 'champion'>): number | null {
	if (s.champion !== null) return s.champion;
	const b = s.bracket;
	if (!b) return null;
	const final = b.matches.find((m) => m.round === bracketRounds(b.size) - 1 && m.index === 0);
	return final?.winner ?? null;
}

function slot(m: TrnMatchView, side: 0 | 1, byId: ReadonlyMap<number, TrnEntrant>, selfId: number): BracketSlot {
	const id = side === 0 ? m.a : m.b;
	const other = side === 0 ? m.b : m.a;
	if (id === null) {
		// Round 0 only has byes; later an empty side waits for the match below.
		const bye = m.round === 0 || m.result === 'bye';
		return { id: null, name: bye ? 'Bye' : 'TBD', state: bye ? 'bye' : 'tbd', wins: null, left: false, out: false, self: false };
	}
	const e = byId.get(id);
	const state: SlotState = m.winner === null ? 'live' : m.winner === id ? 'won' : 'lost';
	const counted = m.result !== 'bye' && other !== null;
	return {
		id,
		name: e?.name ?? `#${id}`,
		state,
		wins: counted ? (m.wins[side] ?? 0) : null,
		left: e?.left ?? false,
		out: state !== 'lost' && (e?.out ?? false),
		self: id === selfId
	};
}

/** Everything the overlay draws for a bracket. `selfId`: my player id (my name is marked). */
export function bracketModel(
	s: Pick<TrnStateView, 'phase' | 'duel' | 'bets' | 'bracket' | 'champion'>,
	selfId: number,
	m: BracketMetrics = BRACKET_METRICS
): BracketModel | null {
	const b: TrnBracketView | null = s.bracket;
	if (!b || !(b.size >= 2)) return null;
	const rounds = bracketRounds(b.size);
	const byId = new Map(b.entrants.map((e) => [e.id, e]));
	const cur = currentMatch(s);
	const curMatch = cur === null ? null : (b.matches[cur] ?? null);
	const { width, height } = bracketSize(b.size, m);
	const boxes: BracketBox[] = [];
	const connectors: BracketModel['connectors'] = [];
	let focus: BoxPos | null = null;
	for (let r = 0; r < rounds; r++) {
		const n = matchesInRound(b.size, r);
		for (let i = 0; i < n; i++) {
			const match = b.matches.find((x) => x.round === r && x.index === i) ?? { round: r, index: i, a: null, b: null, winner: null, wins: [0, 0] as [number, number], result: null };
			const pos = matchPos(b.size, r, i, m);
			const current = curMatch !== null && curMatch.round === r && curMatch.index === i;
			if (current) focus = pos;
			boxes.push({
				key: `${r}:${i}`,
				round: r,
				index: i,
				pos,
				a: slot(match, 0, byId, selfId),
				b: slot(match, 1, byId, selfId),
				current,
				bye: match.result === 'bye' || (r === 0 && (match.a === null || match.b === null)),
				forfeit: match.result === 'forfeit',
				done: match.winner !== null
			});
			connectors.push({ key: `${r}:${i}`, d: connectorPath(b.size, r, i, m), lit: match.winner !== null && match.result !== 'bye' });
		}
	}
	const champ = bracketChampion(s);
	return {
		size: b.size,
		rounds,
		width,
		height,
		columns: Array.from({ length: rounds + 1 }, (_, r) => ({
			round: r,
			x: r * (m.boxW + m.gapX),
			w: m.boxW,
			label: r < rounds ? trnRoundLabel(r + 1, b.size) : 'Champion'
		})),
		boxes,
		connectors,
		champion: { pos: championPos(b.size, m), id: champ, name: champ === null ? '?' : (byId.get(champ)?.name ?? `#${champ}`), self: champ === selfId },
		focus
	};
}

/**
 * The part of the tree that is drawn in a window `viewW` CSS pixels wide
 * without going below `minScale`: whole columns from `from` on, never
 * cropping the column of the current match (earlier rounds go first, the
 * final and the champion always show). The viewBox follows.
 */
export function bracketWindow(model: Pick<BracketModel, 'columns' | 'width' | 'height' | 'focus' | 'rounds'>, viewW: number, minScale: number): { from: number; viewBox: string; width: number } {
	const fit = viewW / Math.max(0.01, minScale);
	const focusX = model.focus?.x ?? Infinity;
	let from = 0;
	while (from < model.rounds - 1 && model.width - model.columns[from]!.x > fit && model.columns[from + 1]!.x <= focusX) from++;
	const x = model.columns[from]!.x;
	const width = model.width - x;
	return { from, viewBox: `${x} 0 ${width} ${model.height}`, width };
}
