/**
 * Reverse-proxy IP extraction (`TRUST_PROXY`) and WebSocket `Origin` allow-list
 * (`ALLOWED_ORIGINS`) for public self-hosted deployments (docs/hosting.md).
 */
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { TLSSocket } from 'node:tls';

interface CidrV4 {
	kind: 4;
	net: number;
	mask: number;
}

interface CidrV6 {
	kind: 6;
	net: bigint;
	mask: bigint;
}

type Cidr = CidrV4 | CidrV6;

export interface TrustProxy {
	/** Mode label for logs/diagnostics. */
	readonly label: string;
	/** Whether `X-Forwarded-For` is accepted (false in `cf`-only or `none` mode). */
	readonly allowXff: boolean;
	/** Require a valid visitor IP when the peer is trusted. */
	readonly requireVisitorIp?: boolean;
	/** True when `ip` (normalized IPv4/IPv6) is a trusted proxy hop. */
	isTrusted(ip: string): boolean;
}

export interface AllowedOrigins {
	readonly origins: ReadonlySet<string>;
	readonly sameOrigin: boolean;
}

const LOOPBACK_CIDRS: Cidr[] = [parseCidr('127.0.0.0/8')!, parseCidr('::1/128')!];

const PRIVATE_CIDRS: Cidr[] = [
	...LOOPBACK_CIDRS,
	parseCidr('10.0.0.0/8')!,
	parseCidr('172.16.0.0/12')!,
	parseCidr('192.168.0.0/16')!,
	parseCidr('100.64.0.0/10')!,
	parseCidr('169.254.0.0/16')!,
	parseCidr('fc00::/7')!,
	parseCidr('fe80::/10')!
];

/** Strip IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` -> `1.2.3.4`) and validate. */
export function normalizeIp(raw: string | undefined | null): string | null {
	if (!raw) return null;
	let s = raw.trim();
	if (s.toLowerCase().startsWith('::ffff:')) {
		const mapped = s.slice(7);
		if (isIP(mapped) === 4) s = mapped;
	}
	return isIP(s) ? s : null;
}

export function isLoopback(addr: string): boolean {
	if (addr === 'localhost') return true;
	const ip = normalizeIp(addr);
	if (!ip) return false;
	return matchesAny(ip, LOOPBACK_CIDRS);
}

function ipv4ToUint32(ip: string): number {
	const p = ip.split('.');
	return (((Number(p[0]) << 24) | (Number(p[1]) << 16) | (Number(p[2]) << 8) | Number(p[3])) >>> 0);
}

function ipv6ToBigInt(ip: string): bigint {
	const [head, tail] = ip.toLowerCase().split('::') as [string, string | undefined];
	const a = head ? head.split(':') : [];
	const b = tail ? tail.split(':') : [];
	const groups =
		tail === undefined ? a : [...a, ...Array<string>(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
	let out = 0n;
	for (const g of groups) out = (out << 16n) | BigInt(parseInt(g || '0', 16));
	return out;
}

function parseCidr(raw: string): Cidr | null {
	const slash = raw.indexOf('/');
	const ipPart = normalizeIp(slash === -1 ? raw : raw.slice(0, slash));
	if (!ipPart) return null;
	const v = isIP(ipPart);
	const maxBits = v === 4 ? 32 : 128;
	const suffix = raw.slice(slash + 1);
	if (slash !== -1 && !/^\d+$/.test(suffix)) return null;
	const bits = slash === -1 ? maxBits : Number(suffix);
	if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return null;
	if (v === 4) {
		const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
		return { kind: 4, net: (ipv4ToUint32(ipPart) & mask) >>> 0, mask };
	}
	const full = (1n << 128n) - 1n;
	const mask = bits === 0 ? 0n : (full << BigInt(128 - bits)) & full;
	return { kind: 6, net: ipv6ToBigInt(ipPart) & mask, mask };
}

function matchesAny(ip: string, cidrs: readonly Cidr[]): boolean {
	const v = isIP(ip);
	if (v === 4) {
		const n = ipv4ToUint32(ip);
		for (const c of cidrs) if (c.kind === 4 && ((n & c.mask) >>> 0) === c.net) return true;
		return false;
	}
	if (v === 6) {
		const n = ipv6ToBigInt(ip);
		for (const c of cidrs) if (c.kind === 6 && (n & c.mask) === c.net) return true;
		return false;
	}
	return false;
}

/**
 * Parse `TRUST_PROXY`:
 * - unset / `loopback`: trust `CF-Connecting-IP` and `X-Forwarded-For` from loopback only (local `cloudflared` default)
 * - `none` / `off` / `false`: ignore forwarded headers
 * - `private` / `cluster`: trust loopback and RFC1918/ULA/CGNAT pod/proxy hops
 * - `cf:<list>`: require `CF-Connecting-IP` from the listed proxy IPs or CIDRs, ignoring XFF
 * - comma-separated IPs, CIDRs, or keywords (e.g. `loopback,10.42.0.0/16`)
 */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
	const trimmed = raw?.trim() ?? '';
	if (!trimmed || trimmed.toLowerCase() === 'loopback') {
		return { label: 'loopback', allowXff: true, isTrusted: (ip) => matchesAny(ip, LOOPBACK_CIDRS) };
	}
	const lower = trimmed.toLowerCase();
	if (lower === 'none' || lower === 'off' || lower === 'false' || lower === '0') {
		return { label: 'none', allowXff: false, isTrusted: () => false };
	}
	if (lower === 'private' || lower === 'cluster') {
		return { label: 'private', allowXff: true, isTrusted: (ip) => matchesAny(ip, PRIVATE_CIDRS) };
	}
	const cloudflare = lower.startsWith('cf:');
	const cidrs: Cidr[] = [];
	for (const part of (cloudflare ? trimmed.slice(3) : trimmed).split(',')) {
		const token = part.trim();
		if (!token && !cloudflare) continue;
		const t = token.toLowerCase();
		if (!cloudflare && t === 'loopback') {
			cidrs.push(...LOOPBACK_CIDRS);
			continue;
		}
		if (!cloudflare && (t === 'private' || t === 'cluster')) {
			cidrs.push(...PRIVATE_CIDRS);
			continue;
		}
		const cidr = parseCidr(token);
		if (!cidr) throw new Error(`Invalid TRUST_PROXY entry: "${token}"`);
		cidrs.push(cidr);
	}
	return {
		label: trimmed,
		allowXff: !cloudflare,
		requireVisitorIp: cloudflare,
		isTrusted: (ip) => matchesAny(ip, cidrs)
	};
}

export const DEFAULT_TRUST_PROXY: TrustProxy = parseTrustProxy(undefined);

function firstHeader(v: string | string[] | undefined): string {
	return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
}

/**
 * Visitor IP for per-IP limits and guest bans.
 * Forwarded headers (`CF-Connecting-IP`, then rightmost untrusted `X-Forwarded-For`
 * hop) are only read when the socket peer is trusted by `trustProxy`.
 * Never returns a loopback or trusted proxy address, so a guest ban cannot lock
 * out everyone behind a tunnel or reverse proxy.
 */
export function clientIp(
	req: { headers?: IncomingMessage['headers']; socket?: { remoteAddress?: string } } | undefined,
	trustProxy: TrustProxy = DEFAULT_TRUST_PROXY
): string | null {
	if (!req) return null;
	const remote = normalizeIp(req.socket?.remoteAddress);
	if (!remote) return null;
	if (!trustProxy.isTrusted(remote)) {
		return isLoopback(remote) ? null : remote;
	}
	const cf = normalizeIp(firstHeader(req.headers?.['cf-connecting-ip']));
	if (cf && !isLoopback(cf) && !trustProxy.isTrusted(cf)) return cf;

	if (trustProxy.allowXff) {
		const rawXff = req.headers?.['x-forwarded-for'];
		const joined = Array.isArray(rawXff) ? rawXff.join(',') : (rawXff ?? '');
		if (joined.trim()) {
			const hops = joined.split(',').map((s) => s.trim()).filter(Boolean);
			// Walk right-to-left: the proxy appends the real peer at the right,
			// whereas the client can spoof anything to the left.
			for (let i = hops.length - 1; i >= 0; i--) {
				const hop = normalizeIp(hops[i]);
				if (!hop) return null;
				if (isLoopback(hop) || trustProxy.isTrusted(hop)) continue;
				return hop;
			}
		}
	}
	return null;
}

/**
 * Parse `ALLOWED_ORIGINS` (comma-separated origins, e.g. `https://surf.example.com`,
 * plus optional `same-origin`). Empty/unset returns null (any origin allowed).
 */
export function parseAllowedOrigins(raw: string | undefined): AllowedOrigins | null {
	if (!raw || !raw.trim()) return null;
	const origins = new Set<string>();
	let sameOrigin = false;
	for (const part of raw.split(',')) {
		const token = part.trim();
		if (!token) continue;
		if (token.toLowerCase() === 'same-origin') {
			sameOrigin = true;
			continue;
		}
		let u: URL;
		try {
			u = new URL(token);
		} catch {
			throw new Error(`Invalid ALLOWED_ORIGINS entry: "${token}"`);
		}
		if (u.protocol !== 'http:' && u.protocol !== 'https:') {
			throw new Error(`ALLOWED_ORIGINS entry must be http or https: "${token}"`);
		}
		origins.add(u.origin.toLowerCase());
	}
	if (origins.size === 0 && !sameOrigin) return null;
	return { origins, sameOrigin };
}

/** True when the upgrade request's `Origin` header is accepted by `allowed`. */
export function isOriginAllowed(
	req: Pick<IncomingMessage, 'headers'> & Partial<Pick<IncomingMessage, 'socket'>>,
	allowed: AllowedOrigins | null,
	publicOrigin?: string
): boolean {
	if (!allowed) return true;
	const raw = firstHeader(req.headers.origin);
	if (!raw) return false;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
	if (allowed.origins.has(u.origin.toLowerCase())) return true;
	if (allowed.sameOrigin) {
		if (publicOrigin !== undefined) return u.origin === publicOrigin;
		const host = firstHeader(req.headers.host);
		const protocol = req.socket instanceof TLSSocket && req.socket.encrypted ? 'https' : 'http';
		try {
			return Boolean(host) && u.origin === new URL(`${protocol}://${host}`).origin;
		} catch {
			return false;
		}
	}
	return false;
}
