/** Game server entry point (no tunnel): `pnpm --filter server start` / `dev` / Docker. */
import { loadDotEnv, startServer } from './server.ts';

const SHUTDOWN_HARD_TIMEOUT_MS = 4_500;

loadDotEnv();

try {
	const server = await startServer();
	const host = server.host === '::' || server.host === '0.0.0.0' ? '0.0.0.0' : server.host;
	console.log(`game server on http://${host}:${server.port} (ws: /ws), map ${server.lobby.currentMap.id}`);
	let stopping = false;
	const stop = (signal: string) => {
		if (stopping) return;
		stopping = true;
		console.log(`received ${signal}, shutting down`);
		const force = setTimeout(() => {
			console.error('shutdown timed out, forcing exit');
			process.exit(1);
		}, SHUTDOWN_HARD_TIMEOUT_MS);
		force.unref();
		void server.close().then(
			() => {
				clearTimeout(force);
				process.exit(0);
			},
			(err) => {
				console.error(`shutdown error: ${(err as Error).message}`);
				process.exit(1);
			}
		);
	};
	process.on('SIGINT', () => stop('SIGINT'));
	process.on('SIGTERM', () => stop('SIGTERM'));
} catch (err) {
	console.error(`failed to start: ${(err as Error).message}`);
	process.exit(1);
}
