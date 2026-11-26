/**
 * Infected client messages (docs/modes.md#infected): `fire`, `reload`,
 * `loadout`, `throwKnife`, `placeBeacon`, `callMoab`. Every field is checked
 * here before the mode uses it. A message with a field of the wrong type or
 * out of range is dropped whole; the result holds fresh copies, so nothing
 * else a client put in its JSON reaches the game or other clients. The rules
 * themselves (held weapon, aim origin, fire rate, team) stay in `InfectedGame`.
 */
import { INF_STEP_MS, isWeaponId, type Vec3, type WeaponId } from '@surf/shared';

export type InfInput =
	/** `tick`: the sim tick the shooter names (the mode clamps it with `clampFireTick`), or null for a live client (rewound by its ping). */
	| { type: 'fire'; weapon: WeaponId; origin: Vec3; dir: Vec3; tick: number | null; renderServerTimeMs?: unknown }
	| { type: 'reload' }
	| { type: 'loadout'; weapon: WeaponId }
	| { type: 'throwKnife'; origin: Vec3; dir: Vec3; renderServerTimeMs?: unknown }
	| { type: 'placeBeacon' }
	| { type: 'callMoab' };

/** Live clients send this as `fire.tick`: they have no sim tick to name. */
export const INF_FIRE_TICK_LIVE = 0x7fffffff;
/** A named tick may trail the shooter's rewind window by this many sim ticks (rounding of the window to ticks). */
export const INF_FIRE_TICK_SLACK = 1;

/**
 * The sim tick a `fire` that names `tick` is tested at: no newer than the
 * server's tick and no older than the poses a real client can have on screen,
 * `rewindMs` back (`infRewindMs` of the shooter's ping) plus
 * INF_FIRE_TICK_SLACK. A client cannot reach older poses of the history by
 * naming an old tick.
 */
export function clampFireTick(tick: number, serverTick: number, rewindMs: number): number {
	const oldest = serverTick - Math.ceil(Math.max(0, rewindMs) / INF_STEP_MS) - INF_FIRE_TICK_SLACK;
	return tick > serverTick ? serverTick : tick < oldest ? oldest : tick;
}

/** No map reaches this far from the origin. */
const MAX_COORD = 1e6;
/** A direction is about unit length (the game checks 0.9..1.1). */
const MAX_DIR = 2;

/** A fresh `{ x, y, z }` when all three are numbers within ±`max`, else null. */
function vec(v: unknown, max: number): Vec3 | null {
	if (typeof v !== 'object' || v === null) return null;
	const { x, y, z } = v as Record<string, unknown>;
	if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
	// NaN fails every comparison.
	if (!(Math.abs(x) <= max && Math.abs(y) <= max && Math.abs(z) <= max)) return null;
	return { x, y, z };
}

/** The checked message, or null when it is not a well-formed infected message. */
export function parseInfInput(msg: unknown): InfInput | null {
	if (typeof msg !== 'object' || msg === null) return null;
	const m = msg as Record<string, unknown>;
	switch (m.type) {
		case 'fire': {
			const origin = vec(m.origin, MAX_COORD);
			const dir = vec(m.dir, MAX_DIR);
			if (!isWeaponId(m.weapon) || !origin || !dir) return null;
			const t = m.tick;
			const tick = typeof t === 'number' && Number.isFinite(t) && t < INF_FIRE_TICK_LIVE ? t : null;
			return { type: 'fire', weapon: m.weapon, origin, dir, tick, ...(m.renderServerTimeMs === undefined ? {} : { renderServerTimeMs: m.renderServerTimeMs }) };
		}
		case 'loadout':
			return isWeaponId(m.weapon) ? { type: 'loadout', weapon: m.weapon } : null;
		case 'throwKnife': {
			const origin = vec(m.origin, MAX_COORD);
			const dir = vec(m.dir, MAX_DIR);
			return origin && dir ? { type: 'throwKnife', origin, dir, ...(m.renderServerTimeMs === undefined ? {} : { renderServerTimeMs: m.renderServerTimeMs }) } : null;
		}
		case 'reload':
		case 'placeBeacon':
		case 'callMoab':
			return { type: m.type };
		default:
			return null;
	}
}
