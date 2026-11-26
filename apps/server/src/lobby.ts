/**
 * Lobby: connections, relay, chat, spectating and map rotation
 * (docs/architecture.md, docs/gameplay.md). Gamemode rules (race timer and
 * run validation, tag rounds) and scoreboard rows live in ./modes
 * (docs/modes.md); the lobby itself is mode-agnostic.
 */
import { performance } from 'node:perf_hooks';
import type { WebSocket } from 'ws';
import type {
	ClientMessage,
	Cvars,
	Loadout,
	MapDef,
	MapRecordInfo,
	NetState,
	PlayerInfo,
	RotationEvent,
	ScoreRow,
	ServerMessage,
	RichEntry,
	SnapshotEntry,
	Vec3,
	VoteOption
} from '@surf/shared';
import {
	CLOSE_IP_LIMIT,
	emptyLoadout,
	isEmptyLoadout,
	mapTitle,
	encodeSnapshot,
	decodeState,
	FLAG_TELEPORTED,
	teleportSeq,
	withTeleportSeq,
	isRaceMode,
	mapCvars as sharedMapCvars,
	MapRotation,
	MAX_CHAT,
	MAX_NAME,
	MAX_PLAYERS,
	MAX_REWIND_RTT_MS,
	MAX_VELOCITY_HARD,
	modeOf,
	POINTS_SCALE,
	PROTOCOL_VERSION,
	CLOSE_PROTOCOL_MISMATCH,
	RICHEST,
	sanitizeText,
	SNAPSHOT_HZ,
	SnapshotTimeline,
	snapshotSampleTimeMs,
	TAG_TICK_HZ,
	usernameKey
} from '@surf/shared';
import { AccountStats, PLAYTIME_FLUSH_MS } from './account-stats.ts';
import { AdminController, ipKey, parseAdminUsernames } from './admin.ts';
import { Accounts, AttemptLimiter, AUTH_LIMITS, TOO_MANY } from './auth.ts';
import { Casino } from './casino.ts';
import { HELP_LINES, parseCommand } from './commands.ts';
import type { AccountRow, BanRow, Db } from './db.ts';
import { Economy } from './economy.ts';
import { TickScheduler } from './scheduler.ts';
import type { LobbyMetricsHooks } from './metrics.ts';
import { Shop } from './shop.ts';
import { isClientTransport, WsClientTransport, type ClientTransport } from './transport.ts';
import { createServerMode, type ModeHost, type ModeOptions, type ServerMode } from './modes/index.ts';
import { observeRenderTime } from './modes/types.ts';
import { PeerRtt } from './peer-rtt.ts';
import { JUMP_SLACK, mapTeleport, nearPose, type ZoneKind } from './validation.ts';

export { SNAPSHOT_HZ };
/** Gamemode rule ticks (tag contact checks), at least the snapshot rate. */
export const MODE_TICK_HZ = TAG_TICK_HZ;
export const SCOREBOARD_MS = 1000;
export const ROTATION_MS = 100;
export const PING_MS = 500;
const PONG_TIMEOUT_MS = 10_000;
const CLIENT_IDLE_TIMEOUT_MS = 10_000;
export const TIME_LEFT_MS = 5000;
export const HELLO_TIMEOUT_MS = 5_000;
/** Maximum open sockets awaiting `hello` (separate from the 32 player slots). */
export const MAX_PENDING_CONNECTIONS = 16;
export const DEFAULT_MAX_PENDING_PER_IP = 4;

/** Parse an optional SNAPSHOT_HZ setting (default 32; 64 supported for lower latency on good links). */
export function parseSnapshotHz(raw: string | number | undefined): number {
	const n = typeof raw === 'number' ? raw : Number(raw);
	return Number.isFinite(n) && n >= 1 && n <= 128 ? Math.round(n) : SNAPSHOT_HZ;
}

/** Per-second limits: above `limit` messages are dropped, above `kick` the client is kicked. */
export const RATE = {
	state: { limit: 70, kick: 250 },
	spawnAck: { limit: 12, kick: 40 },
	chat: { limit: 2, kick: 20 },
	json: { limit: 60, kick: 300 },
	shop: { limit: 8, kick: 100 },
	casino: { limit: 5, kick: 100 },
	/** Zombie Defense actions (repair hold, shop, pads, ready, weapon swap). */
	zd: { limit: 20, kick: 200 }
} as const;

export interface LobbyOptions {
	maps: MapDef[];
	db: Db;
	/** Map to start on; defaults to the first map. */
	initialMap?: string;
	/** Wall clock in ms, used for rotation and run timing (injectable for tests). */
	now?: () => number;
	rng?: () => number;
	/** Casino rolls (default node:crypto; tests). */
	casinoRandom?: () => number;
	/** Monotonic clock in ms for account playtime (default: `now` when injected, else performance.now). */
	playClock?: () => number;
	/** Start interval timers (snapshot, scoreboard, rotation, ping). Default true. */
	timers?: boolean;
	/** Snapshot send rate in Hz (default SNAPSHOT_HZ = 32; 64 supported). */
	snapshotHz?: number;
	maxPlayers?: number;
	/** Pre-hello WebSocket connections allowed (separate from `maxPlayers`). Default 16. */
	maxPending?: number;
	/** Pending sockets per IP. 0 disables the per-IP cap. */
	maxPendingPerIp?: number;
	/** Close sockets that do not send `hello` within this many ms. Default 5000. */
	helloTimeoutMs?: number;
	/** Connected players per IP. 0 disables the per-IP cap. */
	maxPerIp?: number;
	/** Optional runtime metrics hooks (/metrics). */
	metrics?: LobbyMetricsHooks;
	log?: (msg: string) => void;
	/** Seconds per map (default MAP_DURATION); dev testing only, see server.ts. */
	mapDuration?: number;
	/** Seconds after map start before !rtv is allowed (default RTV_BLOCK). */
	rtvBlock?: number;
	/** Gamemode tuning (tests: shorter tag rounds). */
	modes?: ModeOptions;
	/** Admin account usernames, case-insensitive (default: none). */
	adminUsernames?: string[];
}

class Window {
	private start = 0;
	count = 0;
	/** Count one message; returns the count in the current 1 s window. */
	hit(t: number): number {
		if (t - this.start >= 1000) {
			this.start = t;
			this.count = 0;
		}
		return ++this.count;
	}
}

interface Client {
	transport: ClientTransport;
	id: number;
	playerId: string;
	name: string;
	/** Logged-in account (docs/gameplay.md#accounts-and-identity), null for guests. */
	accountId: number | null;
	/** SHA-256 of this connection's session token (for logout). */
	sessionHash: string | null;
	/** Name to fall back to on logout (hello name or last guest rename). */
	guestName: string;
	/** A register/login is being hashed; further auth messages are refused until it ends. */
	authBusy: boolean;
	loginFails: AttemptLimiter;
	registers: AttemptLimiter;
	/** "Log in to save runs" was shown on this connection. */
	guestHinted: boolean;
	/** Client IP for guest bans (admin.ts clientIp), null when unknown. */
	ip: string | null;
	/** Logged in with an admin account (docs/gameplay.md#admin); decided by the server only. */
	admin: boolean;
	helloed: boolean;
	spectating: boolean;
	targetId: number | null;
	state: NetState | null;
	relay: { timeline: SnapshotTimeline; sample: { state: NetState; at: number } | null } | null;
	pendingSpawn: Vec3 | null;
	spawnAt: number;
	spawnSeq: number;
	spawnFrame: string | null;
	spawnSentAt: number;
	clientTeleportSeq: number;
	relayTeleportSeq: number;
	readonly hasRttSample: boolean;
	ping: number;
	rtt: PeerRtt;
	lastPongAt: number;
	lastMessageAt: number;
	/** Worn cosmetics (docs/economy.md#shop); the default look for guests. */
	loadout: Loadout;
	rate: { state: Window; spawnAck: Window; chat: Window; json: Window; shop: Window; casino: Window; zd: Window };
	helloTimer: NodeJS.Timeout | null;
	closed: boolean;
}

const ZONE_KINDS = new Set<ZoneKind>(['start', 'stage', 'checkpoint', 'end']);
const SPAWN_RETRY_MS = 250;
const PLAYER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Full cvars for a map: its gamemode's profile, then the map's overrides. */
export function mapCvars(map: MapDef): Cvars {
	return sharedMapCvars(map);
}

export class Lobby {
	readonly clients = new Set<Client>();
	readonly rotation: MapRotation;
	private readonly maps: Map<string, MapDef>;
	private readonly db: Db;
	private readonly now: () => number;
	/** Monotonic server clock (ms) stamped into snapshots (injectable via playClock/now for tests). */
	private readonly serverClock: () => number;
	private readonly snapHz: number;
	private snapshotSeq = 0;
	readonly maxPlayers: number;
	private readonly maxPending: number;
	private readonly maxPendingPerIp: number;
	private readonly helloTimeoutMs: number;
	private readonly maxPerIp: number;
	private readonly metrics?: LobbyMetricsHooks;
	private readonly log: (msg: string) => void;
	private readonly loginFailsByIp = new AttemptLimiter(AUTH_LIMITS.loginFailsPerConnection * 2);
	private readonly registersByIp = new AttemptLimiter(AUTH_LIMITS.registersPerConnection * 2);
	private map: MapDef;
	private scheduler: TickScheduler | null = null;
	private lastTimeLeftSent = 0;
	private closing = false;
	private mode: ServerMode;
	private readonly modeOptions: ModeOptions;
	private readonly rng: () => number;
	private readonly accounts: Accounts;
	/** Points, coins and abuse detection (docs/economy.md). */
	readonly economy: Economy;
	/** Cosmetics: purchases and worn items (docs/economy.md#shop). */
	private readonly shop: Shop<Client>;
	/** Casino: rolls, bets and payouts (docs/economy.md#casino). */
	readonly casino: Casino<Client>;
	/** Playtime and points of the accounts online (docs/gameplay.md#points-and-playtime). */
	readonly stats: AccountStats;
	readonly admin: AdminController<Client>;
	/** Who started the open RTV request (name kept if they leave). */
	private rtvInitiator: { id: number; name: string } | null = null;

	constructor(opts: LobbyOptions) {
		if (opts.maps.length === 0) {
			throw new Error('No maps available: @surf/shared exports no MAPS (map module not implemented yet?)');
		}
		this.maps = new Map(opts.maps.map((m) => [m.id, m]));
		this.db = opts.db;
		this.now = opts.now ?? Date.now;
		this.maxPlayers = opts.maxPlayers ?? MAX_PLAYERS;
		this.maxPending = opts.maxPending ?? MAX_PENDING_CONNECTIONS;
		this.maxPendingPerIp = opts.maxPendingPerIp ?? 0;
		this.helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
		this.maxPerIp = opts.maxPerIp ?? 0;
		this.metrics = opts.metrics;
		this.log = opts.log ?? ((m) => console.log(m));
		this.accounts = new Accounts(this.db, () => this.now());
		this.stats = new AccountStats(this.db, opts.playClock ?? opts.now, this.log);
		const initial = opts.initialMap && this.maps.has(opts.initialMap) ? opts.initialMap : opts.maps[0].id;
		this.map = this.maps.get(initial)!;
		this.rng = opts.rng ?? Math.random;
		this.modeOptions = opts.modes ?? {};
		this.admin = this.createAdmin(opts.adminUsernames ?? parseAdminUsernames(undefined));
		const clock = opts.playClock ?? opts.now ?? (() => performance.now());
		this.serverClock = clock;
		this.snapHz = parseSnapshotHz(opts.snapshotHz);
		this.economy = this.createEconomy(clock);
		this.shop = new Shop<Client>({
			db: this.db,
			economy: () => this.economy,
			send: (p, m) => this.send(p, m),
			broadcast: (m) => this.broadcast(m),
			system: (text) => this.system(text),
			now: () => this.now(),
			log: this.log
		});
		const lobby = this;
		this.casino = new Casino<Client>(
			{
				db: this.db,
				now: () => this.now(),
				clock,
				*players() {
					for (const c of lobby.clients) if (c.helloed) yield c;
				},
				send: (p, m) => this.send(p, m),
				broadcast: (m) => this.broadcast(m),
				system: (text) => this.system(text),
				balance: (accountId) => this.economy.sendCoinsTo(accountId),
				log: this.log
			},
			opts.casinoRandom
		);
		this.mode = this.createMode();
		this.rotation = new MapRotation({
			isEnabled: (id) => this.admin.isEnabled(id),
			kindOf: (id) => this.maps.get(id)?.kind ?? '',
			maps: [...this.maps.keys()],
			current: initial,
			now: this.now(),
			rng: opts.rng,
			mapDuration: opts.mapDuration,
			rtvBlock: opts.rtvBlock
		});
		this.lastTimeLeftSent = this.now();
		if (opts.timers !== false) {
			const loopHz = Math.max(MODE_TICK_HZ, this.snapHz);
			const tickMs = 1000 / loopHz;
			const modeStepMs = 1000 / MODE_TICK_HZ;
			const snapStepMs = 1000 / this.snapHz;
			let modeAcc = 0;
			let snapAcc = 0;
			this.scheduler = new TickScheduler({
				hz: loopHz,
				onTick: () => {
					// Run mode tick before snapshot send on shared ticks so freshly
					// processed states and mode changes land in the immediate snapshot.
					modeAcc += tickMs;
					if (modeAcc + 0.001 >= modeStepMs) {
						modeAcc -= modeStepMs;
						this.tickMode();
					}
					snapAcc += tickMs;
					if (snapAcc + 0.001 >= snapStepMs) {
						snapAcc -= snapStepMs;
						this.sendSnapshot();
					}
				},
				periodic: [
					{ everyMs: ROTATION_MS, run: () => this.updateRotation() },
					{ everyMs: SCOREBOARD_MS, run: () => this.sendScoreboard() },
					{ everyMs: PING_MS, run: () => this.sendPings() },
					{ everyMs: PLAYTIME_FLUSH_MS, run: () => this.stats.flush() }
				]
			});
			this.scheduler.start();
		}
	}

	/** Active snapshot broadcast rate (Hz). */
	get snapshotHz(): number {
		return this.snapHz;
	}

	get currentMap(): MapDef {
		return this.map;
	}

	/** The current map's gamemode module. */
	get gameMode(): ServerMode {
		return this.mode;
	}

	/** Advance gamemode rules (timer-driven at MODE_TICK_HZ; public for tests). */
	tickMode(): void {
		this.metrics?.recordModeTick();
		this.mode.tick();
		this.economy.tick();
		this.casino.tick();
		this.shop.tick();
	}

	private createEconomy(clock: () => number): Economy {
		const lobby = this;
		return new Economy(
			{
				db: this.db,
				now: () => this.now(),
				clock,
				*players() {
					for (const c of lobby.clients) if (c.helloed) yield c;
				},
				send: (p, msg) => this.send(p as Client, msg),
				broadcast: (msg) => this.broadcast(msg),
				systemTo: (p, text) => this.systemTo(p as Client, text),
				totals: (accountId, pointsTotal) => this.stats.setPoints(accountId, pointsTotal),
				isAdmin: (accountId) => this.admin.isAdminAccount(this.db.accountById(accountId)?.username),
				ban: (accountId, reason, ms) => this.admin.autoBan(accountId, reason, ms),
				abuseLogged: () => this.admin.pushState(),
				log: (msg) => this.log(msg),
				stillness: (p) => this.mode.stillness?.(p as Client) ?? null
			},
			this.map
		);
	}

	private createMode(): ServerMode {
		const lobby = this;
		const map = this.map;
		const host: ModeHost = {
			map,
			db: this.db,
			economy: this.economy.forMode(),
			now: () => this.now(),
			serverNow: () => this.serverClock(),
			replaySaved: (mapId) => {
				if (!this.closing && this.map.id === mapId) this.mode.replayChanged?.();
			},
			rng: () => this.rng(),
			*players() {
				for (const c of lobby.clients) if (c.helloed) yield c;
			},
			send: (p, msg) => {
				this.economy.sent(p as Client, msg);
				this.send(p as Client, msg);
			},
			broadcast: (msg, exceptId) => this.broadcast(msg, exceptId),
			sendBinary: (p, data) => this.sendRaw(p as Client, Buffer.from(data), true),
			broadcastBinary: (data, droppable = false) => {
				const buf = Buffer.from(data);
				for (const c of this.clients) if (c.helloed) this.sendRaw(c, buf, !droppable);
			},
			system: (text) => this.system(text),
			systemTo: (p, text) => this.systemTo(p as Client, text),
			guestRunNotice: (p, text) => {
				const c = p as Client;
				this.systemTo(c, c.guestHinted ? text : `${text} Log in to save runs to the leaderboard.`);
				c.guestHinted = true;
			},
			log: (msg) => this.log(msg)
		};
		return createServerMode(host, this.modeOptions);
	}

	private createAdmin(usernames: string[]): AdminController<Client> {
		return new AdminController<Client>(
			{
				db: this.db,
				maps: [...this.maps.values()],
				clients: () => this.clients,
				send: (c, msg) => this.send(c, msg),
				broadcast: (msg) => this.broadcast(msg),
				system: (text) => this.system(text),
				log: (msg) => this.log(msg),
				forceMap: (id) => {
					const ev = this.rotation.forceMap(id, this.now());
					if (ev) this.handleRotation([ev]);
					return !!ev;
				},
				extend: (secs) => {
					const ev = this.rotation.extendBy(secs, this.now());
					if (!ev) return 'Not during a vote or a pending map change.';
					this.handleRotation([ev]);
					return null;
				},
				adjustCoins: (accountId, amount) => this.economy.adjust(accountId, amount),
				giveItem: (c, item) => this.shop.give(c, item, Date.now()),
				takeItem: (c, item) => this.shop.take(c, item),
				kickBanned: (c, ban) => this.kickBanned(c, ban)
			},
			usernames,
			() => this.now()
		);
	}

	private bannedMessage(ban: BanRow): ServerMessage {
		const seconds = this.admin.secondsLeft(ban);
		return { type: 'banned', reason: ban.reason, ...(seconds === undefined ? {} : { seconds }) };
	}

	/** `banned` message, then close 4009 (the client stops reconnecting until reload, or until the ban lifts). */
	private kickBanned(c: Client, ban: BanRow): void {
		this.log(`banned #${c.id} ${c.name}`);
		this.send(c, this.bannedMessage(ban));
		c.transport.close(4009, 'banned');
		this.onClose(c);
	}

	/**
	 * Guest display name: names of registered accounts (case-insensitive) are
	 * reserved, so a guest cannot pose as an account (or an admin).
	 */
	private guestNameFor(raw: string, playerId: string): { name: string; taken: boolean } {
		const name = cleanName(raw);
		if (!this.db.accountByName(name)) return { name, taken: false };
		let fallback = `Guest-${playerId.replace(/[^A-Za-z0-9]/g, '').slice(0, 4)}`;
		while (this.db.accountByName(fallback)) fallback = `Guest-${Math.floor(10000 + this.rng() * 90000)}`;
		return { name: fallback, taken: true };
	}

	/** Unknown addresses share one bucket, separate from any visitor IP. */
	private countFromIp(ip: string | null, helloed: boolean): number {
		const key = ip === null ? null : ipKey(ip);
		let n = 0;
		for (const c of this.clients) {
			if (c.helloed === helloed && (c.ip === null ? null : ipKey(c.ip)) === key) n++;
		}
		return n;
	}

	get playerCount(): number {
		let n = 0;
		for (const c of this.clients) if (c.helloed) n++;
		return n;
	}

	/** Open sockets that have not completed `hello` yet. */
	get pendingCount(): number {
		let n = 0;
		for (const c of this.clients) if (!c.helloed) n++;
		return n;
	}

	/** Largest WebSocket send queue across all connected sockets (bytes). */
	maxBufferedBytes(): number {
		let max = 0;
		for (const c of this.clients) {
			if (c.transport.bufferedAmount > max) max = c.transport.bufferedAmount;
		}
		return max;
	}

	close(): void {
		this.closing = true;
		this.scheduler?.stop();
		this.scheduler = null;
		this.stats.close();
		this.economy.close();
		for (const c of this.clients) {
			if (c.helloTimer) clearTimeout(c.helloTimer);
			c.helloTimer = null;
			c.transport.close(1001, 'server shutting down');
		}
	}

	// -----------------------------------------------------------------------
	// Connections

	/** Called synchronously before the HTTP upgrade. */
	upgradeStatus(ip: string | null): 503 | 429 | null {
		if (this.closing || this.pendingCount >= this.maxPending) return 503;
		if (this.maxPendingPerIp > 0 && this.countFromIp(ip, false) >= this.maxPendingPerIp) return 429;
		return null;
	}

	/** `ip`: client IP for guest bans (admin.ts clientIp), null when unknown. */
	handleConnection(conn: WebSocket | ClientTransport, ip: string | null = null): void {
		const transport = isClientTransport(conn) ? conn : new WsClientTransport(conn);

		const status = this.upgradeStatus(ip);
		if (status !== null) {
			if (this.closing) transport.close(1001, 'server shutting down');
			else if (status === 429) transport.close(CLOSE_IP_LIMIT, 'too many pending connections');
			else {
				transport.sendReliable(JSON.stringify({ type: 'full' } satisfies ServerMessage));
				transport.close(4003, 'server full');
			}
			return;
		}
		const c: Client = {
			transport,
			id: this.freeId(),
			playerId: '',
			name: '',
			accountId: null,
			sessionHash: null,
			guestName: '',
			authBusy: false,
			loginFails: new AttemptLimiter(AUTH_LIMITS.loginFailsPerConnection),
			registers: new AttemptLimiter(AUTH_LIMITS.registersPerConnection),
			guestHinted: false,
			ip,
			admin: false,
			helloed: false,
			spectating: false,
			targetId: null,
			state: null,
			relay: null,
			pendingSpawn: null,
			spawnAt: 0,
			spawnSeq: 0,
			spawnFrame: null,
			spawnSentAt: 0,
			clientTeleportSeq: 0,
			relayTeleportSeq: 0,
			get hasRttSample() {
				return this.rtt.sample(performance.now()) !== null;
			},
			get ping() {
				return Math.min(MAX_REWIND_RTT_MS, this.rtt.estimate(performance.now()));
			},
			rtt: new PeerRtt(),
			lastPongAt: 0,
			lastMessageAt: 0,
			loadout: emptyLoadout(),
			rate: { state: new Window(), spawnAck: new Window(), chat: new Window(), json: new Window(), shop: new Window(), casino: new Window(), zd: new Window() },
			helloTimer: null,
			closed: false
		};
		c.helloTimer = setTimeout(() => transport.terminate(), this.helloTimeoutMs);
		this.clients.add(c);
		transport.onMessage((data, isBinary) => {
			try {
				this.onMessage(c, data, isBinary);
			} catch (err) {
				this.log(`error handling message from #${c.id}: ${(err as Error).message}`);
			}
		});
		transport.onPong?.((challenge) => {
			const now = performance.now();
			if (c.helloed && c.rtt.pong(challenge, now) !== null) c.lastPongAt = now;
		});
		transport.onClose(() => this.onClose(c));
		transport.onError(() => transport.terminate());
		this.send(c, { type: 'serverIdentity', serverId: this.db.serverId });
	}

	private freeId(): number {
		const used = new Set([...this.clients].map((c) => c.id));
		let id = 1;
		while (used.has(id)) id++;
		return id;
	}

	private onClose(c: Client): void {
		if (c.closed) return;
		c.closed = true;
		if (c.helloTimer) clearTimeout(c.helloTimer);
		this.clients.delete(c);
		if (c.accountId !== null) this.stats.leave(c.accountId, c);
		if (!c.helloed || this.closing) return;
		if (c.accountId !== null) this.economy.leaveAccount(c.accountId, c);
		this.mode.leave(c);
		this.economy.leave(c);
		this.shop.announce(c);
		this.rotation.removeVoter(String(c.id));
		this.db.touch(c.playerId, Date.now());
		this.broadcast({ type: 'leave', id: c.id });
		this.system(`${c.name} left.`);
		this.log(`leave #${c.id} ${c.name}`);
		for (const o of this.clients) {
			if (o.spectating && o.targetId === c.id) o.targetId = null;
		}
		this.admin.pushState();
	}

	private kick(c: Client, reason: string): void {
		this.log(`kick #${c.id} ${c.name}: ${reason}`);
		c.transport.close(4008, reason);
		c.transport.terminate();
	}

	private onMessage(c: Client, data: Buffer, isBinary: boolean): void {
		if (!c.transport.open) return;
		const t = performance.now();
		if (isBinary) {
			const n = c.rate.state.hit(t);
			if (n > RATE.state.kick) return this.kick(c, 'state flood');
			if (n > RATE.state.limit || !c.helloed || c.spectating) return;
			const received = decodeState(data);
			if (!received) return;
			const s = this.combatState(c, received);
			if (!s) return;
			c.state = s;
			c.lastMessageAt = t;
			if (s.renderServerTimeMs !== undefined) observeRenderTime(s.renderServerTimeMs, this.serverClock(), c);
			this.economy.state(c, received);
			this.mode.state(c, s);
			return;
		}
		const n = c.rate.json.hit(t);
		if (n > RATE.json.kick) return this.kick(c, 'message flood');
		if (n > RATE.json.limit) return;
		let msg: ClientMessage;
		try {
			msg = JSON.parse(data.toString('utf8'));
		} catch {
			return;
		}
		if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
		if (!c.helloed) {
			if (msg.type === 'hello') this.onHello(c, msg);
			return;
		}
		c.lastMessageAt = t;
		switch (msg.type) {
			case 'spawnAck': {
				const k = c.rate.spawnAck.hit(t);
				if (k > RATE.spawnAck.kick) return this.kick(c, 'spawn ack flood');
				if (k <= RATE.spawnAck.limit && c.spawnFrame && msg.seq === c.spawnSeq) c.spawnFrame = null;
				return;
			}
			case 'zone':
				return this.onZone(c, msg);
			case 'chat': {
				const k = c.rate.chat.hit(t);
				if (k > RATE.chat.kick) return this.kick(c, 'chat flood');
				if (k > RATE.chat.limit) return;
				if (typeof msg.text === 'string') this.onChat(c, msg.text);
				return;
			}
			case 'vote':
				if (typeof msg.option === 'number') this.handleRotation(this.rotation.castVote(String(c.id), msg.option, this.now()));
				return;
			case 'rtv':
				return this.doRtv(c, null);
			case 'rtvRequest':
				return this.doRtv(c, typeof msg.mapId === 'string' ? msg.mapId : null);
			case 'rtvVote':
				if (typeof msg.yes === 'boolean') this.doRtvVote(c, msg.yes);
				return;
			case 'changeMap':
				if (typeof msg.mapId === 'string') this.lonePlayerChangeMap(c, msg.mapId);
				return;
			case 'spectate':
				if (msg.targetId === null) this.setSpectate(c, false, null);
				else if (typeof msg.targetId === 'number') this.setSpectate(c, true, msg.targetId);
				return;
			case 'name':
				if (typeof msg.name === 'string') this.rename(c, msg.name);
				return;
			case 'register':
			case 'login':
				void this.onCredentials(c, msg).catch((err) => {
					c.authBusy = false;
					this.log(`auth error #${c.id}: ${(err as Error).message}`);
				});
				return;
			case 'logout':
				return this.logout(c);
			case 'getGhost':
				if (typeof msg.map === 'string') this.mode.ghost?.(c, msg.map);
				return;
			case 'fire':
			case 'reload':
			case 'loadout':
			case 'throwKnife':
			case 'placeBeacon':
			case 'callMoab':
			case 'knife':
				// Zombies/infected weapons and hide-and-seek knife (docs/modes.md); the mode validates every field.
				if (!c.spectating) this.mode.message?.(c, msg);
				return;
			case 'zd': {
				// Zombie Defense actions (docs/modes.md#zombie-defense); the mode validates every field.
				const k = c.rate.zd.hit(t);
				if (k > RATE.zd.kick) return this.kick(c, 'action flood');
				if (k <= RATE.zd.limit && !c.spectating) this.mode.message?.(c, msg);
				return;
			}
			case 'boxOpen':
			case 'boxRevealed':
			case 'shopBuy':
			case 'shopEquip': {
				const k = c.rate.shop.hit(t);
				if (k > RATE.shop.kick) return this.kick(c, 'shop flood');
				if (c.closed) return;
				if (msg.type === 'boxRevealed') return k > RATE.shop.limit ? undefined : this.shop.announce(c);
				if (msg.type === 'boxOpen') return this.shop.openBox(c, k > RATE.shop.limit);
				return this.shop.handle(c, msg, k > RATE.shop.limit);
			}
			case 'casinoBet':
			case 'crashCashout': {
				const k = c.rate.casino.hit(t);
				if (k > RATE.casino.kick) return this.kick(c, 'casino flood');
				if (!c.closed) this.casino.handle(c, msg, k > RATE.casino.limit);
				return;
			}
			case 'admin':
				return this.admin.handle(c, msg.action);
			case 'ping':
				if (typeof msg.t === 'number' && Number.isFinite(msg.t)) {
					this.send(c, { type: 'pong', t: msg.t, serverTime: this.serverClock() });
				}
				return;
			default:
				return;
		}
	}

	private onHello(c: Client, msg: Extract<ClientMessage, { type: 'hello' }>): void {
		if (typeof msg.playerId !== 'string' || !PLAYER_ID_RE.test(msg.playerId)) {
			c.transport.close(4001, 'bad player id');
			return;
		}
		if (msg.version !== PROTOCOL_VERSION) {
			this.systemTo(c, `Server protocol changed to v${PROTOCOL_VERSION}. Reload the page to reconnect.`);
			// The v1 browser stops retrying and shows a reload notice on 4002.
			c.transport.close(msg.version === 1 ? 4002 : CLOSE_PROTOCOL_MISMATCH, 'protocol mismatch: reload the page');
			return;
		}
		// Same player connecting again (reload, second tab): drop the old socket.
		for (const o of this.clients) {
			if (o !== c && o.helloed && o.playerId === msg.playerId) {
				o.transport.close(4002, 'connected from another tab');
				this.onClose(o);
			}
		}
		const resumed = msg.token === undefined ? null : this.accounts.resume(msg.token);
		const admin = this.admin.isAdminAccount(resumed?.account.username);
		const ban = this.admin.banFor(resumed?.account.id ?? null, admin, msg.playerId, c.ip);
		if (ban) {
			this.log(`banned hello #${c.id}${resumed ? ` account ${resumed.account.id}` : ''}`);
			this.send(c, this.bannedMessage(ban));
			c.transport.close(4009, 'banned');
			return;
		}
		const guest = this.guestNameFor(typeof msg.name === 'string' ? msg.name : '', msg.playerId);
		const guestName = guest.name;
		if (resumed) this.dropAccountDuplicates(c, resumed.account.id);
		// Check the player cap after dropping duplicate connections.
		if (this.playerCount >= this.maxPlayers) {
			this.send(c, { type: 'full' });
			c.transport.close(4003, 'server full');
			return;
		}
		// After the duplicates are gone, so a reload or account takeover never counts twice.
		if (this.maxPerIp > 0 && this.countFromIp(c.ip, true) >= this.maxPerIp) {
			this.log(`too many connections from one address: #${c.id}`);
			c.transport.close(CLOSE_IP_LIMIT, 'too many connections from this network');
			return;
		}
		const name = resumed ? resumed.account.username : guestName;
		c.playerId = msg.playerId;
		c.name = name;
		c.guestName = guestName;
		c.accountId = resumed?.account.id ?? null;
		c.sessionHash = resumed?.hash ?? null;
		c.admin = admin;
		c.helloed = true;
		c.lastPongAt = c.lastMessageAt = performance.now();
		c.loadout = this.shop.loadoutOf(c.accountId);
		if (c.accountId !== null) this.stats.join(c.accountId, c);
		if (c.helloTimer) clearTimeout(c.helloTimer);
		c.helloTimer = null;
		this.db.upsertPlayer(c.playerId, guestName, Date.now());

		const players: PlayerInfo[] = [];
		for (const o of this.clients) if (o.helloed) players.push(info(o));
		this.send(c, {
			type: 'welcome',
			version: PROTOCOL_VERSION,
			serverId: this.db.serverId,
			selfId: c.id,
			map: this.map.id,
			mode: this.map.kind,
			mapTimeLeft: this.timeLeft(),
			players,
			cvars: mapCvars(this.map),
			records: this.mode.records(c),
			account: resumed ? { username: resumed.account.username, admin } : null,
			serverTime: this.serverClock(),
			snapshotHz: this.snapHz
		});
		this.ping(c, performance.now());
		this.send(c, this.admin.mapsMessage());
		if (!resumed && guest.taken) {
			this.systemTo(c, `That name belongs to a registered account. Log in to use it; playing as ${guestName}.`);
		}
		if (msg.token !== undefined && !resumed) {
			this.send(c, { type: 'auth', ok: false, error: 'Your session expired. Log in again.' });
		}
		this.economy.join(c);
		this.shop.send(c);
		this.casino.send(c);
		this.mode.join(c);
		this.broadcast({ type: 'join', player: info(c) }, c);
		this.system(`${name} joined.`, c);
		const v = this.rotation.vote;
		if (v) {
			this.send(c, {
				type: 'voteStart',
				options: v.options,
				duration: Math.max(0, Math.round((v.endsAt - this.now()) / 1000)),
				rtv: v.rtv
			});
			this.send(c, { type: 'voteUpdate', counts: v.counts.slice() });
		}
		this.sendRtvState(c);
		this.log(`join #${c.id} ${name}`);
		this.admin.pushState();
	}

	// -----------------------------------------------------------------------
	// Accounts

	/** One connection per account: a new login drops the older connection (like a duplicate player id). */
	private dropAccountDuplicates(c: Client, accountId: number): void {
		for (const o of this.clients) {
			if (o !== c && o.helloed && o.accountId === accountId) {
				o.transport.close(4002, 'logged in from another tab or device');
				this.onClose(o);
			}
		}
	}

	private async onCredentials(c: Client, msg: Extract<ClientMessage, { type: 'register' | 'login' }>): Promise<void> {
		const fail = (error: string) => this.send(c, { type: 'auth', ok: false, error });
		if (c.authBusy) return fail('Please wait…');
		if (c.accountId !== null) return fail(`Already logged in as ${c.name}. Log out first.`);
		const username = typeof msg.username === 'string' ? msg.username.slice(0, 256) : '';
		const password = typeof msg.password === 'string' ? msg.password : '';
		const ipBucket = c.ip !== null ? ipKey(c.ip) : null;
		if (msg.type === 'register') {
			const t = this.now();
			if (c.registers.blocked('conn', t) || (ipBucket !== null && this.registersByIp.blocked(ipBucket, t))) {
				return fail(TOO_MANY);
			}
			c.registers.hit('conn', t);
			if (ipBucket !== null) this.registersByIp.hit(ipBucket, t);
			if (this.admin.isAdminAccount(username)) return fail('That username is taken.');
		} else if (ipBucket !== null && this.loginFailsByIp.blocked(ipBucket, this.now())) {
			return fail(TOO_MANY);
		}
		c.authBusy = true;
		let outcome: Awaited<ReturnType<Accounts['login']>>;
		try {
			outcome =
				msg.type === 'register'
					? await this.accounts.register(username, password)
					: await this.accounts.login(username, password, c.loginFails);
		} finally {
			c.authBusy = false;
		}
		if (c.closed || this.closing || c.accountId !== null) return;
		if (!outcome.ok) {
			if (msg.type === 'login' && ipBucket !== null && outcome.error !== TOO_MANY) {
				this.loginFailsByIp.hit(ipBucket, this.now());
			}
			this.log(`${msg.type} failed #${c.id}`);
			return fail(outcome.error);
		}
		const admin = this.admin.isAdminAccount(outcome.account.username);
		const ban = this.admin.banFor(outcome.account.id, admin, null, null);
		if (ban) {
			this.log(`${msg.type} banned #${c.id} account ${outcome.account.id}`);
			fail('This account is banned.');
			return this.kickBanned(c, ban);
		}
		const session = this.accounts.createSession(outcome.account.id);
		this.signIn(c, outcome.account, session.hash, session.token);
		this.log(`${msg.type} #${c.id} account ${outcome.account.id} ${outcome.account.username}`);
		if (msg.type === 'register') {
			this.economy.welcome(outcome.account.id);
			this.releaseName(outcome.account.username, c);
		}
	}

	private signIn(c: Client, account: AccountRow, sessionHash: string, token: string): void {
		this.dropAccountDuplicates(c, account.id);
		c.accountId = account.id;
		this.stats.join(account.id, c);
		c.sessionHash = sessionHash;
		c.admin = this.admin.isAdminAccount(account.username);
		const old = c.name;
		this.setName(c, account.username);
		if (old !== account.username) this.system(`${old} logged in as ${account.username}.`);
		this.send(c, { type: 'auth', ok: true, username: account.username, token, records: this.mode.records(c), admin: c.admin });
		this.economy.account(c);
		this.shop.account(c);
		this.casino.send(c);
		this.admin.pushState();
	}

	/** A new account took `username`: guests using it as their name get a guest name. */
	private releaseName(username: string, except: Client): void {
		const key = usernameKey(username);
		for (const o of this.clients) {
			if (o === except || !o.helloed || o.accountId !== null || usernameKey(o.name) !== key) continue;
			const old = o.name;
			o.guestName = this.guestNameFor(o.name, o.playerId).name;
			this.setName(o, o.guestName);
			this.system(`${old} is now ${o.name} (the name was registered).`);
		}
	}

	private logout(c: Client): void {
		if (c.accountId !== null) {
			if (c.sessionHash) this.accounts.logout(c.sessionHash);
			const old = c.name;
			this.stats.leave(c.accountId, c);
			this.economy.leaveAccount(c.accountId, c);
			c.accountId = null;
			c.sessionHash = null;
			c.admin = false;
			c.guestName = this.guestNameFor(c.guestName, c.playerId).name;
			this.setName(c, c.guestName);
			if (old !== c.name) this.system(`${old} logged out and is now ${c.name}.`);
		}
		this.send(c, { type: 'auth', ok: true, username: null, records: this.mode.records(c), admin: false });
		this.shop.account(c);
		this.casino.send(c);
		this.admin.pushState();
	}

	// -----------------------------------------------------------------------
	// Runs

	private onZone(c: Client, msg: Extract<ClientMessage, { type: 'zone' }>): void {
		if (c.spectating) return;
		if (!ZONE_KINDS.has(msg.kind) || !Number.isInteger(msg.index) || !Number.isInteger(msg.tick) || msg.tick < 0) {
			return;
		}
		this.mode.zone(c, msg.kind, msg.index, msg.tick);
	}

	/** Race records of an account on the current map (empty in non-race modes). */
	records(accountId: number | null): MapRecordInfo {
		return this.mode.records({ id: -1, playerId: '', accountId, name: '', spectating: false, state: null, ping: 0 });
	}

	// -----------------------------------------------------------------------
	// Chat and commands

	private onChat(c: Client, raw: string): void {
		const text = sanitizeText(raw, MAX_CHAT);
		if (!text) return;
		const cmd = parseCommand(text);
		if (!cmd) {
			this.broadcast({ type: 'chat', from: c.name, fromId: c.id, text, ...(c.admin ? { admin: true } : {}) });
			return;
		}
		switch (cmd.cmd) {
			case 'rtv':
				return this.doRtv(c, null);
			case 'top':
			case 'pb':
				if (!this.mode.command(c, cmd)) this.systemTo(c, `!${cmd.cmd} is not available in this mode.`);
				return;
			case 'spec':
				return this.specCommand(c, cmd.name);
			case 'name':
				if (!cmd.name) return this.systemTo(c, 'Usage: !name <new name>');
				return this.rename(c, cmd.name);
			case 'help':
				for (const l of HELP_LINES) this.systemTo(c, l);
				return;
			case 'client':
				return;
			case 'unknown':
				return this.systemTo(c, `Unknown command !${cmd.name}. Type !help.`);
		}
	}

	private rename(c: Client, raw: string): void {
		if (c.accountId !== null) {
			return this.systemTo(c, `You're logged in as ${c.name}. Log out to play under another name.`);
		}
		const name = sanitizeText(raw, MAX_NAME);
		if (!name) return this.systemTo(c, 'Name cannot be empty.');
		if (name === c.name) return;
		if (this.db.accountByName(name)) {
			return this.systemTo(c, `"${name}" belongs to a registered account. Log in to use it.`);
		}
		const old = c.name;
		c.guestName = name;
		this.setName(c, name);
		this.db.rename(c.playerId, name);
		this.system(`${old} is now known as ${name}.`);
		this.admin.pushState();
	}

	/** Change the display name and tell everyone (no chat line). */
	private setName(c: Client, name: string): void {
		if (name === c.name) return;
		c.name = name;
		this.broadcast({ type: 'rename', id: c.id, name });
	}

	private specCommand(c: Client, name: string): void {
		if (!name) {
			if (c.spectating) return this.setSpectate(c, false, null);
			const target = [...this.clients].find((o) => o !== c && o.helloed && !o.spectating);
			return this.setSpectate(c, true, target?.id ?? null);
		}
		const q = name.toLowerCase();
		const others = [...this.clients].filter((o) => o !== c && o.helloed && !o.spectating);
		const target =
			others.find((o) => o.name.toLowerCase() === q) ?? others.find((o) => o.name.toLowerCase().includes(q));
		if (!target) return this.systemTo(c, `No player matching "${name}".`);
		this.setSpectate(c, true, target.id);
	}

	/** Only server spawns and plausible map teleports break the combat pose history. */
	private combatState(c: Client, state: NetState): NetState | null {
		if (isRaceMode(this.mode.id)) return state;
		if ((state.spawnSeq ?? 0) !== c.spawnSeq) return null;
		const clientSeq = teleportSeq(state.flags);
		let teleported = false;
		if (c.pendingSpawn) {
			const elapsed = Math.max(0, this.serverClock() - c.spawnAt) / 1000;
			// Movement clamps each axis. Allow diagonal travel and the usual position slack.
			const axisLimit = Math.min(mapCvars(this.map).sv_maxvelocity, MAX_VELOCITY_HARD);
			const reach = Math.sqrt(3) * axisLimit * elapsed + JUMP_SLACK;
			if (!nearPose(state, c.pendingSpawn, reach)) return null;
			c.pendingSpawn = null;
			c.spawnFrame = null;
			teleported = true;
		} else if (c.state && (clientSeq !== c.clientTeleportSeq || (state.flags & FLAG_TELEPORTED) !== 0)) {
			teleported = mapTeleport(this.map, c.state, state);
		}
		c.clientTeleportSeq = clientSeq;
		if (teleported) {
			c.relayTeleportSeq = (c.relayTeleportSeq + 1) & 0xff;
			// Retain the time anchor, but never relay the pre-teleport pose again.
			if (c.relay) c.relay.sample = null;
		}
		const flags = withTeleportSeq((state.flags & ~FLAG_TELEPORTED) | (teleported ? FLAG_TELEPORTED : 0), c.relayTeleportSeq);
		return { ...state, flags };
	}

	private setSpectate(c: Client, spectating: boolean, targetId: number | null): void {
		if (spectating) {
			const target = [...this.clients].find((o) => o.id === targetId && o !== c && o.helloed && !o.spectating);
			targetId = target ? target.id : null;
		} else {
			targetId = null;
		}
		if (c.spectating === spectating && c.targetId === targetId) return;
		const changed = c.spectating !== spectating;
		c.spectating = spectating;
		c.targetId = targetId;
		if (changed) {
			c.state = null;
			if (c.relay) c.relay.sample = null;
			c.pendingSpawn = null;
			c.spawnFrame = null;
			if (spectating) this.rotation.removeVoter(String(c.id));
		}
		this.broadcast({ type: 'spectating', id: c.id, spectating, targetId });
		if (changed) {
			this.economy.spectate(c);
			this.mode.spectate(c, spectating);
		}
	}

	/** `!rtv`, `rtv` or a Change map click with others here: start (or agree to) an RTV request. */
	private doRtv(c: Client, mapId: string | null): void {
		if (c.spectating) return this.systemTo(c, 'Spectators cannot rock the vote.');
		const starting = !this.rotation.request;
		const res = this.rotation.requestRtv(String(c.id), this.voters(), this.now(), mapId);
		if (!Array.isArray(res)) return this.systemTo(c, res.error);
		if (starting) this.rtvInitiator = { id: c.id, name: c.name };
		this.handleRotation(res);
	}

	private doRtvVote(c: Client, yes: boolean): void {
		if (c.spectating) return this.systemTo(c, 'Spectators cannot vote.');
		const res = this.rotation.rtvVote(String(c.id), yes, this.voters(), this.now());
		if (!Array.isArray(res)) return this.systemTo(c, res.error);
		this.handleRotation(res);
	}

	/** Open RTV request and cooldown for a joining client. */
	private sendRtvState(c: Client): void {
		const r = this.rotation.request;
		if (r) {
			this.send(c, {
				type: 'rtvRequest',
				started: true,
				initiatorId: this.rtvInitiator?.id ?? -1,
				initiator: this.rtvInitiator?.name ?? '?',
				mapId: r.mapId,
				duration: Math.max(0, (r.endsAt - this.now()) / 1000),
				yes: r.yes.size,
				no: r.no.size,
				needed: r.needed
			});
		}
		const wait = this.rotation.rtvAvailableIn(this.now());
		if (wait) this.send(c, { type: 'rtvCooldown', seconds: wait.seconds, reason: wait.reason });
	}

	private mapLabel(id: string): string {
		const m = this.maps.get(id);
		return m ? `${modeOf(m).label} · ${mapTitle(m)}` : id;
	}

	/**
	 * Esc panel map switch: only when `c` is the only connected client
	 * (spectators count as people in the lobby). Same effect as a vote win.
	 */
	private lonePlayerChangeMap(c: Client, mapId: string): void {
		for (const o of this.clients) {
			if (o !== c && o.helloed) return this.systemTo(c, 'Others are here: picking a map starts a map vote request (!rtv).');
		}
		if (!this.maps.has(mapId)) return this.systemTo(c, `Unknown map "${mapId.slice(0, 64)}".`);
		if (!c.admin && !this.admin.isEnabled(mapId)) return this.systemTo(c, 'That map is disabled by an admin.');
		const ev = this.rotation.forceMap(mapId, this.now());
		if (!ev) return this.systemTo(c, `Map "${mapId.slice(0, 64)}" is not in the rotation.`);
		this.handleRotation([ev]);
	}

	// -----------------------------------------------------------------------
	// Rotation

	private voters(): number {
		let n = 0;
		for (const c of this.clients) if (c.helloed && !c.spectating) n++;
		return n;
	}

	timeLeft(): number {
		return Math.ceil(this.rotation.timeLeft(this.now()));
	}

	/** Advance the rotation (called at ~10 Hz by the timer; public for tests). */
	updateRotation(): void {
		this.handleRotation(this.rotation.update(this.now(), this.voters()));
		const t = this.now();
		if (t - this.lastTimeLeftSent >= TIME_LEFT_MS) this.sendTimeLeft();
	}

	private sendTimeLeft(): void {
		this.lastTimeLeftSent = this.now();
		this.broadcast({ type: 'timeLeft', mapTimeLeft: this.timeLeft() });
	}

	private optionLabel(o: VoteOption): string {
		return o.kind === 'extend' ? 'Extend 10 min' : this.mapLabel(o.mapId);
	}

	private handleRotation(events: RotationEvent[]): void {
		for (const e of events) {
			switch (e.type) {
				case 'voteStart':
					this.broadcast({ type: 'voteStart', options: e.options, duration: e.duration, rtv: e.rtv });
					this.system(
						`${e.rtv ? 'Rock the vote! ' : ''}Vote for the next map (${e.duration} s): ` +
							e.options.map((o, i) => `${i + 1}. ${this.optionLabel(o)}`).join('  ')
					);
					break;
				case 'voteUpdate':
					this.broadcast({ type: 'voteUpdate', counts: e.counts });
					break;
				case 'voteEnd':
					this.broadcast({ type: 'voteEnd', winner: e.winner, countdown: e.countdown });
					this.system(
						e.winner.kind === 'extend'
							? 'Vote over: map extended by 10 minutes.'
							: `Vote over: next map ${this.optionLabel(e.winner)} in ${e.countdown} s.`
					);
					break;
				case 'extended':
					this.sendTimeLeft();
					break;
				case 'mapChange':
					this.changeMap(e.map);
					break;
				case 'rtvRequest': {
					const who = this.rtvInitiator ?? { id: -1, name: '?' };
					this.broadcast({
						type: 'rtvRequest',
						started: e.started,
						initiatorId: who.id,
						initiator: who.name,
						mapId: e.mapId,
						duration: e.duration,
						yes: e.yes,
						no: e.no,
						needed: e.needed
					});
					if (e.started) {
						const nom = e.mapId ? ` (${this.mapLabel(e.mapId)})` : '';
						this.system(`${who.name} wants to vote for a new map${nom}. Press 1 = yes, 2 = no.`);
					}
					break;
				}
				case 'rtvRequestEnd':
					this.rtvInitiator = null;
					this.broadcast({ type: 'rtvRequestEnd', passed: e.passed, reason: e.reason, cooldown: e.cooldown });
					if (e.passed) this.system('Map vote request passed.');
					else if (e.reason !== 'cancelled') this.system(`Map vote request declined. Next request in ${e.cooldown} s.`);
					break;
			}
		}
	}

	private changeMap(id: string): void {
		const map = this.maps.get(id);
		if (!map) return;
		this.map = map;
		this.mode.dispose();
		this.economy.useMap(map);
		this.mode = this.createMode();
		const cvars = mapCvars(map);
		const timeLeft = this.timeLeft();
		for (const c of this.clients) {
			if (!c.helloed) continue;
			c.state = null;
			c.relay = null;
			c.pendingSpawn = null;
			c.spawnFrame = null;
			this.send(c, {
				type: 'mapChange',
				map: map.id,
				mode: map.kind,
				mapTimeLeft: timeLeft,
				cvars,
				records: this.mode.records(c)
			});
			this.mode.join(c);
		}
		this.lastTimeLeftSent = this.now();
		this.rtvInitiator = null;
		const wait = this.rotation.rtvAvailableIn(this.now());
		if (wait) this.broadcast({ type: 'rtvCooldown', seconds: wait.seconds, reason: wait.reason });
		this.system(`Map changed to ${mapTitle(map)}.`);
		this.log(`map ${map.id}`);
	}

	// -----------------------------------------------------------------------
	// Periodic sends

	sendSnapshot(): void {
		const now = this.serverClock();
		this.metrics?.recordSnapshotTick();
		const entries: SnapshotEntry[] = [];
		for (const c of this.clients) {
			if (!c.helloed || c.spectating) continue;
			if (c.spawnFrame && now - c.spawnSentAt >= SPAWN_RETRY_MS) {
				c.spawnSentAt = now;
				this.sendRaw(c, c.spawnFrame);
			}
			if (!c.state) continue;
			const relay = c.relay ??= { timeline: new SnapshotTimeline(), sample: null };
			const at = relay.timeline.push(c.state.tick, now);
			if (at !== null) relay.sample = { state: c.state, at };
			if (!relay.sample) continue;
			entries.push({
				id: c.id,
				...relay.sample.state,
				sampleTimeMs: snapshotSampleTimeMs(relay.sample.at, now),
				sourceIdle: relay.timeline.sourceIdle
			});
		}
		if (entries.length === 0) return;
		this.mode.snapshot?.(entries);
		this.snapshotSeq = (this.snapshotSeq + 1) & 0xffff;
		const buf = Buffer.from(encodeSnapshot(entries, now, this.snapshotSeq));
		for (const c of this.clients) if (c.helloed) this.sendRaw(c, buf);
	}

	/** The mode's rows plus what is the same in every mode: admin marker and account totals. */
	scoreRows(): ScoreRow[] {
		const byId = new Map<number, Client>();
		for (const c of this.clients) if (c.helloed) byId.set(c.id, c);
		return this.mode.scoreRows().map((r) => {
			const c = byId.get(r.id);
			const totals = c && c.accountId !== null ? this.stats.totals(c.accountId) : null;
			return {
				...r,
				ping: c ? Math.round(c.rtt.estimate(performance.now())) : r.ping,
				pointsTotal: totals?.pointsTotal ?? null,
				playtimeSecs: totals?.playtimeSecs ?? null,
				// Read fresh: awards, purchases, loot boxes, casino and admins all change it.
				coins: c && c.accountId !== null ? Math.floor(this.db.accountStats(c.accountId).pointsBalance / POINTS_SCALE) : null,
				...(c?.admin ? { admin: true } : {})
			};
		});
	}

	/** The accounts with the most coins, online or not (docs/gameplay.md#tab-scoreboard). */
	richest(): RichEntry[] {
		const online = new Set<number>();
		for (const c of this.clients) if (c.helloed && c.accountId !== null) online.add(c.accountId);
		return this.db.richest(RICHEST).map((r) => ({ name: r.username, coins: Math.floor(r.balance / POINTS_SCALE), online: online.has(r.id) }));
	}

	sendScoreboard(): void {
		if (this.playerCount === 0) return;
		this.broadcast({ type: 'scoreboard', rows: this.scoreRows(), richest: this.richest() });
	}

	sendPings(): void {
		const now = performance.now();
		for (const c of this.clients) {
			if (!c.helloed || !c.transport.open) continue;
			const noPong = c.transport.ping && c.transport.onPong && now - c.lastPongAt >= PONG_TIMEOUT_MS;
			const idle = !c.spectating && now - c.lastMessageAt >= CLIENT_IDLE_TIMEOUT_MS;
			if (noPong || idle) {
				this.log(`timeout #${c.id} ${c.name}: ${noPong ? 'no WebSocket pong' : 'no game traffic'}`);
				c.transport.terminate();
				continue;
			}
			this.ping(c, now);
		}
	}

	private ping(c: Client, now: number): void {
		if (!c.transport.open) return;
		c.transport.ping?.(c.rtt.probe(now));
		this.send(c, { type: 'ping', t: now });
	}

	// -----------------------------------------------------------------------
	// Send helpers

	private sendRaw(c: Client, data: string | Uint8Array, reliable = false): void {
		if (!c.transport.open) return;
		if (typeof data === 'string' || reliable) c.transport.sendReliable(data);
		else if (!c.transport.sendUnreliable(data)) {
			this.metrics?.recordFrameDropped();
			return;
		}
		this.metrics?.recordBytesSent(typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength);
	}

	private send(c: Client, msg: ServerMessage): void {
		if ((msg.type === 'hns' || msg.type === 'inf' || msg.type === 'zm' || msg.type === 'zd') && msg.ev.e === 'spawn' && msg.ev.id === c.id) {
			c.pendingSpawn = 'pos' in msg.ev ? msg.ev.pos : { x: msg.ev.x, y: msg.ev.y, z: msg.ev.z };
			c.state = null;
			c.spawnSeq = c.spawnSeq === 0xffff ? 1 : c.spawnSeq + 1;
			c.spawnFrame = JSON.stringify({ ...msg, spawnSeq: c.spawnSeq });
			c.spawnAt = this.serverClock();
			c.spawnSentAt = c.spawnAt;
			this.sendRaw(c, c.spawnFrame);
			return;
		}
		this.sendRaw(c, JSON.stringify(msg));
	}

	private broadcast(msg: ServerMessage, except?: Client | number): void {
		const s = JSON.stringify(msg);
		const skipId = typeof except === 'number' ? except : except?.id;
		for (const c of this.clients) if (c.helloed && c.id !== skipId) this.sendRaw(c, s);
	}

	private system(text: string, except?: Client): void {
		this.broadcast({ type: 'chat', from: null, fromId: null, text: text.slice(0, 512), system: true }, except);
	}

	private systemTo(c: Client, text: string): void {
		this.send(c, { type: 'chat', from: null, fromId: null, text, system: true });
	}
}

function info(c: Client): PlayerInfo {
	return { id: c.id, name: c.name, spectating: c.spectating, ...(isEmptyLoadout(c.loadout) ? {} : { loadout: c.loadout }) };
}

function cleanName(raw: string): string {
	return sanitizeText(raw, MAX_NAME) || 'Player';
}
