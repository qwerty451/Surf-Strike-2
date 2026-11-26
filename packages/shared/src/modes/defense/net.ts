/**
 * BIN_DEFENSE (type 5): compact zombie and turret snapshot, S→C at the
 * snapshot rate on Zombie Defense maps (docs/architecture.md#protocol-sketch).
 *
 *   u8 5, u8 version (1), u32 sim tick, u8 zombie count, u8 turret count,
 *   then per zombie (12 bytes):
 *     u16 id, i16 x·2, i16 y·2, i16 z·2 (half-unit precision, ±16383 units),
 *     u8 yaw (·256/360), u8 flags (ZDF_*), u8 hp (0..255 = fraction of full),
 *     u8 kind (index in ZD_KINDS)
 *   then per built turret (6 bytes):
 *     u8 pad index, u8 yaw (·256/360), i8 pitch (degrees, ±90),
 *     u8 flags (ZDT_*), u16 target zombie id (0 = none)
 *
 * Turret type and level are in the mode state (`pads`), not here.
 */
import { ZD_KINDS, type ZdZombieKind } from './rules.ts';

export const BIN_DEFENSE = 5;
export const DEFENSE_VERSION = 1;
const HEAD = 8;
const ZENTRY = 12;
const TENTRY = 6;

/** Zombie flags. The first four match Zombie Run's ZF_*. */
export const ZDF_ATTACKING = 1;
export const ZDF_HIT = 2;
export const ZDF_SLOWED = 4;
export const ZDF_ON_GROUND = 8;
/** Tearing a plank off (or, the boss, winding up to smash the barricade). */
export const ZDF_TEARING = 16;
/** In a frost turret's field. */
export const ZDF_FROSTED = 32;
/** Inside the base (came through an opening). */
export const ZDF_INSIDE = 64;

/** Turret flags: fired in the last ZD_FIRE_FLAG_TICKS sim ticks (draw a muzzle flash / tracer to `target`). */
export const ZDT_FIRED = 1;
/** Has a target in range. */
export const ZDT_ACTIVE = 2;
/** Sim ticks a shot keeps ZDT_FIRED set: two 64 Hz ticks cover one 32 Hz snapshot. */
export const ZD_FIRE_FLAG_TICKS = 2;

export interface ZdZombieNet {
	id: number;
	x: number;
	y: number;
	z: number;
	/** Degrees, -180..180. */
	yaw: number;
	flags: number;
	/** 0..1 of full health. */
	hp: number;
	kind: ZdZombieKind;
}

export interface ZdTurretNet {
	pad: number;
	/** Degrees, -180..180. */
	yaw: number;
	/** Degrees, positive up. */
	pitch: number;
	flags: number;
	/** Zombie id, 0 = none. */
	target: number;
}

export interface DefenseFrame {
	tick: number;
	zombies: ZdZombieNet[];
	turrets: ZdTurretNet[];
}

const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 2)));
const yawByte = (yaw: number) => Math.round((((yaw % 360) + 360) % 360) * (256 / 360)) & 0xff;
const byteYaw = (b: number) => {
	const y = (b * 360) / 256;
	return y > 180 ? y - 360 : y;
};

export function encodeDefense(tick: number, zombies: readonly ZdZombieNet[], turrets: readonly ZdTurretNet[]): Uint8Array {
	const nz = Math.min(255, zombies.length);
	const nt = Math.min(255, turrets.length);
	const buf = new Uint8Array(HEAD + nz * ZENTRY + nt * TENTRY);
	const v = new DataView(buf.buffer);
	v.setUint8(0, BIN_DEFENSE);
	v.setUint8(1, DEFENSE_VERSION);
	v.setUint32(2, tick >>> 0, true);
	v.setUint8(6, nz);
	v.setUint8(7, nt);
	let o = HEAD;
	for (let i = 0; i < nz; i++) {
		const z = zombies[i]!;
		v.setUint16(o, z.id & 0xffff, true);
		v.setInt16(o + 2, clampI16(z.x), true);
		v.setInt16(o + 4, clampI16(z.y), true);
		v.setInt16(o + 6, clampI16(z.z), true);
		v.setUint8(o + 8, yawByte(z.yaw));
		v.setUint8(o + 9, z.flags & 0xff);
		v.setUint8(o + 10, Math.max(0, Math.min(255, Math.round(z.hp * 255))));
		v.setUint8(o + 11, Math.max(0, ZD_KINDS.indexOf(z.kind)));
		o += ZENTRY;
	}
	for (let i = 0; i < nt; i++) {
		const t = turrets[i]!;
		v.setUint8(o, t.pad & 0xff);
		v.setUint8(o + 1, yawByte(t.yaw));
		v.setInt8(o + 2, Math.max(-90, Math.min(90, Math.round(t.pitch))));
		v.setUint8(o + 3, t.flags & 0xff);
		v.setUint16(o + 4, t.target & 0xffff, true);
		o += TENTRY;
	}
	return buf;
}

export function decodeDefense(data: ArrayBuffer | Uint8Array): DefenseFrame | null {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	if (bytes.byteLength < HEAD) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getUint8(0) !== BIN_DEFENSE || v.getUint8(1) !== DEFENSE_VERSION) return null;
	const nz = v.getUint8(6);
	const nt = v.getUint8(7);
	if (bytes.byteLength !== HEAD + nz * ZENTRY + nt * TENTRY) return null;
	const zombies: ZdZombieNet[] = [];
	let o = HEAD;
	for (let i = 0; i < nz; i++) {
		zombies.push({
			id: v.getUint16(o, true),
			x: v.getInt16(o + 2, true) / 2,
			y: v.getInt16(o + 4, true) / 2,
			z: v.getInt16(o + 6, true) / 2,
			yaw: byteYaw(v.getUint8(o + 8)),
			flags: v.getUint8(o + 9),
			hp: v.getUint8(o + 10) / 255,
			kind: ZD_KINDS[v.getUint8(o + 11)] ?? 'walker'
		});
		o += ZENTRY;
	}
	const turrets: ZdTurretNet[] = [];
	for (let i = 0; i < nt; i++) {
		turrets.push({
			pad: v.getUint8(o),
			yaw: byteYaw(v.getUint8(o + 1)),
			pitch: v.getInt8(o + 2),
			flags: v.getUint8(o + 3),
			target: v.getUint16(o + 4, true)
		});
		o += TENTRY;
	}
	return { tick: v.getUint32(2, true), zombies, turrets };
}
