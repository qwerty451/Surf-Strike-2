/**
 * Tournament rules (docs/modes.md#tournament), pure and clock-injected: the
 * phases, the bracket, duel rounds, HP, the three duel weapons with
 * lag-compensated hits, the knife fights on the spectator deck and the bet
 * book. The server runs it on the latest state packets and pays what it
 * reports (kills, the champion, bet settlements); the client only displays it.
 *
 * Who can hurt whom is decided here and nowhere else:
 * - the two duelists of the live round hurt only each other, with sniper,
 *   pistol and knife (TRN_DAMAGE);
 * - everyone else is a spectator on the deck, carries only the knife and hurts
 *   only other spectators (TRN_DECK_KNIFE_HITS hits drop one, instant respawn);
 * - bullets never hit spectators, spectators never hit duelists.
 */
import { copyMotion, PlayerBody, restMotion } from '../../body-motion.ts';
import type { BodyInput } from '../../body-pose.ts';
import type { CollisionWorld } from '../../collision/api.ts';
import type { Spawn, TournamentMapInfo } from '../../maps/types.ts';
import { DUCK_VIEW_HEIGHT, VIEW_HEIGHT } from '../../movement/api.ts';
import { pts } from '../../economy.ts';
import type { Vec3 } from '../../types.ts';
import { clampInfVelocity, INF_MELEE_LOS_HEIGHT, INF_ORIGIN_SLACK, INF_STEP_MS } from '../infected/game.ts';
import { INF_HISTORY_MS, PoseHistory } from '../infected/lagcomp.ts';
import { ZM_FIRE_TOLERANCE, ZM_RELOAD_TOLERANCE } from '../zombies/game.ts';
import { meleePlayer, playerUp, rayPlayerPart, type PlayerPart, type PlayerPose } from '../zombies/hitbox.ts';
import { WEAPONS, WeaponState, type WeaponId } from '../zombies/weapons.ts';
import {
	bracketChampion,
	bracketRounds,
	bracketView,
	createBracket,
	decide,
	entrantOf,
	nextMatch,
	pendingMatchOf,
	resolveBracket,
	type TrnBracket
} from './bracket.ts';
import { isTrnWeapon, TRN_HP, trnDamage, type TrnWeapon } from './damage.ts';
import {
	TRN_BET,
	TRN_BET_MIN_ENTRANTS,
	TRN_DECK_KNIFE_HITS,
	TRN_NEXT_SECS,
	TRN_ROUND_SECS,
	TRN_ROUND_WINS,
	trnPrize,
	type TrnBetsView,
	type TrnDuelView,
	type TrnEvent,
	type TrnPhase,
	type TrnRole,
	type TrnStateView
} from './net.ts';

/** Players needed for a tournament. */
export const TRN_MIN_PLAYERS = 2;
/** Countdown before the first tournament once enough players are in (s). */
export const TRN_START_SECS = 5;
/** The tree is shown this long between two duels; bets are open (s). */
export const TRN_BRACKET_SECS = 6;
/** Both duelists are frozen at their spawns this long before a round goes live (s). */
export const TRN_FREEZE_SECS = 3;
/** Pause after a round is decided, before the next round or the bracket (s). */
export const TRN_ROUND_END_SECS = 3;
/** A frozen duelist further than this from their spawn is put back (units). */
export const TRN_FREEZE_SLACK = 48;
/** Spawns put a player back at most this often (ms). */
const PULL_MS = 500;
/** Positions right after a spawn may still be from before it (ms): no pull-backs then. */
const SPAWN_GRACE_MS = 500;
/** Deck HP shown per knife hit: 100, 66, 33, 0. */
const DECK_HIT_HP = Math.ceil(TRN_HP / TRN_DECK_KNIFE_HITS);
/** History samples: INF_HISTORY_MS of sim steps and a few more. */
const HISTORY_SAMPLES = Math.ceil(INF_HISTORY_MS / INF_STEP_MS) + 3;
const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

/** What the server knows of a connected player. */
export interface TrnPlayerInfo {
	id: number;
	name: string;
	/** Logged-in account; null for a guest (no bets, no coins). */
	accountId: number | null;
}

export interface TrnPos {
	x: number;
	y: number;
	z: number;
	ducked: boolean;
	yaw?: number;
	pitch?: number;
	vx?: number;
	vy?: number;
	vz?: number;
	onGround?: boolean;
}

export interface TrnFire {
	weapon: WeaponId;
	origin: Vec3;
	dir: Vec3;
	/** How far back the shooter's screen is (ms, `infRewindMs(ping)`); clamped to the history. 0: the current poses. */
	rewindMs?: number;
}

/** An event and who gets it: everyone by default. */
export interface TrnOut {
	ev: TrnEvent;
	/** Only these players. */
	to?: number[];
	/** Everyone but this player. */
	except?: number;
}

export interface TrnActionResult {
	ok: boolean;
	reason?: string;
	out: TrnOut[];
}

export type TrnBetRefusal = 'closed' | 'small' | 'guest' | 'duelist' | 'pick' | 'twice' | 'coins';

/** A bet to pay out or give back: `payout` in tenths (2× the stake on a win, the stake on a refund, 0 on a loss). */
export interface TrnSettlement {
	accountId: number;
	/** Opaque id the server gave the bet when it took the stake. */
	ticket: number;
	match: number;
	pick: number;
	outcome: 'won' | 'lost' | 'refund';
	stake: number;
	payout: number;
}

export interface TrnGameOptions {
	map: { tournament?: TournamentMapInfo; spawn: Spawn };
	/** Walls between shooter and target (null: no world, tests). */
	world: CollisionWorld | null;
	now: number;
	rng: () => number;
	minPlayers?: number;
	startSecs?: number;
	bracketSecs?: number;
	freezeSecs?: number;
	roundSecs?: number;
	roundEndSecs?: number;
	nextSecs?: number;
	/** Server: looser fire and reload waits for network jitter (ZM_FIRE_TOLERANCE). */
	lenient?: boolean;
}

interface TrnPlayer {
	id: number;
	name: string;
	accountId: number | null;
	pos: TrnPos | null;
	hist: PoseHistory;
	body: PlayerBody;
	guns: Record<TrnWeapon, WeaponState>;
	ws: WeaponState;
	/** Knife hits taken on the deck since the last respawn. */
	deckHits: number;
	/** Where the last spawn put the player, and when. */
	spawnPos: Vec3 | null;
	spawnAt: number;
	lastPull: number;
}

interface Duel {
	match: number;
	/** 1-based; a draw replays it under the same number. */
	round: number;
	hp: [number, number];
	/** freeze → live → post (round decided, pause). */
	sub: 'freeze' | 'live' | 'post';
	/** End of the freeze or the post pause (ms). */
	subEndsAt: number;
	/** End of the live round (ms). */
	roundEndsAt: number;
	/** Round 1 went live once: bets on this match are closed. */
	wentLive: boolean;
	/** The round in the post pause had a winner (the next one is a new round, not a replay). */
	decided: boolean;
}

interface Bet {
	accountId: number;
	ticket: number;
	pick: number;
	stake: number;
}

export class TournamentGame {
	phase: TrnPhase = 'waiting';
	/** Tournaments on this map so far. */
	tournament = 0;
	bracket: TrnBracket | null = null;
	duel: Duel | null = null;
	/** The match being played, or shown next in the bracket phase. */
	current: number | null = null;
	champion: number | null = null;
	/** End of the current phase (starting, bracket, ended), ms. */
	endsAt = 0;
	/** Sim steps so far (lag compensation history). */
	tick = 0;

	private readonly info: TournamentMapInfo;
	private readonly world: CollisionWorld | null;
	private readonly rng: () => number;
	private readonly players = new Map<number, TrnPlayer>();
	/** Accounts of the entrants, by player id (a bettor's other tab is a duelist too). */
	private readonly entrantAccounts = new Map<number, number | null>();
	/** Entrants who played at least one live duel round this tournament (the prize counts them). */
	private readonly playedLive = new Set<number>();
	private readonly bets = new Map<number, Map<number, Bet>>();
	private settlements: TrnSettlement[] = [];
	private pending: TrnOut[] = [];
	private simTime: number;
	private readonly scratch: PlayerPose = { x: 0, y: 0, z: 0, yaw: 0, ducked: false, hunched: false };
	private readonly bodyInput: BodyInput = { vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, ducked: false };
	private readonly minPlayers: number;
	private readonly startMs: number;
	private readonly bracketMs: number;
	private readonly freezeMs: number;
	private readonly roundMs: number;
	private readonly roundEndMs: number;
	private readonly nextMs: number;
	private readonly lenient: boolean;

	constructor(opts: TrnGameOptions) {
		this.info = opts.map.tournament ?? fallbackInfo(opts.map.spawn);
		this.world = opts.world;
		this.rng = opts.rng;
		this.simTime = opts.now;
		this.minPlayers = opts.minPlayers ?? TRN_MIN_PLAYERS;
		this.startMs = (opts.startSecs ?? TRN_START_SECS) * 1000;
		this.bracketMs = (opts.bracketSecs ?? TRN_BRACKET_SECS) * 1000;
		this.freezeMs = (opts.freezeSecs ?? TRN_FREEZE_SECS) * 1000;
		this.roundMs = (opts.roundSecs ?? TRN_ROUND_SECS) * 1000;
		this.roundEndMs = (opts.roundEndSecs ?? TRN_ROUND_END_SECS) * 1000;
		this.nextMs = (opts.nextSecs ?? TRN_NEXT_SECS) * 1000;
		this.lenient = opts.lenient ?? false;
	}

	// ---------------------------------------------------------------------
	// Players

	/**
	 * The players on the map (spectators of the lobby excluded). New ones are
	 * put on the deck; missing ones leave: a duelist forfeits the duel, an
	 * entrant waiting for a match gives the next opponent a walkover.
	 */
	syncPlayers(list: Iterable<TrnPlayerInfo>, now: number): TrnOut[] {
		const want = new Map<number, TrnPlayerInfo>();
		for (const p of list) want.set(p.id, p);
		for (const id of [...this.players.keys()]) if (!want.has(id)) this.remove(id, now);
		for (const [id, info] of want) {
			const p = this.players.get(id);
			if (p) {
				p.name = info.name;
				p.accountId = info.accountId;
				continue;
			}
			const np = this.newPlayer(info);
			this.players.set(id, np);
			this.spawnOnDeck(np, now);
		}
		return this.flush();
	}

	has(id: number): boolean {
		return this.players.has(id);
	}

	get playerCount(): number {
		return this.players.size;
	}

	setPos(id: number, pos: TrnPos, teleported = false): void {
		const p = this.players.get(id);
		if (!p || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
		// A teleport (spawn, map teleport) breaks the pose history: never rewind across it (as infected).
		if (teleported) {
			p.hist.clear();
			p.body.reset();
		}
		const num = (v: number | undefined, was: number | undefined) => (v === undefined ? undefined : Number.isFinite(v) ? v : (was ?? 0));
		const v = { vx: num(pos.vx, p.pos?.vx) ?? 0, vy: num(pos.vy, p.pos?.vy) ?? 0, vz: num(pos.vz, p.pos?.vz) ?? 0 };
		clampInfVelocity(v);
		p.pos = {
			x: pos.x,
			y: pos.y,
			z: pos.z,
			ducked: pos.ducked,
			yaw: num(pos.yaw, p.pos?.yaw),
			pitch: num(pos.pitch, p.pos?.pitch),
			...v,
			onGround: pos.onGround !== false
		};
	}

	private newPlayer(info: TrnPlayerInfo): TrnPlayer {
		const guns = {
			sniper: this.weaponState('sniper'),
			pistol: this.weaponState('pistol'),
			knife: this.weaponState('knife')
		};
		return {
			id: info.id,
			name: info.name,
			accountId: info.accountId,
			pos: null,
			hist: new PoseHistory(HISTORY_SAMPLES),
			body: new PlayerBody(),
			guns,
			ws: guns.knife,
			deckHits: 0,
			spawnPos: null,
			spawnAt: -Infinity,
			lastPull: -Infinity
		};
	}

	private weaponState(w: WeaponId): WeaponState {
		return this.lenient ? new WeaponState(w, ZM_FIRE_TOLERANCE, ZM_RELOAD_TOLERANCE) : new WeaponState(w);
	}

	private remove(id: number, now: number): void {
		this.players.delete(id);
		const b = this.bracket;
		if (!b || (this.phase !== 'bracket' && this.phase !== 'duel')) return;
		const e = entrantOf(b, id);
		if (!e) return;
		e.left = true;
		e.out = true;
		const d = this.duel;
		if (d && this.phase === 'duel') {
			const m = b.matches[d.match]!;
			if (m.a === id || m.b === id) {
				this.endDuel(now, m.a === id ? m.b : m.a, 'forfeit');
				return;
			}
		}
		this.resolve();
		// The match shown next was a walkover: show the one after it.
		if (this.phase === 'bracket' && this.current !== null && b.matches[this.current]!.done) this.goNext(now);
		else if (this.phase === 'duel') this.checkChampion(now);
	}

	/** Duelist of the live duel, or spectator. */
	roleOf(id: number): TrnRole {
		return this.isDuelist(id) ? 'duelist' : 'spectator';
	}

	isDuelist(id: number): boolean {
		const d = this.duel;
		if (!d || this.phase !== 'duel' || !this.bracket) return false;
		const m = this.bracket.matches[d.match]!;
		return m.a === id || m.b === id;
	}

	/** Frozen at a duel spawn (the round is not live yet). */
	isFrozen(id: number): boolean {
		return this.isDuelist(id) && this.duel!.sub === 'freeze';
	}

	/** In the current tournament's bracket. */
	isEntrant(id: number): boolean {
		return !!this.bracket && !!entrantOf(this.bracket, id);
	}

	/** Knocked out of the current tournament (lost, forfeited or left). */
	isOut(id: number): boolean {
		return !!this.bracket && !!entrantOf(this.bracket, id)?.out;
	}

	weaponOf(id: number): WeaponState | null {
		return this.players.get(id)?.ws ?? null;
	}

	hpOf(id: number): number | null {
		const d = this.duel;
		if (!d || !this.bracket || !this.isDuelist(id)) return null;
		return this.bracket.matches[d.match]!.a === id ? d.hp[0] : d.hp[1];
	}

	/** Entrants who played a live duel round this tournament. */
	get liveEntrants(): number {
		return this.playedLive.size;
	}

	// ---------------------------------------------------------------------
	// Flow

	update(now: number): TrnOut[] {
		this.stepSim(now);
		switch (this.phase) {
			case 'waiting':
				if (this.players.size >= this.minPlayers) {
					this.phase = 'starting';
					this.endsAt = now + this.startMs;
				}
				break;
			case 'starting':
				if (this.players.size < this.minPlayers) this.phase = 'waiting';
				else if (now >= this.endsAt) this.startTournament(now);
				break;
			case 'bracket':
				if (now >= this.endsAt) this.startDuel(now);
				break;
			case 'duel':
				this.duelTick(now);
				break;
			case 'ended':
				if (now >= this.endsAt) {
					if (this.players.size >= this.minPlayers) this.startTournament(now);
					else this.toWaiting(now);
				}
				break;
		}
		this.keepOffArena(now);
		return this.flush();
	}

	/** No tournament: waiting, or the countdown to the next one when enough players are in. */
	private toWaiting(now: number): void {
		this.phase = this.players.size >= this.minPlayers ? 'starting' : 'waiting';
		this.endsAt = now + this.startMs;
		this.bracket = null;
		this.duel = null;
		this.current = null;
		this.champion = null;
		this.entrantAccounts.clear();
		this.playedLive.clear();
	}

	private startTournament(now: number): void {
		const list = [...this.players.values()].map((p) => ({ id: p.id, name: p.name }));
		if (list.length < this.minPlayers) return this.toWaiting(now);
		this.tournament++;
		this.champion = null;
		this.duel = null;
		this.current = null;
		this.playedLive.clear();
		this.bets.clear();
		this.entrantAccounts.clear();
		for (const p of this.players.values()) this.entrantAccounts.set(p.id, p.accountId);
		this.bracket = createBracket(list, this.rng);
		this.emit({ e: 'start', tournament: this.tournament, entrants: list.length, prize: trnPrize(list.length) });
		this.phase = 'bracket';
		this.resolve();
		this.goNext(now);
	}

	/** Decide what needs no duel and say so. */
	private resolve(): void {
		const b = this.bracket;
		if (!b) return;
		const live = this.phase === 'duel' && this.duel ? this.duel.match : null;
		for (const m of resolveBracket(b, live)) this.announceDecided(m);
	}

	private announceDecided(m: number): void {
		const match = this.bracket!.matches[m]!;
		this.settleBets(m);
		if (match.winner === null) return;
		const loser = match.a === match.winner ? match.b : match.a;
		this.emit({ e: 'duelEnd', match: m, winner: match.winner, loser, result: match.result ?? 'forfeit' });
	}

	/** Show the next match in the bracket phase, or crown the champion. */
	private goNext(now: number): void {
		this.duel = null;
		if (this.checkChampion(now)) return;
		const m = this.bracket ? nextMatch(this.bracket) : null;
		if (m === null) {
			this.cancel(now);
			return;
		}
		this.phase = 'bracket';
		this.current = m;
		this.endsAt = now + this.bracketMs;
	}

	/** The final is decided: champion, or nobody (cancelled). True when the tournament is over. */
	private checkChampion(now: number): boolean {
		const b = this.bracket;
		if (!b) return false;
		const f = b.matches[b.matches.length - 1]!;
		if (!f.done) return false;
		const champ = bracketChampion(b);
		if (champ === null) {
			this.cancel(now);
			return true;
		}
		this.phase = 'ended';
		this.duel = null;
		this.current = null;
		this.champion = champ;
		this.endsAt = now + this.nextMs;
		const n = this.playedLive.size;
		this.emit({ e: 'champion', tournament: this.tournament, id: champ, entrants: n, prize: trnPrize(n) });
		return true;
	}

	/** Stop the tournament: every open bet is given back. */
	cancel(now: number): TrnOut[] {
		for (const m of [...this.bets.keys()]) this.settleBets(m, true);
		this.toWaiting(now);
		return this.flush();
	}

	private startDuel(now: number): void {
		const b = this.bracket;
		const m = this.current;
		if (!b || m === null || b.matches[m]!.done) return this.goNext(now);
		const match = b.matches[m]!;
		this.phase = 'duel';
		this.duel = { match: m, round: 1, hp: [TRN_HP, TRN_HP], sub: 'freeze', subEndsAt: 0, roundEndsAt: 0, wentLive: false, decided: false };
		this.emit({ e: 'duelStart', match: m, a: match.a!, b: match.b! });
		this.startRound(now);
	}

	private startRound(now: number): void {
		const d = this.duel!;
		const match = this.bracket!.matches[d.match]!;
		d.hp = [TRN_HP, TRN_HP];
		d.sub = 'freeze';
		d.subEndsAt = now + this.freezeMs;
		d.roundEndsAt = 0;
		this.emit({ e: 'roundStart', match: d.match, round: d.round });
		const spawns = this.info.duelSpawns;
		for (const [i, id] of [match.a, match.b].entries()) {
			const p = id === null ? undefined : this.players.get(id);
			if (p) this.spawnDuelist(p, spawns[i]!, now);
		}
	}

	private duelTick(now: number): void {
		const d = this.duel;
		if (!d) return;
		const match = this.bracket!.matches[d.match]!;
		if (d.sub === 'freeze') {
			this.holdFrozen(now);
			if (now < d.subEndsAt) return;
			d.sub = 'live';
			d.roundEndsAt = now + this.roundMs;
			d.wentLive = true;
			if (match.a !== null) this.playedLive.add(match.a);
			if (match.b !== null) this.playedLive.add(match.b);
		} else if (d.sub === 'live') {
			if (now < d.roundEndsAt) return;
			const [ha, hb] = d.hp;
			if (ha === hb) this.endRound(now, null, 'draw');
			else this.endRound(now, ha > hb ? match.a : match.b, 'time');
		} else if (now >= d.subEndsAt) {
			const w = match.wins[0] >= TRN_ROUND_WINS ? match.a : match.wins[1] >= TRN_ROUND_WINS ? match.b : null;
			if (w !== null) this.endDuel(now, w, 'rounds');
			else {
				if (d.decided) d.round++;
				this.startRound(now);
			}
		}
	}

	private endRound(now: number, winner: number | null, reason: 'kill' | 'time' | 'draw'): void {
		const d = this.duel!;
		const match = this.bracket!.matches[d.match]!;
		if (winner !== null) match.wins[winner === match.a ? 0 : 1]++;
		this.emit({ e: 'roundEnd', match: d.match, round: d.round, winner, reason, wins: [match.wins[0], match.wins[1]] });
		d.decided = winner !== null;
		d.sub = 'post';
		d.subEndsAt = now + this.roundEndMs;
	}

	/** The live duel is over: the winner advances, both go back to the deck, bets are settled. */
	private endDuel(now: number, winner: number | null, result: 'rounds' | 'forfeit'): void {
		const d = this.duel!;
		const b = this.bracket!;
		const match = b.matches[d.match]!;
		const loser = match.a === winner ? match.b : match.a;
		decide(b, d.match, winner, result);
		this.settleBets(d.match);
		if (winner !== null) this.emit({ e: 'duelEnd', match: d.match, winner, loser, result });
		for (const id of [match.a, match.b]) {
			const p = id === null ? undefined : this.players.get(id);
			if (p) this.spawnOnDeck(p, now);
		}
		this.duel = null;
		this.phase = 'bracket';
		this.resolve();
		this.goNext(now);
	}

	// ---------------------------------------------------------------------
	// Spawns

	private spawnEvent(p: TrnPlayer, s: Spawn, role: TrnRole, freezeMs: number, now: number): void {
		p.hist.clear();
		p.body.reset();
		p.pos = { x: s.pos.x, y: s.pos.y, z: s.pos.z, ducked: false, yaw: s.yaw, pitch: 0, vx: 0, vy: 0, vz: 0, onGround: true };
		p.spawnPos = { ...s.pos };
		p.spawnAt = now;
		p.lastPull = now;
		const pos = { x: s.pos.x, y: s.pos.y, z: s.pos.z };
		this.emit({ e: 'spawn', id: p.id, role, pos, yaw: s.yaw, freezeSecs: freezeMs / 1000 }, { to: [p.id] });
	}

	private spawnDuelist(p: TrnPlayer, s: Spawn, now: number): void {
		for (const w of ['sniper', 'pistol', 'knife'] as const) p.guns[w].equip(w);
		p.ws = p.guns.sniper;
		p.deckHits = 0;
		this.spawnEvent(p, s, 'duelist', this.freezeMs, now);
		this.ammoEvent(p);
	}

	private spawnOnDeck(p: TrnPlayer, now: number): void {
		const list = this.info.deckSpawns;
		const s = list[Math.min(list.length - 1, Math.floor(this.rng() * list.length))] ?? fallbackInfo({ pos: ZERO, yaw: 0 }).deckSpawns[0]!;
		p.guns.knife.equip('knife');
		p.ws = p.guns.knife;
		p.deckHits = 0;
		this.spawnEvent(p, s, 'spectator', 0, now);
	}

	/** Frozen duelists who walked off their spawn are put back. */
	private holdFrozen(now: number): void {
		const match = this.bracket!.matches[this.duel!.match]!;
		for (const id of [match.a, match.b]) {
			const p = id === null ? undefined : this.players.get(id);
			if (!p?.pos || !p.spawnPos || now - p.spawnAt < SPAWN_GRACE_MS || now - p.lastPull < PULL_MS) continue;
			const s = p.spawnPos;
			if (Math.hypot(p.pos.x - s.x, p.pos.y - s.y, p.pos.z - s.z) <= TRN_FREEZE_SLACK) continue;
			const spawn = this.info.duelSpawns[match.a === id ? 0 : 1];
			this.spawnEvent(p, spawn, 'duelist', Math.max(0, this.duel!.subEndsAt - now), now);
		}
	}

	/** Nobody but the two duelists of a live duel stands in the arena: others are put back on the deck. */
	private keepOffArena(now: number): void {
		for (const p of this.players.values()) {
			if (this.isDuelist(p.id) || !p.pos || now - p.spawnAt < SPAWN_GRACE_MS || now - p.lastPull < PULL_MS) continue;
			if (inBox(p.pos, this.info.arena)) this.spawnOnDeck(p, now);
		}
	}

	// ---------------------------------------------------------------------
	// Weapons

	/** Duelists switch between sniper, pistol and knife; spectators only hold the knife. */
	selectWeapon(id: number, weapon: unknown, now: number): TrnOut[] {
		const p = this.players.get(id);
		if (!p || !isTrnWeapon(weapon) || !this.isDuelist(id)) return [];
		const next = p.guns[weapon];
		if (p.ws !== next) {
			p.ws.reloadEndsAt = 0;
			p.ws = next;
			next.deploy(now);
		}
		this.ammoEvent(p);
		return this.flush();
	}

	reload(id: number, now: number): TrnOut[] {
		const p = this.players.get(id);
		if (!p || !this.isDuelist(id)) return [];
		if (p.ws.startReload(now)) this.ammoEvent(p);
		return this.flush();
	}

	private ammoEvent(p: TrnPlayer): void {
		if (p.ws.melee) return;
		this.emit({ e: 'ammo', weapon: p.ws.weapon, mag: p.ws.mag, reserve: p.ws.reserve }, { to: [p.id] });
	}

	/**
	 * A shot or knife swing. Duelists fire their held weapon at the other
	 * duelist, while the round is live. Spectators swing the knife at other
	 * spectators, at any time. Lag-compensated: the targets are posed where
	 * the shooter saw them, `rewindMs` back.
	 */
	fire(id: number, shot: TrnFire, now: number): TrnActionResult {
		const p = this.players.get(id);
		if (!p) return { ok: false, reason: 'not playing', out: [] };
		const reject = (reason: string): TrnActionResult => {
			this.ammoEvent(p);
			return { ok: false, reason, out: this.flush() };
		};
		const duelist = this.isDuelist(id);
		if (duelist && this.duel!.sub !== 'live') return reject('frozen');
		if (!duelist && shot.weapon !== 'knife') return reject('knife only');
		if (shot.weapon !== p.ws.weapon) return reject('wrong weapon');
		const aim = this.checkAim(p, shot.origin, shot.dir);
		if (typeof aim === 'string') return reject(aim);
		p.ws.update(now);
		if (!p.ws.fire(now)) return reject(p.ws.reloading(now) ? 'reloading' : p.ws.mag <= 0 ? 'empty' : 'too fast');
		const o = { x: shot.origin.x, y: shot.origin.y, z: shot.origin.z };
		const rewind = typeof shot.rewindMs === 'number' && Number.isFinite(shot.rewindMs) ? Math.max(0, Math.min(INF_HISTORY_MS, shot.rewindMs)) : 0;
		const targets = duelist ? this.duelTargets(p) : this.deckTargets(p);
		const hit = this.trace(p, o, aim, targets, now - rewind, now);
		if (!p.ws.melee) {
			this.emit({ e: 'shot', id, weapon: p.ws.weapon, origin: o, end: hit?.end ?? this.end(o, aim, this.worldT(o, aim, p.ws.def.range)) }, { except: id });
			this.ammoEvent(p);
		}
		if (hit) {
			if (duelist) this.hurtDuelist(hit.target, p, p.ws.weapon, hit.part, now);
			else this.hurtSpectator(hit.target, p, now);
		}
		return { ok: true, out: this.flush() };
	}

	/** The other duelist of the live round. */
	private duelTargets(p: TrnPlayer): TrnPlayer[] {
		const match = this.bracket!.matches[this.duel!.match]!;
		const other = match.a === p.id ? match.b : match.a;
		const t = other === null ? undefined : this.players.get(other);
		return t?.pos ? [t] : [];
	}

	/** Every other spectator. */
	private deckTargets(p: TrnPlayer): TrnPlayer[] {
		const out: TrnPlayer[] = [];
		for (const q of this.players.values()) if (q !== p && q.pos && !this.isDuelist(q.id)) out.push(q);
		return out;
	}

	private worldT(o: Vec3, d: Vec3, range: number): number {
		return this.world ? this.world.trace(o, this.end(o, d, range), ZERO, ZERO).fraction * range : range;
	}

	private end(o: Vec3, d: Vec3, t: number): Vec3 {
		return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
	}

	/** Nearest target hit by the held weapon, behind no wall. */
	private trace(p: TrnPlayer, o: Vec3, d: Vec3, targets: TrnPlayer[], at: number, now: number): { target: TrnPlayer; part: PlayerPart; t: number; end: Vec3 } | null {
		const def = p.ws.def;
		const melee = p.ws.melee;
		const worldT = melee ? def.range : this.worldT(o, d, def.range);
		let best: { target: TrnPlayer; part: PlayerPart; t: number; end: Vec3 } | null = null;
		for (const t of targets) {
			const pose = this.poseOf(t, { x: 0, y: 0, z: 0, yaw: 0, ducked: false, hunched: false });
			if (at < now) t.hist.poseAt(at, now, this.poseOf(t, this.scratch), pose);
			if (melee) {
				const h = meleePlayer(o, d, pose, def.range, def.coneDeg);
				if (!h) continue;
				if (this.world && this.world.trace(o, playerUp(pose, INF_MELEE_LOS_HEIGHT), ZERO, ZERO).fraction < 1) continue;
				const part = rayPlayerPart(o, d, pose, def.range + 16)?.part ?? 'chest';
				if (!best || h.t < best.t) best = { target: t, part, t: h.t, end: this.end(o, d, h.t) };
			} else {
				const h = rayPlayerPart(o, d, pose, worldT);
				if (h && (!best || h.t < best.t)) best = { target: t, part: h.part, t: h.t, end: this.end(o, d, h.t) };
			}
		}
		return best;
	}

	private hurtDuelist(t: TrnPlayer, by: TrnPlayer, weapon: WeaponId, part: PlayerPart, now: number): void {
		const d = this.duel!;
		const match = this.bracket!.matches[d.match]!;
		const side = match.a === t.id ? 0 : 1;
		const dmg = Math.min(d.hp[side], trnDamage(weapon, part));
		if (dmg <= 0) return;
		d.hp[side] -= dmg;
		this.emit({ e: 'hit', by: by.id, target: t.id, part, dmg, hp: d.hp[side] }, { to: [by.id, t.id] });
		if (d.hp[side] > 0) return;
		this.emit({ e: 'kill', by: by.id, target: t.id, weapon, head: part === 'head', deck: false });
		this.endRound(now, by.id, 'kill');
	}

	private hurtSpectator(t: TrnPlayer, by: TrnPlayer, now: number): void {
		t.deckHits++;
		const hp = Math.max(0, TRN_HP - t.deckHits * DECK_HIT_HP);
		const dmg = Math.min(DECK_HIT_HP, TRN_HP - (t.deckHits - 1) * DECK_HIT_HP);
		this.emit({ e: 'hit', by: by.id, target: t.id, part: 'chest', dmg, hp }, { to: [by.id, t.id] });
		if (t.deckHits < TRN_DECK_KNIFE_HITS) return;
		this.emit({ e: 'kill', by: by.id, target: t.id, weapon: 'knife', head: false, deck: true });
		this.spawnOnDeck(t, now);
	}

	private eyeOf(pos: TrnPos): Vec3 {
		return { x: pos.x, y: pos.y, z: pos.z + (pos.ducked ? DUCK_VIEW_HEIGHT : VIEW_HEIGHT) };
	}

	/** The unit direction, or why the shot is refused (as infected checks it). */
	private checkAim(p: TrnPlayer, o: Vec3, d: Vec3): Vec3 | string {
		if (!o || !d || ![o.x, o.y, o.z, d.x, d.y, d.z].every(Number.isFinite)) return 'bad shot';
		const len = Math.hypot(d.x, d.y, d.z);
		if (len < 0.9 || len > 1.1) return 'bad direction';
		if (p.pos) {
			if (Math.hypot(o.x - p.pos.x, o.y - p.pos.y, o.z - (p.pos.z + VIEW_HEIGHT)) > INF_ORIGIN_SLACK) return 'bad origin';
			if (this.world) {
				const los = this.world.trace(this.eyeOf(p.pos), o, ZERO, ZERO);
				if (!los.startsolid && los.fraction < 1) return 'bad origin';
			}
		}
		return { x: d.x / len, y: d.y / len, z: d.z / len };
	}

	private poseOf(p: TrnPlayer, out: PlayerPose): PlayerPose {
		const pos = p.pos!;
		out.x = pos.x;
		out.y = pos.y;
		out.z = pos.z;
		out.yaw = pos.yaw ?? 0;
		out.ducked = pos.ducked;
		out.hunched = false;
		out.held = p.ws.weapon;
		out.pitch = pos.pitch ?? 0;
		copyMotion(p.body.motion, (out.motion ??= restMotion()));
		return out;
	}

	/** Bodies and the pose history, in fixed steps (as infected). */
	private stepSim(now: number): void {
		if (now - this.simTime > INF_STEP_MS * 8) this.simTime = now - INF_STEP_MS * 8;
		const steps = Math.floor((now - this.simTime) / INF_STEP_MS);
		if (steps <= 0) return;
		const s = this.bodyInput;
		for (const p of this.players.values()) {
			if (!p.pos) continue;
			s.vx = p.pos.vx ?? 0;
			s.vy = p.pos.vy ?? 0;
			s.vz = p.pos.vz ?? 0;
			s.yaw = p.pos.yaw ?? 0;
			s.pitch = p.pos.pitch ?? 0;
			s.onGround = p.pos.onGround !== false;
			s.ducked = p.pos.ducked;
			p.body.follow(steps, INF_STEP_MS / 1000, s);
		}
		this.simTime += steps * INF_STEP_MS;
		this.tick += steps;
		for (const p of this.players.values()) if (p.pos) p.hist.record(now, this.tick, this.poseOf(p, this.scratch));
	}

	// ---------------------------------------------------------------------
	// Bets

	/** The match bets go on now, or null: the bracket phase before it, and round 1's freeze. */
	betMatch(): number | null {
		if (!this.bracket || this.bracket.entrants.length < TRN_BET_MIN_ENTRANTS) return null;
		if (this.phase === 'bracket') return this.current;
		const d = this.duel;
		if (this.phase === 'duel' && d && !d.wentLive) return d.match;
		return null;
	}

	/** Can this bettor bet on `pick` now? `match` is the match it would go on (-1: none). */
	betCheck(bettor: { id: number; accountId: number | null }, pick: unknown): { ok: true; match: number } | { ok: false; match: number; reason: TrnBetRefusal } {
		const b = this.bracket;
		const live = this.phase === 'bracket' || this.phase === 'duel';
		if (!b || !live) return { ok: false, match: -1, reason: 'closed' };
		if (b.entrants.length < TRN_BET_MIN_ENTRANTS) return { ok: false, match: this.current ?? -1, reason: 'small' };
		const m = this.betMatch();
		if (m === null) return { ok: false, match: this.current ?? -1, reason: 'closed' };
		if (bettor.accountId === null) return { ok: false, match: m, reason: 'guest' };
		const match = b.matches[m]!;
		const duelists = [match.a, match.b];
		const accounts = duelists.map((id) => (id === null ? null : (this.entrantAccounts.get(id) ?? null)));
		if (duelists.includes(bettor.id) || accounts.includes(bettor.accountId)) return { ok: false, match: m, reason: 'duelist' };
		if (typeof pick !== 'number' || !duelists.includes(pick)) return { ok: false, match: m, reason: 'pick' };
		if (this.bets.get(m)?.has(bettor.accountId)) return { ok: false, match: m, reason: 'twice' };
		return { ok: true, match: m };
	}

	/** Record a bet the server took the stake for (after `betCheck` said ok, in the same call). */
	placeBet(accountId: number, match: number, pick: number, ticket: number, stake: number): void {
		let book = this.bets.get(match);
		if (!book) this.bets.set(match, (book = new Map()));
		book.set(accountId, { accountId, ticket, pick, stake });
	}

	/** Pay or give back every bet on a decided match (`refund`: cancelled). */
	private settleBets(m: number, refund = false): void {
		const book = this.bets.get(m);
		if (!book) return;
		this.bets.delete(m);
		const match = this.bracket?.matches[m];
		const rounds = !refund && match?.done && match.result === 'rounds' && match.winner !== null;
		for (const bet of book.values()) {
			const outcome = !rounds ? 'refund' : bet.pick === match!.winner ? 'won' : 'lost';
			const payout = outcome === 'won' ? bet.stake * 2 : outcome === 'refund' ? bet.stake : 0;
			this.settlements.push({ accountId: bet.accountId, ticket: bet.ticket, match: m, pick: bet.pick, outcome, stake: bet.stake, payout });
		}
	}

	/** Bets decided since the last call. */
	takeSettlements(): TrnSettlement[] {
		const out = this.settlements;
		this.settlements = [];
		return out;
	}

	/** Open bets (tests, dispose). */
	openBets(): number {
		let n = 0;
		for (const b of this.bets.values()) n += b.size;
		return n;
	}

	// ---------------------------------------------------------------------
	// Views

	private emit(ev: TrnEvent, route: Omit<TrnOut, 'ev'> = {}): void {
		this.pending.push({ ev, ...route });
	}

	private flush(): TrnOut[] {
		const out = this.pending;
		this.pending = [];
		return out;
	}

	view(now: number): TrnStateView {
		const b = this.bracket;
		const d = this.duel;
		const left = (at: number) => Math.max(0, Math.round((at - now) / 100) / 10);
		let timeLeft = 0;
		if (this.phase === 'starting' || this.phase === 'bracket' || this.phase === 'ended') timeLeft = left(this.endsAt);
		else if (d) timeLeft = d.sub === 'live' ? left(d.roundEndsAt) : d.sub === 'freeze' ? this.roundMs / 1000 : 0;
		const shown = d ? d.match : this.current;
		const round = b && shown !== null ? b.matches[shown]!.round + 1 : 0;
		let duel: TrnDuelView | null = null;
		if (d && this.phase === 'duel') {
			duel = { match: d.match, round: d.round, hp: [d.hp[0], d.hp[1]], freeze: d.sub === 'freeze' ? left(d.subEndsAt) : 0 };
		}
		let bets: TrnBetsView | null = null;
		if (b && b.entrants.length >= TRN_BET_MIN_ENTRANTS && shown !== null && (this.phase === 'bracket' || this.phase === 'duel')) {
			const match = b.matches[shown]!;
			const count: [number, number] = [0, 0];
			for (const bet of this.bets.get(shown)?.values() ?? []) count[bet.pick === match.a ? 0 : 1]++;
			bets = { match: shown, open: this.betMatch() === shown, count };
		}
		return {
			phase: this.phase,
			tournament: this.tournament,
			round,
			timeLeft,
			bracket: b ? bracketView(b) : null,
			duel,
			bets,
			champion: this.phase === 'ended' ? this.champion : null
		};
	}

	/** Bracket rounds of the current tournament (0 without one). */
	get rounds(): number {
		return this.bracket ? bracketRounds(this.bracket.size) : 0;
	}

	/** The match an entrant still has to play, or null. */
	pendingMatchOf(id: number): number | null {
		return this.bracket ? pendingMatchOf(this.bracket, id) : null;
	}
}

/** Stake of one bet, tenths. */
export const TRN_BET_STAKE = pts(TRN_BET);

function inBox(p: Vec3, box: { min: Vec3; max: Vec3 }): boolean {
	return p.x >= box.min.x && p.x <= box.max.x && p.y >= box.min.y && p.y <= box.max.y && p.z >= box.min.z && p.z <= box.max.z;
}

/** A map without tournament data (should not happen; maps.test checks it): everyone at the map spawn. */
function fallbackInfo(spawn: Spawn): TournamentMapInfo {
	const far = { x: 1e9, y: 1e9, z: 1e9 };
	return { duelSpawns: [spawn, spawn], arena: { min: far, max: far }, deck: { min: far, max: far }, deckSpawns: [spawn] };
}
