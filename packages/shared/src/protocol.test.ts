import { describe, expect, it } from 'vitest';
import {
	BIN_SNAPSHOT,
	BIN_STATE,
	decodeSnapshot,
	decodeState,
	encodeSnapshot,
	encodeState,
	FLAG_DUCKED,
	FLAG_ON_GROUND,
	FLAG_TELEPORTED,
	MAX_PLAYERS,
	PROTOCOL_VERSION,
	SNAP_POS_MAX,
	SNAP_POS_MIN,
	SNAP_RUN_TICKS_MAX,
	SNAP_VEL_MAX,
	SNAP_VEL_MIN,
	SNAPSHOT_ENTRY_BASE,
	SNAPSHOT_ENTRY_RACE,
	SNAPSHOT_HEADER_SIZE,
	STATE_SIZE,
	Status,
	teleportSeq,
	withTeleportSeq,
	type NetState,
	type SnapshotEntry
} from './protocol.ts';

function makeEntry(id: number, extra: Partial<NetState> = {}): SnapshotEntry {
	return {
		id,
		tick: 12345,
		x: 100.25,
		y: -250.5,
		z: 64.125,
		vx: 512,
		vy: -320,
		vz: 120,
		pitch: -12.5,
		yaw: 135,
		flags: FLAG_ON_GROUND,
		status: Status.Alive,
		stage: 0,
		runTicks: 0,
		...extra
	};
}

describe('protocol binary codec', () => {
	it('advertises protocol version 3', () => {
		expect(PROTOCOL_VERSION).toBe(3);
	});

	it('packs and unpacks the 8-bit wrapping teleport counter without disturbing other flag bits', () => {
		const base = FLAG_DUCKED | FLAG_ON_GROUND | FLAG_TELEPORTED;
		for (let seq = 0; seq < 260; seq++) {
			const packed = withTeleportSeq(base, seq);
			expect(teleportSeq(packed)).toBe(seq & 0xff);
			expect(packed & FLAG_DUCKED).toBe(FLAG_DUCKED);
			expect(packed & FLAG_ON_GROUND).toBe(FLAG_ON_GROUND);
			expect(packed & FLAG_TELEPORTED).toBe(FLAG_TELEPORTED);
		}
	});

	it('round-trips BIN_STATE with full float32 precision and non-zero Uint8Array offset', () => {
		const s: NetState = {
			tick: 987654,
			x: 48992.375,
			y: -41792.625,
			z: 25056.125,
			vx: 3499.75,
			vy: -1234.5,
			vz: 500.25,
			pitch: -88.75,
			yaw: 179.5,
			flags: withTeleportSeq(FLAG_DUCKED | FLAG_TELEPORTED, 203),
			spawnSeq: 40512,
			status: Status.Running,
			stage: 6,
			runTicks: 44123
		};
		const ab = encodeState(s);
		expect(ab.byteLength).toBe(STATE_SIZE);
		expect(decodeState(ab)).toEqual(s);

		// Slice inside a larger buffer to verify byteOffset handling (zero-copy server ingest).
		const padded = new Uint8Array(STATE_SIZE + 12);
		padded.set(new Uint8Array(ab), 5);
		const view = padded.subarray(5, 5 + STATE_SIZE);
		expect(decodeState(view)).toEqual(s);

		// Reject bad length, bad tag, or non-finite floats.
		expect(decodeState(ab.slice(0, STATE_SIZE - 1))).toBeNull();
		const badTag = new Uint8Array(ab.slice(0));
		badTag[0] = BIN_SNAPSHOT;
		expect(decodeState(badTag)).toBeNull();
		const nanBuf = ab.slice(0);
		new DataView(nanBuf).setFloat32(5, Number.NaN, true);
		expect(decodeState(nanBuf)).toBeNull();
	});

	it('extends combat states with a render timestamp and accepts the original state size', () => {
		const { id: _id, ...state } = makeEntry(1);
		const renderServerTimeMs = 2_000_000_000.125;
		const timed = encodeState({ ...state, renderServerTimeMs });
		expect(timed.byteLength).toBe(STATE_SIZE + 8);
		expect(decodeState(timed)).toEqual({ ...state, renderServerTimeMs });
		expect(decodeState(timed.slice(0, STATE_SIZE))).toEqual(state);
		new DataView(timed).setFloat64(STATE_SIZE, Infinity, true);
		expect(decodeState(timed)).toEqual(state);
	});

	it('round-trips BIN_SNAPSHOT v2 with serverTimeMs, sequence number, and quantized fields', () => {
		const entries: SnapshotEntry[] = [
			makeEntry(1, {
				x: 48992.125,
				y: -41792.875,
				z: 25056.5,
				vx: 16384,
				vy: -16384,
				vz: 900,
				pitch: -89,
				yaw: -179.5,
				flags: withTeleportSeq(FLAG_DUCKED | FLAG_ON_GROUND, 2),
				status: Status.Running,
				stage: 4,
				runTicks: 900_000
			}),
			makeEntry(32, {
				x: -24000,
				y: 28466.25,
				z: -6448.125,
				vx: 0,
				vy: 0,
				vz: 0,
				pitch: 0,
				yaw: 90,
				flags: withTeleportSeq(0, 1),
				status: Status.Infected,
				stage: 0,
				runTicks: 0
			})
		];
		const ab = encodeSnapshot(entries, 123456.25, 65535);
		expect(ab.byteLength).toBe(SNAPSHOT_HEADER_SIZE + 2 * SNAPSHOT_ENTRY_RACE);
		const dec = decodeSnapshot(ab)!;
		expect(dec).not.toBeNull();
		expect(dec.seq).toBe(65535);
		expect(dec.serverTimeMs).toBe(123456.25);
		expect(dec.entries.length).toBe(2);

		const a = dec.entries[0]!;
		expect(a.id).toBe(1);
		expect(a.tick).toBe(12345);
		expect(a.x).toBe(48992.125);
		expect(a.y).toBe(-41792.875);
		expect(a.z).toBe(25056.5);
		expect(a.vx).toBe(16384);
		expect(a.vy).toBe(-16384);
		expect(a.vz).toBe(900);
		expect(Math.abs(a.pitch - -89)).toBeLessThan(0.01);
		expect(Math.abs(a.yaw - -179.5)).toBeLessThan(0.01);
		expect(teleportSeq(a.flags)).toBe(2);
		expect(a.flags & (FLAG_DUCKED | FLAG_ON_GROUND)).toBe(FLAG_DUCKED | FLAG_ON_GROUND);
		expect(a.status).toBe(Status.Running);
		expect(a.stage).toBe(4);
		expect(a.runTicks).toBe(900_000);

		const b = dec.entries[1]!;
		expect(b.id).toBe(32);
		expect(b.yaw).toBe(90);
		expect(b.status).toBe(Status.Infected);
		expect(teleportSeq(b.flags)).toBe(1);
	});

	it('fits 32 players inside a single <= 1150-byte datagram (both non-race and race)', () => {
		const combat = Array.from({ length: MAX_PLAYERS }, (_, i) => makeEntry(i + 1));
		const combatBuf = encodeSnapshot(combat, 5000, 1);
		expect(combatBuf.byteLength).toBe(SNAPSHOT_HEADER_SIZE + MAX_PLAYERS * SNAPSHOT_ENTRY_BASE);
		expect(combatBuf.byteLength).toBeLessThanOrEqual(1150);

		const race = Array.from({ length: MAX_PLAYERS }, (_, i) => makeEntry(i + 1, { stage: 2, runTicks: 1200 + i }));
		const raceBuf = encodeSnapshot(race, 5000, 2);
		expect(raceBuf.byteLength).toBe(SNAPSHOT_HEADER_SIZE + MAX_PLAYERS * SNAPSHOT_ENTRY_RACE);
		expect(raceBuf.byteLength).toBeLessThanOrEqual(1150);

		expect(decodeSnapshot(combatBuf)?.entries.length).toBe(MAX_PLAYERS);
		expect(decodeSnapshot(raceBuf)?.entries.length).toBe(MAX_PLAYERS);
	});

	it('preserves v3 sample times across relay frames and fits 32 players within 1150 bytes', () => {
		const combat = Array.from({ length: MAX_PLAYERS }, (_, i) => ({
			...makeEntry(i + 1),
			sampleTimeMs: 4990.125 + i,
			sourceIdle: i === 0
		}));
		const race = combat.map((e) => ({ ...e, stage: 2, runTicks: 1200 + e.id }));
		const combatBuf = encodeSnapshot(combat, 5000.01, 1);
		const raceBuf = encodeSnapshot(race, 5031.27, 2);
		expect(combatBuf.byteLength).toBe(1005);
		expect(raceBuf.byteLength).toBe(1133);
		const decodedCombat = decodeSnapshot(combatBuf)!.entries;
		const decodedRace = decodeSnapshot(raceBuf)!.entries;
		expect(decodedCombat.map((e) => e.sampleTimeMs)).toEqual(combat.map((e) => e.sampleTimeMs));
		expect(decodedRace.map((e) => e.sampleTimeMs)).toEqual(combat.map((e) => e.sampleTimeMs));
		expect(decodedCombat[0]).toMatchObject({ flags: FLAG_ON_GROUND, sourceIdle: true });
		expect(decodedRace.at(-1)).toMatchObject({ stage: 2, runTicks: 1232, sourceIdle: false });
	});

	it('clamps out-of-range coordinates, velocities and runTicks cleanly', () => {
		const extreme = makeEntry(7, {
			x: 5_000_000,
			y: -5_000_000,
			z: 0.0625,
			vx: 99_999,
			vy: -99_999,
			vz: 12.6,
			stage: 1,
			runTicks: 99_000_000
		});
		const dec = decodeSnapshot(encodeSnapshot([extreme], 42, 0x10005))!;
		expect(dec.seq).toBe(5); // 16-bit wrap
		const e = dec.entries[0]!;
		expect(e.x).toBe(SNAP_POS_MAX);
		expect(e.y).toBe(SNAP_POS_MIN);
		expect(e.vx).toBe(SNAP_VEL_MAX);
		expect(e.vy).toBe(SNAP_VEL_MIN);
		expect(e.vz).toBe(13);
		expect(e.runTicks).toBe(SNAP_RUN_TICKS_MAX);
	});

	it('rejects malformed or truncated snapshot buffers', () => {
		const ab = encodeSnapshot([makeEntry(1)], 100, 1);
		expect(decodeSnapshot(ab.slice(0, SNAPSHOT_HEADER_SIZE - 1))).toBeNull();
		expect(decodeSnapshot(ab.slice(0, ab.byteLength - 1))).toBeNull();
		const extra = new Uint8Array(ab.byteLength + 1);
		extra.set(new Uint8Array(ab));
		expect(decodeSnapshot(extra)).toBeNull();

		const badTag = new Uint8Array(ab.slice(0));
		badTag[0] = BIN_STATE;
		expect(decodeSnapshot(badTag)).toBeNull();

		const badFlags = new Uint8Array(ab.slice(0));
		badFlags[1] = 0xfe;
		expect(decodeSnapshot(badFlags)).toBeNull();

		const badTime = ab.slice(0);
		new DataView(badTime).setFloat64(5, Number.POSITIVE_INFINITY, true);
		expect(decodeSnapshot(badTime)).toBeNull();
	});
});
