/**
 * Tournament HUD helpers (docs/ui.md#tournament-hud): texts, roles and bet
 * eligibility from the mode state. Pure, so the client and the mock share
 * them and vitest covers them.
 */
import { TRN_BET, TRN_BET_MIN_ENTRANTS, trnPrize, type TrnEntrant, type TrnMatchView, type TrnRole, type TrnStateView } from '@surf/shared';

/** Name of entrant `id` from the bracket (also after they left), else the lobby's name. */
export function entrantName(s: TrnStateView | null, id: number, fallback: (id: number) => string): string {
	return s?.bracket?.entrants.find((e) => e.id === id)?.name ?? fallback(id);
}

export function entrantOf(s: TrnStateView | null, id: number): TrnEntrant | null {
	return s?.bracket?.entrants.find((e) => e.id === id) ?? null;
}

/** The match of the live duel. */
export function duelMatch(s: TrnStateView | null): TrnMatchView | null {
	if (!s?.duel || !s.bracket) return null;
	return s.bracket.matches[s.duel.match] ?? null;
}

/** Duelist while a duel is on and `id` is one of its two players; everyone else watches from the deck. */
export function trnRole(s: TrnStateView | null, id: number): TrnRole {
	if (!s || s.phase !== 'duel') return 'spectator';
	const m = duelMatch(s);
	return m && (m.a === id || m.b === id) ? 'duelist' : 'spectator';
}

/** Joined after the tournament started: not in its bracket. */
export function trnLate(s: TrnStateView | null, id: number): boolean {
	if (!s || !s.bracket || s.phase === 'waiting' || s.phase === 'ended') return false;
	return !s.bracket.entrants.some((e) => e.id === id);
}

/** Entrant who is knocked out (and the tournament still runs). */
export function trnOut(s: TrnStateView | null, id: number): boolean {
	if (!s || s.phase === 'waiting' || s.phase === 'ended') return false;
	return entrantOf(s, id)?.out ?? false;
}

export interface BetInput {
	state: TrnStateView | null;
	selfId: number;
	/** Logged-in account (guests have no coins). */
	loggedIn: boolean;
	online: boolean;
}

/** The two sides of the bets' match, or null when there is nothing to bet on. */
export function betSides(s: TrnStateView | null): { match: number; a: number; b: number; open: boolean; count: [number, number] } | null {
	const bets = s?.bets;
	if (!bets || !s?.bracket) return null;
	if (s.bracket.entrants.length < TRN_BET_MIN_ENTRANTS) return null;
	const m = s.bracket.matches[bets.match];
	if (!m || m.a === null || m.b === null) return null;
	return { match: bets.match, a: m.a, b: m.b, open: bets.open, count: bets.count };
}

/** Why the local player cannot bet right now, or null: they may. */
export function betBlocker(i: BetInput): 'offline' | 'none' | 'closed' | 'guest' | 'duelist' | null {
	if (!i.online) return 'offline';
	const sides = betSides(i.state);
	if (!sides) return 'none';
	if (!sides.open) return 'closed';
	if (!i.loggedIn) return 'guest';
	if (sides.a === i.selfId || sides.b === i.selfId) return 'duelist';
	return null;
}

export function canBet(i: BetInput): boolean {
	return betBlocker(i) === null;
}

/** Text of a refused bet (the `bet` event's reason). */
export function betRefusalText(reason: string | undefined): string {
	switch (reason) {
		case 'closed':
			return 'Betting closed for this duel';
		case 'small':
			return `Bets need ${TRN_BET_MIN_ENTRANTS}+ entrants`;
		case 'duelist':
			return "You can't bet on your own duel";
		case 'coins':
			return `Not enough coins (bet is ${TRN_BET})`;
		case 'twice':
			return 'You already bet on this duel';
		case 'pick':
			return 'Pick one of the two duelists';
		default:
			return 'Bet refused';
	}
}

export function betAcceptedText(name: string): string {
	return `Your bet: ${TRN_BET} on ${name}`;
}

/** Outcome of my bet (`betResult`): the payout is what the server says. */
export function betResultText(outcome: 'won' | 'lost' | 'refund', payout: number): string {
	if (outcome === 'won') return `Bet won · +${payout} coins`;
	if (outcome === 'refund') return `Bet refunded · +${payout} coins`;
	return `Bet lost · −${TRN_BET} coins`;
}

/** "Bet 20 on Alice". */
export function betButtonText(name: string): string {
	return `Bet ${TRN_BET} on ${name}`;
}

/** "1 bet" / "3 bets". */
export function betCountText(n: number): string {
	const k = Math.max(0, Math.floor(n));
	return `${k} bet${k === 1 ? '' : 's'}`;
}

/** "1 coin" / "8 coins". */
export function coinsText(n: number): string {
	return `${n} coin${n === 1 ? '' : 's'}`;
}

/** Tournament start line: "6 entrants · prize 16 coins". */
export function startText(entrants: number, prize = trnPrize(entrants)): string {
	return `${entrants} entrants · prize ${coinsText(prize)}`;
}

export function championText(name: string, self: boolean): string {
	return self ? 'You win the tournament!' : `${name} wins the tournament!`;
}

/** Banner after a duel round. */
export function roundEndText(winner: string | null, round: number, reason: 'kill' | 'time' | 'draw'): string {
	if (winner === null || reason === 'draw') return `Round ${round} drawn · replayed`;
	return `${winner} wins round ${round}${reason === 'time' ? ' on time' : ''}`;
}

/** Round-win pips of one side: `wins` filled of `of`. */
export function pips(wins: number, of: number): boolean[] {
	return Array.from({ length: Math.max(0, of) }, (_, i) => i < wins);
}

/** HP bar fraction 0..1. */
export function hpFrac(hp: number): number {
	return Number.isFinite(hp) ? Math.max(0, Math.min(1, hp / 100)) : 0;
}

/** The persistent line under the duel bar, or the banner when no duel shows. */
export function phaseLine(phase: TrnStateView['phase'] | 'solo', late: boolean, out: boolean): string | null {
	if (phase === 'solo') return 'Offline · a tournament needs a server and 2+ players';
	if (phase === 'waiting') return 'Waiting for players · a tournament needs 2+';
	if (late) return 'You are spectating · the next tournament starts soon';
	if (out) return 'Knocked out · watch and bet from the deck';
	return null;
}
