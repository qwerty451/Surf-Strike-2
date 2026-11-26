/**
 * Lag compensation for infected (docs/architecture.md#netcode): a ring of
 * recent poses per player, and how far back a live shooter's screen is.
 *
 * A client draws the other players INTERP_DELAY_MS in the past, interpolated
 * between the snapshots it received. A snapshot is half a round trip old when
 * it arrives and the fire message takes the other half back, so the pose the
 * shooter aimed at is ping + INTERP_DELAY_MS old when the shot reaches the
 * server, plus INF_REWIND_ALLOWANCE_MS.
 */
import { INTERP_DELAY_MS, SNAPSHOT_HZ } from '../../protocol.ts';
import { copyMotion, lerpMotion, restMotion, type PlayerMotion } from '../../body-motion.ts';
import type { PlayerPose } from '../zombies/hitbox.ts';

/** Lag compensation history of player poses. */
export const INF_HISTORY_MS = 400;

/**
 * Extra rewind on top of ping + INTERP_DELAY_MS: half a snapshot interval
 * (15.6 ms). It covers the frame between seeing and firing: the shooter aims
 * at the last frame drawn, and the fire message leaves from the simulation
 * tick at the start of the next frame (16.7 ms later at 60 fps). What is
 * left is not one-sided: a snapshot relays the last state packet the server
 * had when it was sent, the history holds the one it had at each game
 * update, and the two are not in step, so the seen pose and the stored one
 * can be up to one state packet (15.6 ms) apart either way. At 265 u/s the
 * allowance is 4 units, inside the thinnest hit shape of the legs (a shin:
 * 5 units either side of its middle).
 */
export const INF_REWIND_ALLOWANCE_MS = 1000 / SNAPSHOT_HZ / 2;

/**
 * Age (ms) of the poses on a live shooter's screen when their shot or swing
 * reaches the server: round-trip `pingMs` + INTERP_DELAY_MS +
 * INF_REWIND_ALLOWANCE_MS, clamped to the history.
 */
export function infRewindMs(pingMs: number): number {
	const ping = Number.isFinite(pingMs) && pingMs > 0 ? pingMs : 0;
	return Math.min(INF_HISTORY_MS, ping + INTERP_DELAY_MS + INF_REWIND_ALLOWANCE_MS);
}

/** Jumps larger than this are not interpolated (like the client's SnapshotBuffer.snapDistance). */
const SNAP_DISTANCE = 1024;

interface PoseSample extends PlayerPose {
	/** Time the pose was recorded (ms, the clock of `InfectedGame.update`). */
	at: number;
	/** First sim tick covered by this observation. */
	tick: number;
}

/** The motion of `out`, which keeps its own object: from `a`, `f` of the way to `b`. A pose without a motion has none. */
function motionTo(a: PlayerMotion | undefined, b: PlayerMotion | undefined, f: number, out: PlayerPose): void {
	if (!a || !b) {
		out.motion = undefined;
		return;
	}
	out.motion ??= restMotion();
	if (f <= 0) copyMotion(a, out.motion);
	else lerpMotion(a, b, f, out.motion);
}

/**
 * `out` = the pose `f` (0..1) of the way from `a` to `b`. The view pitch and
 * the motion are interpolated like the position (the client does the same, net/interp.ts);
 * ducked, posture and the held item come from the nearer one.
 */
function lerpPose(a: PlayerPose, b: PlayerPose, f: number, out: PlayerPose): void {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const dz = b.z - a.z;
	if (dx * dx + dy * dy + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE) f = 1;
	let dyaw = (b.yaw - a.yaw) % 360;
	if (dyaw > 180) dyaw -= 360;
	else if (dyaw < -180) dyaw += 360;
	const near = f < 0.5 ? a : b;
	out.x = a.x + dx * f;
	out.y = a.y + dy * f;
	out.z = a.z + dz * f;
	out.yaw = a.yaw + dyaw * f;
	out.ducked = near.ducked;
	out.hunched = near.hunched;
	out.held = near.held;
	// A pose without a pitch (level) stays without one.
	const pitch = a.pitch ?? 0;
	out.pitch = a.pitch === undefined && b.pitch === undefined ? undefined : pitch + ((b.pitch ?? 0) - pitch) * f;
	motionTo(a.motion, b.motion, f, out);
}

function copyPose(from: PlayerPose, out: PlayerPose): void {
	out.x = from.x;
	out.y = from.y;
	out.z = from.z;
	out.yaw = from.yaw;
	out.ducked = from.ducked;
	out.hunched = from.hunched;
	out.held = from.held;
	out.pitch = from.pitch;
	motionTo(from.motion, from.motion, 0, out);
}

/**
 * Recent poses of one player, oldest first, in a fixed ring (recording
 * allocates nothing). Cleared on every (re)spawn and teleport, so a lookup can
 * never return a pose from before it.
 */
export class PoseHistory {
	private readonly buf: PoseSample[] = [];
	private start = 0;
	private count = 0;

	constructor(private readonly capacity: number) {
		for (let i = 0; i < capacity; i++) this.buf.push({ at: 0, tick: 0, x: 0, y: 0, z: 0, yaw: 0, ducked: false, hunched: false });
	}

	get size(): number {
		return this.count;
	}

	clear(): void {
		this.start = 0;
		this.count = 0;
	}

	/** Append the pose at time `at`, covering `tick` through the next observation’s first tick (exclusive). */
	record(at: number, tick: number, pose: PlayerPose): void {
		let i: number;
		if (this.count < this.capacity) i = (this.start + this.count++) % this.capacity;
		else {
			i = this.start;
			this.start = (this.start + 1) % this.capacity;
		}
		const s = this.buf[i]!;
		s.at = at;
		s.tick = tick;
		copyPose(pose, s);
	}

	private get(i: number): PoseSample {
		return this.buf[(this.start + i) % this.capacity]!;
	}

	/**
	 * The pose at time `at` into `out`: interpolated between the two samples
	 * around it; the oldest sample when `at` is older; between the newest sample
	 * and `cur` (the pose at `now`) when it is newer. Without samples: `cur`.
	 */
	poseAt(at: number, now: number, cur: PlayerPose, out: PlayerPose): void {
		const n = this.count;
		if (n === 0) return copyPose(cur, out);
		const oldest = this.get(0);
		if (at <= oldest.at) return copyPose(oldest, out);
		// Newest sample at or before `at` (the wanted time is usually near the end).
		let i = n - 1;
		while (i > 0 && this.get(i).at > at) i--;
		const a = this.get(i);
		if (i === n - 1) {
			if (now <= a.at || at >= now) return copyPose(cur, out);
			return lerpPose(a, cur, (at - a.at) / (now - a.at), out);
		}
		const b = this.get(i + 1);
		lerpPose(a, b, (at - a.at) / (b.at - a.at), out);
	}

	/**
	 * The pose recorded in sim tick `tick` into `out` (the newest sample at or
	 * before it); the oldest sample when `tick` is older. Without samples: `cur`.
	 */
	poseAtTick(tick: number, cur: PlayerPose, out: PlayerPose): void {
		const n = this.count;
		if (n === 0) return copyPose(cur, out);
		let i = n - 1;
		while (i > 0 && this.get(i).tick > tick) i--;
		copyPose(this.get(i), out);
	}
}
