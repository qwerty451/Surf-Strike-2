import { describe, expect, it } from 'vitest';
import type { TrnStateView } from '@surf/shared';
import {
	BRACKET_METRICS,
	BRACKET_METRICS_COMPACT,
	bracketChampion,
	bracketModel,
	bracketRounds,
	bracketSize,
	bracketWindow,
	championPos,
	connectorPath,
	currentMatch,
	fitName,
	matchesInRound,
	matchPos,
	type BoxPos
} from './bracket-layout.js';
import { mockBracket, TRN_MOCK_SELF } from './tournament-mock.js';

const centre = (p: BoxPos) => p.y + p.h / 2;
const overlap = (a: BoxPos, b: BoxPos) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const state = (n: number, played: number, p: Partial<TrnStateView> = {}): TrnStateView => ({
	phase: 'bracket',
	tournament: 1,
	round: 1,
	timeLeft: 6,
	bracket: mockBracket(n, played),
	duel: null,
	bets: null,
	champion: null,
	...p
});

describe('bracket geometry', () => {
	it('rounds and matches per round', () => {
		expect([2, 3, 4, 5, 8, 9, 16].map(bracketRounds)).toEqual([1, 2, 2, 3, 3, 4, 4]);
		expect([0, 1, 2, 3].map((r) => matchesInRound(16, r))).toEqual([8, 4, 2, 1]);
		expect(matchesInRound(2, 0)).toBe(1);
	});

	for (const size of [2, 4, 8, 16]) {
		for (const m of [BRACKET_METRICS, BRACKET_METRICS_COMPACT]) {
			it(`size ${size} (${m.boxW}): parents centred on children, no overlap, all inside`, () => {
				const rounds = bracketRounds(size);
				const boxes: BoxPos[] = [];
				for (let r = 0; r < rounds; r++) {
					for (let i = 0; i < matchesInRound(size, r); i++) {
						const p = matchPos(size, r, i, m);
						boxes.push(p);
						if (r > 0) {
							const c0 = matchPos(size, r - 1, 2 * i, m);
							const c1 = matchPos(size, r - 1, 2 * i + 1, m);
							expect(centre(p)).toBeCloseTo((centre(c0) + centre(c1)) / 2, 6);
							expect(p.x).toBeGreaterThan(c0.x + c0.w);
						}
					}
				}
				const champ = championPos(size, m);
				boxes.push(champ);
				expect(centre(champ)).toBeCloseTo(centre(matchPos(size, rounds - 1, 0, m)), 6);
				for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) expect(overlap(boxes[a]!, boxes[b]!)).toBe(false);
				const { width, height } = bracketSize(size, m);
				for (const p of boxes) {
					expect(p.x).toBeGreaterThanOrEqual(0);
					expect(p.y).toBeGreaterThanOrEqual(m.headH);
					expect(p.x + p.w).toBeLessThanOrEqual(width + 1e-6);
					expect(p.y + p.h).toBeLessThanOrEqual(height + 1e-6);
				}
			});
		}
	}

	it('connectors run from a child to its parent, the final to the champion', () => {
		const m = BRACKET_METRICS;
		const from = matchPos(8, 0, 3, m);
		const to = matchPos(8, 1, 1, m);
		expect(connectorPath(8, 0, 3, m)).toBe(`M${from.x + from.w} ${centre(from)}H${(from.x + from.w + to.x) / 2}V${centre(to)}H${to.x}`);
		const champ = championPos(8, m);
		expect(connectorPath(8, 2, 0, m).endsWith(`H${champ.x}`)).toBe(true);
	});
});

describe('bracket model', () => {
	it('3 entrants: one bye in round 0, greyed and passed through', () => {
		const model = bracketModel(state(3, 0), TRN_MOCK_SELF)!;
		expect(model.size).toBe(4);
		expect(model.boxes.map((b) => b.key)).toEqual(['0:0', '0:1', '1:0']);
		const bye = model.boxes[0]!;
		expect(bye.bye).toBe(true);
		expect(bye.b).toMatchObject({ id: null, name: 'Bye', state: 'bye', wins: null });
		expect(bye.a).toMatchObject({ state: 'won', wins: null, self: true });
		// The final has the bye's winner on side a and waits for the other match.
		const final = model.boxes[2]!;
		expect(final.a.id).toBe(TRN_MOCK_SELF);
		expect(final.b).toMatchObject({ id: null, name: 'TBD', state: 'tbd' });
		expect(model.columns.map((c) => c.label)).toEqual(['Semifinal', 'Final', 'Champion']);
	});

	it('2 entrants: a final and the champion slot', () => {
		const model = bracketModel(state(2, 1, { phase: 'ended' }), 99)!;
		expect(model.rounds).toBe(1);
		expect(model.boxes).toHaveLength(1);
		expect(model.champion.id).toBe(TRN_MOCK_SELF);
		expect(model.champion.name).toBe('you');
	});

	it('scores, losers struck, knocked-out winners dimmed later, forfeits', () => {
		const s = state(8, 5);
		const model = bracketModel(s, TRN_MOCK_SELF)!;
		const first = model.boxes.filter((b) => b.round === 0);
		expect(first.every((b) => b.done)).toBe(true);
		for (const b of first) {
			const won = b.a.state === 'won' ? b.a : b.b;
			const lost = b.a.state === 'won' ? b.b : b.a;
			expect(won.state).toBe('won');
			expect(lost.state).toBe('lost');
			if (!b.forfeit) expect(won.wins).toBe(2);
		}
		expect(first.some((b) => b.forfeit)).toBe(true);
		// The loser of the decided semifinal is dimmed in the round-0 box it won.
		const semi = model.boxes.find((b) => b.round === 1 && b.done)!;
		const semiLoser = semi.a.state === 'lost' ? semi.a.id : semi.b.id;
		const earlier = first.flatMap((b) => [b.a, b.b]).find((x) => x.id === semiLoser)!;
		expect(earlier).toMatchObject({ state: 'won', out: true });
		const lit = model.connectors.filter((c) => c.lit).length;
		expect(lit).toBe(5);
	});

	it('the current or next match is highlighted', () => {
		const s = state(8, 4);
		const next = currentMatch(s)!;
		expect(s.bracket!.matches[next]).toMatchObject({ round: 1, index: 0 });
		const model = bracketModel(s, 0)!;
		expect(model.boxes.filter((b) => b.current).map((b) => b.key)).toEqual(['1:0']);
		expect(model.focus).toEqual(model.boxes.find((b) => b.key === '1:0')!.pos);
		// A live duel and bets point at their match.
		expect(currentMatch({ ...s, phase: 'duel', duel: { match: 2, round: 1, hp: [100, 100], freeze: 0 } })).toBe(2);
		expect(currentMatch({ ...s, bets: { match: 3, open: true, count: [0, 0] } })).toBe(3);
		expect(currentMatch({ ...s, phase: 'ended' })).toBeNull();
	});

	it('names come from the entrants, also for players who left', () => {
		const s = state(4, 0);
		s.bracket!.entrants[1]!.left = true;
		s.bracket!.entrants[1]!.out = true;
		const model = bracketModel(s, 0)!;
		const slot = model.boxes.flatMap((b) => [b.a, b.b]).find((x) => x.id === 2)!;
		expect(slot).toMatchObject({ name: 'glidepath', left: true, out: true });
	});

	it('champion: the state, else the final winner', () => {
		const s = state(4, 3);
		expect(bracketChampion(s)).toBe(TRN_MOCK_SELF);
		expect(bracketChampion({ ...s, champion: 3 })).toBe(3);
		expect(bracketChampion(state(4, 1))).toBeNull();
	});

	it('no bracket, no model', () => {
		expect(bracketModel(state(4, 0, { bracket: null }), 0)).toBeNull();
	});

	it('every size from 2 to 16 builds without overlap', () => {
		for (let n = 2; n <= 16; n++) {
			const model = bracketModel(state(n, n), 0)!;
			expect(model.boxes).toHaveLength(model.size - 1);
			const all = [...model.boxes.map((b) => b.pos), model.champion.pos];
			for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) expect(overlap(all[a]!, all[b]!)).toBe(false);
			expect(model.champion.id).not.toBeNull();
		}
	});
});

describe('narrow windows', () => {
	it('wide enough: everything shows', () => {
		const model = bracketModel(state(16, 0), 0)!;
		expect(bracketWindow(model, 2000, 0.72)).toMatchObject({ from: 0, width: model.width });
	});
	it('phone width: earlier rounds go first, never the current one', () => {
		const model = bracketModel(state(16, 8), 0, BRACKET_METRICS_COMPACT)!;
		expect(model.focus).not.toBeNull();
		const w = bracketWindow(model, 340, 0.72);
		expect(w.from).toBe(1);
		expect(model.columns[w.from]!.x).toBeLessThanOrEqual(model.focus!.x);
		expect(w.viewBox).toBe(`${model.columns[1]!.x} 0 ${model.width - model.columns[1]!.x} ${model.height}`);
		// Round 0 is current: nothing is cropped.
		const early = bracketModel(state(16, 0), 0, BRACKET_METRICS_COMPACT)!;
		expect(bracketWindow(early, 340, 0.72).from).toBe(0);
	});
	it('the end: the final always stays', () => {
		const model = bracketModel(state(16, 99, { phase: 'ended' }), 0, BRACKET_METRICS_COMPACT)!;
		expect(bracketWindow(model, 100, 0.72).from).toBe(model.rounds - 1);
	});
});

describe('fitName', () => {
	it('cuts long names with an ellipsis', () => {
		expect(fitName('glidepath', 12)).toBe('glidepath');
		expect(fitName('WWWWWWWWWWWWWWWWWWWWWWWW', 6)).toBe('WWWWW…');
		expect(fitName('ab', 1)).toBe('a…');
	});
});
