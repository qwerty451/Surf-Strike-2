/** Abuse detection (docs/economy.md#abuse-and-collusion): the strike engine, simulated normal and collusive play, the ban end to end. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ABUSE, type AbuseSignal, HNS_PAY, HuntTracker, PROTOCOL_VERSION, pts, TAG_PAY, TimeMeter, type HuntBody, type MapDef } from '@surf/shared';
import { AbuseEngine } from './abuse.ts';
import { hashPassword } from './auth.ts';
import { world, type SimPlayer } from './economy-helpers.ts';
import { startServer, type GameServer } from './server.ts';
import { TestClient, testMap } from './test-helpers.ts';

const HNS = { ...testMap('hns_x'), kind: 'hns' } as MapDef;
const TAG = { ...testMap('tag_x'), kind: 'tag' } as MapDef;
const MIN = 60_000;

describe('AbuseEngine', () => {
	function setup() {
		const t = { now: 0 };
		const out: string[] = [];
		const admins = new Set<number>();
		const e = new AbuseEngine({
			now: () => t.now,
			isAdmin: (id) => admins.has(id),
			warn: (id, n) => out.push(`warn ${id} ${n}`),
			ban: (id, n, _e, exempt) => out.push(`${exempt ? 'exempt' : 'ban'} ${id} ${n}`)
		});
		const report = (signal: AbuseSignal, round: number, ...ids: number[]) =>
			e.report({ signal, round, accounts: ids.map((accountId) => ({ accountId })), involved: ids, evidence: 'x' });
		return { t, e, out, admins, report };
	}

	it('decays one strike per 10 minutes', () => {
		const { t, e, report } = setup();
		report('shadow', 1, 1);
		assert.equal(e.strikes(1), 2);
		t.now += 10 * MIN - 1;
		assert.equal(e.strikes(1), 2);
		t.now += 1;
		assert.equal(e.strikes(1), 1);
		t.now += 30 * MIN;
		assert.equal(e.strikes(1), 0);
		assert.equal(e.strikes(99), 0);
	});

	it('weight-1 signals of one kind never warn, however often they come', () => {
		const { t, e, out, report } = setup();
		for (let i = 0; i < 600; i++) {
			report('contact', i, 1, 2);
			t.now += MIN / 2;
		}
		assert.deepEqual(out, []);
		assert.ok(e.strikes(1) <= 1);
	});

	it('warns at 3 and pauses the awards; the partner is paused only between the two', () => {
		const { t, e, out, report } = setup();
		report('shadow', 1, 1);
		t.now += 2 * MIN;
		e.report({ signal: 'shadow', round: 2, accounts: [{ accountId: 1 }], involved: [1, 2], evidence: 'x' });
		assert.deepEqual(out, ['warn 1 4']);
		assert.equal(e.paused(1), true);
		assert.equal(e.paused(2), false);
		assert.equal(e.paused(2, 1), true);
		assert.equal(e.paused(2, 3), false);
		t.now += 5 * MIN;
		assert.equal(e.paused(1), false);
		assert.equal(e.paused(2, 1), false);
	});

	it('bans at 5 only after a warning and with two rounds or two kinds of signal', () => {
		const a = setup();
		a.report('shadow', 1, 1);
		for (let i = 0; i < 5; i++) {
			a.t.now += 61_000;
			a.report('shadow', 1, 1);
		}
		assert.deepEqual(a.out, ['warn 1 4'], 'one round, one kind: never a ban');
		a.t.now += 61_000;
		a.report('shadow', 2, 1);
		assert.equal(a.out.length, 2);
		assert.match(a.out[1]!, /^ban 1/);
		assert.equal(a.e.strikes(1), ABUSE.afterBan);

		// Everything in the same moment: the warning comes first, no ban.
		const b = setup();
		b.report('shadow', 1, 1);
		b.report('macro', 2, 1);
		b.report('ipFeed', 3, 1);
		assert.deepEqual(b.out, ['warn 1 4']);
	});

	it('after a ban the next one needs a new warning', () => {
		const { t, out, report } = setup();
		for (let i = 0; i < 3; i++) {
			report('shadow', i, 1);
			t.now += 2 * MIN;
		}
		assert.deepEqual(out, ['warn 1 4', 'ban 1 6']);
		t.now += 5 * MIN;
		report('shadow', 9, 1);
		assert.deepEqual(out.slice(2), ['warn 1 4']);
	});

	it('admins are logged, not banned', () => {
		const { t, out, admins, report } = setup();
		admins.add(1);
		for (let i = 0; i < 3; i++) {
			report('shadow', i, 1);
			t.now += 2 * MIN;
		}
		assert.deepEqual(out, ['warn 1 4', 'exempt 1 6']);
	});

	it('the same signal repeated at once counts once per account; prune forgets old suspects', () => {
		const { t, e, report } = setup();
		for (let i = 0; i < 20; i++) report('impossible', 1, 1);
		assert.equal(e.strikes(1), 1);
		t.now += 20 * MIN;
		e.prune();
		assert.equal((e as unknown as { suspects: Map<number, unknown> }).suspects.size, 0);
	});
});

/** Warnings and bans so far. */
const actions = (w: ReturnType<typeof world>) => w.db.abuseLog(100).map((r) => `${r.action} ${r.username}`);

/**
 * One hide and seek round of `secs` with the real HuntTracker: `step` places
 * the players; hiders and seekers are paid for chase and view as the mode will.
 */
function hnsRound(
	w: ReturnType<typeof world>,
	seekers: SimPlayer[],
	hiders: SimPlayer[],
	secs: number,
	step: (t: number, put: (p: SimPlayer, x: number, y: number, yaw?: number) => void, swing: (p: SimPlayer) => void) => void,
	moves: (id: number) => boolean = () => true
) {
	w.mode.roundStart();
	for (const h of hiders) w.stillness.set(h.id, 'look');
	const hunt = new HuntTracker({ sight: { visible: () => true, clear: () => true }, chaseRange: 600, pursuit: true, viewRange: 2000 });
	const chased = new TimeMeter(HNS_PAY.hiderChased.everyMs);
	const seen = new TimeMeter(HNS_PAY.plainView.everyMs);
	// Positions are the script's, not the state packets': the tracker sees these.
	const pos = new Map<number, HuntBody>();
	for (const p of [...seekers, ...hiders]) pos.set(p.id, { id: p.id, x: p.id * 5000, y: 0, z: 0, yaw: 0, pitch: 0 });
	const t0 = w.clock;
	w.run(secs, moves, {
		hz: 8,
		look: hiders.map((h) => h.id),
		each: (t) => {
			step(
				t,
				(p, x, y, yaw = 0) => Object.assign(pos.get(p.id)!, { x, y, yaw }),
				(p) => hunt.attempt(p.id)
			);
			const s = hunt.update(w.clock - t0, seekers.map((p) => pos.get(p.id)!), hiders.map((p) => pos.get(p.id)!));
			if (!s) return;
			for (const [id, e] of s.chased) if (chased.add(id, e.ms)) w.mode.award(id, HNS_PAY.hiderChased.points, 'hnsChased', { against: e.by });
			for (const [id, e] of s.seen) if (!s.chased.has(id) && seen.add(id, e.ms)) w.mode.award(id, HNS_PAY.plainView.points, 'hnsView', { against: e.by });
			for (const sh of s.shadows) w.mode.report('shadow', [sh.hunter, sh.target], '20 s without a swing');
		}
	});
	w.mode.roundEnd();
}

describe('normal play is not flagged', () => {
	it('friends on one network chasing, finding and tagging each other for an hour', () => {
		const w = world(TAG);
		const ps = w.join(6, () => '203.0.113.7'); // a LAN party: one address
		w.active();
		const rng = ps[0]!.rng;
		const pick = () => ps[Math.floor(rng() * ps.length)]!;
		for (let round = 0; round < 18; round++) {
			w.mode.roundStart();
			// The two best friends P1 and P2 go for each other half of the time.
			let it = pick();
			w.run(180, () => true, {
				hz: 8,
				each: (t) => {
					if (t % 10 !== 0) return;
					const target = rng() < 0.5 && it === ps[0] ? ps[1]! : rng() < 0.5 && it === ps[1] ? ps[0]! : pick();
					if (target === it) return;
					if (rng() < 0.6) w.mode.award(target.id, TAG_PAY.chased.points, 'tagChased', { against: it.id });
					w.mode.award(it.id, TAG_PAY.tag, 'tagTag', { against: target.id });
					w.mode.contact(it.id, target.id);
					it = target;
				}
			});
			w.mode.roundEnd();
		}
		assert.deepEqual(actions(w), []);
		for (const p of ps) assert.ok(w.economy.abuse.strikes(p.accountId!) < ABUSE.warnAt);
		assert.ok(w.db.accountStats(ps[0]!.accountId!).pointsTotal > 0);
	});

	it('three friends tagging back and forth all the time', () => {
		const w = world(TAG);
		const ps = w.join(3);
		w.active();
		for (let round = 0; round < 10; round++) {
			w.mode.roundStart();
			let i = 0;
			w.run(180, () => true, {
				hz: 4,
				each: (t) => {
					if (t % 4 !== 0) return;
					const [a, b] = i++ % 2 ? [ps[0]!, ps[1]!] : [ps[1]!, ps[0]!];
					w.mode.contact(a.id, b.id);
					w.mode.award(b.id, TAG_PAY.chased.points, 'tagChased', { against: a.id });
				}
			});
			w.mode.roundEnd();
		}
		assert.deepEqual(actions(w), []);
	});

	it('a bad seeker: close to the same hider for minutes, swinging and missing', () => {
		const w = world(HNS);
		const ps = w.join(6);
		w.active();
		const [seeker, ...hiders] = ps;
		for (let round = 0; round < 6; round++) {
			hnsRound(w, [seeker!], hiders, 240, (t, put, swing) => {
				put(hiders[0]!, 0, 0);
				// Circles around, looks at the hider, swings every few seconds and misses.
				put(seeker!, Math.cos(t) * 90, Math.sin(t) * 90, (t * 180) / Math.PI + 180);
				if (Math.round(t * 8) % 40 === 0) swing(seeker!);
			});
		}
		assert.deepEqual(actions(w), []);
		assert.ok(w.db.accountStats(hiders[0]!.accountId!).pointsTotal > 0, 'the hider still earns');
	});

	it('a seeker who does not see the hider next to them (looks elsewhere)', () => {
		const w = world(HNS);
		const [seeker, ...hiders] = w.join(6);
		w.active();
		for (let round = 0; round < 4; round++) {
			hnsRound(w, [seeker!], hiders, 240, (t, put) => {
				put(hiders[0]!, 0, 0);
				// Stands around the corner, only glancing past the hider.
				put(seeker!, -80, 0, Math.floor(t / 8) % 3 === 0 ? 0 : 180);
			});
		}
		assert.deepEqual(actions(w), []);
	});

	it('a lucky streak: one player earns a lot in a row, from everyone', () => {
		const w = world(HNS);
		const [lucky, ...others] = w.join(8);
		w.active();
		for (let round = 0; round < 12; round++) {
			w.mode.roundStart();
			w.run(120, () => true, {
				hz: 4,
				each: (t) => {
					if (t % 10 !== 0) return;
					const other = others[Math.floor(t / 10 + round) % others.length]!;
					w.mode.award(lucky!.id, HNS_PAY.hiderChased.points, 'hnsChased', { against: other.id });
					w.mode.award(lucky!.id, HNS_PAY.find, 'hnsFind', { against: other.id });
					w.mode.contact(lucky!.id, other.id);
				}
			});
			w.mode.roundEnd();
		}
		assert.deepEqual(actions(w), []);
		assert.equal(w.economy.abuse.strikes(lucky!.accountId!), 0);
	});

	it('three rounds against the same good seeker, all points from them', () => {
		const w = world(HNS);
		const [seeker, ...hiders] = w.join(5);
		w.active();
		for (let round = 0; round < 3; round++) {
			hnsRound(w, [seeker!], hiders, 200, (t, put, swing) => {
				put(hiders[0]!, 200 + t * 250, 0);
				put(seeker!, t * 250, 0);
				if (t % 5 === 0) swing(seeker!);
			});
		}
		assert.deepEqual(actions(w), [], 'a signal at most, no warning');
		assert.ok(w.economy.abuse.strikes(hiders[0]!.accountId!) <= 1);
	});

	it('siblings behind one address, one of them away from the keyboard for two rounds', () => {
		const w = world(HNS);
		const [me, sibling, ...rest] = w.join(6, (i) => (i < 2 ? '2001:db8:1:2::1' : null));
		w.active();
		for (let round = 0; round < 8; round++) {
			w.mode.roundStart();
			const away = round === 3 || round === 4;
			w.run(120, (id) => id !== sibling!.id || !away, { hz: 16 });
			w.mode.award(me!.id, HNS_PAY.find, 'hnsFind', { against: sibling!.id });
			w.mode.award(me!.id, HNS_PAY.find, 'hnsFind', { against: rest[0]!.id });
			w.mode.roundEnd();
		}
		assert.deepEqual(actions(w), []);
		assert.equal(w.economy.abuse.strikes(me!.accountId!), 0);
	});

	it('an hour of normal input is never taken for a macro', () => {
		const w = world(TAG);
		const [a, b] = w.join(3);
		w.run(61 * 60, () => true, {
			hz: 16,
			each: (t) => {
				if (t % 30 !== 0) return;
				w.mode.roundStart();
				w.mode.award(a!.id, pts(1), 'tagTag', { against: b!.id });
			}
		});
		assert.deepEqual(actions(w), []);
		assert.equal(w.economy.abuse.strikes(a!.accountId!), 0);
	});
});

describe('collusion is flagged', () => {
	it('a seeker parked next to a friend who collects view points: warned, paused, then banned', () => {
		const w = world(HNS);
		const ps = w.join(6);
		w.active();
		const [seeker, friend, ...rest] = ps;
		let round = 0;
		const farm = () =>
			hnsRound(w, [seeker!], [friend!, ...rest], 110, (_t, put) => {
				put(friend!, 0, 0);
				put(seeker!, -70, 0, 0);
			}, (id) => id !== friend!.id);
		while (round++ < 10 && !w.bans.length) farm();
		const log = actions(w);
		assert.ok(log.includes(`warning ${seeker!.name}`), log.join());
		assert.ok(log.includes(`ban ${seeker!.name}`), log.join());
		assert.equal(log.at(-1), `warning ${seeker!.name}`, 'the seeker is warned first');
		assert.equal(w.bans[0]!.accountId, seeker!.accountId);
		assert.equal(w.bans[0]!.ms, 5 * MIN);
		assert.ok(round >= 2, 'not within a single round');
		assert.match(w.db.abuseLog(1)[0]!.evidence, /shadow \(round \d+\)/);
		for (const p of rest) assert.equal(w.economy.abuse.strikes(p.accountId!), 0, 'bystanders are untouched');
		const warned = w.sent(seeker!, 'coinsNotice');
		assert.equal(warned[0]!.tone, 'warn');
	});

	it('while paused nothing is paid to the account, and nothing between the pair', () => {
		const w = world(HNS);
		const [a, b, c] = w.join(6);
		w.active();
		w.mode.roundStart();
		for (let i = 0; i < 2; i++) {
			w.mode.award(b!.id, HNS_PAY.plainView.points, 'hnsView', { against: a!.id });
			w.mode.report('shadow', [a!.id, b!.id], 'x');
			w.run(65, () => true, { hz: 8 });
		}
		assert.deepEqual(actions(w), [`warning ${a!.name}`]);
		assert.equal(w.mode.award(a!.id, HNS_PAY.find, 'hnsFind', { against: c!.id }).refused, 'paused');
		assert.equal(w.mode.award(b!.id, HNS_PAY.find, 'hnsFind', { against: a!.id }).refused, 'paused');
		assert.ok(w.mode.award(b!.id, HNS_PAY.find, 'hnsFind', { against: c!.id }).paid > 0);
		w.run(5 * 60, () => true, { hz: 8 });
		assert.ok(w.mode.award(a!.id, HNS_PAY.find, 'hnsFind', { against: c!.id }).paid > 0);
	});

	it('a shadow that earns the target nothing is ignored', () => {
		const w = world(HNS);
		const [a, b] = w.join(6);
		w.active();
		w.mode.report('shadow', [a!.id, b!.id], 'x');
		assert.equal(w.economy.abuse.strikes(a!.accountId!), 0);
	});

	it('an idle second account on the same network that is found every round', () => {
		for (const [ip, flagged] of [['198.51.100.4', true], [null, false]] as const) {
			const w = world(HNS);
			const [me, bot, ...rest] = w.join(6, (i) => (i < 2 ? ip : null));
			w.active();
			for (let round = 0; round < 7; round++) {
				w.mode.roundStart();
				w.run(120, (id) => id !== bot!.id, { hz: 16 });
				w.mode.award(me!.id, HNS_PAY.find, 'hnsFind', { against: bot!.id });
				w.mode.roundEnd();
			}
			assert.equal(actions(w).includes(`warning ${me!.name}`), flagged, String(ip));
			for (const p of rest) assert.equal(w.economy.abuse.strikes(p.accountId!), 0);
			for (const row of w.db.abuseLog(10)) assert.ok(!row.evidence.includes('198.51'), 'no address in the log');
		}
	});

	it('most chase points from one account, round after round, with others to choose from', () => {
		const w = world(HNS);
		const [a, b, c] = w.join(7);
		w.active();
		const round = (by: SimPlayer) => {
			w.mode.roundStart();
			for (let i = 0; i < 4; i++) w.mode.award(a!.id, HNS_PAY.hiderChased.points, 'hnsChased', { against: by.id });
			w.mode.award(a!.id, HNS_PAY.hiderChased.points, 'hnsChased', { against: c!.id });
			w.mode.roundEnd();
			w.run(30, () => true, { hz: 8 });
		};
		round(b!);
		round(b!);
		assert.equal(w.economy.abuse.strikes(a!.accountId!), 0);
		round(b!);
		assert.equal(w.economy.abuse.strikes(a!.accountId!), 1);
		assert.equal(w.economy.abuse.strikes(b!.accountId!), 0);
	});

	it('a looping macro that keeps earning', () => {
		const w = world(TAG);
		const [a, b] = w.join(3);
		w.run(41 * 60, () => true, {
			hz: 32,
			input: (id) => (id === a!.id ? 'macro' : 'human'),
			each: (t) => {
				if (t % 60 !== 0) return;
				w.mode.roundStart();
				w.mode.award(a!.id, pts(1), 'tagTag', { against: b!.id });
			}
		});
		assert.ok(actions(w).includes(`warning ${a!.name}`), actions(w).join());
		assert.equal(w.economy.abuse.strikes(b!.accountId!), 0);
	});

	it('impossible requests: a few are ignored, many together with another signal add up', () => {
		const w = world(HNS);
		const [a] = w.join(5);
		w.active();
		w.mode.report('impossible', [a!.id], 'bag taken from 900 units away');
		w.mode.report('impossible', [a!.id], 'again');
		assert.equal(w.economy.abuse.strikes(a!.accountId!), 1);
		w.run(61, () => true);
		w.mode.report('impossible', [a!.id], 'again');
		w.run(61, () => true);
		w.mode.report('impossible', [a!.id], 'again');
		assert.deepEqual(actions(w), [`warning ${a!.name}`]);
	});

	it('a guest feeder is seen too, only the account gets strikes', () => {
		const w = world(HNS);
		const [me] = w.join(5, (i) => (i === 0 ? '198.51.100.4' : null));
		const bot = w.guest('guest-bot', '198.51.100.4');
		w.active();
		w.run(1, (id) => id !== bot.id); // the last mouse movement ends
		for (let round = 0; round < 3; round++) {
			w.mode.roundStart();
			w.run(120, (id) => id !== bot.id, { hz: 16 });
			w.mode.award(me!.id, HNS_PAY.find, 'hnsFind', { against: bot.id });
			w.mode.roundEnd();
		}
		assert.equal(w.economy.abuse.strikes(me!.accountId!), 2);
	});
});

describe('automatic ban (real server)', () => {
	let server: GameServer;
	let clock = 2_000_000_000;
	const clients: TestClient[] = [];
	const connect = (headers?: Record<string, string>) => {
		const c = new TestClient(server.port, headers);
		clients.push(c);
		return c;
	};

	before(async () => {
		server = await startServer({
			port: 0,
			host: '127.0.0.1',
			dbPath: ':memory:',
			maps: [testMap('surf_a')],
			now: () => clock,
			log: () => {},
			timers: false,
			adminUsernames: ['tim']
		});
	});
	after(async () => {
		for (const c of clients) c.close();
		await server.close();
	});

	it('kicks with reason and time left, lifts by itself, and is listed for admins', async () => {
		const tim = connect();
		await tim.hello('x');
		assert.ok(server.db.createAccount('Tim', await hashPassword('secret')));
		assert.equal((await tim.auth('login', 'Tim', 'secret')).ok, true);
		const key = crypto.randomUUID();
		const bob = connect();
		await bob.hello('x', key);
		const auth = await bob.auth('register', 'Bob', 'secret');
		const token = auth.ok ? auth.token! : '';
		const id = server.db.accountByName('bob')!.id;
		const welcome = { reason: 'welcome', label: 'Welcome bonus', amount: 1000, mult: 10 };
		const coins = bob.of('coins').at(-1)!;
		assert.deepEqual(coins, { type: 'coins', total: 0, balance: 1000, recent: [{ at: coins.recent[0]!.at, ...welcome }] });
		assert.ok(bob.of('multiplier').length > 0);

		const abuse = server.lobby.economy.abuse;
		const strike = (accountId: number, round: number) =>
			abuse.report({ signal: 'shadow', round, accounts: [{ accountId }], involved: [accountId], evidence: 'test' });
		const timId = server.db.accountByName('tim')!.id;
		for (let i = 0; i < 3; i++) {
			strike(id, i);
			strike(timId, i);
			clock += 61_000;
		}
		assert.equal(bob.of('coinsNotice')[0]!.tone, 'info', 'welcome bonus');
		await bob.waitFor('coinsNotice', (m) => m.tone === 'warn');
		await bob.barrier();
		assert.equal(bob.closed, false, 'the ban waits for the next tick');
		server.lobby.tickMode();
		const banned = await bob.waitFor('banned');
		assert.equal(banned.seconds, 300);
		assert.match(banned.reason!, /farming/i);
		await bob.until(() => bob.closed);
		assert.equal(bob.closeCode, 4009);
		await tim.barrier();
		assert.equal(tim.closed, false, 'admins stay');

		const n = tim.messages.length;
		tim.send({ type: 'admin', action: { action: 'listBans' } });
		const st = await tim.waitFor('adminState', () => true, n);
		assert.deepEqual(st.bans.map((b) => [b.username, b.createdBy, b.secondsLeft]), [['Bob', 'auto', 300]]);
		assert.deepEqual(st.abuse!.map((e) => `${e.action} ${e.username}`).sort(), ['ban Bob', 'exempt Tim', 'warning Bob', 'warning Tim']);

		// Still banned, with the time left; also as a guest on the same browser.
		clock += 60_000;
		for (const t of [token, undefined]) {
			const c = connect();
			await c.open();
			c.send({ type: 'hello', playerId: key, name: 'Bob', version: PROTOCOL_VERSION, ...(t ? { token: t } : {}) });
			await c.until(() => c.closed, 3000);
			assert.equal(c.of('banned')[0]!.seconds, 240);
		}
		// Login from elsewhere is refused as well.
		const elsewhere = connect();
		await elsewhere.hello('x');
		await elsewhere.auth('login', 'Bob', 'secret');
		assert.equal((await elsewhere.waitFor('banned')).seconds, 240);

		// An admin may make it permanent; unbanning that leaves the short one.
		const m = tim.messages.length;
		tim.send({ type: 'admin', action: { action: 'ban', username: 'Bob', reason: 'really' } });
		assert.equal((await tim.waitFor('adminResult', () => true, m)).ok, true);
		const c2 = connect();
		await c2.open();
		c2.send({ type: 'hello', playerId: key, name: 'Bob', version: PROTOCOL_VERSION, token });
		await c2.until(() => c2.closed, 3000);
		assert.equal(c2.of('banned')[0]!.seconds, undefined, 'permanent bans have no time');
		assert.equal(c2.of('banned')[0]!.reason, 'really');
		const perm = server.db.bans().find((b) => b.expiresAt === null)!;
		const k = tim.messages.length;
		tim.send({ type: 'admin', action: { action: 'unban', banId: perm.id } });
		assert.equal((await tim.waitFor('adminResult', () => true, k)).ok, true);

		// Over: the same token logs in again, strikes are back to 2.
		clock += 240_000;
		const back = connect();
		const w = await back.hello('x', key, token);
		assert.equal(w.account?.username, 'Bob');
		assert.equal(abuse.strikes(id), ABUSE.afterBan);
		const j = tim.messages.length;
		tim.send({ type: 'admin', action: { action: 'listBans' } });
		assert.deepEqual((await tim.waitFor('adminState', () => true, j)).bans, []);
		assert.equal(server.db.deleteExpiredBans(clock), 1);
	});
});
