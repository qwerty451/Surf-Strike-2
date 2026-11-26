/**
 * Points and coins on the server (docs/economy.md): the only place that pays.
 * Knows the connected players through `EconomyHost`, gives every gamemode a
 * `ModeEconomy` handle, pays playtime, and finds the abuse signals.
 *
 * Amounts are tenths of a point. Guests earn nothing.
 */
import type { AbuseSignal, AwardDef, AwardReason, CosmeticItem, GameModeId, LootRarity, MapDef, NetState, PointLogEntry, ServerMessage } from '@surf/shared';
import {
	ABUSE,
	applyMultiplier,
	AWARDS,
	awardLabel,
	BACKSTOP,
	cosmeticPrice,
	formatTenths,
	LOOTBOX,
	MIN_ACTIVE,
	modeMultiplier,
	MULT_ONE,
	PLAYTIME,
	RECENT_AWARDS,
	SPEED_LIMIT,
	START_COINS
} from '@surf/shared';
import { AbuseEngine } from './abuse.ts';
import { knownPoints, PlayerActivity, StepClock, type Stillness } from './activity.ts';
import { ipKey } from './admin.ts';
import { type AbuseRow, type Db, POINT_LOG_KEEP, POINT_LOG_RULES_MS } from './db.ts';

/** Activity and multiplier are updated this often (ms). */
export const ECONOMY_TICK_MS = 250;
/** Active time is written this often (ms). */
const FLUSH_MS = 60_000;
/** Log roll-up and other housekeeping (ms). */
const HOUSEKEEP_MS = 10 * 60_000;
/** "Earned lately" for the shadow signal (ms). */
const EARNED_LATELY_MS = 30_000;
/** Guests that were told about coins are remembered up to this many. */
const HINTS_MAX = 5000;
/** Shown to the banned player. */
const BAN_REASON = 'Point farming (detected automatically)';

/** What the economy reads of a connected player. */
export interface EconomyPlayer {
	readonly id: number;
	readonly playerId: string;
	readonly accountId: number | null;
	readonly name: string;
	readonly spectating: boolean;
	readonly helloed: boolean;
	readonly ip: string | null;
	readonly state: NetState | null;
}

export interface EconomyHost {
	db: Db;
	/** Wall clock (ms): log times, backstop, abuse. */
	now(): number;
	/** Monotonic clock (ms): activity and playtime. */
	clock(): number;
	players(): Iterable<EconomyPlayer>;
	send(p: EconomyPlayer, msg: ServerMessage): void;
	broadcast(msg: ServerMessage): void;
	systemTo(p: EconomyPlayer, text: string): void;
	/** The account's totals changed (scoreboard). */
	totals(accountId: number, pointsTotal: number): void;
	isAdmin(accountId: number): boolean;
	/** Ban an account (and kick it) for `ms`. */
	ban(accountId: number, reason: string, ms: number): void;
	/** A warning or ban was logged (admin menu). */
	abuseLogged(): void;
	log(msg: string): void;
	/** The current mode's `stillness` hook. */
	stillness(p: EconomyPlayer): Stillness;
}

/** Why an award was not (fully) paid. */
export type AwardRefusal =
	| 'guest'
	| 'gone'
	| 'spectating'
	| 'afk'
	| 'minPlayers'
	| 'suspect'
	| 'paused'
	| 'cap'
	| 'backstop'
	| 'nothing'
	| 'error';

export interface AwardResult {
	/** Tenths credited, multiplier included; 0 when refused. */
	paid: number;
	refused?: AwardRefusal;
}

export interface AwardOptions {
	/** Player id it was earned against (chased by, found, infected, …). Always pass it when there is one. */
	against?: number;
	/** Instead of the reason's label in the popup and the log, e.g. `Gate 3`. */
	label?: string;
}

/** What a gamemode gets as `host.economy` (docs/economy.md#paying-from-a-mode). */
export interface ModeEconomy {
	/** Pay `base` tenths (`pts(3)`, the *_PAY constants). All rules are applied here; just call it. */
	award(playerId: number, base: number, reason: AwardReason, opts?: AwardOptions): AwardResult;
	/** Active players now (guests included, one per account). */
	activePlayers(): number;
	/** Is this player active (not AFK, not spectating)? */
	isActive(playerId: number): boolean;
	/** Current multiplier in tenths (10 outside the multiplayer modes). */
	multiplier(): number;
	/** Enough active players for this mode (or this reason) to pay? */
	enoughPlayers(reason?: AwardReason): boolean;
	/** A round starts: per-round caps and tallies start over. Ends a running one. */
	roundStart(): void;
	/** The round is over, after its last award: the per-round abuse checks run. */
	roundEnd(): void;
	/** Count something per player; returns the count so far, this one included. Survives a reconnect. */
	tally(playerId: number, key: string, scope: 'round' | 'session'): number;
	/** The tally without counting. */
	tallied(playerId: number, key: string, scope: 'round' | 'session'): number;
	/** Base tenths paid for this reason in the round or session. */
	earned(playerId: number, reason: AwardReason, scope: 'round' | 'session'): number;
	/** ms since this reason was last paid to the account on this map; null: never (or over 30 days ago). */
	sinceLastPaid(playerId: number, reason: AwardReason): number | null;
	/** How often this reason (with this label, if given) was paid to the account on this map in the last `ms`; map changes do not reset it. */
	paidWithin(playerId: number, reason: AwardReason, ms: number, label?: string): number;
	/** Every tag, find or infection, paid or not: too many of one pair is a signal. */
	contact(byId: number, targetId: number): void;
	/** Abuse evidence the mode found: `shadow` (hunter, target) or `impossible` (player). */
	report(signal: 'shadow' | 'impossible', playerIds: readonly number[], evidence: string): void;
	/** The mode moved this player other than by a `spawn` event or to a map spawn. */
	teleported(playerId: number): void;
	/** The player did something the server verified that counts as moving (Infected: a gunshot). Not input for playtime. */
	acted(playerId: number): void;
	/**
	 * Tournament bets (docs/economy.md#tournament): take a stake (tenths) from
	 * the account at once. Returns the open bet's ticket, or null when the
	 * balance is too low. Casino-style: no points, no point log, no backstop.
	 */
	betOpen(accountId: number, stake: number): number | null;
	/** Settle an open bet, online or not: pay `payout` tenths (0 when lost). False when it was not open (nothing paid). */
	betClose(ticket: number, payout: number, outcome: 'won' | 'lost' | 'refund'): boolean;
}

/** Same person across reconnects. */
const personOf = (p: EconomyPlayer): string => (p.accountId !== null ? `a${p.accountId}` : `g${p.playerId}`);

/** What one person earned in the running round. */
interface RoundEarner {
	accountId: number;
	name: string;
	/** Base of pair reasons by the other person. */
	pair: Map<string, number>;
	/** Base of all attributed awards by the other person. */
	from: Map<string, { base: number; name: string; accountId: number | null; sameIp: boolean; activity: PlayerActivity | null }>;
}

interface Tallies {
	counts: Map<string, number>;
	earned: Map<string, number>;
}
const newTallies = (): Tallies => ({ counts: new Map(), earned: new Map() });

export class Economy {
	readonly abuse: AbuseEngine;
	private readonly activities = new Map<EconomyPlayer, PlayerActivity>();
	private readonly steps = new StepClock();
	private lastTick = -Infinity;
	private lastFlush: number | null = null;
	private lastHousekeep = -Infinity;
	/** Active time not written yet, per account online. */
	private readonly active = new Map<number, { ms: number; dirty: boolean }>();
	private readonly hinted = new Set<string>();
	/** Account → when it was told about the hourly limit. */
	private readonly limitTold = new Map<number, number>();
	private lastMult = '';
	private map: MapDef;
	private speedLimit = Infinity;
	private points: { x: number; y: number; z: number }[] = [];
	private session: Session;
	private rounds = 0;
	private readonly bans: number[] = [];
	/** Account → when awards were paid in the last 10 minutes. */
	private readonly paidAt = new Map<number, { at: number; from: string | null }[]>();
	/** Pair → contact times. */
	private readonly contacts = new Map<string, number[]>();
	/** Account → the last rounds in which pair points were earned. */
	private readonly pairRounds = new Map<number, { shares: Map<string, number>; enough: boolean }[]>();
	/** earner|feeder → rounds in a row. */
	private readonly feeds = new Map<string, number>();
	/** Tournament stakes given back at the start (the server stopped mid-duel), until the account hears about it. */
	private readonly trnRefunds: Map<number, number>;

	constructor(
		private readonly host: EconomyHost,
		map: MapDef
	) {
		this.map = map;
		this.session = new Session();
		this.abuse = new AbuseEngine({
			now: () => host.now(),
			isAdmin: (id) => host.isAdmin(id),
			warn: (id, strikes, evidence) => this.warn(id, strikes, evidence),
			ban: (id, strikes, evidence, exempt) => this.ban(id, strikes, evidence, exempt)
		});
		this.useMap(map);
		this.trnRefunds = host.db.refundTrnBets(host.now());
		if (this.trnRefunds.size > 0) host.log(`tournament: ${this.trnRefunds.size} open bets given back`);
	}

	// -----------------------------------------------------------------------
	// Connections (called by the lobby)

	join(p: EconomyPlayer): void {
		const a = new PlayerActivity();
		a.newMap();
		this.activities.set(p, a);
		this.sendMultiplier(p);
		this.account(p);
	}

	/** The player logged in (or joined logged in): load and show the totals. */
	account(p: EconomyPlayer): void {
		if (p.accountId === null) return;
		if (!this.active.has(p.accountId)) this.active.set(p.accountId, { ms: this.host.db.activeMs(p.accountId), dirty: false });
		this.sendCoins(p);
		const refund = this.trnRefunds.get(p.accountId);
		if (refund === undefined) return;
		this.trnRefunds.delete(p.accountId);
		this.host.send(p, { type: 'coinsNotice', text: `The server restarted: your tournament bet of ${formatTenths(refund)} coins was given back.`, tone: 'info' });
	}

	/** `accountId`: the account that logged out or whose connection closed. */
	leaveAccount(accountId: number, conn: EconomyPlayer): void {
		for (const p of this.host.players()) if (p !== conn && p.accountId === accountId) return;
		this.flushAccount(accountId);
		this.active.delete(accountId);
	}

	leave(p: EconomyPlayer): void {
		this.activities.delete(p);
	}

	spectate(p: EconomyPlayer): void {
		this.activities.get(p)?.spectate();
	}

	state(p: EconomyPlayer, s: NetState): void {
		this.activities.get(p)?.state(s, this.host.clock(), { limit: this.speedLimit, points: this.points, stillness: this.host.stillness(p) });
	}

	/** Every message a mode sends to one player: spawn events explain a teleport. */
	sent(p: EconomyPlayer, msg: ServerMessage): void {
		if ((msg.type === 'zm' || msg.type === 'inf' || msg.type === 'hns' || msg.type === 'trn') && msg.ev.e === 'spawn') this.activities.get(p)?.expectTeleport(this.host.clock());
	}

	/** Map change: a new map session with its own caps. */
	useMap(map: MapDef): void {
		this.map = map;
		this.speedLimit = SPEED_LIMIT[map.kind];
		this.points = knownPoints(map);
		this.session.open = false;
		this.session = new Session();
		this.contacts.clear();
		for (const a of this.activities.values()) a.newMap();
	}

	// -----------------------------------------------------------------------
	// Activity

	isActive(p: EconomyPlayer): boolean {
		const a = this.activities.get(p);
		return !!a && p.helloed && !p.spectating && !a.still;
	}

	/** Active players; an account connected more than once counts once. */
	activePlayers(): number {
		const people = new Set<string>();
		for (const p of this.host.players()) if (this.isActive(p)) people.add(personOf(p));
		return people.size;
	}

	multiplier(): number {
		return modeMultiplier(this.map.kind, this.activePlayers());
	}

	/** Advance activity and playtime (call often; works every ECONOMY_TICK_MS). */
	tick(): void {
		const t = this.host.clock();
		if (t - this.lastTick < ECONOMY_TICK_MS) return;
		this.lastTick = t;
		const ms = this.steps.step(t);
		const playing = new Map<number, EconomyPlayer>();
		for (const p of this.host.players()) {
			const a = this.activities.get(p);
			if (!a) continue;
			const counts = a.advance(ms, p.spectating, this.host.stillness(p));
			if (counts && p.accountId !== null) playing.set(p.accountId, p);
			const macro = a.macro(t);
			if (macro) this.macro(p, macro.inputs, macro.different);
		}
		for (const [accountId, p] of playing) this.addPlaytime(accountId, p, ms);
		this.lastFlush ??= t;
		if (t - this.lastFlush >= FLUSH_MS) {
			this.lastFlush = t;
			this.flush();
		}
		if (t - this.lastHousekeep >= HOUSEKEEP_MS) {
			this.lastHousekeep = t;
			this.housekeep();
		}
		this.carryOutBans();
		this.sendMultiplier();
	}

	private addPlaytime(accountId: number, p: EconomyPlayer, ms: number): void {
		const a = this.active.get(accountId);
		if (!a) return;
		a.ms += ms;
		a.dirty = true;
		if (a.ms < PLAYTIME.everyMs) return;
		const rest = a.ms - PLAYTIME.everyMs;
		const r = this.pay(p, accountId, PLAYTIME.points, 'playtime', MULT_ONE, AWARDS.playtime, awardLabel('playtime'), rest);
		// A failed write keeps the time and tries again.
		if (r.refused === 'error') return;
		a.ms = rest;
		// Refused by the backstop: nothing was written yet.
		a.dirty = r.paid === 0;
	}

	private flushAccount(accountId: number): void {
		const a = this.active.get(accountId);
		if (!a?.dirty) return;
		try {
			this.host.db.setActiveMs(accountId, a.ms);
			a.dirty = false;
		} catch (err) {
			this.host.log(`active time not saved: ${(err as Error).message}`);
		}
	}

	/** Write all active time. */
	flush(): void {
		for (const id of this.active.keys()) this.flushAccount(id);
	}

	private housekeep(): void {
		const now = this.host.now();
		this.abuse.prune();
		for (const [id, list] of this.paidAt) if (!list.some((e) => now - e.at < ABUSE.macroMs)) this.paidAt.delete(id);
		for (const [id, at] of this.limitTold) if (now - at >= BACKSTOP.windowMs) this.limitTold.delete(id);
		if (this.pairRounds.size > 1000) this.pairRounds.clear();
		try {
			this.host.db.deleteExpiredBans(now);
			const n = this.host.db.rollUpPoints(now - POINT_LOG_RULES_MS, POINT_LOG_KEEP);
			if (n > 0) this.host.log(`point log: ${n} old entries summed up`);
		} catch (err) {
			this.host.log(`housekeeping failed: ${(err as Error).message}`);
		}
	}

	close(): void {
		this.flush();
		this.active.clear();
		this.activities.clear();
	}

	// -----------------------------------------------------------------------
	// Ledger

	private player(id: number): EconomyPlayer | null {
		for (const p of this.host.players()) if (p.id === id) return p;
		return null;
	}

	/**
	 * Credit an account (the one write path). Applies the backstop; every other
	 * rule was checked before.
	 */
	private pay(
		p: EconomyPlayer | null,
		accountId: number,
		base: number,
		reason: AwardReason,
		mult: number,
		def: AwardDef,
		label: string,
		activeMs?: number
	): AwardResult & { base: number } {
		const { db } = this.host;
		const now = this.host.now();
		try {
			if (!def.exempt) {
				const left = BACKSTOP.points - db.countedSince(accountId, now - BACKSTOP.windowMs);
				if (left < base) this.tellLimit(accountId, now);
				if (left <= 0) return { paid: 0, base: 0, refused: 'backstop' };
				base = Math.min(base, left);
			}
			const amount = applyMultiplier(base, mult);
			const row = db.payPoints(
				{ accountId, at: now, mode: this.map.kind, map: this.map.id, reason, label, base, counted: def.exempt ? 0 : base, mult, amount },
				activeMs
			);
			if (!row) return { paid: 0, base: 0, refused: 'gone' };
			this.host.totals(accountId, row.pointsTotal);
			const list = this.paidAt.get(accountId) ?? [];
			if (list.length >= 500) list.shift();
			list.push({ at: now, from: null });
			this.paidAt.set(accountId, list);
			const msg: ServerMessage = {
				type: 'award',
				at: now,
				reason,
				label,
				base,
				mult,
				amount,
				total: row.pointsTotal,
				balance: row.pointsBalance
			};
			if (p) this.host.send(p, msg);
			return { paid: amount, base };
		} catch (err) {
			this.host.log(`award ${reason} for account ${accountId} failed: ${(err as Error).message}`);
			return { paid: 0, base: 0, refused: 'error' };
		}
	}

	/** The hourly backstop cut or refused an award: say so once per hour, with the time until more is paid. */
	private tellLimit(accountId: number, now: number): void {
		const told = this.limitTold.get(accountId);
		if (told !== undefined && now - told < BACKSTOP.windowMs) return;
		this.limitTold.set(accountId, now);
		const first = this.host.db.firstCountedSince(accountId, now - BACKSTOP.windowMs) ?? now;
		const mins = Math.max(1, Math.ceil((first + BACKSTOP.windowMs - now) / 60_000));
		const text = `Hourly coin limit reached (${formatTenths(BACKSTOP.points)} per hour). More is paid in ${mins} min.`;
		this.notify(accountId, text);
	}

	private notify(accountId: number, text: string): void {
		for (const p of this.host.players()) if (p.accountId === accountId) this.host.send(p, { type: 'coinsNotice', text, tone: 'info' });
	}

	/** The player has just registered: say what the new account starts with. */
	welcome(accountId: number): void {
		this.notify(accountId, `Welcome! You start with ${formatTenths(START_COINS)} coins. Spend them in the shop (Esc).`);
	}

	/**
	 * Take coins for a purchase (tenths, positive). False when the balance is
	 * too low; it never goes negative. `item` becomes the reason `shop:<item>`.
	 */
	spend(accountId: number, amount: number, item: string): boolean {
		if (!Number.isInteger(amount) || amount <= 0) return false;
		const reason = `shop:${item}`;
		const row = this.host.db.spendPoints({ accountId, at: this.host.now(), reason, label: awardLabel(reason), amount });
		if (!row) return false;
		this.sendCoinsTo(accountId);
		return true;
	}

	/** Buy an item (docs/economy.md#shop): deduct, log and grant in one transaction. */
	buy(accountId: number, item: CosmeticItem): 'ok' | 'owned' | 'poor' | 'unknown' {
		const price = cosmeticPrice(item);
		if (price === null || !Number.isInteger(price) || price <= 0) return 'unknown';
		const reason = `shop:${item.id}`;
		const r = this.host.db.buyItem({ accountId, at: this.host.now(), reason, label: awardLabel(reason), amount: price }, item.id);
		if (r === 'ok') this.sendCoinsTo(accountId);
		return r;
	}

	/** Buy and open a loot box holding `item` (docs/economy.md#loot-box), in one transaction. */
	openBox(accountId: number, item: CosmeticItem): { duplicate: boolean; refund: number } | 'poor' {
		const refund = LOOTBOX.refund[item.rarity as LootRarity] ?? 0;
		const r = this.host.db.openBox(
			{ accountId, at: this.host.now(), reason: `shop:${LOOTBOX.id}`, label: `Shop: ${LOOTBOX.name}`, amount: LOOTBOX.price },
			item.id,
			{ amount: refund, label: `Duplicate: ${item.name}` }
		);
		if (r === 'poor') return r;
		this.sendCoinsTo(accountId);
		return { duplicate: r === 'duplicate', refund: r === 'duplicate' ? refund : 0 };
	}

	/**
	 * Admin change of the balance (docs/economy.md#admin-changes): signed tenths, or
	 * null for a reset to zero. Clamped at zero; lifetime points and awards stay.
	 * Null when the account does not exist.
	 */
	adjust(accountId: number, amount: number | null): { delta: number; balance: number } | null {
		const label = amount === null ? 'Coins reset by an admin' : amount > 0 ? 'Coins added by an admin' : 'Coins removed by an admin';
		const r = this.host.db.adjustBalance({ accountId, at: this.host.now(), reason: 'admin', label }, amount);
		if (!r || r.delta === 0) return r;
		this.sendCoinsTo(accountId);
		const text = r.delta > 0 ? `An admin gave you ${formatTenths(r.delta)} coins.` : `An admin removed ${formatTenths(-r.delta)} of your coins.`;
		this.notify(accountId, text);
		return r;
	}

	/** Take a tournament stake (docs/economy.md#tournament); the open bet's ticket, or null. */
	betOpen(accountId: number, stake: number): number | null {
		if (!Number.isInteger(stake) || stake <= 0) return null;
		try {
			const id = this.host.db.trnBetOpen(accountId, this.host.now(), stake);
			if (id !== null) this.sendCoinsTo(accountId);
			return id;
		} catch (err) {
			this.host.log(`tournament bet for account ${accountId} failed: ${(err as Error).message}`);
			return null;
		}
	}

	/** Settle a tournament bet; the account need not be online. */
	betClose(ticket: number, payout: number, outcome: 'won' | 'lost' | 'refund'): boolean {
		try {
			const game = outcome === 'won' ? 'trnWin' : outcome === 'refund' ? 'trnRefund' : 'trnLoss';
			const row = this.host.db.trnBetOpenRow(ticket);
			if (!this.host.db.trnBetClose(ticket, this.host.now(), Math.max(0, Math.round(payout)), game)) return false;
			if (row) this.sendCoinsTo(row.accountId);
			return true;
		} catch (err) {
			this.host.log(`tournament bet ${ticket} not settled: ${(err as Error).message}`);
			return false;
		}
	}

	/** Send the totals again after the balance changed. */
	sendCoinsTo(accountId: number): void {
		for (const p of this.host.players()) if (p.accountId === accountId) this.sendCoins(p);
	}

	private sendCoins(p: EconomyPlayer): void {
		if (p.accountId === null) return;
		const row = this.host.db.accountStats(p.accountId);
		const recent: PointLogEntry[] = this.host.db.recentMoney(p.accountId, RECENT_AWARDS);
		this.host.send(p, { type: 'coins', total: row.pointsTotal, balance: row.pointsBalance, recent });
	}

	private sendMultiplier(to?: EconomyPlayer): void {
		const active = this.activePlayers();
		const msg: ServerMessage = { type: 'multiplier', mult: modeMultiplier(this.map.kind, active), active, need: MIN_ACTIVE[this.map.kind] ?? 0 };
		if (to) return this.host.send(to, msg);
		const key = `${msg.mult}:${msg.active}:${msg.need}`;
		if (key === this.lastMult) return;
		this.lastMult = key;
		this.host.broadcast(msg);
	}

	private hintGuest(p: EconomyPlayer): void {
		if (this.hinted.has(p.playerId)) return;
		if (this.hinted.size >= HINTS_MAX) this.hinted.clear();
		this.hinted.add(p.playerId);
		const text = 'Log in or register to earn coins for this.';
		this.host.send(p, { type: 'coinsNotice', text, tone: 'info' });
		this.host.systemTo(p, text);
	}

	// -----------------------------------------------------------------------
	// Mode handle

	/** The handle of a mode on the current map; it stops paying when the map changes. */
	forMode(): ModeEconomy {
		const session = this.session;
		const mode: GameModeId = this.map.kind;
		const need = (reason?: AwardReason) => Math.max(MIN_ACTIVE[mode] ?? 0, (reason && (AWARDS[reason] as AwardDef).minActive) ?? 0);
		const scope = (s: 'round' | 'session') => (s === 'round' ? session.round : session.whole);
		const read = (id: number, key: string, s: 'round' | 'session', what: keyof Tallies) => {
			const p = this.player(id);
			return p ? (scope(s)[what].get(`${personOf(p)}|${key}`) ?? 0) : 0;
		};
		return {
			award: (id, base, reason, opts = {}) => this.award(session, id, base, reason, need(reason), opts),
			activePlayers: () => this.activePlayers(),
			isActive: (id) => {
				const p = this.player(id);
				return !!p && this.isActive(p);
			},
			multiplier: () => this.multiplier(),
			enoughPlayers: (reason) => this.activePlayers() >= need(reason),
			roundStart: () => {
				if (!session.open) return;
				if (session.roundOpen) this.endRound(session);
				session.startRound(++this.rounds, this.host.clock());
				this.sayMinimum(need());
			},
			roundEnd: () => {
				if (session.open && session.roundOpen) this.endRound(session);
			},
			tally: (id, key, s) => {
				const p = this.player(id);
				if (!p) return 0;
				const k = `${personOf(p)}|${key}`;
				const n = (scope(s).counts.get(k) ?? 0) + 1;
				scope(s).counts.set(k, n);
				return n;
			},
			tallied: (id, key, s) => read(id, key, s, 'counts'),
			earned: (id, reason, s) => read(id, reason, s, 'earned'),
			sinceLastPaid: (id, reason) => {
				const accountId = this.player(id)?.accountId ?? null;
				const at = accountId === null ? null : this.host.db.lastPaid(accountId, reason, this.map.id);
				return at === null ? null : Math.max(0, this.host.now() - at);
			},
			paidWithin: (id, reason, ms, label) => {
				const accountId = this.player(id)?.accountId ?? null;
				return accountId === null ? 0 : this.host.db.countPaid(accountId, reason, this.map.id, this.host.now() - ms, label);
			},
			contact: (by, target) => this.contact(session, by, target),
			report: (signal, ids, evidence) => this.report(session, signal, ids, evidence),
			teleported: (id) => {
				const p = this.player(id);
				if (p) this.activities.get(p)?.expectTeleport(this.host.clock());
			},
			acted: (id) => {
				const p = this.player(id);
				if (p && !p.spectating) this.activities.get(p)?.acted();
			},
			betOpen: (accountId, stake) => this.betOpen(accountId, stake),
			betClose: (ticket, payout, outcome) => this.betClose(ticket, payout, outcome)
		};
	}

	/** Why a round pays nothing: too few active players. */
	private sayMinimum(need: number): void {
		const active = this.activePlayers();
		if (active >= need) return;
		const text = `No coins right now: this mode needs ${need} active players (${active} now).`;
		for (const p of this.host.players()) this.host.systemTo(p, text);
	}

	private award(session: Session, id: number, base: number, reason: AwardReason, need: number, opts: AwardOptions): AwardResult {
		const no = (refused: AwardRefusal): AwardResult => ({ paid: 0, refused });
		const def: AwardDef = AWARDS[reason];
		const p = this.player(id);
		const a = p && this.activities.get(p);
		if (!p || !a || !session.open) return no('gone');
		if (!Number.isFinite(base) || base <= 0) return no('nothing');
		base = Math.round(base);
		if (p.spectating) return no('spectating');
		if (a.still) return no('afk');
		const active = this.activePlayers();
		if (active < need) return no('minPlayers');
		if (a.suspect(this.host.clock())) return no('suspect');

		const person = personOf(p);
		const key = `${person}|${reason}`;
		const inRound = session.round.earned.get(key) ?? 0;
		const inSession = session.whole.earned.get(key) ?? 0;
		base = Math.min(base, (def.perRound ?? Infinity) - inRound, (def.perSession ?? Infinity) - inSession);
		if (base <= 0) return no('cap');
		if (p.accountId === null) {
			this.hintGuest(p);
			return no('guest');
		}
		const other = opts.against === undefined ? null : this.player(opts.against);
		if (this.abuse.paused(p.accountId, other?.accountId ?? null)) return no('paused');
		const r = this.pay(p, p.accountId, base, reason, modeMultiplier(this.map.kind, active), def, opts.label ?? def.label);
		if (r.paid === 0) return r;
		session.round.earned.set(key, inRound + r.base);
		session.whole.earned.set(key, inSession + r.base);
		if (other && other !== p) this.attribute(session, p, p.accountId, other, def, r.base, active);
		return r.refused ? { paid: r.paid, refused: r.refused } : { paid: r.paid };
	}

	/** Remember who the award was earned against, for the round's checks. */
	private attribute(session: Session, p: EconomyPlayer, accountId: number, other: EconomyPlayer, def: AwardDef, base: number, active: number): void {
		const from = personOf(other);
		const list = this.paidAt.get(accountId);
		if (list?.length) list[list.length - 1]!.from = from;
		if (!session.roundOpen) return;
		session.minActive = Math.min(session.minActive, active);
		let e = session.earners.get(personOf(p));
		if (!e) session.earners.set(personOf(p), (e = { accountId, name: p.name, pair: new Map(), from: new Map() }));
		if (def.pair) e.pair.set(from, (e.pair.get(from) ?? 0) + base);
		const f = e.from.get(from);
		const sameIp = p.ip !== null && other.ip !== null && ipKey(p.ip) === ipKey(other.ip);
		if (f) f.base += base;
		else e.from.set(from, { base, name: other.name, accountId: other.accountId, sameIp, activity: this.activities.get(other) ?? null });
	}

	// -----------------------------------------------------------------------
	// Abuse signals

	private signal(
		signal: AbuseSignal,
		round: number,
		accounts: { accountId: number; weight?: number }[],
		involved: (number | null)[],
		evidence: string
	): void {
		if (accounts.length === 0) return;
		this.abuse.report({ signal, round, accounts, involved: involved.filter((i): i is number => i !== null), evidence });
	}

	private endRound(session: Session): void {
		session.roundOpen = false;
		const enough = session.minActive >= ABUSE.pairActive && this.activePlayers() >= ABUSE.pairActive;
		const fed = new Set<string>();
		for (const [person, e] of session.earners) {
			if (e.pair.size > 0) {
				const rounds = this.pairRounds.get(e.accountId) ?? [];
				rounds.push({ shares: e.pair, enough });
				if (rounds.length > ABUSE.pairRounds) rounds.shift();
				this.pairRounds.set(e.accountId, rounds);
				const top = concentration(rounds);
				if (top) {
					this.pairRounds.delete(e.accountId);
					const other = e.from.get(top.from);
					this.signal(
						'concentration',
						session.roundId,
						[{ accountId: e.accountId }],
						[e.accountId, other?.accountId ?? null],
						`${Math.round(top.share * 100)}% of ${formatTenths(top.total)} chase and view points from ${other?.name ?? 'one player'}`
					);
				}
			}
			for (const [from, f] of e.from) {
				const idle = f.activity !== null && f.activity.lastInputAt <= session.roundAt;
				if (!f.sameIp || !idle || f.base < ABUSE.feedMin) continue;
				const key = `${person}|${from}`;
				fed.add(key);
				const n = (this.feeds.get(key) ?? 0) + 1;
				this.feeds.set(key, n);
				if (n < ABUSE.feedRounds) continue;
				this.feeds.delete(key);
				const accounts = [{ accountId: e.accountId }, ...(f.accountId !== null ? [{ accountId: f.accountId }] : [])];
				this.signal('ipFeed', session.roundId, accounts, [e.accountId, f.accountId], `${n} rounds in a row fed by ${f.name}, who never acted, from the same network`);
			}
		}
		for (const key of [...this.feeds.keys()]) if (!fed.has(key)) this.feeds.delete(key);
		session.earners.clear();
	}

	private contact(session: Session, byId: number, targetId: number): void {
		const a = this.player(byId);
		const b = this.player(targetId);
		if (!session.open || !a || !b || a === b) return;
		const now = this.host.now();
		const key = [personOf(a), personOf(b)].sort().join('|');
		const times = (this.contacts.get(key) ?? []).filter((t) => now - t < ABUSE.contactMs);
		times.push(now);
		this.contacts.set(key, times);
		if (times.length < ABUSE.contactCount || this.activePlayers() < ABUSE.pairActive) return;
		this.contacts.delete(key);
		const accounts = [a, b].flatMap((p) => (p.accountId !== null ? [{ accountId: p.accountId }] : []));
		this.signal('contact', session.roundId, accounts, [a.accountId, b.accountId], `${a.name} and ${b.name} met ${times.length} times within 60 s`);
	}

	private report(session: Session, signal: 'shadow' | 'impossible', ids: readonly number[], evidence: string): void {
		if (!session.open) return;
		const [a, b] = ids.map((id) => this.player(id));
		if (!a) return;
		if (signal === 'impossible') {
			if (a.accountId !== null) this.signal('impossible', session.roundId, [{ accountId: a.accountId }], [a.accountId], evidence);
			return;
		}
		if (!b) return;
		// Only while it pays: the target earned something from this hunter just now.
		const now = this.host.now();
		const earned = b.accountId !== null && (this.paidAt.get(b.accountId) ?? []).some((e) => now - e.at <= EARNED_LATELY_MS && e.from === personOf(a));
		if (!earned) return;
		const accounts = [
			...(a.accountId !== null ? [{ accountId: a.accountId }] : []),
			// The target may just be unlucky with its hunter: half the weight.
			...(b.accountId !== null ? [{ accountId: b.accountId, weight: 1 }] : [])
		];
		this.signal('shadow', session.roundId, accounts, [a.accountId, b.accountId], `${a.name} stayed next to ${b.name}: ${evidence}`);
	}

	private macro(p: EconomyPlayer, inputs: number, different: number): void {
		if (p.accountId === null) return;
		const now = this.host.now();
		const paid = (this.paidAt.get(p.accountId) ?? []).filter((e) => now - e.at < ABUSE.macroMs);
		const half = now - ABUSE.macroMs / 2;
		if (!paid.some((e) => e.at < half) || !paid.some((e) => e.at >= half)) return;
		this.signal('macro', this.session.roundId, [{ accountId: p.accountId }], [p.accountId], `${inputs} inputs in 10 min, ${different} different ones`);
	}

	private nameOf(accountId: number): string {
		return this.host.db.accountById(accountId)?.username ?? `account ${accountId}`;
	}

	private logAbuse(accountId: number, action: AbuseRow['action'], strikes: number, evidence: string): void {
		const username = this.nameOf(accountId);
		this.host.log(`abuse ${action} account ${accountId} ${username} strikes=${strikes}: ${evidence}`);
		try {
			this.host.db.logAbuse({ createdAt: this.host.now(), accountId, username, action, strikes, evidence });
		} catch (err) {
			this.host.log(`abuse log failed: ${(err as Error).message}`);
		}
	}

	private warn(accountId: number, strikes: number, evidence: string): void {
		this.logAbuse(accountId, 'warning', strikes, evidence);
		const text = 'Your coins are paused for 5 minutes: this looks like point farming. Play normally and nothing else happens; if it continues you are banned for 5 minutes.';
		for (const p of this.host.players()) {
			if (p.accountId !== accountId) continue;
			this.host.send(p, { type: 'coinsNotice', text, tone: 'warn' });
			this.host.systemTo(p, text);
		}
		this.host.abuseLogged();
	}

	private ban(accountId: number, strikes: number, evidence: string, exempt: boolean): void {
		this.logAbuse(accountId, exempt ? 'exempt' : 'ban', strikes, evidence);
		if (!exempt) this.bans.push(accountId);
		this.host.abuseLogged();
	}

	/**
	 * Bans wait for the next tick: a signal can come up inside a mode's own code
	 * (an award, a round end), where a kick would call back into the mode.
	 */
	private carryOutBans(): void {
		for (const accountId of this.bans.splice(0)) {
			try {
				this.host.ban(accountId, BAN_REASON, ABUSE.banMs);
			} catch (err) {
				this.host.log(`automatic ban failed: ${(err as Error).message}`);
			}
		}
	}
}

/** One map session of one mode. */
class Session {
	open = true;
	whole = newTallies();
	round = newTallies();
	roundOpen = false;
	roundId = 0;
	roundAt = -Infinity;
	minActive = Infinity;
	readonly earners = new Map<string, RoundEarner>();

	startRound(id: number, at: number): void {
		this.round = newTallies();
		this.roundOpen = true;
		this.roundId = id;
		this.roundAt = at;
		this.minActive = Infinity;
		this.earners.clear();
	}
}

/**
 * The one account most pair points of the last rounds came from, when that is
 * suspicious: every round with enough players, the same account in each of
 * them, enough points at all, and more than `pairShare` of them.
 */
function concentration(rounds: readonly { shares: Map<string, number>; enough: boolean }[]): { from: string; share: number; total: number } | null {
	if (rounds.length < ABUSE.pairRounds || rounds.some((r) => !r.enough)) return null;
	let total = 0;
	const sums = new Map<string, number>();
	for (const r of rounds)
		for (const [from, base] of r.shares) {
			total += base;
			sums.set(from, (sums.get(from) ?? 0) + base);
		}
	if (total < ABUSE.pairMin) return null;
	for (const [from, sum] of sums) {
		if (sum / total > ABUSE.pairShare && rounds.every((r) => r.shares.has(from))) return { from, share: sum / total, total };
	}
	return null;
}
