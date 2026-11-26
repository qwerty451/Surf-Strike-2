import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './+server.js';

const URL_ = 'https://some-tunnel.trycloudflare.com';

// Outside Vercel the runtime cache is in memory.
async function post(body: unknown, secret = 'test-secret') {
	const request = new Request('http://localhost/api/server', { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
	return POST({ request } as Parameters<typeof POST>[0]);
}

async function get() {
	const res = await GET({} as Parameters<typeof GET>[0]);
	return (await res.json()) as { url: string | null; lastSeen?: number };
}

describe('/api/server', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date'] });
		vi.stubEnv('HOST_SECRET', 'test-secret');
		vi.stubEnv('FIXED_SERVER_URL', undefined);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('hands out the published URL until it is cleared', async () => {
		expect((await post({ url: URL_ })).status).toBe(200);
		expect(await get()).toEqual({ url: URL_, lastSeen: Date.now() });
		expect((await post({ url: null })).status).toBe(200);
		expect(await get()).toEqual({ url: null });
	});

	it('keeps the start time over heartbeats and forgets a silent host', async () => {
		const first = (await (await post({ url: URL_ })).json()) as { startedAt: number };
		vi.advanceTimersByTime(60_000);
		const second = (await (await post({ url: URL_ })).json()) as { startedAt: number; lastSeen: number };
		expect(second.startedAt).toBe(first.startedAt);
		expect(second.lastSeen).toBe(first.startedAt + 60_000);
		vi.advanceTimersByTime(3 * 60_000 + 1);
		expect(await get()).toEqual({ url: null });
	});

	it('refuses a wrong secret and bad URLs', async () => {
		await post({ url: null });
		expect((await post({ url: URL_ }, 'wrong')).status).toBe(401);
		expect((await post({ url: 'http://example.com' })).status).toBe(400);
		expect((await post({})).status).toBe(400);
		expect(await get()).toEqual({ url: null });
	});

	it('keeps the configured URL authoritative over publishes, clears and stale cache entries', async () => {
		expect((await post({ url: URL_ })).status).toBe(200);
		expect((await get()).url).toBe(URL_);

		const fixed = 'https://surf.example.com';
		vi.stubEnv('FIXED_SERVER_URL', fixed);
		expect((await post({ url: 'https://late-tunnel.trycloudflare.com' })).status).toBe(409);
		const clear = await post({ url: null, expectedUrl: URL_ });
		expect(await clear.json()).toEqual({ ok: true, cleared: false, url: fixed });
		expect(await get()).toEqual({ url: fixed });

		vi.stubEnv('FIXED_SERVER_URL', undefined);
		expect((await get()).url).toBe(URL_);
	});

	it('conditional clear with expectedUrl refuses to wipe a different server URL', async () => {
		const fixed = 'https://surf.example.com';
		expect((await post({ url: fixed })).status).toBe(200);
		const mismatch = await post({ url: null, expectedUrl: URL_ });
		expect(mismatch.status).toBe(200);
		expect(await mismatch.json()).toEqual({ ok: true, cleared: false, url: fixed });
		expect((await get()).url).toBe(fixed);

		const match = await post({ url: null, expectedUrl: fixed });
		expect(match.status).toBe(200);
		expect((await match.json()).cleared).toBe(true);
		expect(await get()).toEqual({ url: null });
	});
});
