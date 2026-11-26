/**
 * Discovery API (docs/architecture.md#start-up-flow).
 *
 * POST /api/server  Authorization: Bearer <HOST_SECRET>  body { url: string | null }
 *   Keeps { url, startedAt, lastSeen } in the Vercel Runtime Cache for as long as
 *   the host sends heartbeats. Not durable, and it needs no storage product: the
 *   heartbeats would use up a free Blob store's monthly operations in two days.
 * GET  /api/server  -> { url, lastSeen } or { url: null } (absent, cleared or stale > 3 min).
 *   The CDN answers for 5 s, so many waiting clients cost few cache reads.
 *
 * Both run in one region (the runtime cache is regional). Outside Vercel the cache
 * is in memory.
 *
 * Env (server only): HOST_SECRET, FIXED_SERVER_URL (authoritative when set).
 *
 * Env vars are read from process.env: SvelteKit 3's `$env/dynamic/private`
 * only exposes variables declared with defineEnvVars.
 */
import { json } from '@sveltejs/kit';
import { getCache } from '@vercel/functions';
import type { RequestHandler } from './$types';

const KEY = 'discovery-server';
const STALE_MS = 3 * 60 * 1000;
const MAX_URL = 512;
const NO_STORE = { 'cache-control': 'no-store, max-age=0' };
const GET_HEADERS = { ...NO_STORE, 'vercel-cdn-cache-control': 'max-age=5' };

interface DiscoveryRecord {
	url: string | null;
	startedAt: number | null;
	lastSeen: number;
}

function env(name: string): string | undefined {
	const p = (globalThis as { process?: { env?: { [k: string]: string | undefined } } }).process;
	const v = p?.env?.[name];
	return v ? v : undefined;
}

/** The cache's own hash is 32 bits, and on the Hobby plan all projects share the cache. */
function cache() {
	return getCache({ namespace: 'surf-strike', keyHashFunction: (k) => k });
}

async function sha256(s: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** Constant-time comparison (hash first so lengths always match). */
async function safeEqual(a: string, b: string): Promise<boolean> {
	const [x, y] = await Promise.all([sha256(a), sha256(b)]);
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
	return diff === 0;
}

/** Accept null, https/wss URLs, or http/ws on localhost. Returns the normalized URL or undefined if invalid. */
function normalizeServerUrl(v: unknown): string | null | undefined {
	if (v === null) return null;
	if (typeof v !== 'string' || v.length === 0 || v.length > MAX_URL) return undefined;
	let u: URL;
	try {
		u = new URL(v);
	} catch {
		return undefined;
	}
	if (u.username || u.password || u.search || u.hash) return undefined;
	const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
	const secure = u.protocol === 'https:' || u.protocol === 'wss:';
	const plain = u.protocol === 'http:' || u.protocol === 'ws:';
	if (!secure && !(plain && local)) return undefined;
	const path = u.pathname.replace(/\/+$/, '');
	return `${u.protocol}//${u.host}${path}`;
}

async function readRecord(): Promise<DiscoveryRecord | null> {
	const data = (await cache().get(KEY)) as Partial<DiscoveryRecord> | null | undefined;
	if (typeof data !== 'object' || data === null || typeof data.lastSeen !== 'number') return null;
	return {
		url: typeof data.url === 'string' ? data.url : null,
		startedAt: typeof data.startedAt === 'number' ? data.startedAt : null,
		lastSeen: data.lastSeen
	};
}

export const GET: RequestHandler = async () => {
	const fixed = env('FIXED_SERVER_URL')?.trim();
	if (fixed) {
		const url = normalizeServerUrl(fixed);
		if (!url) return json({ error: 'invalid FIXED_SERVER_URL' }, { status: 503, headers: NO_STORE });
		return json({ url }, { headers: NO_STORE });
	}
	try {
		const rec = await readRecord();
		if (!rec || !rec.url || Date.now() - rec.lastSeen > STALE_MS) return json({ url: null }, { headers: GET_HEADERS });
		return json({ url: rec.url, lastSeen: rec.lastSeen }, { headers: GET_HEADERS });
	} catch (err) {
		console.error('discovery GET failed:', (err as Error).message);
		return json({ url: null }, { headers: NO_STORE });
	}
};

export const POST: RequestHandler = async ({ request }) => {
	const secret = env('HOST_SECRET');
	if (!secret) {
		return json({ error: 'discovery not configured' }, { status: 503, headers: NO_STORE });
	}
	const auth = request.headers.get('authorization') ?? '';
	const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!(await safeEqual(given, secret))) {
		return json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON' }, { status: 400, headers: NO_STORE });
	}
	const rawBody = body as { url?: unknown; expectedUrl?: unknown } | null;
	const url = normalizeServerUrl(rawBody?.url);
	if (url === undefined) {
		return json({ error: 'url must be null or an https/wss URL' }, { status: 400, headers: NO_STORE });
	}
	let expectedUrl: string | null | undefined = undefined;
	if (rawBody && rawBody.expectedUrl !== undefined) {
		expectedUrl = normalizeServerUrl(rawBody.expectedUrl);
		if (!expectedUrl) {
			return json({ error: 'expectedUrl must be a valid https/wss URL' }, { status: 400, headers: NO_STORE });
		}
	}

	// A deployment-level URL takes precedence without reading or writing the shared cache.
	const fixed = env('FIXED_SERVER_URL')?.trim();
	if (fixed) {
		const fixedUrl = normalizeServerUrl(fixed);
		if (!fixedUrl) return json({ error: 'invalid FIXED_SERVER_URL' }, { status: 503, headers: NO_STORE });
		if (url === null) return json({ ok: true, cleared: false, url: fixedUrl }, { headers: NO_STORE });
		return json({ error: 'fixed server configured', url: fixedUrl }, { status: 409, headers: NO_STORE });
	}

	try {
		const now = Date.now();
		const prev = await readRecord().catch(() => null);
		if (url === null && expectedUrl && prev?.url && prev.url !== expectedUrl) {
			return json({ ok: true, cleared: false, url: prev.url }, { headers: NO_STORE });
		}
		let startedAt: number | null = null;
		if (url) {
			startedAt = prev && prev.url === url && prev.startedAt ? prev.startedAt : now;
		}
		const rec: DiscoveryRecord = { url, startedAt, lastSeen: now };
		await cache().set(KEY, rec, { ttl: STALE_MS / 1000, name: KEY });
		// A failed write is only logged by the cache, so read it back.
		const kept = await readRecord();
		if (kept?.lastSeen !== now) throw new Error('the record was not kept');
		return json({ ok: true, ...(url === null ? { cleared: true } : {}), ...rec }, { headers: NO_STORE });
	} catch (err) {
		console.error('discovery POST failed:', (err as Error).message);
		return json({ error: 'cache write failed' }, { status: 502, headers: NO_STORE });
	}
};
