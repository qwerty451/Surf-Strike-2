import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AdminAction } from '@surf/shared';
import { ADMIN_COINS_MAX, CLOSE_IP_LIMIT } from '@surf/shared';
import { clientIp, ipKey, parseAdminUsernames } from './admin.ts';
import type { GameServer } from './server.ts';
import { startServer } from './server.ts';
import { TestClient, testMap } from './test-helpers.ts';

const MAPS = [testMap('surf_a', 'Alpha'), testMap('surf_b', 'Bravo'), testMap('surf_c', 'Charlie')];

let clock = 2_000_000_000;
let server: GameServer;
let dir: string;
let dbPath: string;
const clients: TestClient[] = [];

function start() {
	return startServer({
		port: 0,
		host: '127.0.0.1',
		dbPath,
		maps: MAPS,
		initialMap: 'surf_a',
		now: () => clock,
		rng: () => 0,
		log: () => {},
		adminUsernames: parseAdminUsernames('Tim, other_admin')
	});
}

function client(headers?: Record<string, string>) {
	const c = new TestClient(server.port, headers);
	clients.push(c);
	return c;
}

async function join(name: string, opts: { playerId?: string; token?: string; headers?: Record<string, string>; map?: string } = {}) {
	const c = client(opts.headers);
	const welcome = await c.hello(name, opts.playerId, opts.token, opts.map);
	return { c, welcome };
}

/** Send an admin action; wait for its adminResult (and the adminState that follows, for admins). */
async function admin(c: TestClient, action: AdminAction) {
	const n = c.messages.length;
	c.send({ type: 'admin', action });
	const result = await c.waitFor('adminResult', () => true, n);
	return result;
}

async function adminState(c: TestClient, from = 0) {
	return c.waitFor('adminState', () => true, from);
}

/** Hello that is expected to be refused (banned). */
async function bannedHello(name: string, opts: { playerId?: string; token?: string; headers?: Record<string, string> } = {}) {
	const c = client(opts.headers);
	await c.open();
	c.send({ type: 'hello', playerId: opts.playerId ?? crypto.randomUUID(), name, version: 2, ...(opts.token ? { token: opts.token } : {}) });
	await c.until(() => c.closed, 3000);
	return c;
}

let timToken = '';
let tim: TestClient;

before(async () => {
	dir = mkdtempSync(pathJoin(tmpdir(), 'surf-admin-'));
	dbPath = pathJoin(dir, 'admin.db');
	server = await start();
});

after(async () => {
	for (const c of clients) c.close();
	await server.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('admin', () => {
	it('parses ADMIN_USERNAMES (default tim, case-insensitive)', () => {
		assert.deepEqual(parseAdminUsernames(undefined), ['tim']);
		assert.deepEqual(parseAdminUsernames(''), []);
		assert.deepEqual(parseAdminUsernames(' Tim ,BOB,, '), ['tim', 'bob']);
	});

	it('clientIp: CF-Connecting-IP only via loopback; never a loopback address', () => {
		const req = (remoteAddress: string, cf?: string) =>
			({ socket: { remoteAddress }, headers: cf ? { 'cf-connecting-ip': cf } : {} }) as Parameters<typeof clientIp>[0];
		assert.equal(clientIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
		assert.equal(clientIp(req('::ffff:127.0.0.1', '2001:db8::1')), '2001:db8::1');
		assert.equal(clientIp(req('127.0.0.1')), null);
		assert.equal(clientIp(req('127.0.0.1', 'not-an-ip')), null);
		assert.equal(clientIp(req('127.0.0.1', '127.0.0.1')), null);
		assert.equal(clientIp(req('192.168.1.20', '203.0.113.7')), '192.168.1.20', 'header ignored off loopback');
		assert.equal(clientIp(req('::ffff:192.168.1.20')), '192.168.1.20');
	});

	it('admin is decided by the logged-in account only', async () => {
		const { c: guest, welcome } = await join('Tim');
		assert.equal(welcome.account, null);
		const denied = await admin(guest, { action: 'listBans' });
		assert.deepEqual(denied, { type: 'adminResult', ok: false, error: 'You are not an admin.' });
		assert.equal(guest.of('adminState').length, 0, 'non-admins never get admin state');

		const reg = await guest.auth('register', 'Tim', 'secret1');
		assert.ok(reg.ok && reg.admin === true && reg.token);
		timToken = reg.ok ? reg.token! : '';
		const state = await adminState(guest);
		assert.deepEqual(
			state.maps.map((m) => [m.id, m.enabled]),
			[
				['surf_a', true],
				['surf_b', true],
				['surf_c', true]
			]
		);
		guest.close();

		// Token auto-login: welcome says admin.
		const { c, welcome: w } = await join('whatever', { token: timToken });
		assert.deepEqual(w.account, { username: 'Tim', admin: true });
		tim = c;
		assert.equal((await admin(tim, { action: 'listBans' })).ok, true);
	});

	it('guests cannot use a registered username (any casing); falls back to Guest-xxxx', async () => {
		const { c, welcome } = await join('tIM', { playerId: 'abcd1234-0000-4000-8000-000000000000' });
		const self = welcome.players.find((p) => p.id === welcome.selfId)!;
		assert.equal(self.name, 'Guest-abcd');
		await c.waitFor('chat', (m) => m.system === true && m.text.includes('belongs to a registered account'));
		assert.equal((await admin(c, { action: 'setMapEnabled', mapId: 'surf_b', enabled: false })).ok, false, 'non-admin ignored');

		const n = c.messages.length;
		c.send({ type: 'chat', text: '!name TIM' });
		await c.waitFor('chat', (m) => m.system === true && m.text.includes('belongs to a registered account'), n);
		c.send({ type: 'name', name: 'tim' });
		await c.barrier();
		assert.equal(server.lobby.scoreRows().find((r) => r.id === welcome.selfId)?.name, 'Guest-abcd');
		// Real admin is marked on the scoreboard and in chat; the guest is not.
		assert.equal(server.lobby.scoreRows().find((r) => r.name === 'Tim')?.admin, true);
		assert.equal(server.lobby.scoreRows().find((r) => r.id === welcome.selfId)?.admin, undefined);
		const m = c.messages.length;
		tim.send({ type: 'chat', text: 'hello all' });
		const line = await c.waitFor('chat', (x) => x.text === 'hello all', m);
		assert.equal(line.admin, true);
		c.close();
	});

	it('disabled maps cannot be joined; the last map cannot be disabled', async () => {
		const { c: watcher } = await join('Watcher');
		const n = watcher.messages.length;
		const r = await admin(tim, { action: 'setMapEnabled', mapId: 'surf_b', enabled: false });
		assert.equal(r.ok, true);
		const maps = await watcher.waitFor('maps', () => true, n);
		assert.deepEqual(maps.enabled, ['surf_a', 'surf_c']);
		const last = await admin(tim, { action: 'setMapEnabled', mapId: 'surf_c', enabled: false });
		assert.equal(last.ok, true);
		// Only surf_a (current) left enabled: it cannot be disabled too.
		const none = await admin(tim, { action: 'setMapEnabled', mapId: 'surf_a', enabled: false });
		assert.deepEqual(none, { type: 'adminResult', ok: false, error: 'At least one map must stay enabled.' });
		assert.equal((await admin(tim, { action: 'setMapEnabled', mapId: 'surf_c', enabled: true })).ok, true);

		// A non-admin asking for the disabled lobby lands on the default map.
		const { welcome: wb } = await join('WantsB', { map: 'surf_b' });
		assert.equal(wb.map, 'surf_a');

		// A newcomer gets the enabled list after welcome.
		const { c: late } = await join('Late');
		assert.deepEqual((await late.waitFor('maps')).enabled, ['surf_a', 'surf_c']);
		late.close();
		watcher.close();
	});

	it('only admins join a disabled lobby; players already in it stay', async () => {
		// surf_b is disabled (previous test). An admin can join it; a hello for it works too.
		const n = tim.messages.length;
		tim.send({ type: 'changeMap', mapId: 'surf_b' });
		const ch = await tim.waitFor('mapChange', () => true, n);
		assert.equal(ch.map, 'surf_b');
		const k = tim.messages.length;
		const st = await admin(tim, { action: 'listBans' });
		assert.equal(st.ok, true);
		const state = await adminState(tim, k);
		assert.equal(state.players.find((p) => p.name === 'Tim')?.map, 'surf_b');

		// A non-admin cannot follow; a non-admin already there stays when it gets disabled.
		const { c } = await join('Solo');
		const m = c.messages.length;
		c.send({ type: 'changeMap', mapId: 'surf_b' });
		await c.waitFor('chat', (x) => x.system === true && x.text === 'That map is disabled by an admin.', m);
		c.send({ type: 'changeMap', mapId: 'surf_c' });
		await c.waitFor('mapChange', (x) => x.map === 'surf_c', m);
		assert.equal((await admin(tim, { action: 'setMapEnabled', mapId: 'surf_c', enabled: false })).ok, true);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(server.lobby.mapOf(server.lobby.scoreRows('surf_c')[0]!.id), 'surf_c');
		assert.equal((await admin(tim, { action: 'setMapEnabled', mapId: 'surf_c', enabled: true })).ok, true);
		c.close();
		tim.send({ type: 'changeMap', mapId: 'surf_a' });
		await tim.waitFor('mapChange', (x) => x.map === 'surf_a', n);
	});

	it('ban a connected account: kicked with 4009, login and token refused; unban restores', async () => {
		const { c: bob } = await join('BobGuest');
		const reg = await bob.auth('register', 'Bob', 'secret1');
		assert.ok(reg.ok);
		const bobToken = reg.ok ? reg.token! : '';
		const bobId = server.lobby.scoreRows().find((r) => r.name === 'Bob')!.id;

		// Admins cannot be banned (by id or username), nor themselves.
		const timId = server.lobby.scoreRows().find((r) => r.name === 'Tim')!.id;
		assert.equal((await admin(tim, { action: 'ban', targetId: timId })).ok, false);
		assert.deepEqual(await admin(tim, { action: 'ban', username: 'OTHER_ADMIN' }), {
			type: 'adminResult',
			ok: false,
			error: 'No account named "OTHER_ADMIN".'
		});
		server.db.createAccount('other_admin', 'x');
		assert.deepEqual(await admin(tim, { action: 'ban', username: 'Other_Admin' }), {
			type: 'adminResult',
			ok: false,
			error: 'Admins cannot be banned.'
		});

		const r = await admin(tim, { action: 'ban', targetId: bobId, reason: 'griefing' });
		assert.equal(r.ok, true);
		await bob.until(() => bob.closed);
		assert.equal(bob.closeCode, 4009);
		assert.deepEqual(bob.of('banned'), [{ type: 'banned', reason: 'griefing' }]);
		const st = await adminState(tim, tim.messages.length - 1);
		const ban = st.bans.find((b) => b.username === 'Bob')!;
		assert.equal(ban.kind, 'account');
		assert.equal(ban.reason, 'griefing');
		assert.equal(ban.createdBy, 'Tim');

		// Token auto-login refused.
		const t = await bannedHello('Bob?', { token: bobToken });
		assert.equal(t.closeCode, 4009);
		assert.equal(t.of('welcome').length, 0);
		// Password login refused (from a fresh guest connection).
		const { c: g } = await join('Fresh');
		const login = await g.auth('login', 'bob', 'secret1');
		assert.deepEqual(login, { type: 'auth', ok: false, error: 'This account is banned.' });
		await g.until(() => g.closed);
		assert.equal(g.closeCode, 4009);

		assert.equal((await admin(tim, { action: 'unban', banId: ban.id })).ok, true);
		assert.equal((await admin(tim, { action: 'unban', banId: ban.id })).ok, false);
		const { c: back, welcome } = await join('Bob again', { token: bobToken });
		assert.deepEqual(welcome.account, { username: 'Bob', admin: false });
		back.close();
	});

	it('offline account ban by username', async () => {
		const { c } = await join('Carol0');
		const reg = await c.auth('register', 'Carol', 'secret1');
		const token = reg.ok ? reg.token! : '';
		c.close();
		await new Promise((r) => setTimeout(r, 50));
		assert.equal((await admin(tim, { action: 'ban', username: 'carol' })).ok, true);
		assert.equal((await admin(tim, { action: 'ban', username: 'carol' })).ok, false, 'already banned');
		const t = await bannedHello('x', { token });
		assert.equal(t.closeCode, 4009);
	});

	it('ban a guest: player key and CF-Connecting-IP are blocked; admins on that IP are not', async () => {
		const headers = { 'cf-connecting-ip': '198.51.100.23' };
		const key = crypto.randomUUID();
		const { c: g, welcome } = await join('Griefer', { playerId: key, headers });
		const r = await admin(tim, { action: 'ban', targetId: welcome.selfId });
		assert.equal(r.ok, true);
		await g.until(() => g.closed);
		assert.equal(g.closeCode, 4009);
		assert.equal((await bannedHello('Again', { playerId: key })).closeCode, 4009, 'same key');
		assert.equal((await bannedHello('NewKey', { headers })).closeCode, 4009, 'same IP, new key');
		const { welcome: ok } = await join('Elsewhere', { headers: { 'cf-connecting-ip': '198.51.100.99' } });
		assert.equal(ok.account, null);
		const { welcome: adminSameIp } = await join('t', { token: timToken, headers });
		assert.deepEqual(adminSameIp.account, { username: 'Tim', admin: true });
		tim = clients[clients.length - 1];
	});

	it('coins: add, subtract and reset, online and offline; never below zero, lifetime points stay', async () => {
		const { c: dave } = await join('Dave0');
		assert.ok((await dave.auth('register', 'Dave', 'secret1')).ok);
		const id = server.db.accountByName('dave')!.id;
		server.db.adjustBalance({ accountId: id, at: 1, reason: 'test', label: 'x' }, null); // without the welcome bonus
		server.db.db.prepare('DELETE FROM point_log WHERE account_id = ?').run(id);
		const stats = () => server.db.accountStats(id);

		// Non-admins change nothing.
		assert.equal((await admin(dave, { action: 'coins', username: 'Dave', op: 'add', amount: 50 })).ok, false);
		assert.equal(stats().pointsBalance, 0);

		const n = dave.messages.length;
		const r = await admin(tim, { action: 'coins', username: 'dave', op: 'add', amount: 50 });
		assert.deepEqual(r, { type: 'adminResult', ok: true, message: 'Dave: +50 coins, now 50 coins.' });
		const coins = await dave.waitFor('coins', () => true, n);
		assert.equal(coins.balance, 500);
		assert.equal(coins.total, 0, 'lifetime points stay');
		assert.deepEqual(coins.recent.map((e) => [e.reason, e.amount]), [['admin', 500]]);
		assert.equal((await dave.waitFor('coinsNotice', () => true, n)).text, 'An admin gave you 50 coins.');
		const st = await adminState(tim, tim.messages.length - 1);
		assert.equal(st.players.find((p) => p.account === 'Dave')?.coins, 500);

		assert.equal((await admin(tim, { action: 'coins', username: 'Dave', op: 'subtract', amount: 20 })).ok, true);
		assert.equal(stats().pointsBalance, 300);

		// Offline: subtracting more than there is stops at zero and logs what was taken.
		dave.close();
		await new Promise((res) => setTimeout(res, 50));
		assert.deepEqual(await admin(tim, { action: 'coins', username: 'Dave', op: 'subtract', amount: 999 }), {
			type: 'adminResult',
			ok: true,
			message: 'Dave: -30 coins, now 0 coins.'
		});
		assert.equal(stats().pointsBalance, 0);
		const rows = () => server.db.recentPoints(id, 20).length;
		assert.equal(rows(), 3);
		const none = await admin(tim, { action: 'coins', username: 'Dave', op: 'reset' });
		assert.ok(none.ok && none.message === 'Dave already has 0 coins.');
		assert.equal(rows(), 3, 'nothing changed, nothing logged');
		await admin(tim, { action: 'coins', username: 'Dave', op: 'add', amount: 7 });
		assert.equal((await admin(tim, { action: 'coins', username: 'Dave', op: 'reset' })).ok, true);
		assert.deepEqual([stats().pointsBalance, stats().pointsTotal, server.db.countedSince(id, 0)], [0, 0, 0]);

		// Bad requests.
		for (const amount of [0, -5, 1.5, NaN, ADMIN_COINS_MAX + 1, '5' as never, undefined]) {
			assert.equal((await admin(tim, { action: 'coins', username: 'Dave', op: 'add', amount })).ok, false, String(amount));
		}
		assert.equal((await admin(tim, { action: 'coins', username: 'Dave', op: 'set' as never, amount: 5 })).ok, false);
		assert.equal((await admin(tim, { action: 'coins', username: 'nobody', op: 'reset' })).ok, false);
		assert.equal(stats().pointsBalance, 0);
		// Admins can change their own balance too.
		assert.equal((await admin(tim, { action: 'coins', username: 'Tim', op: 'add', amount: 1 })).ok, true);
	});

	it('gives an item to a connected account, once; not to guests, nothing unknown', async () => {
		const { c: eve } = await join('Eve0');
		const id = server.lobby.scoreRows().find((r) => r.name === 'Eve0')!.id;
		assert.match(String(((await admin(tim, { action: 'giveItem', targetId: id, item: 'hat_joker' })) as { error?: string }).error), /Guests/);
		assert.ok((await eve.auth('register', 'Eve', 'secret1')).ok);
		const n = eve.messages.length;
		assert.deepEqual(await admin(tim, { action: 'giveItem', targetId: id, item: 'hat_joker' }), { type: 'adminResult', ok: true, message: 'Eve got Clown prince mask.' });
		assert.deepEqual((await eve.waitFor('shop', () => true, n)).owned, ['hat_joker']);
		assert.match((await eve.waitFor('coinsNotice', (m) => /gave you/.test(m.text), n)).text, /Clown prince mask/);
		for (const bad of [{ targetId: id, item: 'hat_joker' }, { targetId: id, item: 'nope' }, { targetId: id, item: 'top_default' }, { targetId: 9999, item: 'hat_cap' }]) {
			assert.equal((await admin(tim, { action: 'giveItem', ...bad })).ok, false);
		}
		assert.equal((await admin(eve, { action: 'giveItem', targetId: id, item: 'hat_cap' })).ok, false, 'no admin');

		// Taken away again, also while worn.
		const state = () => tim.of('adminState').at(-1)!.players.find((p) => p.id === id)!;
		eve.send({ type: 'shopEquip', slot: 'hat', item: 'hat_joker' });
		await eve.waitFor('shopResult', (m) => m.ok && m.action === 'equip');
		await admin(tim, { action: 'listBans' });
		assert.deepEqual(state().items, ['hat_joker']);
		const k = eve.messages.length;
		assert.deepEqual(await admin(tim, { action: 'takeItem', targetId: id, item: 'hat_joker' }), {
			type: 'adminResult',
			ok: true,
			message: 'Removed Clown prince mask from Eve.'
		});
		const shop = await eve.waitFor('shop', () => true, k);
		assert.deepEqual([shop.owned, shop.loadout.hat], [[], null]);
		assert.match((await eve.waitFor('coinsNotice', (m) => /removed/.test(m.text), k)).text, /Clown prince mask/);
		await eve.waitFor('cosmetics', (m) => m.id === id && m.loadout.hat === null, k);
		for (const bad of [{ targetId: id, item: 'hat_joker' }, { targetId: id, item: 'nope' }, { targetId: 9999, item: 'hat_cap' }]) {
			assert.equal((await admin(tim, { action: 'takeItem', ...bad })).ok, false);
		}
		assert.equal((await admin(eve, { action: 'takeItem', targetId: id, item: 'hat_joker' })).ok, false, 'no admin');
		eve.close();
	});

	it('writes admin_log rows', () => {
		const rows = server.db.db.prepare('SELECT admin_username, action, target FROM admin_log ORDER BY id').all() as {
			admin_username: string;
			action: string;
			target: string | null;
		}[];
		const actions = rows.map((r) => r.action);
		for (const a of ['disable-map', 'enable-map', 'ban', 'unban', 'coins-add', 'coins-subtract', 'coins-reset']) assert.ok(actions.includes(a), a);
		assert.ok(rows.every((r) => r.admin_username === 'Tim'));
		assert.ok(rows.some((r) => r.action === 'ban' && r.target === 'account Bob'));
	});

	it('map settings and bans persist across a restart (same DB file)', async () => {
		for (const c of clients) c.close();
		await server.close();
		server = await start();
		const { c } = await join('Again');
		assert.deepEqual((await c.waitFor('maps')).enabled, ['surf_a', 'surf_c']);
		const { c: t } = await join('t', { token: timToken });
		const st = await admin(t, { action: 'listBans' }).then(() => adminState(t));
		assert.ok(st.bans.some((b) => b.username === 'Carol' && b.kind === 'account'));
		assert.ok(st.bans.some((b) => b.username === 'Griefer' && b.kind === 'guest'));
		assert.ok(st.players.some((p) => p.name === 'Tim' && p.admin && p.account === 'Tim'));
		assert.ok(st.players.some((p) => p.name === 'Again' && p.guest && !p.admin));
		assert.equal((await bannedHello('Again', { headers: { 'cf-connecting-ip': '198.51.100.23' } })).closeCode, 4009);
	});
});

describe('connection limit per IP', () => {
	it('ipKey: IPv4 as is, IPv6 per /64', () => {
		assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
		assert.equal(ipKey('2001:db8:1:2:aaaa::1'), ipKey('2001:0DB8:0001:0002::ffff'));
		assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
		assert.equal(ipKey('2001:db8::1'), ipKey('2001:db8:0:0:5:6:7:8'));
	});

	it('maxPerIp: the 4th client is refused, a reload and other addresses are not, a leaver frees a slot', async () => {
		const d = mkdtempSync(pathJoin(tmpdir(), 'surf-iplimit-'));
		const s = await startServer({ port: 0, host: '127.0.0.1', dbPath: pathJoin(d, 't.db'), maps: MAPS, log: () => {}, maxPerIp: 3 });
		const all: TestClient[] = [];
		const open = (headers?: Record<string, string>) => {
			const c = new TestClient(s.port, headers);
			all.push(c);
			return c;
		};
		const refused = async (headers: Record<string, string>) => {
			const c = open(headers);
			await c.open();
			c.send({ type: 'hello', version: 0, playerId: crypto.randomUUID(), name: 'Bot' });
			await c.until(() => c.closed);
			assert.equal(c.closeCode, CLOSE_IP_LIMIT);
		};
		try {
			const home = { 'cf-connecting-ip': '198.51.100.7' };
			const pid = crypto.randomUUID();
			await open(home).hello('A', pid);
			const b = open(home);
			await b.hello('B');
			await open(home).hello('C');
			await refused(home);
			await open({ 'cf-connecting-ip': '198.51.100.8' }).hello('Elsewhere');
			await open(home).hello('A', pid); // reload
			await refused(home);
			b.close();
			await b.until(() => b.closed);
			await new Promise((r) => setTimeout(r, 50));
			await open(home).hello('D');
			for (let i = 0; i < 5; i++) await open().hello(`Dev${i}`); // unknown address: no limit
			assert.equal(s.lobby.playerCount, 9);
		} finally {
			for (const c of all) c.close();
			await s.close();
			rmSync(d, { recursive: true, force: true });
		}
	});
});
