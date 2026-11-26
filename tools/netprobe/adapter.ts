import type { CollisionWorld } from '@surf/shared';
import { decodeSnapshot, encodeState, INTERP_DELAY_MS, type NetState, type SnapshotEntry } from './wire-v1.ts';
import { emptySample, SnapshotBuffer } from './interp-v1.ts';
import type { Point } from './path.ts';
import type { ClockPong, Welcome } from './session.ts';

export interface Rendered {
	point: Point | null;
	delayMs: number;
	underrun: boolean;
}

export interface Observer {
	beginFrame?(nowMs: number, dtMs: number, world?: CollisionWorld): void;
	timingMessage?(message: Welcome | ClockPong, arrivalMs: number): void;
	snapshot(data: ArrayBuffer, arrivalMs: number): boolean;
	render(id: number, nowMs: number): Rendered;
	clear(): void;
}

export interface Adapter {
	encode(state: NetState, teleportCount: number): ArrayBuffer;
	observer(botIds: ReadonlySet<number>): Observer;
}

export function arrivalObserver(
	botIds: ReadonlySet<number>,
	decode: (data: ArrayBuffer) => SnapshotEntry[] | null = decodeSnapshot
): Observer {
	const buffers = new Map<number, SnapshotBuffer>();
	const pose = emptySample();
	return {
		snapshot(data, arrivalMs) {
			const entries = decode(data);
			if (!entries) return false;
			for (const entry of entries) {
				if (!botIds.has(entry.id)) continue;
				let buffer = buffers.get(entry.id);
				if (!buffer) buffers.set(entry.id, (buffer = new SnapshotBuffer()));
				buffer.push(entry, arrivalMs);
			}
			return true;
		},
		render(id, nowMs) {
			const buffer = buffers.get(id);
			const target = nowMs - INTERP_DELAY_MS;
			const underrun = !buffer || target > buffer.lastArrival;
			const visible = buffer && nowMs - buffer.lastArrival < 3000 && buffer.sample(target, pose);
			const point = visible ? { x: pose.x, y: pose.y, z: pose.z } : null;
			return { point, delayMs: INTERP_DELAY_MS, underrun };
		},
		clear() {
			buffers.clear();
		}
	};
}

const v1: Adapter = { encode: encodeState, observer: arrivalObserver };

export async function adapterFor(version: number): Promise<Adapter> {
	if (version === 1) return v1;
	if (version !== 2 && version !== 3) throw new Error(`Unsupported server protocol v${version}`);
	const { loadV2Adapter } = await import('./adapter-v2.ts');
	return loadV2Adapter();
}
