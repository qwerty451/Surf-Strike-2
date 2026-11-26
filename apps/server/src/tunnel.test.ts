import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCommand } from './commands.ts';
import { parseTunnelUrl, publishUrl, readHostEnv } from './tunnel.ts';

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
