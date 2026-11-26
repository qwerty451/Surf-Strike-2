/** cloudflared + discovery helpers used by host.ts (pure parts are unit-tested). */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TUNNEL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/i;

/** Extract the quick-tunnel URL from a chunk of cloudflared output. */
export function parseTunnelUrl(text: string): string | null {
	const m = TUNNEL_RE.exec(text);
	if (!m) return null;
	// cloudflared prints https://api.trycloudflare.com in some errors; that is not a tunnel.
	if (/^https:\/\/api\.trycloudflare\.com$/i.test(m[0])) return null;
	return m[0].toLowerCase();
}

/** True when `url` is an ephemeral Cloudflare quick tunnel (`*.trycloudflare.com`). */
export function isQuickTunnelUrl(url: string): boolean {
	try {
		return new URL(url).hostname.toLowerCase().endsWith('.trycloudflare.com');
	} catch {
		return false;
	}
}

/** cloudflared binary: $CLOUDFLARED, ~/.local/bin/cloudflared, else from PATH. */
export function cloudflaredBinary(env: NodeJS.ProcessEnv = process.env): string {
	if (env.CLOUDFLARED) return env.CLOUDFLARED;
	const local = join(homedir(), '.local/bin/cloudflared');
	return existsSync(local) ? local : 'cloudflared';
}

export interface HostEnv {
	hostSecret: string;
	discoveryUrl: string;
	port: number;
	/** Optional fixed self-hosted server URL; local hosting refuses to run while it answers healthy. */
	fixedServerUrl?: string;
}

function validateHttpUrl(raw: string, name: string): string {
	const cleaned = raw.trim().replace(/\/+$/, '');
	try {
		const u = new URL(cleaned);
		if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
			throw new Error('bad protocol');
		}
	} catch {
		throw new Error(`${name} is not a valid https URL: ${cleaned}`);
	}
	return cleaned;
}

/** Read and check the host env vars. Throws with a readable message. */
export function readHostEnv(env: NodeJS.ProcessEnv = process.env): HostEnv {
	const missing: string[] = [];
	const hostSecret = env.HOST_SECRET?.trim() ?? '';
	const rawDiscovery = env.DISCOVERY_URL?.trim() ?? '';
	if (!hostSecret) missing.push('HOST_SECRET');
	if (!rawDiscovery) missing.push('DISCOVERY_URL');
	if (missing.length) {
		throw new Error(
			`Missing ${missing.join(' and ')}. Copy apps/server/.env.example to apps/server/.env and fill it in.`
		);
	}
	if (hostSecret.length < 32) throw new Error('HOST_SECRET must be at least 32 characters.');
	const discoveryUrl = validateHttpUrl(rawDiscovery, 'DISCOVERY_URL');
	const port = Number(env.PORT || 27015);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT is invalid: ${env.PORT}`);
	const rawFixed = env.FIXED_SERVER_URL?.trim() ?? '';
	const fixedServerUrl = rawFixed ? validateHttpUrl(rawFixed, 'FIXED_SERVER_URL') : undefined;
	return { hostSecret, discoveryUrl, port, ...(fixedServerUrl ? { fixedServerUrl } : {}) };
}

/** Check whether `url/health` answers 200 with `{ ok: true }`. Never throws. */
export async function isServerHealthy(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
	try {
		const base = url.replace(/\/+$/, '').replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
		const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
		if (!res.ok) return false;
		const body = (await res.json()) as { ok?: unknown };
		return body?.ok === true;
	} catch {
		return false;
	}
}

/** Read the currently published URL from `GET <discoveryUrl>/api/server`. Never throws. */
export async function fetchPublishedUrl(
	env: Pick<HostEnv, 'discoveryUrl'>,
	fetchImpl: typeof fetch = fetch
): Promise<string | null> {
	try {
		const res = await fetchImpl(`${env.discoveryUrl}/api/server`, { signal: AbortSignal.timeout(5_000) });
		if (!res.ok) return null;
		const body = (await res.json()) as { url?: unknown };
		return typeof body?.url === 'string' && body.url ? body.url.replace(/\/+$/, '') : null;
	} catch {
		return null;
	}
}

/**
 * Detect a live fixed (non-quick-tunnel) self-hosted server that a local host must
 * not overwrite. Checks `FIXED_SERVER_URL` first, then the current discovery entry.
 */
export async function findActiveFixedServer(
	env: Pick<HostEnv, 'discoveryUrl' | 'fixedServerUrl'>,
	fetchImpl: typeof fetch = fetch
): Promise<string | null> {
	if (env.fixedServerUrl && (await isServerHealthy(env.fixedServerUrl, fetchImpl))) {
		return env.fixedServerUrl;
	}
	const current = await fetchPublishedUrl(env, fetchImpl);
	if (current && !isQuickTunnelUrl(current) && (await isServerHealthy(current, fetchImpl))) {
		return current;
	}
	return null;
}

/** POST {url} (and optional expectedUrl when clearing) to the discovery API. Never logs the secret. */
export async function publishUrl(
	env: Pick<HostEnv, 'hostSecret' | 'discoveryUrl'>,
	url: string | null,
	fetchImpl: typeof fetch = fetch,
	expectedUrl?: string
): Promise<boolean> {
	const payload = url === null && expectedUrl ? { url: null, expectedUrl } : { url };
	const res = await fetchImpl(`${env.discoveryUrl}/api/server`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${env.hostSecret}` },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(10_000)
	});
	if (!res.ok) {
		const body = (await res.text().catch(() => '')).slice(0, 200);
		throw new Error(`discovery API answered ${res.status}${body ? `: ${body}` : ''}`);
	}
	if (url !== null) return true;
	const result = (await res.json().catch(() => null)) as { cleared?: boolean } | null;
	return result?.cleared !== false;
}

/**
 * Clear discovery on shutdown only if it still points to `ownUrl`. Checks the live
 * discovery record first (so even older `/api/server` deployments are protected)
 * and sends `expectedUrl` for server-side enforcement. Returns true if cleared.
 */
export async function clearPublishedUrl(
	env: Pick<HostEnv, 'hostSecret' | 'discoveryUrl'>,
	ownUrl: string,
	fetchImpl: typeof fetch = fetch
): Promise<boolean> {
	const normalizedOwn = ownUrl.replace(/\/+$/, '');
	const current = await fetchPublishedUrl(env, fetchImpl);
	if (current && current !== normalizedOwn) return false;
	return publishUrl(env, null, fetchImpl, normalizedOwn);
}
