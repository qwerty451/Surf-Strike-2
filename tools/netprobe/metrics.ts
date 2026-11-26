import type { Rendered } from './adapter.ts';
import { distance, type BotPath, type Point, type Teleport } from './path.ts';

export class Series {
	private values: number[] = [];
	private squares = 0;

	add(value: number): void {
		this.values.push(value);
		this.squares += value * value;
	}

	summary() {
		const sorted = this.values.slice().sort((a, b) => a - b);
		const count = sorted.length;
		const at = (fraction: number) => sorted[Math.ceil(count * fraction) - 1] ?? null;
		return { count, rms: count ? Math.sqrt(this.squares / count) : null, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
	}
}

class Runs {
	private currentMs = 0;
	private totalMs = 0;
	private frames = 0;
	private episodes = 0;
	private over100Ms = 0;
	private maxMs = 0;

	add(on: boolean, dt: number): void {
		if (on) {
			this.frames++;
			this.totalMs += dt;
			this.currentMs += dt;
		} else {
			this.flush();
		}
	}

	private flush(): void {
		if (this.currentMs === 0) return;
		this.episodes++;
		if (this.currentMs > 100) this.over100Ms++;
		this.maxMs = Math.max(this.maxMs, this.currentMs);
		this.currentMs = 0;
	}

	summary() {
		this.flush();
		return { frames: this.frames, totalMs: this.totalMs, episodes: this.episodes, over100Ms: this.over100Ms, maxMs: this.maxMs };
	}
}

interface Frame {
	poseMs: number;
	point: Point;
}

interface ObservedTeleport {
	event: Teleport;
	slide: boolean;
}

export type TruthPath = Pick<BotPath, 'at' | 'project' | 'teleports'>;

interface BotMetrics {
	path: TruthPath;
	previous: Frame | null;
	underruns: Runs;
	freezes: Runs;
	pending: ObservedTeleport[];
}

const TELEPORT_TOLERANCE = 3;
const TELEPORT_WINDOW_MS = 2000;
const TELEPORT_ERROR_WINDOW_MS = 200;

function trackTeleport(bot: BotMetrics, ms: number, point: Point | null, totals: TeleportTotals): void {
	while (bot.pending.length > 0) {
		const pending = bot.pending[0];
		const { event } = pending;
		if (ms < event.ms) return;
		if (ms - event.ms > TELEPORT_WINDOW_MS) {
			totals.missed++;
			bot.pending.shift();
			continue;
		}
		if (!point) return;
		if (Math.abs(point.z - event.to) <= TELEPORT_TOLERANCE) {
			if (pending.slide) totals.slides++;
			else totals.snaps++;
			bot.pending.shift();
			continue;
		}
		if (point.z > Math.min(event.from, event.to) + TELEPORT_TOLERANCE &&
			point.z < Math.max(event.from, event.to) - TELEPORT_TOLERANCE) pending.slide = true;
		return;
	}
}

interface TeleportTotals {
	expected: number;
	slides: number;
	snaps: number;
	missed: number;
}

function sumRuns(runs: Runs[]) {
	const result = { frames: 0, totalMs: 0, episodes: 0, over100Ms: 0, maxMs: 0 };
	for (const run of runs) {
		const summary = run.summary();
		result.frames += summary.frames;
		result.totalMs += summary.totalMs;
		result.episodes += summary.episodes;
		result.over100Ms += summary.over100Ms;
		result.maxMs = Math.max(result.maxMs, summary.maxMs);
	}
	return result;
}

export class ObserverMetrics {
	private readonly bots = new Map<number, BotMetrics>();
	private readonly error = new Series();
	private readonly errorOutsideTeleports = new Series();
	private readonly shapeError = new Series();
	private readonly nominalDelay = new Series();
	private readonly effectiveDelay = new Series();
	private readonly speedWobble = new Series();
	private readonly correctionJump = new Series();
	private readonly teleports: TeleportTotals = { expected: 0, slides: 0, snaps: 0, missed: 0 };
	private frames = 0;
	private rendered = 0;
	private lastFrame: number | null = null;
	private measuredBotMs = 0;

	readonly interArrival = new Series();
	readonly rtt = new Series();
	readonly frameIntervals = new Series();

	constructor(paths: ReadonlyMap<number, TruthPath>, measurementStart: number, measurementEnd: number) {
		for (const [id, path] of paths) {
			// Count teleports with a complete observation window.
			const pending = path.teleports(measurementStart, measurementEnd - TELEPORT_WINDOW_MS).map((event) => ({ event, slide: false }));
			this.teleports.expected += pending.length;
			this.bots.set(id, { path, pending, previous: null, underruns: new Runs(), freezes: new Runs() });
		}
	}

	frame(ms: number, render: (id: number) => Rendered): void {
		const dt = this.lastFrame === null ? 0 : ms - this.lastFrame;
		if (dt > 0) this.frameIntervals.add(dt);
		this.lastFrame = ms;
		this.frames++;
		this.measuredBotMs += dt * this.bots.size;
		for (const [id, bot] of this.bots) {
			const { point, delayMs, underrun } = render(id);
			bot.underruns.add(underrun, dt);
			trackTeleport(bot, ms, point, this.teleports);
			const previous = bot.previous;
			bot.previous = null;
			if (!point) {
				bot.freezes.add(false, dt);
				continue;
			}
			this.rendered++;
			this.nominalDelay.add(delayMs);
			const targetMs = ms - delayMs;
			const error = distance(point, bot.path.at(targetMs));
			this.error.add(error);
			// A small timing miss at a discontinuity can otherwise dominate the spatial error.
			if (bot.path.teleports(targetMs - TELEPORT_ERROR_WINDOW_MS, targetMs + TELEPORT_ERROR_WINDOW_MS).length === 0) {
				this.errorOutsideTeleports.add(error);
			}
			const projected = bot.path.project(ms, point, delayMs);
			this.shapeError.add(projected.error);
			bot.previous = { poseMs: projected.ms, point };
			// Mid-teleport poses and endpoints at the search bound cannot identify a delay.
			if (projected.identifiable && projected.error <= 8 && ms - projected.ms < 1999) {
				this.effectiveDelay.add(ms - projected.ms);
			}
			let held = false;
			if (previous && dt > 0) {
				const before = bot.path.at(previous.poseMs);
				const expected = bot.path.at(previous.poseMs + dt);
				const projectedPose = bot.path.at(projected.ms);
				// Bot paths change levels by teleport. Measure ordinary motion within a level.
				if (before.z === expected.z && before.z === projectedPose.z) {
					held = distance(point, previous.point) < 0.01 && distance(before, expected) >= 0.01;
					this.correctionJump.add(Math.hypot(
						(point.x - previous.point.x) - (expected.x - before.x),
						(point.y - previous.point.y) - (expected.y - before.y),
						(point.z - previous.point.z) - (expected.z - before.z)
					));
				}
				const truthBefore = bot.path.at(projected.ms - dt);
				if (Math.abs(point.z - previous.point.z) <= TELEPORT_TOLERANCE && projectedPose.z === truthBefore.z) {
					this.speedWobble.add((distance(point, previous.point) - distance(projectedPose, truthBefore)) * 1000 / dt);
				}
			}
			bot.freezes.add(held, dt);
		}
	}

	summary() {
		const bots = [...this.bots.values()];
		return {
			frames: this.frames,
			botFrames: this.frames * bots.length,
			renderedBotFrames: this.rendered,
			measuredBotMs: this.measuredBotMs,
			frameIntervalsMs: this.frameIntervals.summary(),
			positionErrorU: this.error.summary(),
			positionErrorOutsideTeleportsU: this.errorOutsideTeleports.summary(),
			pathErrorU: this.shapeError.summary(),
			configuredDelayMs: this.nominalDelay.summary(),
			effectiveDelayMs: this.effectiveDelay.summary(),
			speedWobbleUps: this.speedWobble.summary(),
			correctionJumpU: this.correctionJump.summary(),
			underruns: sumRuns(bots.map(({ underruns }) => underruns)),
			freezes: sumRuns(bots.map(({ freezes }) => freezes)),
			teleports: { ...this.teleports, unresolved: bots.reduce((sum, bot) => sum + bot.pending.length, 0) },
			interArrivalMs: this.interArrival.summary(),
			rttMs: this.rtt.summary()
		};
	}
}

export type MetricsSummary = ReturnType<ObserverMetrics['summary']>;
