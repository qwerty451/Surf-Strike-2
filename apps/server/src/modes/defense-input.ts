/**
 * Zombie Defense client messages (docs/modes.md#zombie-defense): `fire`,
 * `reload` and `zd` (ready, repair, weapon, buy, pad). Every field is checked
 * here before the mode uses it. A message with a field of the wrong type or
 * out of range is dropped whole; the result holds fresh copies, so nothing
 * else a client put in its JSON reaches the game or other clients. The rules
 * themselves (phase, gold, ownership, distance to a pad) stay in `DefenseGame`.
 */
import { isWeaponId, isZdTurretType, isZdWeapon, type Vec3, type WeaponId, type ZdAction } from '@surf/shared';

export type ZdInput =
	| { type: 'fire'; weapon: WeaponId; origin: Vec3; dir: Vec3; tick: number }
	| { type: 'reload' }
	| { type: 'zd'; act: ZdAction };

/** No map reaches this far from the origin. */
const MAX_COORD = 1e6;
/** A direction is about unit length (the game checks 0.9..1.1). */
const MAX_DIR = 2;
/** Shop item ids are short ("reinforce:<opening id>"). */
const MAX_ITEM = 64;
const MAX_PAD = 255;

function vec(v: unknown, max: number): Vec3 | null {
	if (typeof v !== 'object' || v === null) return null;
	const { x, y, z } = v as Record<string, unknown>;
	if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
	if (!(Math.abs(x) <= max && Math.abs(y) <= max && Math.abs(z) <= max)) return null;
	return { x, y, z };
}

function action(v: unknown): ZdAction | null {
	if (typeof v !== 'object' || v === null) return null;
	const m = v as Record<string, unknown>;
	switch (m.a) {
		case 'ready':
			return { a: 'ready' };
		case 'repair':
			return typeof m.on === 'boolean' ? { a: 'repair', on: m.on } : null;
		case 'weapon':
			return isZdWeapon(m.weapon) ? { a: 'weapon', weapon: m.weapon } : null;
		case 'buy':
			return typeof m.item === 'string' && m.item.length > 0 && m.item.length <= MAX_ITEM ? { a: 'buy', item: m.item } : null;
		case 'pad': {
			const pad = m.pad;
			if (typeof pad !== 'number' || !Number.isInteger(pad) || pad < 0 || pad > MAX_PAD) return null;
			if (m.op === 'upgrade' || m.op === 'sell') return m.turret === undefined ? { a: 'pad', pad, op: m.op } : null;
			if (m.op === 'build') return isZdTurretType(m.turret) ? { a: 'pad', pad, op: 'build', turret: m.turret } : null;
			return null;
		}
		default:
			return null;
	}
}

/** The checked message, or null when it is not a well-formed Zombie Defense message. */
export function parseZdInput(msg: unknown): ZdInput | null {
	if (typeof msg !== 'object' || msg === null) return null;
	const m = msg as Record<string, unknown>;
	switch (m.type) {
		case 'fire': {
			const origin = vec(m.origin, MAX_COORD);
			const dir = vec(m.dir, MAX_DIR);
			const t = m.tick;
			if (!isWeaponId(m.weapon) || !origin || !dir || typeof t !== 'number' || !Number.isFinite(t)) return null;
			return { type: 'fire', weapon: m.weapon, origin, dir, tick: t };
		}
		case 'reload':
			return { type: 'reload' };
		case 'zd': {
			const act = action(m.act);
			return act ? { type: 'zd', act } : null;
		}
		default:
			return null;
	}
}
