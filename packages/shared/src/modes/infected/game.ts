/**
 * Infected rules (docs/modes.md#infected). Pure and clock-injected: the
 * server runs one `InfectedGame` per infected map, feeds it players' latest
 * positions, shots and knife throws; tests drive it with a fake clock.
 *
 * Round flow: waiting (< INF_MIN_PLAYERS) → grace (INF_GRACE_SECS: everyone
 * is a survivor with the round's preset weapon and spreads out) → playing
 * (Patient Zero is picked; INF_ROUND_SECS clock, +INF_INFECTION_BONUS_SECS
 * per infection) → ended (INF_END_SECS summary) → grace ...
 *
 * Teams: survivors carry three slots, [1] the round's preset primary, [2] the
 * pistol (INF_SECONDARY, its own magazine and reserve) and [3] the knife, with
 * limited ammo (INF_AMMO), and never die: any claw swipe or throwing knife
 * infects them on the spot.
 * Every infected has claws and a throwing knife only, Patient Zero (alpha)
 * too, who is called that until the first infection. Infected die to
 * survivor fire (INF_INFECTED_HP, headshots kill) and respawn after
 * INF_RESPAWN_SECS at the spawn farthest from the survivors.
 *
 * Throwing knives are simulated projectiles (gravity, one bounce off walls
 * or floors; bank shots still infect) stepped at INF_SIM_HZ with the world
 * trace; a stuck knife can be picked up again by its owner. Knives stick in
 * floors and in walls within INF_KNIFE_WALL_REACH of the floor below; higher
 * on a wall or in a ceiling they drop (harmless, a `knifeBounce` with the new
 * velocity) to the floor below, within walking reach of it. Impacts
 * that would rebound slower than INF_KNIFE_REST_SPEED do not bounce.
 *
 * Choices where the rules leave room:
 * - An infected survivor turns in place (no teleport): the `infect` event
 *   plus an `ammo` event for 'claws' tell the client.
 * - An infection counts as a kill for the infector and a death for the victim.
 * - Melee by an infected reports method 'claws'.
 * - When every infected leaves mid-round, a random survivor becomes infected:
 *   as the Alpha (`alpha` event) before the first infection, else an
 *   `infect` event with `by: null`, method 'claws', timeAdded 0 (not counted
 *   as an infection, no bonus time).
 * - `alphaId` stays set for the round after the first infection; it goes
 *   null only if Patient Zero leaves.
 * - A player who leaves loses all their knives, flying ones included.
 * - Leaving (or spectating) mid-round and coming back restores score, kills
 *   and deaths for the round (keyed by the `keys` given to syncPlayers, else
 *   the id). While playing the player comes back infected (never as a
 *   survivor, never as the Alpha) and holds a knife only if they held one
 *   when they left (survivors and dead infected are due a fresh one).
 *   HP and the respawn timer are not kept: a rejoin spawns fresh.
 * - A knife belongs to the life that threw it: once its owner respawns, a
 *   knife from an earlier life still flies (and infects) but is removed when
 *   it lands, so an owner never holds or retrieves two.
 * - A cancelled grace period (dropping to waiting) does not use up a round:
 *   the next grace repeats the same round number and preset.
 * - Joiners while waiting or ended spawn as survivors at a random spawn.
 * - Dropping back to waiting turns everyone back into a survivor in place
 *   (a `spawn` event at their current position carries the new team).
 * - The scavenger `ammo` event names the weapon it refilled (the primary, and
 *   with the scavenger perk also the pistol) even while another slot is held:
 *   clients should treat `scavenger: true` as a reserve update only.
 *
 * Survivor kill streak perks: kills of infected in one
 * survivor life build `streak`; perks unlock at INF_PERK_KILLS (hardline is
 * the base, always on). The kill that reaches a threshold already gets that
 * perk's effect (the streak is counted first). A `perk` event announces each
 * unlock (none for hardline). Being infected, or a new round, resets the
 * streak and the perks. At `moabKills` (INF_MOAB_KILLS) the survivor may call
 * a M.O.A.B. once (`callMoab`): after the countdown every living infected
 * dies and the survivors win the round. A called M.O.A.B. detonates even if
 * its caller has turned or left (no credit then if they left). The perks of
 * infected players are reported as [] (they have no streak).
 *
 * Respawn beacons: a living infected may place one beacon on the walkable
 * ground below them, also in a jump (INF_BEACON_COOLDOWN_MS between
 * placements; a new one replaces the old). Their next respawn or fall out of
 * the map uses it up and puts them on it (reason 'beacon') instead of the far map spawn. Survivors
 * destroy a beacon with one bullet or knife swing (+INF_SCORE_BEACON_DESTROY,
 * a `hit` with targetId 0 for the hitmarker); infected cannot. Beacons go
 * when their owner leaves or spectates and at every round end / grace /
 * waiting.
 *
 * Hit registration: bullets, melee and throwing knives are tested against the
 * player hitboxes (../zombies/hitbox.ts: capsules on the drawn character's
 * bones, posed like it). Shots and swings are tested against the poses the shooter
 * saw (lagcomp.ts: per-player pose history, never from before the target's
 * last spawn or teleport). Throwing knives are simulated here and hit the
 * current poses.
 *
 * Round stats (stats.ts): shots, hits, headshots, kills, infections, best
 * streak and time survived per player, reset with the score at every grace
 * period, kept through a leave and rejoin, sent with the `end` event for the
 * players present.
 */
import { copyMotion, PlayerBody, restMotion } from '../../body-motion.ts';
import type { BodyInput } from '../../body-pose.ts';
import type { CollisionWorld } from '../../collision/api.ts';
import type { MapDef, Spawn, Zone } from '../../maps/types.ts';
import { SURF_CVARS } from '../../cvars.ts';
import { DUCK_VIEW_HEIGHT, HULL_MAX, HULL_MIN, VIEW_HEIGHT } from '../../movement/api.ts';
import type { Vec3 } from '../../types.ts';
import { hullInBox, tagSpawns } from '../tag.ts';
import { ZM_FIRE_TOLERANCE, ZM_RELOAD_TOLERANCE, ZM_SLOW_FACTORS, ZM_SLOW_MS, zmSlowFactor } from '../zombies/game.ts';
import { meleePlayer, playerUp, rayPlayer, raySphere, sweepPlayer, type PlayerPose } from '../zombies/hitbox.ts';
import { hitDamage, isWeaponId, WEAPONS, WeaponState, type WeaponId } from '../zombies/weapons.ts';
import { INF_HISTORY_MS, PoseHistory } from './lagcomp.ts';
import { infRoundStat, newInfTally, type InfTally } from './stats.ts';

export type InfPhase = 'waiting' | 'grace' | 'playing' | 'ended';
export type InfTeam = 'survivor' | 'infected';
export type InfSpawnReason = 'round' | 'join' | 'respawn' | 'fall' | 'beacon';
/** 'gun' is sent by older servers only (Patient Zero had the round gun). */
export type InfMethod = 'claws' | 'knife' | 'bank' | 'gun';

export const INF_MIN_PLAYERS = 2;
export const INF_GRACE_SECS = 12;
export const INF_ROUND_SECS = 120;
/** Added to the round clock on every infection. */
export const INF_INFECTION_BONUS_SECS = 20;
export const INF_END_SECS = 7;
export const INF_INFECTED_HP = 5;
/** Survivor HP, sent but not shown: claws and knives infect outright, so nothing lowers it. */
export const INF_SURVIVOR_HP = 5;
export const INF_RESPAWN_SECS = 3;
/** Infected speed with claws; holding a gun uses WEAPONS[weapon].moveSpeed. */
export const INF_INFECTED_SPEED = 265;
/** Horizontal speed (u/s) no play in this mode reaches (`SPEED_LIMIT` of the economy). */
export const INF_SPEED_LIMIT = 1000;
export const INF_SIM_HZ = 64;
export const INF_STEP_MS = 1000 / INF_SIM_HZ;
/** A fire/throw origin may be this far from the player's last known eye. */
export const INF_ORIGIN_SLACK = 80;
/** UAV pulse interval on the last survivor (with >= 2 infected). */
export const INF_UAV_INTERVAL_MS = 5000;
/** Survivor primary per round: INF_PRESETS[(round - 1) % length]. */
export const INF_PRESETS: readonly WeaponId[] = ['barrett', 'striker', 'lmg', 'smg', 'sniper'];
/** Survivor secondary (slot 2) every round. */
export const INF_SECONDARY: WeaponId = 'pistol';

export interface InfAmmo {
	mag: number;
	reserve: number;
	/** Reserve rounds gained per infected kill (clamped to WEAPONS[w].reserve). */
	scavenger: number;
}

/** Limited survivor ammo per preset. */
export const INF_AMMO: Readonly<Partial<Record<WeaponId, InfAmmo>>> = Object.freeze({
	barrett: { mag: 10, reserve: 20, scavenger: 10 },
	striker: { mag: 12, reserve: 24, scavenger: 12 },
	lmg: { mag: 100, reserve: 100, scavenger: 50 },
	smg: { mag: 36, reserve: 72, scavenger: 36 },
	pistol: { mag: 12, reserve: 36, scavenger: 12 },
	sniper: { mag: 5, reserve: 15, scavenger: 5 }
});

/** Survivor kill streak perks; see INF_PERK_KILLS. */
export type InfPerkId = 'hardline' | 'sleight' | 'scavenger' | 'steady' | 'specialist';
/** Survivor kill streak at which each perk unlocks (hardline: the base perk). */
export const INF_PERK_KILLS: Readonly<Record<InfPerkId, number>> = Object.freeze({
	hardline: 0,
	sleight: 1,
	scavenger: 3,
	steady: 5,
	specialist: 7
});
const PERK_ORDER: readonly InfPerkId[] = ['hardline', 'sleight', 'scavenger', 'steady', 'specialist'];
export const INF_SCORE_SPECIALIST = 250;
/** Sleight of hand: reload duration factor. */
export const INF_SLEIGHT_RELOAD_FACTOR = 0.5;
/** Steady aim: spread factor (shotgun pellets on the server; every weapon on the client). */
export const INF_STEADY_SPREAD_FACTOR = 0.5;
export const INF_STEADY_SPEED_FACTOR = 1.12;
/** Specialist: wait between shots factor, knockback factor. */
export const INF_SPECIALIST_CADENCE_FACTOR = 0.85;
export const INF_SPECIALIST_KNOCKBACK_FACTOR = 1.2;
/** Before the scavenger perk, a kill refills this share of the primary's INF_AMMO.scavenger. */
const EMERGENCY_REFILL_SHARE = 0.4;
/** With the scavenger perk the primary reserve may grow to this times WEAPONS[w].reserve. */
const SCAVENGER_RESERVE_CAP = 1.5;

/** Survivor kill streak for a M.O.A.B. (25 minus 1 for hardline). */
export const INF_MOAB_KILLS = 24;
export const INF_MOAB_COUNTDOWN_SECS = 10;
export const INF_SCORE_MOAB = 500;

/** Active perks of a survivor with kill streak `streak` (hardline always). */
export function infPerksForStreak(streak: number): InfPerkId[] {
	return PERK_ORDER.filter((perk) => streak >= INF_PERK_KILLS[perk]);
}

export const INF_SCORE_KILL = 100;
export const INF_SCORE_INFECT = 150;
/** Extra for a throwing-knife infection. */
export const INF_SCORE_KNIFE_BONUS = 50;
/** Extra on top of the knife bonus for a bank shot (total 250). */
export const INF_SCORE_BANK_BONUS = 50;
/** To every other living survivor when a survivor is infected. */
export const INF_SCORE_SURVIVE_TICK = 25;
/** To every living survivor when the survivors win. */
export const INF_SCORE_SURVIVE_WIN = 250;
/** To a survivor who destroys an infected's respawn beacon. */
export const INF_SCORE_BEACON_DESTROY = 50;
/** Minimum time between two beacon placements by one player. */
export const INF_BEACON_COOLDOWN_MS = 1500;
/** Beacon hit sphere radius, centred INF_BEACON_HIT_Z above its floor point. */
export const INF_BEACON_HIT_RADIUS = 16;
export const INF_BEACON_HIT_Z = 10;
/** Placement: the floor must be within this far below the feet (a bhopper is in the air most of the time). */
const BEACON_DROP_DIST = 256;
/** The ground trace starts this far above the reported feet. */
const BEACON_TRACE_LIFT = 2;
/** Respawning on a beacon puts the feet this far above its floor point (like map spawns). */
const BEACON_SPAWN_LIFT = 0.25;

export const INF_KNIFE_SPEED = 1150;
export const INF_KNIFE_GRAVITY = 650;
export const INF_KNIFE_MAX_BOUNCES = 1;
export const INF_KNIFE_RESTITUTION = 0.48;
export const INF_KNIFE_TANGENT_DAMP = 0.78;
/** Slower than this after a bounce: the knife sticks (or drops) instead. */
export const INF_KNIFE_REST_SPEED = 90;
/** Horizontal pickup reach from the owner's centre; vertically the owner's hull ± INF_KNIFE_PICKUP_SLACK_Z. */
export const INF_KNIFE_PICKUP_RADIUS = 56;
export const INF_KNIFE_PICKUP_SLACK_Z = 24;
/** A knife sticks in a wall only this close above the floor below it; higher it drops. */
export const INF_KNIFE_WALL_REACH = 96;
/** Added to survivor hitbox radii for the knife's swept test. */
export const INF_KNIFE_HIT_RADIUS = 10;
export const INF_KNIFE_LIFETIME_SECS = 45;
/** Knife hull for world traces. */
export const INF_KNIFE_MIN: Vec3 = Object.freeze({ x: -2, y: -2, z: -2 });
export const INF_KNIFE_MAX: Vec3 = Object.freeze({ x: 2, y: 2, z: 2 });
/** Melee line of sight: from the eye to a point this far up the target's leaning body. */
export const INF_MELEE_LOS_HEIGHT = 40;
/** The knife spawns this far in front of the eye (traced). */
const KNIFE_SPAWN_DIST = 16;
/** The pickup sight line starts in the owner's hull at the knife's height, clamped to these heights above the feet. */
const PICKUP_LOS_MIN_Z = 8;
const PICKUP_LOS_MAX_Z = 64;
/** Surfaces with a normal z at least this are floors (a knife sticks in them). */
const FLOOR_NZ = 0.7;
/** Speed at which a knife that cannot stick leaves the wall or ceiling before it drops. */
const KNIFE_DROP_SPEED = 40;
/** Grace after a teleport (stale positions in flight are ignored for fall checks). */
const TELEPORT_GRACE_MS = 1000;
const HISTORY_TICKS = Math.ceil(INF_HISTORY_MS / INF_STEP_MS);
/** Enough observations for 400 ms at 64 Hz, plus slack for uneven updates. */
const HISTORY_SAMPLES = HISTORY_TICKS + 3;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
/** Kill height when the map has no teleport zones. */
const FALLBACK_KILL_Z = -32768;

export interface InfPlayerPos {
	x: number;
	y: number;
	z: number;
	ducked: boolean;
	yaw?: number;
	/** View pitch (Source degrees, positive = down): the raised arms of the model follow it. */
	pitch?: number;
	/** Velocity (u/s) and ground state: the hit body leans, runs and jumps with them. Absent: standing. */
	vx?: number;
	vy?: number;
	vz?: number;
	onGround?: boolean;
}

export interface InfPlayerView {
	id: number;
	team: InfTeam;
	alpha: boolean;
	hp: number;
	alive: boolean;
	score: number;
	kills: number;
	deaths: number;
	weapon: WeaponId;
	hasKnife: boolean;
	/** An active respawn beacon of this player is on the map. */
	hasBeacon: boolean;
	/** Survivor kills of infected this life (0 for infected). */
	streak: number;
	/** Active kill streak perks (survivors; [] for infected). */
	perks: InfPerkId[];
	/** May call a M.O.A.B. now (`callMoab`). */
	moabReady: boolean;
}

/** A placed respawn beacon; `z` is its floor point. */
export interface InfBeaconView {
	id: number;
	ownerId: number;
	x: number;
	y: number;
	z: number;
	yaw: number;
}

/** Knife orientation: yaw (deg, 0 = +X), pitch (deg, Source convention: positive = down). */
export interface InfKnifeView {
	id: number;
	ownerId: number;
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	pitch: number;
	yaw: number;
	stuck: boolean;
}

export interface InfStateView {
	phase: InfPhase;
	round: number;
	/** Seconds until the grace period / round / summary ends (0 while waiting). */
	timeLeft: number;
	loadout: WeaponId;
	/** Survivor secondary (slot 2). */
	secondary: WeaponId;
	/** A called M.O.A.B. counting down (seconds left), or null. */
	moab: { callerId: number; timeLeft: number } | null;
	alphaId: number | null;
	/** Living survivors. */
	survivors: number;
	/** Infected players (alive or respawning). */
	infected: number;
	players: InfPlayerView[];
	knives: InfKnifeView[];
	beacons: InfBeaconView[];
}

export type InfEvent =
	| { e: 'phase'; phase: InfPhase; round: number; loadout: WeaponId }
	| {
			e: 'spawn';
			id: number;
			x: number;
			y: number;
			z: number;
			yaw: number;
			hp: number;
			team: InfTeam;
			alpha: boolean;
			weapon: WeaponId;
			mag: number;
			reserve: number;
			hasKnife: boolean;
			reason: InfSpawnReason;
	  }
	| { e: 'alpha'; id: number }
	/** `dx`, `dy` (throwing knife and bank shot): unit horizontal direction the knife travelled when it hit, for the victim's hit-direction cue. */
	| { e: 'infect'; id: number; by: number | null; method: InfMethod; timeAdded: number; dx?: number; dy?: number }
	| { e: 'hit'; by: number; targetId: number; head: boolean; kill: boolean }
	| { e: 'kill'; by: number; targetId: number; weapon: WeaponId; head: boolean; x: number; y: number; z: number; yaw: number }
	/**
	 * `pellets` (shotguns): every pellet after the first as flat
	 * `[dx, dy, dz, len, ...]` (unit direction, length to the first surface or the
	 * last pierced hit), so other clients draw one tracer per pellet.
	 */
	| { e: 'shot'; by: number; weapon: WeaponId; o: Vec3; d: Vec3; len: number; pellets?: number[] }
	/** `dx`, `dy`: unit horizontal direction the hit travelled (attacker towards victim), also when the knockback is 0. */
	| { e: 'hurt'; id: number; hp: number; stacks: number; kx: number; ky: number; dx?: number; dy?: number }
	| { e: 'ammo'; id: number; weapon: WeaponId; mag: number; reserve: number; scavenger?: boolean }
	/**
	 * `id` started reloading `weapon`: the other players hear and see it (the reloader's client plays
	 * its own, so it is not sent to them). `ms`: how long the reload takes the player (the weapon's time,
	 * shorter with sleight of hand); 0: the reload that was running ended early (a weapon swap). Read it
	 * with `infReloadMs`.
	 */
	| { e: 'reload'; id: number; weapon: WeaponId; ms?: number }
	| { e: 'knifeThrow'; id: number; ownerId: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
	| { e: 'knifeBounce'; id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
	| { e: 'knifeStick'; id: number; ownerId: number; x: number; y: number; z: number; pitch: number; yaw: number }
	| { e: 'knifePickup'; id: number; ownerId: number }
	| { e: 'knifeRemove'; id: number }
	| { e: 'beaconPlace'; id: number; ownerId: number; x: number; y: number; z: number; yaw: number }
	/** `by`: the survivor who destroyed it, or null when it was cleaned up (replaced, owner left, round over). */
	| { e: 'beaconDestroy'; id: number; ownerId: number; by: number | null; x: number; y: number; z: number }
	/** The owner respawned on it (it is gone). */
	| { e: 'beaconUse'; id: number; ownerId: number; x: number; y: number; z: number }
	| { e: 'uav'; targetId: number; x: number; y: number; z: number }
	/** A survivor's kill streak unlocked `perk` (never hardline). */
	| { e: 'perk'; id: number; perk: InfPerkId; streak: number }
	/** The survivor may call a M.O.A.B. (to them only). */
	| { e: 'moabReady'; id: number }
	| { e: 'moabCall'; by: number; secs: number }
	/** Every living infected died (`kills`); the survivors win the round. */
	| { e: 'moabDetonate'; by: number; kills: number }
	/** `stats`: one row per player of the round (for the round summary); `nextLoadout`: the next round's survivor primary. */
	| {
			e: 'end';
			winner: 'survivors' | 'infected';
			round: number;
			secs: number;
			survivorsLeft: number;
			topId: number | null;
			topScore: number;
			stats?: InfRoundStat[];
			nextLoadout?: WeaponId;
	  };

/** Round summary row of one player (`end` event). */
export interface InfRoundStat {
	id: number;
	/** Team when the round ended. */
	team: InfTeam;
	/** Was Patient Zero this round. */
	alpha: boolean;
	score: number;
	/** Infected killed as a survivor. */
	kills: number;
	/** Survivors infected (as Patient Zero or infected). */
	infections: number;
	deaths: number;
	/** Trigger pulls with a gun while the round was played, and how many of them hit a player. */
	shots: number;
	hits: number;
	/** Trigger pulls that hit at least one player in the head. */
	headshots: number;
	/** Longest survivor kill streak this round. */
	bestStreak: number;
	/** Seconds survived as a survivor (the whole round for a survivor at the end). */
	survivedSecs: number;
}

/** Who receives an event: one player (`to`), everyone except one (`except`), or everyone. */
export function infEventRoute(ev: InfEvent): { to?: number; except?: number } {
	switch (ev.e) {
		case 'spawn':
		case 'ammo':
		case 'hurt':
		case 'moabReady':
			return { to: ev.id };
		case 'hit':
			return { to: ev.by };
		case 'shot':
			return { except: ev.by };
		case 'reload':
			return { except: ev.id };
		default:
			return {};
	}
}

/** Longest reload a `reload` event can name (ms). */
export const INF_RELOAD_MAX_MS = 10_000;

/**
 * Length (ms) of the reload a `reload` event starts; 0 when the event ends a
 * running one, or names a weapon that has nothing to reload. A missing or
 * malformed `ms` counts as the weapon's own reload time.
 */
export function infReloadMs(ev: { weapon: unknown; ms?: unknown }): number {
	const full = isWeaponId(ev.weapon) ? WEAPONS[ev.weapon].reloadMs : 0;
	const ms = ev.ms;
	if (full <= 0 || ms === 0) return 0;
	return typeof ms === 'number' && ms > 0 && ms <= INF_RELOAD_MAX_MS ? ms : full;
}

export interface InfFire {
	weapon: WeaponId;
	origin: Vec3;
	dir: Vec3;
	/** Sim tick the shooter saw (lag compensation); clamped to the history. Not used when `rewindMs` is given. */
	tick: number;
	/**
	 * Live clients: age (ms) of the poses on the shooter's screen (`infRewindMs`
	 * of their ping). The hit test uses the poses of `now - rewindMs`,
	 * interpolated between history samples and clamped to INF_HISTORY_MS.
	 */
	rewindMs?: number;
}

export interface InfActionResult {
	ok: boolean;
	reason?: string;
	events: InfEvent[];
}

interface InfPlayer {
	id: number;
	/** Stable identity for the round bench (rejoin restore). */
	key: string;
	/** Bumped on every (re)spawn as infected: knives remember the life that threw them. */
	life: number;
	team: InfTeam;
	alpha: boolean;
	hp: number;
	alive: boolean;
	score: number;
	kills: number;
	deaths: number;
	/** Held weapon: `primaryWs`, `secondaryWs` or `meleeWs`. */
	ws: WeaponState;
	/** Round preset gun (survivors); kept across weapon swaps. */
	primaryWs: WeaponState;
	/** Pistol (survivors); its own magazine and reserve. */
	secondaryWs: WeaponState;
	/** Knife (survivors) or claws (infected). */
	meleeWs: WeaponState;
	hasKnife: boolean;
	pos: InfPlayerPos | null;
	graceUntil: number;
	/** Infected: respawns at this sim time while not alive. */
	respawnAt: number;
	/** Recent poses for lag compensation; cleared on every spawn/teleport, so it never rewinds past one. */
	hist: PoseHistory;
	/** The body as the characters show it, stepped towards every state (hit poses). */
	body: PlayerBody;
	/** Round stats (stats.ts); follow the player through the bench like the score. */
	stats: InfTally;
	slowUntil: number;
	slowStacks: number;
	/** Earliest time (ms) of the next beacon placement. */
	nextBeaconAt: number;
	/** Survivor: infected killed this life (perks, M.O.A.B.). */
	streak: number;
	/** Survivor: a M.O.A.B. is earned and not called yet. */
	moabReady: boolean;
}

interface Beacon {
	id: number;
	ownerId: number;
	x: number;
	y: number;
	z: number;
	yaw: number;
}

interface Knife {
	id: number;
	ownerId: number;
	pos: Vec3;
	vel: Vec3;
	pitch: number;
	yaw: number;
	stuck: boolean;
	bounces: number;
	bornAt: number;
	/** Owner's `life` at the throw. */
	life: number;
	/** False once the knife dropped off a wall or ceiling (it no longer infects). */
	lethal: boolean;
}

/** Round stats of a player who left mid-round (restored if they come back). */
interface Benched {
	score: number;
	kills: number;
	deaths: number;
	/** Comes back holding a knife (held one, or was dead and due a fresh one). */
	knife: boolean;
	stats: InfTally;
}

type Teleport = Extract<Zone, { type: 'teleport' }>;

export interface InfectedGameOptions {
	map: Pick<MapDef, 'spawn' | 'spawns' | 'zones'>;
	world: CollisionWorld;
	now: number;
	rng?: () => number;
	graceSecs?: number;
	roundSecs?: number;
	endSecs?: number;
	respawnSecs?: number;
	minPlayers?: number;
	/** Server: looser fire/reload timing (ZM_FIRE_TOLERANCE, ZM_RELOAD_TOLERANCE). */
	lenient?: boolean;
	/** Survivor kill streak that earns a M.O.A.B. (INF_MOAB_KILLS). */
	moabKills?: number;
	/** M.O.A.B. countdown (INF_MOAB_COUNTDOWN_SECS). */
	moabCountdownSecs?: number;
}

/** Survivor preset for round `round` (1-based). */
export function infLoadout(round: number): WeaponId {
	const n = INF_PRESETS.length;
	return INF_PRESETS[(((Math.max(1, round) - 1) % n) + n) % n]!;
}

/** Keep a claimed velocity within what the mode's movement can do, in place. The server poses the hit body with it and clients draw it. */
export function clampInfVelocity(v: { vx: number; vy: number; vz: number }): void {
	const axis = (x: number) => Math.max(-SURF_CVARS.sv_maxvelocity, Math.min(SURF_CVARS.sv_maxvelocity, x));
	const vx = axis(v.vx);
	const vy = axis(v.vy);
	const f = Math.min(1, INF_SPEED_LIMIT / (Math.hypot(vx, vy) || 1));
	v.vx = vx * f;
	v.vy = vy * f;
	v.vz = axis(v.vz);
}

/** Velocity of a state packet for the hit body, clamped. A component that is not a number keeps its last value. */
function bodyVelocity(pos: InfPlayerPos, last: InfPlayerPos | null): [number, number, number] {
	const axis = (v: number | undefined, was: number | undefined) => (v === undefined ? 0 : Number.isFinite(v) ? v : (was ?? 0));
	const v = { vx: axis(pos.vx, last?.vx), vy: axis(pos.vy, last?.vy), vz: axis(pos.vz, last?.vz) };
	clampInfVelocity(v);
	return [v.vx, v.vy, v.vz];
}

/** Pitch (Source: positive = down) and yaw in degrees of a direction. */
function angles(v: Vec3): { pitch: number; yaw: number } {
	const h = Math.hypot(v.x, v.y);
	return { pitch: (-Math.atan2(v.z, h) * 180) / Math.PI, yaw: (Math.atan2(v.y, v.x) * 180) / Math.PI };
}

const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

export class InfectedGame {
	phase: InfPhase = 'waiting';
	round = 0;
	/** Grace / round / summary end (ms). */
	endsAt = 0;
	/** Playing phase start (ms). */
	startedAt = 0;
	/** Survivor preset of the current (or next, while waiting) round. */
	roundLoadout: WeaponId = INF_PRESETS[0]!;
	alphaId: number | null = null;
	/** Survivors infected this round. */
	infections = 0;
	/** A called M.O.A.B.: detonates at `detonatesAt` (ms). */
	moab: { callerId: number; detonatesAt: number } | null = null;
	tick = 0;
	/** Sim clock (ms). */
	simTime: number;
	readonly world: CollisionWorld;
	private readonly spawns: Spawn[];
	private readonly teleports: Teleport[];
	private readonly killZ: number;
	private readonly players = new Map<number, InfPlayer>();
	private readonly knives = new Map<number, Knife>();
	/** Respawn beacons by owner id (one per player). */
	private readonly beacons = new Map<number, Beacon>();
	private readonly rng: () => number;
	private readonly graceMs: number;
	private readonly roundMs: number;
	private readonly endMs: number;
	private readonly respawnMs: number;
	private readonly minPlayers: number;
	private readonly lenient: boolean;
	private readonly moabKills: number;
	private readonly moabCountdownMs: number;
	private nextKnifeId = 1;
	private nextBeaconId = 1;
	private nextUavAt = 0;
	/** Scratch pose (current pose of a player for the history and knife tests). */
	private readonly scratch: PlayerPose = { x: 0, y: 0, z: 0, yaw: 0, ducked: false, hunched: false };
	private readonly bodyInput: BodyInput = { vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, ducked: false };
	private pending: InfEvent[] = [];
	/** Players who left this round, by key. */
	private readonly bench = new Map<string, Benched>();

	constructor(opts: InfectedGameOptions) {
		this.world = opts.world;
		this.spawns = tagSpawns(opts.map);
		this.teleports = opts.map.zones.filter((z): z is Teleport => z.type === 'teleport');
		this.killZ = this.teleports.length > 0 ? Math.max(...this.teleports.map((t) => t.max.z)) : FALLBACK_KILL_Z;
		this.rng = opts.rng ?? Math.random;
		this.graceMs = (opts.graceSecs ?? INF_GRACE_SECS) * 1000;
		this.roundMs = (opts.roundSecs ?? INF_ROUND_SECS) * 1000;
		this.endMs = (opts.endSecs ?? INF_END_SECS) * 1000;
		this.respawnMs = (opts.respawnSecs ?? INF_RESPAWN_SECS) * 1000;
		this.minPlayers = opts.minPlayers ?? INF_MIN_PLAYERS;
		this.lenient = opts.lenient ?? false;
		this.moabKills = Math.max(1, opts.moabKills ?? INF_MOAB_KILLS);
		this.moabCountdownMs = (opts.moabCountdownSecs ?? INF_MOAB_COUNTDOWN_SECS) * 1000;
		this.simTime = opts.now;
	}

	// ---------------------------------------------------------------------
	// Players

	/**
	 * Active (non-spectating) players. New ones join; missing ones leave.
	 * `keys` maps ids to a stable identity (the server's player id) so a
	 * reconnect under a new id, or another player reusing an id, is told apart.
	 */
	syncPlayers(ids: Iterable<number>, now: number, keys?: ReadonlyMap<number, string>): void {
		const want = new Set(ids);
		let lostInfected = false;
		for (const [id, p] of [...this.players]) {
			const key = keys?.get(id);
			if (want.has(id)) {
				// Same id, another identity (an id reused by the server): the old player left.
				if (key === undefined || key === p.key) continue;
				if (p.key === `#${id}`) {
					p.key = key; // keys given for the first time
					continue;
				}
			}
			if (p.team === 'infected') lostInfected = true;
			if (this.phase !== 'waiting') {
				// Survivors and dead infected are due a fresh knife; a living infected keeps what they held.
				const knife = p.team !== 'infected' || !p.alive || p.hasKnife;
				this.stopSurviving(p);
				this.bench.set(p.key, { score: p.score, kills: p.kills, deaths: p.deaths, knife, stats: p.stats });
			}
			this.players.delete(id);
			if (this.alphaId === id) this.alphaId = null;
			for (const k of [...this.knives.values()]) if (k.ownerId === id) this.removeKnife(k);
			this.removeBeacon(id, null);
		}
		for (const id of want) {
			if (this.players.has(id)) continue;
			const p = this.newPlayer(id, keys?.get(id) ?? `#${id}`);
			this.players.set(id, p);
			const b = this.phase === 'waiting' ? undefined : this.bench.get(p.key);
			if (b) {
				this.bench.delete(p.key);
				p.score = b.score;
				p.kills = b.kills;
				p.deaths = b.deaths;
				p.stats = b.stats;
			}
			if (this.phase === 'playing') {
				this.makeInfected(p, false);
				if (b) p.hasKnife = b.knife;
				this.spawnEvent(p, this.spawnAwayFrom('survivor'), now, 'join');
			} else {
				this.makeSurvivor(p);
				this.spawnEvent(p, this.randomSpawn(), now, 'join');
			}
		}
		if (this.phase === 'playing' && lostInfected && this.players.size >= this.minPlayers && this.infectedCount() === 0) {
			this.replaceInfected();
		}
	}

	setPlayerPos(id: number, pos: InfPlayerPos, teleported = false): void {
		const p = this.players.get(id);
		if (!p || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
		// The hitboxes turn with the yaw, their arms with the pitch: one that is not a number keeps the last one.
		const yaw = pos.yaw === undefined || Number.isFinite(pos.yaw) ? pos.yaw : (p.pos?.yaw ?? 0);
		const pitch = pos.pitch === undefined || Number.isFinite(pos.pitch) ? pos.pitch : (p.pos?.pitch ?? 0);
		// The body moves with the velocity: the same, within what the mode's movement can do.
		if (teleported) {
			p.hist.clear();
			p.body.reset();
		}
		const [vx, vy, vz] = bodyVelocity(pos, teleported ? null : p.pos);
		const onGround = pos.onGround !== false;
		if (!p.pos) p.pos = { ...pos, yaw, pitch, vx, vy, vz, onGround };
		else {
			p.pos.x = pos.x;
			p.pos.y = pos.y;
			p.pos.z = pos.z;
			p.pos.ducked = pos.ducked;
			p.pos.yaw = yaw;
			p.pos.pitch = pitch;
			p.pos.vx = vx;
			p.pos.vy = vy;
			p.pos.vz = vz;
			p.pos.onGround = onGround;
		}
	}

	hasPlayer(id: number): boolean {
		return this.players.has(id);
	}

	playerView(id: number): InfPlayerView | null {
		const p = this.players.get(id);
		if (!p) return null;
		return {
			id,
			team: p.team,
			alpha: p.alpha,
			hp: p.hp,
			alive: p.alive,
			score: p.score,
			kills: p.kills,
			deaths: p.deaths,
			weapon: p.ws.weapon,
			hasKnife: p.hasKnife,
			hasBeacon: this.beacons.has(id),
			streak: p.streak,
			perks: p.team === 'survivor' ? infPerksForStreak(p.streak) : [],
			moabReady: p.moabReady
		};
	}

	/** Held weapon state of a player (read-only use: HUD, tests). */
	weaponOf(id: number): WeaponState | null {
		return this.players.get(id)?.ws ?? null;
	}

	/** Primary (preset) weapon state of a player. */
	primaryOf(id: number): WeaponState | null {
		return this.players.get(id)?.primaryWs ?? null;
	}

	/** Secondary (pistol) weapon state of a player. */
	secondaryOf(id: number): WeaponState | null {
		return this.players.get(id)?.secondaryWs ?? null;
	}

	/** Max run speed of a player at `now` (held weapon, steady aim perk, hit slows). */
	moveSpeed(id: number, now = this.simTime): number {
		const p = this.players.get(id);
		if (!p) return INF_INFECTED_SPEED;
		const base = p.ws.weapon === 'claws' ? INF_INFECTED_SPEED : WEAPONS[p.ws.weapon].moveSpeed;
		const perk = this.hasPerk(p, 'steady') ? INF_STEADY_SPEED_FACTOR : 1;
		return base * perk * zmSlowFactor(now < p.slowUntil ? p.slowStacks : 0);
	}

	/** Survivor kill streak perk active. */
	private hasPerk(p: InfPlayer, perk: InfPerkId): boolean {
		return p.team === 'survivor' && p.streak >= INF_PERK_KILLS[perk];
	}

	private newPlayer(id: number, key: string): InfPlayer {
		const primaryWs = this.weaponState(this.roundLoadout);
		return {
			id,
			key,
			life: 0,
			team: 'survivor',
			alpha: false,
			hp: INF_SURVIVOR_HP,
			alive: true,
			score: 0,
			kills: 0,
			deaths: 0,
			ws: primaryWs,
			primaryWs,
			secondaryWs: this.weaponState(INF_SECONDARY),
			meleeWs: this.weaponState('knife'),
			hasKnife: false,
			pos: null,
			graceUntil: 0,
			respawnAt: 0,
			hist: new PoseHistory(HISTORY_SAMPLES),
			body: new PlayerBody(),
			stats: newInfTally(),
			slowUntil: 0,
			slowStacks: 0,
			nextBeaconAt: 0,
			streak: 0,
			moabReady: false
		};
	}

	private weaponState(w: WeaponId): WeaponState {
		const ws = this.lenient ? new WeaponState(w, ZM_FIRE_TOLERANCE, ZM_RELOAD_TOLERANCE) : new WeaponState(w);
		this.limitAmmo(ws);
		return ws;
	}

	/** Fresh preset gun and pistol with the mode's limited ammo. */
	private freshGuns(p: InfPlayer): void {
		p.primaryWs.equip(this.roundLoadout);
		this.limitAmmo(p.primaryWs);
		p.secondaryWs.equip(INF_SECONDARY);
		this.limitAmmo(p.secondaryWs);
	}

	private limitAmmo(ws: WeaponState): void {
		const a = INF_AMMO[ws.weapon];
		if (!a) return;
		ws.mag = a.mag;
		ws.reserve = a.reserve;
	}

	private makeSurvivor(p: InfPlayer): void {
		p.team = 'survivor';
		p.alpha = false;
		p.hp = INF_SURVIVOR_HP;
		p.alive = true;
		p.hasKnife = false;
		p.respawnAt = 0;
		p.slowUntil = 0;
		p.slowStacks = 0;
		p.streak = 0;
		p.moabReady = false;
		this.freshGuns(p);
		p.meleeWs.equip('knife');
		p.ws = p.primaryWs;
	}

	/** Infected: claws and the throwing knife; `alpha`: Patient Zero. */
	private makeInfected(p: InfPlayer, alpha: boolean): void {
		p.team = 'infected';
		p.alpha = alpha;
		p.life++;
		p.hp = INF_INFECTED_HP;
		p.alive = true;
		p.hasKnife = true;
		p.respawnAt = 0;
		p.slowUntil = 0;
		p.slowStacks = 0;
		p.streak = 0;
		p.moabReady = false;
		p.primaryWs.reloadEndsAt = 0;
		p.secondaryWs.reloadEndsAt = 0;
		if (p.meleeWs.weapon !== 'claws') p.meleeWs.equip('claws');
		p.ws = p.meleeWs;
	}

	private spawnEvent(p: InfPlayer, s: Spawn, now: number, reason: InfSpawnReason): void {
		p.graceUntil = now + TELEPORT_GRACE_MS;
		p.hist.clear();
		p.body.reset();
		p.pos = { x: s.pos.x, y: s.pos.y, z: s.pos.z, ducked: false, yaw: s.yaw };
		this.pending.push({
			e: 'spawn',
			id: p.id,
			x: s.pos.x,
			y: s.pos.y,
			z: s.pos.z,
			yaw: s.yaw,
			hp: p.hp,
			team: p.team,
			alpha: p.alpha,
			weapon: p.ws.weapon,
			mag: p.ws.mag,
			reserve: p.ws.reserve,
			hasKnife: p.hasKnife,
			reason
		});
	}

	private ammoEvent(p: InfPlayer, ws: WeaponState = p.ws, scavenger = false): void {
		const ev: InfEvent = { e: 'ammo', id: p.id, weapon: ws.weapon, mag: ws.mag, reserve: ws.reserve };
		if (scavenger) ev.scavenger = true;
		this.pending.push(ev);
	}

	private livingSurvivors(): InfPlayer[] {
		const out: InfPlayer[] = [];
		for (const p of this.players.values()) if (p.alive && p.team === 'survivor') out.push(p);
		return out;
	}

	private infectedCount(): number {
		let n = 0;
		for (const p of this.players.values()) if (p.team === 'infected') n++;
		return n;
	}

	private randomSpawn(): Spawn {
		const list = this.spawns;
		return list[Math.min(list.length - 1, Math.floor(this.rng() * list.length))]!;
	}

	/** The spawn farthest (max of the min distance) from living players of `team`; random if none. */
	private spawnAwayFrom(team: InfTeam): Spawn {
		const others: Vec3[] = [];
		for (const p of this.players.values()) if (p.alive && p.team === team && p.pos) others.push(p.pos);
		if (others.length === 0) return this.randomSpawn();
		let best = this.spawns[0]!;
		let bestD = -1;
		for (const s of this.spawns) {
			let d = Infinity;
			for (const o of others) d = Math.min(d, Math.hypot(s.pos.x - o.x, s.pos.y - o.y, s.pos.z - o.z));
			if (d > bestD) {
				bestD = d;
				best = s;
			}
		}
		return best;
	}

	/** Every infected left mid-round: a random survivor takes over. */
	private replaceInfected(): void {
		const surv = this.livingSurvivors();
		if (surv.length === 0) return;
		const p = surv[Math.min(surv.length - 1, Math.floor(this.rng() * surv.length))]!;
		const alpha = this.infections === 0;
		this.stopSurviving(p);
		this.makeInfected(p, alpha);
		this.ammoEvent(p);
		if (alpha) {
			p.stats.alpha = true;
			this.alphaId = p.id;
			this.pending.push({ e: 'alpha', id: p.id });
		} else this.pending.push({ e: 'infect', id: p.id, by: null, method: 'claws', timeAdded: 0 });
	}

	// ---------------------------------------------------------------------
	// Player actions

	/** Survivors swap between the round preset [1], the pistol [2] and the knife [3]. */
	selectWeapon(id: number, weapon: unknown, now: number): InfEvent[] {
		const p = this.players.get(id);
		if (!p || !p.alive || !isWeaponId(weapon)) return [];
		if (p.team !== 'survivor') return [];
		const next =
			weapon === 'knife' ? p.meleeWs : weapon === this.roundLoadout ? p.primaryWs : weapon === INF_SECONDARY ? p.secondaryWs : null;
		if (!next || next.weapon !== weapon) return [];
		let cancelled: WeaponId | null = null;
		if (p.ws !== next) {
			if (p.ws.reloading(now)) cancelled = p.ws.weapon;
			p.ws.reloadEndsAt = 0; // switching away cancels a reload
			p.ws = next;
			// The draw: no shot before deployMs (× the fire tolerance on the server, like the fire rate).
			next.deploy(now);
		}
		const events: InfEvent[] = [{ e: 'ammo', id, weapon: p.ws.weapon, mag: p.ws.mag, reserve: p.ws.reserve }];
		// The others see the reload; swaps themselves are not relayed.
		if (cancelled) events.push({ e: 'reload', id, weapon: cancelled, ms: 0 });
		return events;
	}

	/**
	 * Start a reload of the held gun; false when it is refused (no gun held, a
	 * full magazine, no reserve, already reloading). A reload that starts queues
	 * a `reload` event for the other players: `takeEvents` returns it at once,
	 * the next `update` otherwise. Its `ms` is the time on the player's own
	 * screen: the server's shorter tolerance is for jitter only.
	 */
	reload(id: number, now: number): boolean {
		const p = this.players.get(id);
		if (!p || !p.alive) return false;
		const factor = this.hasPerk(p, 'sleight') ? INF_SLEIGHT_RELOAD_FACTOR : 1;
		if (!p.ws.startReload(now, factor)) return false;
		this.pending.push({ e: 'reload', id, weapon: p.ws.weapon, ms: Math.round(p.ws.def.reloadMs * factor) });
		return true;
	}

	/** The events queued by calls that return none themselves (`reload`, `syncPlayers`), without waiting for the next `update`. */
	takeEvents(): InfEvent[] {
		return this.flush();
	}

	/** Call the earned M.O.A.B. (survivor with `moabReady`, while playing, none inbound). */
	callMoab(id: number, now: number): InfActionResult {
		const p = this.players.get(id);
		if (!p) return { ok: false, reason: 'not playing', events: [] };
		if (!p.alive || p.team !== 'survivor') return { ok: false, reason: 'not a survivor', events: [] };
		if (this.phase !== 'playing') return { ok: false, reason: 'no round', events: [] };
		if (!p.moabReady) return { ok: false, reason: 'not earned', events: [] };
		if (this.moab) return { ok: false, reason: 'already inbound', events: [] };
		p.moabReady = false;
		this.moab = { callerId: id, detonatesAt: now + this.moabCountdownMs };
		this.pending.push({ e: 'moabCall', by: id, secs: this.moabCountdownMs / 1000 });
		return { ok: true, events: this.flush() };
	}

	/** Resolve a shot or swing (server-authoritative, lag-compensated against the pose history). */
	fire(id: number, shot: InfFire, now: number): InfActionResult {
		const p = this.players.get(id);
		const reject = (reason: string): InfActionResult => ({
			ok: false,
			reason,
			events: p ? [{ e: 'ammo', id, weapon: p.ws.weapon, mag: p.ws.mag, reserve: p.ws.reserve }] : []
		});
		if (!p) return { ok: false, reason: 'not playing', events: [] };
		if (!p.alive) return { ok: false, reason: 'dead', events: [] };
		if (this.phase === 'waiting') return reject('no round');
		if (!isWeaponId(shot.weapon) || shot.weapon !== p.ws.weapon) return reject('wrong weapon');
		const aim = this.checkAim(p, shot.origin, shot.dir);
		if (typeof aim === 'string') return reject(aim);
		const cadence = this.hasPerk(p, 'specialist') ? INF_SPECIALIST_CADENCE_FACTOR : 1;
		if (!p.ws.fire(now, cadence)) return reject(p.ws.reloading(now) ? 'reloading' : p.ws.mag <= 0 ? 'empty' : 'too fast');
		const tick = Number.isFinite(shot.tick) ? shot.tick : this.tick;
		const rewind = shot.rewindMs;
		const at = typeof rewind === 'number' && Number.isFinite(rewind) ? now - Math.max(0, Math.min(INF_HISTORY_MS, rewind)) : null;
		// A copy: the event carries the origin on to the other clients.
		this.resolveShot(p, { x: shot.origin.x, y: shot.origin.y, z: shot.origin.z }, aim, tick, at, now);
		return { ok: true, events: this.flush() };
	}

	/** Throw the throwing knife (infected only, while playing). */
	throwKnife(id: number, origin: Vec3, dir: Vec3, now: number, rewindMs = 0): InfActionResult {
		const p = this.players.get(id);
		if (!p) return { ok: false, reason: 'not playing', events: [] };
		if (!p.alive) return { ok: false, reason: 'dead', events: [] };
		if (p.team !== 'infected') return { ok: false, reason: 'not infected', events: [] };
		if (this.phase !== 'playing') return { ok: false, reason: 'no round', events: [] };
		if (!p.hasKnife) return { ok: false, reason: 'no knife', events: [] };
		const aim = this.checkAim(p, origin, dir);
		if (typeof aim === 'string') return { ok: false, reason: aim, events: [] };
		// The knife hull spawns KNIFE_SPAWN_DIST ahead (traced). An origin hugging a
		// surface (hull in solid) falls back to the server-known eye.
		let start: Vec3 = { x: origin.x, y: origin.y, z: origin.z };
		let tr = this.world.trace(start, this.ahead(start, aim, KNIFE_SPAWN_DIST), INF_KNIFE_MIN, INF_KNIFE_MAX);
		if (tr.startsolid && p.pos) {
			start = this.eyeOf(p.pos);
			tr = this.world.trace(start, this.ahead(start, aim, KNIFE_SPAWN_DIST), INF_KNIFE_MIN, INF_KNIFE_MAX);
		}
		if (tr.startsolid) return { ok: false, reason: 'blocked', events: [] };
		p.hasKnife = false;
		const vel = { x: aim.x * INF_KNIFE_SPEED, y: aim.y * INF_KNIFE_SPEED, z: aim.z * INF_KNIFE_SPEED };
		const k: Knife = {
			id: this.nextKnifeId,
			ownerId: id,
			pos: { ...tr.endpos },
			vel,
			...angles(vel),
			stuck: false,
			bounces: 0,
			bornAt: this.simTime,
			life: p.life,
			lethal: true
		};
		this.nextKnifeId = this.nextKnifeId >= 65535 ? 1 : this.nextKnifeId + 1;
		this.knives.set(k.id, k);
		this.pending.push({ e: 'knifeThrow', id: k.id, ownerId: id, x: k.pos.x, y: k.pos.y, z: k.pos.z, vx: vel.x, vy: vel.y, vz: vel.z });
		// Point blank: a survivor between the eye and the spawn point is hit at once.
		const victim = this.knifeVictim(start, aim, tr.fraction * KNIFE_SPAWN_DIST, now, rewindMs);
		if (victim) {
			this.removeKnife(k);
			this.infect(victim, p, 'knife', aim);
		}
		return { ok: true, events: this.flush() };
	}

	/** Place a respawn beacon on the walkable ground below (living infected, while playing). */
	placeBeacon(id: number, now: number): InfActionResult {
		const p = this.players.get(id);
		if (!p) return { ok: false, reason: 'not playing', events: [] };
		if (!p.alive) return { ok: false, reason: 'dead', events: [] };
		if (p.team !== 'infected') return { ok: false, reason: 'not infected', events: [] };
		if (this.phase !== 'playing') return { ok: false, reason: 'no round', events: [] };
		const pos = p.pos;
		if (!pos) return { ok: false, reason: 'no position', events: [] };
		if (now < p.nextBeaconAt) return { ok: false, reason: 'cooldown', events: [] };
		const below = { x: pos.x, y: pos.y, z: pos.z - BEACON_DROP_DIST };
		let down = this.world.trace(pos, below, HULL_MIN, HULL_MAX);
		// A position reported flush on the floor starts in solid: retry from a little above the feet.
		if (down.startsolid) down = this.world.trace({ x: pos.x, y: pos.y, z: pos.z + BEACON_TRACE_LIFT }, below, HULL_MIN, HULL_MAX);
		if (down.startsolid) return { ok: false, reason: 'blocked', events: [] };
		if (down.fraction >= 1 || down.plane.normal.z < FLOOR_NZ) return { ok: false, reason: 'no ground', events: [] };
		const floor = { x: pos.x, y: pos.y, z: down.endpos.z };
		if (floor.z < this.killZ || this.teleports.some((t) => hullInBox(floor, false, t))) return { ok: false, reason: 'blocked', events: [] };
		if (this.world.trace(floor, floor, HULL_MIN, HULL_MAX).startsolid) return { ok: false, reason: 'blocked', events: [] };
		this.removeBeacon(id, null);
		const b: Beacon = { id: this.nextBeaconId, ownerId: id, ...floor, yaw: pos.yaw ?? 0 };
		this.nextBeaconId = this.nextBeaconId >= 65535 ? 1 : this.nextBeaconId + 1;
		this.beacons.set(id, b);
		p.nextBeaconAt = now + INF_BEACON_COOLDOWN_MS;
		this.pending.push({ e: 'beaconPlace', id: b.id, ownerId: id, x: b.x, y: b.y, z: b.z, yaw: b.yaw });
		return { ok: true, events: this.flush() };
	}

	private removeBeacon(ownerId: number, by: number | null): void {
		const b = this.beacons.get(ownerId);
		if (!b) return;
		this.beacons.delete(ownerId);
		this.pending.push({ e: 'beaconDestroy', id: b.id, ownerId, by, x: b.x, y: b.y, z: b.z });
	}

	private clearBeacons(): void {
		for (const id of [...this.beacons.keys()]) this.removeBeacon(id, null);
	}

	/** Survivor shot or swing: every beacon it reaches is destroyed (one hit each). */
	private hitBeacons(p: InfPlayer, o: Vec3, d: Vec3, melee: boolean, range: number, coneDeg: number, worldT: number): void {
		if (p.team !== 'survivor' || this.phase !== 'playing') return;
		for (const b of [...this.beacons.values()]) {
			const c = { x: b.x, y: b.y, z: b.z + INF_BEACON_HIT_Z };
			if (melee) {
				const vx = c.x - o.x;
				const vy = c.y - o.y;
				const vz = c.z - o.z;
				const dist = Math.hypot(vx, vy, vz);
				if (dist - INF_BEACON_HIT_RADIUS > range) continue;
				if (dist > 1e-6) {
					const cos = (vx * d.x + vy * d.y + vz * d.z) / dist;
					// Like melee on players: very close counts at the edge of the screen.
					const cone = dist < INF_BEACON_HIT_RADIUS * 2 ? coneDeg * 1.6 : coneDeg;
					if (cos < Math.cos((cone * Math.PI) / 180)) continue;
				}
				if (this.world.trace(o, c, ZERO, ZERO).fraction < 1) continue;
			} else {
				const t = raySphere(o, d, c.x, c.y, c.z, INF_BEACON_HIT_RADIUS);
				if (t < 0 || t > worldT) continue;
			}
			p.score += INF_SCORE_BEACON_DESTROY;
			this.pending.push({ e: 'hit', by: p.id, targetId: 0, head: false, kill: true });
			this.removeBeacon(b.ownerId, p.id);
		}
	}

	private ahead(o: Vec3, d: Vec3, dist: number): Vec3 {
		return { x: o.x + d.x * dist, y: o.y + d.y * dist, z: o.z + d.z * dist };
	}

	private eyeOf(pos: InfPlayerPos): Vec3 {
		return { x: pos.x, y: pos.y, z: pos.z + (pos.ducked ? DUCK_VIEW_HEIGHT : VIEW_HEIGHT) };
	}

	/** Validate an aim origin/direction; returns the unit direction or a reject reason. */
	private checkAim(p: InfPlayer, o: Vec3, d: Vec3): Vec3 | string {
		if (!o || !d || ![o.x, o.y, o.z, d.x, d.y, d.z].every(Number.isFinite)) return 'bad shot';
		const len = Math.hypot(d.x, d.y, d.z);
		if (len < 0.9 || len > 1.1) return 'bad direction';
		if (p.pos) {
			const dz = o.z - (p.pos.z + VIEW_HEIGHT);
			if (Math.hypot(o.x - p.pos.x, o.y - p.pos.y, dz) > INF_ORIGIN_SLACK) return 'bad origin';
			// The slack must not reach through a wall: the claimed origin is in sight of the known eye.
			const los = this.world.trace(this.eyeOf(p.pos), o, ZERO, ZERO);
			if (!los.startsolid && los.fraction < 1) return 'bad origin';
		}
		return { x: d.x / len, y: d.y / len, z: d.z / len };
	}

	private flush(): InfEvent[] {
		const out = this.pending;
		this.pending = [];
		return out;
	}

	/**
	 * Current hitbox pose of a player, written into `out`. The arms are posed
	 * on the held weapon (claws for every infected), as the clients draw them.
	 * The throwing knife in the claw and the item itself are not part of the body.
	 */
	private poseOf(p: InfPlayer, pos: InfPlayerPos, out: PlayerPose): PlayerPose {
		out.x = pos.x;
		out.y = pos.y;
		out.z = pos.z;
		out.yaw = pos.yaw ?? 0;
		out.ducked = pos.ducked;
		out.hunched = p.team === 'infected';
		out.held = p.ws.weapon;
		out.pitch = pos.pitch ?? 0;
		copyMotion(p.body.motion, (out.motion ??= restMotion()));
		return out;
	}

	/**
	 * Living players of the other team with the pose the shooter saw: the pose
	 * at time `at` (ms, live clients), else the one of sim tick `tick` (the
	 * current pose for the current tick or a later one). Both are clamped to
	 * the history, which starts again at a target's (re)spawn.
	 */
	private targets(p: InfPlayer, tick: number, at: number | null, now: number): Array<{ t: InfPlayer; pose: PlayerPose }> {
		const want: InfTeam = p.team === 'survivor' ? 'infected' : 'survivor';
		const t = Math.round(Math.max(this.tick - HISTORY_TICKS, Math.min(this.tick, tick)));
		const out: Array<{ t: InfPlayer; pose: PlayerPose }> = [];
		for (const q of this.players.values()) {
			if (q === p || q.team !== want || !q.alive || !q.pos) continue;
			const pose = this.poseOf(q, q.pos, { x: 0, y: 0, z: 0, yaw: 0, ducked: false, hunched: false });
			if (at !== null) q.hist.poseAt(at, now, this.poseOf(q, q.pos, this.scratch), pose);
			else if (t < this.tick) q.hist.poseAtTick(t, this.poseOf(q, q.pos, this.scratch), pose);
			out.push({ t: q, pose });
		}
		return out;
	}

	/**
	 * One trigger pull: one ray, or `def.pellets` rays for a shotgun (pellet 0
	 * dead-centre, the rest scattered within `pelletSpread` using the game rng).
	 * Damage and knockback add up per target over all pellets: one `shot`
	 * event (with the other pellets in `pellets`), at most one `hit` (and
	 * `kill`/`hurt`) per target. `tick`/`at`: see `targets`.
	 */
	private resolveShot(p: InfPlayer, o: Vec3, d: Vec3, tick: number, at: number | null, now: number): void {
		const def = WEAPONS[p.ws.weapon];
		const melee = def.magazine === 0;
		const live = this.phase === 'grace' || this.phase === 'playing';
		const targets = live ? this.targets(p, tick, at, now) : [];
		const pellets = melee ? 1 : Math.max(1, Math.floor(def.pellets ?? 1));
		const spread = (def.pelletSpread ?? 0) * (this.hasPerk(p, 'steady') ? INF_STEADY_SPREAD_FACTOR : 1);
		const dirs = pellets > 1 ? this.pelletDirs(d, pellets, spread) : [d];
		const targetHp = p.team === 'survivor' ? INF_INFECTED_HP : INF_SURVIVOR_HP;
		const agg = new Map<InfPlayer, { pose: PlayerPose; dmg: number; kb: number; head: boolean }>();
		const pelletData: number[] = [];
		let len = 0;
		const rays = dirs.map((dir) => {
			const end = { x: o.x + dir.x * def.range, y: o.y + dir.y * def.range, z: o.z + dir.z * def.range };
			const hits: Array<{ t: InfPlayer; pose: PlayerPose; d: number; head: boolean }> = [];
			return { dir, worldT: this.world.trace(o, end, ZERO, ZERO).fraction * def.range, hits };
		});
		// Target by target, so a shotgun poses each hit body once.
		for (const tg of targets) {
			for (const { dir, worldT, hits } of rays) {
				const h = melee ? meleePlayer(o, dir, tg.pose, def.range, def.coneDeg) : rayPlayer(o, dir, tg.pose, worldT, true);
				if (!h) continue;
				if (melee && this.world.trace(o, playerUp(tg.pose, INF_MELEE_LOS_HEIGHT), ZERO, ZERO).fraction < 1) continue;
				hits.push({ ...tg, d: h.t, head: h.head });
			}
		}
		for (let i = 0; i < rays.length; i++) {
			const { dir, worldT, hits } = rays[i]!;
			hits.sort((a, b) => a.d - b.d);
			const taken = hits.slice(0, def.pierce);
			const last = taken.length > 0 && taken.length >= def.pierce ? taken[taken.length - 1]!.d : worldT;
			const pelletLen = melee ? 0 : Math.min(last, worldT);
			if (i === 0) len = pelletLen;
			else pelletData.push(round3(dir.x), round3(dir.y), round3(dir.z), round3(pelletLen));
			this.hitBeacons(p, o, dir, melee, def.range, def.coneDeg, worldT);
			for (const h of taken) {
				const a = agg.get(h.t) ?? { pose: h.pose, dmg: 0, kb: 0, head: false };
				a.dmg += hitDamage(def.id, h.head, targetHp);
				a.kb += def.knockback;
				a.head ||= h.head;
				agg.set(h.t, a);
			}
		}
		const shot: Extract<InfEvent, { e: 'shot' }> = { e: 'shot', by: p.id, weapon: def.id, o: { ...o }, d: { ...d }, len };
		if (pelletData.length > 0) shot.pellets = pelletData;
		this.pending.push(shot);
		if (!melee && this.phase === 'playing') {
			p.stats.shots++;
			if (agg.size > 0) p.stats.hits++;
			for (const a of agg.values()) {
				if (!a.head) continue;
				p.stats.headshots++;
				break;
			}
		}
		const kbFactor = this.hasPerk(p, 'specialist') ? INF_SPECIALIST_KNOCKBACK_FACTOR : 1;
		for (const [t, a] of agg) {
			if (p.team === 'survivor') this.damageInfected(t, p, def.id, a.head, a.pose, d, a.dmg, a.kb * kbFactor);
			else this.damageSurvivor(t, p, a.head);
		}
	}

	/** `n` unit pellet directions: `d` itself, then uniform in the cone of half-angle `spreadDeg` around it. */
	private pelletDirs(d: Vec3, n: number, spreadDeg: number): Vec3[] {
		// Orthonormal basis (u, v) perpendicular to d; the helper axis avoids a near-parallel cross product.
		const ax = Math.abs(d.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
		let u = { x: d.y * ax.z - d.z * ax.y, y: d.z * ax.x - d.x * ax.z, z: d.x * ax.y - d.y * ax.x };
		const ul = Math.hypot(u.x, u.y, u.z) || 1;
		u = { x: u.x / ul, y: u.y / ul, z: u.z / ul };
		const v = { x: d.y * u.z - d.z * u.y, y: d.z * u.x - d.x * u.z, z: d.x * u.y - d.y * u.x };
		const max = (Math.max(0, spreadDeg) * Math.PI) / 180;
		const out: Vec3[] = [d];
		for (let i = 1; i < n; i++) {
			const r = max * Math.sqrt(this.rng());
			const th = 2 * Math.PI * this.rng();
			const c = Math.cos(r);
			const sn = Math.sin(r);
			const x = d.x * c + (u.x * Math.cos(th) + v.x * Math.sin(th)) * sn;
			const y = d.y * c + (u.y * Math.cos(th) + v.y * Math.sin(th)) * sn;
			const z = d.z * c + (u.z * Math.cos(th) + v.z * Math.sin(th)) * sn;
			const l = Math.hypot(x, y, z) || 1;
			out.push({ x: x / l, y: y / l, z: z / l });
		}
		return out;
	}

	private slowStack(until: number, stacks: number): number {
		return this.simTime < until ? Math.min(ZM_SLOW_FACTORS.length - 1, stacks + 1) : 1;
	}

	private slowAndPush(t: InfPlayer, by: InfPlayer, kb: number, d: Vec3): void {
		t.slowStacks = this.slowStack(t.slowUntil, t.slowStacks);
		t.slowUntil = this.simTime + ZM_SLOW_MS;
		const h = Math.hypot(d.x, d.y) || 1;
		const ev: Extract<InfEvent, { e: 'hurt' }> = { e: 'hurt', id: t.id, hp: t.hp, stacks: t.slowStacks, kx: (d.x / h) * kb, ky: (d.y / h) * kb };
		this.hitDir(ev, d, by, t);
		this.pending.push(ev);
	}

	/**
	 * Unit horizontal direction of a hit into `ev.dx`, `ev.dy`: along `d`, the
	 * way the shot or the knife travelled; attacker towards victim when it
	 * came straight down or up. Left unset when neither gives a direction.
	 */
	private hitDir(ev: { dx?: number; dy?: number }, d: Vec3, by: InfPlayer | null, t: InfPlayer): void {
		let dx = d.x;
		let dy = d.y;
		let dh = Math.hypot(dx, dy);
		if (dh < 1e-3 && by?.pos && t.pos) {
			dx = t.pos.x - by.pos.x;
			dy = t.pos.y - by.pos.y;
			dh = Math.hypot(dx, dy);
		}
		if (dh >= 1e-3) {
			// `|| 0`: never -0 on the wire.
			ev.dx = round3(dx / dh) || 0;
			ev.dy = round3(dy / dh) || 0;
		}
	}

	private damageInfected(t: InfPlayer, by: InfPlayer, weapon: WeaponId, head: boolean, pose: PlayerPose, d: Vec3, dmg: number, kb: number): void {
		t.hp = Math.max(0, t.hp - dmg);
		const kill = t.hp <= 0;
		this.pending.push({ e: 'hit', by: by.id, targetId: t.id, head, kill });
		if (!kill) {
			this.slowAndPush(t, by, kb, d);
			return;
		}
		t.alive = false;
		t.respawnAt = this.simTime + this.respawnMs;
		t.deaths++;
		by.kills++;
		by.stats.kills++;
		by.score += INF_SCORE_KILL;
		this.pending.push({ e: 'kill', by: by.id, targetId: t.id, weapon, head, x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw });
		this.streakKill(by);
	}

	/**
	 * A survivor killed an infected: kill streak, perk unlocks, ammo resupply,
	 * M.O.A.B. The streak counts first, so the kill that reaches a perk gets it.
	 */
	private streakKill(by: InfPlayer): void {
		if (by.team !== 'survivor') return;
		const prev = by.streak;
		by.streak++;
		if (by.streak > by.stats.bestStreak) by.stats.bestStreak = by.streak;
		for (const perk of PERK_ORDER) {
			const at = INF_PERK_KILLS[perk];
			if (at === 0 || prev >= at || by.streak < at) continue;
			if (perk === 'specialist') by.score += INF_SCORE_SPECIALIST;
			this.pending.push({ e: 'perk', id: by.id, perk, streak: by.streak });
		}
		const scav = this.hasPerk(by, 'scavenger');
		const prim = by.primaryWs;
		const a = INF_AMMO[prim.weapon];
		if (a) {
			const cap = scav ? Math.round(WEAPONS[prim.weapon].reserve * SCAVENGER_RESERVE_CAP) : WEAPONS[prim.weapon].reserve;
			const add = scav ? a.scavenger : Math.max(1, Math.ceil(a.scavenger * EMERGENCY_REFILL_SHARE));
			prim.reserve = Math.max(prim.reserve, Math.min(cap, prim.reserve + add));
			this.ammoEvent(by, prim, true);
		}
		const sec = by.secondaryWs;
		const sa = INF_AMMO[sec.weapon];
		if (scav && sa) {
			sec.reserve = Math.max(sec.reserve, Math.min(WEAPONS[sec.weapon].reserve, sec.reserve + sa.scavenger));
			this.ammoEvent(by, sec, true);
		}
		if (prev < this.moabKills && by.streak >= this.moabKills) {
			by.moabReady = true;
			this.pending.push({ e: 'moabReady', id: by.id });
		}
	}

	/** Infected attack on a survivor: claws infect outright. */
	private damageSurvivor(t: InfPlayer, by: InfPlayer, head: boolean): void {
		if (t.team !== 'survivor' || !t.alive) return;
		this.pending.push({ e: 'hit', by: by.id, targetId: t.id, head, kill: true });
		this.infect(t, by, 'claws');
	}

	/**
	 * Turn a survivor into an infected (in place). `by` may be gone (null) or
	 * dead (post-mortem knife). `dir`: the way a thrown knife travelled when it
	 * hit (after the bounce for a bank shot); the event carries its horizontal
	 * direction for the victim's hit-direction cue.
	 */
	private infect(t: InfPlayer, by: InfPlayer | null, method: InfMethod, dir?: Vec3): void {
		if (t.team !== 'survivor' || !t.alive) return;
		const first = this.infections === 0;
		this.stopSurviving(t);
		this.makeInfected(t, false);
		t.deaths++;
		this.infections++;
		this.endsAt += INF_INFECTION_BONUS_SECS * 1000;
		if (by) {
			by.kills++;
			by.stats.infections++;
			by.score += INF_SCORE_INFECT;
			if (method === 'knife' || method === 'bank') by.score += INF_SCORE_KNIFE_BONUS;
			if (method === 'bank') by.score += INF_SCORE_BANK_BONUS;
		}
		for (const s of this.livingSurvivors()) s.score += INF_SCORE_SURVIVE_TICK;
		const ev: Extract<InfEvent, { e: 'infect' }> = { e: 'infect', id: t.id, by: by?.id ?? null, method, timeAdded: INF_INFECTION_BONUS_SECS };
		if (dir) this.hitDir(ev, dir, by, t);
		this.pending.push(ev);
		this.ammoEvent(t);
		if (first) {
			// Patient Zero is one of many from now on (even while waiting to respawn).
			for (const p of this.players.values()) {
				if (!p.alpha) continue;
				p.alpha = false;
				this.ammoEvent(p);
			}
		}
	}

	/** A survivor stops being one (turned, or gone): the time they survived this round is final. */
	private stopSurviving(p: InfPlayer): void {
		if (this.phase === 'playing' && p.team === 'survivor') p.stats.survivedMs = Math.max(0, this.simTime - this.startedAt);
	}

	// ---------------------------------------------------------------------
	// Round flow

	/** Advance rules and the simulation to `now`. Returns events since the last call. */
	update(now: number): InfEvent[] {
		if (this.players.size < this.minPlayers) {
			if (this.phase !== 'waiting') this.toWaiting();
		} else if (this.phase === 'waiting' || (this.phase === 'ended' && now >= this.endsAt)) {
			this.startGrace(now);
		} else if (this.phase === 'grace' && now >= this.endsAt) {
			this.startPlaying(now);
		}

		// Sim catch-up (at most 8 steps per call; a long stall skips time).
		if (now - this.simTime > INF_STEP_MS * 8) this.simTime = now - INF_STEP_MS * 8;
		const previousTick = this.tick;
		this.moveBodies(Math.floor((now - this.simTime) / INF_STEP_MS));
		while (this.simTime + INF_STEP_MS <= now) {
			this.simTime += INF_STEP_MS;
			this.step(now);
		}
		// Each catch-up step sees the same client state. Record it once, at observation time.
		if (this.tick !== previousTick) this.recordHistory(now, previousTick + 1);

		if (this.phase === 'playing') {
			const surv = this.livingSurvivors();
			if (surv.length === 0) this.endRound(now, 'infected');
			else if (this.moab && now >= this.moab.detonatesAt) this.detonateMoab(now);
			else if (now >= this.endsAt) {
				for (const s of surv) s.score += INF_SCORE_SURVIVE_WIN;
				this.endRound(now, 'survivors');
			} else this.uav(now, surv);
		}
		return this.flush();
	}

	/** The called M.O.A.B. goes off: every living infected dies and the survivors win. */
	private detonateMoab(now: number): void {
		const m = this.moab!;
		this.moab = null;
		let wiped = 0;
		for (const p of this.players.values()) {
			if (p.team !== 'infected' || !p.alive) continue;
			p.alive = false;
			p.respawnAt = this.simTime + this.respawnMs;
			p.deaths++;
			wiped++;
		}
		const caller = this.players.get(m.callerId);
		if (caller) {
			caller.kills += wiped;
			caller.stats.kills += wiped;
			caller.score += INF_SCORE_MOAB;
		}
		this.pending.push({ e: 'moabDetonate', by: m.callerId, kills: wiped });
		for (const s of this.livingSurvivors()) s.score += INF_SCORE_SURVIVE_WIN;
		this.endRound(now, 'survivors');
	}

	private toWaiting(): void {
		// A cancelled grace period never played: the next grace repeats its round.
		if (this.phase === 'grace') this.round = Math.max(0, this.round - 1);
		this.phase = 'waiting';
		this.bench.clear();
		this.endsAt = 0;
		this.alphaId = null;
		this.infections = 0;
		this.moab = null;
		this.nextUavAt = 0;
		this.clearKnives();
		this.clearBeacons();
		this.roundLoadout = infLoadout(this.round + 1);
		this.pending.push({ e: 'phase', phase: 'waiting', round: this.round, loadout: this.roundLoadout });
		for (const p of this.players.values()) {
			this.makeSurvivor(p);
			const s = p.pos ? { pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z }, yaw: p.pos.yaw ?? 0 } : this.randomSpawn();
			this.spawnEvent(p, s, this.simTime, 'round');
		}
	}

	private startGrace(now: number): void {
		this.phase = 'grace';
		this.round++;
		this.endsAt = now + this.graceMs;
		this.roundLoadout = infLoadout(this.round);
		this.alphaId = null;
		this.infections = 0;
		this.moab = null;
		this.nextUavAt = 0;
		this.bench.clear();
		this.clearKnives();
		this.clearBeacons();
		this.pending.push({ e: 'phase', phase: 'grace', round: this.round, loadout: this.roundLoadout });
		// Distinct random spawns (wrapping when there are more players than spawns).
		const order = [...this.spawns];
		for (let i = order.length - 1; i > 0; i--) {
			const j = Math.min(i, Math.floor(this.rng() * (i + 1)));
			[order[i], order[j]] = [order[j]!, order[i]!];
		}
		let i = 0;
		for (const p of this.players.values()) {
			p.score = 0;
			p.kills = 0;
			p.deaths = 0;
			p.stats = newInfTally();
			this.makeSurvivor(p);
			this.spawnEvent(p, order[i++ % order.length]!, now, 'round');
		}
	}

	private startPlaying(now: number): void {
		this.phase = 'playing';
		this.startedAt = now;
		this.endsAt = now + this.roundMs;
		this.infections = 0;
		this.pending.push({ e: 'phase', phase: 'playing', round: this.round, loadout: this.roundLoadout });
		const ids = [...this.players.keys()];
		const id = ids[Math.min(ids.length - 1, Math.floor(this.rng() * ids.length))]!;
		const p = this.players.get(id)!;
		this.makeInfected(p, true);
		p.stats.alpha = true;
		this.alphaId = id;
		this.pending.push({ e: 'alpha', id });
		this.ammoEvent(p);
	}

	private endRound(now: number, winner: 'survivors' | 'infected'): void {
		const survivorsLeft = this.livingSurvivors().length;
		this.phase = 'ended';
		this.endsAt = now + this.endMs;
		this.moab = null;
		this.clearKnives();
		this.clearBeacons();
		let top: InfPlayer | null = null;
		for (const p of this.players.values()) if (!top || p.score > top.score) top = p;
		const secs = Math.round((now - this.startedAt) / 100) / 10;
		// One row per player present, in scoreboard order.
		const stats: InfRoundStat[] = [];
		for (const p of this.players.values()) stats.push(infRoundStat(p, p.stats, secs));
		stats.sort((a, b) => b.score - a.score || a.id - b.id);
		this.pending.push({
			e: 'end',
			winner,
			round: this.round,
			secs,
			survivorsLeft,
			topId: top && top.score > 0 ? top.id : null,
			topScore: top?.score ?? 0,
			stats,
			nextLoadout: infLoadout(this.round + 1)
		});
		this.pending.push({ e: 'phase', phase: 'ended', round: this.round, loadout: this.roundLoadout });
	}

	/** Last survivor against >= 2 infected: their position every INF_UAV_INTERVAL_MS. */
	private uav(now: number, surv: InfPlayer[]): void {
		const last = surv[0]!;
		if (surv.length !== 1 || this.infectedCount() < 2 || !last.pos) {
			this.nextUavAt = 0;
			return;
		}
		if (now < this.nextUavAt) return;
		this.nextUavAt = now + INF_UAV_INTERVAL_MS;
		this.pending.push({ e: 'uav', targetId: last.id, x: last.pos.x, y: last.pos.y, z: last.pos.z });
	}

	// ---------------------------------------------------------------------
	// Simulation step

	private step(now: number): void {
		this.tick++;
		this.fallOuts(now);
		if (this.phase === 'playing') {
			for (const p of this.players.values()) {
				if (p.team === 'infected' && !p.alive && this.simTime >= p.respawnAt) this.respawnInfected(p, now);
			}
			this.stepKnives();
		}
	}

	/** Every body towards what its player's last state says. */
	private moveBodies(steps: number): void {
		const s = this.bodyInput;
		for (const p of this.players.values()) {
			if (!p.alive || !p.pos) continue;
			s.vx = p.pos.vx ?? 0;
			s.vy = p.pos.vy ?? 0;
			s.vz = p.pos.vz ?? 0;
			s.yaw = p.pos.yaw ?? 0;
			s.pitch = p.pos.pitch ?? 0;
			s.onGround = p.pos.onGround !== false;
			s.ducked = p.pos.ducked;
			p.body.follow(steps, INF_STEP_MS / 1000, s);
		}
	}

	private respawnInfected(p: InfPlayer, now: number): void {
		// Stuck knives of the old life go; flying ones fly on and go when they land.
		for (const k of [...this.knives.values()]) if (k.ownerId === p.id && k.stuck) this.removeKnife(k);
		this.makeInfected(p, p.alpha && this.infections === 0);
		if (!this.useBeacon(p, now)) this.spawnEvent(p, this.spawnAwayFrom('survivor'), now, 'respawn');
	}

	/** Spawn on the player's beacon, which is used up. False without one. */
	private useBeacon(p: InfPlayer, now: number): boolean {
		const b = this.beacons.get(p.id);
		if (!b) return false;
		const at = { x: b.x, y: b.y, z: b.z + BEACON_SPAWN_LIFT };
		if (this.world.trace(at, at, HULL_MIN, HULL_MAX).startsolid) return false;
		this.beacons.delete(p.id);
		this.pending.push({ e: 'beaconUse', id: b.id, ownerId: p.id, x: b.x, y: b.y, z: b.z });
		this.spawnEvent(p, { pos: at, yaw: b.yaw }, now, 'beacon');
		return true;
	}

	private fallOuts(now: number): void {
		for (const p of this.players.values()) {
			const pos = p.pos;
			if (!p.alive || !pos || now < p.graceUntil) continue;
			if (!this.teleports.some((t) => hullInBox(pos, pos.ducked, t))) continue;
			if (this.phase === 'playing' && p.team === 'infected' && this.useBeacon(p, now)) continue;
			const s = this.phase === 'playing' ? this.spawnAwayFrom(p.team === 'survivor' ? 'infected' : 'survivor') : this.randomSpawn();
			this.spawnEvent(p, s, now, 'fall');
		}
	}

	private knifeOut(pos: Vec3): boolean {
		if (pos.z < this.killZ) return true;
		return this.teleports.some(
			(t) =>
				pos.x + INF_KNIFE_MIN.x < t.max.x &&
				pos.x + INF_KNIFE_MAX.x > t.min.x &&
				pos.y + INF_KNIFE_MIN.y < t.max.y &&
				pos.y + INF_KNIFE_MAX.y > t.min.y &&
				pos.z + INF_KNIFE_MIN.z < t.max.z &&
				pos.z + INF_KNIFE_MAX.z > t.min.z
		);
	}

	private stepKnives(): void {
		const dt = INF_STEP_MS / 1000;
		const lifetime = INF_KNIFE_LIFETIME_SECS * 1000;
		for (const k of [...this.knives.values()]) {
			// An infection can end the round and clear the knives mid-loop.
			if (this.phase !== 'playing' || !this.knives.has(k.id)) continue;
			if (this.simTime - k.bornAt > lifetime) {
				this.removeKnife(k);
				continue;
			}
			if (k.stuck) {
				this.stuckKnife(k);
				continue;
			}
			this.flyKnife(k, dt);
			if (this.knives.has(k.id) && this.knifeOut(k.pos)) this.removeKnife(k);
		}
	}

	private stuckKnife(k: Knife): void {
		const owner = this.players.get(k.ownerId);
		if (!owner || owner.team !== 'infected' || owner.life !== k.life) {
			this.removeKnife(k);
			return;
		}
		const pos = owner.pos;
		if (!owner.alive || owner.hasKnife || !pos) return;
		// Reach: a vertical capsule around the owner's hull, in sight of the knife.
		if (Math.hypot(pos.x - k.pos.x, pos.y - k.pos.y) > INF_KNIFE_PICKUP_RADIUS) return;
		const dz = k.pos.z - pos.z;
		if (dz < -INF_KNIFE_PICKUP_SLACK_Z || dz > HULL_MAX.z + INF_KNIFE_PICKUP_SLACK_Z) return;
		// Sight line from the hull at the knife's height (a knife on a waist-high top is in reach).
		const eyeZ = Math.max(pos.z + PICKUP_LOS_MIN_Z, Math.min(pos.z + PICKUP_LOS_MAX_Z, k.pos.z));
		if (this.world.trace({ x: pos.x, y: pos.y, z: eyeZ }, k.pos, ZERO, ZERO).fraction < 1) return;
		owner.hasKnife = true;
		this.knives.delete(k.id);
		this.pending.push({ e: 'knifePickup', id: k.id, ownerId: k.ownerId });
	}

	/**
	 * Closest living survivor the knife's segment (unit `u`, length `maxDist`)
	 * passes through, with hitboxes grown by INF_KNIFE_HIT_RADIUS. Only the
	 * throw's immediate spawn segment can rewind. Flight uses current poses.
	 */
	private knifeVictim(from: Vec3, u: Vec3, maxDist: number, now = 0, rewindMs = 0): InfPlayer | null {
		let best: InfPlayer | null = null;
		let bestT = Infinity;
		for (const s of this.livingSurvivors()) {
			if (!s.pos) continue;
			const current = this.poseOf(s, s.pos, this.scratch);
			let pose = current;
			if (rewindMs > 0) {
				pose = { ...current, motion: undefined };
				s.hist.poseAt(now - rewindMs, now, current, pose);
			}
			const t = sweepPlayer(from, u, pose, maxDist, INF_KNIFE_HIT_RADIUS);
			if (t >= 0 && t < bestT) {
				bestT = t;
				best = s;
			}
		}
		return best;
	}

	private flyKnife(k: Knife, dt: number): void {
		const v = k.vel;
		v.z -= INF_KNIFE_GRAVITY * dt;
		const from = k.pos;
		const to = { x: from.x + v.x * dt, y: from.y + v.y * dt, z: from.z + v.z * dt };
		const tr = this.world.trace(from, to, INF_KNIFE_MIN, INF_KNIFE_MAX);
		const segLen = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);

		if (k.lethal && segLen > 1e-9) {
			const u = { x: (to.x - from.x) / segLen, y: (to.y - from.y) / segLen, z: (to.z - from.z) / segLen };
			const victim = this.knifeVictim(from, u, tr.fraction * segLen);
			if (victim) {
				this.removeKnife(k);
				this.infect(victim, this.players.get(k.ownerId) ?? null, k.bounces > 0 ? 'bank' : 'knife', u);
				return;
			}
		}

		if (tr.fraction < 1) {
			this.knifeContact(k, tr.endpos, tr.plane.normal);
			return;
		}

		k.pos = to;
		Object.assign(k, angles(v));
	}

	/** The knife's trace stopped at a surface: bounce, stick, or drop off a wall. */
	private knifeContact(k: Knife, at: Vec3, n: Vec3): void {
		const v = k.vel;
		const orient = angles(v);
		k.pos = { ...at };
		const vn = v.x * n.x + v.y * n.y + v.z * n.z;
		let bounce: Vec3 | null = null;
		if (k.bounces < INF_KNIFE_MAX_BOUNCES && vn < 0) {
			const vnx = n.x * vn;
			const vny = n.y * vn;
			const vnz = n.z * vn;
			const nv = {
				x: (v.x - vnx) * INF_KNIFE_TANGENT_DAMP - vnx * INF_KNIFE_RESTITUTION,
				y: (v.y - vny) * INF_KNIFE_TANGENT_DAMP - vny * INF_KNIFE_RESTITUTION,
				z: (v.z - vnz) * INF_KNIFE_TANGENT_DAMP - vnz * INF_KNIFE_RESTITUTION
			};
			// Too slow to rebound (e.g. the apex of a lob into a ceiling): no bounce.
			if (Math.hypot(nv.x, nv.y, nv.z) >= INF_KNIFE_REST_SPEED) bounce = nv;
		}
		if (!bounce && (n.z >= FLOOR_NZ || this.nearFloor(k.pos))) {
			this.stick(k, orient);
			return;
		}
		// Push off the surface (the trace stops before solids).
		const off = this.world.trace(k.pos, { x: k.pos.x + n.x, y: k.pos.y + n.y, z: k.pos.z + n.z }, INF_KNIFE_MIN, INF_KNIFE_MAX);
		if (!off.startsolid) k.pos = { ...off.endpos };
		if (bounce) k.bounces++;
		else {
			// High on a wall or in a ceiling: it falls away to the floor, harmless.
			k.bounces = INF_KNIFE_MAX_BOUNCES;
			k.lethal = false;
			bounce = { x: n.x * KNIFE_DROP_SPEED, y: n.y * KNIFE_DROP_SPEED, z: Math.min(0, n.z) * KNIFE_DROP_SPEED };
		}
		k.vel = bounce;
		Object.assign(k, angles(bounce));
		this.pending.push({ e: 'knifeBounce', id: k.id, x: k.pos.x, y: k.pos.y, z: k.pos.z, vx: bounce.x, vy: bounce.y, vz: bounce.z });
	}

	/** A floor within INF_KNIFE_WALL_REACH below the knife centre (in an owner's pickup reach). */
	private nearFloor(pos: Vec3): boolean {
		const down = INF_KNIFE_WALL_REACH + INF_KNIFE_MIN.z - 2;
		const tr = this.world.trace(pos, { x: pos.x, y: pos.y, z: pos.z - down }, INF_KNIFE_MIN, INF_KNIFE_MAX);
		return !tr.startsolid && tr.fraction < 1 && tr.plane.normal.z >= FLOOR_NZ;
	}

	private stick(k: Knife, orient: { pitch: number; yaw: number }): void {
		k.stuck = true;
		k.vel = { x: 0, y: 0, z: 0 };
		k.pitch = orient.pitch;
		k.yaw = orient.yaw;
		this.pending.push({ e: 'knifeStick', id: k.id, ownerId: k.ownerId, x: k.pos.x, y: k.pos.y, z: k.pos.z, pitch: k.pitch, yaw: k.yaw });
	}

	private removeKnife(k: Knife): void {
		if (!this.knives.delete(k.id)) return;
		this.pending.push({ e: 'knifeRemove', id: k.id });
	}

	private clearKnives(): void {
		for (const k of [...this.knives.values()]) this.removeKnife(k);
	}

	/** One pose sample per living player, stamped with the time of this update (lagcomp.ts). */
	private recordHistory(now: number, firstTick: number): void {
		for (const p of this.players.values()) {
			if (p.alive && p.pos) p.hist.record(now, firstTick, this.poseOf(p, p.pos, this.scratch));
		}
	}

	// ---------------------------------------------------------------------
	// Views

	knifeViews(): InfKnifeView[] {
		const out: InfKnifeView[] = [];
		for (const k of this.knives.values()) {
			out.push({
				id: k.id,
				ownerId: k.ownerId,
				x: k.pos.x,
				y: k.pos.y,
				z: k.pos.z,
				vx: k.vel.x,
				vy: k.vel.y,
				vz: k.vel.z,
				pitch: k.pitch,
				yaw: k.yaw,
				stuck: k.stuck
			});
		}
		return out;
	}

	beaconViews(): InfBeaconView[] {
		const out: InfBeaconView[] = [];
		for (const b of this.beacons.values()) out.push({ id: b.id, ownerId: b.ownerId, x: b.x, y: b.y, z: b.z, yaw: b.yaw });
		return out;
	}

	view(now: number): InfStateView {
		const players: InfPlayerView[] = [];
		for (const p of this.players.values()) players.push(this.playerView(p.id)!);
		players.sort((a, b) => b.score - a.score || a.id - b.id);
		const timeLeft = this.phase === 'waiting' ? 0 : Math.max(0, (this.endsAt - now) / 1000);
		return {
			phase: this.phase,
			round: this.round,
			timeLeft: Math.round(timeLeft * 10) / 10,
			loadout: this.roundLoadout,
			secondary: INF_SECONDARY,
			moab: this.moab ? { callerId: this.moab.callerId, timeLeft: Math.round(Math.max(0, (this.moab.detonatesAt - now) / 1000) * 10) / 10 } : null,
			alphaId: this.alphaId,
			survivors: this.livingSurvivors().length,
			infected: this.infectedCount(),
			players,
			knives: this.knifeViews(),
			beacons: this.beaconViews()
		};
	}
}
