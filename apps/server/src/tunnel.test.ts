import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCommand } from './commands.ts';
import {
	clearPublishedUrl,
	findActiveFixedServer,
	isQuickTunnelUrl,
	parseTunnelUrl,
	publishUrl,
	readHostEnv
} from './tunnel.ts';

describe('parseTunnelUrl', () => {
	it('finds the quick tunnel URL in cloudflared output', () => {
		const out = [
			'2026-11-21T10:00:00Z INF Thank you for trying Cloudflare Tunnel.',
			'2026-11-21T10:00:01Z INF +--------------------------------------------------------------------------------------------+',
			'2026-11-21T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
			'2026-11-21T10:00:01Z INF |  https://brave-otter-example-words.trycloudflare.com                                       |',
			'2026-11-21T10:00:01Z INF +--------------------------------------------------------------------------------------------+'
		].join('\n');
		assert.equal(parseTunnelUrl(out), 'https://brave-otter-example-words.trycloudflare.com');
	});

	it('ignores other output', () => {
		assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
		assert.equal(parseTunnelUrl('ERR failed to request https://api.trycloudflare.com/tunnel'), null);
		assert.equal(parseTunnelUrl('see https://example.com'), null);
		assert.equal(parseTunnelUrl('https://evil.trycloudflare.com.example.org'), 'https://evil.trycloudflare.com');
	});
});

describe('readHostEnv', () => {
	const secret = 'x'.repeat(40);
	it('reports missing vars', () => {
		assert.throws(() => readHostEnv({}), /Missing HOST_SECRET and DISCOVERY_URL/);
		assert.throws(() => readHostEnv({ HOST_SECRET: secret }), /Missing DISCOVERY_URL/);
		assert.throws(() => readHostEnv({ HOST_SECRET: 'short', DISCOVERY_URL: 'https://a.b' }), /32 characters/);
		assert.throws(() => readHostEnv({ HOST_SECRET: secret, DISCOVERY_URL: 'ftp://a.b' }), /valid https/);
	});
	it('parses valid env', () => {
		assert.deepEqual(readHostEnv({ HOST_SECRET: secret, DISCOVERY_URL: 'https://app.vercel.app/', PORT: '' }), {
			hostSecret: secret,
			discoveryUrl: 'https://app.vercel.app',
			port: 27015
		});
	});
});

describe('publishUrl', () => {
	it('posts {url} with a bearer token', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fake = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response('{}', { status: 200 });
		}) as unknown as typeof fetch;
		await publishUrl({ hostSecret: 's3cret', discoveryUrl: 'https://d.example' }, 'https://a.trycloudflare.com', fake);
		await publishUrl({ hostSecret: 's3cret', discoveryUrl: 'https://d.example' }, null, fake);
		assert.equal(calls[0].url, 'https://d.example/api/server');
		assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer s3cret');
		assert.equal(calls[0].init.body, JSON.stringify({ url: 'https://a.trycloudflare.com' }));
		assert.equal(calls[1].init.body, '{"url":null}');
	});
	it('throws on HTTP errors', async () => {
		const fake = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
		await assert.rejects(publishUrl({ hostSecret: 's', discoveryUrl: 'https://d' }, null, fake), /401/);
	});
});

describe('fixed self-hosted server protection', () => {
	it('distinguishes quick tunnels from fixed server URLs', () => {
		assert.equal(isQuickTunnelUrl('https://brave-otter.trycloudflare.com'), true);
		assert.equal(isQuickTunnelUrl('https://surf.example.com'), false);
	});

	it('detects a healthy fixed server via FIXED_SERVER_URL or discovery', async () => {
		const fake = (async (url: string) => {
			if (url === 'https://fixed.example/health') return new Response(JSON.stringify({ ok: true }), { status: 200 });
			if (url === 'https://d.example/api/server') return new Response(JSON.stringify({ url: 'https://disc.example' }), { status: 200 });
			if (url === 'https://disc.example/health') return new Response(JSON.stringify({ ok: true }), { status: 200 });
			return new Response('nope', { status: 404 });
		}) as unknown as typeof fetch;
		assert.equal(
			await findActiveFixedServer({ discoveryUrl: 'https://d.example', fixedServerUrl: 'https://fixed.example' }, fake),
			'https://fixed.example'
		);
		assert.equal(await findActiveFixedServer({ discoveryUrl: 'https://d.example' }, fake), 'https://disc.example');

		// Quick tunnels in discovery do not block local hosting.
		const tunnelOnly = (async (url: string) => {
			if (url === 'https://d.example/api/server') {
				return new Response(JSON.stringify({ url: 'https://old-host.trycloudflare.com' }), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as unknown as typeof fetch;
		assert.equal(await findActiveFixedServer({ discoveryUrl: 'https://d.example' }, tunnelOnly), null);
	});

	it('does not report success when a conditional clear loses a race', async () => {
		const own = 'https://my-tunnel.trycloudflare.com';
		const fake: typeof fetch = async (_url, init) =>
			Response.json(init?.method === 'POST' ? { ok: true, cleared: false, url: 'https://surf.example.com' } : { url: own });
		assert.equal(await clearPublishedUrl({ hostSecret: 'secret', discoveryUrl: 'https://d.example' }, own, fake), false);
	});

	it('clearPublishedUrl refuses to clear when discovery points to another server', async () => {
		const posts: Array<{ url: string; body: string }> = [];
		const fixedActive = (async (url: string, init?: RequestInit) => {
			if (!init?.method || init.method === 'GET') {
				return new Response(JSON.stringify({ url: 'https://surf.example.com' }), { status: 200 });
			}
			posts.push({ url, body: String(init.body) });
			return new Response('{}', { status: 200 });
		}) as unknown as typeof fetch;

		const clearedOther = await clearPublishedUrl(
			{ hostSecret: 's3cret', discoveryUrl: 'https://d.example' },
			'https://my-tunnel.trycloudflare.com',
			fixedActive
		);
		assert.equal(clearedOther, false);
		assert.equal(posts.length, 0);

		const ownActive = (async (url: string, init?: RequestInit) => {
			if (!init?.method || init.method === 'GET') {
				return new Response(JSON.stringify({ url: 'https://my-tunnel.trycloudflare.com' }), { status: 200 });
			}
			posts.push({ url, body: String(init.body) });
			return new Response('{}', { status: 200 });
		}) as unknown as typeof fetch;

		const clearedOwn = await clearPublishedUrl(
			{ hostSecret: 's3cret', discoveryUrl: 'https://d.example' },
			'https://my-tunnel.trycloudflare.com',
			ownActive
		);
		assert.equal(clearedOwn, true);
		assert.equal(posts.length, 1);
		assert.deepEqual(JSON.parse(posts[0].body), {
			url: null,
			expectedUrl: 'https://my-tunnel.trycloudflare.com'
		});
	});
});

describe('parseCommand', () => {
	it('parses commands', () => {
		assert.equal(parseCommand('hello'), null);
		assert.deepEqual(parseCommand('!RTV'), { cmd: 'rtv' });
		assert.deepEqual(parseCommand('!map  ember '), { cmd: 'map', name: 'ember' });
		assert.deepEqual(parseCommand('!join'), { cmd: 'map', name: '' });
		assert.deepEqual(parseCommand('!spec  bob smith '), { cmd: 'spec', name: 'bob smith' });
		assert.deepEqual(parseCommand('!spec'), { cmd: 'spec', name: '' });
		assert.deepEqual(parseCommand('!name New Name'), { cmd: 'name', name: 'New Name' });
		assert.deepEqual(parseCommand('!r'), { cmd: 'client' });
		assert.deepEqual(parseCommand('!back'), { cmd: 'client' });
		assert.deepEqual(parseCommand('!foo'), { cmd: 'unknown', name: 'foo' });
	});
});
