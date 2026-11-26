/** HTTP + WebSocket game server: `/health`, `/metrics`, `/ws`, and optional SvelteKit client handler. */
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import type { MapDef } from '@surf/shared';
import { PROTOCOL_VERSION, SERVER_ID_PROTOCOL, TICK_RATE } from '@surf/shared';
import { parseAdminUsernames } from './admin.ts';
import {
	DEFAULT_BACKUP_INTERVAL_MS,
	DEFAULT_BACKUP_KEEP,
	startBackupSchedule,
	type BackupSchedule
} from './backup.ts';
import { Db } from './db.ts';
import { DEFAULT_MAX_PENDING_PER_IP, Lobby, MODE_TICK_HZ, parseSnapshotHz } from './lobby.ts';
import type { LobbyOptions } from './lobby.ts';
import { defaultMapId, loadMaps } from './maps.ts';
import { ServerMetrics } from './metrics.ts';
import { flushRaceReplays } from './modes/race.ts';
import {
	clientIp,
	isOriginAllowed,
	normalizeIp,
	parseAllowedOrigins,
	parseTrustProxy,
	type AllowedOrigins,
	type TrustProxy
} from './proxy.ts';

export const DEFAULT_PORT = 27015;
export const DEFAULT_DB_PATH = resolve(fileURLToPath(new URL('..', import.meta.url)), 'data/surf.db');
/** Default per-IP connection limit when NODE_ENV=production and MAX_PER_IP is unset. */
export const DEFAULT_PROD_MAX_PER_IP = 12;
/** Time to wait for clients to acknowledge WebSocket close 1001 before force-terminating. */
export const DEFAULT_CLOSE_GRACE_MS = 2_000;

export type WebHandler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;

export interface ServerOptions extends Omit<LobbyOptions, 'maps' | 'db'> {
	/** 0 = random free port. Default PORT env or 27015. */
	port?: number;
	/** Private loopback metrics listener. Omit to disable, 0 for an ephemeral test port. */
	metricsPort?: number;
	/** Apply public connection-limit defaults when hosting a quick tunnel. */
	publicHost?: boolean;
	/** Bind address. Default HOST env or all interfaces. */
	host?: string;
	/** SQLite path or ':memory:'. Default DB_PATH env or apps/server/data/surf.db. */
	dbPath?: string;
	/** Maps to serve; default: MAPS from @surf/shared. */
	maps?: MapDef[];
	/** Proxy trust policy for clientIp (default: TRUST_PROXY env or 'loopback'). */
	trustProxy?: TrustProxy | string;
	/** WebSocket Origin allow-list (default: ALLOWED_ORIGINS env or null = allow all). */
	allowedOrigins?: AllowedOrigins | string | null;
	/** SvelteKit adapter-node handler function or path to `handler.js` (default: WEB_HANDLER env). */
	webHandler?: WebHandler | string;
	/** Directory for hourly online SQLite backups via `db.backup()` (default: BACKUP_DIR env, disabled when unset). */
	backupDir?: string;
	/** Backup interval in ms (default: BACKUP_INTERVAL_MS env or 3600000). */
	backupIntervalMs?: number;
	/** Number of newest backups to keep (default: BACKUP_KEEP env or 48). */
	backupKeep?: number;
	/** Grace period (ms) for open WebSockets to close cleanly with 1001 on shutdown. */
	closeGraceMs?: number;
}

export interface GameServer {
	port: number;
	metricsPort: number | null;
	host: string;
	lobby: Lobby;
	db: Db;
	metrics: ServerMetrics;
	/** Fail readiness and reject upgrades while the listener remains open. */
	beginDrain(): void;
	close(): Promise<void>;
}

function parseOptionalInt(raw: string | undefined, name: string, min: number): number | undefined {
	if (raw === undefined || raw.trim() === '') return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min) throw new Error(`Invalid ${name}: ${raw}`);
	return n;
}

async function resolveWebHandler(spec: WebHandler | string | undefined): Promise<WebHandler | null> {
	if (!spec) return null;
	if (typeof spec === 'function') return spec;
	const abs = resolve(spec);
	const mod = (await import(pathToFileURL(abs).href)) as { handler?: unknown };
	if (typeof mod.handler !== 'function') {
		throw new Error(`WEB_HANDLER (${abs}) does not export a handler function`);
	}
	return mod.handler as WebHandler;
}

export async function startServer(opts: ServerOptions = {}): Promise<GameServer> {
	const maps = opts.maps ?? loadMaps();
	if (maps.length === 0) {
		throw new Error(
			'No maps found: @surf/shared does not export a non-empty MAPS yet. Implement packages/shared/src/maps first.'
		);
	}
	const port = opts.port ?? Number(process.env.PORT || DEFAULT_PORT);
	const metricsPort = opts.metricsPort ?? parseOptionalInt(process.env.METRICS_PORT, 'METRICS_PORT', 1);
	if (metricsPort !== undefined && (!Number.isInteger(metricsPort) || metricsPort < 0 || metricsPort > 65535)) {
		throw new Error('METRICS_PORT must be a valid TCP port');
	}
	const host = opts.host ?? (process.env.HOST?.trim() || undefined);
	const dbPath = opts.dbPath ?? (process.env.DB_PATH || DEFAULT_DB_PATH);
	const trustProxy =
		typeof opts.trustProxy === 'string'
			? parseTrustProxy(opts.trustProxy)
			: (opts.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY));
	const allowedOrigins =
		opts.allowedOrigins === undefined
			? parseAllowedOrigins(process.env.ALLOWED_ORIGINS)
			: typeof opts.allowedOrigins === 'string'
				? parseAllowedOrigins(opts.allowedOrigins)
				: opts.allowedOrigins;
	const rawOrigin = process.env.ORIGIN?.trim();
	const publicOrigin = allowedOrigins?.sameOrigin && rawOrigin ? URL.parse(rawOrigin) : undefined;
	if (publicOrigin === null || (publicOrigin && publicOrigin.protocol !== 'http:' && publicOrigin.protocol !== 'https:')) {
		throw new Error('ORIGIN must be a valid HTTP or HTTPS URL');
	}
	const publicLimits = opts.publicHost || process.env.NODE_ENV === 'production';
	const maxPerIp =
		opts.maxPerIp ??
		parseOptionalInt(process.env.MAX_PER_IP, 'MAX_PER_IP', 0) ??
		(publicLimits ? DEFAULT_PROD_MAX_PER_IP : 0);
	const maxPendingPerIp =
		opts.maxPendingPerIp ??
		parseOptionalInt(process.env.MAX_PENDING_PER_IP, 'MAX_PENDING_PER_IP', 0) ??
		(publicLimits ? DEFAULT_MAX_PENDING_PER_IP : 0);
	const maxPending = opts.maxPending ?? parseOptionalInt(process.env.MAX_PENDING_CONNECTIONS, 'MAX_PENDING_CONNECTIONS', 1);
	const helloTimeoutMs = opts.helloTimeoutMs ?? parseOptionalInt(process.env.HELLO_TIMEOUT_MS, 'HELLO_TIMEOUT_MS', 100);
	const webHandler = await resolveWebHandler(opts.webHandler ?? (process.env.WEB_HANDLER?.trim() || undefined));
	const backupDir = opts.backupDir ?? (process.env.BACKUP_DIR?.trim() || undefined);
	const backupIntervalMs =
		opts.backupIntervalMs ?? parseOptionalInt(process.env.BACKUP_INTERVAL_MS, 'BACKUP_INTERVAL_MS', 1_000) ?? DEFAULT_BACKUP_INTERVAL_MS;
	const backupKeep =
		opts.backupKeep ?? parseOptionalInt(process.env.BACKUP_KEEP, 'BACKUP_KEEP', 1) ?? DEFAULT_BACKUP_KEEP;
	const closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;

	const db = new Db(dbPath);
	const snapshotHz = opts.snapshotHz ?? parseSnapshotHz(process.env.SNAPSHOT_HZ);
	const metrics = new ServerMetrics(MODE_TICK_HZ, undefined, snapshotHz);
	let lobby: Lobby;
	try {
		lobby = new Lobby({
			...opts,
			maxPerIp,
			maxPendingPerIp,
			...(maxPending === undefined ? {} : { maxPending }),
			...(helloTimeoutMs === undefined ? {} : { helloTimeoutMs }),
			metrics: opts.metrics ?? metrics,
			maps,
			db,
			initialMap: opts.initialMap ?? defaultMapId(maps),
			snapshotHz,
			adminUsernames: opts.adminUsernames ?? parseAdminUsernames(process.env.ADMIN_USERNAMES)
		});
	} catch (err) {
		metrics.close();
		db.close();
		throw err;
	}

	let draining = false;
	const http = createServer((req, res) => {
		const path = (req.url ?? '/').split('?')[0];
		if (path === '/health') {
			res.writeHead(draining ? 503 : 200, {
				'content-type': 'application/json',
				'cache-control': 'no-store',
				'access-control-allow-origin': '*'
			});
			res.end(
				JSON.stringify({
					ok: !draining,
					serverId: db.serverId,
					version: PROTOCOL_VERSION,
					tickRate: TICK_RATE,
					map: lobby.currentMap.id,
					mode: lobby.currentMap.kind,
					players: lobby.playerCount,
					lobbies: lobby.lobbyCounts()
				})
			);
			return;
		}
		if (path === '/metrics') {
			res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
			return;
		}
		if (path === '/ws') {
			res.writeHead(426, { 'content-type': 'text/plain', upgrade: 'websocket' }).end('upgrade required');
			return;
		}
		if (webHandler) {
			webHandler(req, res, () => {
				if (!res.writableEnded) res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
			});
			return;
		}
		res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
	});

	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 8 * 1024,
		handleProtocols: (protocols) => protocols.has(SERVER_ID_PROTOCOL)
			? SERVER_ID_PROTOCOL
			: (protocols.values().next().value ?? false)
	});
	http.on('upgrade', (req, socket, head) => {
		socket.on('error', () => socket.destroy());
		const reject = (status: number) => {
			socket.end(
				`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
				() => socket.destroy()
			);
		};
		if (draining) return reject(503);
		const path = (req.url ?? '/').split('?')[0];
		if (path !== '/ws') return reject(404);
		if (!isOriginAllowed(req, allowedOrigins, publicOrigin?.origin)) return reject(403);
		const ip = clientIp(req, trustProxy);
		const peer = normalizeIp(req.socket.remoteAddress);
		if (trustProxy.requireVisitorIp && peer && trustProxy.isTrusted(peer) && ip === null) return reject(403);
		const status = lobby.upgradeStatus(ip);
		if (status !== null) return reject(status);
		wss.handleUpgrade(req, socket, head, (ws) => lobby.handleConnection(ws, ip));
	});

	const metricsHttp = metricsPort === undefined ? null : createServer((req, res) => {
		if (req.method !== 'GET' || req.url !== '/metrics') {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, {
			'content-type': 'text/plain; version=0.0.4; charset=utf-8',
			'cache-control': 'no-store'
		}).end(metrics.render(lobby));
	});
	const listen = (server: typeof http, port: number, host?: string) => new Promise<void>((ok, fail) => {
		server.once('error', fail);
		server.listen(port, host, () => {
			server.off('error', fail);
			ok();
		});
	});
	try {
		if (metricsHttp) await listen(metricsHttp, metricsPort!, '127.0.0.1');
		await listen(http, port, host);
	} catch (err) {
		metricsHttp?.close();
		wss.close();
		lobby.close();
		metrics.close();
		db.close();
		throw err;
	}
	const addr = http.address() as AddressInfo;
	const backups: BackupSchedule | null =
		backupDir && dbPath !== ':memory:'
			? startBackupSchedule(db, { dir: backupDir, intervalMs: backupIntervalMs, keep: backupKeep, log: opts.log })
			: null;

	const beginDrain = () => {
		draining = true;
	};
	let closing: Promise<void> | null = null;
	const close = (): Promise<void> => {
		if (closing) return closing;
		beginDrain();
		closing = (async () => {
			// Stop timers, flush playtime/economy, and send WebSocket close 1001 to every client.
			lobby.close();
			for (const s of wss.clients) {
				if (s.readyState === s.OPEN || s.readyState === s.CONNECTING) {
					s.close(1001, 'server shutting down');
				}
			}
			// Wait briefly for the 1001 close frames to flush and clients to acknowledge.
			if (wss.clients.size > 0 && closeGraceMs > 0) {
				await new Promise<void>((done) => {
					let pending = wss.clients.size;
					const finish = () => {
						clearTimeout(timer);
						done();
					};
					const timer = setTimeout(finish, closeGraceMs);
					timer.unref();
					const onDone = () => {
						if (--pending <= 0) finish();
					};
					for (const s of wss.clients) {
						if (s.readyState === s.CLOSED) onDone();
						else s.once('close', onDone);
					}
				});
			}
			for (const s of wss.clients) s.terminate();
			wss.close();
			http.closeIdleConnections?.();
			await new Promise<void>((done) => {
				const hard = setTimeout(() => {
					http.closeAllConnections();
					done();
				}, 1_500);
				hard.unref();
				http.close(() => {
					clearTimeout(hard);
					done();
				});
				http.closeAllConnections();
			});
			if (metricsHttp) await new Promise<void>((done) => {
				metricsHttp.close(() => done());
				metricsHttp.closeAllConnections();
			});
			if (backups) await backups.stop();
			await flushRaceReplays(db);
			metrics.close();
			db.close();
		})();
		return closing;
	};

	return {
		port: addr.port,
		metricsPort: metricsHttp ? (metricsHttp.address() as AddressInfo).port : null,
		host: addr.address,
		lobby,
		db,
		metrics,
		beginDrain,
		close
	};
}

/** Load apps/server/.env if present (Node's built-in loader). */
export function loadDotEnv(): void {
	const file = resolve(fileURLToPath(new URL('..', import.meta.url)), '.env');
	try {
		process.loadEnvFile(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}
