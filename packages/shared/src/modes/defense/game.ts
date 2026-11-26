/**
 * Zombie Defense rules and AI (docs/modes.md#zombie-defense). Pure and
 * clock-injected like `ZombiesGame`: the server runs one `DefenseGame` per
 * defense map (fed with players' latest state packets), the client can run
 * the same class solo, and tests drive it with a fake clock.
 *
 * Game flow: waiting (no players) → build (shop, turrets, repairs; ends at
 * its timer or when every living player is ready) → wave (zombies spawn
 * outside, tear the barricades down and hunt the players inside; cleared
 * when every zombie of the wave was spawned and killed) → build → ... →
 * ended (every player in the game is dead) → a new game from wave 1.
 *
 * Barricades: each opening's box is solid (for players and zombies, not for
 * bullets) while it has a plank: `world` is the static world plus every
 * boarded opening (`gatedWorld`), and the client builds the same with
 * `defenseWorld` and the plank counts of the mode state.
 *
 * AI zombies are bodies on the real `playerMove` hull at ZD_SIM_HZ. Outside
 * they walk the nav graph (MapDef.defense.nav) to an opening's `outside`
 * node, tear its planks off, walk through to `inside` and then chase the
 * nearest living player (straight at them in sight, else A* over the graph).
 */
import type { CollisionWorld } from '../../collision/api.ts';
import type { Cvars } from '../../cvars.ts';
import type { DefenseMapInfo, DefenseOpening, DefensePad, MapDef, Spawn } from '../../maps/types.ts';
import { DUCK_HULL_MAX, HULL_MAX, HULL_MIN, IN_JUMP, VIEW_HEIGHT, type PlayerState, type UserCmd } from '../../movement/api.ts';
import { createPlayer, playerMove } from '../../movement/gamemovement.ts';
import type { Vec3 } from '../../types.ts';
import { gatedWorld, type GatedWorld } from '../zombies/gates.ts';
import { rayZombie, type HitboxPose } from '../zombies/hitbox.ts';
import { WEAPONS, WeaponState, type WeaponId } from '../zombies/weapons.ts';
import { NavGraph } from './nav.ts';
import {
	ZDF_ATTACKING,
	ZDF_FROSTED,
	ZDF_HIT,
	ZDF_INSIDE,
	ZDF_ON_GROUND,
	ZDF_SLOWED,
	ZDF_TEARING,
	ZDT_ACTIVE,
	ZDT_FIRED,
	ZD_FIRE_FLAG_TICKS,
	type ZdTurretNet,
	type ZdZombieNet
} from './net.ts';
import {
	isZdTurretType,
	isZdWeapon,
	parseZdItem,
	ZD_ATTACK_COOLDOWN_MS,
	ZD_ATTACK_WINDUP_MS,
	ZD_BUILD_SECS,
	ZD_DEFAULT_PLANKS,
	ZD_END_SECS,
	ZD_FIRST_BUILD_SECS,
	ZD_GOLD,
	ZD_HEAD_MULT,
	ZD_HIT_FLASH_MS,
	ZD_MAX_ZOMBIES,
	ZD_PAD_RANGE,
	ZD_PLAYER_HP,
	ZD_PLAYER_IFRAMES_MS,
	ZD_REGEN_DELAY_MS,
	ZD_REGEN_EVERY_MS,
	ZD_REINFORCE_FACTORS,
	ZD_REPAIR_MS,
	ZD_REPAIR_RANGE,
	ZD_SHELL_SPEED,
	ZD_SHOP,
	ZD_SLOW_FACTORS,
	ZD_SLOW_MS,
	ZD_STALL_MS,
	ZD_STEP_MS,
	ZD_TESLA_JUMP,
	ZD_TURRETS,
	ZD_TURRET_HEIGHT,
	ZD_TURRET_MAX_LEVEL,
	ZD_WAVE_MAX_SECS,
	ZD_WEAPONS,
	ZD_ZOMBIES,
	zdSpawnInterval,
	zdTurretCost,
	zdTurretRefund,
	zdWavePlan,
	zdZombieHp,
	type ZdPhase,
	type ZdTurretType,
	type ZdWeaponId,
	type ZdZombieKind
} from './rules.ts';

/** Server-side fire/reload tolerance against jitter (as Zombie Run). */
export const ZD_FIRE_TOLERANCE = 0.75;
export const ZD_RELOAD_TOLERANCE = 0.85;
/** A fire origin may be this far from the shooter's last known eye position. */
export const ZD_ORIGIN_SLACK = 80;
/** Lag compensation history. */
export const ZD_HISTORY_MS = 400;
const HISTORY_TICKS = Math.ceil(ZD_HISTORY_MS / ZD_STEP_MS);
const THINK_EVERY = 8;
const SEPARATION = 40;
/** A zombie reached a nav node when this close (XY). */
const NODE_REACHED = 40;
/** A zombie this close (XY) to a boarded opening's box (or its outside node) tears at it. */
const TEAR_DIST = 56;
const STALL_CHECK_MS = 1000;
const STALL_MOVE = 48;
/** Outside zombies chase a player this close in sight instead of heading for an opening. */
const OUTSIDE_CHASE = 320;
const REPATH_MS = 1000;
const RETHINK_OPENING_MS = 3000;
const TELEPORT_GRACE_MS = 1000;

export type ZdZombieState = 'approach' | 'tear' | 'enter' | 'inside';
export type ZdPlayerStatus = 'alive' | 'dead' | 'waiting';

export interface ZdPlayerPos {
	x: number;
	y: number;
	z: number;
	ducked: boolean;
	yaw?: number;
}

export interface ZdPlayerView {
	id: number;
	/** `waiting`: joined during a wave, plays from the next build phase. */
	status: ZdPlayerStatus;
	hp: number;
	maxHp: number;
	gold: number;
	kills: number;
	deaths: number;
	/** Held weapon. */
	weapon: ZdWeaponId;
	/** Owned weapons, in ZD_WEAPONS order. */
	weapons: ZdWeaponId[];
	hpLevel: number;
	damageLevel: number;
	reloadLevel: number;
	/** Pressed Ready in this build phase. */
	ready: boolean;
}

export interface ZdOpeningView {
	planks: number;
	max: number;
	/** "Reinforced" level 0..2. */
	reinforce: number;
}

export interface ZdPadView {
	type: ZdTurretType | null;
	/** 1..3 when built, else 0. */
	level: number;
	/** Player who built it (may have left), null when empty. */
	owner: number | null;
}

export interface ZdStateView {
	phase: ZdPhase;
	/** Games since the map started (1 = the first). */
	round: number;
	/** Current wave (build phase: the wave that comes next; ended: the wave the game was lost in). */
	wave: number;
	/** Seconds until the build phase / summary ends; 0 otherwise. */
	timeLeft: number;
	/** Seconds since the wave started (wave). */
	elapsed: number;
	/** Zombies of the wave still to spawn, alive now, and both together. */
	toSpawn: number;
	alive: number;
	left: number;
	/** Zombies killed this game (players and turrets). */
	kills: number;
	/** The boss's health 0..1 while one is alive, else null. */
	boss: number | null;
	/** By `MapDef.defense.openings` index. */
	openings: ZdOpeningView[];
	/** By `MapDef.defense.pads` index. */
	pads: ZdPadView[];
	players: ZdPlayerView[];
}

type SpawnReason = 'game' | 'join' | 'respawn';
export type ZdPadOp = 'build' | 'upgrade' | 'sell';

export type ZdEvent =
	| { e: 'phase'; phase: ZdPhase; wave: number; round: number }
	/** Teleport `id` (new game, join, respawn) with its hp. */
	| { e: 'spawn'; id: number; x: number; y: number; z: number; yaw: number; hp: number; reason: SpawnReason }
	/** To the shooter: hit marker. */
	| { e: 'hit'; by: number; zid: number; head: boolean; kill: boolean }
	/** `by` 0 with `pad`: a turret kill. `gold`: what the kill paid (to `by`, or the turret's owner). */
	| {
			e: 'kill';
			by: number;
			pad?: number;
			zid: number;
			kind: ZdZombieKind;
			weapon: WeaponId | null;
			head: boolean;
			x: number;
			y: number;
			z: number;
			yaw: number;
			gold: number;
	  }
	/** To everyone but the shooter: tracer / gunshot. `len` = distance to the impact; `pellets` as Infected's. */
	| { e: 'shot'; by: number; weapon: WeaponId; o: Vec3; d: Vec3; len: number; pellets?: number[] }
	/** A player was hit by zombie `zid`. */
	| { e: 'hurt'; id: number; hp: number; zid: number }
	/** To `id`: regeneration. */
	| { e: 'heal'; id: number; hp: number }
	| { e: 'death'; id: number; zid: number }
	/** To `id`: authoritative ammo of the held weapon (rejected shot, swap, purchase). */
	| { e: 'ammo'; id: number; weapon: WeaponId; mag: number; reserve: number }
	/** Plank count of opening `opening` changed: put back by player `by`, or torn off (by null). */
	| { e: 'plank'; opening: number; planks: number; by: number | null }
	/** Opening `opening` lost its last plank. */
	| { e: 'breach'; opening: number; zid: number }
	/** Pad `pad` changed: built, upgraded or sold (`type` null) by `by`. */
	| { e: 'turret'; pad: number; type: ZdTurretType | null; level: number; by: number; op: ZdPadOp }
	/** Mortar shell fired from `pad`, landing at x/y/z after `ms`. */
	| { e: 'shell'; pad: number; x: number; y: number; z: number; ms: number }
	| { e: 'boom'; pad: number; x: number; y: number; z: number; r: number }
	/** Tesla arc from `pad` through zombies `ids` (positions in `pts`, x/y/z flat, chest height). */
	| { e: 'arc'; pad: number; ids: number[]; pts: number[] }
	/** To `id`: answer to a shop purchase, pad action, ready or weapon swap. */
	| { e: 'result'; id: number; act: string; ok: boolean; reason?: string; gold: number }
	| { e: 'ready'; id: number }
	| { e: 'boss'; zid: number; hp: number }
	/** Wave cleared: `bonus` gold to everyone in `ids` (the players in the game). */
	| { e: 'cleared'; wave: number; bonus: number; secs: number; ids: number[] }
	/** The wave ran past ZD_WAVE_MAX_SECS: its remaining zombies were removed. */
	| { e: 'timeout'; wave: number; removed: number }
	| { e: 'end'; wave: number; round: number; kills: number; topId: number | null; topKills: number; secs: number };

/** Who receives an event: one player (`to`), everyone except one (`except`), or everyone. */
export function zdEventRoute(ev: ZdEvent): { to?: number; except?: number } {
	switch (ev.e) {
		case 'spawn':
		case 'ammo':
		case 'heal':
		case 'result':
			return { to: ev.id };
		case 'hit':
			return { to: ev.by };
		case 'shot':
			return { except: ev.by };
		default:
			return {};
	}
}

export interface ZdFire {
	weapon: WeaponId;
	origin: Vec3;
	dir: Vec3;
	/** Zombie sim tick the shooter saw (BIN_DEFENSE); clamped to the history. */
	tick: number;
}

export interface ZdFireResult {
	ok: boolean;
	reason?: string;
	events: ZdEvent[];
}

/** Player actions besides fire/reload (the `zd` client message). */
export type ZdAction =
	| { a: 'ready' }
	/** Hold E at a barricade (on), release (off). */
	| { a: 'repair'; on: boolean }
	| { a: 'weapon'; weapon: ZdWeaponId }
	| { a: 'buy'; item: string }
	| { a: 'pad'; pad: number; op: ZdPadOp; turret?: ZdTurretType };

export interface DefenseZombie {
	readonly id: number;
	readonly kind: ZdZombieKind;
	readonly body: PlayerState;
	yaw: number;
	hp: number;
	readonly maxHp: number;
	state: ZdZombieState;
	/** Opening it heads for / tears at / came through (-1 none). */
	opening: number;
	slowUntil: number;
	slowStacks: number;
	/** Frost factor this step (1 = none). */
	frost: number;
	windupUntil: number;
	nextAttackAt: number;
	attackTarget: number | null;
	hitAt: number;
	/** Next plank comes off at this sim time (tearing). */
	tearAt: number;
	targetId: number | null;
	los: boolean;
	path: number[];
	pathAt: number;
	repathAt: number;
	rethinkAt: number;
	blocked: number;
	stallCheckAt: number;
	stallX: number;
	stallY: number;
	lastProgressAt: number;
	cmd: UserCmd;
}

interface ZdPlayer {
	id: number;
	inGame: boolean;
	alive: boolean;
	hp: number;
	gold: number;
	kills: number;
	deaths: number;
	weapons: Map<ZdWeaponId, WeaponState>;
	held: ZdWeaponId;
	hpLevel: number;
	damageLevel: number;
	reloadLevel: number;
	ready: boolean;
	repairing: boolean;
	nextRepairAt: number;
	plankGold: number;
	lastHurtAt: number;
	nextRegenAt: number;
	iframesUntil: number;
	graceUntil: number;
	pos: ZdPlayerPos | null;
}

interface Opening {
	def: DefenseOpening;
	max: number;
	planks: number;
	reinforce: number;
	/** The one zombie tearing planks off right now (others wait their turn; the boss smashes regardless). */
	tearer: number | null;
	/** Distance from every nav node to this opening's outside node over the outside graph (no opening links). */
	dist: Float64Array;
}

interface Pad {
	def: DefensePad;
	type: ZdTurretType | null;
	level: number;
	owner: number | null;
	yaw: number;
	pitch: number;
	target: number | null;
	nextFireAt: number;
	retargetAt: number;
	firedTick: number;
}

interface Shell {
	pad: number;
	at: number;
	x: number;
	y: number;
	z: number;
	damage: number;
	r: number;
}

interface HistoryFrame {
	tick: number;
	poses: Map<number, HitboxPose>;
}

export interface DefenseGameOptions {
	map: MapDef;
	/** Static map collision; boarded openings are added on top. */
	world: CollisionWorld;
	/** Physics cvars of the map (zombies use them with their own max speed). */
	cvars: Cvars;
	now: number;
	rng?: () => number;
	firstBuildSecs?: number;
	buildSecs?: number;
	endSecs?: number;
	waveMaxSecs?: number;
	maxZombies?: number;
	/** Multiplies spawn intervals (tests: 1e9 = no automatic spawns after the first). */
	spawnIntervalScale?: number;
	/** Server: looser fire/reload timing (ZD_FIRE_TOLERANCE, ZD_RELOAD_TOLERANCE). */
	lenient?: boolean;
	/** Tests: start gold instead of ZD_GOLD.start. */
	startGold?: number;
	/** Tests: the kinds of a wave in spawn order instead of `zdWavePlan`. */
	plan?: (wave: number, players: number) => ZdZombieKind[];
}

/** The static world plus every opening's box (solid while it has a plank): server and client. */
export function defenseWorld(base: CollisionWorld, info: Pick<DefenseMapInfo, 'openings'>): GatedWorld {
	return gatedWorld(base, info.openings);
}

/** Uniform scale about the feet: the Zombie Run hitbox for a scaled zombie. */
function rayScaled(o: Vec3, d: Vec3, p: HitboxPose, maxT: number, s: number) {
	if (s === 1) return rayZombie(o, d, p, maxT);
	const o2 = { x: p.x + (o.x - p.x) / s, y: p.y + (o.y - p.y) / s, z: p.z + (o.z - p.z) / s };
	const h = rayZombie(o2, d, p, maxT / s);
	return h ? { t: h.t * s, head: h.head } : null;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const deg = (r: number) => (r * 180) / Math.PI;

export class DefenseGame {
	phase: ZdPhase = 'waiting';
	/** Games played on this map (the current one included). */
	round = 0;
	/** Current wave (0 before the first). */
	wave = 0;
	endsAt = 0;
	waveStartedAt = 0;
	gameStartedAt = 0;
	kills = 0;
	tick = 0;
	simTime: number;
	readonly zombies = new Map<number, DefenseZombie>();
	readonly map: MapDef;
	readonly info: DefenseMapInfo;
	/** Static world plus boarded openings (movement, zombie sight). */
	readonly world: GatedWorld;
	/** Static world only: bullets and turret shots pass through barricades. */
	readonly base: CollisionWorld;
	readonly nav: NavGraph;
	private readonly openings: Opening[];
	private readonly pads: Pad[];
	private readonly players = new Map<number, ZdPlayer>();
	private readonly rng: () => number;
	private readonly firstBuildMs: number;
	private readonly buildMs: number;
	private readonly endMs: number;
	private readonly waveMaxMs: number;
	private readonly maxZombies: number;
	private readonly spawnScale: number;
	private readonly lenient: boolean;
	private readonly startGold: number;
	private readonly plan: ((wave: number, players: number) => ZdZombieKind[]) | null;
	private readonly zcvars: Cvars;
	private readonly spawns: Spawn[];
	/** Spawn zones sorted by angle around the base (spawning walks round them). */
	private readonly zoneOrder: number[];
	/** Link key → opening index, for links between an opening's outside and inside nodes. */
	private readonly openingLinks = new Map<string, number>();
	private queue: ZdZombieKind[] = [];
	private waveCount = 0;
	private waveIds: number[] = [];
	private zoneCursor = 0;
	private nextSpawnAt = 0;
	private nextZombieId = 1;
	private shells: Shell[] = [];
	private history: HistoryFrame[] = [];
	private pending: ZdEvent[] = [];

	constructor(opts: DefenseGameOptions) {
		const info = opts.map.defense;
		if (!info) throw new Error(`${opts.map.id} has no defense data`);
		this.map = opts.map;
		this.info = info;
		this.base = opts.world;
		this.world = defenseWorld(opts.world, info);
		this.nav = new NavGraph(info.nav);
		this.rng = opts.rng ?? Math.random;
		this.firstBuildMs = (opts.firstBuildSecs ?? ZD_FIRST_BUILD_SECS) * 1000;
		this.buildMs = (opts.buildSecs ?? ZD_BUILD_SECS) * 1000;
		this.endMs = (opts.endSecs ?? ZD_END_SECS) * 1000;
		this.waveMaxMs = (opts.waveMaxSecs ?? ZD_WAVE_MAX_SECS) * 1000;
		this.maxZombies = opts.maxZombies ?? ZD_MAX_ZOMBIES;
		this.spawnScale = opts.spawnIntervalScale ?? 1;
		this.lenient = opts.lenient ?? false;
		this.startGold = opts.startGold ?? ZD_GOLD.start;
		this.plan = opts.plan ?? null;
		this.simTime = opts.now;
		this.zcvars = { ...opts.cvars, sv_autobunnyhopping: 0, sv_enablebunnyhopping: 0 };
		this.spawns = opts.map.spawns && opts.map.spawns.length > 0 ? opts.map.spawns : [opts.map.spawn];
		for (const [i, o] of info.openings.entries()) {
			this.openingLinks.set(`${o.outside}:${o.inside}`, i);
			this.openingLinks.set(`${o.inside}:${o.outside}`, i);
		}
		this.openings = info.openings.map((def) => {
			const max = def.planks ?? ZD_DEFAULT_PLANKS;
			return { def, max, planks: max, reinforce: 0, tearer: null, dist: this.distanceField(def.outside) };
		});
		this.pads = info.pads.map((def) => ({
			def,
			type: null,
			level: 0,
			owner: null,
			yaw: def.yaw,
			pitch: 0,
			target: null,
			nextFireAt: 0,
			retargetAt: 0,
			firedTick: -Infinity
		}));
		// Walk the spawn zones by their angle around the base, so consecutive spawns come from all sides.
		let cx = 0;
		let cy = 0;
		for (const o of info.openings) {
			cx += (o.min.x + o.max.x) / 2 / info.openings.length;
			cy += (o.min.y + o.max.y) / 2 / info.openings.length;
		}
		const angle = (i: number) => {
			const z = info.spawnZones[i]!;
			return Math.atan2((z.min.y + z.max.y) / 2 - cy, (z.min.x + z.max.x) / 2 - cx);
		};
		const order = info.spawnZones.map((_, i) => i).sort((a, b) => angle(a) - angle(b));
		// Opposite sides in turn: 0, n/2, 1, n/2+1, ...
		const half = Math.ceil(order.length / 2);
		this.zoneOrder = [];
		for (let i = 0; i < half; i++) {
			this.zoneOrder.push(order[i]!);
			if (i + half < order.length) this.zoneOrder.push(order[i + half]!);
		}
		this.resetBarricades();
	}

	/** Dijkstra from `goal` over the graph without opening links (zombies outside). */
	private distanceField(goal: number): Float64Array {
		const n = this.nav.nodes.length;
		const dist = new Float64Array(n).fill(Infinity);
		if (goal < 0 || goal >= n) return dist;
		dist[goal] = 0;
		const done = new Uint8Array(n);
		for (;;) {
			let cur = -1;
			for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < Infinity && (cur < 0 || dist[i]! < dist[cur]!)) cur = i;
			if (cur < 0) break;
			done[cur] = 1;
			for (const { to, len } of this.nav.adj[cur]!) {
				if (this.openingLinks.has(`${cur}:${to}`)) continue;
				if (dist[cur]! + len < dist[to]!) dist[to] = dist[cur]! + len;
			}
		}
		return dist;
	}

	// ---------------------------------------------------------------------
	// Players

	/** Active (non-spectating) players. New ones join; missing ones leave. */
	syncPlayers(ids: Iterable<number>, now: number): void {
		const want = new Set(ids);
		for (const id of [...this.players.keys()]) if (!want.has(id)) this.players.delete(id);
		for (const id of want) {
			if (this.players.has(id)) continue;
			const p = this.newPlayer(id);
			this.players.set(id, p);
			if (this.phase === 'build') {
				p.inGame = true;
				this.spawnPlayer(p, this.players.size - 1, now, 'join');
			}
			// Waiting: the game start brings them in; wave/ended: the next build phase / game.
		}
	}

	private newPlayer(id: number): ZdPlayer {
		const p: ZdPlayer = {
			id,
			inGame: false,
			alive: false,
			hp: ZD_PLAYER_HP,
			gold: this.startGold,
			kills: 0,
			deaths: 0,
			weapons: new Map(),
			held: 'pistol',
			hpLevel: 0,
			damageLevel: 0,
			reloadLevel: 0,
			ready: false,
			repairing: false,
			nextRepairAt: 0,
			plankGold: 0,
			lastHurtAt: -Infinity,
			nextRegenAt: 0,
			iframesUntil: 0,
			graceUntil: 0,
			pos: null
		};
		this.resetLoadout(p);
		return p;
	}

	private resetLoadout(p: ZdPlayer): void {
		p.gold = this.startGold;
		p.kills = 0;
		p.deaths = 0;
		p.hpLevel = 0;
		p.damageLevel = 0;
		p.reloadLevel = 0;
		p.weapons.clear();
		p.weapons.set('pistol', this.weaponState('pistol'));
		p.held = 'pistol';
	}

	setPlayerPos(id: number, pos: ZdPlayerPos): void {
		const p = this.players.get(id);
		if (!p) return;
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

	playerView(id: number): ZdPlayerView | null {
		const p = this.players.get(id);
		if (!p) return null;
		return {
			id,
			status: !p.inGame ? 'waiting' : p.alive ? 'alive' : 'dead',
			hp: p.hp,
			maxHp: this.maxHp(p),
			gold: p.gold,
			kills: p.kills,
			deaths: p.deaths,
			weapon: p.held,
			weapons: ZD_WEAPONS.filter((w): w is ZdWeaponId => p.weapons.has(w as ZdWeaponId)),
			hpLevel: p.hpLevel,
			damageLevel: p.damageLevel,
			reloadLevel: p.reloadLevel,
			ready: p.ready
		};
	}

	/** Held weapon state of a player (HUD in solo, tests). */
	weaponOf(id: number): WeaponState | null {
		const p = this.players.get(id);
		return p ? (p.weapons.get(p.held) ?? null) : null;
	}

	/** Plank count of opening `i`. */
	planks(i: number): number {
		return this.openings[i]?.planks ?? 0;
	}

	private maxHp(p: ZdPlayer): number {
		return ZD_PLAYER_HP + ZD_SHOP.hpPerLevel * p.hpLevel;
	}

	private weaponState(w: WeaponId): WeaponState {
		return this.lenient ? new WeaponState(w, ZD_FIRE_TOLERANCE, ZD_RELOAD_TOLERANCE) : new WeaponState(w);
	}

	private living(): ZdPlayer[] {
		const out: ZdPlayer[] = [];
		for (const p of this.players.values()) if (p.inGame && p.alive) out.push(p);
		return out;
	}

	private spawnPlayer(p: ZdPlayer, i: number, now: number, reason: SpawnReason): void {
		p.alive = true;
		p.hp = this.maxHp(p);
		p.iframesUntil = now + 1000;
		p.lastHurtAt = -Infinity;
		p.repairing = false;
		p.graceUntil = now + TELEPORT_GRACE_MS;
		const s = this.spawns[i % this.spawns.length]!;
		p.pos = { x: s.pos.x, y: s.pos.y, z: s.pos.z, ducked: false, yaw: s.yaw };
		this.pending.push({ e: 'spawn', id: p.id, x: s.pos.x, y: s.pos.y, z: s.pos.z, yaw: s.yaw, hp: p.hp, reason });
	}

	private ammoEvent(p: ZdPlayer): ZdEvent {
		const ws = p.weapons.get(p.held)!;
		return { e: 'ammo', id: p.id, weapon: p.held, mag: ws.mag, reserve: ws.reserve };
	}

	// ---------------------------------------------------------------------
	// Player actions

	reload(id: number, now: number): boolean {
		const p = this.players.get(id);
		if (!p || !p.alive || !p.inGame) return false;
		const f = p.reloadLevel > 0 ? ZD_SHOP.reloadFactor : 1;
		return p.weapons.get(p.held)!.startReload(now, f);
	}

	/** Ready, repair, weapon swap, shop purchase, pad action. Returns events to dispatch now. */
	act(id: number, action: ZdAction, now: number): ZdEvent[] {
		const p = this.players.get(id);
		if (!p) return [];
		const result = (act: string, ok: boolean, reason?: string): ZdEvent[] => {
			this.pending.push(
				reason !== undefined ? { e: 'result', id, act, ok, reason, gold: p.gold } : { e: 'result', id, act, ok, gold: p.gold }
			);
			return this.flush();
		};
		if (!p.inGame || !p.alive) return action.a === 'repair' ? [] : result(action.a, false, 'not playing');
		switch (action.a) {
			case 'ready':
				if (this.phase !== 'build') return result('ready', false, 'not build phase');
				if (!p.ready) {
					p.ready = true;
					this.pending.push({ e: 'ready', id });
				}
				return result('ready', true);
			case 'repair':
				if (action.on && !p.repairing) p.nextRepairAt = this.simTime + ZD_REPAIR_MS;
				p.repairing = action.on;
				return [];
			case 'weapon': {
				const ws = p.weapons.get(action.weapon);
				if (!ws) return result('weapon', false, 'not owned');
				if (p.held !== action.weapon) {
					p.weapons.get(p.held)!.reloadEndsAt = 0;
					p.held = action.weapon;
					ws.deploy(now);
				}
				this.pending.push(this.ammoEvent(p));
				return this.flush();
			}
			case 'buy': {
				const r = this.buy(p, action.item, now);
				return result(`buy:${action.item}`, r === null, r ?? undefined);
			}
			case 'pad': {
				const r = this.padAction(p, action.pad, action.op, action.turret);
				return result(`pad:${action.op}`, r === null, r ?? undefined);
			}
		}
	}

	/** A purchase; null when it went through, else the reason. */
	private buy(p: ZdPlayer, id: string, now: number): string | null {
		if (this.phase !== 'build') return 'not build phase';
		const item = parseZdItem(id);
		if (!item) return 'unknown item';
		const pay = (cost: number): boolean => {
			if (p.gold < cost) return false;
			p.gold -= cost;
			return true;
		};
		switch (item.kind) {
			case 'weapon': {
				if (p.weapons.has(item.weapon)) return 'owned';
				if (!pay(ZD_SHOP.weapons[item.weapon])) return 'gold';
				const ws = this.weaponState(item.weapon);
				p.weapons.set(item.weapon, ws);
				p.weapons.get(p.held)!.reloadEndsAt = 0;
				p.held = item.weapon;
				ws.deploy(now);
				this.pending.push(this.ammoEvent(p));
				return null;
			}
			case 'ammo': {
				let missing = false;
				for (const ws of p.weapons.values()) if (ws.mag < ws.def.magazine || ws.reserve < ws.def.reserve) missing = true;
				if (!missing) return 'full';
				if (!pay(ZD_SHOP.ammo)) return 'gold';
				for (const ws of p.weapons.values()) {
					ws.reloadEndsAt = 0;
					ws.mag = ws.def.magazine;
					ws.reserve = ws.def.reserve;
				}
				this.pending.push(this.ammoEvent(p));
				return null;
			}
			case 'hp':
			case 'damage':
			case 'reload': {
				const key = item.kind === 'hp' ? 'hpLevel' : item.kind === 'damage' ? 'damageLevel' : 'reloadLevel';
				const prices = ZD_SHOP[item.kind];
				const lvl = p[key];
				if (lvl >= prices.length) return 'max level';
				if (!pay(prices[lvl]!)) return 'gold';
				p[key] = lvl + 1;
				if (item.kind === 'hp') p.hp += ZD_SHOP.hpPerLevel;
				return null;
			}
			case 'reinforce': {
				const o = this.openings.find((x) => x.def.id === item.opening);
				if (!o) return 'unknown opening';
				if (o.reinforce >= ZD_SHOP.reinforce.length) return 'max level';
				if (!pay(ZD_SHOP.reinforce[o.reinforce]!)) return 'gold';
				o.reinforce++;
				return null;
			}
			case 'repairAll': {
				const fix = this.openings.filter((o, i) => o.planks < o.max && !this.occupied(i));
				const missing = fix.reduce((n, o) => n + o.max - o.planks, 0);
				if (missing === 0) return 'nothing to repair';
				if (!pay(Math.max(ZD_SHOP.repairAllMin, ZD_SHOP.repairAllPerPlank * missing))) return 'gold';
				for (const o of fix) this.setPlanks(this.openings.indexOf(o), o.max, p.id);
				return null;
			}
		}
	}

	private padAction(p: ZdPlayer, i: number, op: ZdPadOp, type: ZdTurretType | undefined): string | null {
		if (this.phase !== 'build') return 'not build phase';
		const pad = this.pads[i];
		if (!pad) return 'unknown pad';
		if (!p.pos || Math.hypot(p.pos.x - pad.def.pos.x, p.pos.y - pad.def.pos.y) > ZD_PAD_RANGE || Math.abs(p.pos.z - pad.def.pos.z) > 96)
			return 'too far';
		switch (op) {
			case 'build': {
				if (pad.type) return 'occupied';
				if (!isZdTurretType(type)) return 'unknown turret';
				const cost = zdTurretCost(type, 1);
				if (p.gold < cost) return 'gold';
				p.gold -= cost;
				Object.assign(pad, { type, level: 1, owner: p.id, yaw: pad.def.yaw, pitch: 0, target: null, nextFireAt: this.simTime, retargetAt: 0 });
				break;
			}
			case 'upgrade': {
				if (!pad.type) return 'empty';
				if (pad.level >= ZD_TURRET_MAX_LEVEL) return 'max level';
				const cost = zdTurretCost(pad.type, pad.level + 1);
				if (p.gold < cost) return 'gold';
				p.gold -= cost;
				pad.level++;
				break;
			}
			case 'sell': {
				if (!pad.type) return 'empty';
				// The builder sells; anyone may once the builder has left.
				if (pad.owner !== p.id && pad.owner !== null && this.players.has(pad.owner)) return 'not yours';
				p.gold += zdTurretRefund(pad.type, pad.level);
				Object.assign(pad, { type: null, level: 0, owner: null, target: null });
				break;
			}
		}
		this.pending.push({ e: 'turret', pad: i, type: pad.type, level: pad.level, by: p.id, op });
		return null;
	}

	/** Resolve a shot (server-authoritative; lag-compensated against the zombie history). */
	fire(id: number, shot: ZdFire, now: number): ZdFireResult {
		const p = this.players.get(id);
		if (!p) return { ok: false, reason: 'not playing', events: [] };
		if (!p.inGame || !p.alive) return { ok: false, reason: 'dead', events: [] };
		const reject = (reason: string): ZdFireResult => ({ ok: false, reason, events: [this.ammoEvent(p)] });
		if (this.phase === 'waiting') return reject('no game');
		if (shot.weapon !== p.held) return reject('wrong weapon');
		const o = shot.origin;
		const d = shot.dir;
		if (!o || !d || ![o.x, o.y, o.z, d.x, d.y, d.z].every(Number.isFinite)) return reject('bad shot');
		const len = Math.hypot(d.x, d.y, d.z);
		if (len < 0.9 || len > 1.1) return reject('bad direction');
		if (p.pos) {
			const dz = o.z - (p.pos.z + VIEW_HEIGHT);
			if (Math.hypot(o.x - p.pos.x, o.y - p.pos.y, dz) > ZD_ORIGIN_SLACK) return reject('bad origin');
		}
		const ws = p.weapons.get(p.held)!;
		if (!ws.fire(now)) return reject(ws.reloading(now) ? 'reloading' : ws.mag <= 0 ? 'empty' : 'too fast');
		const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
		this.resolveShot(p, o, dir, Number.isFinite(shot.tick) ? shot.tick : this.tick);
		return { ok: true, events: this.flush() };
	}

	private flush(): ZdEvent[] {
		const out = this.pending;
		this.pending = [];
		return out;
	}

	private poses(tick: number): Array<{ z: DefenseZombie; pose: HitboxPose }> {
		const t = Math.round(Math.max(this.tick - HISTORY_TICKS, Math.min(this.tick, tick)));
		const frame = t >= this.tick ? undefined : this.history.find((h) => h.tick === t);
		const out: Array<{ z: DefenseZombie; pose: HitboxPose }> = [];
		for (const z of this.zombies.values()) {
			const pose = frame?.poses.get(z.id) ?? { x: z.body.origin.x, y: z.body.origin.y, z: z.body.origin.z, yaw: z.yaw };
			out.push({ z, pose });
		}
		return out;
	}

	private resolveShot(p: ZdPlayer, o: Vec3, d: Vec3, tick: number): void {
		const def = WEAPONS[p.held];
		const pellets = Math.max(1, Math.floor(def.pellets ?? 1));
		const dirs = pellets > 1 ? this.pelletDirs(d, pellets, def.pelletSpread ?? 0) : [d];
		const targets = this.poses(tick);
		const agg = new Map<DefenseZombie, { dmg: number; kb: number; head: boolean }>();
		const pelletData: number[] = [];
		let len = 0;
		const mult = 1 + ZD_SHOP.damagePerLevel * p.damageLevel;
		for (let i = 0; i < dirs.length; i++) {
			const dir = dirs[i]!;
			const end = { x: o.x + dir.x * def.range, y: o.y + dir.y * def.range, z: o.z + dir.z * def.range };
			// Bullets pass through barricades: the static world only.
			const worldT = this.base.trace(o, end, ZERO, ZERO).fraction * def.range;
			const hits: Array<{ z: DefenseZombie; t: number; head: boolean }> = [];
			for (const tg of targets) {
				const h = rayScaled(o, dir, tg.pose, worldT, ZD_ZOMBIES[tg.z.kind].scale);
				if (h) hits.push({ z: tg.z, t: h.t, head: h.head });
			}
			hits.sort((a, b) => a.t - b.t);
			const taken = hits.slice(0, def.pierce);
			const last = taken.length > 0 && taken.length >= def.pierce ? taken[taken.length - 1]!.t : worldT;
			const pl = Math.min(last, worldT);
			if (i === 0) len = pl;
			else pelletData.push(round3(dir.x), round3(dir.y), round3(dir.z), round3(pl));
			for (const h of taken) {
				const zd = ZD_ZOMBIES[h.z.kind];
				const a = agg.get(h.z) ?? { dmg: 0, kb: 0, head: false };
				a.dmg += h.head ? (zd.headKill ? h.z.hp + 1e6 : def.damage * mult * ZD_HEAD_MULT) : def.damage * mult;
				a.kb += def.knockback;
				a.head ||= h.head;
				agg.set(h.z, a);
			}
		}
		const shot: Extract<ZdEvent, { e: 'shot' }> = { e: 'shot', by: p.id, weapon: def.id, o: { ...o }, d: { ...d }, len };
		if (pelletData.length > 0) shot.pellets = pelletData;
		this.pending.push(shot);
		for (const [z, a] of agg) {
			const kill = this.damageZombie(z, a.dmg, { player: p, weapon: def.id, head: a.head });
			this.pending.push({ e: 'hit', by: p.id, zid: z.id, head: a.head, kill });
			if (kill) continue;
			z.slowStacks = this.simTime < z.slowUntil ? Math.min(ZD_SLOW_FACTORS.length - 1, z.slowStacks + 1) : 1;
			z.slowUntil = this.simTime + ZD_SLOW_MS;
			const kb = a.kb / ZD_ZOMBIES[z.kind].scale ** 3;
			if (kb > 0) {
				const h = Math.hypot(d.x, d.y) || 1;
				z.body.velocity.x = (d.x / h) * kb;
				z.body.velocity.y = (d.y / h) * kb;
			}
		}
	}

	/** `n` unit pellet directions: `d` itself, then uniform in the cone of half-angle `spreadDeg` around it. */
	private pelletDirs(d: Vec3, n: number, spreadDeg: number): Vec3[] {
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

	/**
	 * Damage a zombie; returns true when it died (kill event, gold, counters).
	 * `src`: a player's weapon or a turret pad.
	 */
	private damageZombie(
		z: DefenseZombie,
		dmg: number,
		src: { player: ZdPlayer; weapon: WeaponId; head: boolean } | { pad: number }
	): boolean {
		if (!this.zombies.has(z.id) || dmg <= 0) return false;
		z.hp -= dmg;
		z.hitAt = this.simTime;
		if (z.hp > 1e-6) return false;
		this.zombies.delete(z.id);
		this.kills++;
		const o = z.body.origin;
		let by = 0;
		let gold = 0;
		if ('player' in src) {
			by = src.player.id;
			gold = src.head ? ZD_GOLD.headshotKill : ZD_GOLD.kill;
			src.player.kills++;
			src.player.gold += gold;
			this.pending.push({ e: 'kill', by, zid: z.id, kind: z.kind, weapon: src.weapon, head: src.head, x: o.x, y: o.y, z: o.z, yaw: z.yaw, gold });
		} else {
			const owner = this.pads[src.pad]?.owner;
			const op = owner !== null && owner !== undefined ? this.players.get(owner) : undefined;
			if (op?.inGame) {
				gold = ZD_GOLD.turretKill;
				op.gold += gold;
			}
			this.pending.push({ e: 'kill', by: 0, pad: src.pad, zid: z.id, kind: z.kind, weapon: null, head: false, x: o.x, y: o.y, z: o.z, yaw: z.yaw, gold });
		}
		return true;
	}

	// ---------------------------------------------------------------------
	// Game flow

	/** Advance rules and the simulation to `now`. Returns events since the last call. */
	update(now: number): ZdEvent[] {
		if (this.players.size === 0) {
			if (this.phase !== 'waiting') {
				this.phase = 'waiting';
				this.endsAt = 0;
				this.zombies.clear();
				this.queue = [];
				this.shells = [];
				this.history = [];
				this.pending.push({ e: 'phase', phase: 'waiting', wave: this.wave, round: this.round });
			}
		} else if (this.phase === 'waiting') this.startGame(now);
		else if (this.phase === 'build') {
			const living = this.living();
			if (now >= this.endsAt || (living.length > 0 && living.every((p) => p.ready))) this.startWave(now);
		} else if (this.phase === 'ended' && now >= this.endsAt) this.startGame(now);

		if (now - this.simTime > ZD_STEP_MS * 8) this.simTime = now - ZD_STEP_MS * 8;
		while (this.simTime + ZD_STEP_MS <= now) {
			this.simTime += ZD_STEP_MS;
			this.step(now);
		}

		if (this.phase === 'wave') {
			if (this.living().length === 0) this.endGame(now);
			else if (this.queue.length === 0 && this.zombies.size === 0) this.clearWave(now);
			else if (now - this.waveStartedAt > this.waveMaxMs) {
				const removed = this.zombies.size + this.queue.length;
				this.zombies.clear();
				this.queue = [];
				this.pending.push({ e: 'timeout', wave: this.wave, removed });
				this.clearWave(now);
			}
		}
		return this.flush();
	}

	private resetBarricades(): void {
		for (const [i, o] of this.openings.entries()) {
			o.planks = o.max;
			o.reinforce = 0;
			o.tearer = null;
			this.world.setOpen(i, o.planks === 0);
		}
	}

	private startGame(now: number): void {
		this.round++;
		this.wave = 0;
		this.kills = 0;
		this.gameStartedAt = now;
		this.zombies.clear();
		this.queue = [];
		this.shells = [];
		this.history = [];
		this.resetBarricades();
		for (const pad of this.pads) Object.assign(pad, { type: null, level: 0, owner: null, target: null, yaw: pad.def.yaw, pitch: 0 });
		let i = 0;
		for (const p of this.players.values()) {
			this.resetLoadout(p);
			p.inGame = true;
			p.ready = false;
			this.spawnPlayer(p, i++, now, 'game');
		}
		this.startBuild(now, true);
	}

	private startBuild(now: number, first: boolean): void {
		this.phase = 'build';
		this.endsAt = now + (first ? this.firstBuildMs : this.buildMs);
		let i = 0;
		for (const p of this.players.values()) {
			p.ready = false;
			p.plankGold = 0;
			if (!p.inGame) {
				// Joined during the wave or the summary: plays from now, with the start loadout.
				this.resetLoadout(p);
				p.inGame = true;
				this.spawnPlayer(p, i++, now, 'join');
			} else if (!p.alive) this.spawnPlayer(p, i++, now, 'respawn');
			else {
				p.hp = this.maxHp(p);
				i++;
			}
		}
		this.pending.push({ e: 'phase', phase: 'build', wave: this.wave + 1, round: this.round });
	}

	private startWave(now: number): void {
		this.phase = 'wave';
		this.wave++;
		this.waveStartedAt = now;
		const living = this.living();
		this.waveIds = [...this.players.values()].filter((p) => p.inGame).map((p) => p.id);
		const n = Math.max(1, living.length);
		this.queue = this.plan ? this.plan(this.wave, n) : zdWavePlan(this.wave, n, this.rng);
		this.waveCount = this.queue.length;
		this.zoneCursor = Math.floor(this.rng() * Math.max(1, this.zoneOrder.length));
		this.nextSpawnAt = this.simTime + 1000;
		for (const p of this.players.values()) p.ready = false;
		this.pending.push({ e: 'phase', phase: 'wave', wave: this.wave, round: this.round });
	}

	private clearWave(now: number): void {
		const bonus = ZD_GOLD.waveBonus(this.wave);
		const ids: number[] = [];
		for (const p of this.players.values()) {
			if (!p.inGame) continue;
			p.gold += bonus;
			ids.push(p.id);
		}
		this.pending.push({ e: 'cleared', wave: this.wave, bonus, secs: Math.round((now - this.waveStartedAt) / 100) / 10, ids });
		this.startBuild(now, false);
	}

	private endGame(now: number): void {
		this.phase = 'ended';
		this.endsAt = now + this.endMs;
		this.queue = [];
		let top: ZdPlayer | null = null;
		for (const p of this.players.values()) if (p.inGame && (!top || p.kills > top.kills)) top = p;
		this.pending.push({
			e: 'end',
			wave: this.wave,
			round: this.round,
			kills: this.kills,
			topId: top && top.kills > 0 ? top.id : null,
			topKills: top?.kills ?? 0,
			secs: Math.round((now - this.gameStartedAt) / 100) / 10
		});
		this.pending.push({ e: 'phase', phase: 'ended', wave: this.wave, round: this.round });
	}

	// ---------------------------------------------------------------------
	// Simulation step

	private step(now: number): void {
		this.tick++;
		const living = this.living();
		const playing = this.phase === 'build' || this.phase === 'wave';
		if (playing) {
			this.repairs(living);
			this.regen(living);
		}
		if (this.phase === 'wave') this.spawnZombies();
		this.applyFrost();
		const zs = [...this.zombies.values()];
		for (const z of zs) if (this.zombies.has(z.id)) this.moveZombie(z, zs, living);
		if (this.phase === 'wave') {
			for (const z of zs) if (this.zombies.has(z.id)) this.attack(z, living, now);
			this.turrets();
			this.landShells();
		}
		this.recordHistory();
	}

	private occupied(i: number): boolean {
		const o = this.openings[i]!.def;
		const hit = (p: Vec3, top: number) =>
			p.x + HULL_MAX.x > o.min.x &&
			p.x + HULL_MIN.x < o.max.x &&
			p.y + HULL_MAX.y > o.min.y &&
			p.y + HULL_MIN.y < o.max.y &&
			p.z + top > o.min.z &&
			p.z < o.max.z;
		for (const z of this.zombies.values()) if (hit(z.body.origin, HULL_MAX.z)) return true;
		for (const p of this.players.values()) if (p.inGame && p.alive && p.pos && hit(p.pos, p.pos.ducked ? DUCK_HULL_MAX.z : HULL_MAX.z)) return true;
		return false;
	}

	private setPlanks(i: number, n: number, by: number | null, zid = 0): void {
		const o = this.openings[i]!;
		if (o.planks === n) return;
		o.planks = n;
		this.world.setOpen(i, n === 0);
		this.pending.push({ e: 'plank', opening: i, planks: n, by });
		if (n === 0) this.pending.push({ e: 'breach', opening: i, zid });
	}

	/** Players holding E near an opening's inside node put a plank back every ZD_REPAIR_MS. */
	private repairs(living: ZdPlayer[]): void {
		for (const p of living) {
			if (!p.repairing || !p.pos || this.simTime < p.nextRepairAt) continue;
			let best = -1;
			let bestD = ZD_REPAIR_RANGE;
			for (const [i, o] of this.openings.entries()) {
				if (o.planks >= o.max) continue;
				const n = this.nav.nodes[o.def.inside];
				if (!n || Math.abs(n.z - p.pos.z) > 64) continue;
				const d = Math.hypot(n.x - p.pos.x, n.y - p.pos.y);
				if (d <= bestD) {
					bestD = d;
					best = i;
				}
			}
			if (best < 0 || this.occupied(best)) continue;
			p.nextRepairAt = this.simTime + ZD_REPAIR_MS;
			this.setPlanks(best, this.openings[best]!.planks + 1, p.id);
			const gold = Math.min(ZD_GOLD.plank, ZD_GOLD.plankCapPerWave - p.plankGold);
			if (gold > 0) {
				p.gold += gold;
				p.plankGold += gold;
			}
		}
	}

	private regen(living: ZdPlayer[]): void {
		for (const p of living) {
			const max = this.maxHp(p);
			if (p.hp >= max || this.simTime < p.lastHurtAt + ZD_REGEN_DELAY_MS || this.simTime < p.nextRegenAt) continue;
			p.hp++;
			p.nextRegenAt = this.simTime + ZD_REGEN_EVERY_MS;
			this.pending.push({ e: 'heal', id: p.id, hp: p.hp });
		}
	}

	private spawnZombies(): void {
		if (this.queue.length === 0 || this.simTime < this.nextSpawnAt) return;
		const living = this.living().length;
		const due = Math.max(this.nextSpawnAt, this.simTime - ZD_STEP_MS);
		this.nextSpawnAt = due + zdSpawnInterval(Math.max(1, this.waveIds.length)) * this.spawnScale;
		if (this.zombies.size >= this.maxZombies || living === 0) return;
		const zones = this.info.spawnZones;
		for (let tries = 0; tries < zones.length; tries++) {
			const zi = this.zoneOrder[this.zoneCursor++ % this.zoneOrder.length]!;
			const zone = zones[zi]!;
			const x = zone.min.x + 16 + this.rng() * Math.max(0, zone.max.x - zone.min.x - 32);
			const y = zone.min.y + 16 + this.rng() * Math.max(0, zone.max.y - zone.min.y - 32);
			const kind = this.queue[0]!;
			const z = this.spawnZombie(kind, { x, y, z: zone.min.z + 0.25 });
			if (!z) continue;
			this.queue.shift();
			if (kind === 'boss') this.pending.push({ e: 'boss', zid: z.id, hp: z.maxHp });
			return;
		}
	}

	/** Add an AI zombie at a feet position (also used by tests). Returns null if the spot is blocked. */
	spawnZombie(kind: ZdZombieKind, pos: Vec3): DefenseZombie | null {
		if (this.world.trace(pos, pos, HULL_MIN, HULL_MAX).startsolid) return null;
		const hp = zdZombieHp(kind, Math.max(1, this.wave), Math.max(1, this.waveIds.length));
		const z: DefenseZombie = {
			id: this.nextZombieId,
			kind,
			body: createPlayer(pos),
			yaw: 0,
			hp,
			maxHp: hp,
			state: 'approach',
			opening: -1,
			slowUntil: 0,
			slowStacks: 0,
			frost: 1,
			windupUntil: 0,
			nextAttackAt: 0,
			attackTarget: null,
			hitAt: -Infinity,
			tearAt: 0,
			targetId: null,
			los: false,
			path: [],
			pathAt: 0,
			repathAt: 0,
			rethinkAt: 0,
			blocked: 0,
			stallCheckAt: this.simTime + STALL_CHECK_MS,
			stallX: pos.x,
			stallY: pos.y,
			lastProgressAt: this.simTime,
			cmd: { pitch: 0, yaw: 0, forwardmove: 0, sidemove: 0, buttons: 0 }
		};
		this.nextZombieId = this.nextZombieId >= 65535 ? 1 : this.nextZombieId + 1;
		this.zombies.set(z.id, z);
		return z;
	}

	/** Put a stalled zombie back at a spawn zone, heading for an opening again. */
	private respawnStalled(z: DefenseZombie): void {
		const zones = this.info.spawnZones;
		for (let tries = 0; tries < zones.length; tries++) {
			const zone = zones[this.zoneOrder[this.zoneCursor++ % this.zoneOrder.length]!]!;
			const pos = { x: (zone.min.x + zone.max.x) / 2, y: (zone.min.y + zone.max.y) / 2, z: zone.min.z + 0.25 };
			if (this.world.trace(pos, pos, HULL_MIN, HULL_MAX).startsolid) continue;
			Object.assign(z.body.origin, pos);
			z.body.velocity.x = z.body.velocity.y = z.body.velocity.z = 0;
			break;
		}
		z.state = 'approach';
		z.opening = -1;
		z.path = [];
		z.rethinkAt = 0;
		z.windupUntil = 0;
		z.lastProgressAt = this.simTime;
		z.stallX = z.body.origin.x;
		z.stallY = z.body.origin.y;
	}

	private applyFrost(): void {
		for (const z of this.zombies.values()) z.frost = 1;
		if (this.phase !== 'wave') return;
		for (const pad of this.pads) {
			if (pad.type !== 'frost') continue;
			const lv = ZD_TURRETS.frost.levels[pad.level - 1]!;
			let any = false;
			for (const z of this.zombies.values()) {
				const o = z.body.origin;
				if (Math.hypot(o.x - pad.def.pos.x, o.y - pad.def.pos.y) > lv.range || Math.abs(o.z - pad.def.pos.z) > 200) continue;
				z.frost = Math.min(z.frost, lv.extra);
				any = true;
			}
			pad.target = null;
			if (any) pad.firedTick = this.tick;
		}
	}

	/** Pick the opening to attack: shortest walk, fewer zombies already there, open ones preferred. */
	private chooseOpening(z: DefenseZombie, node: number): number {
		const crowd = new Array<number>(this.openings.length).fill(0);
		for (const q of this.zombies.values()) if (q !== z && q.opening >= 0 && q.state !== 'inside') crowd[q.opening]!++;
		let best = -1;
		let bestCost = Infinity;
		for (const [i, o] of this.openings.entries()) {
			const d = o.dist[node]!;
			if (!Number.isFinite(d)) continue;
			const cost = d + 180 * crowd[i]! - (o.planks === 0 ? 500 : 0) + this.rng() * 120;
			if (cost < bestCost) {
				bestCost = cost;
				best = i;
			}
		}
		return best;
	}

	/** Next node on the way to opening `i` from node `n` (down its distance field), or -1 at the goal. */
	private nextTowards(i: number, n: number): number {
		const dist = this.openings[i]!.dist;
		let best = -1;
		let bestD = dist[n]!;
		for (const { to, len } of this.nav.adj[n]!) {
			if (this.openingLinks.has(`${n}:${to}`)) continue;
			const d = dist[to]! + len;
			if (dist[to]! < bestD && d <= dist[n]! + 1e-6) {
				bestD = dist[to]!;
				best = to;
			}
		}
		return best;
	}

	private closedFor(a: number, b: number): boolean {
		const i = this.openingLinks.get(`${a}:${b}`);
		return i !== undefined && this.openings[i]!.planks > 0;
	}

	private nearestPlayer(o: Vec3, living: ZdPlayer[]): ZdPlayer | null {
		let best: ZdPlayer | null = null;
		let bestD = Infinity;
		for (const p of living) {
			if (!p.pos) continue;
			const d = (p.pos.x - o.x) ** 2 + (p.pos.y - o.y) ** 2 + 4 * (p.pos.z - o.z) ** 2;
			if (d < bestD) {
				bestD = d;
				best = p;
			}
		}
		return best;
	}

	private sight(a: Vec3, b: Vec3): boolean {
		return this.world.trace({ x: a.x, y: a.y, z: a.z + 40 }, { x: b.x, y: b.y, z: b.z + 40 }, ZERO, ZERO).fraction >= 1;
	}

	/** Steer target for path following: the current node, advanced when reached. */
	private followPath(z: DefenseZombie): Vec3 | null {
		const o = z.body.origin;
		while (z.pathAt < z.path.length) {
			const n = this.nav.nodes[z.path[z.pathAt]!]!;
			if (Math.hypot(n.x - o.x, n.y - o.y) > NODE_REACHED) return n;
			z.pathAt++;
		}
		return null;
	}

	/** Start a path at the node that is not behind the zombie. */
	private setPath(z: DefenseZombie, path: number[] | null): void {
		z.path = path ?? [];
		z.pathAt = 0;
		if (z.path.length >= 2) {
			const o = z.body.origin;
			const a = this.nav.nodes[z.path[0]!]!;
			const b = this.nav.nodes[z.path[1]!]!;
			if (Math.hypot(b.x - o.x, b.y - o.y) < Math.hypot(b.x - a.x, b.y - a.y)) z.pathAt = 1;
		}
	}

	private boxDist(o: Vec3, def: DefenseOpening): number {
		const dx = Math.max(def.min.x - o.x, 0, o.x - def.max.x);
		const dy = Math.max(def.min.y - o.y, 0, o.y - def.max.y);
		return Math.hypot(dx, dy);
	}

	/** AI: state machine (approach → tear → enter → inside), steering, separation, jumps, stall breaker. */
	private moveZombie(z: DefenseZombie, all: DefenseZombie[], living: ZdPlayer[]): void {
		const b = z.body;
		const o = b.origin;
		const def = ZD_ZOMBIES[z.kind];
		const cmd = z.cmd;
		cmd.buttons = 0;
		cmd.forwardmove = 0;
		cmd.sidemove = 0;
		const think = (this.tick + z.id) % THINK_EVERY === 0;
		const active = this.phase === 'wave';
		let goal: Vec3 | null = null;
		let face: Vec3 | null = null;
		let wantJump = false;
		let busy = false;

		if (active && think) {
			const t = this.nearestPlayer(o, living);
			z.targetId = t?.id ?? null;
		}
		const target = z.targetId !== null ? this.players.get(z.targetId) : undefined;
		const tp = target && target.inGame && target.alive ? target.pos : null;

		if (active && z.state !== 'inside' && tp) {
			// A player close by outside (or right at the barricade's inside) in sight: go for them.
			const d = Math.hypot(tp.x - o.x, tp.y - o.y);
			if (d < OUTSIDE_CHASE && Math.abs(tp.z - o.z) < 80) {
				if (think) z.los = this.sight(o, tp);
				if (z.los) goal = tp;
			}
		}

		if (!active) {
			// Build/ended: zombies left over stand still.
		} else if (goal) {
			busy = Math.hypot(tp!.x - o.x, tp!.y - o.y) < def.reach * 2;
		} else if (z.state === 'approach') {
			const node = this.nav.nearest(o);
			if (z.opening < 0 || this.simTime >= z.rethinkAt) {
				z.opening = this.chooseOpening(z, node);
				z.rethinkAt = this.simTime + RETHINK_OPENING_MS;
				z.path = [];
			}
			const op = this.openings[z.opening];
			if (op) {
				const out = this.nav.nodes[op.def.outside]!;
				const atOpening = this.boxDist(o, op.def) < TEAR_DIST || Math.hypot(out.x - o.x, out.y - o.y) < NODE_REACHED;
				if (atOpening) {
					if (op.planks > 0) {
						z.state = 'tear';
						z.tearAt = this.simTime + this.tearMs(z, op);
					} else z.state = 'enter';
				} else {
					if (z.path.length === 0 || z.pathAt >= z.path.length) {
						const path = [node];
						for (let n = node, k = 0; k < this.nav.nodes.length; k++) {
							const nx = this.nextTowards(z.opening, n);
							if (nx < 0) break;
							path.push(nx);
							n = nx;
						}
						this.setPath(z, path);
					}
					goal = this.followPath(z) ?? out;
				}
			}
		}
		if (active && !goal && (z.state === 'tear' || z.state === 'enter') && !this.openings[z.opening]) z.state = 'approach';
		if (active && !goal && z.state === 'tear') {
			const op = this.openings[z.opening]!;
			busy = true;
			if (op.planks === 0) z.state = 'enter';
			else {
				const c = { x: (op.def.min.x + op.def.max.x) / 2, y: (op.def.min.y + op.def.max.y) / 2, z: o.z };
				face = c;
				if (this.boxDist(o, op.def) > TEAR_DIST * 0.6) goal = c;
				if (z.kind !== 'boss' && op.tearer !== z.id) {
					const t = op.tearer !== null ? this.zombies.get(op.tearer) : undefined;
					if (!t || t.state !== 'tear' || t.opening !== z.opening) {
						op.tearer = z.id;
						z.tearAt = this.simTime + this.tearMs(z, op);
					}
				}
				if ((z.kind === 'boss' || op.tearer === z.id) && this.simTime >= z.tearAt) {
					this.setPlanks(z.opening, z.kind === 'boss' ? 0 : op.planks - 1, null, z.id);
					z.tearAt = this.simTime + this.tearMs(z, op);
				}
			}
		}
		if (active && !goal && z.state === 'enter') {
			const op = this.openings[z.opening]!;
			const inside = this.nav.nodes[op.def.inside]!;
			if (op.planks > 0 && this.boxDist(o, op.def) < TEAR_DIST) {
				z.state = 'tear';
				z.tearAt = this.simTime + this.tearMs(z, op);
			} else if (Math.hypot(inside.x - o.x, inside.y - o.y) < NODE_REACHED) {
				z.state = 'inside';
				z.path = [];
			} else goal = inside;
		}
		if (active && !goal && z.state === 'inside' && tp) {
			const dx = tp.x - o.x;
			const dy = tp.y - o.y;
			const dz = tp.z - o.z;
			const dist = Math.hypot(dx, dy);
			let direct = dist < 160 && Math.abs(dz) < 80;
			if (!direct && dist < 1400 && Math.abs(dz) < 100) {
				if (think) z.los = this.sight(o, tp);
				direct = z.los;
			}
			busy = dist < def.reach * 2;
			if (direct) {
				goal = tp;
				if (dist < 90 && dz > 24 && b.onGround) wantJump = true;
			} else {
				if (this.simTime >= z.repathAt || z.pathAt >= z.path.length) {
					z.repathAt = this.simTime + REPATH_MS;
					this.setPath(z, this.nav.path(this.nav.nearest(o), this.nav.nearest(tp), (a, c) => this.closedFor(a, c)));
				}
				goal = this.followPath(z) ?? tp;
			}
		}

		const tx = goal ?? face;
		let wx = tx ? tx.x - o.x : 0;
		let wy = tx ? tx.y - o.y : 0;
		const wl = Math.hypot(wx, wy);
		if (wl > 1e-3) {
			wx /= wl;
			wy /= wl;
			if (goal) {
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
				cmd.forwardmove = 450;
				const speed = Math.hypot(b.velocity.x, b.velocity.y);
				if (b.onGround && speed < 60 && this.simTime > z.hitAt + 300) z.blocked++;
				else z.blocked = 0;
				if (z.blocked > 12) {
					wantJump = true;
					z.blocked = 0;
				}
			}
			z.yaw = deg(Math.atan2(wy, wx));
		}
		if (wantJump && b.onGround) cmd.buttons |= IN_JUMP;
		cmd.yaw = z.yaw;
		const slowed = this.simTime < z.slowUntil;
		if (!slowed) z.slowStacks = 0;
		const hitSlow = ZD_SLOW_FACTORS[Math.min(ZD_SLOW_FACTORS.length - 1, slowed ? z.slowStacks : 0)]!;
		let speed = def.speed * Math.min(hitSlow, z.frost);
		if (z.windupUntil > 0) speed *= 0.7;
		this.zcvars.sv_maxspeed = speed;
		playerMove(this.world, b, cmd, this.zcvars, ZD_STEP_MS / 1000);

		// Stall breaker: no progress (moving, tearing, fighting) for ZD_STALL_MS.
		if (!active) {
			z.lastProgressAt = this.simTime;
			return;
		}
		if (this.simTime >= z.stallCheckAt) {
			const moved = Math.hypot(o.x - z.stallX, o.y - z.stallY);
			if (moved >= STALL_MOVE || busy || z.windupUntil > 0) z.lastProgressAt = this.simTime;
			z.stallX = o.x;
			z.stallY = o.y;
			z.stallCheckAt = this.simTime + STALL_CHECK_MS;
			if (this.simTime - z.lastProgressAt >= ZD_STALL_MS) this.respawnStalled(z);
		}
	}

	private tearMs(z: DefenseZombie, op: Opening): number {
		return ZD_ZOMBIES[z.kind].tearMs * ZD_REINFORCE_FACTORS[Math.min(ZD_REINFORCE_FACTORS.length - 1, op.reinforce)]!;
	}

	/** Wind up on the nearest living player in reach and sight (not through planks), then hit if still in reach. */
	private attack(z: DefenseZombie, living: ZdPlayer[], now: number): void {
		const def = ZD_ZOMBIES[z.kind];
		const o = z.body.origin;
		const inReach = (p: ZdPlayer | undefined, scale: number) =>
			!!p?.pos && p.inGame && p.alive && Math.hypot(p.pos.x - o.x, p.pos.y - o.y) <= def.reach * scale && Math.abs(p.pos.z - o.z) < 64 + 16 * def.scale;
		if (z.windupUntil === 0) {
			if (this.simTime < z.nextAttackAt) return;
			let best: ZdPlayer | null = null;
			let bestD = Infinity;
			for (const p of living) {
				if (!inReach(p, 1)) continue;
				const d = Math.hypot(p.pos!.x - o.x, p.pos!.y - o.y);
				if (d < bestD && this.sight(o, p.pos!)) {
					bestD = d;
					best = p;
				}
			}
			if (!best) return;
			z.attackTarget = best.id;
			z.windupUntil = this.simTime + ZD_ATTACK_WINDUP_MS;
			return;
		}
		if (this.simTime < z.windupUntil) return;
		z.windupUntil = 0;
		z.nextAttackAt = this.simTime + ZD_ATTACK_COOLDOWN_MS;
		const t = z.attackTarget !== null ? this.players.get(z.attackTarget) : undefined;
		if (t && inReach(t, 1.3) && this.sight(o, t.pos!)) this.hurt(t, z, now);
	}

	private hurt(p: ZdPlayer, z: DefenseZombie, now: number): void {
		if (!p.alive || now < p.iframesUntil) return;
		p.hp = Math.max(0, p.hp - ZD_ZOMBIES[z.kind].damage);
		p.iframesUntil = now + ZD_PLAYER_IFRAMES_MS;
		p.lastHurtAt = this.simTime;
		p.nextRegenAt = this.simTime + ZD_REGEN_DELAY_MS;
		this.pending.push({ e: 'hurt', id: p.id, hp: p.hp, zid: z.id });
		if (p.hp > 0) return;
		p.alive = false;
		p.deaths++;
		p.repairing = false;
		p.ready = false;
		const ws = p.weapons.get(p.held);
		if (ws) ws.reloadEndsAt = 0;
		this.pending.push({ e: 'death', id: p.id, zid: z.id });
	}

	// ---------------------------------------------------------------------
	// Turrets

	private muzzle(pad: Pad): Vec3 {
		return { x: pad.def.pos.x, y: pad.def.pos.y, z: pad.def.pos.z + ZD_TURRET_HEIGHT };
	}

	private chest(z: DefenseZombie): Vec3 {
		const o = z.body.origin;
		return { x: o.x, y: o.y, z: o.z + 40 * ZD_ZOMBIES[z.kind].scale };
	}

	private clearShot(from: Vec3, to: Vec3): boolean {
		return this.base.trace(from, to, ZERO, ZERO).fraction >= 1;
	}

	/** Best target of a turret: zombies inside first, then the nearest, in range (and sight). */
	private acquire(pad: Pad): DefenseZombie | null {
		const t = ZD_TURRETS[pad.type!];
		const lv = t.levels[pad.level - 1]!;
		const m = this.muzzle(pad);
		const cands: Array<{ z: DefenseZombie; key: number }> = [];
		for (const z of this.zombies.values()) {
			const c = this.chest(z);
			const d = Math.hypot(c.x - m.x, c.y - m.y, c.z - m.z);
			if (d > lv.range || (t.minRange !== undefined && d < t.minRange)) continue;
			cands.push({ z, key: d - (z.state === 'inside' ? 1e5 : 0) });
		}
		cands.sort((a, b) => a.key - b.key);
		for (const c of cands.slice(0, 12)) if (!t.los || this.clearShot(m, this.chest(c.z))) return c.z;
		return null;
	}

	private turrets(): void {
		for (const [i, pad] of this.pads.entries()) {
			if (!pad.type || pad.type === 'frost') continue;
			const t = ZD_TURRETS[pad.type];
			const lv = t.levels[pad.level - 1]!;
			let target = pad.target !== null ? this.zombies.get(pad.target) : undefined;
			const m = this.muzzle(pad);
			if (target) {
				const c = this.chest(target);
				const d = Math.hypot(c.x - m.x, c.y - m.y, c.z - m.z);
				if (d > lv.range || (t.minRange !== undefined && d < t.minRange)) target = undefined;
			}
			if (!target || this.tick >= pad.retargetAt) {
				target = this.acquire(pad) ?? undefined;
				pad.retargetAt = this.tick + THINK_EVERY;
			}
			pad.target = target?.id ?? null;
			if (!target) continue;
			const c = this.chest(target);
			pad.yaw = deg(Math.atan2(c.y - m.y, c.x - m.x));
			pad.pitch = deg(Math.atan2(c.z - m.z, Math.hypot(c.x - m.x, c.y - m.y)));
			if (this.simTime < pad.nextFireAt) continue;
			pad.nextFireAt = Math.max(pad.nextFireAt + lv.fireMs, this.simTime);
			pad.firedTick = this.tick;
			switch (pad.type) {
				case 'sentry':
					this.damageZombie(target, lv.damage, { pad: i });
					break;
				case 'scatter': {
					const ax = (c.x - m.x) / (Math.hypot(c.x - m.x, c.y - m.y, c.z - m.z) || 1);
					const ay = (c.y - m.y) / (Math.hypot(c.x - m.x, c.y - m.y, c.z - m.z) || 1);
					const az = (c.z - m.z) / (Math.hypot(c.x - m.x, c.y - m.y, c.z - m.z) || 1);
					const cos = Math.cos((lv.extra * Math.PI) / 180);
					for (const z of [...this.zombies.values()]) {
						const q = this.chest(z);
						const d = Math.hypot(q.x - m.x, q.y - m.y, q.z - m.z);
						if (d > lv.range || d < 1e-3) continue;
						if (((q.x - m.x) * ax + (q.y - m.y) * ay + (q.z - m.z) * az) / d < cos) continue;
						if (z !== target && !this.clearShot(m, q)) continue;
						this.damageZombie(z, lv.damage, { pad: i });
					}
					break;
				}
				case 'mortar': {
					// Lead the target by its velocity over the flight time (two passes).
					const tb = target.body;
					let ms = Math.max(400, (Math.hypot(tb.origin.x - m.x, tb.origin.y - m.y) / ZD_SHELL_SPEED) * 1000);
					const lead = (t: number) => ({
						x: tb.origin.x + tb.velocity.x * (t / 1000),
						y: tb.origin.y + tb.velocity.y * (t / 1000),
						z: tb.origin.z
					});
					ms = Math.max(400, (Math.hypot(lead(ms).x - m.x, lead(ms).y - m.y) / ZD_SHELL_SPEED) * 1000);
					const o = lead(ms);
					this.shells.push({ pad: i, at: this.simTime + ms, x: o.x, y: o.y, z: o.z, damage: lv.damage, r: lv.extra });
					this.pending.push({ e: 'shell', pad: i, x: round3(o.x), y: round3(o.y), z: round3(o.z), ms: Math.round(ms) });
					break;
				}
				case 'tesla': {
					const hit: DefenseZombie[] = [target];
					while (hit.length < lv.extra) {
						const last = hit[hit.length - 1]!.body.origin;
						let next: DefenseZombie | null = null;
						let nd = ZD_TESLA_JUMP;
						for (const z of this.zombies.values()) {
							if (hit.includes(z)) continue;
							const d = Math.hypot(z.body.origin.x - last.x, z.body.origin.y - last.y, z.body.origin.z - last.z);
							if (d < nd && this.clearShot(this.chest(hit[hit.length - 1]!), this.chest(z))) {
								nd = d;
								next = z;
							}
						}
						if (!next) break;
						hit.push(next);
					}
					const pts: number[] = [];
					for (const z of hit) {
						const q = this.chest(z);
						pts.push(round3(q.x), round3(q.y), round3(q.z));
					}
					this.pending.push({ e: 'arc', pad: i, ids: hit.map((z) => z.id), pts });
					for (const z of hit) this.damageZombie(z, lv.damage, { pad: i });
					break;
				}
			}
			if (!this.zombies.has(target.id)) pad.target = null;
		}
	}

	private landShells(): void {
		if (this.shells.length === 0) return;
		const keep: Shell[] = [];
		for (const s of this.shells) {
			if (this.simTime < s.at) {
				keep.push(s);
				continue;
			}
			this.pending.push({ e: 'boom', pad: s.pad, x: round3(s.x), y: round3(s.y), z: round3(s.z), r: s.r });
			for (const z of [...this.zombies.values()]) {
				const o = z.body.origin;
				const d = Math.hypot(o.x - s.x, o.y - s.y);
				if (d > s.r || Math.abs(o.z - s.z) > 128) continue;
				this.damageZombie(z, s.damage * (1 - 0.5 * (d / s.r)), { pad: s.pad });
			}
		}
		this.shells = keep;
	}

	private recordHistory(): void {
		const poses = new Map<number, HitboxPose>();
		for (const z of this.zombies.values()) poses.set(z.id, { x: z.body.origin.x, y: z.body.origin.y, z: z.body.origin.z, yaw: z.yaw });
		this.history.push({ tick: this.tick, poses });
		while (this.history.length > HISTORY_TICKS) this.history.shift();
	}

	// ---------------------------------------------------------------------
	// Views

	/** Tearing planks off (or the boss winding up its smash), not waiting for its turn. */
	isTearing(z: DefenseZombie): boolean {
		if (z.state !== 'tear') return false;
		return z.kind === 'boss' || this.openings[z.opening]?.tearer === z.id;
	}

	zombieFlags(z: DefenseZombie): number {
		return (
			(z.windupUntil > 0 ? ZDF_ATTACKING : 0) |
			(this.simTime - z.hitAt < ZD_HIT_FLASH_MS ? ZDF_HIT : 0) |
			(this.simTime < z.slowUntil ? ZDF_SLOWED : 0) |
			(z.body.onGround ? ZDF_ON_GROUND : 0) |
			(this.isTearing(z) ? ZDF_TEARING : 0) |
			(z.frost < 1 ? ZDF_FROSTED : 0) |
			(z.state === 'inside' ? ZDF_INSIDE : 0)
		);
	}

	/** The BIN_DEFENSE payload: every zombie and every built turret. */
	snapshot(): { tick: number; zombies: ZdZombieNet[]; turrets: ZdTurretNet[] } {
		const zombies: ZdZombieNet[] = [];
		for (const z of this.zombies.values()) {
			const o = z.body.origin;
			zombies.push({ id: z.id, x: o.x, y: o.y, z: o.z, yaw: z.yaw, flags: this.zombieFlags(z), hp: Math.max(0, z.hp) / z.maxHp, kind: z.kind });
		}
		const turrets: ZdTurretNet[] = [];
		for (const [i, pad] of this.pads.entries()) {
			if (!pad.type) continue;
			turrets.push({
				pad: i,
				yaw: pad.yaw,
				pitch: pad.pitch,
				flags: (this.tick - pad.firedTick < ZD_FIRE_FLAG_TICKS ? ZDT_FIRED : 0) | (pad.target !== null ? ZDT_ACTIVE : 0),
				target: pad.target ?? 0
			});
		}
		return { tick: this.tick, zombies, turrets };
	}

	view(now: number): ZdStateView {
		const players: ZdPlayerView[] = [];
		for (const p of this.players.values()) players.push(this.playerView(p.id)!);
		players.sort((a, b) => b.kills - a.kills || a.id - b.id);
		let boss: number | null = null;
		for (const z of this.zombies.values()) if (z.kind === 'boss') boss = Math.max(0, z.hp) / z.maxHp;
		const timeLeft = this.phase === 'build' || this.phase === 'ended' ? Math.max(0, (this.endsAt - now) / 1000) : 0;
		return {
			phase: this.phase,
			round: this.round,
			wave: this.phase === 'build' ? this.wave + 1 : this.wave,
			timeLeft: Math.round(timeLeft * 10) / 10,
			elapsed: this.phase === 'wave' ? Math.round((now - this.waveStartedAt) / 100) / 10 : 0,
			toSpawn: this.queue.length,
			alive: this.zombies.size,
			left: this.queue.length + (this.phase === 'wave' ? this.zombies.size : 0),
			kills: this.kills,
			boss,
			openings: this.openings.map((o) => ({ planks: o.planks, max: o.max, reinforce: o.reinforce })),
			pads: this.pads.map((p) => ({ type: p.type, level: p.level, owner: p.owner })),
			players
		};
	}

	/** Zombies of the current wave in total (spawned or not), for tests and HUD. */
	get waveSize(): number {
		return this.waveCount;
	}

	/** Players who were in the game when the current wave started. */
	get waveParticipants(): readonly number[] {
		return this.waveIds;
	}

	/** Living players count (tests). */
	livingCount(): number {
		return this.living().length;
	}
}
