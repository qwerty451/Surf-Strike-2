/**
 * Tournament client (docs/modes.md#tournament). The server runs the bracket,
 * the duels and the bets; this keeps the latest `modeState`, applies `trn`
 * events (spawns with freeze, hits, kills, tracers, ammo, bet answers),
 * predicts the local weapons (fire rate, ammo, reload, sniper scope) and
 * builds the HUD view.
 *
 * Duelists carry sniper [1], pistol [2] and knife [3] (TRN_WEAPONS); everyone
 * else watches from the glass deck with the knife only. Shots and swings go
 * out as `fire` (the knife too), swaps as `loadout`, reloads as `reload`, the
 * same messages as Infected. Offline (or before the first state) the map is
 * free roam on the deck with the knife.
 *
 * Gun feel is a lean subset of Infected's (gunfeel.ts): the aim/zoom ease and
 * the aimed move speed, no recoil or bloom; spread blends from the hip cone to
 * the aimed one with the aim.
 */
import {
	TRN_WEAPONS,
	trnPrize,
	trnRoundLabel,
	WEAPONS,
	WeaponState,
	type ClientMessage,
	type CollisionWorld,
	type TrnEvent,
	type TrnRole,
	type TrnStateView,
	type Vec3,
	type WeaponId
} from '@surf/shared';
import type { RemotePlayers } from '../render/players.js';
import type { ZombieRenderer } from '../render/zombies.js';
import type { KillFeedLine, TournamentView, TrnBetPanel, TrnDuelSide } from './contract.js';
import { aimFov, aimMoveFactor, aimStep, AIM, ease, ZOOM_MS, zoomStep } from './gunfeel.js';
import { hitFeedback, localImpact, shotFeedback, type FxHost } from './infected-feedback.js';
import type { InfSound } from './infected.js';
import {
	betAcceptedText,
	betRefusalText,
	betResultText,
	betSides,
	canBet,
	championText,
	duelMatch,
	entrantName,
	roundEndText,
	startText,
	trnLate,
	trnOut,
	trnRole
} from './tournament-view.js';
import { FIRE_BUFFER_MS, forwardDir, liveKillFeed, pushKillFeed, spreadDir } from './zombies-view.js';

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
/** `fire.tick`: no rewind tick of our own; the server uses its own history (as Infected). */
export const TRN_FIRE_TICK_NOW = 2 ** 31 - 1;
const FLASH_MS = 3200;
/** A bet outcome shows this long, whatever the bets move on to (ms). */
const BET_RESULT_MS = 6000;
/** After a spawn, a state may still be older than it: role and life from states wait this long (ms). */
const SPAWN_GRACE_MS = 1500;
/** Share of the sniper's aim after which its scope overlay comes in. */
const SCOPE_OVERLAY_FROM = 0.6;
/** My tracers start this far ahead of the eye, beside and below it (units). */
const TRACER_AHEAD = 18;

export interface TrnHost extends FxHost {
	online(): boolean;
	selfId(): number;
	send(msg: ClientMessage): void;
	/** Lobby name of any player. */
	name(id: number): string;
	/** Move the local player (spawn), velocity zeroed. */
	teleport(pos: Vec3, yaw: number): void;
	voteOpen(): boolean;
	/** Logged-in account (bets need coins). */
	loggedIn(): boolean;
	/** Viewmodel and tracers. */
	zombieRenderer(): ZombieRenderer | null;
	remotePlayers(): RemotePlayers | null;
	/** Eased zoom, every frame: the aimed FOV (horizontal at 4:3) and its 0..1 progress. */
	zoomProgress(fov: number, t: number): void;
	/** The viewed player (spectate target, else me). */
	viewId(): number;
}

export class TournamentClient {
	private state: TrnStateView | null = null;
	private stateAt = 0;
	private endsAt = 0;
	/** Local freeze end (spawn freeze, or the duel's freeze while I duel). */
	private frozenUntil = 0;
	private role: TrnRole = 'spectator';
	private alive = true;
	private readonly sniper = new WeaponState('sniper');
	private readonly pistol = new WeaponState('pistol');
	private readonly knife = new WeaponState('knife');
	private ws: WeaponState = this.knife;
	private fireHeld = false;
	private firePressAt = -Infinity;
	private dryArmed = false;
	private aimHeld = false;
	private aimT = 0;
	/** Set every frame by the mode: Mouse2 toggles the aim (`cl_aimtoggle`), and the player's FOV. */
	aimToggle = false;
	fov = 90;
	private scopeSound = false;
	private spectating = false;
	private specId: number | null = null;
	private hitMarker: TournamentView['hitMarker'] = null;
	private hurtAt = 0;
	private feed: KillFeedLine[] = [];
	private feedId = 0;
	private flash: TournamentView['flash'] = null;
	/** Weapon each remote duelist was last seen firing (their avatar holds it). */
	private readonly held = new Map<number, WeaponId>();
	/** My accepted bet and the latest bet note, per match. */
	private myBet: { match: number; pick: number } | null = null;
	private betNote: { match: number; note: NonNullable<TrnBetPanel['note']> } | null = null;
	/** Latest bet outcome (`betResult`): shown for a while even after the bets moved on. */
	private betResult: TournamentView['betResult'] = null;
	private spawnAt = -Infinity;
	private lastFrame = 0;
	private view: TournamentView | null = null;
	private viewKey = '';

	constructor(
		private readonly host: TrnHost,
		now: number,
		/** Map collision for cosmetic tracer length (optional in tests). */
		private readonly world: Pick<CollisionWorld, 'trace'> | null = null
	) {
		this.lastFrame = now;
		this.host.zombieRenderer()?.setWeapon(this.ws.weapon);
	}

	get me(): number {
		return this.host.selfId();
	}

	get weapon(): WeaponId {
		return this.ws.weapon;
	}

	get myRole(): TrnRole {
		return this.role;
	}

	get down(): boolean {
		return !this.alive;
	}

	get latestState(): TrnStateView | null {
		return this.state;
	}

	/** Offline: solo free roam; online before the first state: waiting. */
	private get phase(): TournamentView['phase'] {
		if (!this.host.online()) return 'solo';
		return this.state?.phase ?? 'waiting';
	}

	/** The local player may not move (spawn freeze, or the duel's freeze while dueling). */
	frozen(now: number): boolean {
		return now < this.frozenUntil;
	}

	/** Free roam without a server round: fall-outs respawn locally. */
	get localFallouts(): boolean {
		return this.phase === 'solo' || this.phase === 'waiting';
	}

	/** Weapon move speed, slowed while aimed. */
	maxSpeed(): number {
		return WEAPONS[this.ws.weapon].moveSpeed * aimMoveFactor(this.ws.weapon, ease(this.aimT));
	}

	/** Remote duelist out of the round (killed): not drawn until the next spawn. */
	isDown(id: number): boolean {
		const s = this.state;
		const m = duelMatch(s);
		if (!s?.duel || !m) return false;
		if (m.a === id) return s.duel.hp[0] <= 0;
		if (m.b === id) return s.duel.hp[1] <= 0;
		return false;
	}

	/** What a remote player holds: a duelist the gun they last fired (sniper first), a spectator the knife. */
	heldOf(id: number): WeaponId {
		if (trnRole(this.state, id) !== 'duelist') return 'knife';
		return this.held.get(id) ?? 'sniper';
	}

	/** Spectating (free-fly or `targetId`): no local weapons, scope or feedback. */
	setSpectate(spectating: boolean, targetId: number | null): void {
		const id = spectating ? targetId : null;
		if (spectating === this.spectating && id === this.specId) return;
		this.spectating = spectating;
		this.specId = id;
		if (spectating) {
			this.fireHeld = false;
			this.aimHeld = false;
			this.aimT = 0;
		}
		this.viewKey = '';
	}

	// ---------------------------------------------------------------------
	// Weapons

	/** Equip for a role: duelists get TRN_WEAPONS fresh (ammo then comes from the server), spectators the knife. */
	private arm(role: TrnRole): void {
		this.role = role;
		this.sniper.equip('sniper');
		this.pistol.equip('pistol');
		this.knife.equip('knife');
		this.hold(role === 'duelist' ? this.slotOf(TRN_WEAPONS[0] ?? 'sniper') : this.knife);
		this.viewKey = '';
	}

	private slotOf(w: WeaponId): WeaponState {
		return w === 'sniper' ? this.sniper : w === 'pistol' ? this.pistol : this.knife;
	}

	/** Hold `next`; with `now` (a key press) it is drawn and cannot fire for its deployMs, as on the server. */
	private hold(next: WeaponState, now?: number): void {
		if (next === this.ws && now !== undefined) return;
		this.ws.reloadEndsAt = 0;
		this.ws = next;
		this.aimT = 0;
		if (this.aimToggle) this.aimHeld = false;
		if (now !== undefined) {
			next.deploy(now);
			this.host.sound('draw');
		}
		this.host.zombieRenderer()?.setWeapon(next.weapon);
		this.viewKey = '';
	}

	/** Duelists: 1 sniper, 2 pistol, 3 knife. Spectators who may bet: 1 / 2 bet on side a / b. False: the key goes to the map vote. */
	slot(n: number, now: number): boolean {
		if (this.host.voteOpen()) return false;
		if (this.role !== 'duelist' || this.spectating) {
			const sides = betSides(this.state);
			if (sides && (n === 1 || n === 2) && canBet(this.betInput()) && !this.hasBet(sides.match)) {
				this.bet(n === 1 ? sides.a : sides.b);
				return true;
			}
			return false;
		}
		if (!this.alive) return true;
		const want = n === 1 ? this.sniper : n === 2 ? this.pistol : n === 3 ? this.knife : null;
		if (!want || want === this.ws) return true;
		this.hold(want, now);
		this.host.send({ type: 'loadout', weapon: want.weapon });
		return true;
	}

	reload(now: number): void {
		if (this.spectating || !this.alive || this.ws.melee) return;
		if (!this.ws.startReload(now)) return;
		this.host.sound('reload');
		if (this.aimToggle) this.aimHeld = false;
		this.host.send({ type: 'reload' });
		this.viewKey = '';
	}

	press(action: 'attack' | 'attack2', down: boolean, now: number): void {
		if (this.spectating) return;
		if (action === 'attack') {
			this.fireHeld = down;
			if (down) {
				this.firePressAt = now;
				this.dryArmed = true;
			}
			return;
		}
		const aims = AIM[this.ws.weapon] !== undefined;
		if (this.aimToggle) {
			if (down && this.alive && aims) this.aimHeld = !this.aimHeld;
		} else this.aimHeld = down && this.alive;
		if (down && aims && WEAPONS[this.ws.weapon].zoomFov !== null) this.scopeSound = true;
	}

	/** Every held button let go (pointer lock lost, chat, menus). */
	release(now: number): void {
		this.press('attack', false, now);
		if (!this.aimToggle) this.press('attack2', false, now);
	}

	private get aiming(): boolean {
		return this.aimHeld && this.alive && !this.spectating && AIM[this.ws.weapon] !== undefined && this.ws.reloadEndsAt === 0;
	}

	/** May fire now: online, alive, not frozen; duelists only while their duel is on, spectators always (deck knife fights). */
	private canFight(now: number): boolean {
		if (!this.alive || this.spectating || this.frozen(now)) return false;
		if (this.role === 'spectator') return this.ws.weapon === 'knife';
		return this.phase === 'duel';
	}

	/** After the movement of a tick: the trigger. */
	tick(now: number, eye: Vec3, pitch: number, yaw: number): void {
		this.sniper.update(now);
		this.pistol.update(now);
		if (!this.canFight(now)) {
			if (!this.alive) this.fireHeld = false;
			return;
		}
		const def = this.ws.def;
		const want = (this.fireHeld && def.automatic) || now - this.firePressAt < FIRE_BUFFER_MS;
		if (!want) return;
		if (!this.ws.melee && this.ws.mag <= 0) {
			this.firePressAt = -Infinity;
			if (this.ws.reloading(now)) return;
			if (this.ws.reserve > 0) this.reload(now);
			else if (this.dryArmed) {
				this.dryArmed = false;
				this.host.sound('dryfire');
			}
			return;
		}
		if (!this.ws.fire(now)) return;
		this.firePressAt = -Infinity;
		this.shoot(now, eye, pitch, yaw);
	}

	/** Spread now: the hip cone blends into the aimed one with the aim. */
	private spreadNow(): number {
		const def = this.ws.def;
		const a = ease(this.aimT);
		return def.spread + (def.scopedSpread - def.spread) * a;
	}

	private shoot(now: number, eye: Vec3, pitch: number, yaw: number): void {
		const def = this.ws.def;
		const fwd = forwardDir(pitch, yaw);
		const dir = spreadDir(fwd, this.spreadNow());
		const r = this.host.zombieRenderer();
		r?.fired(now);
		this.host.sound(def.magazine === 0 ? 'knife' : (`shot-${def.id}` as InfSound));
		if (def.magazine > 0 && r) {
			const yr = (yaw * Math.PI) / 180;
			const scoped = ease(this.aimT) > 0.5;
			const side = scoped ? 0 : 7;
			const start = {
				x: eye.x + fwd.x * TRACER_AHEAD + Math.sin(yr) * side,
				y: eye.y + fwd.y * TRACER_AHEAD - Math.cos(yr) * side,
				z: eye.z + fwd.z * TRACER_AHEAD - 6
			};
			const end = { x: eye.x + dir.x * def.range, y: eye.y + dir.y * def.range, z: eye.z + dir.z * def.range };
			const t = (this.world?.trace(eye, end, ZERO, ZERO).fraction ?? 1) * def.range;
			r.tracer(start, { x: eye.x + dir.x * t, y: eye.y + dir.y * t, z: eye.z + dir.z * t }, now);
			localImpact(this.host, this.world, eye, dir, t, def.range, now, true);
		}
		if (def.id === 'sniper') this.host.sound('bolt');
		this.host.send({ type: 'fire', weapon: def.id, origin: { x: eye.x, y: eye.y, z: eye.z }, dir, tick: TRN_FIRE_TICK_NOW });
	}

	// ---------------------------------------------------------------------
	// Bets

	private betInput() {
		return { state: this.state, selfId: this.me, loggedIn: this.host.loggedIn(), online: this.host.online() };
	}

	private hasBet(match: number): boolean {
		return this.myBet?.match === match;
	}

	/** Bet on duelist `pick` of the bets' match (the server answers with `bet`). */
	bet(pick: number): void {
		const sides = betSides(this.state);
		if (!sides || (pick !== sides.a && pick !== sides.b)) return;
		this.host.send({ type: 'trnBet', pick });
	}

	// ---------------------------------------------------------------------
	// Server input

	onModeState(m: TrnStateView, now: number): void {
		const prev = this.state;
		this.state = m;
		this.stateAt = now;
		this.endsAt = m.phase === 'waiting' ? 0 : now + Math.max(0, m.timeLeft) * 1000;
		// A new tournament: old bets are history (bets are kept per match otherwise).
		if (prev && prev.tournament !== m.tournament) {
			this.myBet = null;
			this.betNote = null;
		}
		// The spawn event is authoritative: a state from before it must not undo it.
		if (now - this.spawnAt < SPAWN_GRACE_MS) {
			this.viewKey = '';
			return;
		}
		const role = trnRole(m, this.me);
		const duel = m.duel;
		const match = duelMatch(m);
		if (role === 'duelist' && duel && match) {
			// A missed duel spawn: arm from the state.
			if (this.role !== 'duelist') this.arm('duelist');
			const hp = match.a === this.me ? duel.hp[0] : duel.hp[1];
			this.alive = hp > 0;
			if (duel.freeze > 0) this.frozenUntil = Math.max(this.frozenUntil, now + duel.freeze * 1000);
		} else if (this.role === 'duelist' && m.phase !== 'duel') {
			// The duel is over for me (missed deck spawn): back to the knife.
			this.arm('spectator');
			this.alive = true;
		}
		this.viewKey = '';
	}

	private nameOf(id: number): string {
		return entrantName(this.state, id, (i) => this.host.name(i));
	}

	private feedName(id: number, lower = false): string {
		if (id === this.me) return lower ? 'you' : 'You';
		return this.nameOf(id);
	}

	private setFlash(text: string, tone: NonNullable<TournamentView['flash']>['tone'], now: number, sub?: string): void {
		this.flash = sub ? { text, sub, at: now, tone } : { text, at: now, tone };
	}

	onEvent(ev: TrnEvent, now: number): void {
		const me = this.me;
		switch (ev.e) {
			case 'spawn': {
				if (ev.id !== me) break;
				this.spawnAt = now;
				this.host.teleport(ev.pos, ev.yaw);
				this.alive = true;
				this.frozenUntil = ev.freezeSecs > 0 ? now + ev.freezeSecs * 1000 : 0;
				this.fireHeld = false;
				this.aimHeld = false;
				this.aimT = 0;
				this.arm(ev.role);
				break;
			}
			case 'start':
				this.feed = [];
				this.myBet = null;
				this.betNote = null;
				this.held.clear();
				this.setFlash('Tournament starting', 'info', now, startText(ev.entrants, ev.prize));
				this.host.sound('round');
				break;
			case 'duelStart': {
				const b = this.state?.bracket;
				const r = b?.matches[ev.match]?.round;
				const sub = b && r !== undefined ? trnRoundLabel(r + 1, b.size) : '';
				this.setFlash(`${this.feedName(ev.a)} vs ${this.feedName(ev.b, true)}`, 'duel', now, sub || undefined);
				this.host.sound('round');
				break;
			}
			case 'roundStart':
				this.setFlash(`Round ${ev.round}`, 'duel', now, 'Fight!');
				break;
			case 'roundEnd': {
				const tone = ev.winner === null ? 'info' : ev.winner === me ? 'win' : this.role === 'duelist' ? 'lose' : 'info';
				this.setFlash(roundEndText(ev.winner === null ? null : this.feedName(ev.winner), ev.round, ev.reason), tone, now, `${ev.wins[0]} – ${ev.wins[1]}`);
				break;
			}
			case 'duelEnd': {
				const winner = this.feedName(ev.winner);
				const text = ev.winner === me ? 'You advance!' : ev.loser === me ? 'Knocked out' : `${winner} advances`;
				const sub = ev.result === 'forfeit' ? 'by forfeit' : ev.result === 'bye' ? 'bye' : undefined;
				this.setFlash(text, ev.winner === me ? 'win' : ev.loser === me ? 'lose' : 'info', now, sub);
				break;
			}
			case 'hit':
				if (ev.by === me) {
					const kill = ev.hp <= 0;
					this.hitMarker = { at: now, head: ev.part === 'head', kill };
					hitFeedback(this.host, { e: 'hit', by: ev.by, targetId: ev.target, head: ev.part === 'head', kill }, now);
				}
				if (ev.target === me) {
					this.hurtAt = now;
					this.host.sound('hurt');
				}
				break;
			case 'kill': {
				const how = WEAPONS[ev.weapon]?.label ?? ev.weapon;
				const text = `${this.feedName(ev.by)} · ${how}${ev.head ? ' · headshot' : ''} › ${this.feedName(ev.target, true)}${ev.deck ? ' · deck' : ''}`;
				this.feed = pushKillFeed(this.feed, { id: ++this.feedId, text, head: ev.head, mine: ev.by === me, at: now }, now);
				if (ev.target === me && !ev.deck) {
					this.alive = false;
					this.fireHeld = false;
					this.aimHeld = false;
					this.setFlash(`Killed by ${this.nameOf(ev.by)}`, 'lose', now);
				}
				break;
			}
			case 'shot': {
				if (ev.id === me) break;
				this.held.set(ev.id, ev.weapon);
				const dx = ev.end.x - ev.origin.x;
				const dy = ev.end.y - ev.origin.y;
				const dz = ev.end.z - ev.origin.z;
				const len = Math.hypot(dx, dy, dz);
				const d = len > 1e-6 ? { x: dx / len, y: dy / len, z: dz / len } : { x: 1, y: 0, z: 0 };
				shotFeedback(this.host, this.world, this.host.zombieRenderer(), { e: 'shot', by: ev.id, weapon: ev.weapon, o: ev.origin, d, len }, now);
				this.host.sound(WEAPONS[ev.weapon]?.magazine === 0 ? 'knife' : (`shot-${ev.weapon}` as InfSound), ev.origin);
				break;
			}
			case 'ammo': {
				const ws = ev.weapon === 'sniper' ? this.sniper : ev.weapon === 'pistol' ? this.pistol : null;
				if (!ws || !Number.isFinite(ev.mag) || !Number.isFinite(ev.reserve)) break;
				ws.mag = ev.mag;
				ws.reserve = ev.reserve;
				break;
			}
			case 'bet':
				if (ev.ok && ev.pick !== null) {
					this.myBet = { match: ev.match, pick: ev.pick };
					this.betNote = { match: ev.match, note: { text: betAcceptedText(this.nameOf(ev.pick)), tone: 'ok', at: now } };
				} else this.betNote = { match: ev.match, note: { text: betRefusalText(ev.reason), tone: 'bad', at: now } };
				break;
			case 'betResult': {
				const note = { text: betResultText(ev.outcome, ev.payout), tone: ev.outcome === 'won' ? 'won' : ev.outcome === 'lost' ? 'lost' : 'refund', at: now } as const;
				this.betNote = { match: ev.match, note };
				this.betResult = note;
				break;
			}
			case 'champion': {
				const self = ev.id === me;
				this.setFlash(championText(this.nameOf(ev.id), self), 'gold', now, `Prize ${ev.prize} coin${ev.prize === 1 ? '' : 's'} · ${ev.entrants} entrants`);
				this.host.sound(self ? 'perk' : 'round');
				break;
			}
			default:
				break;
		}
		this.viewKey = '';
	}

	// ---------------------------------------------------------------------
	// Frame

	/** Aim ease, zoom, viewmodel and the HUD view (same object while nothing changed). */
	frame(now: number, viewmodel: boolean, speed: number): TournamentView {
		const dt = Math.max(0, Math.min(100, now - this.lastFrame));
		this.lastFrame = now;
		const w = this.ws.weapon;
		const aim = AIM[w];
		this.aimT = aimStep(this.aimT, this.aiming, dt, aim?.aimMs ?? ZOOM_MS);
		if (this.scopeSound) {
			this.scopeSound = false;
			this.host.sound('scope');
		}
		const a = ease(this.aimT);
		const zoomT = aim ? ease(zoomStep(this.aimT, aim.aimMs)) : 0;
		this.host.zoomProgress(aimFov(this.fov, w), zoomT);
		const r = this.host.zombieRenderer();
		if (r) {
			r.setWeapon(w);
			const scopedIn = WEAPONS[w].zoomFov !== null && a >= 1;
			r.updateViewmodel(now, viewmodel && !this.spectating && this.alive && !scopedIn, this.ws.reloadProgress(now), speed, undefined, this.ws.mag);
		}
		if (this.flash && now - this.flash.at > FLASH_MS) {
			this.flash = null;
			this.viewKey = '';
		}
		if (this.betResult && now - this.betResult.at > BET_RESULT_MS) {
			this.betResult = null;
			this.viewKey = '';
		}
		const feed = liveKillFeed(this.feed, now);
		if (feed.length !== this.feed.length) {
			this.feed = feed;
			this.viewKey = '';
		}
		const scopeT = WEAPONS[w].zoomFov !== null ? Math.max(0, Math.min(1, (a - SCOPE_OVERLAY_FROM) / (1 - SCOPE_OVERLAY_FROM))) : 0;
		const frozen = this.frozen(now);
		const key = `${this.viewKey}|${a.toFixed(3)}|${scopeT.toFixed(3)}|${this.ws.mag}|${this.ws.reserve}|${this.ws.reloadEndsAt}|${w}|${frozen}|${this.host.viewId()}|${this.host.online()}|${this.host.loggedIn()}|${this.host.voteOpen()}`;
		if (this.view && key === this.viewKey) return this.view;
		this.viewKey = key;
		this.view = this.buildView(a, scopeT);
		this.viewKey = key;
		return this.view;
	}

	private duelSide(id: number, hp: number, wins: number): TrnDuelSide {
		return { id, name: this.nameOf(id), hp, wins, self: id === this.me };
	}

	private betPanel(): TrnBetPanel | null {
		const s = this.state;
		const sides = betSides(s);
		if (!s || !sides) return null;
		const mine = this.myBet?.match === sides.match ? this.myBet : null;
		const note = this.betNote?.match === sides.match ? this.betNote.note : null;
		// Closed bets show only to who has a stake or an answer to read.
		if (!sides.open && !mine && !note) return null;
		return {
			match: sides.match,
			open: sides.open,
			a: { id: sides.a, name: this.nameOf(sides.a), count: sides.count[0] ?? 0 },
			b: { id: sides.b, name: this.nameOf(sides.b), count: sides.count[1] ?? 0 },
			canBet: !mine && canBet(this.betInput()),
			mine: mine ? { pick: mine.pick, name: this.nameOf(mine.pick) } : null,
			note
		};
	}

	private buildView(aimT: number, scopeT: number): TournamentView {
		const s = this.state;
		const phase = this.phase;
		const online = phase !== 'solo';
		const viewId = this.spectating && this.specId !== null ? this.specId : this.me;
		const duel = online ? s?.duel : null;
		const match = online ? duelMatch(s) : null;
		const freezeUntil = duel && duel.freeze > 0 ? this.stateAt + duel.freeze * 1000 : 0;
		let next: TournamentView['next'] = null;
		if (online && s?.phase === 'bracket' && s.bracket) {
			const m = s.bracket.matches[s.bets?.match ?? -1] ?? s.bracket.matches.find((x) => x.a !== null && x.b !== null && x.winner === null);
			if (m && m.a !== null && m.b !== null) next = { a: this.nameOf(m.a), b: this.nameOf(m.b) };
		}
		const entrants = s?.bracket?.entrants.length ?? 0;
		const champ = online && s?.phase === 'ended' && s.champion !== null ? s.champion : null;
		const def = this.ws.def;
		return {
			phase,
			tournament: s?.tournament ?? 0,
			roundLabel: online && s && s.round > 0 && s.bracket ? trnRoundLabel(s.round, s.bracket.size) : '',
			endsAt: online && phase !== 'waiting' ? this.endsAt : 0,
			role: online ? trnRole(s, viewId) : 'spectator',
			late: online && trnLate(s, this.me),
			out: online && trnOut(s, this.me),
			entrants,
			prize: trnPrize(entrants),
			duel:
				duel && match && match.a !== null && match.b !== null
					? {
							a: this.duelSide(match.a, duel.hp[0], match.wins[0] ?? 0),
							b: this.duelSide(match.b, duel.hp[1], match.wins[1] ?? 0),
							round: duel.round,
							freezeUntil
						}
					: null,
			next,
			champion: champ !== null ? { id: champ, name: this.nameOf(champ), self: champ === this.me } : null,
			flash: this.flash,
			showBracket: online && (s?.phase === 'bracket' || s?.phase === 'ended') && !!s?.bracket,
			state: online ? s : null,
			selfId: this.me,
			bet: online ? this.betPanel() : null,
			betResult: online ? this.betResult : null,
			alive: this.alive,
			knifeOnly: this.role !== 'duelist',
			weapon: def.id,
			weaponLabel: def.label,
			mag: this.ws.mag,
			magSize: def.magazine,
			reserve: this.ws.reserve,
			reloadEndsAt: this.ws.reloadEndsAt,
			reloadMs: this.ws.reloadDurationMs || def.reloadMs,
			hitMarker: this.hitMarker,
			hurtAt: this.hurtAt,
			killFeed: this.feed,
			scoped: def.zoomFov !== null && aimT > 0.5,
			scopeT,
			aimT: this.spectating ? 0 : aimT,
			spectating: this.spectating
		};
	}

	/** Solo scoreboard row. */
	soloRow(): { kills: number; score: number } {
		return { kills: 0, score: 0 };
	}

	dispose(): void {
		this.host.zoomProgress(this.fov, 0);
		const r = this.host.zombieRenderer();
		r?.setWeapon(null);
		r?.updateViewmodel(0, false, 1, 0);
	}
}
