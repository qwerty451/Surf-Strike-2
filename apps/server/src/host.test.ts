import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TestClient } from './test-helpers.ts';

it('pnpm host drains health and upgrades before clearing discovery', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), 'surf-host-'));
	const bin = join(dir, 'cloudflared');
	const url = 'https://test-host.trycloudflare.com';
	writeFileSync(bin, `#!/bin/sh\necho '${url}'\nexec sleep 60\n`, { mode: 0o700 });

	const steps = new EventEmitter();
	const published = once(steps, 'published');
	const clearing = once(steps, 'clearing');
	const allowClear = once(steps, 'allowClear');
	let current: string | null = null;
	let clearExpectedUrl: string | undefined;
	const discovery = createServer(async (req, res) => {
		res.setHeader('content-type', 'application/json');
		if (req.method === 'POST') {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString()) as { url: string | null; expectedUrl?: string };
			if (body.url === null) {
				clearExpectedUrl = body.expectedUrl;
				steps.emit('clearing');
				await allowClear;
			}
			current = body.url;
			res.end(JSON.stringify({ ok: true }));
			if (current) steps.emit('published');
		} else {
			res.end(JSON.stringify({ url: current }));
		}
	});
	discovery.listen(0, '127.0.0.1');
	await once(discovery, 'listening');
	const address = discovery.address();
	assert.ok(address && typeof address !== 'string');

	const reserved = createServer().listen(0, '127.0.0.1');
	await once(reserved, 'listening');
	const target = reserved.address();
	assert.ok(target && typeof target !== 'string');
	await new Promise<void>((resolve) => reserved.close(() => resolve()));

	const host = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('host.ts', import.meta.url))], {
		cwd: fileURLToPath(new URL('..', import.meta.url)),
		detached: true,
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(target.port),
			DB_PATH: ':memory:',
			WEB_HANDLER: '',
			ALLOWED_ORIGINS: '',
			TRUST_PROXY: 'loopback',
			FIXED_SERVER_URL: ' ',
			DISCOVERY_URL: `http://127.0.0.1:${address.port}`,
			HOST_SECRET: 'x'.repeat(32),
			CLOUDFLARED: bin
		},
		stdio: ['ignore', 'ignore', 'pipe']
	});
	let stderr = '';
	host.stderr.on('data', (chunk) => { stderr += String(chunk); });
	const exited = once(host, 'exit');
	const abort = AbortSignal.timeout(8_000);
	const timedOut = once(abort, 'abort').then(() => { throw new Error(`host timed out: ${stderr}`); });
	const whileRunning = (promise: Promise<unknown>) => Promise.race([
		promise,
		exited.then(([code]) => { throw new Error(`host exited early (${code}): ${stderr}`); }),
		timedOut
	]);
	try {
		await whileRunning(published);
		host.kill('SIGTERM');
		await whileRunning(clearing);
		assert.equal(clearExpectedUrl, url);
		const health = await fetch(`http://127.0.0.1:${target.port}/health`, { signal: abort });
		assert.equal(health.status, 503);
		assert.equal((await health.json()).ok, false);
		await assert.rejects(new TestClient(target.port).open(), /Unexpected server response: 503/);
		steps.emit('allowClear');
		assert.deepEqual(await Promise.race([exited, timedOut]), [0, null], stderr);
		assert.equal(current, null);
	} finally {
		steps.emit('allowClear');
		if (host.exitCode === null && host.signalCode === null && host.pid) {
			const force = setTimeout(() => {
				if (host.exitCode === null && host.signalCode === null) {
					try { process.kill(-host.pid!, 'SIGKILL'); } catch { /* already exited */ }
				}
			}, 1_000);
			try { await exited; } finally { clearTimeout(force); }
		}
		discovery.closeAllConnections();
		await new Promise<void>((resolve) => discovery.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});
