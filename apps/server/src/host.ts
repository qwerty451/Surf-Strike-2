/**
 * `pnpm host` (docs/architecture.md#start-up-flow): game server + cloudflared
 * quick tunnel + discovery publish/heartbeat.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { loadDotEnv, startServer } from './server.ts';
import type { HostEnv } from './tunnel.ts';
import {
	clearPublishedUrl,
	cloudflaredBinary,
	fetchPublishedUrl,
	findActiveFixedServer,
	isQuickTunnelUrl,
	parseTunnelUrl,
	publishUrl,
	readHostEnv
} from './tunnel.ts';

const HEARTBEAT_MS = 60_000;
const TUNNEL_TIMEOUT_MS = 60_000;

loadDotEnv();

let env: HostEnv;
try {
	env = readHostEnv();
} catch (err) {
	console.error(`host: ${(err as Error).message}`);
	process.exit(1);
}

// Refuse to overwrite a live fixed self-hosted server.
const activeFixed = await findActiveFixedServer(env);
if (activeFixed) {
	console.error(`host: refusing to start: a fixed self-hosted server is live at ${activeFixed}`);
	process.exit(1);
}

let server: Awaited<ReturnType<typeof startServer>>;
try {
	server = await startServer({ port: env.port, publicHost: true });
} catch (err) {
	console.error(`host: failed to start the game server: ${(err as Error).message}`);
	process.exit(1);
}
console.log(`host: game server on http://localhost:${server.port} (map ${server.lobby.currentMap.id})`);

const bin = cloudflaredBinary();
console.log(`host: starting ${bin} tunnel --url http://localhost:${server.port}`);
const tunnel: ChildProcess = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${server.port}`], {
	stdio: ['ignore', 'pipe', 'pipe']
});

let publicUrl: string | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let publishing: Promise<boolean> | null = null;
let stopping = false;

async function publish(url: string): Promise<boolean> {
	try {
		const current = await fetchPublishedUrl(env);
		if (stopping) return false;
		if (current && current !== url && !isQuickTunnelUrl(current)) {
			console.error(`host: discovery now points to fixed server ${current}; not overwriting`);
			return false;
		}
		await publishUrl(env, url);
		return true;
	} catch (err) {
		console.error(`host: publish failed: ${(err as Error).message}`);
		return false;
	}
}

async function clearDiscovery(ownUrl: string): Promise<void> {
	try {
		const cleared = await clearPublishedUrl(env, ownUrl);
		if (cleared) console.log('host: discovery cleared');
		else console.log('host: discovery was not cleared');
	} catch (err) {
		console.error(`host: clear failed: ${(err as Error).message}`);
	}
}

async function shutdown(code = 0): Promise<void> {
	if (stopping) return;
	stopping = true;
	server.beginDrain();
	console.log('host: shutting down');
	clearTimeout(tunnelTimeout);
	if (heartbeat) clearInterval(heartbeat);
	await publishing;
	if (publicUrl) await clearDiscovery(publicUrl);
	try {
		await server.close();
	} finally {
		if (tunnel.exitCode === null) tunnel.kill('SIGTERM');
	}
	process.exit(code);
}

const tunnelTimeout = setTimeout(() => {
	if (!publicUrl) {
		console.error('host: cloudflared did not print a trycloudflare.com URL within 60 s');
		void shutdown(1);
	}
}, TUNNEL_TIMEOUT_MS);

function onOutput(chunk: Buffer): void {
	if (stopping || publicUrl) return;
	const url = parseTunnelUrl(chunk.toString('utf8'));
	if (!url) return;
	publicUrl = url;
	clearTimeout(tunnelTimeout);
	console.log(`host: tunnel up at ${url} (ws: ${url.replace(/^https/, 'wss')}/ws)`);
	publishing = publish(url);
	void publishing.then((ok) => {
		if (ok) console.log(`host: published to ${env.discoveryUrl}/api/server`);
	});
	heartbeat = setInterval(() => {
		publishing = publish(url);
	}, HEARTBEAT_MS);
}

tunnel.stdout?.on('data', onOutput);
tunnel.stderr?.on('data', onOutput);
tunnel.on('error', (err) => {
	console.error(`host: cannot run cloudflared (${bin}): ${err.message}. Set CLOUDFLARED to its path.`);
	void shutdown(1);
});
tunnel.on('exit', (code, signal) => {
	if (stopping) return;
	console.error(`host: cloudflared exited (${signal ?? code})`);
	void shutdown(1);
});

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
