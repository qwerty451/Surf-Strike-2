import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FLAG_TELEPORTED, MAP_DURATION, PROTOCOL_VERSION, Status, VOTE_AT, VOTE_DURATION, TICK_RATE } from '@surf/shared';
import { hashPassword } from './auth.ts';
import type { GameServer } from './server.ts';
import { startServer } from './server.ts';
import { netState, sleep, TestClient, testMap } from './test-helpers.ts';

const MS = (ticks: number) => (ticks / TICK_RATE) * 1000;
const MAPS = [testMap('surf_a', 'Alpha'), testMap('surf_b', 'Bravo'), testMap('surf_c', 'Charlie'), testMap('surf_d', 'Delta')];

let clock = 1_000_000_000;
let server: GameServer;
const clients: TestClient[] = [];

async function join(name: string, playerId?: string) {
	const c = new TestClient(server.port);
	clients.push(c);
	const welcome = await c.hello(name, playerId);
	return { c, welcome };
}

/** Drive a run: start -> (stage at +256) -> end at +512 ticks, with wall clock in step. */
async function run(
	c: TestClient,
	opts: { stageIndex?: number; vx?: number; jumpAt?: number; wallMs?: number; totalTicks?: number } = {}
) {
	const total = opts.totalTicks ?? 512;
	const t0 = 10_000;
	c.sendState(netState(t0 - 2, 150, { status: Status.StartZone }));
	c.send({ type: 'zone', kind: 'start', index: 0, tick: t0 });
	await c.barrier(); // start processed at `clock`
	const startClock = clock;
	for (let t = t0; t <= t0 + total; t += 16) {
		let x = 216 + ((t - t0) * 1850) / total;
		if (opts.jumpAt !== undefined && t - t0 >= opts.jumpAt && t - t0 < opts.jumpAt + 16) x = -3000;
		c.sendState(netState(t, x, { vx: opts.vx ?? 400, runTicks: t - t0 }));
		if (t - t0 === 256) c.send({ type: 'zone', kind: 'stage', index: opts.stageIndex ?? 2, tick: t });
	}
	clock = startClock + (opts.wallMs ?? MS(total));
	const n = c.messages.length;
	c.send({ type: 'zone', kind: 'end', index: 0, tick: t0 + total });
	return c.until(() =>
		c.messages
			.slice(n)
			.find(
				(m) =>
					m.type === 'runResult' ||
					m.type === 'runRejected' ||
					(m.type === 'chat' && m.system === true && m.text.includes('guest run, not saved'))
			)
	);
}

before(async () => {
	server = await startServer({
		port: 0,
		host: '127.0.0.1',
		dbPath: ':memory:',
		maps: MAPS,
		initialMap: 'surf_a',
		now: () => clock,
		rng: () => 0,
		log: () => {}
	});
});

after(async () => {
	for (const c of clients) c.close();
	await server.close();
});

describe('lobby', () => {
	it('health endpoint', async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/health`);
		const body = await res.json();
		assert.equal(body.ok, true);
		assert.equal(body.version, 3);
		assert.equal(body.map, 'surf_a');
	});

	it('hello -> welcome, join broadcast, names sanitized', async () => {
		const { c: a, welcome: wa } = await join('Alice');
		assert.equal(wa.version, 3);
		assert.equal(wa.map, 'surf_a');
		assert.equal(wa.selfId, 1);
		assert.equal(wa.mapTimeLeft, MAP_DURATION);
		assert.equal(wa.cvars.sv_maxvelocity, 3500);
		assert.equal(wa.cvars.sv_airaccelerate, 150);
		assert.deepEqual(wa.records, { pbTicks: null, pbSplits: null, rank: null, recordTicks: null, recordName: null, top: [] });
		const { welcome: wb } = await join('\u0001Bob' + 'b'.repeat(40));
		assert.equal(wb.players.length, 2);
		const self = wb.players.find((p) => p.id === wb.selfId)!;
		assert.equal(self.name.length, 24);
		assert.ok(self.name.startsWith('Bob'));
		const j = await a.waitFor('join');
		assert.equal(j.player.id, wb.selfId);
		await a.waitFor('chat', (m) => m.system === true && m.text.includes('joined'));
	});

	it('chat is broadcast, commands are not', async () => {
		const { c: a } = await join('ChatA');
		const { c: b } = await join('ChatB');
		const nb = b.messages.length;
		a.send({ type: 'chat', text: '  hello\u0007 world  ' });
		const m = await b.waitFor('chat', (m) => m.from === 'ChatA', nb);
		assert.equal(m.text, 'hello world');
		a.send({ type: 'chat', text: '!top' });
		await a.waitFor('chat', (m) => m.system === true && /No times|Top/.test(m.text));
		await sleep(100);
		assert.equal(
			b.messages.slice(nb).some((m) => m.type === 'chat' && m.text.includes('!top')),
			false
		);
		// Long message truncated to 128.
		await sleep(1000);
		a.send({ type: 'chat', text: 'x'.repeat(500) });
		const long = await b.waitFor('chat', (m) => m.from === 'ChatA' && m.text.startsWith('xxx'), nb);
		assert.equal(long.text.length, 128);
	});

	it('snapshot contains other players; spectators excluded', async () => {
		const { c: a, welcome: wa } = await join('SnapA');
		const { c: b } = await join('SnapB');
		a.sendState(netState(5, 123.5, { yaw: 90 }));
		const entry = await b.until(() => b.snapshots.flat().find((e) => e.id === wa.selfId && e.x === 123.5));
		assert.equal(entry.yaw, 90);
		a.send({ type: 'spectate', targetId: 999 });
		const sp = await b.waitFor('spectating', (m) => m.id === wa.selfId);
		assert.equal(sp.spectating, true);
		await sleep(100);
		const n = b.snapshots.length;
		await sleep(150);
		assert.equal(
			b.snapshots.slice(n).some((s) => s.some((e) => e.id === wa.selfId)),
			false
		);
		a.send({ type: 'spectate', targetId: null });
		await b.waitFor('spectating', (m) => m.id === wa.selfId && !m.spectating);
	});

	it('scoreboard lists players', async () => {
		const { c } = await join('Score');
		const sb = await c.waitFor('scoreboard', (m) => m.rows.some((r) => r.name === 'Score'), 0, 2500);
		assert.ok(sb.rows.length >= 2);
	});

	it('valid run is saved and returns runResult', async () => {
		const { c } = await join('Runner');
		assert.equal((await c.auth('register', 'Runner', 'secret1')).ok, true);
		const pid = server.db.accountByName('Runner')!.id;
		const res = await run(c);
		assert.equal(res.type, 'runResult');
		if (res.type !== 'runResult') return;
		assert.equal(res.ticks, 512);
		assert.equal(res.rank, 1);
		assert.equal(res.pb, true);
		assert.equal(res.record, true);
		assert.deepEqual(res.splits, [256]);
		assert.equal(res.records.pbTicks, 512);
		assert.equal(res.records.recordName, 'Runner');
		assert.equal(server.db.getPb(pid, 'surf_a')?.ticks, 512);
		await c.waitFor('chat', (m) => m.system === true && m.text.includes('new map record'));
		// Slower run: not a PB, not saved.
		await sleep(1100);
		const slow = await run(c, { totalTicks: 640 });
		assert.equal(slow.type, 'runResult');
		if (slow.type === 'runResult') assert.equal(slow.pb, false);
		assert.equal(server.db.getPb(pid, 'surf_a')?.ticks, 512);
	});

	for (const [label, opts, reason] of [
		['zone order', { stageIndex: 3 }, 'zones out of order'],
		['speed', { vx: 4000 }, 'speed above sv_maxvelocity'],
		['teleport jump', { jumpAt: 128 }, 'position jump'],
		['timing', { wallMs: 16000 }, 'timer does not match wall-clock time']
	] as const) {
		it(`invalid run rejected: ${label}`, async () => {
			const user = `Bad_${label.replace(/\s/g, '_')}`;
			const { c } = await join(user);
			assert.equal((await c.auth('register', user, 'secret1')).ok, true);
			const pid = server.db.accountByName(user)!.id;
			const res = await run(c, opts);
			assert.deepEqual(res, { type: 'runRejected', reason });
			await c.waitFor('chat', (m) => m.system === true && m.text.startsWith('Run not saved'));
			assert.equal(server.db.getPb(pid, 'surf_a'), null);
		});
	}

	it('teleport flag near a respawn is accepted', async () => {
		const { c } = await join('Teleporter');
		assert.equal((await c.auth('register', 'Teleporter', 'secret1')).ok, true);
		const t0 = 50_000;
		c.sendState(netState(t0 - 2, 150));
		c.send({ type: 'zone', kind: 'start', index: 0, tick: t0 });
		await c.barrier();
		const start = clock;
		c.sendState(netState(t0 + 16, 400));
		c.sendState(netState(t0 + 256, 1050));
		c.send({ type: 'zone', kind: 'stage', index: 2, tick: t0 + 256 });
		c.sendState(netState(t0 + 270, 1500, { z: -400 }));
		c.sendState(netState(t0 + 272, 1050, { z: 0, flags: FLAG_TELEPORTED }));
		for (let t = t0 + 288; t <= t0 + 512; t += 16) c.sendState(netState(t, 1050 + ((t - t0 - 272) * 1000) / 240));
		clock = start + MS(512);
		const n = c.messages.length;
		c.send({ type: 'zone', kind: 'end', index: 0, tick: t0 + 512 });
		const res = await c.until(() => c.messages.slice(n).find((m) => m.type === 'runResult' || m.type === 'runRejected'));
		assert.equal(res.type, 'runResult');
	});

	it('full lobby: the 33rd connection receives a full frame and closes with 4003', async () => {
		for (const c of clients) c.close();
		clients.length = 0;
		await sleep(200);
		for (let i = 0; i < 32; i += 8) {
			const batch = Array.from({ length: 8 }, () => new TestClient(server.port));
			clients.push(...batch);
			await Promise.all(batch.map((c, j) => c.hello(`P${i + j}`)));
		}
		const extra = new TestClient(server.port);
		clients.push(extra);
		try {
			await extra.open();
			extra.send({ type: 'hello', playerId: 'extra-player', name: 'Extra', version: PROTOCOL_VERSION });
			await extra.waitFor('full');
			await extra.until(() => extra.closed);
			assert.equal(extra.closeCode, 4003);
		} finally {
			for (const c of clients) c.close();
			clients.length = 0;
			await sleep(200);
		}
		assert.equal(server.lobby.clients.size, 0);
	});

	it('vote at 0:30, extend, rtv and map change (fake clock)', async () => {
		const { c } = await join('Voter');
		const base = clock - (MAP_DURATION - server.lobby.timeLeft()) * 1000;
		// Scheduled vote.
		clock = base + (MAP_DURATION - VOTE_AT) * 1000 + 10;
		server.lobby.updateRotation();
		const vs = await c.waitFor('voteStart');
		assert.equal(vs.rtv, false);
		assert.equal(vs.options.length, 4);
		assert.deepEqual(vs.options[3], { kind: 'extend' });
		assert.equal(vs.options.some((o) => o.kind === 'map' && o.mapId === 'surf_a'), false);
		await c.waitFor('chat', (m) => m.system === true && m.text.includes('Vote for the next map'));
		c.send({ type: 'vote', option: 4 });
		const vu = await c.waitFor('voteUpdate');
		assert.deepEqual(vu.counts, [0, 0, 0, 1]);
		clock += VOTE_DURATION * 1000;
		server.lobby.updateRotation();
		const ve = await c.waitFor('voteEnd');
		assert.deepEqual(ve.winner, { kind: 'extend' });
		const tl = await c.waitFor('timeLeft', (m) => m.mapTimeLeft > 600);
		assert.ok(tl.mapTimeLeft >= 600 && tl.mapTimeLeft <= 610);

		// RTV (solo voter => opens at once, no extend option).
		await sleep(1100);
		let n = c.messages.length;
		c.send({ type: 'chat', text: '!rtv' });
		const rv = await c.waitFor('voteStart', () => true, n);
		assert.equal(rv.rtv, true);
		assert.equal(rv.options.some((o) => o.kind === 'extend'), false);
		await c.waitFor('chat', (m) => m.system === true && m.text.includes('wants to vote for a new map'), n);
		c.send({ type: 'vote', option: 2 });
		await c.waitFor('voteUpdate', (m) => m.counts[1] === 1, n);
		clock += VOTE_DURATION * 1000;
		server.lobby.updateRotation();
		const re = await c.waitFor('voteEnd', () => true, n);
		assert.deepEqual(re.winner, rv.options[1]);
		assert.equal(re.countdown, 5);
		clock += 5000;
		server.lobby.updateRotation();
		const mc = await c.waitFor('mapChange', () => true, n);
		assert.equal(mc.map, (rv.options[1] as { mapId: string }).mapId);
		assert.equal(mc.mapTimeLeft, MAP_DURATION);
		assert.equal(mc.cvars.sv_maxvelocity, 3500);
		assert.equal(mc.records.pbTicks, null);
		assert.equal(server.lobby.currentMap.id, mc.map);

		// rtv blocked for the first 20 seconds.
		await sleep(1100);
		n = c.messages.length;
		c.send({ type: 'chat', text: '!rtv' });
		const blocked = await c.waitFor('chat', (m) => m.system === true && m.text.includes('available in 20 s'), n);
		assert.ok(blocked);
		clock += 20_000;
		await sleep(1100);
		n = c.messages.length;
		c.send({ type: 'chat', text: '!rtv' });
		await c.waitFor('voteStart', () => true, n);
		c.close();
		await c.until(() => c.closed);
		await sleep(100);
	});

	it('changeMap: allowed for a lone player, rejected with others connected', async () => {
		const { c } = await join('Loner');
		const from = server.lobby.currentMap.id;
		const target = MAPS.find((m) => m.id !== from)!.id;
		// Open an rtv vote first: the switch must cancel it.
		let n = c.messages.length;
		if (!server.lobby.rotation.vote) {
			clock += 60_000;
			c.send({ type: 'rtv' });
			await c.waitFor('voteStart', () => true, n);
		}
		assert.ok(server.lobby.rotation.vote);

		n = c.messages.length;
		c.send({ type: 'changeMap', mapId: 'nope' });
		await c.waitFor('chat', (m) => m.system === true && m.text.includes('Unknown map'), n);
		assert.equal(server.lobby.currentMap.id, from);

		n = c.messages.length;
		c.send({ type: 'changeMap', mapId: target });
		const mc = await c.waitFor('mapChange', () => true, n);
		assert.equal(mc.map, target);
		assert.equal(mc.mapTimeLeft, MAP_DURATION);
		assert.equal(mc.cvars.sv_maxvelocity, 3500);
		assert.equal(mc.records.pbTicks, null);
		assert.equal(server.lobby.currentMap.id, target);
		assert.equal(server.lobby.rotation.vote, null);
		assert.equal(server.lobby.rotation.nextMap, null);

		// A second client (even a spectator) blocks it.
		const { c: other } = await join('Other');
		other.send({ type: 'chat', text: '!spec' });
		await c.waitFor('spectating', (m) => m.spectating, c.messages.length - 1);
		n = c.messages.length;
		c.send({ type: 'changeMap', mapId: from });
		await c.waitFor('chat', (m) => m.system === true && m.text.includes('starts a map vote request'), n);
		assert.equal(server.lobby.currentMap.id, target);
		other.send({ type: 'changeMap', mapId: from });
		await other.waitFor('chat', (m) => m.system === true && m.text.includes('starts a map vote request'));
		assert.equal(server.lobby.currentMap.id, target);

		// Alone again: allowed.
		other.close();
		await c.waitFor('leave', () => true, n);
		n = c.messages.length;
		c.send({ type: 'changeMap', mapId: from });
		await c.waitFor('mapChange', (m) => m.map === from, n);
		assert.equal(server.lobby.currentMap.id, from);
		c.close();
		await c.until(() => c.closed);
		await sleep(100);
	});

	it('duplicate player id replaces the old connection', async () => {
		const pid = crypto.randomUUID();
		const { c: a } = await join('Dup', pid);
		await join('Dup', pid);
		await a.until(() => a.closed);
		assert.equal(a.closeCode, 4002);
	});
});

describe('accounts', () => {
	it('register validation: spaces, short password, per-connection limit, duplicate (case-insensitive)', async () => {
		const { c } = await join('Reg');
		assert.deepEqual(await c.auth('register', 'has space', 'secret1'), {
			type: 'auth',
			ok: false,
			error: 'Username cannot contain spaces.'
		});
		assert.deepEqual(await c.auth('register', 'Short', '1234'), {
			type: 'auth',
			ok: false,
			error: 'Password must be at least 5 characters.'
		});
		assert.equal((await c.auth('register', 'tab\there', 'secret1')).ok, false);
		const limited = await c.auth('register', 'Fine', 'secret1');
		assert.equal(limited.ok, false);
		if (!limited.ok) assert.match(limited.error, /Too many attempts/);
		assert.equal(server.db.accountByName('Fine'), null);

		const { c: b, welcome } = await join('Newbie');
		assert.equal(welcome.account, null);
		const ok = await b.auth('register', 'Acc1', 'secret1');
		assert.equal(ok.ok, true);
		if (ok.ok) {
			assert.equal(ok.username, 'Acc1');
			assert.equal(typeof ok.token, 'string');
			assert.ok(ok.records);
		}
		const { c: d } = await join('Dupe');
		assert.deepEqual(await d.auth('register', 'ACC1', 'secret1'), { type: 'auth', ok: false, error: 'That username is taken.' });
		for (const x of [c, b, d]) x.close();
	});

	it('login ok/wrong, rename broadcast, !name disabled; second login kicks the first', async () => {
		const { c: watcher } = await join('Watcher');
		const { c, welcome } = await join('Guesty');
		assert.deepEqual(await c.auth('login', 'acc1', 'wrong!'), { type: 'auth', ok: false, error: 'Wrong username or password.' });
		assert.deepEqual(await c.auth('login', 'nobody_here', 'secret1'), {
			type: 'auth',
			ok: false,
			error: 'Wrong username or password.'
		});
		const ok = await c.auth('login', 'acc1', 'secret1');
		assert.ok(ok.ok && ok.username === 'Acc1' && typeof ok.token === 'string');
		await watcher.waitFor('rename', (m) => m.id === welcome.selfId && m.name === 'Acc1');
		await watcher.waitFor('chat', (m) => m.system === true && m.text === 'Guesty logged in as Acc1.');
		const n = c.messages.length;
		c.send({ type: 'chat', text: '!name Other' });
		await c.waitFor('chat', (m) => m.system === true && m.text.includes("You're logged in as Acc1"), n);
		c.send({ type: 'name', name: 'Other' });
		await c.barrier();
		assert.equal(server.lobby.scoreRows().find((r) => r.id === welcome.selfId)?.name, 'Acc1');
		const again = await c.auth('login', 'acc1', 'secret1');
		assert.equal(again.ok, false);

		const { c: second } = await join('Elsewhere');
		assert.equal((await second.auth('login', 'Acc1', 'secret1')).ok, true);
		await c.until(() => c.closed);
		assert.equal(c.closeCode, 4002);
		second.close();
		watcher.close();
	});

	it('token auto-login via hello, expired/unknown token, logout', async () => {
		const { c } = await join('Tok');
		const reg = await c.auth('register', 'TokUser', 'secret1');
		assert.ok(reg.ok && reg.token);
		const token = reg.ok ? reg.token! : '';

		const r = new TestClient(server.port);
		clients.push(r);
		const w = await r.hello('ignored name', undefined, token);
		assert.deepEqual(w.account, { username: 'TokUser', admin: false });
		assert.equal(w.players.find((p) => p.id === w.selfId)?.name, 'TokUser');
		await c.until(() => c.closed);
		assert.equal(c.closeCode, 4002, 'the token login kicked the older connection');

		const bad = new TestClient(server.port);
		clients.push(bad);
		const wb = await bad.hello('Lost', undefined, 'not-a-real-token');
		assert.equal(wb.account, null);
		const rejected = await bad.waitFor('auth');
		assert.equal(rejected.ok, false);

		const out = await r.auth('logout');
		assert.equal(out.ok, true);
		if (out.ok) assert.equal(out.username, null);
		await r.waitFor('rename', (m) => m.id === w.selfId && m.name === 'ignored name');
		const after = new TestClient(server.port);
		clients.push(after);
		assert.equal((await after.hello('Later', undefined, token)).account, null, 'logout deleted the session');
		for (const x of [r, bad, after]) x.close();
	});

	it('rate limit: 5 failed logins per minute per connection and per username', async () => {
		server.db.createAccount('Limited', await hashPassword('right-pass'));
		const { c } = await join('Brute');
		const { c: owner } = await join('Owner');
		for (let i = 0; i < 5; i++) assert.equal((await c.auth('login', 'Limited', `wrong${i}`)).ok, false);
		const blocked = await c.auth('login', 'Limited', 'right-pass');
		assert.ok(!blocked.ok && /Too many attempts/.test(blocked.error));
		const other = await owner.auth('login', 'limited', 'right-pass');
		assert.ok(!other.ok && /Too many attempts/.test(other.error), 'username is locked for every connection');
		clock += 61_000;
		assert.equal((await owner.auth('login', 'Limited', 'right-pass')).ok, true);
		c.close();
		owner.close();
	});

	it('guest runs are not saved; logged-in runs are saved and shown in !top', async () => {
		const { c } = await join('Walker');
		const before = server.db.countRuns(server.lobby.currentMap.id);
		const first = await run(c);
		assert.equal(first.type, 'chat');
		if (first.type === 'chat') assert.match(first.text, /guest run, not saved\)\. Log in to save runs to the leaderboard\./);
		await sleep(1100);
		const second = await run(c);
		assert.ok(second.type === 'chat' && !second.text.includes('Log in'), 'hint shown once per connection');
		assert.equal(server.db.countRuns(server.lobby.currentMap.id), before);
		let n = c.messages.length;
		c.send({ type: 'chat', text: '!pb' });
		await c.waitFor('chat', (m) => m.system === true && m.text.startsWith('Guests have no PBs'), n);

		assert.equal((await c.auth('register', 'WalkerAcc', 'secret1')).ok, true);
		await sleep(1100);
		const saved = await run(c, { totalTicks: 448 });
		assert.equal(saved.type, 'runResult');
		if (saved.type === 'runResult') {
			assert.equal(saved.pb, true);
			assert.equal(saved.records.pbTicks, 448);
		}
		n = c.messages.length;
		c.send({ type: 'chat', text: '!top' });
		await c.waitFor('chat', (m) => m.system === true && /WalkerAcc {2}\d\d:/.test(m.text), n);
		const row = server.lobby.scoreRows().find((r) => r.name === 'WalkerAcc');
		assert.equal(row?.pbTicks, 448);
		c.close();
	});
});
