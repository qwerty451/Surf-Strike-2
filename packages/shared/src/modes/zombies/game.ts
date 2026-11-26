/**
 * Zombies rules and AI (docs/modes.md#zombies). Pure and clock-injected: the
 * server runs one `ZombiesGame` per zombies map (fed with players' latest
 * state packets), and the client runs the same class in solo so the mode is
 * playable offline. Tests drive it with a fake clock.
 *
 * Round flow: waiting (no players) → countdown (start area, pick a weapon) →
 * playing (open the gates zone by zone, reach the evac zone) → ended (won:
 * a survivor reached the evac zone; lost: no survivors left) → countdown ...
 *
 * Teams: everyone starts a round as a survivor. A survivor who goes down
 * turns into a player-controlled zombie for the rest of the round (claws,
 * zombie speed, HP and hitboxes; respawns at a zombie spawn when killed).
 *
 * Gates: the route is split into zones by solid gates (MapDef.zombies.gates).
 * When at least half of the living survivors stand in a gate's unlock area at
 * once, a ZM_GATE_COUNTDOWN_SECS countdown starts (never cancelled); then the
 * gate opens and its collision is removed. A living survivor who moves through
 * an open gate passes it (event `pass`), in order and each gate at most once;
 * gates skipped by a teleport (late join, fall-out) are never passed.
 *
 * AI zombies are bodies simulated with the real `playerMove` (hull, gravity,
 * steps, collision incl. closed gates) at ZM_SIM_HZ, driven by AI UserCmds.
 */
import type { CollisionWorld } from '../../collision/api.ts';
import type { Cvars } from '../../cvars.ts';
import type { MapDef, Spawn, Zone, ZombieGate, ZombieSpawnZone } from '../../maps/types.ts';
import { HULL_MAX, HULL_MIN, IN_JUMP, VIEW_HEIGHT, type PlayerState, type UserCmd } from '../../movement/api.ts';
import { createPlayer, playerMove } from '../../movement/gamemovement.ts';
import type { SnapshotEntry } from '../../protocol.ts';
import type { Vec3 } from '../../types.ts';
import { hullInBox } from '../tag.ts';
import { gatedWorld, gateFarSide, unlockReached, ZM_GATE_COUNTDOWN_SECS, type GatedWorld, type GateState } from './gates.ts';
import { meleeZombie, rayZombie, type HitboxPose } from './hitbox.ts';
import { ZombiePath } from './path.ts';
import { DEFAULT_WEAPON, hitDamage, isLoadoutWeapon, isWeaponId, WEAPONS, WeaponState, ZOMBIE_HP, type WeaponId } from './weapons.ts';

export type ZmPhase = 'waiting' | 'countdown' | 'playing' | 'ended';
export type ZmTeam = 'survivor' | 'zombie';

export const ZM_SIM_HZ = 64;
export const ZM_STEP_MS = 1000 / ZM_SIM_HZ;
export const ZM_COUNTDOWN_SECS = 8;
export const ZM_END_SECS = 7;
/** A round that takes longer than this is lost. */
export const ZM_ROUND_MAX_SECS = 900;
/** Hard cap on AI zombies alive at once, whatever the player count (server tick, bandwidth, client draw calls). */
export const ZM_MAX_ZOMBIES = 96;
/** Alive cap for n living survivors: ZM_CAP_BASE * n^ZM_CAP_EXP. */
export const ZM_CAP_BASE = 18;
export const ZM_CAP_EXP = 0.5;
/** Spawn rate for n living survivors: n^ZM_RATE_EXP per ZM_SPAWN_BASE_MS (faster along the route). */
export const ZM_SPAWN_BASE_MS = 1500;
export const ZM_RATE_EXP = 0.85;
export const ZM_SPAWN_MIN_MS = 50;
export const ZM_PLAYER_HP = 5;
/** Zombie run speed, AI and player-zombies (survivors: 195-250 by weapon). */
export const ZM_ZOMBIE_SPEED = 265;
/** Speed factor by stacked hit slows (0 = not slowed). */
export const ZM_SLOW_FACTORS = [1, 0.6, 0.5, 0.42] as const;
export const ZM_SLOW_MS = 600;
/** Horizontal origin distance at which a zombie can hit a player (hulls 32 wide). */
export const ZM_ATTACK_RANGE = 50;
export const ZM_ATTACK_WINDUP_MS = 350;
export const ZM_ATTACK_COOLDOWN_MS = 900;
/** After a hit a survivor cannot be hit again for this long. */
export const ZM_PLAYER_IFRAMES_MS = 300;
/** Weapon can be changed for this long after a (re)spawn. */
export const ZM_LOADOUT_SECS = 15;
/** A downed survivor rises as a zombie after this long; a killed player-zombie respawns after this long. */
export const ZM_TURN_SECS = 3;
export const ZM_PZ_RESPAWN_SECS = 4;
/** Lag compensation history. */
export const ZM_HISTORY_MS = 400;
export const ZM_SPAWN_MIN_DIST = 700;
export const ZM_SPAWN_MAX_DIST = 3200;
/** Zombies this far (path units) behind the last survivor and away from everyone are removed. */
export const ZM_DESPAWN_BEHIND = 1600;
/** Server-side fire/reload tolerance against jitter. */
export const ZM_FIRE_TOLERANCE = 0.75;
export const ZM_RELOAD_TOLERANCE = 0.85;
/** A fire origin may be this far from the shooter's last known eye position. */
export const ZM_ORIGIN_SLACK = 80;
/** Grace after a teleport (stale positions in flight are ignored for fall checks). */
const TELEPORT_GRACE_MS = 1000;
const THINK_EVERY = 8;
const SEPARATION = 40;
const LOOKAHEAD = 160;
const STUCK_CHECK_MS = 2000;
const STUCK_LIMIT = 3;
/** Zombies this close to a closed gate wait there instead of counting as stuck. */
const GATE_WAIT_DIST = 200;
const HISTORY_TICKS = Math.ceil(ZM_HISTORY_MS / ZM_STEP_MS);
/** Match the remote player interpolation buffer's snap distance. */
const PLAYER_SNAP_DISTANCE = 1024;

/**
 * Spawn interval (ms) for `survivors` living survivors at route progress 0..1.
 * Sub-linear: twice the survivors meet about 1.8x the zombies, so each one
 * faces slightly fewer.
 */
export function zmSpawnInterval(survivors: number, progress: number): number {
	const n = Math.max(1, survivors);
	const p = Math.max(0, Math.min(1, progress));
	return Math.max(ZM_SPAWN_MIN_MS, (ZM_SPAWN_BASE_MS / n ** ZM_RATE_EXP) * (1 - 0.35 * p));
}

/** Concurrent AI zombie cap for `survivors` living survivors (sub-linear, at most `max`). */
export function zmZombieCap(survivors: number, max = ZM_MAX_ZOMBIES): number {
	return Math.min(max, Math.round(ZM_CAP_BASE * Math.max(1, survivors) ** ZM_CAP_EXP));
}

/** Speed factor for a zombie with `stacks` hit slows. */
export function zmSlowFactor(stacks: number): number {
	return ZM_SLOW_FACTORS[Math.max(0, Math.min(ZM_SLOW_FACTORS.length - 1, stacks))]!;
}

/**
 * Spawn areas the spawner may use: those feeding path nodes from 2 behind to
 * 3 ahead of the front survivor's segment and not behind a closed gate
 * (`node <= maxNode`), at least ZM_SPAWN_MIN_DIST from every living survivor
 * and within ZM_SPAWN_MAX_DIST of one.
 */
export function eligibleSpawnZones(
	zones: readonly ZombieSpawnZone[],
	frontSegment: number,
	players: readonly Vec3[],
	maxNode = Infinity
): ZombieSpawnZone[] {
	if (players.length === 0) return [];
	return zones.filter((z) => {
		if (z.node < frontSegment - 2 || z.node > frontSegment + 3 || z.node > maxNode) return false;
		const nearest = nearestDist(z, players);
		return nearest >= ZM_SPAWN_MIN_DIST && nearest <= ZM_SPAWN_MAX_DIST;
	});
}

function nearestDist(z: ZombieSpawnZone, players: readonly Vec3[]): number {
	const cx = (z.min.x + z.max.x) / 2;
	const cy = (z.min.y + z.max.y) / 2;
	let nearest = Infinity;
	for (const p of players) nearest = Math.min(nearest, Math.hypot(p.x - cx, p.y - cy, p.z - z.min.z));
	return nearest;
}

export interface ZmPlayerPos {
	x: number;
	y: number;
	z: number;
	ducked: boolean;
	/** View yaw (degrees): player-zombies' head hitbox faces it. */
	yaw?: number;
}

export interface ZmPlayerView {
	id: number;
	team: ZmTeam;
	/** Survivors: 0..ZM_PLAYER_HP. Zombies: 0..ZOMBIE_HP. */
	hp: number;
	/** In play (false: down survivor rising, or killed zombie waiting to respawn). */
	alive: boolean;
	kills: number;
	/** Times downed as a survivor this round. */
	deaths: number;
	weapon: WeaponId;
}

export interface ZmGateView {
	state: GateState;
	/** Seconds until it opens (counting), else 0. */
	secsLeft: number;
}

export interface ZmStateView {
	phase: ZmPhase;
	round: number;
	/** Seconds until the countdown/summary ends; 0 while playing. */
	timeLeft: number;
	/** Seconds since the round started (playing). */
	elapsed: number;
	/** Last checkpoint the team reached (0 = start) and how many there are. */
	checkpoint: number;
	checkpoints: number;
	/** Front survivor's route progress 0..1. */
	progress: number;
	/** AI zombies alive. */
	zombies: number;
	kills: number;
	gates: ZmGateView[];
	players: ZmPlayerView[];
}

type SpawnReason = 'round' | 'checkpoint' | 'join' | 'fall' | 'zombie';

export type ZmEvent =
	| { e: 'phase'; phase: ZmPhase; round: number }
	/** Teleport `id` (start, join, fall-out, zombie (re)spawn) with its hp and team. */
	| { e: 'spawn'; id: number; x: number; y: number; z: number; yaw: number; hp: number; team: ZmTeam; reason: SpawnReason }
	/** To the shooter: hit marker. `pid` = player-zombie hit (zid 0). */
	| { e: 'hit'; by: number; zid: number; pid?: number; head: boolean; kill: boolean }
	| { e: 'kill'; by: number; zid: number; pid?: number; weapon: WeaponId; head: boolean; x: number; y: number; z: number; yaw: number }
	/** To everyone but the shooter: tracer / gunshot / swing. `len` = distance to the impact. */
	| { e: 'shot'; by: number; weapon: WeaponId; o: Vec3; d: Vec3; len: number }
	/** A survivor was hit (by an AI zombie `zid`, or a player-zombie `by`, or a fall: zid 0). */
	| { e: 'hurt'; id: number; hp: number; zid: number; by?: number }
	/** To a player-zombie hit by a survivor: new hp, slow stacks and knockback velocity. */
	| { e: 'zhurt'; id: number; hp: number; stacks: number; kx: number; ky: number }
	/** A survivor went down: they turn into a zombie. */
	| { e: 'down'; id: number; by?: number }
	| { e: 'checkpoint'; index: number; by: number }
	| { e: 'gate'; index: number; state: GateState; secs: number }
	/** A living survivor passed gate `index` (for the server's payouts; not sent to clients). */
	| { e: 'pass'; id: number; index: number }
	/** To `id`: authoritative ammo (rejected shot, checkpoint refill, loadout change). */
	| { e: 'ammo'; id: number; weapon: WeaponId; mag: number; reserve: number }
	| { e: 'end'; won: boolean; round: number; secs: number; kills: number; topId: number | null; topKills: number; by: number | null };

/** Who receives an event: one player (`to`), everyone except one (`except`), or everyone. */
export function zmEventRoute(ev: ZmEvent): { to?: number; except?: number } {
	switch (ev.e) {
		case 'spawn':
		case 'ammo':
		case 'zhurt':
		case 'pass':
			return { to: ev.id };
		case 'hit':
			return { to: ev.by };
		case 'shot':
			return { except: ev.by };
		default:
			return {};
	}
}

export interface ZmFire {
	weapon: WeaponId;
	origin: Vec3;
	dir: Vec3;
	/** Zombie sim tick the shooter saw (lag compensation); clamped to the history. */
	tick: number;
	/** Validated time of the player pose on the same clock as outgoing player snapshots. */
	playerRenderTime?: number;
}

export interface ZmFireResult {
	ok: boolean;
	reason?: string;
	events: ZmEvent[];
}

export interface Zombie {
	readonly id: number;
	readonly body: PlayerState;
	yaw: number;
	hp: number;
	slowUntil: number;
	slowStacks: number;
	/** Attack wind-up ends at this sim time (0 = none). */
	windupUntil: number;
	nextAttackAt: number;
	/** Last time it was hit (sim ms), for the hit flash. */
	hitAt: number;
	targetId: number | null;
	/** Line of sight to the target at the last think. */
	los: boolean;
	/** Ticks spent blocked while trying to move. */
	blocked: number;
	stuckCheckAt: number;
	stuckX: number;
	stuckY: number;
	stuckCount: number;
	cmd: UserCmd;
}

interface ZmPlayer {
	id: number;
	team: ZmTeam;
	hp: number;
	alive: boolean;
	kills: number;
	deaths: number;
	ws: WeaponState;
	/** Survivor weapon kept while a zombie (restored next round). */
	loadout: WeaponId;
	pos: ZmPlayerPos | null;
	poseHistory: PlayerHistorySample[];
	/** Route progress of `pos`, refreshed every sim step. */
	s: number;
	/** Gates behind this survivor: passed, or skipped by a spawn at a checkpoint. */
	zone: number;
	iframesUntil: number;
	loadoutUntil: number;
	graceUntil: number;
	/** Zombie team: rises/respawns at this time while not alive. */
	respawnAt: number;
	slowUntil: number;
	slowStacks: number;
}

interface Gate {
	def: ZombieGate;
	/** Route progress of the gate, and the box right behind it. */
	s: number;
	far: { min: Vec3; max: Vec3 };
	state: GateState;
	opensAt: number;
}

interface PlayerHistorySample {
	at: number;
	pose: HitboxPose;
}

interface HistoryFrame {
	at: number;
	tick: number;
	poses: Map<number, HitboxPose>;
}

export interface ZombiesGameOptions {
	map: MapDef;
	/** Static map collision; closed gates are added on top. */
	world: CollisionWorld;
	/** Physics cvars of the map (zombies use them with their own max speed). */
	cvars: Cvars;
	now: number;
	rng?: () => number;
	countdownSecs?: number;
	endSecs?: number;
	maxZombies?: number;
	/** Multiplies spawn intervals (tests: 1e9 = no automatic spawns). */
	spawnIntervalScale?: number;
	/** Server: looser fire/reload timing (ZM_FIRE_TOLERANCE, ZM_RELOAD_TOLERANCE). */
	lenient?: boolean;
	/** Online: capture the poses relayed by the lobby instead of sampling during simulation. */
	relayedPlayerHistory?: boolean;
	/** Path units behind the last survivor before zombies despawn (tests: Infinity). */
	despawnBehind?: number;
	gateSecs?: number;
	/** Tests: start with every gate open. */
	gatesOpen?: boolean;
}

/** Flags in the zombie snapshot (net.ts). */
export const ZF_ATTACKING = 1;
export const ZF_HIT = 2;
export const ZF_SLOWED = 4;
export const ZF_ON_GROUND = 8;
/** Hit flash length (ms). */
export const ZM_HIT_FLASH_MS = 120;

type Target = { kind: 'ai'; z: Zombie; pose: HitboxPose } | { kind: 'pz'; p: ZmPlayer; pose: HitboxPose };

export class ZombiesGame {
	phase: ZmPhase = 'waiting';
	round = 0;
	/** Countdown / summary end (ms). */
	endsAt = 0;
	startedAt = 0;
	checkpoint = 0;
	teamKills = 0;
	/** Zombie sim tick (increments every ZM_STEP_MS). */
	tick = 0;
	/** Sim clock (ms). */
	simTime: number;
	readonly zombies = new Map<number, Zombie>();
	readonly path: ZombiePath;
	readonly map: MapDef;
	/** Static world plus closed gates. */
	readonly world: GatedWorld;
	readonly checkpoints: Array<Extract<Zone, { index: number }>>;
	readonly endZone: Extract<Zone, { type: 'end' }> | null;
	private readonly gates: Gate[];
	private readonly teleports: Array<Extract<Zone, { type: 'teleport' }>>;
	private readonly players = new Map<number, ZmPlayer>();
	private readonly rng: () => number;
	private readonly countdownMs: number;
	private readonly endMs: number;
	private readonly gateMs: number;
	private readonly gatesStartOpen: boolean;
	private readonly maxZombies: number;
	private readonly spawnScale: number;
	private readonly lenient: boolean;
	private readonly relayedPlayerHistory: boolean;
	private readonly zcvars: Cvars;
	private readonly startSpawns: Spawn[];
	private readonly killZ: number;
	private readonly despawnBehind: number;
	private nextZombieId = 1;
	private nextSpawnAt = 0;
	private history: HistoryFrame[] = [];
	private frontS = 0;
	private rearS = 0;
	private pending: ZmEvent[] = [];
	private readonly sGoal: Vec3 = { x: 0, y: 0, z: 0 };

	constructor(opts: ZombiesGameOptions) {
		const route = opts.map.zombies;
		if (!route) throw new Error(`${opts.map.id} has no zombie route`);
		this.map = opts.map;
		this.world = gatedWorld(opts.world, route.gates);
		this.path = new ZombiePath(route.path);
		this.gates = route.gates.map((def) => {
			const s = this.path.project((def.min.x + def.max.x) / 2, (def.min.y + def.max.y) / 2, def.min.z);
			const a = this.path.pointAt(s - 32);
			const b = this.path.pointAt(s + 32);
			return { def, s, far: gateFarSide(def, { x: b.x - a.x, y: b.y - a.y }), state: 'closed', opensAt: 0 };
		});
		this.rng = opts.rng ?? Math.random;
		this.countdownMs = (opts.countdownSecs ?? ZM_COUNTDOWN_SECS) * 1000;
		this.endMs = (opts.endSecs ?? ZM_END_SECS) * 1000;
		this.gateMs = (opts.gateSecs ?? ZM_GATE_COUNTDOWN_SECS) * 1000;
		this.gatesStartOpen = opts.gatesOpen ?? false;
		this.maxZombies = opts.maxZombies ?? ZM_MAX_ZOMBIES;
		this.spawnScale = opts.spawnIntervalScale ?? 1;
		this.lenient = opts.lenient ?? false;
		this.relayedPlayerHistory = opts.relayedPlayerHistory ?? false;
		this.despawnBehind = opts.despawnBehind ?? ZM_DESPAWN_BEHIND;
		this.simTime = opts.now;
		this.zcvars = { ...opts.cvars, sv_autobunnyhopping: 0, sv_enablebunnyhopping: 0 };
		this.checkpoints = opts.map.zones
			.filter((z): z is Extract<Zone, { index: number }> => z.type === 'checkpoint')
			.sort((a, b) => a.index - b.index);
		this.endZone = (opts.map.zones.find((z) => z.type === 'end') as Extract<Zone, { type: 'end' }> | undefined) ?? null;
		this.teleports = opts.map.zones.filter((z): z is Extract<Zone, { type: 'teleport' }> => z.type === 'teleport');
		this.startSpawns = opts.map.spawns && opts.map.spawns.length > 0 ? opts.map.spawns : [opts.map.spawn];
		this.killZ = this.teleports.length > 0 ? Math.max(...this.teleports.map((t) => t.max.z)) : -Infinity;
		this.resetGates();
	}

	// ---------------------------------------------------------------------
	// Players

	/** Active (non-spectating) players. New ones join; missing ones leave. */
	syncPlayers(ids: Iterable<number>, now: number): void {
		const want = new Set(ids);
		for (const id of [...this.players.keys()]) if (!want.has(id)) this.players.delete(id);
		for (const id of want) {
			if (this.players.has(id)) continue;
			const p: ZmPlayer = {
				id,
				team: 'survivor',
				hp: ZM_PLAYER_HP,
				alive: true,
				kills: 0,
				deaths: 0,
				ws: this.weaponState(DEFAULT_WEAPON),
				loadout: DEFAULT_WEAPON,
				pos: null,
				poseHistory: [],
				s: 0,
				zone: 0,
				iframesUntil: 0,
				loadoutUntil: now + ZM_LOADOUT_SECS * 1000,
				graceUntil: 0,
				respawnAt: 0,
				slowUntil: 0,
				slowStacks: 0
			};
			this.players.set(id, p);
			if (this.phase === 'playing') this.joinSurvivor(p, now);
			else if (this.phase !== 'waiting') this.spawnAtStart(p, this.players.size - 1, now, 'join');
		}
	}

	setPlayerPos(id: number, pos: ZmPlayerPos, teleported = false): void {
		const p = this.players.get(id);
		if (!p) return;
		if (teleported) p.poseHistory.length = 0;
		if (!p.pos) p.pos = { ...pos };
		else {
			p.pos.x = pos.x;
			p.pos.y = pos.y;
			p.pos.z = pos.z;
			p.pos.ducked = pos.ducked;
			p.pos.yaw = pos.yaw;
		}
	}

	hasPlayer(id: number): boolean {
		return this.players.has(id);
	}

	playerView(id: number): ZmPlayerView | null {
		const p = this.players.get(id);
		return p ? { id, team: p.team, hp: p.hp, alive: p.alive, kills: p.kills, deaths: p.deaths, weapon: p.ws.weapon } : null;
	}

	/** Weapon state of a player (read-only use: HUD in solo, tests). */
	weaponOf(id: number): WeaponState | null {
		return this.players.get(id)?.ws ?? null;
	}

	/** State of gate `i`. */
	gateState(i: number): GateState {
		return this.gates[i]?.state ?? 'open';
	}

	private weaponState(w: WeaponId): WeaponState {
		return this.lenient ? new WeaponState(w, ZM_FIRE_TOLERANCE, ZM_RELOAD_TOLERANCE) : new WeaponState(w);
	}

	private survivors(): ZmPlayer[] {
		const out: ZmPlayer[] = [];
		for (const p of this.players.values()) if (p.alive && p.team === 'survivor') out.push(p);
		return out;
	}

	private spawnEvent(p: ZmPlayer, s: Spawn, now: number, reason: SpawnReason): void {
		p.graceUntil = now + TELEPORT_GRACE_MS;
		p.poseHistory.length = 0;
		p.pos = { x: s.pos.x, y: s.pos.y, z: s.pos.z, ducked: false, yaw: s.yaw };
		this.pending.push({ e: 'spawn', id: p.id, x: s.pos.x, y: s.pos.y, z: s.pos.z, yaw: s.yaw, hp: p.hp, team: p.team, reason });
	}

	private makeSurvivor(p: ZmPlayer, now: number): void {
		p.team = 'survivor';
		p.hp = ZM_PLAYER_HP;
		p.alive = true;
		p.iframesUntil = 0;
		p.respawnAt = 0;
		p.ws.equip(p.loadout);
	}

	private spawnAtStart(p: ZmPlayer, i: number, now: number, reason: SpawnReason): void {
		this.makeSurvivor(p, now);
		p.zone = 0;
		p.loadoutUntil = Math.max(this.endsAt, now) + ZM_LOADOUT_SECS * 1000;
		this.spawnEvent(p, this.startSpawns[i % this.startSpawns.length]!, now, reason);
	}

	/** Spawn point of the team's current checkpoint (start spawns before the first). */
	private checkpointSpawn(i: number): Spawn {
		const cp = this.checkpoints.find((c) => c.index === this.checkpoint);
		return cp ? cp.respawn : this.startSpawns[i % this.startSpawns.length]!;
	}

	/** Gates on the route before a checkpoint. */
	private gatesBefore(cp: Extract<Zone, { index: number }> | undefined): number {
		if (!cp) return 0;
		const o = cp.respawn.pos;
		const s = this.path.project(o.x, o.y, o.z);
		return this.gates.filter((g) => g.s < s).length;
	}

	/** The team's checkpoint moved this survivor: gates before it are skipped, not passed. */
	private skipGates(p: ZmPlayer): void {
		p.zone = Math.max(p.zone, this.gatesBefore(this.checkpoints.find((c) => c.index === this.checkpoint)));
	}

	/** Late joiner during a round: a survivor at the team's checkpoint. */
	private joinSurvivor(p: ZmPlayer, now: number): void {
		this.makeSurvivor(p, now);
		p.iframesUntil = now + 1000;
		p.loadoutUntil = now + ZM_LOADOUT_SECS * 1000;
		p.zone = 0;
		this.skipGates(p);
		this.spawnEvent(p, this.checkpointSpawn(p.id), now, 'join');
	}

	/** First gate that is still closed (index), or -1. */
	private firstClosedGate(): number {
		return this.gates.findIndex((g) => g.state !== 'open');
	}

	/** Highest spawn-area node in the reachable zones. */
	private reachableNode(): number {
		const i = this.firstClosedGate();
		return i < 0 ? Infinity : this.gates[i]!.def.node;
	}

	/** Player-zombie (re)spawn: a spawn area in the reachable zones, away from survivors. */
	private zombieSpawnPoint(): Spawn {
		const zones = this.map.zombies!.spawnZones;
		const surv = this.survivors()
			.filter((p) => p.pos)
			.map((p) => p.pos!);
		const maxNode = this.reachableNode();
		let pick = eligibleSpawnZones(zones, this.path.segmentAt(this.frontS), surv, maxNode);
		if (pick.length === 0) {
			// Nearest allowed area that keeps the minimum distance, else any allowed area.
			const allowed = zones.filter((z) => z.node <= maxNode);
			const far = allowed.filter((z) => nearestDist(z, surv) >= ZM_SPAWN_MIN_DIST).sort((a, b) => nearestDist(a, surv) - nearestDist(b, surv));
			pick = far.length > 0 ? [far[0]!] : allowed.length > 0 ? [allowed[0]!] : [];
		}
		const z = pick[Math.min(pick.length - 1, Math.floor(this.rng() * pick.length))];
		if (!z) return this.startSpawns[0]!;
		const pos = { x: (z.min.x + z.max.x) / 2, y: (z.min.y + z.max.y) / 2, z: z.min.z + 0.25 };
		const goal = this.path.pointAt(this.frontS);
		return { pos, yaw: (Math.atan2(goal.y - pos.y, goal.x - pos.x) * 180) / Math.PI };
	}

	private spawnPlayerZombie(p: ZmPlayer, now: number): void {
		p.team = 'zombie';
		p.alive = true;
		p.hp = ZOMBIE_HP;
		p.slowUntil = 0;
		p.slowStacks = 0;
		if (p.ws.weapon !== 'claws') p.ws.equip('claws');
		this.spawnEvent(p, this.zombieSpawnPoint(), now, 'zombie');
	}

	// ---------------------------------------------------------------------
	// Player actions

	/** Change weapon (fresh magazine): survivors, outside rounds or inside the loadout window. */
	loadout(id: number, weapon: unknown, now: number): ZmEvent[] {
		const p = this.players.get(id);
		if (!p || !p.alive || p.team !== 'survivor' || !isLoadoutWeapon(weapon)) return [];
		if (this.phase === 'playing' && now > p.loadoutUntil) return [];
		p.loadout = weapon;
		if (p.ws.weapon !== weapon) p.ws.equip(weapon);
		return [{ e: 'ammo', id, weapon, mag: p.ws.mag, reserve: p.ws.reserve }];
	}

	reload(id: number, now: number): boolean {
		const p = this.players.get(id);
		if (!p || !p.alive) return false;
		return p.ws.startReload(now);
	}

	/** Resolve a shot or swing (server-authoritative; lag-compensated against the zombie history). */
	fire(id: number, shot: ZmFire, now: number): ZmFireResult {
		const p = this.players.get(id);
		const reject = (reason: string): ZmFireResult => ({
			ok: false,
			reason,
			events: p ? [{ e: 'ammo', id, weapon: p.ws.weapon, mag: p.ws.mag, reserve: p.ws.reserve }] : []
		});
		if (!p) return { ok: false, reason: 'not playing', events: [] };
		if (!p.alive) return { ok: false, reason: 'down', events: [] };
		if (this.phase === 'waiting') return reject('no round');
		if (!isWeaponId(shot.weapon) || shot.weapon !== p.ws.weapon) return reject('wrong weapon');
		const o = shot.origin;
		const d = shot.dir;
		if (!o || !d || ![o.x, o.y, o.z, d.x, d.y, d.z].every(Number.isFinite)) return reject('bad shot');
		const len = Math.hypot(d.x, d.y, d.z);
		if (len < 0.9 || len > 1.1) return reject('bad direction');
		if (p.pos) {
			const dz = o.z - (p.pos.z + VIEW_HEIGHT);
			if (Math.hypot(o.x - p.pos.x, o.y - p.pos.y, dz) > ZM_ORIGIN_SLACK) return reject('bad origin');
		}
		if (!p.ws.fire(now)) return reject(p.ws.reloading(now) ? 'reloading' : p.ws.mag <= 0 ? 'empty' : 'too fast');
		const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
		if (p.team === 'zombie') return { ok: true, events: this.claw(p, o, dir, now, shot.playerRenderTime) };
		const tick = Number.isFinite(shot.tick) ? shot.tick : this.tick;
		return { ok: true, events: this.resolveShot(p, o, dir, tick, shot.playerRenderTime) };
	}

	/** Player-zombie melee: the nearest survivor in reach and in the cone takes one hit. */
	private claw(p: ZmPlayer, o: Vec3, d: Vec3, now: number, playerRenderTime?: number): ZmEvent[] {
		const def = WEAPONS.claws;
		this.pending.push({ e: 'shot', by: p.id, weapon: 'claws', o: { ...o }, d: { ...d }, len: 0 });
		if (this.phase !== 'playing') return this.flush();
		let best: ZmPlayer | null = null;
		let bestT = Infinity;
		for (const s of this.survivors()) {
			if (!s.pos) continue;
			const rewound = playerRenderTime === undefined ? undefined : this.playerPoseAt(s.poseHistory, playerRenderTime);
			const pose = rewound ?? { ...s.pos, yaw: s.pos.yaw ?? 0 };
			const h = meleeZombie(o, d, pose, def.range, def.coneDeg);
			if (!h || h.t >= bestT) continue;
			const los = this.world.trace(o, { x: pose.x, y: pose.y, z: pose.z + 40 }, ZERO, ZERO);
			if (los.fraction < 1) continue;
			best = s;
			bestT = h.t;
		}
		if (best) this.hurt(best, 0, now, false, p);
		return this.flush();
	}

	private flush(): ZmEvent[] {
		const out = this.pending;
		this.pending = [];
		return out;
	}

	/** Shot targets at the shooter's tick, or their current pose if they have no sample for it. */
	private targets(tick: number, playerRenderTime?: number): Target[] {
		const t = Math.max(this.tick - HISTORY_TICKS, Math.min(this.tick, tick));
		const frame = t >= this.tick ? undefined : this.history.find((h) => h.tick === Math.floor(t));
		const next = frame && t > frame.tick ? this.history.find((h) => h.tick === Math.ceil(t)) : undefined;
		const out: Target[] = [];
		for (const z of this.zombies.values()) {
			const a = frame?.poses.get(z.id);
			const b = next?.poses.get(z.id);
			const current = { x: z.body.origin.x, y: z.body.origin.y, z: z.body.origin.z, yaw: z.yaw };
			let pose = a ?? b ?? current;
			if (a && b && frame) {
				const f = t - frame.tick;
				const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
				const dyaw = ((((b.yaw - a.yaw + 180) % 360) + 360) % 360) - 180;
				pose = dx * dx + dy * dy + dz * dz > 512 ** 2
					? b
					: { x: a.x + dx * f, y: a.y + dy * f, z: a.z + dz * f, yaw: a.yaw + dyaw * f };
			}
			out.push({ kind: 'ai', z, pose });
		}
		for (const p of this.players.values()) {
			if (p.team !== 'zombie' || !p.alive || !p.pos) continue;
			const at = playerRenderTime ?? frame?.at;
			const pose = at !== undefined ? this.playerPoseAt(p.poseHistory, at) : undefined;
			out.push({ kind: 'pz', p, pose: pose ?? { ...p.pos, yaw: p.pos.yaw ?? 0 } });
		}
		return out;
	}

	private playerPoseAt(history: readonly PlayerHistorySample[], at: number): HitboxPose | undefined {
		const first = history[0];
		if (!first || at <= first.at) return first?.pose;
		for (let i = 1; i < history.length; i++) {
			const b = history[i]!;
			if (b.at < at) continue;
			const a = history[i - 1]!;
			const dx = b.pose.x - a.pose.x;
			const dy = b.pose.y - a.pose.y;
			const dz = b.pose.z - a.pose.z;
			if (dx * dx + dy * dy + dz * dz > PLAYER_SNAP_DISTANCE ** 2) return b.pose;
			const f = (at - a.at) / (b.at - a.at);
			let yawDelta = (b.pose.yaw - a.pose.yaw) % 360;
			if (yawDelta > 180) yawDelta -= 360;
			else if (yawDelta < -180) yawDelta += 360;
			return { x: a.pose.x + dx * f, y: a.pose.y + dy * f, z: a.pose.z + dz * f, yaw: a.pose.yaw + yawDelta * f };
		}
		return history.at(-1)?.pose;
	}

	private resolveShot(p: ZmPlayer, o: Vec3, d: Vec3, tick: number, playerRenderTime?: number): ZmEvent[] {
		const def = WEAPONS[p.ws.weapon];
		const events: ZmEvent[] = [];
		const end = { x: o.x + d.x * def.range, y: o.y + d.y * def.range, z: o.z + d.z * def.range };
		const worldT = this.world.trace(o, end, ZERO, ZERO).fraction * def.range;
		const hits: Array<{ tg: Target; t: number; head: boolean }> = [];
		for (const tg of this.targets(tick, playerRenderTime)) {
			if (def.magazine === 0) {
				const h = meleeZombie(o, d, tg.pose, def.range, def.coneDeg);
				if (!h) continue;
				const los = this.world.trace(o, { x: tg.pose.x, y: tg.pose.y, z: tg.pose.z + 40 }, ZERO, ZERO);
				if (los.fraction < 1) continue;
				hits.push({ tg, t: h.t, head: h.head });
			} else {
				const h = rayZombie(o, d, tg.pose, worldT);
				if (h) hits.push({ tg, t: h.t, head: h.head });
			}
		}
		hits.sort((a, b) => a.t - b.t);
		const taken = hits.slice(0, def.pierce);
		const last = taken.length > 0 && taken.length >= def.pierce ? taken[taken.length - 1]!.t : worldT;
		events.push({ e: 'shot', by: p.id, weapon: def.id, o: { ...o }, d: { ...d }, len: def.magazine > 0 ? Math.min(last, worldT) : 0 });
		for (const h of taken) {
			if (h.tg.kind === 'ai') this.damageZombie(h.tg.z, p, def.id, h.head, d, events);
			else this.damagePlayerZombie(h.tg.p, p, def.id, h.head, d, events);
		}
		return events;
	}

	private slowStack(until: number, stacks: number): number {
		return this.simTime < until ? Math.min(ZM_SLOW_FACTORS.length - 1, stacks + 1) : 1;
	}

	private damageZombie(z: Zombie, by: ZmPlayer, weapon: WeaponId, head: boolean, d: Vec3, events: ZmEvent[]): void {
		const def = WEAPONS[weapon];
		z.hp -= hitDamage(weapon, head, z.hp);
		z.hitAt = this.simTime;
		const kill = z.hp <= 0;
		events.push({ e: 'hit', by: by.id, zid: z.id, head, kill });
		if (kill) {
			this.zombies.delete(z.id);
			by.kills++;
			this.teamKills++;
			const o = z.body.origin;
			events.push({ e: 'kill', by: by.id, zid: z.id, weapon, head, x: o.x, y: o.y, z: o.z, yaw: z.yaw });
			return;
		}
		z.slowStacks = this.slowStack(z.slowUntil, z.slowStacks);
		z.slowUntil = this.simTime + ZM_SLOW_MS;
		if (def.knockback > 0) {
			const h = Math.hypot(d.x, d.y) || 1;
			const v = z.body.velocity;
			v.x = (d.x / h) * def.knockback;
			v.y = (d.y / h) * def.knockback;
		}
	}

	private damagePlayerZombie(t: ZmPlayer, by: ZmPlayer, weapon: WeaponId, head: boolean, d: Vec3, events: ZmEvent[]): void {
		const def = WEAPONS[weapon];
		t.hp = Math.max(0, t.hp - hitDamage(weapon, head, t.hp));
		const kill = t.hp <= 0;
		events.push({ e: 'hit', by: by.id, zid: 0, pid: t.id, head, kill });
		const pos = t.pos!;
		if (kill) {
			t.alive = false;
			t.respawnAt = this.simTime + ZM_PZ_RESPAWN_SECS * 1000;
			by.kills++;
			this.teamKills++;
			events.push({ e: 'kill', by: by.id, zid: 0, pid: t.id, weapon, head, x: pos.x, y: pos.y, z: pos.z, yaw: pos.yaw ?? 0 });
			return;
		}
		t.slowStacks = this.slowStack(t.slowUntil, t.slowStacks);
		t.slowUntil = this.simTime + ZM_SLOW_MS;
		const h = Math.hypot(d.x, d.y) || 1;
		events.push({ e: 'zhurt', id: t.id, hp: t.hp, stacks: t.slowStacks, kx: (d.x / h) * def.knockback, ky: (d.y / h) * def.knockback });
	}

	// ---------------------------------------------------------------------
	// Round flow

	/** Advance rules and the zombie simulation to `now`. Returns events since the last call. */
	update(now: number): ZmEvent[] {
		if (this.players.size === 0) {
			if (this.phase !== 'waiting') {
				this.phase = 'waiting';
				this.endsAt = 0;
				this.zombies.clear();
				this.history = [];
				this.pending.push({ e: 'phase', phase: 'waiting', round: this.round });
			}
		} else if (this.phase === 'waiting') {
			this.startCountdown(now);
		} else if (this.phase === 'countdown' && now >= this.endsAt) {
			this.startRound(now);
		} else if (this.phase === 'ended' && now >= this.endsAt) {
			this.startCountdown(now);
		}

		// Sim catch-up (at most 8 steps per call; a long stall skips time).
		if (now - this.simTime > ZM_STEP_MS * 8) this.simTime = now - ZM_STEP_MS * 8;
		while (this.simTime + ZM_STEP_MS <= now) {
			this.simTime += ZM_STEP_MS;
			this.step(now);
		}

		if (this.phase === 'playing') {
			if (this.survivors().length === 0) this.endRound(now, false, null);
			else if (now - this.startedAt > ZM_ROUND_MAX_SECS * 1000) this.endRound(now, false, null);
		}
		return this.flush();
	}

	private resetGates(): void {
		for (const [i, g] of this.gates.entries()) {
			g.state = this.gatesStartOpen ? 'open' : 'closed';
			g.opensAt = 0;
			this.world.setOpen(i, this.gatesStartOpen);
		}
	}

	private startCountdown(now: number): void {
		this.phase = 'countdown';
		this.endsAt = now + this.countdownMs;
		this.checkpoint = 0;
		this.teamKills = 0;
		this.zombies.clear();
		this.history = [];
		this.resetGates();
		this.pending.push({ e: 'phase', phase: 'countdown', round: this.round + 1 });
		let i = 0;
		for (const p of this.players.values()) {
			p.kills = 0;
			p.deaths = 0;
			this.spawnAtStart(p, i++, now, 'round');
		}
	}

	private startRound(now: number): void {
		this.phase = 'playing';
		this.round++;
		this.startedAt = now;
		this.nextSpawnAt = this.simTime + ZM_SPAWN_BASE_MS * this.spawnScale;
		this.pending.push({ e: 'phase', phase: 'playing', round: this.round });
	}

	private endRound(now: number, won: boolean, by: number | null): void {
		this.phase = 'ended';
		this.endsAt = now + this.endMs;
		let top: ZmPlayer | null = null;
		for (const p of this.players.values()) if (!top || p.kills > top.kills) top = p;
		this.pending.push({
			e: 'end',
			won,
			round: this.round,
			secs: Math.round((now - this.startedAt) / 100) / 10,
			kills: this.teamKills,
			topId: top && top.kills > 0 ? top.id : null,
			topKills: top?.kills ?? 0,
			by
		});
		this.pending.push({ e: 'phase', phase: 'ended', round: this.round });
	}

	// ---------------------------------------------------------------------
	// Simulation step

	private step(now: number): void {
		this.tick++;
		const surv = this.survivors();
		this.frontS = 0;
		this.rearS = Infinity;
		for (const p of surv) {
			if (!p.pos) continue;
			p.s = this.path.project(p.pos.x, p.pos.y, p.pos.z);
			if (p.s > this.frontS) this.frontS = p.s;
			if (p.s < this.rearS) this.rearS = p.s;
		}
		if (this.rearS === Infinity) this.rearS = 0;

		if (this.phase === 'playing') this.updatePasses(now);
		if (this.phase === 'playing' || this.phase === 'countdown') this.playerZones(now);
		if (this.phase === 'playing') {
			this.updateGates(now);
			this.spawnZombies();
			for (const p of this.players.values()) if (p.team === 'zombie' && !p.alive && this.simTime >= p.respawnAt) this.spawnPlayerZombie(p, now);
		}
		const zs = [...this.zombies.values()];
		const alive = this.survivors();
		for (const z of zs) this.moveZombie(z, zs, alive);
		if (this.phase === 'playing') for (const z of zs) if (this.zombies.has(z.id)) this.attack(z, now);
		this.recordHistory();
	}

	private playerZones(now: number): void {
		const playing = this.phase === 'playing';
		let reached = 0;
		let reachedBy = -1;
		for (const p of this.players.values()) {
			const pos = p.pos;
			if (!p.alive || !pos) continue;
			if (now >= p.graceUntil && this.teleports.some((t) => hullInBox(pos, pos.ducked, t))) {
				if (p.team === 'zombie') this.spawnEvent(p, this.zombieSpawnPoint(), now, 'fall');
				else {
					if (playing) this.hurt(p, 0, now, true);
					if (playing) this.skipGates(p);
					if (p.alive) this.spawnEvent(p, playing ? this.checkpointSpawn(p.id) : this.startSpawns[0]!, now, 'fall');
				}
				continue;
			}
			if (!playing || p.team !== 'survivor') continue;
			for (const cp of this.checkpoints) {
				if (cp.index > this.checkpoint && cp.index > reached && hullInBox(pos, pos.ducked, cp)) {
					reached = cp.index;
					reachedBy = p.id;
				}
			}
			if (this.endZone && hullInBox(pos, pos.ducked, this.endZone)) {
				this.endRound(now, true, p.id);
				return;
			}
		}
		if (reached > 0) this.reachCheckpoint(reached, reachedBy);
	}

	/** Start the next gate's countdown when half the survivors are in its unlock area; open counted-down gates. */
	private updateGates(now: number): void {
		for (const [i, g] of this.gates.entries()) {
			if (g.state === 'counting' && now >= g.opensAt) {
				g.state = 'open';
				this.world.setOpen(i, true);
				this.pending.push({ e: 'gate', index: i, state: 'open', secs: 0 });
			}
		}
		const i = this.gates.findIndex((g) => g.state === 'closed');
		if (i < 0) return;
		const g = this.gates[i]!;
		const surv = this.survivors();
		let inside = 0;
		for (const p of surv) if (p.pos && hullInBox(p.pos, p.pos.ducked, g.def.unlock)) inside++;
		if (!unlockReached(inside, surv.length)) return;
		g.state = 'counting';
		g.opensAt = now + this.gateMs;
		this.pending.push({ e: 'gate', index: i, state: 'counting', secs: this.gateMs / 1000 });
	}

	/**
	 * Living survivors who are behind their next gate now. Being in a checkpoint
	 * or the evac beyond it counts too (a long gap between position packets). A
	 * gate that is not open cannot be passed: being behind it then skips it.
	 */
	private updatePasses(now: number): void {
		for (const p of this.survivors()) {
			const pos = p.pos;
			if (!pos || now < p.graceUntil) continue;
			const next = this.gates[p.zone];
			if (!next) continue;
			let zone = p.zone;
			if (inBox(pos, next.far)) zone++;
			else if (this.endZone && hullInBox(pos, pos.ducked, this.endZone)) zone = this.gates.length;
			else for (const cp of this.checkpoints) if (hullInBox(pos, pos.ducked, cp)) zone = Math.max(zone, this.gatesBefore(cp));
			for (; p.zone < zone; p.zone++) if (this.gates[p.zone]!.state === 'open') this.pending.push({ e: 'pass', id: p.id, index: p.zone });
		}
	}

	private reachCheckpoint(index: number, by: number): void {
		this.checkpoint = index;
		this.pending.push({ e: 'checkpoint', index, by });
		for (const p of this.survivors()) {
			p.hp = ZM_PLAYER_HP;
			p.ws.refill();
			this.pending.push({ e: 'ammo', id: p.id, weapon: p.ws.weapon, mag: p.ws.mag, reserve: p.ws.reserve });
		}
	}

	/** One hit on a survivor (fall-outs ignore i-frames). A survivor at 0 HP turns into a zombie. */
	private hurt(p: ZmPlayer, zid: number, now: number, ignoreIframes = false, by?: ZmPlayer): void {
		if (!p.alive || p.team !== 'survivor' || (!ignoreIframes && now < p.iframesUntil)) return;
		p.hp = Math.max(0, p.hp - 1);
		p.iframesUntil = now + ZM_PLAYER_IFRAMES_MS;
		this.pending.push(by ? { e: 'hurt', id: p.id, hp: p.hp, zid, by: by.id } : { e: 'hurt', id: p.id, hp: p.hp, zid });
		if (p.hp > 0) return;
		p.alive = false;
		p.deaths++;
		p.team = 'zombie';
		p.ws.reloadEndsAt = 0;
		p.ws.equip('claws');
		p.respawnAt = this.simTime + ZM_TURN_SECS * 1000;
		if (by) by.kills++;
		this.pending.push(by ? { e: 'down', id: p.id, by: by.id } : { e: 'down', id: p.id });
	}

	private spawnZombies(): void {
		if (this.simTime < this.nextSpawnAt) return;
		const alive = this.survivors();
		const n = Math.max(1, alive.length);
		const progress = this.path.length > 0 ? this.frontS / this.path.length : 0;
		// Carry the remainder: intervals get down to a few sim steps with many survivors.
		const due = Math.max(this.nextSpawnAt, this.simTime - ZM_STEP_MS);
		this.nextSpawnAt = due + zmSpawnInterval(n, progress) * this.spawnScale;
		if (this.zombies.size >= zmZombieCap(n, this.maxZombies)) return;
		const positions = alive.filter((p) => p.pos).map((p) => p.pos!);
		const zones = eligibleSpawnZones(this.map.zombies!.spawnZones, this.path.segmentAt(this.frontS), positions, this.reachableNode());
		if (zones.length === 0) return;
		const zone = zones[Math.min(zones.length - 1, Math.floor(this.rng() * zones.length))]!;
		const x = zone.min.x + 16 + this.rng() * Math.max(0, zone.max.x - zone.min.x - 32);
		const y = zone.min.y + 16 + this.rng() * Math.max(0, zone.max.y - zone.min.y - 32);
		this.spawnZombie({ x, y, z: zone.min.z + 0.25 });
	}

	/** Add an AI zombie at a feet position (also used by tests). Returns null if the spot is blocked. */
	spawnZombie(pos: Vec3): Zombie | null {
		if (this.world.trace(pos, pos, HULL_MIN, HULL_MAX).startsolid) return null;
		const body = createPlayer(pos);
		const z: Zombie = {
			id: this.nextZombieId,
			body,
			yaw: 0,
			hp: ZOMBIE_HP,
			slowUntil: 0,
			slowStacks: 0,
			windupUntil: 0,
			nextAttackAt: 0,
			hitAt: -Infinity,
			targetId: null,
			los: false,
			blocked: 0,
			stuckCheckAt: this.simTime + STUCK_CHECK_MS,
			stuckX: pos.x,
			stuckY: pos.y,
			stuckCount: 0,
			cmd: { pitch: 0, yaw: 0, forwardmove: 0, sidemove: 0, buttons: 0 }
		};
		this.nextZombieId = this.nextZombieId >= 65535 ? 1 : this.nextZombieId + 1;
		this.zombies.set(z.id, z);
		return z;
	}

	private nearestAlive(z: Zombie, alive: ZmPlayer[]): ZmPlayer | null {
		let best: ZmPlayer | null = null;
		let bestD = Infinity;
		const o = z.body.origin;
		for (const p of alive) {
			if (!p.pos) continue;
			const d = (p.pos.x - o.x) ** 2 + (p.pos.y - o.y) ** 2 + 4 * (p.pos.z - o.z) ** 2;
			if (d < bestD) {
				bestD = d;
				best = p;
			}
		}
		return best;
	}

	private nearClosedGate(o: Vec3): boolean {
		for (const g of this.gates) {
			if (g.state === 'open') continue;
			const dx = Math.max(g.def.min.x - o.x, 0, o.x - g.def.max.x);
			const dy = Math.max(g.def.min.y - o.y, 0, o.y - g.def.max.y);
			if (Math.hypot(dx, dy) < GATE_WAIT_DIST) return true;
		}
		return false;
	}

	/** AI: pick a goal (survivor in reach/sight, else along the route), separation, jump when blocked. */
	private moveZombie(z: Zombie, all: Zombie[], alive: ZmPlayer[]): void {
		const b = z.body;
		const o = b.origin;
		const cmd = z.cmd;
		cmd.buttons = 0;
		cmd.forwardmove = 0;
		cmd.sidemove = 0;
		const think = (this.tick + z.id) % THINK_EVERY === 0;
		const cur = z.targetId !== null ? this.players.get(z.targetId) : undefined;
		if (think || !cur || !cur.alive || cur.team !== 'survivor') z.targetId = this.nearestAlive(z, alive)?.id ?? null;
		const target = z.targetId !== null ? this.players.get(z.targetId) : undefined;
		let wx = 0;
		let wy = 0;
		let wantJump = false;
		if (target?.pos && target.alive && target.team === 'survivor') {
			const tp = target.pos;
			const dx = tp.x - o.x;
			const dy = tp.y - o.y;
			const dz = tp.z - o.z;
			const dist = Math.hypot(dx, dy);
			let direct = dist < 160 && Math.abs(dz) < 80;
			if (!direct && dist < 1100 && Math.abs(dz) < 100 && think) {
				const los = this.world.trace({ x: o.x, y: o.y, z: o.z + 40 }, { x: tp.x, y: tp.y, z: tp.z + 40 }, ZERO, ZERO);
				z.los = los.fraction >= 1;
				direct = z.los;
			} else if (!direct && dist < 1100 && Math.abs(dz) < 100) direct = z.los;
			const zs = this.path.project(o.x, o.y, o.z);
			if (!direct && Math.abs(target.s - zs) < LOOKAHEAD) direct = true;
			if (direct) {
				wx = dx;
				wy = dy;
				if (dist < 90 && dz > 24 && b.onGround) wantJump = true;
			} else {
				const g = this.path.pointAt(zs + Math.sign(target.s - zs) * LOOKAHEAD, this.sGoal);
				wx = g.x - o.x;
				wy = g.y - o.y;
			}
		}
		const wl = Math.hypot(wx, wy);
		if (wl > 1e-3) {
			wx /= wl;
			wy /= wl;
			// Separation from nearby zombies (no zombie-zombie collision).
			let sx = 0;
			let sy = 0;
			for (const q of all) {
				if (q === z) continue;
				const qx = o.x - q.body.origin.x;
				const qy = o.y - q.body.origin.y;
				if (Math.abs(qx) > SEPARATION || Math.abs(qy) > SEPARATION || Math.abs(o.z - q.body.origin.z) > 72) continue;
				const d = Math.hypot(qx, qy);
				if (d >= SEPARATION) continue;
				const w = (SEPARATION - d) / SEPARATION;
				if (d < 1e-3) {
					sx += ((z.id % 7) - 3) * 0.3;
					sy += ((z.id % 5) - 2) * 0.3;
				} else {
					sx += (qx / d) * w;
					sy += (qy / d) * w;
				}
			}
			wx += sx * 0.9;
			wy += sy * 0.9;
			z.yaw = (Math.atan2(wy, wx) * 180) / Math.PI;
			cmd.forwardmove = 450;
			// Blocked while trying to move: jump (small ledges, crates).
			const speed = Math.hypot(b.velocity.x, b.velocity.y);
			if (b.onGround && speed < 60 && this.simTime > z.hitAt + 300) z.blocked++;
			else z.blocked = 0;
			if (z.blocked > 12) {
				wantJump = true;
				z.blocked = 0;
			}
		}
		if (wantJump && b.onGround) cmd.buttons |= IN_JUMP;
		cmd.yaw = z.yaw;
		const slowed = this.simTime < z.slowUntil;
		if (!slowed) z.slowStacks = 0;
		let speed = ZM_ZOMBIE_SPEED * zmSlowFactor(slowed ? z.slowStacks : 0);
		if (z.windupUntil > 0) speed *= 0.7;
		this.zcvars.sv_maxspeed = speed;
		playerMove(this.world, b, cmd, this.zcvars, ZM_STEP_MS / 1000);

		// Fell out of the map, or stuck for a long time: remove (the spawner refills).
		if (o.z < this.killZ) {
			this.zombies.delete(z.id);
			return;
		}
		if (this.simTime >= z.stuckCheckAt) {
			const moved = Math.hypot(o.x - z.stuckX, o.y - z.stuckY);
			const busy =
				(target?.pos && Math.hypot(target.pos.x - o.x, target.pos.y - o.y) < ZM_ATTACK_RANGE * 2) || this.nearClosedGate(o);
			z.stuckCount = moved < 48 && !busy ? z.stuckCount + 1 : 0;
			z.stuckX = o.x;
			z.stuckY = o.y;
			z.stuckCheckAt = this.simTime + STUCK_CHECK_MS;
			if (z.stuckCount >= STUCK_LIMIT) {
				this.zombies.delete(z.id);
				return;
			}
		}
		// Far behind the team and away from everyone: despawn.
		if (think && alive.length > 0) {
			const zs = this.path.project(o.x, o.y, o.z);
			if (zs < this.rearS - this.despawnBehind) {
				let near = false;
				for (const p of alive) if (p.pos && Math.hypot(p.pos.x - o.x, p.pos.y - o.y) < 1200) near = true;
				if (!near) this.zombies.delete(z.id);
			}
		}
	}

	private attack(z: Zombie, now: number): void {
		const target = z.targetId !== null ? this.players.get(z.targetId) : undefined;
		const o = z.body.origin;
		const inReach = (scale: number) => {
			const tp = target?.pos;
			if (!tp || !target!.alive || target!.team !== 'survivor') return false;
			return Math.hypot(tp.x - o.x, tp.y - o.y) <= ZM_ATTACK_RANGE * scale && Math.abs(tp.z - o.z) < 64;
		};
		if (z.windupUntil === 0) {
			if (this.simTime >= z.nextAttackAt && inReach(1)) z.windupUntil = this.simTime + ZM_ATTACK_WINDUP_MS;
			return;
		}
		if (this.simTime < z.windupUntil) return;
		z.windupUntil = 0;
		z.nextAttackAt = this.simTime + ZM_ATTACK_COOLDOWN_MS;
		if (target && inReach(1.3)) this.hurt(target, z.id, now);
	}

	private recordHistory(): void {
		const poses = new Map<number, HitboxPose>();
		for (const z of this.zombies.values()) poses.set(z.id, { x: z.body.origin.x, y: z.body.origin.y, z: z.body.origin.z, yaw: z.yaw });
		this.history.push({ at: this.simTime, tick: this.tick, poses });
		if (this.history.length > HISTORY_TICKS + 1) this.history.shift();
		if (this.relayedPlayerHistory) return;
		for (const p of this.players.values()) {
			if (p.team === 'zombie' && p.alive && p.pos) this.recordPlayerPose(p, p.pos, this.simTime);
		}
	}

	/** Record relayed player poses at the same sample times used by the renderer. */
	recordPlayerSnapshot(entries: readonly SnapshotEntry[]): void {
		if (!this.relayedPlayerHistory) return;
		for (const entry of entries) {
			const p = this.players.get(entry.id);
			if (p?.alive && entry.sampleTimeMs !== undefined) this.recordPlayerPose(p, entry, entry.sampleTimeMs);
		}
	}

	private recordPlayerPose(p: ZmPlayer, { x, y, z, yaw = 0 }: ZmPlayerPos | SnapshotEntry, at: number): void {
		const history = p.poseHistory;
		const sample = { at, pose: { x, y, z, yaw } };
		if (history.at(-1)?.at === at) history[history.length - 1] = sample;
		else history.push(sample);
		while (history.length > 2 && history[1]!.at < at - ZM_HISTORY_MS) history.shift();
	}

	// ---------------------------------------------------------------------
	// Views

	/** Snapshot flags of a zombie. */
	zombieFlags(z: Zombie): number {
		return (
			(z.windupUntil > 0 ? ZF_ATTACKING : 0) |
			(this.simTime - z.hitAt < ZM_HIT_FLASH_MS ? ZF_HIT : 0) |
			(this.simTime < z.slowUntil ? ZF_SLOWED : 0) |
			(z.body.onGround ? ZF_ON_GROUND : 0)
		);
	}

	view(now: number): ZmStateView {
		const players: ZmPlayerView[] = [];
		for (const p of this.players.values()) players.push(this.playerView(p.id)!);
		players.sort((a, b) => b.kills - a.kills || a.id - b.id);
		const timeLeft = this.phase === 'countdown' || this.phase === 'ended' ? Math.max(0, (this.endsAt - now) / 1000) : 0;
		return {
			phase: this.phase,
			round: this.phase === 'countdown' ? this.round + 1 : this.round,
			timeLeft: Math.round(timeLeft * 10) / 10,
			elapsed: this.phase === 'playing' ? Math.round((now - this.startedAt) / 100) / 10 : 0,
			checkpoint: this.checkpoint,
			checkpoints: this.checkpoints.length,
			progress: this.path.length > 0 ? Math.round((this.frontS / this.path.length) * 1000) / 1000 : 0,
			zombies: this.zombies.size,
			kills: this.teamKills,
			gates: this.gates.map((g) => ({
				state: g.state,
				secsLeft: g.state === 'counting' ? Math.max(0, Math.round((g.opensAt - now) / 100) / 10) : 0
			})),
			players
		};
	}
}

const inBox = (p: Vec3, b: { min: Vec3; max: Vec3 }): boolean =>
	p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
