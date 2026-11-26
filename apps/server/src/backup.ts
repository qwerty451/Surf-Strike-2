/**
 * Online SQLite backups via `better-sqlite3` `db.backup()` (docs/hosting.md#backups).
 *
 * Uses SQLite's online backup API rather than copying a live WAL database file.
 * Runs in-process on an hourly timer so a single pod with an RWO volume needs no
 * second container or lock coordination.
 */
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';

export const DEFAULT_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_BACKUP_KEEP = 48;

const BACKUP_NAME_RE = /^surf-\d{8}T\d{6}Z\.db$/;

/** UTC filename: `surf-YYYYMMDDTHHMMSSZ.db` (lexicographically sortable). */
export function backupFilename(now: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`surf-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
		`T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z.db`
	);
}

/**
 * Write one consistent backup to `dir/surf-<UTC>.db` via an atomic `.tmp` rename,
 * then prune older backups so at most `keep` remain.
 */
export async function runBackup(
	db: Db,
	dir: string,
	keep = DEFAULT_BACKUP_KEEP,
	now: Date = new Date()
): Promise<string> {
	mkdirSync(dir, { recursive: true });
	// The scheduler serializes backups. Clean up partial copies left by a stopped process.
	for (const name of readdirSync(dir)) {
		const finalName = name.replace(/\.tmp(?:-journal)?$/, '');
		if (name !== finalName && BACKUP_NAME_RE.test(finalName)) rmSync(join(dir, name), { force: true });
	}
	const finalPath = join(dir, backupFilename(now));
	const tmpPath = `${finalPath}.tmp`;
	try {
		await db.db.backup(tmpPath);
		renameSync(tmpPath, finalPath);
	} catch (err) {
		rmSync(tmpPath, { force: true });
		throw err;
	}
	pruneBackups(dir, keep);
	return finalPath;
}

/** Delete the oldest `surf-<UTC>.db` files in `dir`, keeping the newest `keep`. */
export function pruneBackups(dir: string, keep = DEFAULT_BACKUP_KEEP): string[] {
	if (keep < 1) return [];
	const files = readdirSync(dir)
		.filter((name) => BACKUP_NAME_RE.test(name))
		.sort();
	if (files.length <= keep) return [];
	const removed: string[] = [];
	for (const name of files.slice(0, files.length - keep)) {
		rmSync(join(dir, name), { force: true });
		removed.push(name);
	}
	return removed;
}

export interface BackupScheduleOptions {
	dir: string;
	intervalMs?: number;
	keep?: number;
	log?: (msg: string) => void;
}

export interface BackupSchedule {
	runNow(): Promise<string | null>;
	stop(): Promise<void>;
}

/**
 * Schedule periodic online backups in-process. Skips overlapping runs and waits
 * briefly for an in-flight backup on `stop()` so shutdown stays within 5 s.
 */
export function startBackupSchedule(db: Db, opts: BackupScheduleOptions): BackupSchedule {
	const intervalMs = opts.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MS;
	const keep = opts.keep ?? DEFAULT_BACKUP_KEEP;
	const log = opts.log ?? ((m: string) => console.log(m));
	let stopped = false;
	let inFlight: Promise<string | null> | null = null;

	const runNow = (): Promise<string | null> => {
		if (stopped) return Promise.resolve(null);
		if (inFlight) return inFlight;
		inFlight = runBackup(db, opts.dir, keep)
			.then((path) => {
				log(`backup wrote ${path}`);
				return path;
			})
			.catch((err) => {
				log(`backup failed: ${(err as Error).message}`);
				return null;
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};

	const timer = setInterval(() => {
		void runNow();
	}, intervalMs);
	timer.unref();

	return {
		runNow,
		async stop() {
			stopped = true;
			clearInterval(timer);
			if (inFlight) {
				await Promise.race([
					inFlight,
					new Promise<void>((ok) => {
						const t = setTimeout(ok, 2_000);
						t.unref();
					})
				]);
			}
		}
	};
}
