/**
 * Tournament HUD mock (`?mockhud&mode=tournament&scene=<scene>`, docs/ui.md#hud-mock):
 * a made-up bracket (`&entrants=2..16`, default 8) and the HUD view of each
 * scene, so the duel bar, banners, bet panel and the bracket tree can be
 * checked without a server. Hold B (or `&bracket=1`) for the tree during a duel.
 */
import { trnPrize, trnRoundLabel, type TrnBracketView, type TrnMatchView, type TrnPhase, type TrnStateView } from '@surf/shared';
import type { TournamentView } from '#lib/game/contract.js';
import { bracketRounds, currentMatch } from '#lib/ui/bracket-layout.js';

export const TRN_MOCK_SCENES = ['waiting', 'starting', 'freeze', 'duel', 'scoped', 'watch', 'bet', 'betwon', 'bracket', 'ended', 'late', 'out', 'solo'] as const;
export type TrnMockScene = (typeof TRN_MOCK_SCENES)[number];

export function isTrnMockScene(s: string | null): s is TrnMockScene {
	return TRN_MOCK_SCENES.includes(s as TrnMockScene);
}

const NAMES = ['you', 'glidepath', 'cirrus', 'boreal', 'WWWWWWWWWWWWWWWWWWWWWWWW', 'nimbus', 'Guest-4f1a', 'tim', 'aurora', 'kestrel', 'vapor', 'quill', 'sable', 'onyx', 'drift', 'ember'];
/** Player id of "you" in the mock. */
export const TRN_MOCK_SELF = 1;

/**
 * A bracket of `n` entrants (ids 1..n, "you" first) with the first `played`
 * matches decided, round by round. Byes go to the first matches' b side.
 */
export function mockBracket(n: number, played: number): TrnBracketView {
	const count = Math.max(2, Math.min(16, Math.floor(n)));
	const size = 2 ** bracketRounds(count);
	const entrants = Array.from({ length: count }, (_, i) => ({ id: i + 1, name: NAMES[i] ?? `player ${i + 1}`, seed: 0, out: false, left: false }));
	const half = size / 2;
	const byes = size - count;
	const matches: TrnMatchView[] = [];
	let next = 0;
	for (let i = 0; i < half; i++) {
		const a = entrants[next++]!;
		a.seed = 2 * i;
		let b: number | null = null;
		if (i >= byes) {
			const e = entrants[next++]!;
			e.seed = 2 * i + 1;
			b = e.id;
		}
		matches.push({ round: 0, index: i, a: a.id, b, winner: b === null ? a.id : null, wins: [0, 0], result: b === null ? 'bye' : null });
	}
	const rounds = bracketRounds(size);
	for (let r = 1; r < rounds; r++) {
		for (let i = 0; i < size / 2 ** (r + 1); i++) matches.push({ round: r, index: i, a: null, b: null, winner: null, wins: [0, 0], result: null });
	}
	const find = (r: number, i: number) => matches.find((m) => m.round === r && m.index === i)!;
	const advance = (m: TrnMatchView) => {
		if (m.winner === null || m.round + 1 >= rounds) return;
		const p = find(m.round + 1, Math.floor(m.index / 2));
		if (m.index % 2 === 0) p.a = m.winner;
		else p.b = m.winner;
	};
	for (const m of matches) if (m.result === 'bye') advance(m);
	let done = 0;
	for (const m of matches) {
		if (m.result === 'bye' || m.a === null || m.b === null) continue;
		if (done >= played) break;
		done++;
		// "you" keeps winning; otherwise a mix of 2-0, 2-1 and one forfeit.
		const aWins = m.a === TRN_MOCK_SELF || (m.b !== TRN_MOCK_SELF && (m.round + m.index) % 3 !== 1);
		m.winner = aWins ? m.a : m.b;
		const forfeit = m.round === 0 && m.index === half - 1 && count > 4;
		m.result = forfeit ? 'forfeit' : 'rounds';
		m.wins = forfeit ? [aWins ? 1 : 0, aWins ? 0 : 1] : aWins ? [2, (m.index % 2) as 0 | 1] : [m.index % 2, 2];
		const loser = entrants.find((e) => e.id === (aWins ? m.b : m.a))!;
		loser.out = true;
		if (forfeit) loser.left = true;
		advance(m);
	}
	return { size, entrants, matches };
}

function state(phase: TrnPhase, n: number, played: number, p: Partial<TrnStateView> = {}): TrnStateView {
	const bracket = mockBracket(n, played);
	const s: TrnStateView = { phase, tournament: 3, round: 0, timeLeft: 40, bracket, duel: null, bets: null, champion: null, ...p };
	const cur = currentMatch({ ...s, phase: phase === 'duel' ? 'bracket' : phase });
	if (cur !== null && s.round === 0) s.round = (bracket.matches[cur]?.round ?? 0) + 1;
	return s;
}

/** The match "you" play next (or the first open one). */
function myMatch(b: TrnBracketView): number {
	const i = b.matches.findIndex((m) => m.winner === null && m.a !== null && m.b !== null && (m.a === TRN_MOCK_SELF || m.b === TRN_MOCK_SELF));
	return i >= 0 ? i : b.matches.findIndex((m) => m.winner === null && m.a !== null && m.b !== null);
}

/** Someone else's next match (for the watching scenes). */
function otherMatch(b: TrnBracketView): number {
	const i = b.matches.findIndex((m) => m.winner === null && m.a !== null && m.b !== null && m.a !== TRN_MOCK_SELF && m.b !== TRN_MOCK_SELF);
	return i >= 0 ? i : myMatch(b);
}

const name = (s: TrnStateView, id: number) => s.bracket?.entrants.find((e) => e.id === id)?.name ?? `#${id}`;

/** The HUD view of a scene at `now` (performance.now()). */
export function mockTournamentView(scene: TrnMockScene, now: number, entrants = 8): TournamentView {
	const n = Math.max(2, Math.min(16, Math.floor(entrants)));
	const half = Math.max(1, Math.floor(n / 2));
	let s: TrnStateView;
	let flash: TournamentView['flash'] = null;
	let bet: TournamentView['bet'] = null;
	let knifeOnly = true;
	switch (scene) {
		case 'waiting':
		case 'solo':
			s = { phase: 'waiting', tournament: 0, round: 0, timeLeft: 0, bracket: null, duel: null, bets: null, champion: null };
			break;
		case 'starting':
			s = state('starting', n, 0, { timeLeft: 8 });
			flash = { text: 'Tournament starting', sub: `${n} entrants · prize ${trnPrize(n)} coins`, at: now - 400, tone: 'info' };
			break;
		case 'freeze':
		case 'duel':
		case 'scoped': {
			s = state('duel', n, Math.max(0, half - 1));
			const m = myMatch(s.bracket!);
			const mm = s.bracket!.matches[m]!;
			mm.wins = scene === 'freeze' ? [0, 0] : [1, 1];
			s.duel = { match: m, round: scene === 'freeze' ? 1 : 3, hp: scene === 'freeze' ? [100, 100] : [62, 18], freeze: scene === 'freeze' ? 3 : 0 };
			s.timeLeft = scene === 'freeze' ? 90 : 41;
			s.round = mm.round + 1;
			knifeOnly = false;
			flash =
				scene === 'freeze'
					? { text: `You vs ${name(s, mm.a === TRN_MOCK_SELF ? mm.b! : mm.a!)}`, sub: trnRoundLabel(mm.round + 1, s.bracket!.size), at: now - 300, tone: 'duel' }
					: { text: `${name(s, mm.b!)} wins round 2`, sub: '1 – 1', at: now - 500, tone: 'lose' };
			break;
		}
		case 'watch':
		case 'bet':
		case 'betwon':
		case 'late':
		case 'out': {
			s = state('duel', n, Math.max(0, half - 1));
			const m = otherMatch(s.bracket!);
			const mm = s.bracket!.matches[m]!;
			const live = scene === 'late' || scene === 'out';
			s.duel = { match: m, round: live ? 2 : 1, hp: live ? [100, 45] : [100, 100], freeze: live ? 0 : 4 };
			s.round = mm.round + 1;
			s.timeLeft = live ? 63 : 90;
			if (scene === 'out') s.bracket!.entrants.find((e) => e.id === TRN_MOCK_SELF)!.out = true;
			if (n >= 4) {
				s.bets = { match: m, open: !live, count: [3, 5] };
				const a = { id: mm.a!, name: name(s, mm.a!), count: 3 };
				const b = { id: mm.b!, name: name(s, mm.b!), count: 5 };
				bet = {
					match: m,
					open: !live,
					a,
					b,
					canBet: scene === 'watch',
					mine: scene === 'bet' || scene === 'betwon' ? { pick: b.id, name: b.name } : null,
					note:
						scene === 'bet'
							? { text: `Your bet: 20 on ${b.name}`, tone: 'ok', at: now - 200 }
							: scene === 'betwon'
								? { text: 'Bet won · +40 coins', tone: 'won', at: now - 200 }
								: null
				};
			}
			if (scene === 'betwon') s.bets = { match: m, open: false, count: [3, 5] };
			if (scene === 'betwon' && bet) bet.open = false;
			break;
		}
		case 'bracket': {
			s = state('bracket', n, half, { timeLeft: 6 });
			const m = otherMatch(s.bracket!);
			if (n >= 4) {
				s.bets = { match: m, open: true, count: [1, 0] };
				const mm = s.bracket!.matches[m]!;
				bet = { match: m, open: true, a: { id: mm.a!, name: name(s, mm.a!), count: 1 }, b: { id: mm.b!, name: name(s, mm.b!), count: 0 }, canBet: true, mine: null, note: null };
			}
			break;
		}
		case 'ended': {
			s = state('ended', n, 99, { timeLeft: 12 });
			s.champion = TRN_MOCK_SELF;
			flash = { text: 'You win the tournament!', sub: `Prize ${trnPrize(n)} coins · ${n} entrants`, at: now - 300, tone: 'gold' };
			break;
		}
	}
	const online = scene !== 'solo';
	const duel = s.duel;
	const match = duel ? s.bracket?.matches[duel.match] : null;
	const sniper = !knifeOnly;
	const scoped = scene === 'scoped';
	const next =
		s.phase === 'bracket' && s.bets
			? (() => {
					const m = s.bracket!.matches[s.bets!.match]!;
					return { a: name(s, m.a!), b: name(s, m.b!) };
				})()
			: null;
	return {
		phase: online ? s.phase : 'solo',
		tournament: s.tournament,
		roundLabel: s.round > 0 && s.bracket ? trnRoundLabel(s.round, s.bracket.size) : '',
		endsAt: s.phase === 'waiting' || !online ? 0 : now + s.timeLeft * 1000,
		role: sniper ? 'duelist' : 'spectator',
		late: scene === 'late',
		out: scene === 'out',
		entrants: s.bracket?.entrants.length ?? 0,
		prize: trnPrize(s.bracket?.entrants.length ?? 0),
		duel:
			duel && match && match.a !== null && match.b !== null
				? {
						a: { id: match.a, name: name(s, match.a), hp: duel.hp[0], wins: match.wins[0], self: match.a === TRN_MOCK_SELF },
						b: { id: match.b, name: name(s, match.b), hp: duel.hp[1], wins: match.wins[1], self: match.b === TRN_MOCK_SELF },
						round: duel.round,
						freezeUntil: duel.freeze > 0 ? now + duel.freeze * 1000 : 0
					}
				: null,
		next,
		champion: s.phase === 'ended' && s.champion !== null ? { id: s.champion, name: name(s, s.champion), self: s.champion === TRN_MOCK_SELF } : null,
		flash,
		showBracket: online && (s.phase === 'bracket' || s.phase === 'ended'),
		state: online ? s : null,
		selfId: TRN_MOCK_SELF,
		bet,
		betResult: scene === 'betwon' ? { text: 'Bet won · +40 coins', tone: 'won', at: now - 200 } : null,
		alive: true,
		knifeOnly,
		weapon: sniper ? 'sniper' : 'knife',
		weaponLabel: sniper ? 'Sniper rifle' : 'Knife',
		mag: sniper ? 3 : 0,
		magSize: sniper ? 5 : 0,
		reserve: sniper ? 10 : 0,
		reloadEndsAt: 0,
		reloadMs: 3000,
		hitMarker: scene === 'duel' ? { at: now - 60, head: true, kill: false } : null,
		hurtAt: scene === 'duel' ? now - 150 : 0,
		killFeed:
			scene === 'duel' || scene === 'watch'
				? [
						{ id: 1, text: 'cirrus · Sniper rifle · headshot › boreal', head: true, mine: false, at: now - 2000 },
						{ id: 2, text: 'nimbus · Knife › Guest-4f1a · deck', head: false, mine: false, at: now - 900 }
					]
				: [],
		scoped,
		scopeT: scoped ? 1 : 0,
		aimT: scoped ? 1 : 0,
		spectating: false
	};
}
