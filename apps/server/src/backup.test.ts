import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { backupFilename, runBackup, startBackupSchedule } from './backup.ts';
import { Db } from './db.ts';

describe('database backups', () => {
	it('formats UTC filenames cleanly', () => {
		assert.equal(backupFilename(new Date('2026-11-25T04:05:09Z')), 'surf-20261125T040509Z.db');
	});

	it('creates a consistent standalone SQLite backup from a live WAL database and prunes old files', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'surf-backup-'));
		const dbPath = join(dir, 'surf.db');
		const backupDir = join(dir, 'backups');
		const db = new Db(dbPath);
		try {
			const acc = db.createAccount('Alice', 'scrypt$16384$8$1$salt$hash', 1_000);
			assert.ok(acc);
			db.saveRun(acc.id, 'surf_aurora', 1234, [500], 2_000);

			// Produce 4 backups with keep=2; only the newest 2 must remain.
			const dates = [
				new Date('2026-11-25T01:00:00Z'),
				new Date('2026-11-25T02:00:00Z'),
				new Date('2026-11-25T03:00:00Z'),
				new Date('2026-11-25T04:00:00Z')
			];
			let lastPath = '';
			for (const d of dates) {
				lastPath = await runBackup(db, backupDir, 2, d);
			}
			const files = readdirSync(backupDir).sort();
			assert.deepEqual(files, ['surf-20261125T030000Z.db', 'surf-20261125T040000Z.db']);
			assert.equal(existsSync(`${lastPath}.tmp`), false);

			// Mutate live DB after backup; backup file must still be valid and independent.
			db.createAccount('Bob', 'scrypt$16384$8$1$salt$hash', 3_000);
			const restored = new Database(lastPath, { readonly: true });
			try {
				const check = restored.pragma('integrity_check') as Array<{ integrity_check: string }>;
				assert.equal(check[0]?.integrity_check, 'ok');
				const users = restored.prepare('SELECT username FROM accounts ORDER BY id').all() as Array<{ username: string }>;
				assert.deepEqual(users, [{ username: 'Alice' }]);
			} finally {
				restored.close();
			}
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('removes interrupted partial copies before the next backup and keeps valid backups', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'surf-backup-stale-'));
		const db = new Db(':memory:');
		try {
			const first = await runBackup(db, dir, 2, new Date('2026-11-25T01:00:00Z'));
			const stale = join(dir, 'surf-20261125T020000Z.db.tmp');
			writeFileSync(stale, 'partial backup');
			writeFileSync(`${stale}-journal`, 'partial journal');
			const unrelated = join(dir, 'unrelated.db.tmp');
			writeFileSync(unrelated, '');
			const last = await runBackup(db, dir, 2, new Date('2026-11-25T03:00:00Z'));
			assert.deepEqual(readdirSync(dir).sort(), [first, last, unrelated].map((path) => basename(path)).sort());
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('schedule runs and stops cleanly', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'surf-backup-sched-'));
		const db = new Db(join(dir, 'surf.db'));
		const logs: string[] = [];
		try {
			const sched = startBackupSchedule(db, {
				dir: join(dir, 'backups'),
				intervalMs: 60_000,
				keep: 48,
				log: (m) => logs.push(m)
			});
			const path = await sched.runNow();
			assert.ok(path && existsSync(path));
			await sched.stop();
			assert.equal(await sched.runNow(), null);
			assert.equal(logs.length, 1);
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
