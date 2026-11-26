/**
 * Hide and seek rules (docs/modes.md#hide-and-seek). Pure and clock-injected:
 * the server runs one `HnsGame` per hns map, feeds it the latest player
 * positions (with their arrival time, for knife lag compensation) at
 * MODE_TICK_HZ and resolves knife swings; tests drive it with a fake clock.
 *
 * Round flow: waiting (< 2 players, free roam) → starting (5 s) → hiding
 * (45 s: seekers frozen and blindfolded at their spawn, hiders spread out) →
 * seeking (4:00: seekers hunt with knives; a knifed hider becomes a seeker) →
 * ended (8 s summary) → hiding (next round, seekers re-picked) ...
 * Seekers win when no hiders are left; hiders win when the seeking time runs
 * out with at least one hider alive.
 */
import { HNS_PAY, POINTS_SCALE } from '../economy.ts';
import type { HnsCashBag, MapDef, Spawn } from '../maps/types.ts';
import { DUCK_HULL_MAX, HULL_MAX } from '../movement/api.ts';
import type { Vec3 } from '../types.ts';
import { tagSpawns } from './tag.ts';

export const HNS_MIN_PLAYERS = 2;
/** Free-roam countdown once enough players are in (before the first round). */
export const HNS_START_SECS = 5;
/** Hiding phase: seekers frozen and blindfolded (CS:GO HNS servers: 15-60 s; we use 30). */
export const HNS_HIDE_SECS = 30;
/** Seeking phase length. */
export const HNS_SEEK_SECS = 240;
/** Round summary before the next round. */
export const HNS_END_SECS = 8;
/** From this many players, two seekers start each round. */
export const HNS_TWO_SEEKER_PLAYERS = 8;
/** A found hider respawns at a seeker spawn, frozen for this long. */
export const HNS_FOUND_FREEZE_SECS = 3;
/** Chat/HUD warnings at these seconds left in the seeking phase. */
export const HNS_WARN_SECS: readonly number[] = [60, 30, 10];
/** Seeker knife: reach from the eye to the target's hull surface, aim cone half-angle, swing interval. */
export const HNS_KNIFE = Object.freeze({ reach: 64, coneDeg: 30, swingMs: 500 });
/** Server-side swing interval tolerance against jitter. */
export const HNS_SWING_TOLERANCE = 0.75;
/** State packets above this horizontal speed (u/s) are not from normal play. */
export const HNS_SPEED_LIMIT = 600;
/** Position history kept per player for knife lag compensation. */
export const HNS_HISTORY_MS = 500;
/** Largest rewind applied to a knife swing. */
export const HNS_MAX_REWIND_MS = 400;
/** Swing origin must be this close to the seeker's last known eye. */
export const HNS_ORIGIN_SLACK = 80;
/** A frozen seeker this far from their freeze point is teleported back. */
export const HNS_FREEZE_SLACK = 48;
/** Share of the seeking phase that has passed when the cash bag appears. */
export const HNS_BAG_AT = 0.5;
/**
 * Cash bag touch: horizontal distance from the player's feet origin (hull 16 +
 * bag 18 + a little for packet spacing), and how far above and below the bag's
 * floor point the feet may be (a jump over it counts).
 */
export const HNS_BAG_TOUCH = Object.freeze({ radius: 44, up: 48, down: 24 });
/** Between two state packets a player cannot run further than this; longer steps are not swept for a touch. */
export const HNS_BAG_SWEEP = 128;
/** Player hull radius for knife hits (hull is 32 wide). */
export const HNS_HULL_RADIUS = 16;
/** Name tags of other players are only drawn this close (and in line of sight). */
export const HNS_NAMETAG_RANGE = 600;

export type HnsPhase = 'waiting' | 'starting' | 'hiding' | 'seeking' | 'ended';
export type HnsRole = 'hider' | 'seeker';
export type HnsWinner = 'hiders' | 'seekers';

/** Feet origin (Source convention) and duck state of a player. */
export interface HnsPos {
	x: number;
	y: number;
	z: number;
	ducked: boolean;
}

export interface HnsPlayerView {
	id: number;
	role: HnsRole;
	/** Hiders knifed this round. */
	finds: number;
	/** Seconds survived as a hider during this round's seeking phase. */
	survived: number;
	/** Seconds this player stays frozen (hiding-phase seeker, or just found). */
	frozen: number;
}

/** The cash bag of the running round: still to come, waiting to be taken, or taken. */
export type HnsBagView =
	| { phase: 'pending'; secs: number }
	| { phase: 'out'; pos: Vec3; place: string }
	| { phase: 'taken'; by: number; coins: number };

/** Round state for the HUD and scoreboard (`modeState { mode: 'hns' }`). */
export interface HnsStateView {
	phase: HnsPhase;
	round: number;
	/** Seconds left in the current phase (0 while waiting). */
	timeLeft: number;
	seekers: number[];
	hiders: number[];
	/** Last round's winner (shown while ended). */
	winner: HnsWinner | null;
	players: HnsPlayerView[];
	/** Cash bag; absent or null when this round has none (or the server is older). */
	bag?: HnsBagView | null;
}

export type HnsEvent =
	/** Dropped below 2 players (cancelled = a round was running). */
	| { e: 'waiting'; cancelled: boolean }
	| { e: 'starting'; secs: number }
	| { e: 'roundStart'; round: number; seekers: number[]; hideSecs: number }
	/** Seekers released. */
	| { e: 'release'; seekSecs: number }
	/** Teleport `id` (to that player only): round start, found, late join, freeze breach. */
	| { e: 'spawn'; id: number; role: HnsRole; pos: Vec3; yaw: number; freezeSecs: number }
	/** A seeker swung (others draw/hear it). */
	| { e: 'swing'; by: number }
	| { e: 'found'; by: number; target: number; hidersLeft: number }
	/** Every seeker left: a hider was made seeker. */
	| { e: 'newSeeker'; id: number }
	| { e: 'lastHider'; id: number }
	| { e: 'warn'; secs: number }
	/** The cash bag appeared. */
	| { e: 'bag'; pos: Vec3; place: string }
	/** A hider took it: `coins` it held (whole points, before the multiplier), `paid` credited (tenths; 0 for guests). */
	| { e: 'bagTaken'; by: number; coins: number; paid: number }
	| { e: 'end'; round: number; winner: HnsWinner; survivors: number[]; topSeeker: { id: number; finds: number } | null };

/** Does a player at `p` touch the bag at `bag`? `from`: their previous position, for the way between two packets. */
export function touchesBag(p: Vec3, bag: Vec3, from?: Vec3 | null): boolean {
	const t = HNS_BAG_TOUCH;
	const near = (q: Vec3) => Math.hypot(q.x - bag.x, q.y - bag.y) <= t.radius && q.z >= bag.z - t.down && q.z <= bag.z + t.up;
	if (near(p)) return true;
	if (!from) return false;
	const dx = p.x - from.x;
	const dy = p.y - from.y;
	const dz = p.z - from.z;
	const len2 = dx * dx + dy * dy;
	if (len2 === 0 || len2 + dz * dz > HNS_BAG_SWEEP * HNS_BAG_SWEEP) return false;
	const f = Math.max(0, Math.min(1, ((bag.x - from.x) * dx + (bag.y - from.y) * dy) / len2));
	return near({ x: from.x + dx * f, y: from.y + dy * f, z: from.z + dz * f });
}

/** How many players seek at round start. */
export function seekerCount(players: number): number {
	return players >= HNS_TWO_SEEKER_PLAYERS ? 2 : 1;
}

/** Hider and seeker spawns of a map (falls back to `spawns` / `spawn` without `hns`). */
export function hnsSpawns(map: Pick<MapDef, 'spawn' | 'spawns' | 'hns'>): { hiders: Spawn[]; seekers: Spawn[] } {
	const hiders = map.hns?.hiderSpawns.length ? map.hns.hiderSpawns : tagSpawns(map);
	const seekers = map.hns?.seekerSpawns.length ? map.hns.seekerSpawns : [map.spawn];
	return { hiders, seekers };
}

/** Eye height for a pose. */
export function hnsEye(p: HnsPos): number {
	return p.z + (p.ducked ? 46 : 64);
}

/**
 * Knife check against a player hull (vertical cylinder, radius 16, 72 tall /
 * 54 ducked): the nearest point of the hull axis to the eye is within
 * `reach` (to the hull surface) and inside the aim cone (wider up close).
 * Returns the distance to the hull surface, or null.
 */
export function knifeHit(eye: Vec3, dir: Vec3, t: HnsPos, reach = HNS_KNIFE.reach, coneDeg = HNS_KNIFE.coneDeg): number | null {
	const top = t.z + (t.ducked ? DUCK_HULL_MAX.z : HULL_MAX.z);
	const zc = Math.max(t.z, Math.min(top, eye.z));
	const vx = t.x - eye.x;
	const vy = t.y - eye.y;
	const vz = zc - eye.z;
	const dist = Math.hypot(vx, vy, vz);
	const surface = Math.max(0, dist - HNS_HULL_RADIUS);
	if (surface > reach) return null;
	if (dist > 1e-6) {
		const cos = (vx * dir.x + vy * dir.y + vz * dir.z) / dist;
		const limit = Math.cos(((dist < HNS_HULL_RADIUS * 2.5 ? coneDeg * 1.6 : coneDeg) * Math.PI) / 180);
		if (cos < limit) return null;
	}
	return surface;
}

/**
 * Hide and seek horizontal speed check for state packets. Each jump trims the
 * speed to 286 u/s and strafing adds at most about 60 in the air; long falls and
 * slopes can add more, so the limit is well above anything normal play reaches.
 */
export function overSpeedCap(vx: number, vy: number, limit = HNS_SPEED_LIMIT): boolean {
	return vx * vx + vy * vy > limit * limit;
}

export interface HnsGameOptions {
	now: number; // ms
	map: Pick<MapDef, 'spawn' | 'spawns' | 'hns'>;
	rng?: () => number;
	startSecs?: number;
	hideSecs?: number;
	seekSecs?: number;
	endSecs?: number;
	foundFreezeSecs?: number;
	minPlayers?: number;
	/** Line of sight between two points (server: a world trace); default: always clear. */
	los?: (a: Vec3, b: Vec3) => boolean;
	/** Are there enough players for the cash bag right now (asked when it would appear)? Default: always. */
	bagAllowed?: () => boolean;
}

export interface HnsSwing {
	origin: Vec3;
	dir: Vec3;
}

export type HnsSwingResult = { ok: true; hit: number | null; events: HnsEvent[] } | { ok: false; reason: string; events: HnsEvent[] };

interface Sample extends HnsPos {
	t: number;
}

interface HnsPlayer {
	role: HnsRole;
	finds: number;
	survivedMs: number;
	frozenUntil: number;
	/** Where a frozen player must stay (their spawn). */
	freezeAt: Spawn | null;
	lastSwing: number;
	/** Last round this player started as a seeker (-1 = never). */
	lastSeekRound: number;
	history: Sample[];
	/** Last freeze-breach teleport (rate limit). */
	lastPull: number;
}

export class HnsGame {
	phase: HnsPhase = 'waiting';
	round = 0;
	/** ms: end of the current phase, 0 while waiting. */
	endsAt = 0;
	winner: HnsWinner | null = null;
	private readonly players = new Map<number, HnsPlayer>();
	private readonly rng: () => number;
	private readonly startMs: number;
	private readonly hideMs: number;
	private readonly seekMs: number;
	private readonly endMs: number;
	private readonly foundMs: number;
	private readonly minPlayers: number;
	private readonly spawns: { hiders: Spawn[]; seekers: Spawn[] };
	private readonly los: (a: Vec3, b: Vec3) => boolean;
	private readonly bagSpot: HnsCashBag | null;
	private readonly bagAllowed: () => boolean;
	private bag: { phase: 'none' | 'pending' } | { phase: 'out'; coins: number } | { phase: 'taken'; by: number; coins: number } = { phase: 'none' };
	private last: number;
	private warned = new Set<number>();
	private pending: HnsEvent[] = [];

	constructor(opts: HnsGameOptions) {
		this.rng = opts.rng ?? Math.random;
		this.startMs = (opts.startSecs ?? HNS_START_SECS) * 1000;
		this.hideMs = (opts.hideSecs ?? HNS_HIDE_SECS) * 1000;
		this.seekMs = (opts.seekSecs ?? HNS_SEEK_SECS) * 1000;
		this.endMs = (opts.endSecs ?? HNS_END_SECS) * 1000;
		this.foundMs = (opts.foundFreezeSecs ?? HNS_FOUND_FREEZE_SECS) * 1000;
		this.minPlayers = opts.minPlayers ?? HNS_MIN_PLAYERS;
		this.spawns = hnsSpawns(opts.map);
		this.los = opts.los ?? (() => true);
		this.bagSpot = opts.map.hns?.cashBag ?? null;
		this.bagAllowed = opts.bagAllowed ?? (() => true);
		this.last = opts.now;
	}

	has(id: number): boolean {
		return this.players.has(id);
	}

	role(id: number): HnsRole | null {
		return this.players.get(id)?.role ?? null;
	}

	/** Ids with `role`, ascending. */
	ids(role: HnsRole): number[] {
		const out: number[] = [];
		for (const [id, p] of this.players) if (p.role === role) out.push(id);
		return out.sort((a, b) => a - b);
	}

	get seekers(): number[] {
		return this.ids('seeker');
	}

	get hiders(): number[] {
		return this.ids('hider');
	}

	/** A round is running (hiding or seeking). */
	get inRound(): boolean {
		return this.phase === 'hiding' || this.phase === 'seeking';
	}

	isFrozen(id: number, now: number): boolean {
		const p = this.players.get(id);
		return !!p && p.frozenUntil > now;
	}

	finds(id: number): number {
		return this.players.get(id)?.finds ?? 0;
	}

	survived(id: number): number {
		return Math.round(this.players.get(id)?.survivedMs ?? 0) / 1000;
	}

	timeLeft(now: number): number {
		return this.phase === 'waiting' ? 0 : Math.max(0, (this.endsAt - now) / 1000);
	}

	view(now: number): HnsStateView {
		const players: HnsPlayerView[] = [];
		for (const [id, p] of this.players) {
			players.push({
				id,
				role: p.role,
				finds: p.finds,
				survived: Math.round(p.survivedMs / 100) / 10,
				frozen: Math.max(0, Math.round((p.frozenUntil - now) / 100) / 10)
			});
		}
		players.sort((a, b) => a.id - b.id);
		return {
			phase: this.phase,
			round: this.round,
			timeLeft: Math.round(this.timeLeft(now) * 10) / 10,
			seekers: this.seekers,
			hiders: this.hiders,
			winner: this.phase === 'ended' ? this.winner : null,
			players,
			bag: this.bagView(now)
		};
	}

	/** Whole coins in the bag that is waiting to be taken, or null. */
	get bagCoins(): number | null {
		return this.bag.phase === 'out' ? this.bag.coins : null;
	}

	/** ms: when the cash bag appears in this seeking phase. */
	private get bagDue(): number {
		return this.endsAt - this.seekMs * (1 - HNS_BAG_AT);
	}

	private bagView(now: number): HnsBagView | null {
		const b = this.bag;
		const spot = this.bagSpot;
		if (!spot || this.phase !== 'seeking') return null;
		if (b.phase === 'out') return { phase: 'out', pos: { ...spot.pos }, place: spot.place };
		if (b.phase === 'taken') return { phase: 'taken', by: b.by, coins: b.coins };
		if (b.phase === 'none' || !this.bagAllowed()) return null;
		return { phase: 'pending', secs: Math.round(Math.max(0, this.bagDue - now) / 100) / 10 };
	}

	/**
	 * Is this living hider touching the bag? `swept`: also count the way from
	 * their previous position (call it once per state packet).
	 */
	reachesBag(id: number, swept = false): boolean {
		const p = this.players.get(id);
		if (!this.bagSpot || this.bag.phase !== 'out' || this.phase !== 'seeking' || p?.role !== 'hider') return false;
		const h = p.history;
		const pos = h[h.length - 1];
		return !!pos && touchesBag(pos, this.bagSpot.pos, swept ? h[h.length - 2] : null);
	}

	/** Distance of a player's latest position from the bag's spot (Infinity when unknown). */
	bagDistance(id: number): number {
		const pos = this.pos(id);
		const b = this.bagSpot?.pos;
		return pos && b ? Math.hypot(pos.x - b.x, pos.y - b.y, pos.z - b.z) : Infinity;
	}

	/** The hider takes the bag; `paid`: tenths credited for it. */
	takeBag(id: number, paid: number): HnsEvent[] {
		if (this.bag.phase !== 'out' || this.role(id) !== 'hider') return [];
		const coins = this.bag.coins;
		this.bag = { phase: 'taken', by: id, coins };
		this.emit({ e: 'bagTaken', by: id, coins, paid });
		return this.flush();
	}

	/** Record a player's position as it arrived (`now`), for lag compensation. */
	setPos(id: number, pos: HnsPos, now: number, teleported = false): void {
		const p = this.players.get(id);
		if (!p) return;
		const h = p.history;
		if (teleported) h.length = 0;
		h.push({ t: now, x: pos.x, y: pos.y, z: pos.z, ducked: pos.ducked });
		while (h.length > 2 && h[1]!.t < now - HNS_HISTORY_MS) h.shift();
	}

	/** Latest known position (null before the first state). */
	pos(id: number): HnsPos | null {
		const h = this.players.get(id)?.history;
		return h && h.length > 0 ? h[h.length - 1]! : null;
	}

	/** Position at time `t` (linear between history samples; clamped to the history). */
	posAt(id: number, t: number): HnsPos | null {
		const h = this.players.get(id)?.history;
		if (!h || h.length === 0) return null;
		if (t <= h[0]!.t) return h[0]!;
		for (let i = 1; i < h.length; i++) {
			const b = h[i]!;
			if (b.t < t) continue;
			const a = h[i - 1]!;
			const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
			return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, ducked: f < 0.5 ? a.ducked : b.ducked };
		}
		return h[h.length - 1]!;
	}

	/**
	 * Advance to `now`. `active` holds every non-spectating player in the map
	 * (positions come from setPos).
	 */
	update(now: number, active: Iterable<number>): HnsEvent[] {
		const ids = new Set(active);
		this.accrue(now);
		this.syncPlayers(ids, now);

		if (ids.size < this.minPlayers) {
			if (this.phase !== 'waiting') {
				const cancelled = this.inRound;
				this.phase = 'waiting';
				this.endsAt = 0;
				this.winner = null;
				this.bag = { phase: 'none' };
				for (const p of this.players.values()) this.resetRole(p);
				this.emit({ e: 'waiting', cancelled });
			}
			return this.flush();
		}

		if (this.phase === 'waiting') {
			this.phase = 'starting';
			this.endsAt = now + this.startMs;
			this.emit({ e: 'starting', secs: this.startMs / 1000 });
		}
		if ((this.phase === 'starting' || this.phase === 'ended') && now >= this.endsAt) this.startRound(now);
		if (this.phase === 'hiding' && now >= this.endsAt) {
			this.phase = 'seeking';
			this.endsAt = now + this.seekMs;
			this.warned.clear();
			this.bag = { phase: this.bagSpot ? 'pending' : 'none' };
			for (const p of this.players.values()) {
				if (p.role === 'seeker' && p.frozenUntil <= now + this.foundMs) {
					p.frozenUntil = 0;
					p.freezeAt = null;
				}
			}
			this.emit({ e: 'release', seekSecs: this.seekMs / 1000 });
		}
		if (this.phase === 'seeking') {
			if (this.hiders.length === 0) this.endRound(now, 'seekers');
			else if (now >= this.endsAt) this.endRound(now, 'hiders');
			else {
				if (this.bag.phase === 'pending' && now >= this.bagDue) this.spawnBag();
				const left = (this.endsAt - now) / 1000;
				for (const w of HNS_WARN_SECS) {
					if (left <= w && !this.warned.has(w) && this.seekMs / 1000 > w) {
						this.warned.add(w);
						if (left > w - 1) this.emit({ e: 'warn', secs: w });
					}
				}
			}
		}
		if (this.inRound) this.enforceFreeze(now);
		return this.flush();
	}

	/** Resolve a seeker's knife swing. `rewindMs`: how far in the past the seeker saw the others. */
	swing(id: number, s: HnsSwing, now: number, rewindMs = 0): HnsSwingResult {
		const p = this.players.get(id);
		const reject = (reason: string): HnsSwingResult => ({ ok: false, reason, events: [] });
		if (!p) return reject('not playing');
		if (p.role !== 'seeker') return reject('not a seeker');
		if (this.phase !== 'seeking') return reject('not seeking');
		if (p.frozenUntil > now) return reject('frozen');
		const o = s?.origin;
		const d = s?.dir;
		if (!o || !d || ![o.x, o.y, o.z, d.x, d.y, d.z].every(Number.isFinite)) return reject('bad swing');
		const len = Math.hypot(d.x, d.y, d.z);
		if (len < 0.9 || len > 1.1) return reject('bad direction');
		const me = this.pos(id);
		if (me && Math.hypot(o.x - me.x, o.y - me.y, o.z - hnsEye(me)) > HNS_ORIGIN_SLACK) return reject('bad origin');
		if (now - p.lastSwing < HNS_KNIFE.swingMs * HNS_SWING_TOLERANCE) return reject('too fast');
		p.lastSwing = now;
		const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
		this.emit({ e: 'swing', by: id });

		const rewind = Math.max(0, Math.min(HNS_MAX_REWIND_MS, Number.isFinite(rewindMs) ? rewindMs : 0));
		let best: number | null = null;
		let bestD = Infinity;
		for (const [tid, t] of this.players) {
			if (t.role !== 'hider' || tid === id) continue;
			// The pose the seeker saw (rewound), or the latest one: either counts.
			for (const pose of [this.posAt(tid, now - rewind), this.pos(tid)]) {
				if (!pose) continue;
				const dist = knifeHit(o, dir, pose);
				if (dist === null || dist >= bestD) continue;
				if (!this.los(o, { x: pose.x, y: pose.y, z: pose.z + (pose.ducked ? 27 : 36) })) continue;
				best = tid;
				bestD = dist;
			}
		}
		if (best !== null) this.found(id, best, now);
		return { ok: true, hit: best, events: this.flush() };
	}

	// ---------------------------------------------------------------------

	private emit(e: HnsEvent): void {
		this.pending.push(e);
	}

	private flush(): HnsEvent[] {
		const out = this.pending;
		this.pending = [];
		return out;
	}

	private resetRole(p: HnsPlayer): void {
		p.role = 'hider';
		p.frozenUntil = 0;
		p.freezeAt = null;
	}

	/** Hiders earn survived time during the seeking phase. */
	private accrue(now: number): void {
		const from = this.last;
		this.last = Math.max(this.last, now);
		if (this.phase !== 'seeking') return;
		const dt = Math.min(now, this.endsAt) - from;
		if (dt <= 0) return;
		for (const p of this.players.values()) if (p.role === 'hider') p.survivedMs += dt;
	}

	private newPlayer(): HnsPlayer {
		return { role: 'hider', finds: 0, survivedMs: 0, frozenUntil: 0, freezeAt: null, lastSwing: -Infinity, lastSeekRound: -1, history: [], lastPull: -Infinity };
	}

	private syncPlayers(active: Set<number>, now: number): void {
		let lostSeekers = false;
		for (const [id, p] of this.players) {
			if (active.has(id)) continue;
			if (p.role === 'seeker') lostSeekers = true;
			this.players.delete(id);
		}
		for (const id of active) {
			if (this.players.has(id)) continue;
			const p = this.newPlayer();
			this.players.set(id, p);
			// Late joiners during a round seek (frozen with the others while hiding).
			if (this.inRound) this.makeSeeker(id, p, this.phase === 'hiding' ? this.endsAt : 0, now);
		}
		if (!this.inRound || active.size < this.minPlayers) return;
		const hiders = this.hiders;
		if (lostSeekers && this.seekers.length === 0 && hiders.length > 0) {
			const id = this.pick(hiders);
			this.makeSeeker(id, this.players.get(id)!, this.phase === 'hiding' ? this.endsAt : now + this.foundMs, now);
			this.emit({ e: 'newSeeker', id });
		}
		if (this.phase === 'seeking') this.checkHiders(now);
	}

	/** Seekers win at zero hiders; one hider left is announced. */
	private checkHiders(now: number): void {
		const hiders = this.hiders;
		if (hiders.length === 0) this.endRound(now, 'seekers');
	}

	/** Make `id` a seeker at a seeker spawn, frozen until `frozenUntil` (0 = not frozen). */
	private makeSeeker(id: number, p: HnsPlayer, frozenUntil: number, now: number): void {
		p.role = 'seeker';
		const s = this.spawnFor(this.spawns.seekers);
		this.setPos(id, { ...s.pos, ducked: false }, now, true);
		p.frozenUntil = frozenUntil;
		p.freezeAt = frozenUntil > now ? { pos: { ...s.pos }, yaw: s.yaw } : null;
		this.emit({ e: 'spawn', id, role: 'seeker', pos: { ...s.pos }, yaw: s.yaw, freezeSecs: Math.max(0, (frozenUntil - now) / 1000) });
	}

	private spawnFor(list: Spawn[]): Spawn {
		return list[Math.min(list.length - 1, Math.floor(this.rng() * list.length))]!;
	}

	private startRound(now: number): void {
		this.phase = 'hiding';
		this.round++;
		this.endsAt = now + this.hideMs;
		this.winner = null;
		this.warned.clear();
		this.bag = { phase: 'none' };
		const ids = [...this.players.keys()];
		for (const p of this.players.values()) {
			this.resetRole(p);
			p.finds = 0;
			p.survivedMs = 0;
			p.lastSwing = -Infinity;
		}
		// Seekers: prefer players who have not sought for the longest (never first), random among ties.
		const n = Math.min(seekerCount(ids.length), ids.length - 1);
		const seekers: number[] = [];
		const pool = [...ids];
		for (let i = 0; i < n; i++) {
			const oldest = Math.min(...pool.map((id) => this.players.get(id)!.lastSeekRound));
			const id = this.pick(pool.filter((x) => this.players.get(x)!.lastSeekRound === oldest));
			pool.splice(pool.indexOf(id), 1);
			seekers.push(id);
		}
		seekers.sort((a, b) => a - b);
		this.emit({ e: 'roundStart', round: this.round, seekers, hideSecs: this.hideMs / 1000 });
		const hiderSpawns = this.shuffled(this.spawns.hiders);
		let k = 0;
		for (const id of ids.sort((a, b) => a - b)) {
			const p = this.players.get(id)!;
			if (seekers.includes(id)) {
				p.lastSeekRound = this.round;
				this.makeSeeker(id, p, this.endsAt, now);
			} else {
				const s = hiderSpawns[k++ % hiderSpawns.length]!;
				this.setPos(id, { ...s.pos, ducked: false }, now, true);
				this.emit({ e: 'spawn', id, role: 'hider', pos: { ...s.pos }, yaw: s.yaw, freezeSecs: 0 });
			}
		}
	}

	/** Halfway through the seeking phase: once per round, only with enough players at that moment. */
	private spawnBag(): void {
		if (!this.bagSpot || !this.bagAllowed()) {
			this.bag = { phase: 'none' };
			return;
		}
		const min = HNS_PAY.bagMin / POINTS_SCALE;
		const max = HNS_PAY.bagMax / POINTS_SCALE;
		this.bag = { phase: 'out', coins: min + Math.min(max - min, Math.floor(this.rng() * (max - min + 1))) };
		this.emit({ e: 'bag', pos: { ...this.bagSpot.pos }, place: this.bagSpot.place });
	}

	private endRound(now: number, winner: HnsWinner): void {
		this.phase = 'ended';
		this.endsAt = now + this.endMs;
		this.winner = winner;
		let top: { id: number; finds: number } | null = null;
		for (const [id, p] of this.players) {
			p.frozenUntil = 0;
			p.freezeAt = null;
			if (p.finds > 0 && (!top || p.finds > top.finds || (p.finds === top.finds && id < top.id))) top = { id, finds: p.finds };
		}
		this.emit({ e: 'end', round: this.round, winner, survivors: this.hiders, topSeeker: top });
	}

	private found(by: number, target: number, now: number): void {
		const s = this.players.get(by)!;
		const t = this.players.get(target)!;
		s.finds++;
		this.makeSeeker(target, t, now + this.foundMs, now);
		const left = this.hiders;
		this.emit({ e: 'found', by, target, hidersLeft: left.length });
		if (left.length === 1) this.emit({ e: 'lastHider', id: left[0]! });
		this.checkHiders(now);
	}

	/** Frozen players who left their freeze point are put back (server-side freeze). */
	private enforceFreeze(now: number): void {
		for (const [id, p] of this.players) {
			if (p.frozenUntil <= now || !p.freezeAt) continue;
			const pos = this.pos(id);
			if (!pos || now - p.lastPull < 500) continue;
			const f = p.freezeAt.pos;
			if (Math.hypot(pos.x - f.x, pos.y - f.y, pos.z - f.z) <= HNS_FREEZE_SLACK) continue;
			p.lastPull = now;
			this.setPos(id, { ...f, ducked: false }, now, true);
			this.emit({ e: 'spawn', id, role: p.role, pos: { ...f }, yaw: p.freezeAt.yaw, freezeSecs: (p.frozenUntil - now) / 1000 });
		}
	}

	private shuffled<T>(list: readonly T[]): T[] {
		const a = [...list];
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.min(i, Math.floor(this.rng() * (i + 1)));
			[a[i], a[j]] = [a[j]!, a[i]!];
		}
		return a;
	}

	/** Remove and return a random element. */
	private pick(ids: number[]): number {
		const i = Math.min(ids.length - 1, Math.floor(this.rng() * ids.length));
		return ids.splice(i, 1)[0]!;
	}
}
