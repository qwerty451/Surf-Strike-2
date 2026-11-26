/**
 * Offline reproducible netcode benchmark harness: runs the real game server
 * and headless bot clients through a userspace delay/jitter/loss WebSocket
 * proxy (no sudo, no OS firewall/netem changes) and prints per-scenario stats.
 *
 * Usage:
 *   pnpm --filter server exec tsx ../../tools/net-bench.ts [--duration 6] [--json] [--scenario fiber] [--replay]
 */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import type { WebSocket as WsSocket, WebSocketServer as WsServer } from '../apps/server/node_modules/@types/ws/index.d.ts';
import {
	BIN_SNAPSHOT,
	decodeSnapshot,
	encodeState,
	FLAG_ON_GROUND,
	FLAG_TELEPORTED,
	INTERP_DELAY_MS,
	PROTOCOL_VERSION,
	SNAPSHOT_HZ,
	Status,
	TICK_RATE,
	withTeleportSeq,
	type MapDef,
	type NetState,
	type ServerMessage
} from '../packages/shared/src/index.ts';
import { startServer } from '../apps/server/src/server.ts';
import { FixedStep } from '../apps/web/src/lib/game/loop.ts';
import { AdaptiveDelay } from '../apps/web/src/lib/net/adaptive.ts';
import { ServerClock } from '../apps/web/src/lib/net/clock.ts';
import { emptySample, SnapshotBuffer } from '../apps/web/src/lib/net/interp.ts';
import { NetStats } from '../apps/web/src/lib/net/stats.ts';
import { replayProbe, type TraceEvent } from './netprobe/trace.ts';
import type { TruthPath } from './netprobe/metrics.ts';

const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { WebSocket, WebSocketServer } = serverRequire('ws') as {
	WebSocket: typeof WsSocket;
	WebSocketServer: typeof WsServer;
};

// ---------------------------------------------------------------------------
// Seeded PRNG (deterministic across runs)

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function normal(rng: () => number): number {
	const u1 = Math.max(1e-9, rng());
	const u2 = rng();
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Userspace TCP-ordered delay / jitter / loss / burst-stall WebSocket proxy

export interface LinkProfile {
	/** Nominal round-trip propagation delay (ms); half applied each way. */
	rttMs: number;
	/** One-way jitter standard deviation (ms, clipped Gaussian). */
	jitterMs: number;
	/** Per-TCP-segment i.i.d. packet loss probability (0..1). Frames >1420 B span 2 segments. */
	lossRate: number;
	/** Optional periodic Wi-Fi fade burst interval (ms, 0 = none). */
	burstEveryMs?: number;
	/** Duration of each Wi-Fi fade burst (ms). */
	burstDurationMs?: number;
	/** Seed for deterministic impairment. */
	seed: number;
}

const TCP_MSS_BYTES = 1420;
const WS_TLS_OVERHEAD = 26;

interface QueuedFrame {
	data: Buffer | string;
	isBinary: boolean;
	deliverAt: number;
}

class OrderedImpairedPipe {
	private readonly rng: () => number;
	private readonly queue: QueuedFrame[] = [];
	private timer: NodeJS.Timeout | null = null;
	private lastDeliverAt = 0;
	private stallUntil = 0;
	private nextBurstAt = Infinity;
	private burstEndAt = 0;
	private closed = false;

	constructor(
		private readonly profile: LinkProfile,
		private readonly sendFn: (data: Buffer | string, isBinary: boolean) => void,
		seedOffset: number
	) {
		this.rng = mulberry32((profile.seed ^ seedOffset) >>> 0);
		if (profile.burstEveryMs && profile.burstEveryMs > 0) {
			this.nextBurstAt = performance.now() + profile.burstEveryMs * (0.4 + this.rng() * 0.4);
		}
	}

	enqueue(data: Buffer | string, isBinary: boolean): void {
		if (this.closed) return;
		const now = performance.now();
		const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
		const oneWay = this.profile.rttMs / 2;
		const jitter = this.profile.jitterMs > 0 ? Math.max(-oneWay * 0.8, normal(this.rng) * this.profile.jitterMs) : 0;
		let deliverAt = now + Math.max(0.5, oneWay + jitter);

		// Model periodic Wi-Fi fade bursts (TCP holds all in-flight frames until fade clears + retransmit).
		if (this.profile.burstEveryMs && this.profile.burstDurationMs) {
			if (now >= this.nextBurstAt) {
				this.burstEndAt = now + this.profile.burstDurationMs;
				this.nextBurstAt = this.burstEndAt + this.profile.burstEveryMs * (0.8 + this.rng() * 0.4);
			}
			if (now < this.burstEndAt) {
				const recovery = this.burstEndAt + this.profile.rttMs + 30 + this.rng() * 40;
				if (recovery > this.stallUntil) this.stallUntil = recovery;
			}
		}

		// Model per-TCP-segment loss (multi-segment frames suffer higher loss probability).
		if (this.profile.lossRate > 0) {
			const segments = Math.max(1, Math.ceil((bytes + WS_TLS_OVERHEAD) / TCP_MSS_BYTES));
			const pLoss = 1 - Math.pow(1 - this.profile.lossRate, segments);
			if (this.rng() < pLoss) {
				// Fast retransmit takes ~1 RTT + 45..90 ms; double loss triggers Linux 200 ms RTO.
				const doubleLoss = this.rng() < this.profile.lossRate * 4;
				const stallMs = doubleLoss ? 200 + this.profile.rttMs : this.profile.rttMs + 45 + this.rng() * 45;
				const recovery = now + oneWay + stallMs;
				if (recovery > this.stallUntil) this.stallUntil = recovery;
			}
		}

		// TCP FIFO ordering: a stalled segment holds all subsequent frames until recovery,
		// then flushes them back-to-back in a burst.
		if (deliverAt < this.stallUntil) deliverAt = this.stallUntil;
		if (deliverAt < this.lastDeliverAt + 0.05) deliverAt = this.lastDeliverAt + 0.05;
		this.lastDeliverAt = deliverAt;

		this.queue.push({ data, isBinary, deliverAt });
		this.schedule();
	}

	private schedule(): void {
		if (this.timer || this.queue.length === 0 || this.closed) return;
		const wait = Math.max(0, this.queue[0]!.deliverAt - performance.now());
		this.timer = setTimeout(() => {
			this.timer = null;
			this.drain();
		}, wait);
	}

	private drain(): void {
		if (this.closed) return;
		const now = performance.now();
		while (this.queue.length > 0 && this.queue[0]!.deliverAt <= now + 0.5) {
			const item = this.queue.shift()!;
			this.sendFn(item.data, item.isBinary);
		}
		this.schedule();
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.queue.length = 0;
	}
}

class ImpairmentProxy {
	private readonly wss: WsServer;
	private readonly pipes = new Set<OrderedImpairedPipe>();
	private readonly upstreams = new Set<WsSocket>();
	private connSeq = 0;
	port = 0;

	constructor(
		private readonly upstreamPort: number,
		private readonly profile: LinkProfile
	) {
		this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws' });
		this.wss.on('connection', (downstream) => this.handle(downstream));
	}

	async start(): Promise<number> {
		await new Promise<void>((ok) => this.wss.once('listening', ok));
		const addr = this.wss.address();
		this.port = typeof addr === 'object' && addr ? addr.port : 0;
		return this.port;
	}

	private handle(downstream: WsSocket): void {
		const id = ++this.connSeq;
		const upstream = new WebSocket(`ws://127.0.0.1:${this.upstreamPort}/ws`);
		this.upstreams.add(upstream);

		const pendingUp: Array<{ data: Buffer | string; isBinary: boolean }> = [];
		let upOpen = false;

		const c2s = new OrderedImpairedPipe(
			this.profile,
			(data, isBinary) => {
				if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
			},
			id * 131 + 17
		);
		const s2c = new OrderedImpairedPipe(
			this.profile,
			(data, isBinary) => {
				if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
			},
			id * 131 + 997
		);
		this.pipes.add(c2s);
		this.pipes.add(s2c);

		upstream.on('open', () => {
			upOpen = true;
			for (const p of pendingUp) c2s.enqueue(p.data, p.isBinary);
			pendingUp.length = 0;
		});
		downstream.on('message', (data, isBinary) => {
			const payload = isBinary ? Buffer.from(data as Buffer) : data.toString('utf8');
			if (!upOpen) pendingUp.push({ data: payload, isBinary });
			else c2s.enqueue(payload, isBinary);
		});
		upstream.on('message', (data, isBinary) => {
			const payload = isBinary ? Buffer.from(data as Buffer) : data.toString('utf8');
			s2c.enqueue(payload, isBinary);
		});

		const cleanup = () => {
			c2s.close();
			s2c.close();
			this.pipes.delete(c2s);
			this.pipes.delete(s2c);
			this.upstreams.delete(upstream);
			try {
				downstream.close();
			} catch {
				// ignore
			}
			try {
				upstream.close();
			} catch {
				// ignore
			}
		};
		downstream.on('close', cleanup);
		upstream.on('close', cleanup);
		downstream.on('error', cleanup);
		upstream.on('error', cleanup);
	}

	async close(): Promise<void> {
		for (const p of this.pipes) p.close();
		for (const u of this.upstreams) u.terminate();
		for (const c of this.wss.clients) c.terminate();
		await new Promise<void>((ok) => this.wss.close(() => ok()));
	}
}

// ---------------------------------------------------------------------------
// Deterministic test trajectories

interface Pose {
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	yaw: number;
	teleported: boolean;
}

type TrajectoryKind = 'surf1200' | 'run265' | 'teleport400';

function evalTrajectory(kind: TrajectoryKind, elapsedSec: number, prevElapsedSec: number): Pose {
	if (kind === 'surf1200') {
		// Curved 1200 u/s surf arc (R = 600 u, omega = 2 rad/s) + gentle vertical wave.
		const R = 600;
		const w = 2.0;
		const a = w * elapsedSec;
		const x = R * Math.cos(a);
		const y = R * Math.sin(a);
		const z = 200 + 80 * Math.sin(1.5 * elapsedSec);
		const vx = -R * w * Math.sin(a);
		const vy = R * w * Math.cos(a);
		const vz = 80 * 1.5 * Math.cos(1.5 * elapsedSec);
		const yaw = (Math.atan2(vy, vx) * 180) / Math.PI;
		return { x, y, z, vx, vy, vz, yaw, teleported: false };
	}
	if (kind === 'run265') {
		// 265 u/s Infected straight run with smooth turn reversals.
		const speed = 265;
		const x = speed * elapsedSec;
		const y = 80 * Math.sin(2.5 * elapsedSec);
		const vx = speed;
		const vy = 80 * 2.5 * Math.cos(2.5 * elapsedSec);
		const yaw = (Math.atan2(vy, vx) * 180) / Math.PI;
		return { x, y, z: 0, vx, vy, vz: 0, yaw, teleported: false };
	}
	// teleport400: moves at 265 u/s, teleports by 400 u (< 1024 snapDistance!) every 0.5 s.
	const period = 0.5;
	const seg = Math.floor(elapsedSec / period);
	const prevSeg = Math.floor(prevElapsedSec / period);
	const teleported = seg !== prevSeg && prevElapsedSec >= 0;
	const local = elapsedSec - seg * period;
	const baseX = (seg % 2) * 400;
	return {
		x: baseX + 265 * local,
		y: (seg % 2) * 200,
		z: 0,
		vx: 265,
		vy: 0,
		vz: 0,
		yaw: 0,
		teleported
	};
}

function benchTruth(kind: TrajectoryKind): TruthPath {
	const at = (ms: number) => evalTrajectory(kind, Math.max(0, ms) / 1000, -1);
	return {
		at,
		teleports: () => [],
		project(now, point, delay) {
			if (kind === 'teleport400') {
				// Each branch repeats every second, so recover path error but report no delay.
				let closest = { ms: now - delay, error: Infinity, identifiable: false };
				for (let from = Math.max(0, Math.floor((now - 2000) / 500)) * 500; from <= now; from += 500) {
					const origin = at(from);
					const lo = Math.max(0, now - 2000 - from);
					const hi = Math.min(500, now - from);
					if (lo > hi) continue;
					const age = Math.max(lo, Math.min(hi, (point.x - origin.x) * 1000 / origin.vx));
					const error = Math.hypot(point.x - (origin.x + origin.vx * age / 1000), point.y - origin.y, point.z - origin.z);
					if (error < closest.error || (error === closest.error &&
						Math.abs(now - delay - from - age) < Math.abs(now - delay - closest.ms))) {
						closest = { ms: from + age, error, identifiable: false };
					}
				}
				return closest;
			}
			let ms: number;
			if (kind === 'surf1200') {
				const phaseMs = Math.atan2(point.y, point.x) * 500;
				const periodMs = Math.PI * 1000;
				ms = phaseMs + periodMs * Math.floor((now - phaseMs) / periodMs);
			} else {
				ms = point.x * 1000 / 265;
			}
			const truth = at(ms);
			const error = Math.hypot(point.x - truth.x, point.y - truth.y, point.z - truth.z);
			return { ms, error, identifiable: ms >= 0 && ms <= now };
		}
	};
}

// ---------------------------------------------------------------------------
// Headless bots and scenario runner

interface ScenarioDef {
	name: string;
	trajectory: TrajectoryKind;
	players: number;
	profile: LinkProfile;
}

interface ScenarioResult {
	replay?: ReturnType<typeof replayProbe>[number]['controllers'];
	scenario: string;
	players: number;
	snapBytes: number;
	inKibPerSec: number;
	snapHz: number;
	jitterMs: number;
	gapP95Ms: number;
	gapMaxMs: number;
	dupPct: number;
	meanInterpMs: number;
	meanVisualDelayMs: number;
	underrunPct: number;
	underrunMs: number;
	extrapMs: number;
	freezeMs: number;
	posRmsU: number;
	posP99U: number;
	posMaxU: number;
	speedStdUs: number;
	teleportLerpFrames: number;
}

const DEFAULT_SCENARIOS: ScenarioDef[] = [
	{
		name: 'fiber-surf1200',
		trajectory: 'surf1200',
		players: 8,
		profile: { rttMs: 20, jitterMs: 1, lossRate: 0, seed: 101 }
	},
	{
		name: 'wifi-surf1200',
		trajectory: 'surf1200',
		players: 8,
		profile: { rttMs: 40, jitterMs: 10, lossRate: 0.01, seed: 202 }
	},
	{
		name: 'wifi-burst-run265',
		trajectory: 'run265',
		players: 8,
		profile: { rttMs: 45, jitterMs: 12, lossRate: 0.015, burstEveryMs: 2200, burstDurationMs: 65, seed: 303 }
	},
	{
		name: '32p-wifi-surf1200',
		trajectory: 'surf1200',
		players: 32,
		profile: { rttMs: 35, jitterMs: 8, lossRate: 0.015, seed: 404 }
	},
	{
		name: 'teleport-400u',
		trajectory: 'teleport400',
		players: 4,
		profile: { rttMs: 25, jitterMs: 3, lossRate: 0, seed: 505 }
	}
];

function benchMap(): MapDef {
	return {
		id: 'surf_bench',
		title: 'Bench',
		kind: 'surf',
		difficulty: 'easy',
		layout: 'linear',
		cvars: { sv_maxvelocity: 3500 },
		spawn: { pos: { x: 0, y: 0, z: 0 }, yaw: 0 },
		brushes: [],
		zones: [],
		theme: {
			skyTop: 0,
			skyHorizon: 0,
			skyBottom: 0,
			fogColor: 0,
			fogNear: 0,
			fogFar: 1,
			sunColor: 0,
			sunIntensity: 1,
			sunDir: { x: 0, y: 0, z: 1 },
			ambientSky: 0,
			ambientGround: 0,
			ambientIntensity: 1,
			materials: {},
			effects: []
		}
	};
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
	return sorted[idx]!;
}

async function connectClient(
	port: number,
	name: string
): Promise<{ ws: WsSocket; selfId: number; serverTime?: number; snapshotHz?: number; welcomeArrival: number }> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	ws.binaryType = 'arraybuffer';
	const welcome = await new Promise<{ selfId: number; serverTime?: number; snapshotHz?: number; welcomeArrival: number }>((ok, fail) => {
		const timeout = setTimeout(() => fail(new Error(`welcome timeout for ${name}`)), 5000);
		ws.once('open', () => {
			ws.send(JSON.stringify({ type: 'hello', playerId: crypto.randomUUID(), name, version: PROTOCOL_VERSION }));
		});
		const onMsg = (data: Buffer | ArrayBuffer, isBinary: boolean) => {
			if (isBinary) return;
			const msg = JSON.parse(Buffer.from(data as ArrayBuffer).toString('utf8')) as ServerMessage;
			if (msg.type === 'welcome') {
				clearTimeout(timeout);
				ws.off('message', onMsg);
				ok({ selfId: msg.selfId, serverTime: msg.serverTime, snapshotHz: msg.snapshotHz, welcomeArrival: performance.now() });
			}
		};
		ws.on('message', onMsg);
		ws.once('error', (err) => {
			clearTimeout(timeout);
			fail(err);
		});
	});
	return { ws, ...welcome };
}

async function runScenario(def: ScenarioDef, durationSec: number, snapshotHz: number, replay: boolean): Promise<ScenarioResult> {
	const server = await startServer({
		port: 0,
		host: '127.0.0.1',
		dbPath: ':memory:',
		maps: [benchMap()],
		initialMap: 'surf_bench',
		snapshotHz,
		log: () => {}
	});
	const proxy = new ImpairmentProxy(server.port, def.profile);
	await proxy.start();

	const sockets: WsSocket[] = [];
	const timers: NodeJS.Timeout[] = [];
	try {
		// Connect target bot through proxy, observer through proxy, and extra background bots directly
		// (background bots keep the lobby populated at `def.players` so snapshot payloads match real sizes).
		const target = await connectClient(proxy.port, 'Target');
		const observer = await connectClient(proxy.port, 'Observer');
		sockets.push(target.ws, observer.ws);

		const extras: WsSocket[] = [];
		for (let i = 2; i < def.players; i++) {
			const bot = await connectClient(server.port, `Bg-${i}`);
			extras.push(bot.ws);
			sockets.push(bot.ws);
		}

		// Keep ping responses flowing on all clients.
		for (const ws of sockets) {
			ws.on('message', (data, isBinary) => {
				if (isBinary) return;
				const msg = JSON.parse(Buffer.from(data as ArrayBuffer).toString('utf8')) as ServerMessage;
				if (msg.type === 'ping' && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
				}
			});
		}

		// Background bots + observer send initial state so all `def.players` appear in every snapshot.
		for (let i = 0; i < extras.length + 1; i++) {
			const ws = i < extras.length ? extras[i]! : observer.ws;
			const st: NetState = {
				tick: 1,
				x: 1000 + i * 50,
				y: 1000,
				z: 0,
				vx: 0,
				vy: 0,
				vz: 0,
				pitch: 0,
				yaw: 0,
				flags: FLAG_ON_GROUND,
				status: Status.Running,
				stage: 1,
				runTicks: i * 10
			};
			ws.send(encodeState(st));
		}

		// Observer tracks target using the real production ServerClock + AdaptiveDelay + SnapshotBuffer + NetStats.
		const clock = new ServerClock();
		const adaptive = new AdaptiveDelay({ snapshotHz: observer.snapshotHz ?? SNAPSHOT_HZ });
		if (observer.snapshotHz) clock.setNominalSnapHz(observer.snapshotHz);
		if (observer.serverTime !== undefined) clock.seed(observer.welcomeArrival, observer.serverTime);
		const buf = new SnapshotBuffer();
		const stats = new NetStats();
		if (observer.snapshotHz) stats.setNominalSnapHz(observer.snapshotHz);
		stats.setInterpDelay(adaptive.currentMs);
		const sample = emptySample();
		const events: TraceEvent[] | undefined = replay ? [[observer.welcomeArrival, 'timing', {
			type: 'welcome', selfId: observer.selfId, map: 'surf_bench',
			serverTime: observer.serverTime, snapshotHz: observer.snapshotHz
		}]] : undefined;

		const gaps: number[] = [];
		let lastSnapArr = -Infinity;
		let totalSnapBytes = 0;
		let snapCount = 0;
		let totalInBytes = 0;

		observer.ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
		const pingTimer = setInterval(() => {
			if (observer.ws.readyState === WebSocket.OPEN) {
				observer.ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
			}
		}, 1000);
		timers.push(pingTimer);

		observer.ws.on('message', (data, isBinary) => {
			const arr = performance.now();
			const bytes = isBinary ? (data as ArrayBuffer).byteLength : Buffer.byteLength(Buffer.from(data as ArrayBuffer));
			totalInBytes += bytes;
			stats.recordTraffic('in', bytes, arr);
			if (!isBinary) {
				const msg = JSON.parse(Buffer.from(data as ArrayBuffer).toString('utf8')) as ServerMessage;
				if (msg.type === 'pong') {
					events?.push([arr, 'timing', msg]);
					const rtt = clock.observePong(msg.t, arr, msg.serverTime);
					if (rtt >= 0) stats.recordRtt(rtt);
				} else if (msg.type === 'scoreboard') {
					const row = msg.rows.find((r) => r.id === observer.selfId);
					if (row && stats.rtt < 0) stats.recordRtt(row.ping);
				}
				return;
			}
			const ab = data as ArrayBuffer;
			if (ab.byteLength < 1 || new Uint8Array(ab, 0, 1)[0] !== BIN_SNAPSHOT) return;
			const frame = decodeSnapshot(ab);
			if (!frame) return;
			events?.push([arr, 'snapshot', Buffer.from(ab).toString('base64')]);
			totalSnapBytes += ab.byteLength;
			snapCount++;
			if (Number.isFinite(lastSnapArr)) gaps.push(arr - lastSnapArr);
			lastSnapArr = arr;
			const obs = clock.observeSnapshot(arr, frame.serverTimeMs, frame.seq);
			stats.recordSnapshot(arr, {
				serverTimeMs: frame.serverTimeMs,
				seq: frame.seq,
				selfId: observer.selfId,
				entries: obs.accepted ? frame.entries : undefined
			});
			if (!obs.accepted) return;
			adaptive.observeSnapshot(arr, obs);
			const te = frame.entries.find((e) => e.id === target.selfId);
			if (te) buf.push(te, frame.serverTimeMs, arr);
		});

		// Target runs real FixedStep (64 Hz) driven by a 60 Hz frame cadence (same as browser rAF).
		const warmupMs = 800;
		const measureMs = durationSec * 1000;
		const startMs = performance.now();
		const step = new FixedStep(TICK_RATE, 8);
		let targetTick = 1;
		let targetTpSeq = 0;
		let prevElapsed = -1;
		let lastTargetFrame = startMs;

		const targetTimer = setInterval(() => {
			const now = performance.now();
			const dt = now - lastTargetFrame;
			lastTargetFrame = now;
			const n = step.advance(dt);
			const stepMs = step.stepMs;
			let tickEnd = now - step.accMs - (n - 1) * stepMs;
			for (let i = 0; i < n; i++, tickEnd += stepMs) {
				const elapsedSec = Math.max(0, (tickEnd - startMs) / 1000);
				const p = evalTrajectory(def.trajectory, elapsedSec, prevElapsed);
				prevElapsed = elapsedSec;
				if (p.teleported) targetTpSeq = (targetTpSeq + 1) & 0xff;
				const flags = withTeleportSeq(FLAG_ON_GROUND | (p.teleported ? FLAG_TELEPORTED : 0), targetTpSeq);
				if (target.ws.readyState === WebSocket.OPEN) {
					target.ws.send(
						encodeState({
							tick: targetTick++,
							x: p.x,
							y: p.y,
							z: p.z,
							vx: p.vx,
							vy: p.vy,
							vz: p.vz,
							pitch: 0,
							yaw: p.yaw,
							flags,
							status: Status.Running,
							stage: 1,
							runTicks: targetTick
						})
					);
				}
			}
		}, 1000 / 60);
		timers.push(targetTimer);

		// Observer samples at 60 Hz and records rendered trajectory samples after warmup.
		interface FrameRecord {
			now: number;
			dtMs: number;
			x: number;
			y: number;
			z: number;
			interpMs: number;
			underrun: boolean;
			extrapolating: boolean;
		}
		const frames: FrameRecord[] = [];
		let lastObsFrame = startMs;

		const obsTimer = setInterval(() => {
			const now = performance.now();
			const dt = now - lastObsFrame;
			lastObsFrame = now;
			events?.push([now, 'frame', 60, dt]);
			const interpMs = adaptive.update(now, dt);
			stats.setInterpDelay(interpMs);
			const renderAt = clock.renderTime(now, interpMs);
			const ok = buf.sample(renderAt, sample, undefined, now);
			if (!ok) return;
			const underrun = buf.lastUnderrun;
			const extrapolating = buf.lastExtrapMs > 0;
			stats.recordFrame(now, dt, underrun, extrapolating);
			if (now - startMs >= warmupMs) {
				frames.push({
					now,
					dtMs: dt,
					x: sample.x,
					y: sample.y,
					z: sample.z,
					interpMs,
					underrun,
					extrapolating
				});
			}
		}, 1000 / 60);
		timers.push(obsTimer);

		await new Promise<void>((r) => setTimeout(r, warmupMs + measureMs));
		for (const t of timers) clearInterval(t);
		timers.length = 0;

		const endMs = performance.now();
		const totalElapsedSec = (endMs - startMs) / 1000;
		const snapView = stats.view(endMs, false);

		// Estimate best-fit constant visual delay across non-underrun frames by minimizing
		// trajectory MSE over [0, 350] ms so we separate latency (meanVisualDelayMs) from
		// trajectory distortion/wobble/freezes (posRmsU, posP99U, posMaxU).
		const bestDelayMs = (() => {
			if (def.trajectory === 'teleport400' || frames.length === 0) return def.profile.rttMs + INTERP_DELAY_MS + 1000 / SNAPSHOT_HZ / 2;
			let bestD = INTERP_DELAY_MS + def.profile.rttMs;
			let bestErr = Infinity;
			for (let d = 20; d <= 320; d += 2) {
				let sumSq = 0;
				for (const f of frames) {
					const tSec = Math.max(0, (f.now - d - startMs) / 1000);
					const truth = evalTrajectory(def.trajectory, tSec, tSec);
					const dx = f.x - truth.x;
					const dy = f.y - truth.y;
					const dz = f.z - truth.z;
					sumSq += dx * dx + dy * dy + dz * dz;
				}
				if (sumSq < bestErr) {
					bestErr = sumSq;
					bestD = d;
				}
			}
			// Refine to 0.25 ms.
			for (let d = bestD - 2; d <= bestD + 2; d += 0.25) {
				let sumSq = 0;
				for (const f of frames) {
					const tSec = Math.max(0, (f.now - d - startMs) / 1000);
					const truth = evalTrajectory(def.trajectory, tSec, tSec);
					const dx = f.x - truth.x;
					const dy = f.y - truth.y;
					const dz = f.z - truth.z;
					sumSq += dx * dx + dy * dy + dz * dz;
				}
				if (sumSq < bestErr) {
					bestErr = sumSq;
					bestD = d;
				}
			}
			return bestD;
		})();

		const posErrors: number[] = [];
		const speeds: number[] = [];
		let underrunFrames = 0;
		let underrunMs = 0;
		let extrapMs = 0;
		let interpSum = 0;
		let teleportLerpFrames = 0;

		for (let i = 0; i < frames.length; i++) {
			const f = frames[i]!;
			interpSum += f.interpMs;
			if (f.underrun) {
				underrunFrames++;
				underrunMs += f.dtMs;
				if (f.extrapolating) extrapMs += f.dtMs;
			}
			if (def.trajectory === 'teleport400') {
				// Valid positions live on y = 0 (even segment) or y = 200 (odd segment).
				// Any frame with 20 < y < 180 is an avatar visibly lerping across a teleport!
				if (f.y > 20 && f.y < 180) teleportLerpFrames++;
				const nearY = Math.min(Math.abs(f.y), Math.abs(f.y - 200));
				posErrors.push(nearY);
			} else {
				const tSec = Math.max(0, (f.now - bestDelayMs - startMs) / 1000);
				const truth = evalTrajectory(def.trajectory, tSec, tSec);
				posErrors.push(Math.hypot(f.x - truth.x, f.y - truth.y, f.z - truth.z));
			}
			if (i > 0 && f.dtMs > 1 && def.trajectory !== 'teleport400') {
				const prev = frames[i - 1]!;
				const spd = Math.hypot(f.x - prev.x, f.y - prev.y, f.z - prev.z) / (f.dtMs / 1000);
				speeds.push(spd);
			}
		}

		const sortedErr = [...posErrors].sort((a, b) => a - b);
		const rms = posErrors.length > 0 ? Math.sqrt(posErrors.reduce((a, e) => a + e * e, 0) / posErrors.length) : 0;
		const speedMean = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
		const speedStd =
			speeds.length > 1
				? Math.sqrt(speeds.reduce((a, v) => a + (v - speedMean) * (v - speedMean), 0) / (speeds.length - 1))
				: 0;
		const sortedGaps = [...gaps].sort((a, b) => a - b);

		const replayed = events && replayProbe({
			schema: 1, protocol: PROTOCOL_VERSION, start: startMs, measuredStart: startMs + warmupMs,
			measuredEnd: endMs, botIds: [target.selfId], fps: [60], events
		}, { truth: new Map([[target.selfId, benchTruth(def.trajectory)]]), map: benchMap() });
		return {
			replay: replayed?.[0].controllers,
			scenario: def.name,
			players: def.players,
			snapBytes: snapCount > 0 ? Math.round(totalSnapBytes / snapCount) : 0,
			inKibPerSec: totalInBytes / totalElapsedSec / 1024,
			snapHz: snapCount / totalElapsedSec,
			jitterMs: snapView.jitterMs,
			gapP95Ms: percentile(sortedGaps, 0.95),
			gapMaxMs: sortedGaps.length > 0 ? sortedGaps[sortedGaps.length - 1]! : 0,
			dupPct: snapView.dupPct,
			meanInterpMs: frames.length > 0 ? interpSum / frames.length : INTERP_DELAY_MS,
			meanVisualDelayMs: bestDelayMs,
			underrunPct: frames.length > 0 ? (underrunFrames / frames.length) * 100 : 0,
			underrunMs,
			extrapMs,
			freezeMs: Math.max(0, underrunMs - extrapMs),
			posRmsU: rms,
			posP99U: percentile(sortedErr, 0.99),
			posMaxU: sortedErr.length > 0 ? sortedErr[sortedErr.length - 1]! : 0,
			speedStdUs: speedStd,
			teleportLerpFrames
		};
	} finally {
		for (const t of timers) clearInterval(t);
		for (const ws of sockets) ws.terminate();
		await proxy.close();
		await server.close();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let duration = 5;
	let json = false;
	let replay = false;
	let filter: string | null = null;
	let snapshotHz = SNAPSHOT_HZ;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--duration' && args[i + 1]) duration = Math.max(1, Number(args[++i]));
		else if (args[i] === '--json') json = true;
		else if (args[i] === '--replay') replay = true;
		else if (args[i] === '--scenario' && args[i + 1]) filter = args[++i]!;
		else if (args[i] === '--hz' && args[i + 1]) snapshotHz = Math.max(1, Math.min(128, Math.round(Number(args[++i]))));
	}

	const list = filter ? DEFAULT_SCENARIOS.filter((s) => s.name.includes(filter!)) : DEFAULT_SCENARIOS;
	const results: ScenarioResult[] = [];
	for (const sc of list) {
		results.push(await runScenario(sc, duration, snapshotHz, replay));
	}

	if (json) {
		console.log(JSON.stringify({ protocol: PROTOCOL_VERSION, snapshotHz, results }, null, 2));
		return;
	}

	console.log(`Surf Strike 2 net-bench (protocol v${PROTOCOL_VERSION}, SNAPSHOT_HZ=${snapshotHz}, ${duration}s/scenario)\n`);
	console.log(
		[
			'scenario'.padEnd(20),
			'B/sn'.padStart(5),
			'KiB/s'.padStart(6),
			'Hz'.padStart(5),
			'jit'.padStart(5),
			'gap95'.padStart(6),
			'gapMx'.padStart(6),
			'dup%'.padStart(5),
			'intrp'.padStart(6),
			'vDly'.padStart(6),
			'und%'.padStart(5),
			'undMs'.padStart(6),
			'extMs'.padStart(6),
			'frzMs'.padStart(6),
			'rmsU'.padStart(6),
			'p99U'.padStart(6),
			'spdSd'.padStart(6),
			'tpLrp'.padStart(5)
		].join(' ')
	);
	console.log('-'.repeat(126));
	for (const r of results) {
		console.log(
			[
				r.scenario.padEnd(20),
				String(r.snapBytes).padStart(5),
				r.inKibPerSec.toFixed(1).padStart(6),
				r.snapHz.toFixed(1).padStart(5),
				r.jitterMs.toFixed(1).padStart(5),
				r.gapP95Ms.toFixed(1).padStart(6),
				r.gapMaxMs.toFixed(0).padStart(6),
				r.dupPct.toFixed(1).padStart(5),
				r.meanInterpMs.toFixed(0).padStart(6),
				r.meanVisualDelayMs.toFixed(0).padStart(6),
				r.underrunPct.toFixed(1).padStart(5),
				r.underrunMs.toFixed(0).padStart(6),
				r.extrapMs.toFixed(0).padStart(6),
				r.freezeMs.toFixed(0).padStart(6),
				r.posRmsU.toFixed(2).padStart(6),
				r.posP99U.toFixed(2).padStart(6),
				r.speedStdUs.toFixed(1).padStart(6),
				String(r.teleportLerpFrames).padStart(5)
			].join(' ')
		);
	}
	if (replay) {
		console.log('\nSnapshot replay at 60 Hz (effective delay p50/p95 ms, freeze seconds, position error RMS u)');
		for (const result of results) {
			for (const [name, metrics] of Object.entries(result.replay ?? {})) {
				const { p50, p95 } = metrics.effectiveDelayMs;
				console.log(
					`${result.scenario} ${name}: ${p50?.toFixed(1) ?? 'n/a'}/${p95?.toFixed(1) ?? 'n/a'}, ` +
					`${(metrics.freezes.totalMs / 1000).toFixed(3)}, ${metrics.positionErrorU.rms?.toFixed(1) ?? 'n/a'}`
				);
			}
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
