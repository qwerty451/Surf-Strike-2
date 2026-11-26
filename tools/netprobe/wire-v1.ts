// Movement wire format from a64f384 packages/shared/src/protocol.ts.
export const INTERP_DELAY_MS = 100;

export const BIN_STATE = 1;
export const BIN_SNAPSHOT = 2;
export interface NetState {
	tick: number;
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	pitch: number;
	yaw: number;
	flags: number;
	status: number;
	stage: number;
	runTicks: number;
}

const STATE_BODY = 4 + 4 * 8 + 1 + 1 + 1 + 4; // 43
export const STATE_SIZE = 1 + STATE_BODY;

function writeBody(v: DataView, o: number, s: NetState): number {
	v.setUint32(o, s.tick >>> 0, true);
	o += 4;
	for (const n of [s.x, s.y, s.z, s.vx, s.vy, s.vz, s.pitch, s.yaw]) {
		v.setFloat32(o, n, true);
		o += 4;
	}
	v.setUint8(o++, s.flags);
	v.setUint8(o++, s.status);
	v.setUint8(o++, s.stage);
	v.setUint32(o, s.runTicks >>> 0, true);
	return o + 4;
}

function readBody(v: DataView, o: number): NetState {
	const f = (i: number) => v.getFloat32(o + 4 + i * 4, true);
	return {
		tick: v.getUint32(o, true),
		x: f(0),
		y: f(1),
		z: f(2),
		vx: f(3),
		vy: f(4),
		vz: f(5),
		pitch: f(6),
		yaw: f(7),
		flags: v.getUint8(o + 36),
		status: v.getUint8(o + 37),
		stage: v.getUint8(o + 38),
		runTicks: v.getUint32(o + 39, true)
	};
}

export function encodeState(s: NetState): ArrayBuffer {
	const buf = new ArrayBuffer(STATE_SIZE);
	const v = new DataView(buf);
	v.setUint8(0, BIN_STATE);
	writeBody(v, 1, s);
	return buf;
}

export function decodeState(buf: ArrayBuffer): NetState | null {
	if (buf.byteLength !== STATE_SIZE) return null;
	const v = new DataView(buf);
	if (v.getUint8(0) !== BIN_STATE) return null;
	const s = readBody(v, 1);
	for (const n of [s.x, s.y, s.z, s.vx, s.vy, s.vz, s.pitch, s.yaw]) if (!Number.isFinite(n)) return null;
	return s;
}

export interface SnapshotEntry extends NetState {
	id: number;
}

export function encodeSnapshot(entries: SnapshotEntry[]): ArrayBuffer {
	const buf = new ArrayBuffer(2 + entries.length * (2 + STATE_BODY));
	const v = new DataView(buf);
	v.setUint8(0, BIN_SNAPSHOT);
	v.setUint8(1, entries.length);
	let o = 2;
	for (const e of entries) {
		v.setUint16(o, e.id, true);
		o = writeBody(v, o + 2, e);
	}
	return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): SnapshotEntry[] | null {
	const v = new DataView(buf);
	if (buf.byteLength < 2 || v.getUint8(0) !== BIN_SNAPSHOT) return null;
	const n = v.getUint8(1);
	if (buf.byteLength !== 2 + n * (2 + STATE_BODY)) return null;
	const out: SnapshotEntry[] = [];
	let o = 2;
	for (let i = 0; i < n; i++) {
		const id = v.getUint16(o, true);
		out.push({ id, ...readBody(v, o + 2) });
		o += 2 + STATE_BODY;
	}
	return out;
}
