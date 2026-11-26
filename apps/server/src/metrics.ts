/**
 * Runtime metrics exposed at `/metrics` in Prometheus text exposition format
 * (docs/hosting.md#metrics).
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { SNAPSHOT_HZ } from '@surf/shared';

const TICK_RING_SIZE = 256;
const RATE_WINDOW_SECS = 5;
const ELD_RESET_MS = 30_000;

class LatenessRing {
	private readonly samples = new Float64Array(TICK_RING_SIZE);
	private write = 0;
	private filled = 0;
	private lastMs: number | null = null;
	count = 0;

	constructor(private readonly expectedMs: number) {}

	record(nowMs: number): void {
		this.count++;
		if (this.lastMs !== null) {
			const late = Math.max(0, nowMs - this.lastMs - this.expectedMs);
			this.samples[this.write] = late;
			this.write = (this.write + 1) % TICK_RING_SIZE;
			if (this.filled < TICK_RING_SIZE) this.filled++;
		}
		this.lastMs = nowMs;
	}

	stats(): { p50: number; p99: number; max: number } {
		if (this.filled === 0) return { p50: 0, p99: 0, max: 0 };
		const sorted = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);
		const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
		return { p50: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1] };
	}
}

class BytesRate {
	private readonly buckets = new Float64Array(RATE_WINDOW_SECS);
	private readonly secs = new Int32Array(RATE_WINDOW_SECS).fill(-1);
	private startSec: number;
	total = 0;

	constructor(nowMs: number) {
		this.startSec = Math.floor(nowMs / 1000);
	}

	add(bytes: number, nowMs: number): void {
		if (bytes <= 0) return;
		this.total += bytes;
		const sec = Math.floor(nowMs / 1000);
		const idx = ((sec % RATE_WINDOW_SECS) + RATE_WINDOW_SECS) % RATE_WINDOW_SECS;
		if (this.secs[idx] !== sec) {
			this.secs[idx] = sec;
			this.buckets[idx] = 0;
		}
		this.buckets[idx] += bytes;
	}

	perSecond(nowMs: number): number {
		const nowSec = Math.floor(nowMs / 1000);
		let sum = 0;
		for (let i = 0; i < RATE_WINDOW_SECS; i++) {
			if (this.secs[i] >= 0 && nowSec - this.secs[i] < RATE_WINDOW_SECS) {
				sum += this.buckets[i];
			}
		}
		const elapsed = Math.max(1, Math.min(RATE_WINDOW_SECS, nowSec - this.startSec + 1));
		return sum / elapsed;
	}
}

export interface MetricsSource {
	readonly playerCount: number;
	readonly pendingCount: number;
	readonly maxPlayers: number;
	maxBufferedBytes(): number;
}

export interface LobbyMetricsHooks {
	recordSnapshotTick(nowMs?: number): void;
	recordModeTick(nowMs?: number): void;
	recordBytesSent(bytes: number, nowMs?: number): void;
	recordFrameDropped(): void;
}

export class ServerMetrics implements LobbyMetricsHooks {
	private readonly eld: ReturnType<typeof monitorEventLoopDelay>;
	private eldLast = { p50: 0, p99: 0, max: 0 };
	private readonly eldResetTimer: NodeJS.Timeout;
	private readonly snapshotLateness: LatenessRing;
	private readonly modeLateness: LatenessRing;
	private readonly bytes: BytesRate;
	private framesDropped = 0;

	constructor(modeTickHz: number, private readonly now: () => number = () => performance.now(), snapshotHz = SNAPSHOT_HZ) {
		this.snapshotLateness = new LatenessRing(1000 / snapshotHz);
		this.modeLateness = new LatenessRing(1000 / modeTickHz);
		this.bytes = new BytesRate(this.now());
		this.eld = monitorEventLoopDelay({ resolution: 10 });
		this.eld.enable();
		this.eldResetTimer = setInterval(() => {
			this.eldLast = this.readEld();
			this.eld.reset();
		}, ELD_RESET_MS);
		this.eldResetTimer.unref();
	}

	recordSnapshotTick(nowMs = this.now()): void {
		this.snapshotLateness.record(nowMs);
	}

	recordModeTick(nowMs = this.now()): void {
		this.modeLateness.record(nowMs);
	}

	recordBytesSent(bytes: number, nowMs = this.now()): void {
		this.bytes.add(bytes, nowMs);
	}

	recordFrameDropped(): void {
		this.framesDropped++;
	}

	private readEld(): { p50: number; p99: number; max: number } {
		if (this.eld.count === 0) return this.eldLast;
		const toMs = (ns: number) => (Number.isFinite(ns) && ns > 0 ? ns / 1e6 : 0);
		return {
			p50: toMs(this.eld.percentile(50)),
			p99: toMs(this.eld.percentile(99)),
			max: toMs(this.eld.max)
		};
	}

	/** Prometheus text exposition format (version 0.0.4). */
	render(source: MetricsSource): string {
		const nowMs = this.now();
		const eld = this.readEld();
		const snap = this.snapshotLateness.stats();
		const mode = this.modeLateness.stats();
		const rss = process.memoryUsage().rss;
		const lines = [
			'# HELP surf_players Connected players in the lobby.',
			'# TYPE surf_players gauge',
			`surf_players ${source.playerCount}`,
			'# HELP surf_pending_connections Open WebSocket connections awaiting hello.',
			'# TYPE surf_pending_connections gauge',
			`surf_pending_connections ${source.pendingCount}`,
			'# HELP surf_max_players Configured maximum player slots.',
			'# TYPE surf_max_players gauge',
			`surf_max_players ${source.maxPlayers}`,
			'# HELP surf_event_loop_delay_p50_ms Event loop delay 50th percentile in milliseconds.',
			'# TYPE surf_event_loop_delay_p50_ms gauge',
			`surf_event_loop_delay_p50_ms ${fmt(eld.p50)}`,
			'# HELP surf_event_loop_delay_p99_ms Event loop delay 99th percentile in milliseconds.',
			'# TYPE surf_event_loop_delay_p99_ms gauge',
			`surf_event_loop_delay_p99_ms ${fmt(eld.p99)}`,
			'# HELP surf_event_loop_delay_max_ms Event loop delay max in milliseconds.',
			'# TYPE surf_event_loop_delay_max_ms gauge',
			`surf_event_loop_delay_max_ms ${fmt(eld.max)}`,
			'# HELP surf_snapshot_tick_lateness_p50_ms Snapshot timer lateness 50th percentile in milliseconds.',
			'# TYPE surf_snapshot_tick_lateness_p50_ms gauge',
			`surf_snapshot_tick_lateness_p50_ms ${fmt(snap.p50)}`,
			'# HELP surf_snapshot_tick_lateness_p99_ms Snapshot timer lateness 99th percentile in milliseconds.',
			'# TYPE surf_snapshot_tick_lateness_p99_ms gauge',
			`surf_snapshot_tick_lateness_p99_ms ${fmt(snap.p99)}`,
			'# HELP surf_snapshot_tick_lateness_max_ms Snapshot timer lateness max in milliseconds.',
			'# TYPE surf_snapshot_tick_lateness_max_ms gauge',
			`surf_snapshot_tick_lateness_max_ms ${fmt(snap.max)}`,
			'# HELP surf_snapshot_ticks_total Total snapshot timer ticks.',
			'# TYPE surf_snapshot_ticks_total counter',
			`surf_snapshot_ticks_total ${this.snapshotLateness.count}`,
			'# HELP surf_mode_tick_lateness_p50_ms Mode timer lateness 50th percentile in milliseconds.',
			'# TYPE surf_mode_tick_lateness_p50_ms gauge',
			`surf_mode_tick_lateness_p50_ms ${fmt(mode.p50)}`,
			'# HELP surf_mode_tick_lateness_p99_ms Mode timer lateness 99th percentile in milliseconds.',
			'# TYPE surf_mode_tick_lateness_p99_ms gauge',
			`surf_mode_tick_lateness_p99_ms ${fmt(mode.p99)}`,
			'# HELP surf_mode_tick_lateness_max_ms Mode timer lateness max in milliseconds.',
			'# TYPE surf_mode_tick_lateness_max_ms gauge',
			`surf_mode_tick_lateness_max_ms ${fmt(mode.max)}`,
			'# HELP surf_mode_ticks_total Total mode timer ticks.',
			'# TYPE surf_mode_ticks_total counter',
			`surf_mode_ticks_total ${this.modeLateness.count}`,
			'# HELP surf_bytes_sent_total Cumulative bytes sent over WebSockets.',
			'# TYPE surf_bytes_sent_total counter',
			`surf_bytes_sent_total ${this.bytes.total}`,
			'# HELP surf_bytes_sent_per_second Rolling average bytes sent per second over WebSockets.',
			'# TYPE surf_bytes_sent_per_second gauge',
			`surf_bytes_sent_per_second ${fmt(this.bytes.perSecond(nowMs))}`,
			'# HELP surf_frames_dropped_total Droppable frames skipped due to socket backlog.',
			'# TYPE surf_frames_dropped_total counter',
			`surf_frames_dropped_total ${this.framesDropped}`,
			'# HELP surf_socket_buffered_bytes_max Maximum WebSocket bufferedAmount across connected sockets in bytes.',
			'# TYPE surf_socket_buffered_bytes_max gauge',
			`surf_socket_buffered_bytes_max ${source.maxBufferedBytes()}`,
			'# HELP process_resident_memory_bytes Resident memory size in bytes.',
			'# TYPE process_resident_memory_bytes gauge',
			`process_resident_memory_bytes ${rss}`,
			'# HELP process_uptime_seconds Process uptime in seconds.',
			'# TYPE process_uptime_seconds gauge',
			`process_uptime_seconds ${fmt(process.uptime())}`
		];
		return `${lines.join('\n')}\n`;
	}

	close(): void {
		clearInterval(this.eldResetTimer);
		this.eld.disable();
	}
}

function fmt(n: number): string {
	return Number.isFinite(n) ? Number(n.toFixed(3)).toString() : '0';
}
