/**
 * Zombie hitboxes (docs/modes.md#zombies): a vertical cylinder for the body
 * and a sphere for the head, matching the hunched low-poly zombie the client
 * draws (head pushed forward along the zombie's yaw). Origins are feet
 * positions, Source axes (Z up), yaw in degrees.
 *
 * Players in infected use the pose-aware player hitboxes at the end of this
 * file instead (`rayPlayer`, `meleePlayer`, `sweepPlayer`).
 */
import { copyMotion, restMotion, type PlayerMotion } from '../../body-motion.ts';
import {
	armAngles,
	BODY_AIR_DRIFT,
	BODY_BALL,
	BODY_HIP_Z,
	bodyAngles,
	bodyGait,
	clawAngles,
	footPose,
	GRIP_RELAX_DROP,
	gripBobY,
	gripBobZ,
	gripRelax,
	legPose,
	newBodyAngles,
	newLegPose,
	shoulderRoll,
	shoulderYaw,
	type ArmAngles,
	type BodyAngles,
	type BodyExtras,
	type BodyPosture,
	type FootPose,
	type GaitShape
} from '../../body-pose.ts';
import type { Vec3 } from '../../types.ts';
import type { WeaponId } from './weapons.ts';

/** Body cylinder: radius and height range above the feet. */
export const ZOMBIE_BODY = { radius: 13, z0: 0, z1: 54 } as const;
/** Head sphere: forward offset along the yaw, height of its centre, radius. */
export const ZOMBIE_HEAD = { forward: 7.5, z: 65, radius: 7.5 } as const;

export interface HitboxPose {
	x: number;
	y: number;
	z: number;
	yaw: number;
}

export interface RayHit {
	/** Distance along the (unit) ray to the first hitbox surface. */
	t: number;
	head: boolean;
}

/** Ray (unit `d`) vs sphere; returns the entry distance >= 0, or -1. */
export function raySphere(o: Vec3, d: Vec3, cx: number, cy: number, cz: number, r: number): number {
	const ox = o.x - cx;
	const oy = o.y - cy;
	const oz = o.z - cz;
	const b = ox * d.x + oy * d.y + oz * d.z;
	const c = ox * ox + oy * oy + oz * oz - r * r;
	if (c > 0 && b > 0) return -1;
	const disc = b * b - c;
	if (disc < 0) return -1;
	const t = -b - Math.sqrt(disc);
	return t < 0 ? 0 : t;
}

/** Ray (unit `d`) vs capped vertical cylinder; returns the entry distance >= 0, or -1. */
export function rayCylinder(o: Vec3, d: Vec3, cx: number, cy: number, z0: number, z1: number, r: number): number {
	let tMin = -Infinity;
	let tMax = Infinity;
	// Side wall: |(o + d t) - c|_xy <= r.
	const ox = o.x - cx;
	const oy = o.y - cy;
	const a = d.x * d.x + d.y * d.y;
	const c = ox * ox + oy * oy - r * r;
	if (a < 1e-12) {
		if (c > 0) return -1;
	} else {
		const b = ox * d.x + oy * d.y;
		const disc = b * b - a * c;
		if (disc < 0) return -1;
		const s = Math.sqrt(disc);
		tMin = (-b - s) / a;
		tMax = (-b + s) / a;
	}
	// Caps: z0 <= o.z + d.z t <= z1.
	if (Math.abs(d.z) < 1e-12) {
		if (o.z < z0 || o.z > z1) return -1;
	} else {
		let ta = (z0 - o.z) / d.z;
		let tb = (z1 - o.z) / d.z;
		if (ta > tb) [ta, tb] = [tb, ta];
		if (ta > tMin) tMin = ta;
		if (tb < tMax) tMax = tb;
	}
	if (tMin > tMax || tMax < 0) return -1;
	return tMin < 0 ? 0 : tMin;
}

/** Head sphere centre of a pose. */
export function headCentre(p: HitboxPose): Vec3 {
	const r = (p.yaw * Math.PI) / 180;
	return { x: p.x + Math.cos(r) * ZOMBIE_HEAD.forward, y: p.y + Math.sin(r) * ZOMBIE_HEAD.forward, z: p.z + ZOMBIE_HEAD.z };
}

/**
 * First hitbox a ray hits within `maxT`. The head counts when the ray reaches
 * it before (or without) the body: a ray from below that passes the body
 * first is a body hit.
 */
export function rayZombie(o: Vec3, d: Vec3, p: HitboxPose, maxT: number): RayHit | null {
	const h = headCentre(p);
	const th = raySphere(o, d, h.x, h.y, h.z, ZOMBIE_HEAD.radius);
	const tb = rayCylinder(o, d, p.x, p.y, p.z + ZOMBIE_BODY.z0, p.z + ZOMBIE_BODY.z1, ZOMBIE_BODY.radius);
	const head = th >= 0 && th <= maxT && (tb < 0 || th <= tb);
	if (head) return { t: th, head: true };
	if (tb >= 0 && tb <= maxT) return { t: tb, head: false };
	return null;
}

/**
 * Melee check: the zombie's nearest point (body axis clamped to its height)
 * is within `reach` of the eye and inside the aim cone. Returns the distance
 * and whether the aim ray itself goes through the head, or null.
 */
export function meleeZombie(eye: Vec3, d: Vec3, p: HitboxPose, reach: number, coneDeg: number): RayHit | null {
	const zc = Math.max(p.z + ZOMBIE_BODY.z0, Math.min(p.z + ZOMBIE_BODY.z1, eye.z));
	const vx = p.x - eye.x;
	const vy = p.y - eye.y;
	const vz = zc - eye.z;
	const dist = Math.hypot(vx, vy, vz);
	const surface = Math.max(0, dist - ZOMBIE_BODY.radius);
	if (surface > reach) return null;
	if (dist > 1e-6) {
		const cos = (vx * d.x + vy * d.y + vz * d.z) / dist;
		// Very close zombies count even at the edge of the screen.
		const limit = Math.cos(((dist < ZOMBIE_BODY.radius * 2 ? coneDeg * 1.6 : coneDeg) * Math.PI) / 180);
		if (cos < limit) return null;
	}
	const ray = rayZombie(eye, d, p, reach + ZOMBIE_BODY.radius * 2);
	return { t: surface, head: ray?.head ?? false };
}

// ---------------------------------------------------------------------------
// Player hitboxes (docs/modes.md#infected)

/**
 * Player hitboxes: capsules on the bones of the character every client draws
 * (docs/characters.md). The server has no animator, so this is the short form
 * of it, from the same shared formulas (body-pose.ts): the same joints, the
 * same lean and hips, the same two-bone arm reach to the held item and the
 * same leg IK. It knows position, yaw, duck, posture (hunched for infected),
 * the held item, the view pitch and the motion (`PlayerMotion`). The web
 * tests `render/infected-hitbox.test.ts` (at rest) and
 * `render/infected-motion.test.ts` (moving) measure both against each other.
 *
 * The torso, the head and arms on an item are one capsule per part (a runner's
 * also where their bob, sway and twist turn around). Where in
 * its stride a character is, which leg it jumps off with and how far its feet
 * trail behind a turn on the spot is only known to the client that draws it:
 * the legs, and arms that hold nothing, are tested at a number of places of
 * that motion, close enough together to cover all of it.
 *
 * One size for every look: cosmetics, hair styles, talons, the throwing knife
 * and the held item never change a capsule and cannot be hit by themselves.
 *
 * Not followed, because only the drawing client knows it: the surf stance,
 * the blend between two held items, recoil, reloads, knife and claw swings,
 * and breathing (covered by the radii).
 *
 * Model space, as in the character code: x forward, y up, z to the right,
 * feet at the origin.
 */
export type PlayerPart =
	| 'head'
	| 'neck'
	| 'chest'
	| 'ribs'
	| 'belly'
	| 'hips'
	| `${'upperArm' | 'foreArm' | 'hand' | 'thigh' | 'shin' | 'foot'}${'R' | 'L'}`;

/**
 * Capsule radius per part (units): the drawn limb's, plus a little for breathing
 * and idle sway. The shins are wider than drawn (3.3 to 4.1), so a bullet
 * between the legs of a standing player still hits, as it always did.
 */
export const PLAYER_RADII: Readonly<Record<PlayerPart, number>> = Object.freeze({
	head: 7.4,
	neck: 3.2,
	chest: 6.5,
	ribs: 6.3,
	belly: 6.1,
	hips: 6.7,
	upperArmR: 3.9,
	upperArmL: 3.9,
	foreArmR: 2.8,
	foreArmL: 2.8,
	handR: 3.8,
	handL: 3.8,
	thighR: 5.8,
	thighL: 5.8,
	shinR: 5.2,
	shinL: 5.2,
	footR: 4.1,
	footL: 4.1
});
export const PLAYER_PARTS = Object.freeze(Object.keys(PLAYER_RADII)) as readonly PlayerPart[];
/** The part whose hits are headshots (a bobbing head has several capsules). */
const HEAD = 0;
/** The legs come last. */
const LEG_PARTS = 12;

/** A point or direction in model space: [forward, up, right]. */
export type ModelPoint = readonly [x: number, y: number, z: number];

export interface PlayerHold {
	/** `one`: a knife in the right hand; `pistol`: both hands around the grip; `long`: shouldered, the left hand on `fore`. */
	hold: 'one' | 'pistol' | 'long';
	/** Right grip from the shoulder pivot, in the aim frame (turned to the view pitch). */
	at: ModelPoint;
	/** Left hand from the right one, in the aim frame. */
	fore: ModelPoint;
}

/** How the hands hold each item. The animator poses the arms from this table and the hit tests use the same one. */
export const PLAYER_HOLDS: Readonly<Record<Exclude<WeaponId, 'claws'>, PlayerHold>> = Object.freeze({
	knife: { hold: 'one', at: [10, -6.5, 7], fore: [0, 0, 0] },
	pistol: { hold: 'pistol', at: [14.5, -0.6, 1.2], fore: [-0.4, -1.1, -1.1] },
	lmg: { hold: 'long', at: [8.6, -4.6, 4.6], fore: [10.8, 0.8, -0.4] },
	smg: { hold: 'long', at: [9.6, -3.2, 4], fore: [8.4, -0.2, -0.4] },
	striker: { hold: 'long', at: [8.6, -4.2, 4.4], fore: [11.2, 0.6, -0.4] },
	sniper: { hold: 'long', at: [8.6, -3.2, 4.2], fore: [10, 0.8, -0.4] },
	barrett: { hold: 'long', at: [8.4, -3.6, 4.4], fore: [11.4, 0.8, -0.4] }
});

/** Per hold: the share of the view pitch the item follows, how far running tips it forward, the finger direction of the hand in the aim frame and the turn of the chest to the right. */
export const PLAYER_GRIPS = Object.freeze({
	one: { follow: 0.75, relax: 0.1, right: [0.86, -0.12, -0.5] as ModelPoint, left: null, chestYaw: 0 },
	pistol: { follow: 0.95, relax: 0.12, right: [1, 0, 0] as ModelPoint, left: [0.82, 0.1, 0.56] as ModelPoint, chestYaw: 0 },
	long: { follow: 0.95, relax: 0.12, right: [1, 0, 0] as ModelPoint, left: [0.62, 0.3, 0.72] as ModelPoint, chestYaw: -0.16 }
});

/** Where the elbows point. */
export const PLAYER_ELBOWS = Object.freeze({ R: [-0.35, -1, 0.75] as ModelPoint, L: [-0.2, -1, -0.55] as ModelPoint });
/** Lengths of the arm bones, and from the wrist to the middle of the fist. */
export const PLAYER_UPPER_ARM = 11;
export const PLAYER_FOREARM = 9.8;
export const PLAYER_FIST = 3;
/** Furthest a wrist reaches, as a share of the arm. */
const ARM_REACH = 0.995;
/** View pitch the character follows (degrees). */
const PITCH_MAX = 80;

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface PlayerPose extends HitboxPose {
	ducked: boolean;
	/** Infected posture (Patient Zero too): the body hunches forward, claws are raised. Never with an item in the hands. */
	hunched: boolean;
	/** What the player holds (PLAYER_HOLDS); claws for an infected. Absent or null: the arms hang (hunched: raised as with claws). */
	held?: WeaponId | null;
	/** View pitch (Source degrees, positive = down) the head, torso and arms follow; absent: level. */
	pitch?: number;
	/** The moving body, which then says the duck and the pitch too, eased as drawn. Absent: standing still, all the way up or down. */
	motion?: PlayerMotion;
}

/** Joints in the bind pose, each from the one it hangs on. */
const SPINE: ModelPoint = [-0.2, 5.5, 0];
const CHEST: ModelPoint = [-0.1, 5.5, 0];
const NECK: ModelPoint = [-0.5, 10, 0];
const HEAD_JOINT: ModelPoint = [0.4, 3.2, 0];
const CLAVICLE: ModelPoint = [0, 6.4, 2.6];
/** Shoulder from the collarbone's joint. */
const UPPER_ARM: ModelPoint = [0, -0.5, 5.9];
/** Ends of the foot's capsule: from the ankle, and from the ball. */
const HEEL: ModelPoint = [-1.6, -0.8, 0];
const TOE: ModelPoint = [1.1, 1.6, 0];
/** Shoulder pivot of the aim frame above the chest joint. */
const PIVOT_Y = 7;

/** Furthest apart (units) the places are at which a swinging foot, knee or hand is tested. */
const SAMPLE_STEP = 4;
/** Places tested over a gait cycle (most), times the hip turns and the legs in front in the air. */
const MAX_PHASES = 18;
const MAX_LEGS = 96;
const MAX_ARMS = 24;
/** Places of the bobbing torso, head and held item of a runner. */
const BOBS = 4;
/** Places of an arm whose elbow a bob swings around (a pistol aimed straight up), and how loose that is. */
const ELBOWS = 16;
const ELBOW_LOOSE = 0.95;
/** And where it spins: as many again, and how loose that is. */
const ELBOWS_SPIN = 64;
const ELBOW_SPIN = 0.3;

// The pose being tested, in model space (scratch, set by `posePlayer`; the hit
// tests allocate nothing): per capsule the two ends of the axis and the radius,
// and which part it is. The first capsules are one per part, in the order of
// PLAYER_PARTS; the other places of the legs and free arms follow.
const STRIDE = 7;
const PARTS = PLAYER_PARTS.length;
const CAPACITY = PARTS * (1 + BOBS) + 6 * ELBOWS_SPIN + 6 * (MAX_LEGS + MAX_ARMS);
const P = new Float64Array(CAPACITY * STRIDE);
const PART = new Uint8Array(CAPACITY);
const RADIUS = Float64Array.from(PLAYER_PARTS, (n) => PLAYER_RADII[n]);
for (let i = 0; i < CAPACITY; i++) {
	PART[i] = i < PARTS ? i : 0;
	P[i * STRIDE + 6] = RADIUS[PART[i]!]!;
}
/** Capsules of the pose. */
let count = PARTS;
const I = Object.freeze(Object.fromEntries(PLAYER_PARTS.map((n, i) => [n, i]))) as Readonly<Record<PlayerPart, number>>;

function end(i: number, e: 0 | 1, x: number, y: number, z: number): void {
	const k = i * STRIDE + e * 3;
	P[k] = x;
	P[k + 1] = y;
	P[k + 2] = z;
}

/** A capsule for another place of `part`. */
function another(part: number): number {
	const i = count++;
	PART[i] = part;
	P[i * STRIDE + 6] = RADIUS[part]!;
	return i;
}

// Output of the small vector helpers below.
let vx = 0;
let vy = 0;
let vz = 0;

interface Quat {
	x: number;
	y: number;
	z: number;
	w: number;
}
const quat = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
const qPelvis = quat();
const qSpine = quat();
const qChest = quat();
const qNeck = quat();
const qHead = quat();

/** Yaw (left +), then forward pitch, then roll (right +), as the animator's bones. */
function ypr(o: Quat, yaw: number, pitch: number, roll: number): void {
	const cy = Math.cos(yaw / 2);
	const sy = Math.sin(yaw / 2);
	const cz = Math.cos(pitch / 2);
	const sz = -Math.sin(pitch / 2);
	const cr = Math.cos(roll / 2);
	const sr = Math.sin(roll / 2);
	const x = sy * sz;
	const y = sy * cz;
	const z = cy * sz;
	const w = cy * cz;
	o.x = w * sr + x * cr;
	o.y = y * cr + z * sr;
	o.z = z * cr - y * sr;
	o.w = w * cr - x * sr;
}

/** Half way between two orientations (which are less than half a turn apart). */
function halfway(a: Quat, b: Quat, o: Quat): void {
	const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
	const x = a.x + b.x * s;
	const y = a.y + b.y * s;
	const z = a.z + b.z * s;
	const w = a.w + b.w * s;
	const l = Math.sqrt(x * x + y * y + z * z + w * w);
	o.x = x / l;
	o.y = y / l;
	o.z = z / l;
	o.w = w / l;
}

/** (x, y, z) turned by `q`. */
function rotate(q: Quat, x: number, y: number, z: number): void {
	const tx = 2 * (q.y * z - q.z * y);
	const ty = 2 * (q.z * x - q.x * z);
	const tz = 2 * (q.x * y - q.y * x);
	vx = x + q.w * tx + q.y * tz - q.z * ty;
	vy = y + q.w * ty + q.z * tx - q.x * tz;
	vz = z + q.w * tz + q.x * ty - q.y * tx;
}

/** (x, y, z) pitched forward by (c, s) = (cos, sin): the aim frame. */
function turn(x: number, y: number, z: number, c: number, s: number): void {
	vx = x * c + y * s;
	vy = y * c - x * s;
	vz = z;
}

// The chest joint.
let cX = 0;
let cY = 0;
let cZ = 0;

/** A point of the chest (from its joint) in model space. */
function chest(x: number, y: number, z: number): void {
	rotate(qChest, x, y, z);
	vx += cX;
	vy += cY;
	vz += cZ;
}

/** The shoulder of `side`, whose collarbone turns by `yaw` and `roll` with the arm. */
function shoulder(side: 1 | -1, yaw: number, roll: number): void {
	// Yaw about y after roll about x, as the animator's collarbone.
	const cr = Math.cos(roll);
	const sr = Math.sin(roll);
	const y = UPPER_ARM[1] * cr - UPPER_ARM[2] * side * sr;
	const z = UPPER_ARM[1] * sr + UPPER_ARM[2] * side * cr;
	chest(CLAVICLE[0] + z * Math.sin(yaw), CLAVICLE[1] + y, CLAVICLE[2] * side + z * Math.cos(yaw));
}

// The motion and posture being posed, and the results of the shared formulas.
const M = restMotion();
let posture: BodyPosture = 'normal';
const gait: GaitShape = { duty: 0, stride: 0, lift: 0 };
const angles: BodyAngles = newBodyAngles();
const leg = newLegPose();
const foot: FootPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, toe: 0 };
const arm: ArmAngles = { fwd: 0, out: 0, bend: 0, inward: 0, curl: 0 };
const NO_EXTRAS: BodyExtras = Object.freeze({ time: 0, surf: 0, rampDrop: 0, lunge: 0 });
/** The middle of the gait cycle. */
const MIDDLE = NaN;

/** The angles and the pelvis of the pose at gait phase `phL` of the left foot. */
function pelvis(phL: number, item: PlayerHold | null): void {
	bodyAngles(M, phL, gait.duty, posture, item ? 1 : 0, item ? PLAYER_GRIPS[item.hold].chestYaw : 0, NO_EXTRAS, angles);
	ypr(qPelvis, angles.pelvisYaw, angles.pelvisPitch, angles.pelvisRoll);
}

/** The pelvis, and the chest the arms hang on. */
function core(phL: number, item: PlayerHold | null): void {
	pelvis(phL, item);
	ypr(qChest, angles.chestYaw, angles.chestPitch, angles.chestRoll);
	halfway(qPelvis, qChest, qSpine);
	rotate(qPelvis, SPINE[0], SPINE[1], SPINE[2]);
	const sx = angles.px + vx;
	const sy = angles.py + vy;
	const sz = angles.pz + vz;
	rotate(qSpine, CHEST[0], CHEST[1], CHEST[2]);
	cX = sx + vx;
	cY = sy + vy;
	cZ = sz + vz;
}

/** Torso and head of the core, into the capsules of their parts, or into others of the same. */
function torso(more: boolean): void {
	const { px, py, pz } = angles;
	const hips = more ? another(I.hips) : I.hips;
	const belly = more ? another(I.belly) : I.belly;
	const ribs = more ? another(I.ribs) : I.ribs;
	const breast = more ? another(I.chest) : I.chest;
	const neck = more ? another(I.neck) : I.neck;
	const head = more ? another(I.head) : I.head;
	for (let e = 0; e < 2; e++) {
		const z = e === 0 ? 1 : -1;
		rotate(qPelvis, -0.2, -1, 2.4 * z);
		end(hips, e as 0 | 1, px + vx, py + vy, pz + vz);
		rotate(qPelvis, SPINE[0], SPINE[1], SPINE[2]);
		const sx = px + vx;
		const sy = py + vy;
		const sz = pz + vz;
		rotate(qSpine, 0, 0, 2 * z);
		end(belly, e as 0 | 1, sx + vx, sy + vy, sz + vz);
		chest(0.3, 5.8, 3.6 * z);
		end(breast, e as 0 | 1, vx, vy, vz);
		chest(0.3, 1, 2.8 * z);
		end(ribs, e as 0 | 1, vx, vy, vz);
	}
	ypr(qHead, 0, angles.headPitch, angles.headRoll);
	halfway(qChest, qHead, qNeck);
	chest(NECK[0], NECK[1], NECK[2]);
	const nX = vx;
	const nY = vy;
	const nZ = vz;
	end(neck, 0, nX, nY, nZ);
	rotate(qNeck, HEAD_JOINT[0], HEAD_JOINT[1], HEAD_JOINT[2]);
	const bX = nX + vx;
	const bY = nY + vy;
	const bZ = nZ + vz;
	end(neck, 1, bX, bY, bZ);
	rotate(qHead, 0, 4.2, 0);
	end(head, 0, bX + vx, bY + vy, bZ + vz);
	rotate(qHead, 0, 5.8, 0);
	end(head, 1, bX + vx, bY + vy, bZ + vz);
}

/** The leg of `side` at its gait phase `ph`, into the capsules `thigh`, `shin` and `sole`. */
function poseLeg(side: 1 | -1, ph: number, leads: boolean, drift: number, thigh: number, shin: number, sole: number): void {
	footPose(M, angles, gait, side, ph, leads, 0, drift, foot);
	rotate(qPelvis, 0, -1, BODY_HIP_Z * side);
	const hx = angles.px + vx;
	const hy = angles.py + vy;
	const hz = angles.pz + vz;
	legPose(hx, hy, hz, foot, side, M.duck, leg);
	end(thigh, 0, hx, hy, hz);
	end(thigh, 1, leg.kneeX, leg.kneeY, leg.kneeZ);
	end(shin, 0, leg.kneeX, leg.kneeY, leg.kneeZ);
	const { ankleX, ankleY, ankleZ } = leg;
	end(shin, 1, ankleX, ankleY, ankleZ);
	// Heel and ball; the toe in front of the ball stays flat on a planted foot.
	const c = Math.cos(foot.yaw);
	const s = Math.sin(foot.yaw);
	const pc = Math.cos(foot.pitch);
	const ps = Math.sin(foot.pitch);
	const hl = HEEL[0] * pc - HEEL[1] * ps;
	end(sole, 0, ankleX + hl * c, ankleY + HEEL[0] * ps + HEEL[1] * pc, ankleZ - hl * s);
	const tc = Math.cos(foot.pitch * foot.toe);
	const ts = Math.sin(foot.pitch * foot.toe);
	const bl = BODY_BALL[0] * pc - BODY_BALL[1] * ps + TOE[0] * tc - TOE[1] * ts;
	end(sole, 1, ankleX + bl * c, ankleY + BODY_BALL[0] * ps + BODY_BALL[1] * pc + TOE[0] * ts + TOE[1] * tc, ankleZ - bl * s);
}

/** Every place the legs can be at: over the stride, with either leg in front in the air, and with the feet trailing a turn. */
function legs(): void {
	const still = M.move * M.ground < 0.02;
	const phases = still ? 1 : Math.min(MAX_PHASES, 4 + Math.ceil((2 * gait.stride * M.move * M.ground) / SAMPLE_STEP));
	// Half of them while the foot is planted, half while it swings.
	const planted = phases >> 1;
	// In the air: either leg in front, drifting a little.
	const leads = M.ground < 0.98 ? 4 : 1;
	const hip = M.hip;
	const width = M.turnL + M.turnR;
	let hips = width < 0.05 ? 1 : 2 + Math.floor((width * lerp(8, 15, M.duck)) / SAMPLE_STEP);
	hips = Math.max(1, Math.min(hips, Math.floor(MAX_LEGS / (phases * leads))));
	for (let side: 1 | -1 = 1; ; side = -1) {
		let nominal = true;
		for (let j = 0; j < hips; j++) {
			M.hip = hips === 1 ? hip : hip - M.turnR + (width * j) / (hips - 1);
			for (let i = 0; i < phases; i++) {
				const ph = still ? 0 : i < planted ? (gait.duty * 0.999 * i) / (planted - 1) : gait.duty + ((1 - gait.duty) * (i - planted + 1)) / (phases - planted + 1);
				pelvis(still ? MIDDLE : side > 0 ? (ph + 0.5) % 1 : ph, null);
				for (let k = 0; k < leads; k++) {
					const right = side > 0;
					const thigh = right ? I.thighR : I.thighL;
					const shin = right ? I.shinR : I.shinL;
					const sole = right ? I.footR : I.footL;
					const drift = leads === 1 ? 0 : k & 2 ? BODY_AIR_DRIFT : -BODY_AIR_DRIFT;
					if (nominal) poseLeg(side, ph, (k & 1) === 0, drift, thigh, shin, sole);
					else poseLeg(side, ph, (k & 1) === 0, drift, another(thigh), another(shin), another(sole));
					nominal = false;
				}
			}
		}
		if (side < 0) break;
	}
	M.hip = hip;
}

// Results of `reach`: the wrist, and how far the elbow's way is from the arm's own line (near 0, a small bob swings it right around).
let bent = 1;
let wX = 0;
let wY = 0;
let wZ = 0;

/** Two-bone arm from the shoulder of `side` to a wrist target: upper arm and forearm capsules, and the wrist it gets to. */
function reach(side: 1 | -1, tx: number, ty: number, tz: number, u: number, f: number): void {
	const right = side > 0;
	armAngles(M, angles, side, true, 0, 0, arm);
	shoulder(side, shoulderYaw(side, arm.fwd), shoulderRoll(side, arm.out));
	const sx = vx;
	const sy = vy;
	const sz = vz;
	let dx = tx - sx;
	let dy = ty - sy;
	let dz = tz - sz;
	const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
	dx /= d;
	dy /= d;
	dz /= d;
	const len = clamp(d, 4, (PLAYER_UPPER_ARM + PLAYER_FOREARM) * ARM_REACH);
	const pole = right ? PLAYER_ELBOWS.R : PLAYER_ELBOWS.L;
	const px = pole[0];
	const py = pole[1];
	const pz = pole[2];
	const along = px * dx + py * dy + pz * dz;
	let ex = px - dx * along;
	let ey = py - dy * along;
	let ez = pz - dz * along;
	const e = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
	bent = Math.min(bent, e);
	ex /= e;
	ey /= e;
	ez /= e;
	const ca = clamp((PLAYER_UPPER_ARM * PLAYER_UPPER_ARM + len * len - PLAYER_FOREARM * PLAYER_FOREARM) / (2 * PLAYER_UPPER_ARM * len), -1, 1);
	const a = PLAYER_UPPER_ARM * ca;
	const b = PLAYER_UPPER_ARM * Math.sqrt(1 - ca * ca);
	end(u, 0, sx, sy, sz);
	end(u, 1, sx + dx * a + ex * b, sy + dy * a + ey * b, sz + dz * a + ez * b);
	end(f, 0, sx + dx * a + ex * b, sy + dy * a + ey * b, sz + dz * a + ez * b);
	wX = sx + dx * len;
	wY = sy + dy * len;
	wZ = sz + dz * len;
	end(f, 1, wX, wY, wZ);
}

/** Arm without an item, hanging and swinging or with the claws raised, into three capsules. */
function poseArm(side: 1 | -1, leads: boolean, claws: boolean, u: number, f: number, h: number): void {
	armAngles(M, angles, side, leads, 0, 0, arm);
	if (claws) clawAngles(M, angles, side, 0, arm);
	shoulder(side, shoulderYaw(side, arm.fwd), shoulderRoll(side, arm.out));
	const sx = vx;
	const sy = vy;
	const sz = vz;
	// Swing forward, out to the side, then the twist that turns the elbow's bend inwards.
	const cf = Math.cos(arm.fwd);
	const sf = Math.sin(arm.fwd);
	const co = Math.cos(arm.out);
	const so = Math.sin(arm.out) * side;
	rotate(qChest, co * sf, -co * cf, so);
	const ex = sx + vx * PLAYER_UPPER_ARM;
	const ey = sy + vy * PLAYER_UPPER_ARM;
	const ez = sz + vz * PLAYER_UPPER_ARM;
	const bend = Math.sin(arm.bend);
	const bx = bend * Math.cos(arm.inward);
	const by = -Math.cos(arm.bend);
	const bz = -bend * Math.sin(arm.inward) * side;
	const oy = by * co + bz * so;
	const oz = bz * co - by * so;
	rotate(qChest, bx * cf - oy * sf, bx * sf + oy * cf, oz);
	const wx = ex + vx * PLAYER_FOREARM;
	const wy = ey + vy * PLAYER_FOREARM;
	const wz = ez + vz * PLAYER_FOREARM;
	end(u, 0, sx, sy, sz);
	end(u, 1, ex, ey, ez);
	end(f, 0, ex, ey, ez);
	end(f, 1, wx, wy, wz);
	end(h, 0, wx, wy, wz);
	// Fingers: shorter the more they curl, and curled inwards.
	const l = clamp(6.4 - 3.1 * arm.curl, 3, 5);
	const ux = vx * l;
	const uy = vy * l;
	const uz = vz * l;
	rotate(qChest, 0, 0, -0.6 * side);
	end(h, 1, wx + ux + vx, wy + uy + vy, wz + uz + vz);
}

/** Every place an arm that holds nothing can be at: over its swing, and either way round in the air. */
function freeArm(side: 1 | -1, claws: boolean, item: PlayerHold | null): void {
	const right = side > 0;
	const u = right ? I.upperArmR : I.upperArmL;
	const f = right ? I.foreArmR : I.foreArmL;
	const h = right ? I.handR : I.handL;
	const move = M.move * M.ground;
	const run = clamp(M.speed / 250, 0, 1);
	// The hand's way over a swing.
	const way = move * lerp(0.35, 0.78, run) * (claws ? 0.5 * 0.5 * move + 0.2 : 1) * 2 * 19;
	const swings = move < 0.02 ? 1 : Math.min(MAX_ARMS / 2, 2 + Math.floor(way / SAMPLE_STEP));
	const leads = M.ground < 0.98 && !(claws && M.ground < 0.02) ? 2 : 1;
	for (let i = 0; i < swings; i++) {
		// Evenly over the swing, not over the time; every other one on the way back, with the weight on the other foot.
		const ph = swings === 1 ? MIDDLE : Math.acos(1 - (2 * i) / (swings - 1)) / (2 * Math.PI);
		core(i & 1 ? 1 - ph : ph, item);
		for (let k = 0; k < leads; k++) {
			if (i + k === 0) poseArm(side, true, claws, u, f, h);
			else poseArm(side, k === 0, claws, another(u), another(f), another(h));
		}
	}
}

/** The fist of a hand on an item: from the wrist along the fingers (turned to the aim). */
function fist(h: number, d: ModelPoint, c: number, s: number): void {
	const l = PLAYER_FIST / Math.hypot(d[0], d[1], d[2]);
	end(h, 0, wX, wY, wZ);
	turn(d[0] * l, d[1] * l, d[2] * l, c, s);
	end(h, 1, wX + vx, wY + vy, wZ + vz);
}

/** The arms that hold an item, both or the right one alone, at gait phase `phL`, into the capsules of their parts, or into others of the same. */
function heldArms(item: PlayerHold, phL: number, more: boolean): void {
	const grip = PLAYER_GRIPS[item.hold];
	const relax = gripRelax(grip.relax, angles);
	const drop = relax * GRIP_RELAX_DROP;
	const aim = M.aim * grip.follow + relax;
	const c = Math.cos(aim);
	const s = Math.sin(aim);
	chest(0, PIVOT_Y, 0);
	const pX = vx;
	const pY = vy;
	const pZ = vz;
	// The wrist is a fist behind the grip along the fingers.
	const r = grip.right;
	const l = PLAYER_FIST / Math.hypot(r[0], r[1], r[2]);
	const bob = Number.isNaN(phL) ? 0 : angles.move * angles.run;
	turn(item.at[0] - r[0] * l, item.at[1] + gripBobY(phL || 0) * bob - drop - r[1] * l, item.at[2] + gripBobZ(phL || 0) * bob - r[2] * l, c, s);
	reach(1, pX + vx, pY + vy, pZ + vz, more ? another(I.upperArmR) : I.upperArmR, more ? another(I.foreArmR) : I.foreArmR);
	fist(more ? another(I.handR) : I.handR, r, c, s);
	const left = grip.left;
	if (!left) return;
	// The left hand from where the right one got to, so it never leaves the item.
	const k = PLAYER_FIST / Math.hypot(left[0], left[1], left[2]);
	const fx = wX;
	const fy = wY;
	const fz = wZ;
	turn(PLAYER_FIST + item.fore[0] - left[0] * k, item.fore[1] - left[1] * k, item.fore[2] - left[2] * k, c, s);
	reach(-1, fx + vx, fy + vy, fz + vz, more ? another(I.upperArmL) : I.upperArmL, more ? another(I.foreArmL) : I.foreArmL);
	fist(more ? another(I.handL) : I.handL, left, c, s);
}

/** Pose the capsules of `p` in model space, all but the legs. `keep`: the next call with the same object finds it posed. */
function poseTop(p: PlayerPose, keep: boolean): void {
	if (keep && posed === p) return;
	if (p.motion) copyMotion(p.motion, M);
	else {
		copyMotion(REST, M);
		M.duck = p.ducked ? 1 : 0;
		M.aim = clamp(Number.isFinite(p.pitch) ? p.pitch! : 0, -PITCH_MAX, PITCH_MAX) * DEG;
	}
	posture = p.hunched ? 'infected' : 'normal';
	const item = p.held && p.held !== 'claws' ? PLAYER_HOLDS[p.held] : null;
	bodyGait(M.speed, M.duck, posture, gait);
	count = PARTS;
	posed = keep ? p : null;
	legsPosed = false;
	core(MIDDLE, item);
	torso(false);
	bent = 1;
	if (item) heldArms(item, MIDDLE, false);
	// The bob, sway and twist of a run: where they turn around.
	const bobs = M.move * M.ground * M.speed > 50;
	if (bobs)
		for (let k = 0; k < BOBS; k++) {
			const ph = gait.duty / 2 + k / BOBS;
			core(ph, item);
			torso(true);
			if (item) heldArms(item, ph, true);
		}
	// The four places above may have found it loose too.
	if (item && bobs && bent < ELBOW_LOOSE) {
		const elbows = bent < ELBOW_SPIN ? ELBOWS_SPIN : ELBOWS;
		for (let k = 0; k < elbows; k++) {
			core((k + 0.5) / elbows, item);
			// The first one instead of the middle, which is nowhere on the elbow's way.
			heldArms(item, (k + 0.5) / elbows, k > 0);
		}
	}
	if (!item) freeArm(1, p.hunched, null);
	if (!item || !PLAYER_GRIPS[item.hold].left) freeArm(-1, p.hunched, item);
}

/** The legs of the pose. */
function poseLegs(): void {
	if (legsPosed) return;
	legsPosed = true;
	legs();
}

/** Pose the capsules of `p` in model space. */
function posePlayer(p: PlayerPose): void {
	poseTop(p, false);
	poseLegs();
}

/** The pose that is kept, and whether its legs are posed. */
let posed: PlayerPose | null = null;
let legsPosed = false;
const REST: Readonly<PlayerMotion> = Object.freeze(restMotion());

/** World position of a model point of a pose (scratch result in vx, vy, vz). */
function toWorld(p: PlayerPose, x: number, y: number, z: number): Vec3 {
	const yr = p.yaw * DEG;
	const c = Math.cos(yr);
	const s = Math.sin(yr);
	return { x: p.x + x * c + z * s, y: p.y + x * s - z * c, z: p.z + y };
}

/** World position on the axis of a part (a limb in motion: one of its places): `along` 0..1 from its first end (shoulder, hip, heel, left half of the torso is 1) to its second. */
export function playerPoint(p: PlayerPose, part: PlayerPart, along = 0.5): Vec3 {
	posePlayer(p);
	const o = I[part] * STRIDE;
	return toWorld(p, P[o]! + (P[o + 3]! - P[o]!) * along, P[o + 1]! + (P[o + 4]! - P[o + 1]!) * along, P[o + 2]! + (P[o + 5]! - P[o + 2]!) * along);
}

/** World position `up` units up the leaning body (three quarters of it ducked): on the line from the feet to the neck. */
export function playerUp(p: PlayerPose, up: number): Vec3 {
	posePlayer(p);
	const o = I.neck * STRIDE;
	const x = P[o]!;
	const y = P[o + 1]!;
	const z = P[o + 2]!;
	const f = (up * lerp(1, 0.75, M.duck)) / (Math.hypot(x, y, z) || 1);
	return toWorld(p, x * f, y * f, z * f);
}

/** The capsules of a pose in world space (tests and the dev viewer): a limb in motion has several. */
export function playerCapsules(p: PlayerPose): Array<{ part: PlayerPart; a: Vec3; b: Vec3; r: number }> {
	posePlayer(p);
	return Array.from({ length: count }, (_, i) => {
		const o = i * STRIDE;
		return { part: PLAYER_PARTS[PART[i]!]!, a: toWorld(p, P[o]!, P[o + 1]!, P[o + 2]!), b: toWorld(p, P[o + 3]!, P[o + 4]!, P[o + 5]!), r: P[o + 6]! };
	});
}

// The ray in model space (scratch, set by `toModel`).
let ox = 0;
let oy = 0;
let oz = 0;
let dx = 0;
let dy = 0;
let dz = 0;

function toModel(o: Vec3, d: Vec3, p: PlayerPose): void {
	const yr = p.yaw * DEG;
	const c = Math.cos(yr);
	const s = Math.sin(yr);
	const x = o.x - p.x;
	const y = o.y - p.y;
	ox = x * c + y * s;
	oz = x * s - y * c;
	oy = o.z - p.z;
	dx = d.x * c + d.y * s;
	dz = d.x * s - d.y * c;
	dy = d.z;
}

/** A ball that holds every pose: its height above the feet and its radius. */
export const PLAYER_BOUNDS = Object.freeze({ y: 36, r: 49 });

/** Whether the model-space ray passes within `grow` of where a player can be. */
function near(grow: number): boolean {
	const y = oy - PLAYER_BOUNDS.y;
	const t = -(ox * dx + y * dy + oz * dz);
	const r = PLAYER_BOUNDS.r + grow;
	const d2 = ox * ox + y * y + oz * oz;
	return d2 <= r * r || (t >= 0 && d2 - t * t <= r * r);
}

/** The legs are inside this upright cylinder, whatever they do. */
export const PLAYER_LEG_BOUNDS = Object.freeze({ y0: -8, y1: 46, r: 31 });

/** Whether the model-space ray passes within `grow` of where legs can be. */
function nearLegs(grow: number): boolean {
	const r = PLAYER_LEG_BOUNDS.r + grow;
	let t0 = 0;
	let t1 = Infinity;
	const a = dx * dx + dz * dz;
	const c = ox * ox + oz * oz - r * r;
	if (a < 1e-12) {
		if (c > 0) return false;
	} else {
		const b = ox * dx + oz * dz;
		const disc = b * b - a * c;
		if (disc < 0) return false;
		const s = Math.sqrt(disc);
		t0 = Math.max(t0, (-b - s) / a);
		t1 = (-b + s) / a;
	}
	const y0 = PLAYER_LEG_BOUNDS.y0 - grow;
	const y1 = PLAYER_LEG_BOUNDS.y1 + grow;
	if (Math.abs(dy) < 1e-12) return t0 <= t1 && oy >= y0 && oy <= y1;
	const ta = (y0 - oy) / dy;
	const tb = (y1 - oy) / dy;
	return Math.max(t0, Math.min(ta, tb)) <= Math.min(t1, Math.max(ta, tb));
}

/** Entry distance >= 0 of the model-space ray into the capsule at `k` grown by `grow`, or -1. */
function rayCapsule(k: number, grow: number): number {
	const r = P[k + 6]! + grow;
	const r2 = r * r;
	const bax = P[k + 3]! - P[k]!;
	const bay = P[k + 4]! - P[k + 1]!;
	const baz = P[k + 5]! - P[k + 2]!;
	const oax = ox - P[k]!;
	const oay = oy - P[k + 1]!;
	const oaz = oz - P[k + 2]!;
	const baba = bax * bax + bay * bay + baz * baz;
	const bard = bax * dx + bay * dy + baz * dz;
	const baoa = bax * oax + bay * oay + baz * oaz;
	const rdoa = dx * oax + dy * oay + dz * oaz;
	const oaoa = oax * oax + oay * oay + oaz * oaz;
	// Inside already?
	const h0 = clamp(baba > 1e-9 ? baoa / baba : 0, 0, 1);
	const ix = oax - bax * h0;
	const iy = oay - bay * h0;
	const iz = oaz - baz * h0;
	if (ix * ix + iy * iy + iz * iz <= r2) return 0;
	// Wall between the ends.
	const a = baba - bard * bard;
	if (a > 1e-9) {
		const b = baba * rdoa - baoa * bard;
		const c = baba * oaoa - baoa * baoa - r2 * baba;
		const h = b * b - a * c;
		if (h >= 0) {
			const t = (-b - Math.sqrt(h)) / a;
			const y = baoa + t * bard;
			if (y > 0 && y < baba) return t >= 0 ? t : -1;
		}
	}
	// Ball at an end: the nearer of the two.
	let best = -1;
	for (let e = 0; e < 2; e++) {
		const ocx = e === 0 ? oax : oax - bax;
		const ocy = e === 0 ? oay : oay - bay;
		const ocz = e === 0 ? oaz : oaz - baz;
		const b = dx * ocx + dy * ocy + dz * ocz;
		const h = b * b - (ocx * ocx + ocy * ocy + ocz * ocz - r2);
		if (h < 0) continue;
		const t = -b - Math.sqrt(h);
		if (t >= 0 && (best < 0 || t < best)) best = t;
	}
	return best;
}

/**
 * First player capsule a ray (unit `d`) hits within `maxT`. Like `rayZombie`,
 * the head counts when the ray reaches it before (or without) the body.
 * `keep`: more rays at the same, unchanged pose object follow (a shotgun).
 */
export function rayPlayer(o: Vec3, d: Vec3, p: PlayerPose, maxT: number, keep = false): RayHit | null {
	toModel(o, d, p);
	if (!near(0)) return null;
	poseTop(p, keep);
	if (nearLegs(0)) poseLegs();
	let th = -1;
	let tb = -1;
	for (let i = 0; i < count; i++) {
		if (i === LEG_PARTS && !legsPosed) i = PARTS;
		if (i >= count) break;
		const t = rayCapsule(i * STRIDE, 0);
		if (t < 0) continue;
		if (PART[i] === HEAD) {
			if (th < 0 || t < th) th = t;
		} else if (tb < 0 || t < tb) tb = t;
	}
	if (th >= 0 && th <= maxT && (tb < 0 || th <= tb)) return { t: th, head: true };
	if (tb >= 0 && tb <= maxT) return { t: tb, head: false };
	return null;
}

/**
 * Like `rayPlayer`, plus the part of the capsule that was hit first (the head
 * when the head counts, as in `rayPlayer`; else the nearest body capsule).
 * Tournament damage depends on it (modes/tournament/damage.ts).
 */
export function rayPlayerPart(o: Vec3, d: Vec3, p: PlayerPose, maxT: number, keep = false): (RayHit & { part: PlayerPart }) | null {
	toModel(o, d, p);
	if (!near(0)) return null;
	poseTop(p, keep);
	if (nearLegs(0)) poseLegs();
	let th = -1;
	let tb = -1;
	let pb = 0;
	for (let i = 0; i < count; i++) {
		if (i === LEG_PARTS && !legsPosed) i = PARTS;
		if (i >= count) break;
		const t = rayCapsule(i * STRIDE, 0);
		if (t < 0) continue;
		if (PART[i] === HEAD) {
			if (th < 0 || t < th) th = t;
		} else if (tb < 0 || t < tb) {
			tb = t;
			pb = PART[i]!;
		}
	}
	if (th >= 0 && th <= maxT && (tb < 0 || th <= tb)) return { t: th, head: true, part: 'head' };
	if (tb >= 0 && tb <= maxT) return { t: tb, head: false, part: PLAYER_PARTS[pb]! };
	return null;
}

/**
 * A ball of `radius` moving from `o` along unit `d` (a throwing knife): the
 * distance at which it first touches a capsule within `maxT`, or -1.
 */
export function sweepPlayer(o: Vec3, d: Vec3, p: PlayerPose, maxT: number, radius: number): number {
	toModel(o, d, p);
	if (!near(radius)) return -1;
	poseTop(p, false);
	if (nearLegs(radius)) poseLegs();
	let best = -1;
	for (let i = 0; i < count; i++) {
		if (i === LEG_PARTS && !legsPosed) i = PARTS;
		if (i >= count) break;
		const t = rayCapsule(i * STRIDE, radius);
		if (t >= 0 && t <= maxT && (best < 0 || t < best)) best = t;
	}
	return best;
}

/** Melee: a target whose nearest surface is this close counts in a wider cone (edge of the screen). */
const MELEE_CLOSE = 13;
const MELEE_CLOSE_CONE = 1.6;
/** Melee: the head flag comes from the aim ray itself, tested this far past the reach. */
const MELEE_HEAD_SLACK = 16;

// The melee test in progress (scratch): reach, cone limits, and the result so far.
let mReach = 0;
let mCone = 0;
let mConeClose = 0;
let mSurface = 0;
let mHit = false;

/** The point of the capsule at `k` nearest the model point (x, y, z), as its offset from the eye: `nearest` marks the one nearest the eye. */
function meleeTry(k: number, x: number, y: number, z: number, nearest: boolean): void {
	const bax = P[k + 3]! - P[k]!;
	const bay = P[k + 4]! - P[k + 1]!;
	const baz = P[k + 5]! - P[k + 2]!;
	const baba = bax * bax + bay * bay + baz * baz;
	const h = baba > 1e-9 ? clamp(((x - P[k]!) * bax + (y - P[k + 1]!) * bay + (z - P[k + 2]!) * baz) / baba, 0, 1) : 0;
	const ax = P[k]! + bax * h;
	const ay = P[k + 1]! + bay * h;
	const az = P[k + 2]! + baz * h;
	const gap = Math.sqrt((x - ax) * (x - ax) + (y - ay) * (y - ay) + (z - az) * (z - az));
	// A point inside stays; one outside goes to the surface.
	const f = gap > P[k + 6]! ? P[k + 6]! / gap : 1;
	const ex = ax + (x - ax) * f - ox;
	const ey = ay + (y - ay) * f - oy;
	const ez = az + (z - az) * f - oz;
	const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
	if (nearest && dist < mSurface) mSurface = dist;
	if (dist > mReach) return;
	if (dist < 1e-6 || (ex * dx + ey * dy + ez * dz) / dist >= (dist < MELEE_CLOSE ? mConeClose : mCone)) mHit = true;
}

/**
 * Melee check against the player capsules: some part is within `reach` of the
 * eye and inside the aim cone. Per capsule two points are tried, the one
 * nearest the eye and the one nearest the aim line. Returns the distance to
 * the nearest surface and whether the aim ray itself goes through the head,
 * or null.
 */
export function meleePlayer(eye: Vec3, d: Vec3, p: PlayerPose, reach: number, coneDeg: number): RayHit | null {
	toModel(eye, d, p);
	const bounds = reach + PLAYER_BOUNDS.r;
	if (ox * ox + (oy - PLAYER_BOUNDS.y) ** 2 + oz * oz > bounds * bounds) return null;
	posed = null;
	poseTop(p, true);
	poseLegs();
	mReach = reach;
	mCone = Math.cos(coneDeg * DEG);
	// Very close players count even at the edge of the screen.
	mConeClose = Math.cos(Math.min(180, coneDeg * MELEE_CLOSE_CONE) * DEG);
	mSurface = Infinity;
	mHit = false;
	for (let i = 0; i < count; i++) {
		const k = i * STRIDE;
		const along = ((P[k]! + P[k + 3]!) / 2 - ox) * dx + ((P[k + 1]! + P[k + 4]!) / 2 - oy) * dy + ((P[k + 2]! + P[k + 5]!) / 2 - oz) * dz;
		const t = clamp(along, 0, reach);
		meleeTry(k, ox, oy, oz, true);
		meleeTry(k, ox + dx * t, oy + dy * t, oz + dz * t, false);
	}
	const ray = mHit ? rayPlayer(eye, d, p, reach + MELEE_HEAD_SLACK, true) : null;
	posed = null;
	if (!mHit) return null;
	const surface = mSurface;
	return { t: surface, head: ray?.head ?? false };
}
