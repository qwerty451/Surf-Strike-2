import { describe, expect, it, vi } from 'vitest';
import { SERVER_ID_PROTOCOL, buildCollisionWorld, encodeSnapshot, withTeleportSeq, type NetState, type ServerMessage, type SnapshotFrame } from '@surf/shared';
import { NetClient } from './client.js';
import { parseDiscovery, sameOriginWsUrl, serverOverride, toWsUrl } from './discovery.js';
import { emptySample, lerpAngle, MAX_EXTRAP_DISTANCE, MAX_EXTRAP_MS, SnapshotBuffer } from './interp.js';
import type { NetTransport, NetTransportHandlers } from './transport.js';
import { Connection } from './connection.js';
import { clearSession, loadSession, saveSession } from '../game/identity.js';
import { memoryStore } from '../game/storage.js';

describe('discovery URLs', () => {
	it('converts http(s) to ws(s) and appends /ws', () => {
		expect(toWsUrl('https://abc.trycloudflare.com')).toBe('wss://abc.trycloudflare.com/ws');
		expect(toWsUrl('http://localhost:27015')).toBe('ws://localhost:27015/ws');
		expect(toWsUrl('wss://x.example/ws')).toBe('wss://x.example/ws');
		expect(toWsUrl('ws://x.example/custom')).toBe('ws://x.example/custom');
		expect(toWsUrl('abc.trycloudflare.com')).toBe('wss://abc.trycloudflare.com/ws');
		expect(toWsUrl('localhost:27015')).toBe('ws://localhost:27015/ws');
		expect(toWsUrl('ftp://nope')).toBeNull();
		expect(toWsUrl('')).toBeNull();
	});
	it('reads ?server= and same-origin URLs', () => {
		expect(serverOverride('?server=https%3A%2F%2Fa.b')).toBe('wss://a.b/ws');
		expect(serverOverride('?x=1')).toBeNull();
		expect(sameOriginWsUrl({ origin: 'https://surf.example.com' })).toBe('wss://surf.example.com/ws');
		expect(sameOriginWsUrl({ origin: 'http://localhost:8080' })).toBe('ws://localhost:8080/ws');
		expect(sameOriginWsUrl(null)).toBeNull();
	});
	it('self-hosted Connection connects to sameOrigin without calling /api/server, while ?server= overrides it', () => {
		const fetchSpy = vi.fn();
		const opened: string[] = [];
		const origWs = globalThis.WebSocket;
		class FakeWs {
			binaryType = '';
			constructor(url: string) {
				opened.push(url);
			}
			close() {}
		}
		globalThis.WebSocket = FakeWs as unknown as typeof WebSocket;
		try {
			const noop = () => {};
			const c1 = new Connection(
				{ connecting: noop, open: noop, message: noop, snapshot: noop, closed: noop, idle: noop },
				{ override: null, sameOrigin: 'wss://self.example/ws', dev: false, fetch: fetchSpy as unknown as typeof fetch }
			);
			c1.start();
			c1.dispose();
			expect(opened).toEqual(['wss://self.example/ws']);
			expect(fetchSpy).not.toHaveBeenCalled();

			const c2 = new Connection(
				{ connecting: noop, open: noop, message: noop, snapshot: noop, closed: noop, idle: noop },
				{
					override: 'wss://other.example/ws',
					sameOrigin: 'wss://self.example/ws',
					dev: false,
					fetch: fetchSpy as unknown as typeof fetch
				}
			);
			c2.start();
			c2.dispose();
			expect(opened).toEqual(['wss://self.example/ws', 'wss://other.example/ws']);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.WebSocket = origWs;
		}
	});
	it('reuses a session only after seeing the same database identity on the socket', async () => {
		const store = memoryStore();
		const account = { token: 'tunnel-token', username: 'Player' };
		saveSession(store, 'discovery:/api/server', { ...account, token: 'legacy-token' });
		const noop = () => {};
		const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
		let socket!: FakeWs;
		class FakeWs {
			protocol = SERVER_ID_PROTOCOL;
			onopen?: () => void;
			onmessage?: (event: { data: string }) => void;
			constructor() { socket = this; }
			close() {}
		}
		vi.stubGlobal('WebSocket', FakeWs);

		async function connect(host: string, serverId: string | null, manual = false) {
			const opened = vi.fn();
			let scope: string | null = null;
			const connection = new Connection(
				{
					connecting: noop,
					open: (_client, identityScope) => {
						scope = identityScope;
						opened(scope === null ? null : loadSession(store, scope));
					},
					message: noop, snapshot: noop, closed: noop, idle: noop
				},
				{ override: manual ? `wss://${host}/ws` : null, dev: false, fetch: async () => Response.json({ url: `https://${host}` }) }
			);
			try {
				socket = undefined!;
				connection.start();
				await vi.waitFor(() => expect(socket).toBeDefined());
				if (serverId === null) socket.protocol = 'surf';
				socket.onopen?.();
				if (serverId !== null) {
					expect(opened).not.toHaveBeenCalled();
					socket.onmessage?.({ data: JSON.stringify({ type: 'serverIdentity', serverId }) });
				}
				expect(opened).toHaveBeenCalledExactlyOnceWith(scope === null ? null : loadSession(store, scope));
				return { scope, session: opened.mock.calls[0]?.[0] };
			} finally {
				connection.dispose();
			}
		}
		try {
			const first = await connect('first.trycloudflare.com', firstId);
			expect(first.session).toBeNull();
			expect(first.scope).not.toBeNull();
			saveSession(store, first.scope!, account);

			const rotated = await connect('second.trycloudflare.com', firstId);
			expect(rotated.session).toEqual(account);
			expect((await connect('third.trycloudflare.com', otherId)).session).toBeNull();
			expect((await connect('second.trycloudflare.com', otherId)).session).toBeNull();
			expect((await connect('second.trycloudflare.com', firstId, true)).session).toBeNull();
			expect((await connect('second.trycloudflare.com', null)).session).toBeNull();
			clearSession(store, rotated.scope!);
			expect((await connect('first.trycloudflare.com', firstId)).session).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('parses discovery responses', () => {
		const now = Date.parse('2026-11-21T12:00:00Z');
		expect(parseDiscovery({ url: null }, now)).toBeNull();
		expect(parseDiscovery(null, now)).toBeNull();
		expect(parseDiscovery({ url: 'https://a.trycloudflare.com' }, now)).toBe('wss://a.trycloudflare.com/ws');
		expect(parseDiscovery({ url: 'https://a.b', lastSeen: now - 60_000 }, now)).toBe('wss://a.b/ws');
		expect(parseDiscovery({ url: 'https://a.b', lastSeen: now - 4 * 60_000 }, now)).toBeNull();
		expect(parseDiscovery({ url: 'https://a.b', lastSeen: '2026-11-21T11:59:00Z' }, now)).toBe('wss://a.b/ws');
	});
});

function st(x: number, yaw = 0): NetState {
	return { tick: 0, x, y: 0, z: 0, vx: x, vy: 0, vz: 0, pitch: 0, yaw, flags: 0, status: 1, stage: 1, runTicks: x };
}

describe('snapshot interpolation', () => {
	it('lerps angles the short way', () => {
		expect(lerpAngle(170, -170, 0.5)).toBeCloseTo(180);
		expect(lerpAngle(-10, 10, 0.25)).toBeCloseTo(-5);
	});
	it('interpolates between samples by arrival time', () => {
		const b = new SnapshotBuffer();
		const out = emptySample();
		expect(b.sample(0, out)).toBe(false);
		b.push(st(0, 350), 1000);
		b.push(st(100, 10), 1031.25);
		b.push(st(200, 30), 1062.5);
		expect(b.sample(1015.625, out)).toBe(true);
		expect(out.x).toBeCloseTo(50);
		expect(out.yaw).toBeCloseTo(360);
		b.sample(1046.875, out);
		expect(out.x).toBeCloseTo(150);
		expect(out.yaw).toBeCloseTo(20);
	});
	it('clamps before buffer, extrapolates up to maxExtrapMs, and holds past the cap', () => {
		const b = new SnapshotBuffer();
		const out = emptySample();
		b.push(st(10), 100);
		b.push(st(20), 200);
		b.sample(50, out);
		expect(out.x).toBe(10);
		expect(b.lastUnderrun).toBe(false);
		// Within the cap: linearly extrapolates using vx = 20 u/s.
		b.sample(225, out);
		expect(out.x).toBeCloseTo(20 + 20 * 0.025, 5);
		expect(b.lastUnderrun).toBe(true);
		expect(b.lastExtrapMs).toBeCloseTo(25, 5);
		// Past the cap: holds at the capped pose and reports freeze (lastExtrapMs = 0).
		b.sample(500, out);
		expect(out.x).toBeCloseTo(20 + 20 * (MAX_EXTRAP_MS / 1000), 5);
		expect(b.lastUnderrun).toBe(true);
		expect(b.lastExtrapMs).toBe(0);
	});
	it('snaps across teleports by distance or teleport counter even below snapDistance', () => {
		const b = new SnapshotBuffer();
		const out = emptySample();
		b.push(st(0), 0);
		b.push(st(5000), 100);
		b.sample(10, out);
		expect(out.x).toBe(0);
		b.sample(100, out);
		expect(out.x).toBe(5000);

		// Short 400 u teleport (< 1024 snapDistance) without FLAG_TELEPORTED bit, caught via teleport counter.
		const b2 = new SnapshotBuffer();
		b2.push({ ...st(0), tick: 1, flags: withTeleportSeq(0, 0) }, 0);
		b2.push({ ...st(400), tick: 3, flags: withTeleportSeq(0, 4) }, 31.25);
		b2.sample(15, out);
		expect(out.x).toBe(0);
		b2.sample(31.25, out);
		expect(out.x).toBe(400);
	});
	it('clamps extrapolation to map geometry and holds the confirmed pose for a stalled sender', () => {
		const world = buildCollisionWorld({ brushes: [{ type: 'box', min: { x: 60, y: -128, z: -128 }, max: { x: 70, y: 128, z: 128 }, material: 'concrete' }] });
		const b = new SnapshotBuffer();
		const out = emptySample();
		b.push({ ...st(0), tick: 1, vx: 1200 }, 1000);
		b.push({ ...st(37.5), tick: 3, vx: 1200 }, 1031.25);
		b.sample(1106.25, out, world);
		expect(out.x).toBeCloseTo(43.96875);
		for (let t = 1062.5; t <= 1250; t += 31.25) b.push({ ...st(37.5), tick: 3, vx: 1200 }, t);
		b.sample(1250, out);
		expect(out.x).toBe(37.5);
		expect(b.sourceIdle).toBe(true);
		b.push({ ...st(39), tick: 19, vx: 1200 }, 1281.25);
		expect(b.sourceIdle).toBe(true);
		b.push({ ...st(40), tick: 21, vx: 1200 }, 1312.5);
		expect(b.sourceIdle).toBe(false);
	});
	it('slides along a contact plane, then holds at a reduced render timestamp', () => {
		const world = buildCollisionWorld({ brushes: [{ type: 'box', min: { x: 60, y: -512, z: -128 }, max: { x: 70, y: 512, z: 128 }, material: 'concrete' }] });
		const b = new SnapshotBuffer();
		const out = emptySample();
		b.push({ ...st(30), tick: 1, vx: 1000, vy: 500, sampleTimeMs: 1000 }, 1000);
		b.sample(1200, out, world);
		const held = b.lastRenderMs;
		expect(held).toBeCloseTo(1000 + 13.96875 + 24);
		expect(out.x).toBeCloseTo(43.96875);
		expect(out.y).toBeCloseTo((held - 1000) * 0.5);
		b.sample(1350, out, world);
		expect(b.lastRenderMs).toBeCloseTo(held);
	});

	it('eases a wrong stop prediction, then snaps across a teleport during the correction', () => {
		const b = new SnapshotBuffer();
		const out = emptySample();
		b.push({ ...st(0), tick: 1, vx: 1000, sampleTimeMs: 1000 }, 1000);
		b.sample(1000 + MAX_EXTRAP_DISTANCE, out, undefined, 1300);
		const extrapolated = out.x;
		expect(extrapolated).toBeCloseTo(MAX_EXTRAP_DISTANCE);
		b.push({ ...st(20), tick: 7, vx: 0, sampleTimeMs: 1100 }, 1100);
		b.sample(1116, out, undefined, 1316);
		expect(out.x).toBeCloseTo(20 + (extrapolated - 20 * MAX_EXTRAP_DISTANCE / 100) * 0.8);
		b.push({ ...st(400), tick: 8, vx: 0, flags: withTeleportSeq(0, 1), sampleTimeMs: 1130 }, 1130);
		b.sample(1132, out, undefined, 1332);
		expect(out.x).toBe(400);
	});

	it('finishes a prediction correction using frame time while the render timestamp holds', () => {
		const b = new SnapshotBuffer();
		const out = emptySample();
		b.push({ ...st(0), tick: 1, vx: 1000, sampleTimeMs: 1000 }, 1000);
		b.sample(1100, out, undefined, 1300);
		b.push({ ...st(20), tick: 7, vx: 0, sampleTimeMs: 1100 }, 1100);
		b.sample(1250, out, undefined, 1316);
		expect(out.x).toBeGreaterThan(20);
		expect(b.lastRenderMs).toBe(1125);
		b.sample(1280, out, undefined, 1380);
		expect(out.x).toBe(20);
		expect(b.lastRenderMs).toBe(1125);
	});

	it('keeps arrival times monotonic', () => {
		const b = new SnapshotBuffer();
		const out = emptySample();
		b.push(st(0), 100);
		b.push(st(10), 90);
		b.sample(100, out);
		expect(out.x).toBe(0);
		expect(b.size).toBe(2);
	});
	it('de-aliases 64->32 Hz tick spacing and drops duplicate ticks', () => {
		const b = new SnapshotBuffer();
		const out = emptySample();
		const speed = 640; // 10 u per 64 Hz tick (15.625 ms)
		const atTick = (tick: number): NetState => ({
			...st(tick * 10),
			tick,
			vx: speed
		});
		// Snapshots arrive at uniform 31.25 ms server intervals, but sender ticks arrive as 2, 1, 3, 0 (dup), 4.
		b.push(atTick(100), 1000, 5000);
		b.push(atTick(102), 1031.25, 5031.25);
		b.push(atTick(103), 1062.5, 5062.5);
		b.push(atTick(106), 1093.75, 5093.75);
		b.push(atTick(106), 1125.0, 5125.0); // duplicate tick: must be dropped while keeping lastArrival fresh
		b.push(atTick(110), 1156.25, 5156.25);

		expect(b.lastArrival).toBe(5156.25);
		// Sample across the 1-tick/3-tick/dup region: velocity should stay constant at 640 u/s (10 u per 15.625 ms).
		for (let t = 1005; t <= 1150; t += 10) {
			expect(b.sample(t, out)).toBe(true);
			const expectedX = 1000 + ((t - 1000) / 1000) * speed;
			expect(Math.abs(out.x - expectedX)).toBeLessThan(1.5);
		}
	});
	it('separates local arrival time from server timeline and detects idle sources', () => {
		const b = new SnapshotBuffer();
		b.push({ ...st(0), tick: 1 }, 1000, 9000);
		b.push({ ...st(10), tick: 2 }, 1031.25, 9031.25);
		expect(b.sourceIdle).toBe(false);
		for (let i = 0; i < 8; i++) {
			b.push({ ...st(10), tick: 2 }, 1062.5 + i * 31.25, 9062.5 + i * 31.25);
		}
		expect(b.sourceIdle).toBe(true);
		expect(b.lastArrival).toBeCloseTo(9062.5 + 7 * 31.25);
	});
});

describe('NetClient transport seam', () => {
	it('routes JSON messages, v2 binary snapshots, traffic accounting, and close codes via injected NetTransport', () => {
		let hooks!: NetTransportHandlers;
		const sentText: string[] = [];
		const sentBin: ArrayBuffer[] = [];
		let open = true;
		const fake: NetTransport = {
			get isOpen() {
				return open;
			},
			sendText: (s) => void sentText.push(s),
			sendBinary: (b) => void sentBin.push(b),
			close: () => {
				open = false;
			}
		};

		let opened = false;
		let closedCode = -1;
		const msgs: ServerMessage[] = [];
		const snaps: SnapshotFrame[] = [];
		let bytesIn = 0;
		let bytesOut = 0;

		const client = new NetClient(
			'wss://example.invalid/ws',
			{
				open: () => (opened = true),
				message: (m) => msgs.push(m),
				snapshot: (f) => snaps.push(f),
				traffic: (dir, bytes) => {
					if (dir === 'in') bytesIn += bytes;
					else bytesOut += bytes;
				},
				close: (_wasOpen, code) => (closedCode = code)
			},
			(_url, h) => {
				hooks = h;
				return fake;
			}
		);

		hooks.open();
		expect(opened).toBe(true);
		expect(client.isOpen).toBe(true);

		client.send({ type: 'ping', t: 10 });
		client.sendBinary(new ArrayBuffer(44));
		expect(sentText.length).toBe(1);
		expect(sentBin.length).toBe(1);
		expect(bytesOut).toBeGreaterThan(44);

		hooks.text(JSON.stringify({ type: 'pong', t: 10, serverTime: 500 }), 120);
		hooks.binary(encodeSnapshot([{ id: 2, ...st(40) }], 500, 7), 125);
		expect(msgs).toEqual([{ type: 'pong', t: 10, serverTime: 500 }]);
		expect(snaps.length).toBe(1);
		expect(snaps[0]!.seq).toBe(7);
		expect(snaps[0]!.serverTimeMs).toBe(500);
		expect(bytesIn).toBeGreaterThan(0);

		hooks.close(1000);
		expect(closedCode).toBe(1000);
		expect(client.isOpen).toBe(false);
	});
});
