import type { NetState } from './wire-v1.ts';

export type Point = Pick<NetState, 'x' | 'y' | 'z'>;
export type Pose = Point & Pick<NetState, 'vx' | 'vy' | 'vz'>;

type Motion =
	| { kind: 'line'; x: number; y: number; vx: number; vy: number }
	| { kind: 'arc'; x: number; y: number; angle: number; rate: number };
type Segment = Motion & { start: number; end: number; z: number };

const RADIUS = 600;
const TAU = 2 * Math.PI;
const ARC_END_X = 530 + RADIUS * Math.sin(6);
const ARC_END_Y = RADIUS * (1 - Math.cos(6));
const CYCLE_MS = 16_000;
const DELAY_SEARCH_MS = 2_000;
// The endpoint belongs to the next segment, which may start on a different level.
const SEGMENT_END_EPSILON_MS = 1e-6;

const segments: Segment[] = [
	{ start: 0, end: 2000, z: 0, kind: 'line', x: 0, y: 0, vx: 265, vy: 0 },
	{ start: 2000, end: 5000, z: 0, kind: 'arc', x: 530, y: RADIUS, angle: 0, rate: 2 },
	{ start: 5000, end: 6000, z: 0, kind: 'line', x: ARC_END_X, y: ARC_END_Y, vx: 0, vy: 0 },
	{ start: 6000, end: 9000, z: 384, kind: 'arc', x: 530, y: RADIUS, angle: 6, rate: -2 },
	{ start: 9000, end: 11000, z: 384, kind: 'line', x: 530, y: 0, vx: -265, vy: 0 },
	{ start: 11000, end: 12000, z: 384, kind: 'line', x: 0, y: 0, vx: 0, vy: 0 },
	{ start: 12000, end: 14000, z: 1920, kind: 'line', x: 0, y: 0, vx: 265, vy: 0 },
	{ start: 14000, end: 16000, z: 1920, kind: 'line', x: 530, y: 0, vx: -265, vy: 0 }
];

function poseAt(segment: Segment, localMs: number): Pose {
	const s = (localMs - segment.start) / 1000;
	const { x, y, z } = segment;
	if (segment.kind === 'line') {
		const { vx, vy } = segment;
		return { x: x + vx * s, y: y + vy * s, z, vx, vy, vz: 0 };
	}
	const angle = segment.angle + segment.rate * s;
	const speed = RADIUS * segment.rate;
	const sin = Math.sin(angle);
	const cos = Math.cos(angle);
	return { x: x + RADIUS * sin, y: y - RADIUS * cos, z, vx: speed * cos, vy: speed * sin, vz: 0 };
}

function closestMs(segment: Segment, point: Point, lo: number, hi: number): number {
	const dx = point.x - segment.x;
	const dy = point.y - segment.y;
	let ms: number;
	if (segment.kind === 'line') {
		const { vx, vy } = segment;
		if (vx === 0 && vy === 0) return hi;
		ms = segment.start + (1000 * (dx * vx + dy * vy)) / (vx * vx + vy * vy);
	} else {
		const angle = Math.atan2(dx, -dy);
		const middleAngle = segment.angle + (segment.rate * ((lo + hi) / 2 - segment.start)) / 1000;
		const nearestAngle = angle + TAU * Math.round((middleAngle - angle) / TAU);
		ms = segment.start + (1000 * (nearestAngle - segment.angle)) / segment.rate;
	}
	return Math.max(lo, Math.min(hi, ms));
}

export function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export interface Teleport {
	ms: number;
	from: number;
	to: number;
}

export class BotPath {
	private readonly offsetY: number;
	private readonly phaseMs: number;

	constructor(index: number) {
		this.offsetY = index * 128;
		// Different path phases, all aligned to a 64 Hz tick.
		this.phaseMs = index * 875;
	}

	at(ms: number): Pose {
		const absolute = ms + this.phaseMs;
		const local = absolute - CYCLE_MS * Math.floor(absolute / CYCLE_MS);
		const segment = segments.find(({ end }) => local < end)!;
		const pose = poseAt(segment, local);
		pose.y += this.offsetY;
		return pose;
	}

	teleports(startMs: number, endMs: number): Teleport[] {
		const start = startMs + this.phaseMs;
		const end = endMs + this.phaseMs;
		const events: Teleport[] = [];
		for (let cycle = CYCLE_MS * Math.floor(start / CYCLE_MS); cycle <= end; cycle += CYCLE_MS) {
			for (const [offset, from, to] of [[0, 1920, 0], [6000, 0, 384], [12000, 384, 1920]]) {
				const at = cycle + offset;
				if (at > start && at <= end) events.push({ ms: at - this.phaseMs, from, to });
			}
		}
		return events;
	}

	/** Invert the known path within a bounded lookback, excluding stationary ambiguity. */
	project(ms: number, point: Point, nominalMs: number): { ms: number; error: number; identifiable: boolean } {
		const localPoint = { ...point, y: point.y - this.offsetY };
		const start = ms + this.phaseMs - DELAY_SEARCH_MS;
		const end = ms + this.phaseMs;
		let best = { ms: ms - nominalMs, error: Infinity, identifiable: false };
		for (let cycle = CYCLE_MS * Math.floor(start / CYCLE_MS); cycle <= end; cycle += CYCLE_MS) {
			for (const segment of segments) {
				const lo = Math.max(segment.start, start - cycle);
				const hi = Math.min(segment.end - SEGMENT_END_EPSILON_MS, end - cycle);
				if (lo > hi) continue;
				const at = closestMs(segment, localPoint, lo, hi);
				const pose = poseAt(segment, at);
				const projectedMs = cycle + at - this.phaseMs;
				const error = distance(localPoint, pose);
				const moving = pose.vx !== 0 || pose.vy !== 0;
				const tied = Math.abs(error - best.error) <= 0.01;
				// Stops and retraced sections can map to multiple times.
				const ambiguous = !moving || (tied && (!best.identifiable || Math.abs(best.ms - projectedMs) > 1));
				const nearerNominal = Math.abs(ms - projectedMs - nominalMs) < Math.abs(ms - best.ms - nominalMs);
				if (error < best.error - 0.01 || (tied && (!moving && best.identifiable || nearerNominal))) {
					best = { ms: projectedMs, error, identifiable: tied ? !ambiguous : moving };
				} else if (tied && ambiguous) {
					best.identifiable = false;
				}
			}
		}
		return best;
	}
}
