import { buildCollisionWorld, decodeSnapshot, getMap, type MapDef } from '@surf/shared';
import { arrivalObserver, type Observer } from './adapter.ts';
import { loadV2Adapter } from './adapter-v2.ts';
import { SnapshotBuffer } from '../../apps/web/src/lib/net/interp.ts';
import { PreviousDelay } from './adaptive-before.ts';
import { ObserverMetrics, type MetricsSummary, type TruthPath } from './metrics.ts';
import { BotPath } from './path.ts';
import type { ClockPong, Welcome } from './session.ts';

export type TraceEvent =
	| [at: number, kind: 'snapshot', data: string]
	| [at: number, kind: 'timing', message: Welcome | ClockPong]
	| [at: number, kind: 'frame', fps: number, dt: number]
	| [at: number, kind: 'clear', map?: string];

export interface ProbeTrace {
	schema: 1;
	protocol: number;
	start: number;
	measuredStart: number;
	measuredEnd: number;
	botIds: number[];
	fps: number[];
	events: TraceEvent[];
}

interface ReplayOptions {
	truth?: ReadonlyMap<number, TruthPath>;
	/** Supply the map for custom scenarios outside the shipped rotation. */
	map?: MapDef;
	controllers?: Record<string, (botIds: ReadonlySet<number>) => Observer>;
}

/** Replay the actual callbacks in order, including frames skipped by the real probe. */
export function replayProbe(
	trace: ProbeTrace,
	options: ReplayOptions = {}
): { fps: number; controllers: Record<string, MetricsSummary> }[] {
	if (trace?.schema !== 1 || !Array.isArray(trace.events) || !Array.isArray(trace.botIds)
		|| !Array.isArray(trace.fps) || ![1, 2, 3].includes(trace.protocol)) {
		throw new Error('Expected a netprobe trace recorded with --trace');
	}
	const botIds = new Set(trace.botIds);
	const paths = options.truth ?? new Map(trace.botIds.map((id, i) => [id, new BotPath(i)]));
	const definitions: NonNullable<ReplayOptions['controllers']> = options.controllers ?? (trace.protocol === 1 ? {
		fixed: arrivalObserver
	} : {
		fixed: (ids) => arrivalObserver(ids, (data) => decodeSnapshot(data)?.entries ?? null),
		previous: (ids) => loadV2Adapter(() => new PreviousDelay(), () => {
			const buffer = new SnapshotBuffer();
			buffer.maxExtrapMs = 50;
			return buffer;
		}).observer(ids),
		tuned: (ids) => loadV2Adapter().observer(ids)
	});
	const worlds = new Map<string, ReturnType<typeof buildCollisionWorld>>();
	function worldFor(map: string) {
		if (trace.protocol === 1) return undefined;
		const cached = worlds.get(map);
		if (cached) return cached;
		const def = options.map?.id === map ? options.map : getMap(map);
		if (!def) throw new Error(`No collision map for ${map}`);
		const world = buildCollisionWorld(def);
		worlds.set(map, world);
		return world;
	}
	return trace.fps.map((fps) => {
		const observers = Object.entries(definitions).map(([name, create]) => ({
			name, observer: create(botIds),
			metrics: new ObserverMetrics(paths, trace.measuredStart - trace.start, trace.measuredEnd - trace.start)
		}));
		let world;
		for (const event of trace.events) {
			const [at, kind, value, dt] = event;
			if (kind === 'frame') {
				if (value !== fps) continue;
				for (const { observer, metrics } of observers) {
					observer.beginFrame?.(at, dt, world);
					if (at >= trace.measuredStart && at <= trace.measuredEnd) {
						metrics.frame(at - trace.start, (id) => observer.render(id, at));
					}
				}
			} else if (kind === 'snapshot') {
				const bytes = Uint8Array.from(Buffer.from(value, 'base64')).buffer;
				for (const { observer } of observers) {
					if (!observer.snapshot(bytes, at)) throw new Error(`Invalid snapshot at ${at} ms`);
				}
			} else if (kind === 'timing') {
				if (value.type === 'welcome') world = worldFor(value.map);
				for (const { observer } of observers) observer.timingMessage?.(value, at);
			} else {
				if (value) world = worldFor(value);
				else if (trace.protocol !== 1) throw new Error('Map change missing its collision map');
				for (const { observer } of observers) observer.clear();
			}
		}
		return { fps, controllers: Object.fromEntries(observers.map(({ name, metrics }) => [name, metrics.summary()])) };
	});
}
