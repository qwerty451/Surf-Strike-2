import { setTimeout as sleep } from 'node:timers/promises';
import { FixedStep } from '../../apps/web/src/lib/game/loop.ts';
import { adapterFor } from './adapter.ts';
import { ObserverMetrics } from './metrics.ts';
import { BotPath } from './path.ts';
import { startRelay, type Impairment, type Relay } from './relay.ts';
import { Peer } from './session.ts';
import type { TraceEvent, ProbeTrace } from './trace.ts';
import { BIN_SNAPSHOT } from './wire-v1.ts';

const TICK_RATE = 64;
const TICK_MS = 1000 / TICK_RATE;
const WARMUP_MS = 2000;
const FLAG_TELEPORTED = 4;
const STATUS_RUNNING = 1;

export interface Config extends Impairment {
	url: URL;
	bots: number;
	seconds: number;
	fps: number[];
	senderFps: number;
}

async function health(address: URL, signal?: AbortSignal) {
	const url = new URL('/health', address);
	url.protocol = address.protocol === 'wss:' ? 'https:' : 'http:';
	const timeout = AbortSignal.timeout(5000);
	const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
	if (!response.ok) throw new Error(`/health returned HTTP ${response.status}`);
	const value = await response.json() as { ok: boolean; version: number; tickRate: number; map: string; mode: string; players: number };
	if (value.ok !== true || value.tickRate !== TICK_RATE || !Number.isInteger(value.version)) throw new Error('Unexpected /health response');
	return value;
}

function frameClock(start: number, fps: number) {
	const period = 1000 / fps;
	let frame = 1;
	let last = start;
	return {
		get next() { return start + frame * period; },
		step(now: number) {
			const dt = now - last;
			last = now;
			// Like rAF, skip missed display frames and run one callback.
			frame = Math.max(frame + 1, Math.floor((now - start) / period) + 1);
			return dt;
		}
	};
}

export async function runProbe(config: Config, signal: AbortSignal, recordTrace = false) {
	const startedAt = new Date().toISOString();
	const events: TraceEvent[] | undefined = recordTrace ? [] : undefined;
	const before = await health(config.url, signal);
	const adapter = await adapterFor(before.version);
	const failed = new AbortController();
	const stop = AbortSignal.any([signal, failed.signal]);
	const fail = (error: Error) => failed.abort(error);
	const peers: Peer[] = [];
	const left = new Set<number>();
	const paths = new Map<number, BotPath>();
	const mapChanges: { elapsedMs: number; map: string }[] = [];
	let observerPeer: Peer | undefined;
	let relay: Relay | null = null;
	let start = 0;
	let startMap = before.map;
	let startMode = before.mode;
	let received = 0;
	let snapshotBytes = 0;
	let startMapTimeLeft: number | null = null;
	let snapshotHz: number | null = null;
	let malformed = 0;
	let measuredStart = Infinity;
	let measuredEnd = Infinity;
	const cleanup = { botCloseHandshakes: 0, botLeaveEvents: 0, observerCloseHandshake: false, playersAfter: null as number | null };
	const renderers = config.fps.map((fps) => ({ fps, observer: adapter.observer(new Set()), metrics: undefined as ObserverMetrics | undefined }));
	let stopAt = 0;
	let sentStates = 0;
	let actualSeconds = 0;

	try {
		if (config.lossPct || config.jitterMs || config.burst) relay = await startRelay(config.url, config);
		for (let i = 0; i < config.bots; i++) {
			stop.throwIfAborted();
			const peer = new Peer(config.url, relay, `probe-${i + 1}`, before.version, { fail });
			peers.push(peer);
			const welcome = await peer.welcome;
			paths.set(welcome.selfId, new BotPath(i));
		}
		const ids = new Set(paths.keys());
		for (const renderer of renderers) renderer.observer = adapter.observer(ids);
		stop.throwIfAborted();
		let lastArrival = -Infinity;
		let nextClockPing = Infinity;
		observerPeer = new Peer(config.url, relay, 'probe-observer', before.version, {
			fail,
			snapshot(data, arrival) {
				if (new Uint8Array(data)[0] !== BIN_SNAPSHOT) return;
				const measuring = arrival >= measuredStart && arrival <= measuredEnd;
				let decoded = true;
				for (const { observer } of renderers) decoded = observer.snapshot(data, arrival) && decoded;
				if (!decoded) {
					malformed++;
					return;
				}
				if (events && arrival <= measuredEnd) events.push([arrival, 'snapshot', Buffer.from(data).toString('base64')]);
				if (measuring) {
					received++;
					snapshotBytes += data.byteLength;
					for (const { metrics } of renderers) {
						if (lastArrival >= measuredStart) metrics?.interArrival.add(arrival - lastArrival);
					}
				}
				lastArrival = arrival;
			},
			rtt(ms) {
				const now = performance.now();
				if (now >= measuredStart && now <= measuredEnd) {
					for (const { metrics } of renderers) metrics?.rtt.add(ms);
				}
			},
			message(message, arrival) {
				if (message.type === 'welcome' || message.type === 'pong') {
					if (events && arrival <= measuredEnd) {
						const timing = message.type === 'pong'
							? { type: message.type, t: message.t, serverTime: message.serverTime }
							: {
								type: message.type, selfId: message.selfId, map: message.map,
								serverTime: message.serverTime, snapshotHz: message.snapshotHz
							};
						events.push([arrival, 'timing', timing]);
					}
					for (const { observer } of renderers) observer.timingMessage?.(message, arrival);
					if (message.type === 'welcome' && before.version >= 2) {
						observerPeer?.clockPing(arrival);
						nextClockPing = arrival + 1000;
					}
				}
				if (message.type === 'leave' && ids.has(message.id)) left.add(message.id);
				if (message.type === 'mapChange') {
					if (events && arrival <= measuredEnd) events.push([arrival, 'clear', message.map]);
					if (Number.isFinite(measuredStart)) mapChanges.push({ elapsedMs: arrival - (measuredStart - WARMUP_MS), map: message.map });
					for (const { observer } of renderers) observer.clear();
				}
			}
		});
		const observerWelcome = await observerPeer.welcome;
		startMap = observerWelcome.map;
		startMode = observerWelcome.mode ?? before.mode;
		startMapTimeLeft = observerWelcome.mapTimeLeft ?? null;
		snapshotHz = observerWelcome.snapshotHz ?? null;
		start = performance.now();
		measuredStart = start + WARMUP_MS;
		stopAt = measuredEnd = measuredStart + config.seconds * 1000;

		const botFrames = peers.map((peer, i) => ({
			peer,
			path: [...paths.values()][i],
			clock: frameClock(start + (1000 / config.senderFps) * (i / peers.length), config.senderFps),
			step: new FixedStep(TICK_RATE, 8),
			tick: 0,
			teleportCount: 0,
			lastZ: null as number | null
		}));
		const renderFrames = renderers.map((renderer) => {
			renderer.metrics = new ObserverMetrics(paths, WARMUP_MS, WARMUP_MS + config.seconds * 1000);
			return { ...renderer, clock: frameClock(start, renderer.fps), metrics: renderer.metrics };
		});
		console.error(`Connected ${peers.length} bots and 1 observer on v${before.version}, ${observerWelcome.map}. Measuring ${config.seconds}s after warm-up.`);
		let nextPing = measuredStart;

		while (true) {
			stop.throwIfAborted();
			const now = performance.now();
			if (now >= stopAt) {
				actualSeconds = (now - measuredStart) / 1000;
				break;
			}
			let next = stopAt;
			for (const bot of botFrames) {
				if (now >= bot.clock.next) {
					const steps = bot.step.advance(bot.clock.step(now));
					let tickEnd = now - bot.step.accMs - (steps - 1) * TICK_MS;
					for (let i = 0; i < steps; i++, tickEnd += TICK_MS) {
						const motion = bot.path.at(tickEnd - start);
						const teleported = bot.lastZ !== null && motion.z !== bot.lastZ;
						if (teleported) bot.teleportCount++;
						bot.lastZ = motion.z;
						bot.peer.sendState(adapter.encode({
							...motion, tick: bot.tick++, flags: teleported ? FLAG_TELEPORTED : 0,
							pitch: 0, yaw: Math.atan2(motion.vy, motion.vx) * 180 / Math.PI,
							status: STATUS_RUNNING, stage: 0, runTicks: 0
						}, bot.teleportCount));
						if (now >= measuredStart) sentStates++;
					}
				}
				next = Math.min(next, bot.clock.next);
			}
			for (const { clock, metrics, observer, fps } of renderFrames) {
				if (now >= clock.next) {
					const dt = clock.step(now);
					events?.push([now, 'frame', fps, dt]);
					observer.beginFrame?.(now, dt);
					if (now >= measuredStart) metrics.frame(now - start, (id) => observer.render(id, now));
				}
				next = Math.min(next, clock.next);
			}
			if (now >= nextPing) {
				observerPeer.ping();
				nextPing += 1000 * (1 + Math.floor((now - nextPing) / 1000));
			}
			if (now >= nextClockPing) {
				observerPeer.clockPing(now);
				nextClockPing = now + 1000;
			}
			next = Math.min(next, nextPing, nextClockPing);
			await sleep(Math.max(1, Math.ceil(next - performance.now())), undefined, { signal: stop });
		}
	} catch (error) {
		throw stop.aborted ? stop.reason : error;
	} finally {
		measuredEnd = Math.min(measuredEnd, performance.now());
		const closed = await Promise.all(peers.map((peer) => peer.close()));
		cleanup.botCloseHandshakes = closed.filter(Boolean).length;
		if (observerPeer && paths.size) {
			const deadline = performance.now() + 1500;
			while (left.size < paths.size && performance.now() < deadline) await sleep(25);
		}
		cleanup.botLeaveEvents = left.size;
		if (observerPeer) cleanup.observerCloseHandshake = await observerPeer.close();
		await relay?.close();
		try {
			cleanup.playersAfter = (await health(config.url)).players;
		} catch {
			// Close handshakes and leave events still describe cleanup.
		}
		console.error(`Cleanup: ${cleanup.botLeaveEvents}/${paths.size} bot leave events, ${cleanup.playersAfter ?? 'unknown'} players remain.`);
	}
	if (received === 0) throw new Error(`No valid snapshots during measurement (${malformed} unreadable)`);
	const { url, ...settings } = config;
	const trace: ProbeTrace | undefined = events && {
		schema: 1, protocol: before.version, start, measuredStart, measuredEnd,
		botIds: [...paths.keys()], fps: config.fps, events
	};
	const result = {
		schema: 1,
		startedAt,
		url: url.href,
		protocol: before.version,
		startMap,
		startMode,
		startMapTimeLeft,
		snapshotHz,
		playersBefore: before.players,
		actualSeconds,
		settings,
		sentStates,
		receivedSnapshots: received,
		snapshotBytes,
		malformedSnapshots: malformed,
		mapChanges,
		relay: relay?.stats ?? null,
		cleanup,
		observers: renderers.map(({ fps, metrics }) => ({ fps, ...metrics!.summary() }))
	};
	return { result, trace };
}

export type Result = Awaited<ReturnType<typeof runProbe>>['result'];
