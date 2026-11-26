import { describe, expect, it } from 'vitest';
import { TRN_BET, type TrnStateView } from '@surf/shared';
import { mockBracket } from '../ui/tournament-mock.js';
import {
	betAcceptedText,
	betBlocker,
	betButtonText,
	betCountText,
	betRefusalText,
	betResultText,
	betSides,
	canBet,
	championText,
	entrantName,
	hpFrac,
	phaseLine,
	pips,
	roundEndText,
	startText,
	trnLate,
	trnOut,
	trnRole
} from './tournament-view.js';

/** 8 entrants (ids 1..8), round 0 match 1 (ids 3 v 4) live, bets on it. */
function duelState(p: Partial<TrnStateView> = {}): TrnStateView {
	const bracket = mockBracket(8, 0);
	return {
		phase: 'duel',
		tournament: 2,
		round: 1,
		timeLeft: 80,
		bracket,
		duel: { match: 1, round: 1, hp: [100, 100], freeze: 2 },
		bets: { match: 1, open: true, count: [2, 1] },
		champion: null,
		...p
	};
}

describe('roles', () => {
	it('duelists are the live match; everyone else watches', () => {
		const s = duelState();
		expect(s.bracket!.matches[1]).toMatchObject({ a: 3, b: 4 });
		expect(trnRole(s, 3)).toBe('duelist');
		expect(trnRole(s, 4)).toBe('duelist');
		expect(trnRole(s, 1)).toBe('spectator');
		expect(trnRole({ ...s, phase: 'bracket' }, 3)).toBe('spectator');
		expect(trnRole(null, 3)).toBe('spectator');
	});
	it('late joiners and knocked-out entrants', () => {
		const s = duelState();
		expect(trnLate(s, 42)).toBe(true);
		expect(trnLate(s, 1)).toBe(false);
		expect(trnLate({ ...s, phase: 'ended' }, 42)).toBe(false);
		expect(trnLate({ ...s, phase: 'waiting', bracket: null }, 42)).toBe(false);
		s.bracket!.entrants[0]!.out = true;
		expect(trnOut(s, 1)).toBe(true);
		expect(trnOut(s, 2)).toBe(false);
	});
	it('names from the bracket, else the lobby', () => {
		const s = duelState();
		expect(entrantName(s, 2, () => 'lobby')).toBe('glidepath');
		expect(entrantName(s, 77, (id) => `P${id}`)).toBe('P77');
	});
});

describe('bet eligibility', () => {
	const input = (p: Partial<Parameters<typeof betBlocker>[0]> = {}) => ({ state: duelState(), selfId: 1, loggedIn: true, online: true, ...p });
	it('a logged-in spectator may bet while bets are open', () => {
		expect(betBlocker(input())).toBeNull();
		expect(canBet(input())).toBe(true);
		expect(betSides(duelState())).toEqual({ match: 1, a: 3, b: 4, open: true, count: [2, 1] });
	});
	it('not the two duelists, not guests, not closed, not offline', () => {
		expect(betBlocker(input({ selfId: 3 }))).toBe('duelist');
		expect(betBlocker(input({ selfId: 4 }))).toBe('duelist');
		expect(betBlocker(input({ loggedIn: false }))).toBe('guest');
		expect(betBlocker(input({ state: duelState({ bets: { match: 1, open: false, count: [0, 0] } }) }))).toBe('closed');
		expect(betBlocker(input({ online: false }))).toBe('offline');
	});
	it('no bets: missing, too small a bracket, or a match without two players', () => {
		expect(betBlocker(input({ state: duelState({ bets: null }) }))).toBe('none');
		const small = duelState({ bracket: mockBracket(3, 0), duel: null, bets: { match: 1, open: true, count: [0, 0] } });
		expect(betSides(small)).toBeNull();
		const tbd = duelState({ bets: { match: 4, open: true, count: [0, 0] } });
		expect(tbd.bracket!.matches[4]!.round).toBe(1);
		expect(betSides(tbd)).toBeNull();
	});
});

describe('texts', () => {
	it('bets', () => {
		expect(betButtonText('Alice')).toBe(`Bet ${TRN_BET} on Alice`);
		expect(betAcceptedText('Alice')).toBe('Your bet: 20 on Alice');
		expect(betResultText('won', 40)).toBe('Bet won · +40 coins');
		expect(betResultText('refund', 20)).toBe('Bet refunded · +20 coins');
		expect(betResultText('lost', 0)).toBe('Bet lost · −20 coins');
		expect([0, 1, 2].map(betCountText)).toEqual(['0 bets', '1 bet', '2 bets']);
	});
	it('every refusal reason has its own text', () => {
		const reasons = ['closed', 'small', 'duelist', 'coins', 'twice', 'pick'];
		const texts = reasons.map(betRefusalText);
		expect(new Set(texts).size).toBe(reasons.length);
		expect(betRefusalText('coins')).toContain('Not enough coins');
		expect(betRefusalText('small')).toContain('4+');
		expect(betRefusalText(undefined)).toBe('Bet refused');
		expect(betRefusalText('new-reason')).toBe('Bet refused');
	});
	it('banners', () => {
		expect(startText(6)).toBe('6 entrants · prize 16 coins');
		expect(startText(2)).toBe('2 entrants · prize 1 coin');
		expect(championText('Alice', false)).toBe('Alice wins the tournament!');
		expect(championText('you', true)).toBe('You win the tournament!');
		expect(roundEndText('Alice', 2, 'kill')).toBe('Alice wins round 2');
		expect(roundEndText('Bob', 1, 'time')).toBe('Bob wins round 1 on time');
		expect(roundEndText(null, 3, 'draw')).toBe('Round 3 drawn · replayed');
	});
	it('phase lines', () => {
		expect(phaseLine('waiting', false, false)).toContain('needs 2+');
		expect(phaseLine('solo', false, false)).toContain('Offline');
		expect(phaseLine('duel', true, false)).toBe('You are spectating · the next tournament starts soon');
		expect(phaseLine('bracket', false, true)).toContain('Knocked out');
		expect(phaseLine('duel', false, false)).toBeNull();
	});
	it('pips and HP', () => {
		expect(pips(1, 2)).toEqual([true, false]);
		expect(pips(2, 2)).toEqual([true, true]);
		expect(hpFrac(150)).toBe(1);
		expect(hpFrac(-5)).toBe(0);
		expect(hpFrac(Number.NaN)).toBe(0);
		expect(hpFrac(25)).toBe(0.25);
	});
});
