/**
 * Server discovery (docs/architecture.md#client-connect-flow).
 * Pure URL helpers plus the `/api/server` fetch.
 */
/**
 * Dev builds fall back to a local dev game server on 27016, so they never
 * touch the production host on 27015 (./start.sh).
 */
export const DEV_FALLBACK_URL = 'ws://localhost:27016/ws';
export const DISCOVERY_STALE_MS = 3 * 60 * 1000;
export const RETRY_MS = 10_000;
const DISCOVERY_ENDPOINT = '/api/server';

/**
 * Normalise a server address to a WebSocket URL:
 * https → wss, http → ws, bare host → wss, and append `/ws` when the path is empty.
 */
export function toWsUrl(input: string): string | null {
	let s = input.trim();
	if (!s) return null;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
		const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(s);
		s = `${local ? 'ws' : 'wss'}://${s}`;
	}
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return null;
	}
	const proto = u.protocol.toLowerCase();
	if (proto === 'https:') u.protocol = 'wss:';
	else if (proto === 'http:') u.protocol = 'ws:';
	else if (proto !== 'ws:' && proto !== 'wss:') return null;
	if (u.pathname === '' || u.pathname === '/') u.pathname = '/ws';
	u.hash = '';
	return u.toString();
}

/** `?server=<url>` override, or null. */
export function serverOverride(search: string): string | null {
	try {
		const v = new URLSearchParams(search).get('server');
		return v ? toWsUrl(v) : null;
	} catch {
		return null;
	}
}

/** Same-origin WebSocket URL (`wss://<host>/ws`, or `ws://` on HTTP) for self-hosted builds. */
export function sameOriginWsUrl(loc: Pick<Location, 'origin'> | null | undefined): string | null {
	return loc?.origin ? toWsUrl(loc.origin) : null;
}

function timeOf(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
	if (typeof v === 'string') {
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

/**
 * Interpret a discovery response: `{ url, startedAt?, lastSeen? }`.
 * Null url or a heartbeat older than 3 minutes means "no server".
 */
export function parseDiscovery(body: unknown, nowMs: number): string | null {
	if (!body || typeof body !== 'object') return null;
	const b = body as Record<string, unknown>;
	if (typeof b.url !== 'string' || !b.url) return null;
	const seen = timeOf(b.lastSeen) ?? timeOf(b.startedAt);
	if (seen !== null && nowMs - seen > DISCOVERY_STALE_MS) return null;
	return toWsUrl(b.url);
}

/** Fetch `/api/server`; resolves to a ws URL or null (never throws). */
export async function discover(
	fetchFn: typeof fetch,
	signal?: AbortSignal,
	endpoint = DISCOVERY_ENDPOINT
): Promise<string | null> {
	try {
		const res = await fetchFn(endpoint, { signal, cache: 'no-store' });
		if (!res.ok) return null;
		return parseDiscovery(await res.json(), Date.now());
	} catch {
		return null;
	}
}

/**
 * Within discovery, quick tunnels can change URL without changing databases.
 * Explicit connections and fixed URLs also scope sessions to their own origin.
 */
export function sessionScope(url: string, serverId: string, discovered: boolean): string {
	const target = new URL(url);
	if (discovered && target.protocol === 'wss:' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(target.host)) {
		return `discovery:${DISCOVERY_ENDPOINT}:${serverId}`;
	}
	return `${target.origin}:${serverId}`;
}
