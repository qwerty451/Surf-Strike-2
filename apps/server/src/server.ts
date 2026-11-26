/** HTTP + WebSocket game server: `/health` and `/ws`. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { MapDef } from '@surf/shared';
import { PROTOCOL_VERSION, TICK_RATE } from '@surf/shared';
import { clientIp, parseAdminUsernames } from './admin.ts';
import { Db } from './db.ts';
import { Lobby } from './lobby.ts';
import type { LobbyOptions } from './lobby.ts';
import { defaultMapId, loadMaps } from './maps.ts';

export const DEFAULT_PORT = 27015;
export const DEFAULT_DB_PATH = resolve(fileURLToPath(new URL('..', import.meta.url)), 'data/surf.db');

export interface ServerOptions extends Omit<LobbyOptions, 'maps' | 'db'> {
	/** 0 = random free port. Default PORT env or 27015. */
	port?: number;
	host?: string;
	/** SQLite path or ':memory:'. Default DB_PATH env or apps/server/data/surf.db. */
	dbPath?: string;
	/** Maps to serve; default: MAPS from @surf/shared. */
	maps?: MapDef[];
}

export interface GameServer {
	port: number;
	lobby: Lobby;
	db: Db;
	close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<GameServer> {
	const maps = opts.maps ?? loadMaps();
	if (maps.length === 0) {
		throw new Error(
			'No maps found: @surf/shared does not export a non-empty MAPS yet. Implement packages/shared/src/maps first.'
		);
	}
	const port = opts.port ?? Number(process.env.PORT || DEFAULT_PORT);
	const dbPath = opts.dbPath ?? (process.env.DB_PATH || DEFAULT_DB_PATH);
	const db = new Db(dbPath);
	const lobby = new Lobby({
		...opts,
		maps,
		db,
		initialMap: opts.initialMap ?? defaultMapId(maps),
		adminUsernames: opts.adminUsernames ?? parseAdminUsernames(process.env.ADMIN_USERNAMES)
	});

	const http = createServer((req, res) => {
		const path = (req.url ?? '/').split('?')[0];
		if (path === '/health') {
			res.writeHead(200, {
				'content-type': 'application/json',
				'cache-control': 'no-store',
				'access-control-allow-origin': '*'
			});
			res.end(
				JSON.stringify({
					ok: true,
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
		res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
	});

	const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 8 * 1024 });
	wss.on('connection', (socket, req) => lobby.handleConnection(socket, clientIp(req)));

	await new Promise<void>((ok, fail) => {
		http.once('error', fail);
		http.listen(port, opts.host, () => {
			http.off('error', fail);
			ok();
		});
	});
	const actual = (http.address() as AddressInfo).port;

	return {
		port: actual,
		lobby,
		db,
		close: () =>
			new Promise<void>((ok) => {
				lobby.close();
				for (const s of wss.clients) s.terminate();
				wss.close();
				http.closeAllConnections();
				http.close(() => {
					db.close();
					ok();
				});
			})
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
