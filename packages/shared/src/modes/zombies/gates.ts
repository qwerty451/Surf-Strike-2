/**
 * Zombies gates (MapDef.zombies.gates, docs/modes.md#zombies): a collision
 * world that adds the solid box of every closed gate to the map's static
 * world. The same wrapper runs on the server (zombies, hit traces) and on the
 * client (local movement), driven by the gate state in the mode state.
 */
import type { CollisionWorld, Trace } from '../../collision/api.ts';
import { buildCollisionWorld } from '../../collision/world.ts';
import type { ZombieGate } from '../../maps/types.ts';
import type { Vec3 } from '../../types.ts';

export type GateState = 'closed' | 'counting' | 'open';

export const ZM_GATE_COUNTDOWN_SECS = 30;

/** Unlock rule: at least half of the living survivors in the area (and at least one). */
export function unlockReached(inside: number, alive: number): boolean {
	return alive > 0 && inside > 0 && inside * 2 >= alive;
}

/** Depth of a gate's far side, for `gateFarSide`. */
const FAR_DEPTH = 512;
/** Half the hull: past the gate means the whole hull is. */
const HULL_HALF = 16;

/**
 * Box behind a gate (seen along the route) that a player's origin is in right
 * after passing it. `heading`: route direction at the gate.
 */
export function gateFarSide(g: ZombieGate, heading: { x: number; y: number }): { min: Vec3; max: Vec3 } {
	const min = { x: g.min.x, y: g.min.y, z: g.min.z - 64 };
	const max = { x: g.max.x, y: g.max.y, z: g.max.z + 64 };
	const axis = g.max.x - g.min.x < g.max.y - g.min.y ? 'x' : 'y';
	if (heading[axis] >= 0) {
		min[axis] = g.max[axis] + HULL_HALF;
		max[axis] = min[axis] + FAR_DEPTH;
	} else {
		max[axis] = g.min[axis] - HULL_HALF;
		min[axis] = max[axis] - FAR_DEPTH;
	}
	return { min, max };
}

export interface GatedWorld extends CollisionWorld {
	/** Open flags by gate index (true = no collision). */
	readonly open: boolean[];
	setOpen(index: number, open: boolean): void;
}

/** `gates`: any solid boxes (Zombie Run gates, Zombie Defense barricades). */
export function gatedWorld(base: CollisionWorld, gates: readonly Pick<ZombieGate, 'min' | 'max'>[]): GatedWorld {
	const worlds = gates.map((g) => buildCollisionWorld({ brushes: [{ type: 'box', min: g.min, max: g.max, material: 'gate' }] }));
	const open = gates.map(() => false);
	function trace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3): Trace {
		let best = base.trace(start, end, mins, maxs);
		for (let i = 0; i < worlds.length; i++) {
			if (open[i]) continue;
			const g = gates[i]!;
			// Cheap reject: swept box far from the gate.
			if (
				Math.max(start.x, end.x) + maxs.x < g.min.x - 1 ||
				Math.min(start.x, end.x) + mins.x > g.max.x + 1 ||
				Math.max(start.y, end.y) + maxs.y < g.min.y - 1 ||
				Math.min(start.y, end.y) + mins.y > g.max.y + 1 ||
				Math.max(start.z, end.z) + maxs.z < g.min.z - 1 ||
				Math.min(start.z, end.z) + mins.z > g.max.z + 1
			)
				continue;
			const t = worlds[i]!.trace(start, end, mins, maxs);
			if (t.startsolid || t.fraction < best.fraction) {
				best = {
					...(t.fraction < best.fraction ? t : best),
					startsolid: best.startsolid || t.startsolid,
					allsolid: best.allsolid || t.allsolid
				};
			}
		}
		return best;
	}
	return {
		solids: base.solids,
		trace,
		open,
		setOpen(i, v) {
			if (i >= 0 && i < open.length) open[i] = v;
		}
	};
}
