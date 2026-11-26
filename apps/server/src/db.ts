/**
 * SQLite storage (docs/gameplay.md#personal-bests-and-leaderboard).
 *
 * - `accounts` / `sessions`: username + scrypt password hash, and SHA-256
 *   hashes of session tokens (docs/architecture.md#accounts).
 * - `account_runs`: the leaderboard. Only each account's best run per map is
 *   kept; guests never get rows here.
 * - `players`: guest bookkeeping (localStorage UUID, last name, last seen).
 * - `replays`: record ghosts (docs/gameplay.md#ghosts), one row per map: the
 *   fastest validated account run recorded by the server, deflate-raw packed.
 * - `map_settings`, `bans`, `admin_log`: admin menu state (docs/gameplay.md#admin):
 *   disabled maps, account / guest bans, and an audit log of admin actions.
 * - `account_stats`: playtime and points per account
 *   (docs/gameplay.md#points-and-playtime); a missing row means zero.
 * - `runs`: legacy guest runs keyed by the localStorage UUID (and timed at
 *   the old 128 tick). Kept untouched for reference, never read or written.
 *
 * - `point_log`: the last POINT_LOG_KEEP awards and purchases per account;
 *   older rows are summed up in `point_rollup` (docs/economy.md#storage).
 * - `abuse_log`: automatic warnings and bans.
 * - `owned_items`, `equipped`: cosmetics bought in the shop and worn, one item
 *   per slot (docs/economy.md#shop).
 * - `casino_log`, `casino_stats`, `casino_crash`: the last CASINO_RECENT casino
 *   bets per account, their sums per account, and the open crash bets
 *   (docs/economy.md#casino).
 * - `trn_bets`: open tournament bets, whose stake is taken; given back at
 *   start-up when the server stopped before the duel ended
 *   (docs/economy.md#tournament). Their stakes and payouts are `casino_log`
 *   rows (`trnBet`, `trnWin`, `trnRefund`), not in `casino_stats`.
 *
 * Every table is created with CREATE TABLE IF NOT EXISTS and new columns are
 * added with a default, so an existing database migrates in place on start-up
 * without losing data.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { CASINO_RECENT, casinoLabel, RECENT_AWARDS, usernameKey } from '@surf/shared';

export interface RunRow {
	accountId: number;
	name: string;
	ticks: number;
	splits: number[];
	createdAt: number;
}

export interface SaveResult {
	/** True when the run replaced (or created) the account's PB. */
	pb: boolean;
	/** Previous PB ticks, null if none. */
	previous: number | null;
}

export interface ReplayRow {
	accountId: number;
	name: string;
	ticks: number;
	samples: number;
	/** Deflate-raw compressed packGhost() track. */
	data: Buffer;
	createdAt: number;
}

export interface BanRow {
	id: number;
	accountId: number | null;
	playerKey: string | null;
	ip: string | null;
	usernameSnapshot: string;
	reason: string | null;
	createdAt: number;
	createdBy: string;
	/** Wall clock (ms) when the ban lifts by itself; null = permanent. */
	expiresAt: number | null;
}

/** A point_log row to write; amounts and multiplier in tenths. */
export interface PointEntry {
	accountId: number;
	at: number;
	mode: string;
	map: string;
	reason: string;
	label: string;
	base: number;
	/** Part of `base` that counts towards the hourly backstop. */
	counted: number;
	mult: number;
	amount: number;
}

export interface PointLogRow {
	at: number;
	reason: string;
	label: string;
	amount: number;
	mult: number;
}

export interface AbuseRow {
	id: number;
	createdAt: number;
	accountId: number;
	username: string;
	action: 'warning' | 'ban' | 'exempt';
	strikes: number;
	evidence: string;
}

/**
 * point_log rows kept per account; older ones are summed up. Those of the last
 * POINT_LOG_RULES_MS stay longer: the limits on repeated awards (up to 24 hours) count them.
 */
export const POINT_LOG_KEEP = RECENT_AWARDS;
export const POINT_LOG_RULES_MS = 25 * 3600_000;
/** abuse_log rows kept. */
export const ABUSE_LOG_MAX = 2000;

/**
 * Account totals (docs/gameplay.md#points-and-playtime). Earned and spendable
 * points are separate numbers, both stored in tenths of a point (docs/economy.md).
 */
export interface AccountStatsRow {
	playtimeSecs: number;
	/** Lifetime earned points: only ever grows. */
	pointsTotal: number;
	/** Spendable points (coins). */
	pointsBalance: number;
}

/** One settled casino bet; tenths. */
export interface CasinoRow {
	at: number;
	game: string;
	bet: number;
	payout: number;
}

export interface AccountRow {
	id: number;
	username: string;
	passwordHash: string;
}

export class Db {
	readonly db: Database.Database;
	private readonly st: ReturnType<Db['prepare']>;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path);
		this.db.pragma('journal_mode = WAL');
		this.db.pragma('foreign_keys = ON');
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS players (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				first_seen INTEGER NOT NULL,
				last_seen INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				player_id TEXT NOT NULL REFERENCES players(id),
				map TEXT NOT NULL,
				time_ticks INTEGER NOT NULL,
				splits_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE (player_id, map)
			);
			CREATE INDEX IF NOT EXISTS runs_map_time ON runs (map, time_ticks);
			CREATE TABLE IF NOT EXISTS accounts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				username TEXT NOT NULL,
				username_lower TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				last_login INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS sessions (
				token_hash TEXT PRIMARY KEY,
				account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
			CREATE TABLE IF NOT EXISTS account_runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				map TEXT NOT NULL,
				time_ticks INTEGER NOT NULL,
				splits_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				UNIQUE (account_id, map)
			);
			CREATE INDEX IF NOT EXISTS account_runs_map_time ON account_runs (map, time_ticks);
			CREATE TABLE IF NOT EXISTS replays (
				map TEXT PRIMARY KEY,
				account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				time_ticks INTEGER NOT NULL,
				samples INTEGER NOT NULL,
				data BLOB NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS map_settings (
				map_id TEXT PRIMARY KEY,
				enabled INTEGER NOT NULL DEFAULT 1
			);
			CREATE TABLE IF NOT EXISTS bans (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
				player_key TEXT,
				ip TEXT,
				username_snapshot TEXT NOT NULL,
				reason TEXT,
				created_at INTEGER NOT NULL,
				created_by TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS bans_account ON bans (account_id);
			CREATE INDEX IF NOT EXISTS bans_player_key ON bans (player_key);
			CREATE INDEX IF NOT EXISTS bans_ip ON bans (ip);
			CREATE TABLE IF NOT EXISTS admin_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				created_at INTEGER NOT NULL,
				admin_account_id INTEGER,
				admin_username TEXT NOT NULL,
				action TEXT NOT NULL,
				target TEXT,
				detail TEXT
			);
			CREATE TABLE IF NOT EXISTS account_stats (
				account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
				playtime_secs INTEGER NOT NULL DEFAULT 0,
				points_total INTEGER NOT NULL DEFAULT 0,
				points_balance INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS point_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				created_at INTEGER NOT NULL,
				mode TEXT NOT NULL,
				map TEXT NOT NULL,
				reason TEXT NOT NULL,
				label TEXT NOT NULL,
				base INTEGER NOT NULL,
				counted INTEGER NOT NULL DEFAULT 0,
				multiplier INTEGER NOT NULL,
				amount INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS point_log_account ON point_log (account_id, created_at);
			CREATE INDEX IF NOT EXISTS point_log_time ON point_log (created_at);
			CREATE TABLE IF NOT EXISTS point_rollup (
				account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				mode TEXT NOT NULL,
				reason TEXT NOT NULL,
				entries INTEGER NOT NULL,
				base INTEGER NOT NULL,
				amount INTEGER NOT NULL,
				PRIMARY KEY (account_id, mode, reason)
			);
			CREATE TABLE IF NOT EXISTS abuse_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				created_at INTEGER NOT NULL,
				account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				username TEXT NOT NULL,
				action TEXT NOT NULL,
				strikes INTEGER NOT NULL,
				evidence TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS owned_items (
				account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				item_id TEXT NOT NULL,
				bought_at INTEGER NOT NULL,
				price INTEGER NOT NULL,
				PRIMARY KEY (account_id, item_id)
			);
			CREATE TABLE IF NOT EXISTS equipped (
				account_id INTEGER NOT NULL,
				slot TEXT NOT NULL,
				item_id TEXT NOT NULL,
				PRIMARY KEY (account_id, slot),
				FOREIGN KEY (account_id, item_id) REFERENCES owned_items (account_id, item_id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS casino_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				created_at INTEGER NOT NULL,
				game TEXT NOT NULL,
				bet INTEGER NOT NULL,
				payout INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS casino_log_account ON casino_log (account_id, id);
			CREATE INDEX IF NOT EXISTS casino_log_time ON casino_log (created_at);
			CREATE TABLE IF NOT EXISTS casino_stats (
				account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
				plays INTEGER NOT NULL,
				bet INTEGER NOT NULL,
				payout INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS casino_crash (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
				created_at INTEGER NOT NULL,
				bet INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS trn_bets (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
				created_at INTEGER NOT NULL,
				bet INTEGER NOT NULL
			);
		`);
		// Missing = permanent ban / no active time yet.
		this.addColumn('bans', 'expires_at', 'INTEGER');
		this.addColumn('account_stats', 'active_ms', 'INTEGER NOT NULL DEFAULT 0');
		this.st = this.prepare();
	}

	/** Add a column to a table of an older database; existing rows get the default. */
	private addColumn(table: string, column: string, type: string): void {
		const cols = this.db.pragma(`table_info(${table})`) as { name: string }[];
		if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
	}

	private prepare() {
		const d = this.db;
		return {
			upsertPlayer: d.prepare(
				`INSERT INTO players (id, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`
			),
			rename: d.prepare(`UPDATE players SET name = ? WHERE id = ?`),
			touch: d.prepare(`UPDATE players SET last_seen = ? WHERE id = ?`),

			insertAccount: d.prepare(
				`INSERT INTO accounts (username, username_lower, password_hash, created_at, last_login) VALUES (?, ?, ?, ?, ?)`
			),
			accountByKey: d.prepare(`SELECT id, username, password_hash FROM accounts WHERE username_lower = ?`),
			accountById: d.prepare(`SELECT id, username, password_hash FROM accounts WHERE id = ?`),
			touchAccount: d.prepare(`UPDATE accounts SET last_login = ? WHERE id = ?`),
			insertSession: d.prepare(`INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)`),
			session: d.prepare(
				`SELECT a.id, a.username, a.password_hash, s.expires_at
				 FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`
			),
			deleteSession: d.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
			pruneSessions: d.prepare(`DELETE FROM sessions WHERE expires_at <= ?`),

			getPb: d.prepare(`SELECT time_ticks, splits_json, created_at FROM account_runs WHERE account_id = ? AND map = ?`),
			upsertRun: d.prepare(
				`INSERT INTO account_runs (account_id, map, time_ticks, splits_json, created_at) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(account_id, map) DO UPDATE SET
					time_ticks = excluded.time_ticks,
					splits_json = excluded.splits_json,
					created_at = excluded.created_at
				 WHERE excluded.time_ticks < account_runs.time_ticks`
			),
			rankOf: d.prepare(`SELECT COUNT(*) AS n FROM account_runs WHERE map = ? AND time_ticks < ?`),
			count: d.prepare(`SELECT COUNT(*) AS n FROM account_runs WHERE map = ?`),
			top: d.prepare(
				`SELECT r.account_id, a.username, r.time_ticks, r.splits_json, r.created_at
				 FROM account_runs r JOIN accounts a ON a.id = r.account_id
				 WHERE r.map = ? ORDER BY r.time_ticks ASC, r.created_at ASC LIMIT ?`
			),
			getReplay: d.prepare(
				`SELECT r.account_id, a.username, r.time_ticks, r.samples, r.data, r.created_at
				 FROM replays r JOIN accounts a ON a.id = r.account_id WHERE r.map = ?`
			),
			upsertReplay: d.prepare(
				`INSERT INTO replays (map, account_id, time_ticks, samples, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(map) DO UPDATE SET
					account_id = excluded.account_id,
					time_ticks = excluded.time_ticks,
					samples = excluded.samples,
					data = excluded.data,
					created_at = excluded.created_at
				 WHERE excluded.time_ticks < replays.time_ticks`
			),
			ranks: d.prepare(
				`SELECT account_id, time_ticks FROM account_runs WHERE map = ? ORDER BY time_ticks ASC, created_at ASC`
			),

			accountStats: d.prepare(`SELECT playtime_secs, points_total, points_balance FROM account_stats WHERE account_id = ?`),
			richest: d.prepare(
				`SELECT a.id, a.username, s.points_balance AS balance FROM account_stats s JOIN accounts a ON a.id = s.account_id
				 WHERE s.points_balance > 0 ORDER BY s.points_balance DESC, a.id LIMIT ?`
			),
			// From `accounts`, so an account deleted meanwhile is skipped instead of failing the batch.
			addPlaytime: d.prepare(
				`INSERT INTO account_stats (account_id, playtime_secs) SELECT id, ? FROM accounts WHERE id = ?
				 ON CONFLICT(account_id) DO UPDATE SET playtime_secs = playtime_secs + excluded.playtime_secs`
			),
			activeMs: d.prepare(`SELECT active_ms FROM account_stats WHERE account_id = ?`),
			setActiveMs: d.prepare(
				`INSERT INTO account_stats (account_id, active_ms) SELECT id, ? FROM accounts WHERE id = ?
				 ON CONFLICT(account_id) DO UPDATE SET active_ms = excluded.active_ms`
			),
			addPoints: d.prepare(
				`INSERT INTO account_stats (account_id, points_total, points_balance) SELECT id, @amount, @amount FROM accounts WHERE id = @id
				 ON CONFLICT(account_id) DO UPDATE SET
					points_total = points_total + excluded.points_total,
					points_balance = points_balance + excluded.points_balance`
			),
			spendPoints: d.prepare(
				`UPDATE account_stats SET points_balance = points_balance - @amount WHERE account_id = @id AND points_balance >= @amount`
			),
			setBalance: d.prepare(
				`INSERT INTO account_stats (account_id, points_balance) SELECT id, @balance FROM accounts WHERE id = @id
				 ON CONFLICT(account_id) DO UPDATE SET points_balance = excluded.points_balance`
			),
			logPoints: d.prepare(
				`INSERT INTO point_log (account_id, created_at, mode, map, reason, label, base, counted, multiplier, amount)
				 VALUES (@accountId, @at, @mode, @map, @reason, @label, @base, @counted, @mult, @amount)`
			),
			countedSince: d.prepare(`SELECT COALESCE(SUM(counted), 0) AS n FROM point_log WHERE account_id = ? AND created_at > ?`),
			firstCounted: d.prepare(`SELECT MIN(created_at) AS at FROM point_log WHERE account_id = ? AND created_at > ? AND counted > 0`),
			lastPaid: d.prepare(`SELECT MAX(created_at) AS at FROM point_log WHERE account_id = ? AND reason = ? AND (? IS NULL OR map = ?)`),
			countPaid: d.prepare(
				`SELECT COUNT(*) AS n FROM point_log WHERE account_id = ? AND created_at > ? AND reason = ? AND map = ? AND (? IS NULL OR label = ?)`
			),
			recentPoints: d.prepare(
				`SELECT created_at AS at, reason, label, amount, multiplier AS mult FROM point_log WHERE account_id = ? ORDER BY id DESC LIMIT ?`
			),
			oldPoints: d.prepare(
				`SELECT id FROM (SELECT id, created_at, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY id DESC) AS n FROM point_log) WHERE created_at < ? AND n > ?`
			).pluck(),
			// What changed the balance: awards, purchases, admins (point_log) and settled bets (casino_log).
			recentMoney: d.prepare(
				`SELECT * FROM (SELECT id, created_at AS at, reason, label, amount, multiplier AS mult, 0 AS bet FROM point_log WHERE account_id = @id ORDER BY id DESC LIMIT @n)
				 UNION ALL
				 SELECT * FROM (SELECT id, created_at AS at, 'casino:' || game AS reason, '' AS label, payout - bet AS amount, 10 AS mult, 1 AS bet FROM casino_log WHERE account_id = @id ORDER BY id DESC LIMIT @n)
				 ORDER BY at DESC, id DESC LIMIT @n`
			),
			rollUp: d.prepare(
				`INSERT INTO point_rollup (account_id, mode, reason, entries, base, amount)
				 SELECT account_id, mode, reason, COUNT(*), SUM(base), SUM(amount) FROM point_log WHERE id IN (SELECT value FROM json_each(?)) GROUP BY account_id, mode, reason
				 ON CONFLICT(account_id, mode, reason) DO UPDATE SET
					entries = entries + excluded.entries, base = base + excluded.base, amount = amount + excluded.amount`
			),
			deleteOldPoints: d.prepare(`DELETE FROM point_log WHERE id IN (SELECT value FROM json_each(?))`),
			insertAbuse: d.prepare(
				`INSERT INTO abuse_log (created_at, account_id, username, action, strikes, evidence) VALUES (?, ?, ?, ?, ?, ?)`
			),
			pruneAbuse: d.prepare(`DELETE FROM abuse_log WHERE id <= (SELECT MAX(id) FROM abuse_log) - ?`),
			listAbuse: d.prepare(`SELECT * FROM abuse_log ORDER BY id DESC LIMIT ?`),

			ownedItems: d.prepare(`SELECT item_id FROM owned_items WHERE account_id = ? ORDER BY bought_at, item_id`).pluck(),
			grantItem: d.prepare(
				`INSERT INTO owned_items (account_id, item_id, bought_at, price) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, item_id) DO NOTHING`
			),
			equippedItems: d.prepare(`SELECT slot, item_id FROM equipped WHERE account_id = ?`),
			// From `owned_items`: an item that is not owned changes nothing.
			equipItem: d.prepare(
				`INSERT INTO equipped (account_id, slot, item_id) SELECT account_id, ?, item_id FROM owned_items WHERE account_id = ? AND item_id = ?
				 ON CONFLICT(account_id, slot) DO UPDATE SET item_id = excluded.item_id`
			),
			dropItem: d.prepare(`DELETE FROM owned_items WHERE account_id = ? AND item_id = ?`),
			unequipItem: d.prepare(`DELETE FROM equipped WHERE account_id = ? AND item_id = ?`),
			unequipSlot: d.prepare(`DELETE FROM equipped WHERE account_id = ? AND slot = ?`),

			credit: d.prepare(`UPDATE account_stats SET points_balance = points_balance + ? WHERE account_id = ?`),
			logCasino: d.prepare(`INSERT INTO casino_log (account_id, created_at, game, bet, payout) VALUES (?, ?, ?, ?, ?)`),
			addCasino: d.prepare(
				`INSERT INTO casino_stats (account_id, plays, bet, payout) VALUES (?, 1, ?, ?)
				 ON CONFLICT(account_id) DO UPDATE SET plays = plays + 1, bet = bet + excluded.bet, payout = payout + excluded.payout`
			),
			casinoNet: d.prepare(`SELECT payout - bet FROM casino_stats WHERE account_id = ?`).pluck(),
			recentCasino: d.prepare(`SELECT created_at AS at, game, bet, payout FROM casino_log WHERE account_id = ? ORDER BY id DESC LIMIT ?`),
			pruneCasino: d.prepare(
				`DELETE FROM casino_log WHERE account_id = @id AND id <= (SELECT id FROM casino_log WHERE account_id = @id ORDER BY id DESC LIMIT 1 OFFSET @keep)`
			),
			openCrash: d.prepare(`INSERT INTO casino_crash (account_id, created_at, bet) VALUES (?, ?, ?) ON CONFLICT(account_id) DO NOTHING`),
			closeCrash: d.prepare(`DELETE FROM casino_crash WHERE id = ? RETURNING account_id AS accountId, bet`),
			openCrashes: d.prepare(`SELECT id FROM casino_crash ORDER BY id`).pluck(),
			openTrnBet: d.prepare(`INSERT INTO trn_bets (account_id, created_at, bet) VALUES (?, ?, ?)`),
			closeTrnBet: d.prepare(`DELETE FROM trn_bets WHERE id = ? RETURNING account_id AS accountId, bet`),
			openTrnBets: d.prepare(`SELECT id FROM trn_bets ORDER BY id`).pluck(),
			trnBetRow: d.prepare(`SELECT account_id AS accountId, bet FROM trn_bets WHERE id = ?`),

			disabledMaps: d.prepare(`SELECT map_id FROM map_settings WHERE enabled = 0`),
			setMapEnabled: d.prepare(
				`INSERT INTO map_settings (map_id, enabled) VALUES (?, ?) ON CONFLICT(map_id) DO UPDATE SET enabled = excluded.enabled`
			),
			insertBan: d.prepare(
				`INSERT INTO bans (account_id, player_key, ip, username_snapshot, reason, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			),
			deleteBan: d.prepare(`DELETE FROM bans WHERE id = ?`),
			banById: d.prepare(`SELECT * FROM bans WHERE id = ?`),
			listBans: d.prepare(`SELECT * FROM bans ORDER BY created_at DESC, id DESC`),
			// Permanent bans first, then the one that lasts longest.
			banForAccount: d.prepare(
				`SELECT * FROM bans WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)
				 ORDER BY expires_at IS NOT NULL, expires_at DESC, id LIMIT 1`
			),
			banForGuest: d.prepare(
				`SELECT * FROM bans WHERE ((player_key IS NOT NULL AND player_key = ?) OR (ip IS NOT NULL AND ip = ?))
				 AND (expires_at IS NULL OR expires_at > ?)
				 ORDER BY expires_at IS NOT NULL, expires_at DESC, id LIMIT 1`
			),
			deleteExpiredBans: d.prepare(`DELETE FROM bans WHERE expires_at IS NOT NULL AND expires_at <= ?`),
			insertAdminLog: d.prepare(
				`INSERT INTO admin_log (created_at, admin_account_id, admin_username, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)`
			)
		};
	}

	// -----------------------------------------------------------------------
	// Guests

	upsertPlayer(id: string, name: string, now = Date.now()): void {
		this.st.upsertPlayer.run(id, name, now, now);
	}

	rename(id: string, name: string): void {
		this.st.rename.run(name, id);
	}

	touch(id: string, now = Date.now()): void {
		this.st.touch.run(now, id);
	}

	// -----------------------------------------------------------------------
	// Accounts and sessions (validation and hashing live in auth.ts)

	/**
	 * Create an account; null if the username is taken (case-insensitive).
	 * `welcome`: coins it starts with, logged in the same transaction (balance
	 * only, no lifetime points).
	 */
	createAccount(
		username: string,
		passwordHash: string,
		now = Date.now(),
		welcome?: Pick<PointEntry, 'reason' | 'label' | 'amount'>
	): AccountRow | null {
		try {
			return this.db.transaction(() => {
				const r = this.st.insertAccount.run(username, usernameKey(username), passwordHash, now, now);
				const id = Number(r.lastInsertRowid);
				if (welcome && welcome.amount > 0) {
					this.st.setBalance.run({ id, balance: welcome.amount });
					this.st.logPoints.run({ accountId: id, at: now, ...welcome, mode: 'bonus', map: '', base: 0, counted: 0, mult: 10 });
				}
				return { id, username, passwordHash };
			})();
		} catch (err) {
			if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
			throw err;
		}
	}

	accountByName(username: string): AccountRow | null {
		return toAccount(this.st.accountByKey.get(usernameKey(username)));
	}

	accountById(id: number): AccountRow | null {
		return toAccount(this.st.accountById.get(id));
	}

	touchAccount(id: number, now = Date.now()): void {
		this.st.touchAccount.run(now, id);
	}

	createSession(tokenHash: string, accountId: number, expiresAt: number, now = Date.now()): void {
		this.st.pruneSessions.run(now);
		this.st.insertSession.run(tokenHash, accountId, now, expiresAt);
	}

	/** Account of a live session; expired sessions are deleted and return null. */
	sessionAccount(tokenHash: string, now = Date.now()): AccountRow | null {
		const r = this.st.session.get(tokenHash) as
			| { id: number; username: string; password_hash: string; expires_at: number }
			| undefined;
		if (!r) return null;
		if (r.expires_at <= now) {
			this.st.deleteSession.run(tokenHash);
			return null;
		}
		return toAccount(r);
	}

	deleteSession(tokenHash: string): void {
		this.st.deleteSession.run(tokenHash);
	}

	// -----------------------------------------------------------------------
	// Account totals (account-stats.ts)

	/** Accounts with the most coins (tenths), richest first; none without coins. */
	richest(limit: number): { id: number; username: string; balance: number }[] {
		return this.st.richest.all(limit) as { id: number; username: string; balance: number }[];
	}

	/** Zeros for an account without a row yet. */
	accountStats(accountId: number): AccountStatsRow {
		const r = this.st.accountStats.get(accountId) as
			| { playtime_secs: number; points_total: number; points_balance: number }
			| undefined;
		return { playtimeSecs: r?.playtime_secs ?? 0, pointsTotal: r?.points_total ?? 0, pointsBalance: r?.points_balance ?? 0 };
	}

	/** Add seconds online, all or nothing. */
	addPlaytime(entries: readonly { accountId: number; secs: number }[]): void {
		this.db.transaction(() => {
			for (const e of entries) this.st.addPlaytime.run(e.secs, e.accountId);
		})();
	}

	// -----------------------------------------------------------------------
	// Points and coins (economy.ts); amounts in tenths of a point

	/** Active time towards the next playtime points. */
	activeMs(accountId: number): number {
		return (this.st.activeMs.get(accountId) as { active_ms: number } | undefined)?.active_ms ?? 0;
	}

	setActiveMs(accountId: number, ms: number): void {
		this.st.setActiveMs.run(Math.round(ms), accountId);
	}

	/**
	 * Credit an award and log it, all or nothing; `activeMs` also stores the
	 * rest of the active time. Null when the account no longer exists.
	 */
	payPoints(e: PointEntry, activeMs?: number): AccountStatsRow | null {
		return this.db.transaction(() => {
			if (this.st.addPoints.run({ id: e.accountId, amount: e.amount }).changes === 0) return null;
			this.st.logPoints.run(e);
			if (activeMs !== undefined) this.setActiveMs(e.accountId, activeMs);
			return this.accountStats(e.accountId);
		})();
	}

	/** Take `e.amount` (positive) from the balance and log it; null when the balance is too low. */
	spendPoints(e: Pick<PointEntry, 'accountId' | 'at' | 'reason' | 'label' | 'amount'>): AccountStatsRow | null {
		return this.db.transaction(() => {
			if (this.st.spendPoints.run({ id: e.accountId, amount: e.amount }).changes === 0) return null;
			this.st.logPoints.run({ ...e, mode: 'shop', map: '', base: 0, counted: 0, mult: 10, amount: -e.amount });
			return this.accountStats(e.accountId);
		})();
	}

	/**
	 * Buy an item: take the price, log it and grant the item, all or nothing.
	 * The write lock is taken first, so two buyers (connections, processes)
	 * can never both pass the checks.
	 */
	buyItem(e: Pick<PointEntry, 'accountId' | 'at' | 'reason' | 'label' | 'amount'>, itemId: string): 'ok' | 'owned' | 'poor' {
		return this.db
			.transaction((): 'ok' | 'owned' | 'poor' => {
				if (this.ownedItems(e.accountId).includes(itemId)) return 'owned';
				if (!this.spendPoints(e)) return 'poor';
				this.st.grantItem.run(e.accountId, itemId, e.at, e.amount);
				return 'ok';
			})
			.immediate();
	}

	/**
	 * Admin change of the balance: `amount` tenths (signed), or null for a reset
	 * to zero. Never below zero; lifetime points stay. `delta` is what really
	 * changed (logged unless 0). Null when the account no longer exists.
	 */
	adjustBalance(e: Pick<PointEntry, 'accountId' | 'at' | 'reason' | 'label'>, amount: number | null): { delta: number; balance: number } | null {
		return this.db
			.transaction(() => {
				const before = this.accountStats(e.accountId).pointsBalance;
				const balance = amount === null ? 0 : Math.max(0, before + amount);
				const delta = balance - before;
				if (this.st.setBalance.run({ id: e.accountId, balance }).changes === 0) return null;
				if (delta !== 0) this.st.logPoints.run({ ...e, mode: 'admin', map: '', base: 0, counted: 0, mult: 10, amount: delta });
				return { delta, balance };
			})
			.immediate();
	}

	/**
	 * Open a loot box: take the price, log it, then grant the item, or give
	 * `refund` tenths back when the account already owns it. All or nothing.
	 */
	openBox(
		e: Pick<PointEntry, 'accountId' | 'at' | 'reason' | 'label' | 'amount'>,
		itemId: string,
		refund: { amount: number; label: string }
	): 'new' | 'duplicate' | 'poor' {
		return this.db
			.transaction((): 'new' | 'duplicate' | 'poor' => {
				const duplicate = this.ownedItems(e.accountId).includes(itemId);
				if (!this.spendPoints(e)) return 'poor';
				if (!duplicate) {
					this.st.grantItem.run(e.accountId, itemId, e.at, e.amount);
					return 'new';
				}
				if (refund.amount > 0) {
					this.st.setBalance.run({ id: e.accountId, balance: this.accountStats(e.accountId).pointsBalance + refund.amount });
					this.st.logPoints.run({ ...e, label: refund.label, mode: 'shop', map: '', base: 0, counted: 0, mult: 10, amount: refund.amount });
				}
				return 'duplicate';
			})
			.immediate();
	}

	// -----------------------------------------------------------------------
	// Casino (casino.ts); amounts in tenths

	/** A decided bet: take it, pay the result and log it, all or nothing. False when the balance is too low. */
	casinoPlay(accountId: number, e: CasinoRow): boolean {
		return this.db
			.transaction(() => {
				if (this.st.spendPoints.run({ id: accountId, amount: e.bet }).changes === 0) return false;
				this.settleCasino(accountId, e);
				return true;
			})
			.immediate();
	}

	private settleCasino(accountId: number, e: CasinoRow): void {
		if (e.payout > 0) this.st.credit.run(e.payout, accountId);
		this.st.logCasino.run(accountId, e.at, e.game, e.bet, e.payout);
		this.st.pruneCasino.run({ id: accountId, keep: CASINO_RECENT });
		this.st.addCasino.run(accountId, e.bet, e.payout);
	}

	/** Take the bet of a crash round, which stays open until `crashClose`. One open round per account. */
	crashOpen(accountId: number, at: number, bet: number): number | 'poor' | 'open' {
		return this.db
			.transaction((): number | 'poor' | 'open' => {
				if (this.st.spendPoints.run({ id: accountId, amount: bet }).changes === 0) return 'poor';
				const r = this.st.openCrash.run(accountId, at, bet);
				if (r.changes > 0) return Number(r.lastInsertRowid);
				this.st.credit.run(bet, accountId);
				return 'open';
			})
			.immediate();
	}

	/** End a crash round: pay and log it. False when it is no longer open (nothing is paid). */
	crashClose(id: number, at: number, payout: number): boolean {
		return this.db
			.transaction(() => {
				const r = this.st.closeCrash.get(id) as { accountId: number; bet: number } | undefined;
				if (!r) return false;
				this.settleCasino(r.accountId, { at, game: 'crash', bet: r.bet, payout });
				return true;
			})
			.immediate();
	}

	/** Give every open crash bet back (server start); tenths per account. */
	refundCrashes(): Map<number, number> {
		return this.db
			.transaction(() => {
				const out = new Map<number, number>();
				for (const id of this.st.openCrashes.all() as number[]) {
					const r = this.st.closeCrash.get(id) as { accountId: number; bet: number };
					this.st.credit.run(r.bet, r.accountId);
					out.set(r.accountId, r.bet);
				}
				return out;
			})
			.immediate();
	}

	// -----------------------------------------------------------------------
	// Tournament bets (docs/economy.md#tournament): the crash pattern, without
	// the one-per-account limit and without casino_stats; tenths.

	/** Take a tournament stake: the bet stays open until `trnBetClose`. Null when the balance is too low. */
	trnBetOpen(accountId: number, at: number, bet: number): number | null {
		return this.db
			.transaction((): number | null => {
				if (this.st.spendPoints.run({ id: accountId, amount: bet }).changes === 0) return null;
				const id = Number(this.st.openTrnBet.run(accountId, at, bet).lastInsertRowid);
				this.logTrnBet(accountId, at, 'trnBet', bet, 0);
				return id;
			})
			.immediate();
	}

	/** Settle an open tournament bet: credit `payout` (0 for a loss). False when it is no longer open (nothing paid). */
	trnBetClose(id: number, at: number, payout: number, game: 'trnWin' | 'trnRefund' | 'trnLoss'): boolean {
		return this.db
			.transaction(() => {
				const r = this.st.closeTrnBet.get(id) as { accountId: number; bet: number } | undefined;
				if (!r) return false;
				if (payout > 0) {
					this.st.credit.run(payout, r.accountId);
					this.logTrnBet(r.accountId, at, game, 0, payout);
				}
				return true;
			})
			.immediate();
	}

	/** Give every open tournament bet back (server start); tenths per account. */
	refundTrnBets(at: number): Map<number, number> {
		return this.db
			.transaction(() => {
				const out = new Map<number, number>();
				for (const id of this.st.openTrnBets.all() as number[]) {
					const r = this.st.closeTrnBet.get(id) as { accountId: number; bet: number };
					this.st.credit.run(r.bet, r.accountId);
					this.logTrnBet(r.accountId, at, 'trnRefund', 0, r.bet);
					out.set(r.accountId, (out.get(r.accountId) ?? 0) + r.bet);
				}
				return out;
			})
			.immediate();
	}

	/** Account and stake of an open tournament bet. */
	trnBetOpenRow(id: number): { accountId: number; bet: number } | null {
		return (this.st.trnBetRow.get(id) as { accountId: number; bet: number } | undefined) ?? null;
	}

	/** Open tournament bets (tests). */
	openTrnBetCount(): number {
		return (this.st.openTrnBets.all() as number[]).length;
	}

	private logTrnBet(accountId: number, at: number, game: string, bet: number, payout: number): void {
		this.st.logCasino.run(accountId, at, game, bet, payout);
		this.st.pruneCasino.run({ id: accountId, keep: CASINO_RECENT });
	}

	/** Won minus bet, of all settled bets ever. */
	casinoNet(accountId: number): number {
		return (this.st.casinoNet.get(accountId) as number | undefined) ?? 0;
	}

	/** Newest first. */
	recentCasino(accountId: number, limit: number): CasinoRow[] {
		return this.st.recentCasino.all(accountId, limit) as CasinoRow[];
	}

	/** Give an item for free. False when it is already owned. */
	giveItem(accountId: number, itemId: string, at: number): boolean {
		return this.db
			.transaction(() => {
				if (this.ownedItems(accountId).includes(itemId)) return false;
				this.st.grantItem.run(accountId, itemId, at, 0);
				return true;
			})
			.immediate();
	}

	/** Take an item away, also when it is worn. False when it is not owned. */
	takeItem(accountId: number, itemId: string): boolean {
		return this.db
			.transaction(() => {
				this.st.unequipItem.run(accountId, itemId);
				return this.st.dropItem.run(accountId, itemId).changes > 0;
			})
			.immediate();
	}

	/** Item ids, oldest first (also items this version does not know). */
	ownedItems(accountId: number): string[] {
		return this.st.ownedItems.all(accountId) as string[];
	}

	/** Slot to item id as stored: pass it through `sanitizeLoadout`. */
	equipped(accountId: number): Record<string, string> {
		const rows = this.st.equippedItems.all(accountId) as { slot: string; item_id: string }[];
		return Object.fromEntries(rows.map((r) => [r.slot, r.item_id]));
	}

	/** Wear an owned item (`null`: the slot's default). False when it is not owned. */
	equip(accountId: number, slot: string, itemId: string | null): boolean {
		if (itemId !== null) return this.st.equipItem.run(slot, accountId, itemId).changes > 0;
		this.st.unequipSlot.run(accountId, slot);
		return true;
	}

	/** When the oldest award that counts towards the backstop after `since` was paid; null: none. */
	firstCountedSince(accountId: number, since: number): number | null {
		return (this.st.firstCounted.get(accountId, since) as { at: number | null }).at;
	}

	/** Base points counted towards the backstop after `since`. */
	countedSince(accountId: number, since: number): number {
		return (this.st.countedSince.get(accountId, since) as { n: number }).n;
	}

	/** When this reason was last paid to the account (on `map`, or anywhere); null = not in the log. */
	lastPaid(accountId: number, reason: string, map: string | null): number | null {
		return (this.st.lastPaid.get(accountId, reason, map, map) as { at: number | null }).at;
	}

	/** How often this reason (with this label, if given) was paid to the account on `map` after `since`. */
	countPaid(accountId: number, reason: string, map: string, since: number, label: string | null = null): number {
		return (this.st.countPaid.get(accountId, since, reason, map, label, label) as { n: number }).n;
	}

	/** Newest first. */
	recentPoints(accountId: number, limit: number): PointLogRow[] {
		return this.st.recentPoints.all(accountId, limit) as PointLogRow[];
	}

	/** The last changes of the balance, newest first: awards, purchases, admin changes and settled casino bets. */
	recentMoney(accountId: number, limit: number): PointLogRow[] {
		const rows = this.st.recentMoney.all({ id: accountId, n: limit }) as (PointLogRow & { id: number; bet: number })[];
		return rows.map(({ id: _id, bet, ...r }) => (bet ? { ...r, label: casinoLabel(r.reason.slice('casino:'.length), r.amount) } : r));
	}

	/** Sum up and delete log rows older than `before`, except the newest `keep` of each account; returns how many. */
	rollUpPoints(before: number, keep: number): number {
		return this.db.transaction(() => {
			const ids = JSON.stringify(this.st.oldPoints.all(before, keep));
			this.st.rollUp.run(ids);
			return this.st.deleteOldPoints.run(ids).changes;
		})();
	}

	logAbuse(e: Omit<AbuseRow, 'id'>): void {
		this.st.insertAbuse.run(e.createdAt, e.accountId, e.username, e.action, e.strikes, e.evidence);
		this.st.pruneAbuse.run(ABUSE_LOG_MAX);
	}

	/** Newest first. */
	abuseLog(limit: number): AbuseRow[] {
		const rows = this.st.listAbuse.all(limit) as Array<{
			id: number;
			created_at: number;
			account_id: number;
			username: string;
			action: AbuseRow['action'];
			strikes: number;
			evidence: string;
		}>;
		return rows.map((r) => ({
			id: r.id,
			createdAt: r.created_at,
			accountId: r.account_id,
			username: r.username,
			action: r.action,
			strikes: r.strikes,
			evidence: r.evidence
		}));
	}

	// -----------------------------------------------------------------------
	// Leaderboard (accounts only)

	getPb(accountId: number, map: string): { ticks: number; splits: number[]; createdAt: number } | null {
		const r = this.st.getPb.get(accountId, map) as
			| { time_ticks: number; splits_json: string; created_at: number }
			| undefined;
		if (!r) return null;
		return { ticks: r.time_ticks, splits: parseSplits(r.splits_json), createdAt: r.created_at };
	}

	/** Save if better than the account's PB. */
	saveRun(accountId: number, map: string, ticks: number, splits: number[], now = Date.now()): SaveResult {
		return this.db.transaction(() => {
			const prev = this.getPb(accountId, map);
			if (prev && prev.ticks <= ticks) return { pb: false, previous: prev.ticks };
			this.st.upsertRun.run(accountId, map, ticks, JSON.stringify(splits), now);
			return { pb: true, previous: prev?.ticks ?? null };
		})();
	}

	/** 1-based rank a time would have on the map (ties share the better rank). */
	rankFor(map: string, ticks: number): number {
		return (this.st.rankOf.get(map, ticks) as { n: number }).n + 1;
	}

	countRuns(map: string): number {
		return (this.st.count.get(map) as { n: number }).n;
	}

	top(map: string, limit = 10): RunRow[] {
		const rows = this.st.top.all(map, limit) as Array<{
			account_id: number;
			username: string;
			time_ticks: number;
			splits_json: string;
			created_at: number;
		}>;
		return rows.map((r) => ({
			accountId: r.account_id,
			name: r.username,
			ticks: r.time_ticks,
			splits: parseSplits(r.splits_json),
			createdAt: r.created_at
		}));
	}

	/** account id -> { rank, ticks } for a map. */
	ranks(map: string): Map<number, { rank: number; ticks: number }> {
		const rows = this.st.ranks.all(map) as Array<{ account_id: number; time_ticks: number }>;
		const out = new Map<number, { rank: number; ticks: number }>();
		let rank = 0;
		let prevTicks = -1;
		rows.forEach((r, i) => {
			if (r.time_ticks !== prevTicks) rank = i + 1;
			prevTicks = r.time_ticks;
			out.set(r.account_id, { rank, ticks: r.time_ticks });
		});
		return out;
	}

	// -----------------------------------------------------------------------
	// Record ghosts (docs/gameplay.md#ghosts)

	/** The map's record ghost, or null. */
	getReplay(map: string): ReplayRow | null {
		const r = this.st.getReplay.get(map) as
			| { account_id: number; username: string; time_ticks: number; samples: number; data: Buffer; created_at: number }
			| undefined;
		if (!r) return null;
		return { accountId: r.account_id, name: r.username, ticks: r.time_ticks, samples: r.samples, data: r.data, createdAt: r.created_at };
	}

	/** Store a run's replay if it is faster than the map's stored ghost; true when stored. */
	saveReplay(map: string, accountId: number, ticks: number, samples: number, data: Uint8Array, now = Date.now()): boolean {
		return this.st.upsertReplay.run(map, accountId, ticks, samples, Buffer.from(data), now).changes > 0;
	}

	// -----------------------------------------------------------------------
	// Admin (docs/gameplay.md#admin)

	/** Map ids an admin disabled (every other map is enabled). */
	disabledMaps(): Set<string> {
		return new Set((this.st.disabledMaps.all() as Array<{ map_id: string }>).map((r) => r.map_id));
	}

	setMapEnabled(mapId: string, enabled: boolean): void {
		this.st.setMapEnabled.run(mapId, enabled ? 1 : 0);
	}

	addBan(b: Omit<BanRow, 'id' | 'expiresAt'> & { expiresAt?: number | null }): BanRow {
		const ban = { ...b, expiresAt: b.expiresAt ?? null };
		const r = this.st.insertBan.run(
			ban.accountId,
			ban.playerKey,
			ban.ip,
			ban.usernameSnapshot,
			ban.reason,
			ban.createdAt,
			ban.createdBy,
			ban.expiresAt
		);
		return { id: Number(r.lastInsertRowid), ...ban };
	}

	/** The removed ban, or null when there was none. */
	removeBan(id: number): BanRow | null {
		const row = toBan(this.st.banById.get(id));
		if (row) this.st.deleteBan.run(id);
		return row;
	}

	bans(): BanRow[] {
		return (this.st.listBans.all() as unknown[]).map((r) => toBan(r)!);
	}

	/** The account's ban in force at `now` (a permanent one first). */
	accountBan(accountId: number, now: number): BanRow | null {
		return toBan(this.st.banForAccount.get(accountId, now));
	}

	/** A ban in force on this player key or IP (either may be null). */
	guestBan(playerKey: string | null, ip: string | null, now: number): BanRow | null {
		if (!playerKey && !ip) return null;
		return toBan(this.st.banForGuest.get(playerKey, ip, now));
	}

	/** Delete bans that lifted by themselves; returns how many. */
	deleteExpiredBans(now: number): number {
		return this.st.deleteExpiredBans.run(now).changes;
	}

	logAdmin(
		admin: { accountId: number | null; username: string },
		action: string,
		target: string | null,
		detail: string | null,
		now = Date.now()
	): void {
		this.st.insertAdminLog.run(now, admin.accountId, admin.username, action, target, detail);
	}

	close(): void {
		this.db.close();
	}
}

function toBan(r: unknown): BanRow | null {
	if (!r) return null;
	const b = r as {
		id: number;
		account_id: number | null;
		player_key: string | null;
		ip: string | null;
		username_snapshot: string;
		reason: string | null;
		created_at: number;
		created_by: string;
		expires_at: number | null;
	};
	return {
		id: b.id,
		accountId: b.account_id,
		playerKey: b.player_key,
		ip: b.ip,
		usernameSnapshot: b.username_snapshot,
		reason: b.reason,
		createdAt: b.created_at,
		createdBy: b.created_by,
		expiresAt: b.expires_at ?? null
	};
}

function toAccount(r: unknown): AccountRow | null {
	if (!r) return null;
	const a = r as { id: number; username: string; password_hash: string };
	return { id: a.id, username: a.username, passwordHash: a.password_hash };
}

function parseSplits(json: string): number[] {
	try {
		const v = JSON.parse(json);
		return Array.isArray(v) ? v.filter((n) => typeof n === 'number') : [];
	} catch {
		return [];
	}
}
