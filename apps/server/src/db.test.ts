import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { Accounts, AttemptLimiter, hashPassword, tokenHash, verifyPassword, WRONG_LOGIN } from './auth.ts';
import { Db } from './db.ts';

describe('Db', () => {
	it('keeps only the best run per account per map', () => {
		const db = new Db(':memory:');
		const a = db.createAccount('Alice', 'h', 1)!.id;
		const b = db.createAccount('Bob', 'h', 1)!.id;
		assert.deepEqual(db.saveRun(a, 'm', 1000, [400], 10), { pb: true, previous: null });
		assert.deepEqual(db.saveRun(a, 'm', 1200, [500], 11), { pb: false, previous: 1000 });
		assert.deepEqual(db.saveRun(a, 'm', 900, [300], 12), { pb: true, previous: 1000 });
		assert.deepEqual(db.getPb(a, 'm'), { ticks: 900, splits: [300], createdAt: 12 });
		db.saveRun(b, 'm', 950, [], 13);
		db.saveRun(b, 'other', 10, [], 13);
		assert.equal(db.countRuns('m'), 2);
		assert.deepEqual(
			db.top('m').map((r) => [r.name, r.ticks]),
			[
				['Alice', 900],
				['Bob', 950]
			]
		);
		assert.equal(db.rankFor('m', 900), 1);
		assert.equal(db.rankFor('m', 920), 2);
		assert.equal(db.rankFor('m', 2000), 3);
		assert.deepEqual([...db.ranks('m')], [
			[a, { rank: 1, ticks: 900 }],
			[b, { rank: 2, ticks: 950 }]
		]);
		const rows = db.db.prepare('SELECT COUNT(*) AS n FROM account_runs').get() as { n: number };
		assert.equal(rows.n, 3);
		db.close();
	});

	it('usernames are unique case-insensitively and keep their casing', () => {
		const db = new Db(':memory:');
		assert.ok(db.createAccount('Alice', 'h'));
		assert.equal(db.createAccount('aLICE', 'h'), null);
		assert.equal(db.accountByName('ALICE')?.username, 'Alice');
		db.close();
	});

	it('sessions expire and can be deleted', () => {
		const db = new Db(':memory:');
		const id = db.createAccount('Sess', 'h')!.id;
		db.createSession('t1', id, 2000, 1000);
		assert.equal(db.sessionAccount('t1', 1500)?.id, id);
		assert.equal(db.sessionAccount('t1', 2000), null);
		assert.equal(db.sessionAccount('t1', 1500), null, 'expired session was deleted');
		db.createSession('t2', id, 5000, 1000);
		db.deleteSession('t2');
		assert.equal(db.sessionAccount('t2', 1500), null);
		db.close();
	});

	it('migrates an existing database in place; legacy guest runs are kept but not on the leaderboard', () => {
		const dir = mkdtempSync(join(tmpdir(), 'surf-db-'));
		const path = join(dir, 'surf.db');
		try {
			const old = new Database(path);
			old.exec(`
				CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
				CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL REFERENCES players(id),
					map TEXT NOT NULL, time_ticks INTEGER NOT NULL, splits_json TEXT NOT NULL, created_at INTEGER NOT NULL,
					UNIQUE (player_id, map));
				INSERT INTO players VALUES ('legacy-uuid', 'Old', 1, 1);
				INSERT INTO runs (player_id, map, time_ticks, splits_json, created_at) VALUES ('legacy-uuid', 'm', 5, '[]', 1);
			`);
			old.close();
			const db = new Db(path);
			assert.equal((db.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 1);
			assert.deepEqual(db.top('m'), []);
			assert.equal(db.countRuns('m'), 0);
			db.close();
			// Opening again is a no-op.
			new Db(path).close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** The schema as it was before `account_stats` (the production database of 2026-11). */
const OLD_SCHEMA = `
	CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
	CREATE TABLE runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL REFERENCES players(id), map TEXT NOT NULL,
		time_ticks INTEGER NOT NULL, splits_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (player_id, map));
	CREATE INDEX runs_map_time ON runs (map, time_ticks);
	CREATE TABLE accounts (
		id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_login INTEGER NOT NULL);
	CREATE TABLE sessions (
		token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
	CREATE INDEX sessions_account ON sessions (account_id);
	CREATE TABLE account_runs (
		id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		map TEXT NOT NULL, time_ticks INTEGER NOT NULL, splits_json TEXT NOT NULL, created_at INTEGER NOT NULL,
		UNIQUE (account_id, map));
	CREATE INDEX account_runs_map_time ON account_runs (map, time_ticks);
	CREATE TABLE replays (
		map TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		time_ticks INTEGER NOT NULL, samples INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
	CREATE TABLE map_settings (map_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
	CREATE TABLE bans (
		id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
		player_key TEXT, ip TEXT, username_snapshot TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL);
	CREATE INDEX bans_account ON bans (account_id);
	CREATE INDEX bans_player_key ON bans (player_key);
	CREATE INDEX bans_ip ON bans (ip);
	CREATE TABLE admin_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, admin_account_id INTEGER,
		admin_username TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
	INSERT INTO players VALUES ('legacy-uuid', 'Old', 1, 2);
	INSERT INTO runs (player_id, map, time_ticks, splits_json, created_at) VALUES ('legacy-uuid', 'surf_ember', 5, '[]', 1);
	INSERT INTO accounts (username, username_lower, password_hash, created_at, last_login) VALUES
		('Tim', 'tim', 'hash-tim', 10, 20), ('Ana', 'ana', 'hash-ana', 11, 21);
	INSERT INTO sessions VALUES ('tok', 1, 10, 99999999999999);
	INSERT INTO account_runs (account_id, map, time_ticks, splits_json, created_at) VALUES
		(1, 'surf_ember', 9000, '[3000,6000]', 30), (2, 'surf_ember', 8800, '[2900]', 31), (2, 'bhop_meadow', 700, '[]', 32);
	INSERT INTO replays VALUES ('surf_ember', 2, 8800, 3, x'0102ff', 31);
	INSERT INTO map_settings VALUES ('surf_aurora', 0);
	INSERT INTO bans (account_id, username_snapshot, reason, created_at, created_by) VALUES (2, 'Ana', 'why', 40, 'Tim');
	INSERT INTO admin_log (created_at, admin_username, action) VALUES (41, 'Tim', 'ban');
`;

describe('account_stats migration', () => {
	const TABLES = ['players', 'runs', 'accounts', 'sessions', 'account_runs', 'replays', 'map_settings', 'bans', 'admin_log'];
	/** Columns a later schema added, with their value in old rows. */
	const ADDED: Record<string, Record<string, unknown>> = { bans: { expires_at: null } };
	/** Every old row and column; added columns are checked and left out. */
	const dump = (d: Database.Database) => ({
		rows: Object.fromEntries(
			TABLES.map((t) => [
				t,
				(d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[]).map((row) => {
					for (const [col, v] of Object.entries(ADDED[t] ?? {})) {
						if (!(col in row)) continue;
						assert.equal(row[col], v, `${t}.${col}`);
						delete row[col];
					}
					return row;
				})
			])
		),
		columns: Object.fromEntries(
			TABLES.map((t) => [t, (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).filter((c) => !(c.name in (ADDED[t] ?? {})))])
		)
	});
	const NEW_TABLES = ['account_stats', 'point_log', 'point_rollup', 'abuse_log', 'owned_items', 'equipped', 'casino_log', 'casino_stats', 'casino_crash', 'server_settings', 'trn_bets'];

	it('the schema with account_stats (before points): totals and permanent bans stay, new columns start empty', () => {
		const dir = mkdtempSync(join(tmpdir(), 'surf-db-'));
		const path = join(dir, 'surf.db');
		try {
			const old = new Database(path);
			old.exec(
				OLD_SCHEMA +
					`CREATE TABLE account_stats (
						account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
						playtime_secs INTEGER NOT NULL DEFAULT 0, points_total INTEGER NOT NULL DEFAULT 0, points_balance INTEGER NOT NULL DEFAULT 0);
					INSERT INTO account_stats VALUES (1, 3600, 0, 0), (2, 77, 509, 120);`
			);
			old.close();
			for (let i = 0; i < 2; i++) {
				const db = new Db(path); // the second time nothing is left to migrate
				assert.deepEqual(db.accountStats(2), { playtimeSecs: 77, pointsTotal: 509, pointsBalance: 120 });
				assert.equal(db.accountStats(1).playtimeSecs, 3600);
				assert.equal(db.activeMs(1), 0);
				const ban = db.accountBan(2, Number.MAX_SAFE_INTEGER);
				assert.equal(ban?.reason, 'why');
				assert.equal(ban?.expiresAt, null, 'old bans are permanent');
				assert.equal(db.deleteExpiredBans(Number.MAX_SAFE_INTEGER), 0);
				assert.equal(db.bans().length, 1);
				db.close();
			}
			const db = new Db(path);
			db.payPoints({ accountId: 2, at: 1, mode: 'hns', map: 'm', reason: 'hnsFind', label: 'x', base: 30, counted: 30, mult: 15, amount: 45 });
			db.setActiveMs(1, 1234.4);
			assert.deepEqual(db.accountStats(2), { playtimeSecs: 77, pointsTotal: 554, pointsBalance: 165 });
			assert.deepEqual(db.accountStats(1), { playtimeSecs: 3600, pointsTotal: 0, pointsBalance: 0 });
			assert.equal(db.activeMs(1), 1234);
			// The previous server's statements still work on it (rollback).
			db.db.exec(`INSERT INTO account_stats (account_id, playtime_secs) SELECT id, 5 FROM accounts WHERE id = 2
				ON CONFLICT(account_id) DO UPDATE SET playtime_secs = playtime_secs + excluded.playtime_secs`);
			db.db.exec(`INSERT INTO bans (account_id, player_key, ip, username_snapshot, reason, created_at, created_by) VALUES (1, NULL, NULL, 'Tim', NULL, 1, 'x')`);
			assert.equal(db.accountStats(2).playtimeSecs, 82);
			assert.equal(db.accountBan(1, 5)?.expiresAt, null);
			assert.equal(db.db.pragma('integrity_check', { simple: true }), 'ok');
			db.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('opens a database of the previous schema with every row and column intact, and only adds new tables and columns', () => {
		const dir = mkdtempSync(join(tmpdir(), 'surf-db-'));
		const path = join(dir, 'surf.db');
		try {
			const old = new Database(path);
			old.pragma('journal_mode = WAL');
			old.exec(OLD_SCHEMA);
			const before = dump(old);
			const tablesBefore = old.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).pluck().all() as string[];
			old.close();

			const db = new Db(path);
			assert.deepEqual(dump(db.db), before);
			const tablesAfter = db.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).pluck().all() as string[];
			assert.deepEqual(tablesAfter, [...tablesBefore, ...NEW_TABLES].sort());
			assert.equal((db.db.prepare('SELECT COUNT(*) AS n FROM account_stats').get() as { n: number }).n, 0);
			// Still readable through the API.
			assert.deepEqual(db.top('surf_ember').map((r) => [r.name, r.ticks]), [['Ana', 8800], ['Tim', 9000]]);
			assert.deepEqual(db.getPb(1, 'surf_ember'), { ticks: 9000, splits: [3000, 6000], createdAt: 30 });
			assert.equal(db.sessionAccount('tok')?.username, 'Tim');
			assert.equal(db.accountByName('TIM')?.passwordHash, 'hash-tim');
			assert.equal(db.getReplay('surf_ember')?.data.toString('hex'), '0102ff');
			assert.deepEqual([...db.disabledMaps()], ['surf_aurora']);
			assert.equal(db.accountBan(2, Date.now())?.reason, 'why');
			// Old accounts start at zero and can be counted.
			assert.deepEqual(db.accountStats(1), { playtimeSecs: 0, pointsTotal: 0, pointsBalance: 0 });
			db.addPlaytime([{ accountId: 1, secs: 61 }]);
			db.close();

			// Opening again keeps the new totals and still changes nothing else.
			const again = new Db(path);
			assert.deepEqual(again.accountStats(1), { playtimeSecs: 61, pointsTotal: 0, pointsBalance: 0 });
			assert.deepEqual(dump(again.db), before);
			again.close();

			// Rolling back to the old server: it ignores the extra table.
			const rollback = new Database(path);
			rollback.exec(OLD_SCHEMA.slice(0, OLD_SCHEMA.indexOf('INSERT')).replaceAll('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ').replaceAll('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS '));
			assert.deepEqual(dump(rollback), before);
			rollback.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('auth', () => {
	it('scrypt hashes verify, use a per-user salt and reject wrong passwords', async () => {
		const h1 = await hashPassword('hunter22');
		const h2 = await hashPassword('hunter22');
		assert.match(h1, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
		assert.notEqual(h1, h2);
		assert.equal(await verifyPassword('hunter22', h1), true);
		assert.equal(await verifyPassword('hunter23', h1), false);
		assert.equal(await verifyPassword('hunter22', 'garbage'), false);
	});

	it('register/login/resume/logout', async () => {
		const db = new Db(':memory:');
		const acc = new Accounts(db, () => 0);
		assert.deepEqual(await acc.register('has space', 'secret'), { ok: false, error: 'Username cannot contain spaces.' });
		assert.deepEqual(await acc.register('Neo', '1234'), { ok: false, error: 'Password must be at least 5 characters.' });
		const reg = await acc.register('Neo', 'secret');
		assert.equal(reg.ok, true);
		assert.deepEqual(await acc.register('NEO', 'other1'), { ok: false, error: 'That username is taken.' });
		const fails = new AttemptLimiter(5);
		assert.deepEqual(await acc.login('neo', 'wrong!', fails), { ok: false, error: WRONG_LOGIN });
		assert.deepEqual(await acc.login('nobody', 'secret', fails), { ok: false, error: WRONG_LOGIN });
		const ok = await acc.login('nEo', 'secret', fails);
		assert.ok(ok.ok && ok.account.username === 'Neo');
		const s = acc.createSession(ok.account.id);
		assert.equal(s.hash, tokenHash(s.token));
		const stored = db.db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
		assert.deepEqual(stored.map((r) => r.token_hash), [s.hash], 'only the token hash is stored');
		assert.equal(acc.resume(s.token)?.account.username, 'Neo');
		assert.equal(acc.resume('nope'), null);
		acc.logout(s.hash);
		assert.equal(acc.resume(s.token), null);
		db.close();
	});

	it('attempt limiter uses a sliding one-minute window', () => {
		const l = new AttemptLimiter(2);
		l.hit('k', 0);
		l.hit('k', 30_000);
		assert.equal(l.blocked('k', 59_999), true);
		assert.equal(l.blocked('k', 60_000), false);
		assert.equal(l.blocked('other', 0), false);
	});
});
