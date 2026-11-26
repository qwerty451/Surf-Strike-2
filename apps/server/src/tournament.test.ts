/** Tournament (docs/modes.md#tournament, docs/economy.md#tournament): the real mode and economy in a simulated lobby. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MapDef, ServerMessage, TrnEvent, Vec3 } from '@surf/shared';
import { BACKSTOP, pts, Status, TRN_BET, TRN_BET_STAKE, trnPrize, VIEW_HEIGHT } from '@surf/shared';
import { Economy } from './economy.ts';
import type { SimPlayer } from './economy-helpers.ts';
import { TournamentMode } from './modes/tournament.ts';
import { modeWorld } from './payout-helpers.ts';
import { testMap } from './test-helpers.ts';

function trnMap(): MapDef {
	return {
		...testMap('trn_test', 'Tournament Test'),
		kind: 'tournament',
		layout: 'open',
		spawns: [],
		zones: [],
		tournament: {
			duelSpawns: [
				{ pos: { x: 0, y: -400, z: 0 }, yaw: 90 },
				{ pos: { x: 0, y: 400, z: 0 }, yaw: -90 }
			],
			arena: { min: { x: -800, y: -800, z: -50 }, max: { x: 800, y: 800, z: 400 } },
			deck: { min: { x: -800, y: -800, z: 500 }, max: { x: 800, y: 800, z: 700 } },
			deckSpawns: Array.from({ length: 8 }, (_, i) => ({ pos: { x: -700 + i * 200, y: 0, z: 512 }, yaw: 0 }))
		}
	};
}

type Ev<K extends TrnEvent['e']> = Extract<TrnEvent, { e: K }>;

function lobby(n: number) {
	const map = trnMap();
	const s = modeWorld(map, (host) => new TournamentMode(host, { startSecs: 1, bracketSecs: 2, nextSecs: 2 }));
	const got = new Map<number, ServerMessage[]>();
	const at = new Map<number, Vec3 & { yaw: number }>();
	const byId = new Map<number, SimPlayer>();
	s.onBroadcast = (msg) => {
		for (const p of s.w.players) {
			const list = got.get(p.id) ?? [];
			list.push(msg);
			got.set(p.id, list);
		}
	};
	s.onSend = (id, msg) => {
		const list = got.get(id) ?? [];
		list.push(msg);
		got.set(id, list);
		if (msg.type !== 'trn' || msg.ev.e !== 'spawn' || msg.ev.id !== id) return;
		const p = byId.get(id);
		at.set(id, { ...msg.ev.pos, yaw: msg.ev.yaw });
		if (p) s.put(p, msg.ev.pos.x, msg.ev.pos.y, msg.ev.pos.z, msg.ev.yaw);
	};
	const mode = s.mode;
	const ps = s.w.join(n);
	for (const p of ps) {
		byId.set(p.id, p);
		s.enter(p, 0, 0);
	}
	s.run(0.1);
	const t = {
		s,
		mode,
		g: mode.game,
		ps,
		at,
		byId,
		trn<K extends TrnEvent['e']>(p: SimPlayer, e: K): Ev<K>[] {
			return (got.get(p.id) ?? []).flatMap((m) => (m.type === 'trn' && m.ev.e === e ? [m.ev as Ev<K>] : []));
		},
		balance(p: SimPlayer): number {
			return s.w.db.accountStats(p.accountId!).pointsBalance;
		},
		give(p: SimPlayer, coins: number) {
			s.w.economy.adjust(p.accountId!, pts(coins));
		},
		until(done: () => boolean, max = 900) {
			s.runUntil(done, max);
		},
		duelists(): [SimPlayer, SimPlayer] {
			const m = t.g.bracket!.matches[t.g.duel!.match]!;
			return [byId.get(m.a!)!, byId.get(m.b!)!];
		},
		fire(p: SimPlayer, weapon: 'sniper' | 'pistol' | 'knife', target: Vec3) {
			const o = at.get(p.id)!;
			const origin = { x: o.x, y: o.y, z: o.z + VIEW_HEIGHT };
			const d = { x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z };
			const l = Math.hypot(d.x, d.y, d.z);
			s.send(p, { type: 'fire', weapon, origin, dir: { x: d.x / l, y: d.y / l, z: d.z / l }, tick: 0x7fffffff });
		},
		/** Play the live duel: the duelist on side a kills the other until the duel is over. Returns the winner. */
		playDuel(): SimPlayer {
			t.until(() => t.g.phase === 'duel');
			const [a, b] = t.duelists();
			const match = t.g.duel!.match;
			while (t.g.phase === 'duel' && t.g.duel?.match === match) {
				if (t.g.duel.sub !== 'live') {
					s.run(0.1);
					continue;
				}
				const tg = at.get(b.id)!;
				t.fire(a, 'sniper', { x: tg.x, y: tg.y, z: tg.z + 40 });
				s.run(1.3);
			}
			return a;
		},
		bet(p: SimPlayer, pick: number | null) {
			s.send(p, { type: 'trnBet', pick: pick as number });
			return t.trn(p, 'bet').at(-1)!;
		}
	};
	return t;
}

describe('tournament server: brackets', () => {
	for (let n = 2; n <= 9; n++) {
		it(`${n} entrants play to a champion`, () => {
			const t = lobby(n);
			t.until(() => t.g.phase === 'bracket' || t.g.phase === 'duel');
			const b = t.g.bracket!;
			assert.equal(b.entrants.length, n);
			assert.equal(b.matches.filter((m) => m.round === 0 && m.b === null).length, b.size - n);
			let duels = 0;
			while (t.g.phase !== 'ended') {
				t.playDuel();
				duels++;
				assert.ok(duels < n, 'one duel per elimination');
			}
			assert.equal(duels, n - 1);
			const champ = t.trn(t.ps[0]!, 'champion')[0]!;
			assert.equal(champ.entrants, n);
			assert.equal(champ.prize, trnPrize(n));
			assert.equal(t.s.paid(t.byId.get(champ.id)!, 'trnChampion'), pts(trnPrize(n)));
		});
	}
});

describe('tournament server: coins', () => {
	it('a duel kill pays 1 coin to the killer, nothing else', () => {
		const t = lobby(2);
		t.until(() => t.g.phase === 'duel');
		const [a, b] = t.duelists();
		t.until(() => t.g.duel?.sub === 'live');
		const tg = t.at.get(b.id)!;
		t.fire(a, 'sniper', { x: tg.x, y: tg.y, z: tg.z + 40 });
		t.s.run(1.3);
		if (t.g.duel?.sub === 'live') t.fire(a, 'sniper', { x: tg.x, y: tg.y, z: tg.z + 40 });
		t.s.run(0.1);
		assert.equal(t.trn(a, 'kill').length, 1);
		assert.equal(t.s.paid(a, 'trnKill'), pts(1));
		assert.equal(t.s.paid(b, 'trnKill'), 0);
	});

	it('deck kills pay nothing', () => {
		const t = lobby(4);
		t.until(() => t.g.phase === 'duel');
		const [a, b] = t.duelists();
		const [c, d] = t.ps.filter((p) => p !== a && p !== b) as [SimPlayer, SimPlayer];
		for (let i = 0; i < 3; i++) {
			t.s.put(c, 0, 0, 512, 0);
			t.at.set(c.id, { x: 0, y: 0, z: 512, yaw: 0 });
			t.s.put(d, 40, 0, 512, 180);
			// The target stood there long enough for the swinger's (rewound) view.
			t.s.run(0.3);
			const l = Math.hypot(40, VIEW_HEIGHT - 40);
			t.s.send(c, { type: 'knife', origin: { x: 0, y: 0, z: 512 + VIEW_HEIGHT }, dir: { x: 40 / l, y: 0, z: (40 - VIEW_HEIGHT) / l } });
			t.s.run(0.2);
		}
		const kill = t.trn(c, 'kill').at(-1);
		assert.ok(kill?.deck, 'deck kill');
		assert.equal(t.s.paid(c, 'trnKill'), 0);
	});

	it('the prize counts only entrants who played a live round, and is exempt from the hourly limit', () => {
		const t = lobby(4);
		t.until(() => t.g.phase === 'duel');
		const [a, b] = t.duelists();
		// The other two leave without playing: walkovers.
		for (const p of t.ps) if (p !== a && p !== b) t.s.leave(p);
		// The champion has used up the hourly limit already.
		t.s.w.db.payPoints({
			accountId: a.accountId!,
			at: t.s.w.now,
			mode: 'tag',
			map: 'x',
			reason: 'tagTag',
			label: 'Tag',
			base: BACKSTOP.points,
			counted: BACKSTOP.points,
			mult: 10,
			amount: BACKSTOP.points
		});
		t.playDuel();
		t.until(() => t.g.phase === 'ended');
		const champ = t.trn(a, 'champion')[0]!;
		assert.equal(champ.id, a.id);
		assert.equal(champ.entrants, 2);
		assert.equal(champ.prize, trnPrize(2));
		assert.equal(t.s.paid(a, 'trnChampion'), pts(trnPrize(2)));
		// Kills are counted: the limit refused them.
		assert.equal(t.s.paid(a, 'trnKill'), 0);
		const row = t.s.w.db.db.prepare(`SELECT counted FROM point_log WHERE account_id = ? AND reason = 'trnChampion'`).get(a.accountId) as { counted: number };
		assert.equal(row.counted, 0);
	});

	it('a walkover champion without a live round gets no prize', () => {
		const t = lobby(2);
		t.until(() => t.g.phase === 'duel');
		const [a, b] = t.duelists();
		t.s.leave(b);
		t.s.run(0.1);
		assert.equal(t.trn(a, 'duelEnd').at(-1)?.result, 'forfeit');
		assert.equal(t.trn(a, 'champion')[0]?.prize, 0);
		assert.equal(t.s.paid(a, 'trnChampion'), 0);
	});
});

describe('tournament server: bets', () => {
	function betting(n = 5) {
		const t = lobby(n);
		t.until(() => t.g.phase === 'bracket');
		const m = t.g.current!;
		const match = t.g.bracket!.matches[m]!;
		const others = t.ps.filter((p) => p.id !== match.a && p.id !== match.b);
		for (const p of t.ps) t.give(p, 100);
		return { t, m, match, others };
	}

	it('takes the stake at once and pays 2× on a win, nothing on a loss', () => {
		const { t, m, match, others } = betting();
		const [x, y] = others as [SimPlayer, SimPlayer];
		const before = t.balance(x);
		assert.deepEqual(t.bet(x, match.a!), { e: 'bet', ok: true, match: t.g.current!, pick: match.a });
		assert.equal(t.balance(x), before - TRN_BET_STAKE);
		assert.equal(t.bet(y, match.b!).ok, true);
		assert.equal(t.s.w.db.openTrnBetCount(), 2);
		const winner = t.playDuel();
		const [wonBy, lostBy] = winner.id === match.a ? [x, y] : [y, x];
		assert.deepEqual(t.trn(wonBy, 'betResult').at(-1), { e: 'betResult', match: m, outcome: 'won', payout: TRN_BET * 2 });
		assert.deepEqual(t.trn(lostBy, 'betResult').at(-1), { e: 'betResult', match: m, outcome: 'lost', payout: 0 });
		assert.equal(t.balance(wonBy), before + TRN_BET_STAKE);
		assert.equal(t.balance(lostBy), before - TRN_BET_STAKE);
		assert.equal(t.s.w.db.openTrnBetCount(), 0);
		// Casino path: no points, no point log, not in casino_stats; in the Coins view.
		const logged = t.s.w.db.db.prepare(`SELECT COUNT(*) AS n FROM point_log WHERE reason LIKE 'trnBet%'`).get() as { n: number };
		assert.equal(logged.n, 0);
		assert.equal(t.s.w.db.casinoNet(wonBy.accountId!), 0);
		const recent = t.s.w.db.recentMoney(wonBy.accountId!, 5).map((r) => r.label);
		assert.ok(recent.includes('Tournament bet won') && recent.includes('Tournament bet'));
	});

	it('settles for a bettor who disconnected', () => {
		const { t, match, others } = betting();
		const x = others[0]!;
		const before = t.balance(x);
		t.bet(x, match.a!);
		t.s.leave(x);
		const winner = t.playDuel();
		assert.equal(t.balance(x), winner.id === match.a ? before + TRN_BET_STAKE : before - TRN_BET_STAKE);
	});

	it('refunds a forfeit and a cancelled match', () => {
		const { t, match, others } = betting();
		const x = others[0]!;
		const before = t.balance(x);
		t.bet(x, match.a!);
		t.s.leave(t.byId.get(match.b!)!);
		t.s.run(0.1);
		assert.equal(t.trn(x, 'betResult').at(-1)?.outcome, 'refund');
		assert.equal(t.trn(x, 'betResult').at(-1)?.payout, TRN_BET);
		assert.equal(t.balance(x), before);
		// The next match; then the map changes.
		const next = t.g.bracket!.matches[t.g.current!]!;
		const y = t.ps.find((p) => p.id !== next.a && p.id !== next.b && p !== x && t.s.w.players.has(p))!;
		const yBefore = t.balance(y);
		assert.equal(t.bet(y, next.a!).ok, true);
		t.mode.dispose();
		assert.equal(t.balance(y), yBefore);
		assert.equal(t.trn(y, 'betResult').at(-1)?.outcome, 'refund');
		assert.equal(t.s.w.db.openTrnBetCount(), 0);
	});

	it('refusals: guest, duelist, pick, twice, coins, closed, small', () => {
		const { t, match, others } = betting();
		const [x, y] = others as [SimPlayer, SimPlayer];
		const guest = t.s.w.guest();
		t.byId.set(guest.id, guest);
		t.s.enter(guest, 0, 0);
		assert.equal(t.bet(guest, match.a!).reason, 'guest');
		assert.equal(t.bet(t.byId.get(match.a!)!, match.b!).reason, 'duelist');
		assert.equal(t.bet(x, x.id).reason, 'pick');
		assert.equal(t.bet(x, null).reason, 'pick');
		assert.equal(t.bet(x, match.a!).ok, true);
		assert.equal(t.bet(x, match.b!).reason, 'twice');
		t.s.w.economy.adjust(y.accountId!, null);
		assert.equal(t.bet(y, match.a!).reason, 'coins');
		assert.equal(t.balance(y), 0);
		t.give(y, 100);
		t.until(() => t.g.duel?.sub === 'live');
		assert.equal(t.bet(y, match.a!).reason, 'closed');
		// Small bracket.
		const small = lobby(3);
		small.until(() => small.g.phase === 'bracket');
		small.give(small.ps[2]!, 100);
		assert.equal(small.bet(small.ps[2]!, small.ps[0]!.id).reason, 'small');
	});

	it('open bets are given back after a restart', () => {
		const { t, match, others } = betting();
		const x = others[0]!;
		const before = t.balance(x);
		t.bet(x, match.a!);
		assert.equal(t.s.w.db.openTrnBetCount(), 1);
		const logs: string[] = [];
		// A new server on the same database.
		new Economy(
			{
				db: t.s.w.db,
				now: () => t.s.w.now,
				clock: () => t.s.w.clock,
				players: () => [],
				send: () => {},
				broadcast: () => {},
				systemTo: () => {},
				totals: () => {},
				isAdmin: () => false,
				ban: () => {},
				abuseLogged: () => {},
				log: (m) => void logs.push(m),
				stillness: () => null
			},
			trnMap()
		);
		assert.equal(t.balance(x), before);
		assert.equal(t.s.w.db.openTrnBetCount(), 0);
		assert.ok(logs.some((l) => l.includes('1 open bets given back')));
	});
});

describe('tournament server: targets', () => {
	it('spectators never hurt duelists; duelists never hit spectators', () => {
		const t = lobby(3);
		t.until(() => t.g.phase === 'duel');
		t.until(() => t.g.duel?.sub === 'live');
		const [a, b] = t.duelists();
		const c = t.ps.find((p) => p !== a && p !== b)!;
		// The spectator jumps down next to b and swings; then stands in a's line of fire.
		t.s.put(c, 0, 340, 0, 90);
		t.at.set(c.id, { x: 0, y: 340, z: 0, yaw: 90 });
		t.fire(c, 'knife', { x: 0, y: 400, z: 40 });
		assert.equal(t.g.hpOf(b.id), 100);
		t.s.put(c, 0, 0, 0, -90);
		t.s.run(0.3);
		t.fire(a, 'sniper', { x: 0, y: 0, z: 40 });
		assert.equal(t.trn(c, 'hit').length, 0);
		// Guns other than the knife are refused for spectators.
		const hp = t.g.hpOf(b.id);
		t.at.set(c.id, { x: 0, y: 0, z: 0, yaw: -90 });
		t.fire(c, 'sniper', { x: 0, y: 400, z: 40 });
		assert.equal(t.g.hpOf(b.id), hp);
	});

	it('score rows: duels won, duel kills, status', () => {
		const t = lobby(3);
		t.until(() => t.g.phase === 'duel');
		const winner = t.playDuel();
		const rows = t.mode.scoreRows();
		const w = rows.find((r) => r.id === winner.id)!;
		assert.equal(w.score, 1);
		assert.equal(w.kills, 2);
		assert.equal(w.status, Status.Alive);
		const late = t.s.w.join(1)[0]!;
		t.s.enter(late, 0, 0);
		t.s.run(0.1);
		const rows2 = t.mode.scoreRows();
		assert.equal(rows2.find((r) => r.id === late.id)!.status, Status.Spectating);
		assert.equal(rows2.filter((r) => r.status === Status.Down).length, 1);
	});
});
