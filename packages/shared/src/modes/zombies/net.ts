/**
 * BIN_ZOMBIES (type 4): compact zombie snapshot, S→C at the snapshot rate on
 * zombies maps (docs/architecture.md#protocol-sketch).
 *
 *   u8 4, u8 version (2), u32 sim tick, u8 count, f64 server time, then per zombie (11 bytes):
 *   u16 id, i16 x·2, i16 y·2, i16 z·2 (half-unit precision, ±16383 units),
 *   u8 yaw (·256/360), u8 flags (ZF_*), u8 hp (0..255 = fraction of full)
 */
export const BIN_ZOMBIES = 4;
export const ZOMBIES_VERSION = 2;
const HEAD = 15;
const ENTRY = 11;

export interface ZombieNet {
	id: number;
	x: number;
	y: number;
	z: number;
	/** Degrees, -180..180. */
	yaw: number;
	flags: number;
	/** 0..1 of full health. */
	hp: number;
}

export interface ZombieFrame {
	tick: number;
	serverTimeMs?: number;
	zombies: ZombieNet[];
}

const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 2)));

export function encodeZombies(tick: number, zombies: readonly ZombieNet[], serverTimeMs?: number): Uint8Array {
	const n = Math.min(255, zombies.length);
	const buf = new Uint8Array(HEAD + n * ENTRY);
	const v = new DataView(buf.buffer);
	v.setUint8(0, BIN_ZOMBIES);
	v.setUint8(1, ZOMBIES_VERSION);
	v.setUint32(2, tick >>> 0, true);
	v.setUint8(6, n);
	v.setFloat64(7, serverTimeMs ?? NaN, true);
	let o = HEAD;
	for (let i = 0; i < n; i++) {
		const z = zombies[i]!;
		v.setUint16(o, z.id & 0xffff, true);
		v.setInt16(o + 2, clampI16(z.x), true);
		v.setInt16(o + 4, clampI16(z.y), true);
		v.setInt16(o + 6, clampI16(z.z), true);
		v.setUint8(o + 8, Math.round((((z.yaw % 360) + 360) % 360) * (256 / 360)) & 0xff);
		v.setUint8(o + 9, z.flags & 0xff);
		v.setUint8(o + 10, Math.max(0, Math.min(255, Math.round(z.hp * 255))));
		o += ENTRY;
	}
	return buf;
}

export function decodeZombies(data: ArrayBuffer | Uint8Array): ZombieFrame | null {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	if (bytes.byteLength < HEAD) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (v.getUint8(0) !== BIN_ZOMBIES || v.getUint8(1) !== ZOMBIES_VERSION) return null;
	const n = v.getUint8(6);
	if (bytes.byteLength !== HEAD + n * ENTRY) return null;
	const zombies: ZombieNet[] = [];
	let o = HEAD;
	for (let i = 0; i < n; i++) {
		let yaw = (v.getUint8(o + 8) * 360) / 256;
		if (yaw > 180) yaw -= 360;
		zombies.push({
			id: v.getUint16(o, true),
			x: v.getInt16(o + 2, true) / 2,
			y: v.getInt16(o + 4, true) / 2,
			z: v.getInt16(o + 6, true) / 2,
			yaw,
			flags: v.getUint8(o + 9),
			hp: v.getUint8(o + 10) / 255
		});
		o += ENTRY;
	}
	const serverTimeMs = v.getFloat64(7, true);
	return { tick: v.getUint32(2, true), ...(Number.isFinite(serverTimeMs) ? { serverTimeMs } : {}), zombies };
}
