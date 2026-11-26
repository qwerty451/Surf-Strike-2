import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { CLOSE_IP_LIMIT, CLOSE_PROTOCOL_MISMATCH, PROTOCOL_VERSION, SERVER_ID_PROTOCOL } from '@surf/shared';
import { clientIp, isOriginAllowed, parseAllowedOrigins, parseTrustProxy } from './proxy.ts';
import { startServer } from './server.ts';
import { netState, sleep, TestClient, testMap } from './test-helpers.ts';

const MAPS = [testMap('surf_a', 'Alpha')];
const LOCAL_SERVER = { port: 0, host: '127.0.0.1', dbPath: ':memory:', maps: MAPS, log: () => {} };

// A peer that reads the upgrade but sends neither hello nor a close acknowledgement.
async function silentSocket(port: number, headers = '') {
	const socket = createConnection({ host: '127.0.0.1', port });
	try {
		socket.write(
			`GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
			'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' + headers + '\r\n'
		);
		const [data] = await once(socket, 'data', { signal: AbortSignal.timeout(2_000) });
		assert.match(String(data), /^HTTP\/1.1 101 /);
		return socket;
	} catch (err) {
		socket.destroy();
		throw err;
	}
}

function fakeReq(remoteAddress: string, headers: Record<string, string | string[]> = {}) {
	return { socket: { remoteAddress }, headers };
}

it('advertises the same server identity before hello and across database restarts', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'surf-server-id-'));
	async function identity(dbPath: string): Promise<string> {
		const server = await startServer({ ...LOCAL_SERVER, dbPath });
		try {
			const health = await fetch(`http://127.0.0.1:${server.port}/health`);
			const { serverId } = await health.json() as { serverId: string };
			assert.match(serverId, /^[0-9a-f-]{36}$/);
			const client = new TestClient(server.port, undefined, ['surf', SERVER_ID_PROTOCOL]);
			await client.open();
			assert.equal(client.ws.protocol, SERVER_ID_PROTOCOL);
			const greeting = await client.until(() => client.messages[0]);
			assert.deepEqual(greeting, { type: 'serverIdentity', serverId });
			const welcome = await client.hello('Identity');
			assert.equal(welcome.serverId, serverId);
			return serverId;
		} finally {
			await server.close();
		}
	}
	try {
		const firstPath = join(dir, 'first.db');
		const first = await identity(firstPath);
		assert.equal(await identity(firstPath), first);
		assert.notEqual(await identity(join(dir, 'second.db')), first);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('TRUST_PROXY and clientIp', () => {
	it('default (loopback) trusts CF-Connecting-IP and X-Forwarded-For only from loopback', () => {
		const tp = parseTrustProxy(undefined);
		assert.equal(clientIp(fakeReq('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }), tp), '203.0.113.7');
		assert.equal(clientIp(fakeReq('::1', { 'x-forwarded-for': '198.51.100.2' }), tp), '198.51.100.2');
		assert.equal(clientIp(fakeReq('10.42.0.9', { 'cf-connecting-ip': '203.0.113.7' }), tp), '10.42.0.9');
	});

	it('private trusts pod hops, picks rightmost untrusted XFF, never returns pod IP', () => {
		const tp = parseTrustProxy('private');
		assert.equal(clientIp(fakeReq('10.42.0.9', { 'cf-connecting-ip': '203.0.113.7' }), tp), '203.0.113.7');
		// Spoofed left entry ignored; trusted pod hop skipped; real visitor returned.
		assert.equal(
			clientIp(fakeReq('10.42.0.9', { 'x-forwarded-for': '1.2.3.4, 198.51.100.42, 10.42.0.2' }), tp),
			'198.51.100.42'
		);
		// No headers from trusted pod -> null so guest ban never bans the tunnel pod.
		assert.equal(clientIp(fakeReq('10.42.0.9'), tp), null);
		// Direct public peer -> headers ignored.
		assert.equal(clientIp(fakeReq('198.51.100.5', { 'cf-connecting-ip': '1.2.3.4' }), tp), '198.51.100.5');
	});

	it('cf mode trusts only CF-Connecting-IP from explicitly configured peers', () => {
		const tp = parseTrustProxy('cf:10.52.0.0/16');
		assert.equal(clientIp(fakeReq('::ffff:10.52.0.9', { 'cf-connecting-ip': '203.0.113.7' }), tp), '203.0.113.7');
		assert.equal(clientIp(fakeReq('10.42.0.9', { 'cf-connecting-ip': '203.0.113.7' }), tp), '10.42.0.9');
		assert.equal(clientIp(fakeReq('10.52.0.9', { 'x-forwarded-for': '203.0.113.7' }), tp), null);
		assert.throws(() => parseTrustProxy('cf:10.52.0.0/'), /Invalid TRUST_PROXY/);
		assert.throws(() => parseTrustProxy('cf:private'), /Invalid TRUST_PROXY/);
		assert.throws(() => parseTrustProxy('cf'), /TRUST_PROXY/);
	});

	it('rejects missing or invalid visitor headers from trusted Cloudflare peers before upgrade', async () => {
		const server = await startServer({ ...LOCAL_SERVER, trustProxy: 'cf:127.0.0.1' });
		try {
			const badHeaders: Array<Record<string, string>> = [
				{ 'x-forwarded-for': '198.51.100.1' },
				{ 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' }
			];
			for (const headers of badHeaders) {
				await assert.rejects(new TestClient(server.port, headers).open(), /Unexpected server response: 403/);
			}
			const visitor = new TestClient(server.port, { 'cf-connecting-ip': '198.51.100.1' });
			await visitor.hello('Visitor');
			visitor.close();
		} finally {
			await server.close();
		}
	});

	it('none ignores all forwarded headers and never returns loopback', () => {
		const tp = parseTrustProxy('none');
		assert.equal(clientIp(fakeReq('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }), tp), null);
		assert.equal(clientIp(fakeReq('198.51.100.5', { 'x-forwarded-for': '1.2.3.4' }), tp), '198.51.100.5');
	});

	it('explicit IPv4 and IPv6 CIDRs match accurately and reject invalid entries', () => {
		const tp = parseTrustProxy('10.42.0.0/16, fd00:1234::/32');
		assert.equal(clientIp(fakeReq('10.42.9.8', { 'x-forwarded-for': '203.0.113.10' }), tp), '203.0.113.10');
		assert.equal(clientIp(fakeReq('10.43.0.1', { 'x-forwarded-for': '203.0.113.10' }), tp), '10.43.0.1');
		assert.equal(clientIp(fakeReq('fd00:1234::5', { 'cf-connecting-ip': '2001:db8::9' }), tp), '2001:db8::9');
		assert.throws(() => parseTrustProxy('not-a-cidr'), /Invalid TRUST_PROXY/);
	});
});

describe('ALLOWED_ORIGINS', () => {
	it('uses ORIGIN for same-origin upgrades behind TLS termination', async (t) => {
		const original = process.env.ORIGIN;
		process.env.ORIGIN = 'https://public.example';
		t.after(() => {
			if (original === undefined) delete process.env.ORIGIN;
			else process.env.ORIGIN = original;
		});
		const server = await startServer({ ...LOCAL_SERVER, allowedOrigins: 'same-origin' });
		try {
			const client = new TestClient(server.port, { origin: 'https://public.example' });
			assert.equal((await client.hello('Visitor')).map, 'surf_a');
			await assert.rejects(
				new TestClient(server.port, { origin: `http://127.0.0.1:${server.port}` }).open(),
				/Unexpected server response: 403/
			);
			await assert.rejects(
				new TestClient(server.port, {
					origin: 'https://wrong.example', host: 'wrong.example', 'x-forwarded-proto': 'https'
				}).open(),
				/Unexpected server response: 403/
			);
		} finally {
			await server.close();
		}
	});

	it('parses allow-list and checks origins including same-origin', () => {
		assert.equal(parseAllowedOrigins(undefined), null);
		assert.equal(isOriginAllowed({ headers: {} }, null), true);

		const allowed = parseAllowedOrigins('https://Play.Example.com/, same-origin');
		assert.equal(isOriginAllowed({ headers: { origin: 'https://play.example.com' } }, allowed), true);
		assert.equal(isOriginAllowed({ headers: { origin: 'https://evil.example.com' } }, allowed), false);
		assert.equal(isOriginAllowed({ headers: {} }, allowed), false);
		const host = 'self.example.com:8080';
		assert.equal(isOriginAllowed({ headers: { origin: `http://${host}`, host } }, allowed), true);
		assert.equal(isOriginAllowed({ headers: { origin: `https://${host}`, host, 'x-forwarded-proto': 'https' } }, allowed), false);
		assert.equal(isOriginAllowed({ headers: { origin: 'http://self.example.com:8081', host } }, allowed), false);
		assert.equal(isOriginAllowed({ headers: { origin: 'http://self.example.com', host: 'self.example.com:80' } }, allowed), true);
		assert.throws(() => parseAllowedOrigins('ftp://bad.example'), /http or https/);
	});

	it('rejects disallowed WebSocket upgrades with HTTP 403 and accepts allowed origins', async () => {
		const server = await startServer({
			port: 0,
			host: '127.0.0.1',
			dbPath: ':memory:',
			maps: MAPS,
			log: () => {},
			allowedOrigins: 'https://allowed.example,same-origin'
		});
		try {
			const rejectedStatus = await new Promise<number>((ok, fail) => {
				const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
					headers: { origin: 'https://evil.example' }
				});
				ws.once('unexpected-response', (_req, res) => ok(res.statusCode ?? 0));
				ws.once('open', () => {
					ws.close();
					fail(new Error('should have been rejected'));
				});
			});
			assert.equal(rejectedStatus, 403);

			const c = new TestClient(server.port, { origin: 'https://allowed.example' });
			const w = await c.hello('Good');
			assert.equal(w.map, 'surf_a');
			c.close();
			const local = new TestClient(server.port, { origin: `http://127.0.0.1:${server.port}` });
			assert.equal((await local.hello('Local')).map, 'surf_a');
			local.close();
		} finally {
			await server.close();
		}
	});
});

describe('pre-hello caps, hello timeout, metrics, web handler, and graceful shutdown', () => {
	for (const version of [1, 2]) it(`rejects v${version} before sending welcome or replacing a connected player`, async () => {
		const server = await startServer(LOCAL_SERVER);
		const live = new TestClient(server.port);
		const legacy = new TestClient(server.port);
		try {
			const id = crypto.randomUUID();
			await live.hello('Current', id);
			await legacy.open();
			legacy.send({ type: 'hello', version, playerId: id, name: 'Legacy' });
			await legacy.waitFor('chat', (m) => m.text.includes('Reload the page'));
			await legacy.until(() => legacy.closed);
			assert.equal(legacy.closeCode, version === 1 ? 4002 : CLOSE_PROTOCOL_MISMATCH);
			assert.equal(legacy.of('welcome').length, 0);
			assert.equal(live.closed, false);
			assert.equal(server.lobby.playerCount, 1);
		} finally {
			live.close();
			legacy.close();
			await server.close();
		}
	});

	it('rejects pending overflows with HTTP 429 or 503 and terminates silent peers', async () => {
		const server = await startServer({
			...LOCAL_SERVER,
			maxPending: 2,
			maxPendingPerIp: 1,
			helloTimeoutMs: 1_000
		});
		const first = await silentSocket(server.port, 'CF-Connecting-IP: 198.51.100.10\r\n');
		const firstClosed = once(first, 'close', { signal: AbortSignal.timeout(2_500) });
		try {
			assert.equal(server.lobby.pendingCount, 1);
			assert.equal(server.lobby.playerCount, 0);
			await assert.rejects(
				new TestClient(server.port, { 'cf-connecting-ip': '198.51.100.10' }).open(),
				/Unexpected server response: 429/
			);
			const second = new TestClient(server.port);
			await second.open();
			assert.equal(server.lobby.pendingCount, 2);
			await assert.rejects(
				new TestClient(server.port, { 'cf-connecting-ip': '198.51.100.11' }).open(),
				/Unexpected server response: 503/
			);
			second.send({ type: 'hello', version: PROTOCOL_VERSION, playerId: 'second-peer', name: 'Second' });
			await second.waitFor('welcome');
			assert.equal(server.lobby.playerCount, 1);
			await firstClosed;
			const replacement = new TestClient(server.port, { 'cf-connecting-ip': '198.51.100.10' });
			await replacement.hello('Replacement');
			assert.equal(server.lobby.pendingCount, 0);
		} finally {
			first.destroy();
			await server.close();
		}
	});

	it('sends full and closes with 4003 at the player cap while keeping pending caps', async () => {
		const server = await startServer({ ...LOCAL_SERVER, maxPlayers: 1, maxPending: 2, maxPendingPerIp: 1 });
		try {
			const player = new TestClient(server.port);
			await player.hello('Player', 'same-player');
			const extra = new TestClient(server.port);
			await extra.open();
			await assert.rejects(new TestClient(server.port).open(), /Unexpected server response: 429/);
			const otherIp = new TestClient(server.port, { 'cf-connecting-ip': '198.51.100.10' });
			await otherIp.open();
			await assert.rejects(
				new TestClient(server.port, { 'cf-connecting-ip': '198.51.100.11' }).open(),
				/Unexpected server response: 503/
			);
			extra.send({ type: 'hello', version: PROTOCOL_VERSION, playerId: 'extra-player', name: 'Extra' });
			await extra.waitFor('full');
			await extra.until(() => extra.closed);
			assert.equal(extra.closeCode, 4003);
			assert.equal(server.lobby.playerCount, 1);
			await otherIp.hello('Player', 'same-player');
			await player.until(() => player.closed);
			assert.equal(player.closeCode, 4002);
			assert.equal(server.lobby.playerCount, 1);
		} finally {
			await server.close();
		}
	});

	it('public defaults admit 12 players from one IP and cap pending peers separately', async () => {
		const server = await startServer({ ...LOCAL_SERVER, publicHost: true });
		const ip = { 'cf-connecting-ip': '198.51.100.10' };
		try {
			for (let i = 0; i < 12; i++) await new TestClient(server.port, ip).hello(`Player${i}`);
			assert.equal(server.lobby.playerCount, 12);
			const extra = new TestClient(server.port, ip);
			await extra.open();
			extra.send({ type: 'hello', version: PROTOCOL_VERSION, playerId: 'extra-peer', name: 'Extra' });
			await extra.until(() => extra.closed);
			assert.equal(extra.closeCode, CLOSE_IP_LIMIT);

			// Missing IPs under the legacy policy share a single pending bucket.
			const unknown = Array.from({ length: 4 }, () => new TestClient(server.port));
			await Promise.all(unknown.map((c) => c.open()));
			await assert.rejects(new TestClient(server.port).open(), /Unexpected server response: 429/);
		} finally {
			await server.close();
		}
	});

	it('reports HTTP 503 on health and upgrades while draining', async () => {
		const server = await startServer({ ...LOCAL_SERVER, closeGraceMs: 3_000 });
		const silent = await silentSocket(server.port);
		try {
			const closed = server.close();
			const health = await fetch(`http://127.0.0.1:${server.port}/health`);
			assert.equal(health.status, 503);
			assert.equal((await health.json()).ok, false);
			await assert.rejects(new TestClient(server.port).open(), /Unexpected server response: 503/);
			silent.destroy();
			await closed;
		} finally {
			silent.destroy();
			await server.close();
		}
	});

	it('serves Prometheus on loopback, keeps /metrics private, and closes sockets on shutdown', async () => {
		const server = await startServer({
			port: 0,
			metricsPort: 0,
			host: '127.0.0.1',
			dbPath: ':memory:',
			maps: MAPS,
			log: () => {},
			webHandler: (req, res) => {
				res.writeHead(200, { 'content-type': 'text/html' }).end(`<html>${req.url}</html>`);
			}
		});
		const c = new TestClient(server.port);
		await c.hello('Watcher');
		c.sendState(netState(1, 100));
		await sleep(80);

		const healthRes = await fetch(`http://127.0.0.1:${server.port}/health`);
		assert.equal(healthRes.status, 200);
		assert.equal((await healthRes.json()).players, 1);

		const webRes = await fetch(`http://127.0.0.1:${server.port}/`);
		assert.equal(webRes.status, 200);
		assert.equal(await webRes.text(), '<html>/</html>');

		const wsHttpRes = await fetch(`http://127.0.0.1:${server.port}/ws`);
		assert.equal(wsHttpRes.status, 426);

		assert.equal((await fetch(`http://127.0.0.1:${server.port}/metrics`)).status, 404);
		const metricsRes = await fetch(`http://127.0.0.1:${server.metricsPort}/metrics`);
		assert.equal(metricsRes.status, 200);
		assert.match(metricsRes.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/);
		const body = await metricsRes.text();
		for (const metric of [
			'surf_players 1',
			'surf_pending_connections 0',
			'surf_event_loop_delay_p50_ms ',
			'surf_event_loop_delay_p99_ms ',
			'surf_event_loop_delay_max_ms ',
			'surf_snapshot_tick_lateness_p50_ms ',
			'surf_snapshot_tick_lateness_p99_ms ',
			'surf_snapshot_tick_lateness_max_ms ',
			'surf_mode_tick_lateness_p50_ms ',
			'surf_mode_tick_lateness_p99_ms ',
			'surf_mode_tick_lateness_max_ms ',
			'surf_bytes_sent_per_second ',
			'surf_socket_buffered_bytes_max ',
			'process_resident_memory_bytes '
		]) {
			assert.ok(body.includes(metric), `missing metric line: ${metric}`);
		}

		// Graceful shutdown delivers close code 1001 quickly (well under 5 s).
		const t0 = performance.now();
		await server.close();
		const elapsedMs = performance.now() - t0;
		await c.until(() => c.closed);
		assert.equal(c.closeCode, 1001);
		assert.ok(elapsedMs < 5_000, `shutdown took ${elapsedMs} ms`);
	});
});
