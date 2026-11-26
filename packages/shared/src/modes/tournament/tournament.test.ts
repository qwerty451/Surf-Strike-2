import { describe, expect, it } from 'vitest';
import type { TournamentMapInfo } from '../../maps/types.ts';
import { VIEW_HEIGHT } from '../../movement/api.ts';
import type { Vec3 } from '../../types.ts';
import { PLAYER_PARTS, rayPlayer, rayPlayerPart, type PlayerPart } from '../zombies/hitbox.ts';
import { bracketSize, byeMatches, createBracket, decide, matchAt, nextMatch, resolveBracket, bracketChampion } from './bracket.ts';
import { TRN_DAMAGE, trnDamage, trnHitsToKill, trnRegion } from './damage.ts';
import { TournamentGame, TRN_BET_STAKE, type TrnOut, type TrnPlayerInfo } from './game.ts';
import { TRN_BET_MIN_ENTRANTS, TRN_DECK_KNIFE_HITS, trnPrize, type TrnEvent } from './net.ts';

// ---------------------------------------------------------------------------
// Damage

describe('tournament damage', () => {
	it('sniper: one shot on head or torso, two on arms and legs', () => {
		for (const part of PLAYER_PARTS) {
			const r = trnRegion(part);
			expect(trnHitsToKill('sniper', part)).toBe(r === 'arm' || r === 'leg' ? 2 : 1);
		}
	});
	it('pistol: one headshot, four hits elsewhere', () => {
		for (const part of PLAYER_PARTS) expect(trnHitsToKill('pistol', part)).toBe(part === 'head' ? 1 : 4);
	});
	it('knife: two hits anywhere', () => {
		for (const part of PLAYER_PARTS) expect(trnHitsToKill('knife', part)).toBe(2);
	});
	it('regions', () => {
		const want: Record<string, PlayerPart[]> = {
			head: ['head'],
			torso: ['neck', 'chest', 'ribs', 'belly', 'hips'],
			arm: ['upperArmR', 'upperArmL', 'foreArmR', 'foreArmL', 'handR', 'handL'],
			leg: ['thighR', 'thighL', 'shinR', 'shinL', 'footR', 'footL']
		};
		for (const [region, parts] of Object.entries(want)) for (const p of parts) expect(trnRegion(p)).toBe(region);
		expect(Object.values(want).flat().sort()).toEqual([...PLAYER_PARTS].sort());
	});
	it('other weapons do nothing', () => {
		expect(trnDamage('lmg', 'head')).toBe(0);
		expect(trnDamage('claws', 'chest')).toBe(0);
		expect(TRN_DAMAGE.sniper.torso).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// Bracket

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }));
const seq = (seed = 1) => {
	let s = seed;
	return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
};

describe('tournament bracket', () => {
	for (let n = 2; n <= 9; n++) {
		it(`shape for ${n} entrants`, () => {
			const b = createBracket(people(n), seq(n));
			const size = bracketSize(n);
			expect(b.size).toBe(size);
			expect(b.matches.length).toBe(size - 1);
			expect(b.entrants.map((e) => e.id).sort((x, y) => x - y)).toEqual(people(n).map((p) => p.id));
			// Layout: round then index, and (r, i) at matchAt.
			for (const [k, m] of b.matches.entries()) expect(matchAt(size, m.round, m.index)).toBe(k);
			const first = b.matches.filter((m) => m.round === 0);
			expect(first.length).toBe(size / 2);
			// Byes only in round 0, never two in one match, spread over both halves.
			const byes = first.filter((m) => m.b === null);
			expect(byes.length).toBe(size - n);
			for (const m of first) expect(m.a).not.toBeNull();
			if (size >= 4) {
				const left = byes.filter((m) => m.index < size / 4).length;
				expect(Math.abs(left - (byes.length - left))).toBeLessThanOrEqual(1);
			}
			// Seeds are the round-0 slots.
			for (const e of b.entrants) {
				const m = first[e.seed >> 1]!;
				expect(e.seed % 2 === 0 ? m.a : m.b).toBe(e.id);
			}
			const decided = resolveBracket(b);
			expect(decided.length).toBe(size - n);
			for (const k of decided) expect(b.matches[k]!.result).toBe('bye');
			// Playing every next match in order reaches a champion.
			for (let m = nextMatch(b); m !== null; m = nextMatch(b)) {
				const match = b.matches[m]!;
				decide(b, m, match.a, 'rounds');
				resolveBracket(b);
			}
			expect(bracketChampion(b)).not.toBeNull();
		});
	}

	it('bye matches spread by bit reversal', () => {
		expect([...byeMatches(4, 3)]).toEqual([0, 2, 1]);
		expect([...byeMatches(8, 2)]).toEqual([0, 4]);
	});

	it('random seeding uses the source', () => {
		const a = createBracket(people(8), seq(1)).entrants.map((e) => e.id);
		const b = createBracket(people(8), seq(99)).entrants.map((e) => e.id);
		expect(a).not.toEqual(b);
	});

	it('walkover when the next opponent left, nobody when both did', () => {
		const b = createBracket(people(8), seq(3));
		const [m0, m1, m2] = b.matches;
		b.entrants.find((e) => e.id === m1!.a)!.left = true;
		expect(resolveBracket(b)).toEqual([1]);
		expect(b.matches[1]!.winner).toBe(m1!.b);
		expect(b.matches[1]!.result).toBe('forfeit');
		for (const id of [m2!.a, m2!.b]) b.entrants.find((e) => e.id === id)!.left = true;
		expect(resolveBracket(b)).toEqual([2]);
		expect(b.matches[2]!.winner).toBeNull();
		// m3's winner will get a walkover in the semi against nobody.
		decide(b, 3, b.matches[3]!.a, 'rounds');
		expect(resolveBracket(b)).toContain(matchAt(8, 1, 1));
		void m0;
	});
});

// ---------------------------------------------------------------------------
// Game

const INFO: TournamentMapInfo = {
	duelSpawns: [
		{ pos: { x: 0, y: -400, z: 0 }, yaw: 90 },
		{ pos: { x: 0, y: 400, z: 0 }, yaw: -90 }
	],
	arena: { min: { x: -800, y: -800, z: -50 }, max: { x: 800, y: 800, z: 400 } },
	deck: { min: { x: -800, y: -800, z: 500 }, max: { x: 800, y: 800, z: 700 } },
	deckSpawns: Array.from({ length: 8 }, (_, i) => ({ pos: { x: -700 + i * 200, y: 0, z: 512 }, yaw: 0 }))
};

const STEP = 1000 / 32;

function sim(n: number, opts: { bracketSecs?: number } = {}) {
	let now = 1_000_000;
	const g = new TournamentGame({ map: { tournament: INFO, spawn: INFO.deckSpawns[0]! }, world: null, now, rng: seq(7), startSecs: 1, bracketSecs: opts.bracketSecs ?? 1, nextSecs: 2 });
	const list: TrnPlayerInfo[] = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, accountId: 100 + i }));
	const log: TrnOut[] = [];
	const pos = new Map<number, Vec3 & { yaw: number }>();
	const take = (out: TrnOut[]) => {
		for (const o of out) {
			log.push(o);
			if (o.ev.e === 'spawn') pos.set(o.ev.id, { ...o.ev.pos, yaw: o.ev.yaw });
		}
	};
	const s = {
		g,
		list,
		log,
		get now() {
			return now;
		},
		events: <K extends TrnEvent['e']>(e: K) => log.map((o) => o.ev).filter((ev): ev is Extract<TrnEvent, { e: K }> => ev.e === e),
		step(secs: number) {
			for (let t = 0; t < secs * 1000 - 1e-6; t += STEP) {
				now += STEP;
				take(g.syncPlayers(list, now));
				for (const p of list) {
					const at = pos.get(p.id);
					if (at) g.setPos(p.id, { x: at.x, y: at.y, z: at.z, ducked: false, yaw: at.yaw, pitch: 0 });
				}
				take(g.update(now));
			}
		},
		until(done: () => boolean, max = 600) {
			for (let i = 0; i < max * 32 && !done(); i++) s.step(STEP / 1000);
			if (!done()) throw new Error('not reached');
		},
		leave(id: number) {
			const i = list.findIndex((p) => p.id === id);
			list.splice(i, 1);
			pos.delete(id);
			s.step(STEP / 1000);
		},
		place(id: number, at: Vec3 & { yaw: number }) {
			pos.set(id, at);
			g.setPos(id, { ...at, ducked: false, pitch: 0 });
		},
		/** Fire from the player's eye at a world point. */
		fire(id: number, weapon: 'sniper' | 'pistol' | 'knife', at: Vec3) {
			const p = pos.get(id)!;
			const o = { x: p.x, y: p.y, z: p.z + VIEW_HEIGHT };
			const d = { x: at.x - o.x, y: at.y - o.y, z: at.z - o.z };
			const l = Math.hypot(d.x, d.y, d.z);
			const r = g.fire(id, { weapon, origin: o, dir: { x: d.x / l, y: d.y / l, z: d.z / l } }, now);
			take(r.out);
			return r;
		},
		duelists(): [number, number] {
			const m = g.bracket!.matches[g.duel!.match]!;
			return [m.a!, m.b!];
		},
		live() {
			s.until(() => g.phase === 'duel' && g.duel?.sub === 'live');
		},
		/** The first duelist kills the other with the sniper (body shots until dead). */
		kill(): number {
			const [a, b] = s.duelists();
			const target = pos.get(b)!;
			for (let i = 0; i < 4 && g.hpOf(b) !== null && g.duel?.sub === 'live'; i++) {
				const r = s.fire(a, 'sniper', { x: target.x, y: target.y, z: target.z + 40 });
				expect(r.ok).toBe(true);
				if (g.duel?.sub === 'live') s.step(1.3);
			}
			return a;
		}
	};
	return s;
}

describe('tournament flow', () => {
	it('waits for 2 players', () => {
		const s = sim(1);
		s.step(3);
		expect(s.g.phase).toBe('waiting');
		s.list.push({ id: 2, name: 'P2', accountId: 101 });
		s.step(0.1);
		expect(s.g.phase).toBe('starting');
		s.step(1);
		expect(['bracket', 'duel']).toContain(s.g.phase);
		expect(s.events('start')[0]).toMatchObject({ tournament: 1, entrants: 2, prize: 1 });
	});

	it('players are put on the deck on join', () => {
		const s = sim(3);
		s.step(0.1);
		const spawns = s.events('spawn');
		expect(spawns.map((e) => e.id).sort()).toEqual([1, 2, 3]);
		for (const e of spawns) expect(e).toMatchObject({ role: 'spectator', freezeSecs: 0 });
	});

	it('a duel: freeze, kills, rounds, champion, next tournament', () => {
		const s = sim(2);
		s.until(() => s.g.phase === 'duel');
		const [a, b] = s.duelists();
		const spawns = s.events('spawn').filter((e) => e.role === 'duelist');
		expect(spawns.map((e) => e.freezeSecs)).toEqual([3, 3]);
		expect(s.events('duelStart')[0]).toMatchObject({ a, b });
		expect(s.g.view(s.now).duel).toMatchObject({ round: 1, hp: [100, 100] });
		// Frozen: no shots.
		expect(s.fire(a, 'sniper', { x: 0, y: 400, z: 40 }).reason).toBe('frozen');
		s.live();
		s.kill();
		expect(s.events('kill').at(-1)).toMatchObject({ by: a, target: b, weapon: 'sniper', deck: false });
		expect(s.events('roundEnd').at(-1)).toMatchObject({ round: 1, winner: a, reason: 'kill', wins: [1, 0] });
		s.live();
		expect(s.g.view(s.now).duel?.round).toBe(2);
		s.kill();
		expect(s.events('roundEnd').at(-1)).toMatchObject({ round: 2, winner: a, reason: 'kill', wins: [2, 0] });
		s.until(() => s.g.phase === 'ended');
		expect(s.events('duelEnd').at(-1)).toMatchObject({ winner: a, loser: b, result: 'rounds' });
		expect(s.events('champion')[0]).toMatchObject({ tournament: 1, id: a, entrants: 2, prize: 1 });
		expect(s.g.view(s.now).champion).toBe(a);
		// Both back on the deck.
		expect(s.events('spawn').slice(-2).map((e) => e.role)).toEqual(['spectator', 'spectator']);
		s.until(() => s.g.tournament === 2);
		expect(s.events('start').length).toBe(2);
	});

	it('a timeout goes to the duelist with more HP; equal HP replays the round', () => {
		const s = sim(2);
		s.until(() => s.g.phase === 'duel');
		s.live();
		s.step(90.1);
		expect(s.events('roundEnd').at(-1)).toMatchObject({ round: 1, winner: null, reason: 'draw', wins: [0, 0] });
		s.live();
		expect(s.g.view(s.now).duel?.round).toBe(1);
		const [a, b] = s.duelists();
		// A pistol body shot: 25.
		const t = { x: 0, y: 400, z: 40 };
		const r = s.fire(a, 'pistol', t);
		expect(r.reason).toBe('wrong weapon');
		s.g.selectWeapon(a, 'pistol', s.now);
		s.step(0.5);
		s.fire(a, 'pistol', t);
		const hit = s.events('hit').at(-1)!;
		expect(hit).toMatchObject({ by: a, target: b, dmg: trnDamage('pistol', hit.part) });
		s.step(91);
		expect(s.events('roundEnd').at(-1)).toMatchObject({ round: 1, winner: a, reason: 'time', wins: [1, 0] });
	});

	it('a duelist who leaves forfeits; the opponent advances', () => {
		const s = sim(2);
		s.until(() => s.g.phase === 'duel');
		const [a, b] = s.duelists();
		s.leave(b);
		expect(s.events('duelEnd').at(-1)).toMatchObject({ winner: a, loser: b, result: 'forfeit' });
		expect(s.g.phase).toBe('ended');
		// Nobody played a live round: no prize.
		expect(s.events('champion')[0]).toMatchObject({ id: a, entrants: 0, prize: 0 });
	});

	it('an entrant waiting for a later match who leaves gives a walkover', () => {
		const s = sim(4);
		s.until(() => s.g.phase === 'duel');
		expect(s.g.duel!.match).toBe(0);
		const waiting = s.g.bracket!.matches[1]!;
		const [stay, gone] = [waiting.a!, waiting.b!];
		s.leave(gone);
		expect(s.events('duelEnd').at(-1)).toMatchObject({ match: 1, winner: stay, loser: gone, result: 'forfeit' });
		expect(s.g.bracket!.entrants.find((e) => e.id === gone)).toMatchObject({ out: true, left: true });
		expect(s.g.phase).toBe('duel');
	});

	it('the last entrant left is the champion', () => {
		const s = sim(4);
		s.until(() => s.g.phase === 'bracket');
		const [m0, m1] = s.g.bracket!.matches;
		for (const id of [m1!.a!, m1!.b!, m0!.b!]) s.leave(id);
		expect(s.g.phase).toBe('ended');
		expect(s.g.champion).toBe(m0!.a);
	});

	it('the prize counts only entrants who played a live round', () => {
		const s = sim(5);
		s.until(() => s.g.phase === 'bracket');
		// 5 entrants in 8 slots: 3 byes. Everyone else leaves but the first match.
		const b = s.g.bracket!;
		const first = b.matches.find((m) => m.round === 0 && m.b !== null)!;
		s.until(() => s.g.phase === 'duel');
		expect(s.g.duel!.match).toBe(b.matches.indexOf(first));
		for (const e of b.entrants) if (e.id !== first.a && e.id !== first.b) s.leave(e.id);
		s.live();
		s.kill();
		s.live();
		s.kill();
		s.until(() => s.g.phase === 'ended');
		expect(s.events('start')[0]).toMatchObject({ entrants: 5, prize: trnPrize(5) });
		expect(s.events('champion')[0]).toMatchObject({ entrants: 2, prize: trnPrize(2) });
	});

	it('late joiners watch until the next tournament, then play', () => {
		const s = sim(2);
		s.until(() => s.g.phase === 'duel');
		s.list.push({ id: 3, name: 'P3', accountId: 103 });
		s.step(0.1);
		expect(s.g.isEntrant(3)).toBe(false);
		expect(s.g.roleOf(3)).toBe('spectator');
		s.live();
		s.kill();
		s.live();
		s.kill();
		s.until(() => s.g.tournament === 2);
		expect(s.g.isEntrant(3)).toBe(true);
		expect(s.events('start').at(-1)).toMatchObject({ entrants: 3 });
	});
});

describe('tournament targets', () => {
	it('spectators only hurt spectators, with the knife; three hits drop one', () => {
		const s = sim(4);
		s.until(() => s.g.phase === 'duel');
		s.live();
		const [a, b] = s.duelists();
		const [c, d] = s.list.map((p) => p.id).filter((id) => id !== a && id !== b);
		expect(s.g.roleOf(c!)).toBe('spectator');
		// Spectators carry the knife only.
		expect(s.fire(c!, 'sniper', { x: 0, y: 0, z: 0 }).reason).toBe('knife only');
		expect(s.g.selectWeapon(c!, 'sniper', s.now)).toEqual([]);
		// A spectator next to a duelist cannot knife them.
		s.place(c!, { x: 0, y: 340, z: 0, yaw: 90 });
		const hits = s.events('hit').length;
		expect(s.fire(c!, 'knife', { x: 0, y: 400, z: 40 }).ok).toBe(true);
		expect(s.events('hit').length).toBe(hits);
		// But another spectator, on the deck.
		s.place(c!, { x: 0, y: 0, z: 512, yaw: 0 });
		s.place(d!, { x: 40, y: 0, z: 512, yaw: 180 });
		s.step(0.5);
		s.place(d!, { x: 40, y: 0, z: 512, yaw: 180 });
		s.place(c!, { x: 0, y: 0, z: 512, yaw: 0 });
		for (let i = 0; i < TRN_DECK_KNIFE_HITS; i++) {
			expect(s.fire(c!, 'knife', { x: 40, y: 0, z: 552 }).ok).toBe(true);
			s.step(0.5);
			s.place(d!, { x: 40, y: 0, z: 512, yaw: 180 });
			s.place(c!, { x: 0, y: 0, z: 512, yaw: 0 });
		}
		const deckHits = s.events('hit').filter((h) => h.target === d);
		expect(deckHits.map((h) => h.hp)).toEqual([66, 32, 0]);
		expect(s.events('kill').at(-1)).toMatchObject({ by: c, target: d, deck: true, weapon: 'knife' });
		expect(s.events('spawn').at(-1)).toMatchObject({ id: d, role: 'spectator', freezeSecs: 0 });
		expect(s.g.phase).toBe('duel');
	});

	it('bullets never hit spectators', () => {
		const s = sim(3);
		s.until(() => s.g.phase === 'duel');
		s.live();
		const [a, b] = s.duelists();
		const c = s.list.map((p) => p.id).find((id) => id !== a && id !== b)!;
		// The spectator stands right in the line of fire, in front of the other duelist.
		s.place(c, { x: 0, y: 0, z: 0, yaw: -90 });
		const before = s.events('hit').length;
		s.fire(a, 'sniper', { x: 0, y: 0, z: 40 });
		const after = s.events('hit').slice(before);
		expect(after.every((h) => h.target === b)).toBe(true);
	});

	it('a spectator in the arena is put back on the deck', () => {
		const s = sim(3);
		s.until(() => s.g.phase === 'duel');
		const [a, b] = s.duelists();
		const c = s.list.map((p) => p.id).find((id) => id !== a && id !== b)!;
		s.step(1);
		const n = s.events('spawn').filter((e) => e.id === c).length;
		s.place(c, { x: 100, y: 0, z: 0, yaw: 0 });
		s.step(0.1);
		expect(s.events('spawn').filter((e) => e.id === c).length).toBe(n + 1);
	});
});

describe('tournament bets', () => {
	function bettingSim(n = 4) {
		const s = sim(n, { bracketSecs: 6 });
		s.until(() => s.g.phase === 'bracket');
		const m = s.g.current!;
		const match = s.g.bracket!.matches[m]!;
		const others = s.list.filter((p) => p.id !== match.a && p.id !== match.b);
		return { s, m, match, others };
	}

	it('needs a bracket of 4', () => {
		const s = sim(3, { bracketSecs: 6 });
		s.until(() => s.g.phase === 'bracket');
		expect(TRN_BET_MIN_ENTRANTS).toBe(4);
		expect(s.g.betCheck({ id: 3, accountId: 102 }, 1)).toMatchObject({ ok: false, reason: 'small' });
		expect(s.g.view(s.now).bets).toBeNull();
	});

	it('refusals', () => {
		const { s, m, match, others } = bettingSim();
		const o = others[0]!;
		expect(s.g.betCheck({ id: o.id, accountId: null }, match.a)).toMatchObject({ ok: false, reason: 'guest' });
		expect(s.g.betCheck({ id: match.a!, accountId: 100 + match.a! - 1 }, match.b)).toMatchObject({ ok: false, reason: 'duelist' });
		// Another tab of a duelist's account.
		expect(s.g.betCheck({ id: 99, accountId: 100 + match.a! - 1 }, match.b)).toMatchObject({ ok: false, reason: 'duelist' });
		expect(s.g.betCheck({ id: o.id, accountId: o.accountId }, o.id)).toMatchObject({ ok: false, reason: 'pick' });
		expect(s.g.betCheck({ id: o.id, accountId: o.accountId }, match.a)).toEqual({ ok: true, match: m });
		s.g.placeBet(o.accountId!, m, match.a!, 1, TRN_BET_STAKE);
		expect(s.g.betCheck({ id: o.id, accountId: o.accountId }, match.b)).toMatchObject({ ok: false, reason: 'twice' });
		expect(s.g.view(s.now).bets).toEqual({ match: m, open: true, count: [1, 0] });
		// Open through round 1's freeze, closed once it is live.
		s.until(() => s.g.phase === 'duel');
		expect(s.g.betCheck({ id: others[1]!.id, accountId: others[1]!.accountId }, match.b).ok).toBe(true);
		s.live();
		expect(s.g.betCheck({ id: others[1]!.id, accountId: others[1]!.accountId }, match.b)).toMatchObject({ ok: false, reason: 'closed' });
		expect(s.g.view(s.now).bets?.open).toBe(false);
	});

	it('a win pays 2×, a loss nothing', () => {
		const { s, m, match, others } = bettingSim();
		s.g.placeBet(others[0]!.accountId!, m, match.a!, 11, TRN_BET_STAKE);
		s.g.placeBet(others[1]!.accountId!, m, match.b!, 12, TRN_BET_STAKE);
		s.until(() => s.g.phase === 'duel');
		s.live();
		const winner = s.kill();
		s.live();
		s.kill();
		s.until(() => s.g.phase === 'bracket');
		const set = s.g.takeSettlements();
		const won = set.find((x) => x.pick === winner)!;
		const lost = set.find((x) => x.pick !== winner)!;
		expect(won).toMatchObject({ outcome: 'won', payout: TRN_BET_STAKE * 2, match: m });
		expect(lost).toMatchObject({ outcome: 'lost', payout: 0 });
		expect(s.g.openBets()).toBe(0);
	});

	it('a forfeit or a cancel refunds', () => {
		const { s, m, match, others } = bettingSim();
		s.g.placeBet(others[0]!.accountId!, m, match.a!, 21, TRN_BET_STAKE);
		s.leave(match.b!);
		expect(s.g.takeSettlements()).toEqual([expect.objectContaining({ ticket: 21, outcome: 'refund', payout: TRN_BET_STAKE })]);
		const m2 = s.g.current!;
		const next = s.g.bracket!.matches[m2]!;
		const bettor = s.list.find((p) => p.id !== next.a && p.id !== next.b)!;
		s.g.placeBet(bettor.accountId!, m2, next.a!, 22, TRN_BET_STAKE);
		s.g.cancel(s.now);
		expect(s.g.takeSettlements()).toEqual([expect.objectContaining({ ticket: 22, outcome: 'refund', payout: TRN_BET_STAKE })]);
		expect(s.g.phase).toBe('starting');
	});
});

describe('rayPlayerPart', () => {
	it('agrees with rayPlayer and names the part', () => {
		const pose = { x: 0, y: 0, z: 0, yaw: 180, ducked: false, hunched: false, held: 'sniper' as const, pitch: 0 };
		let head = 0;
		let limbs = 0;
		for (let z = 0; z <= 76; z += 2) {
			for (let y = -20; y <= 20; y += 4) {
				const o = { x: 200, y, z };
				const d = { x: -1, y: 0, z: 0 };
				const a = rayPlayer(o, d, pose, 1000);
				const b = rayPlayerPart(o, d, pose, 1000);
				expect(b === null).toBe(a === null);
				if (!a || !b) continue;
				expect(b.t).toBeCloseTo(a.t, 9);
				expect(b.head).toBe(a.head);
				expect(b.part === 'head').toBe(a.head);
				if (b.head) head++;
				if (trnRegion(b.part) === 'arm' || trnRegion(b.part) === 'leg') limbs++;
			}
		}
		expect(head).toBeGreaterThan(0);
		expect(limbs).toBeGreaterThan(0);
	});
});
