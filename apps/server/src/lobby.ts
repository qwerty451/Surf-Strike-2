/**
 * Lobby: connections, accounts, relay, chat and spectating
 * (docs/architecture.md, docs/gameplay.md). Every map has its own lobby (a
 * `Room`, docs/architecture.md#lobbies): players pick one in the server
 * browser and only see, hear and play with the players in it. Gamemode rules
 * (race timer and run validation, tag rounds) and scoreboard rows live in
 * ./modes (docs/modes.md); the lobby itself is mode-agnostic.
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
	ScoreRow,
	ServerMessage,
	RichEntry,
	SnapshotEntry
} from '@surf/shared';
import {
	CLOSE_IP_LIMIT,
	emptyLoadout,
	isEmptyLoadout,
	mapTitle,
	encodeSnapshot,
	decodeState,
	mapCvars as sharedMapCvars,
	MAX_CHAT,
	MAX_NAME,
	MAX_PLAYERS,
	modeOf,
	POINTS_SCALE,
	PROTOCOL_VERSION,
	RICHEST,
	sanitizeText,
	SNAPSHOT_HZ,
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
import { Shop } from './shop.ts';
import { createServerMode, type ModeHost, type ModeOptions, type ServerMode } from './modes/index.ts';
import { EMPTY_RECORDS } from './modes/types.ts';
import type { ZoneKind } from './validation.ts';

export { SNAPSHOT_HZ };
/** Gamemode rule ticks (tag contact checks), at least the snapshot rate. */
export const MODE_TICK_HZ = TAG_TICK_HZ;
export const SCOREBOARD_MS = 1000;
/** `lobbies` (players per map) goes out at most this often. */
export const LOBBIES_MS = 1000;
export const PING_MS = 2000;
export const HELLO_TIMEOUT_MS = 10_000;

/** Per-second limits: above `limit` messages are dropped, above `kick` the client is kicked. */
export const RATE = {
	state: { limit: 70, kick: 250 },
	chat: { limit: 2, kick: 20 },
	json: { limit: 60, kick: 300 },
	shop: { limit: 8, kick: 100 },
	casino: { limit: 5, kick: 100 }
} as const;

export interface LobbyOptions {
	maps: MapDef[];
	db: Db;
	/** Lobby for clients whose hello names no (known, enabled) map; defaults to the first map. */
	initialMap?: string;
	/** Wall clock in ms, used for run timing (injectable for tests). */
	now?: () => number;
	rng?: () => number;
	/** Casino rolls (default node:crypto; tests). */
	casinoRandom?: () => number;
	/** Monotonic clock in ms for account playtime (default: `now` when injected, else performance.now). */
	playClock?: () => number;
	/** Start interval timers (snapshot, scoreboard, lobbies, ping). Default true. */
	timers?: boolean;
	maxPlayers?: number;
	/** Connected clients allowed per IP address (ipKey); 0 = no limit (default; `pnpm host` sets 3). */
	maxPerIp?: number;
	log?: (msg: string) => void;
	/** Gamemode tuning (tests: shorter tag rounds). */
	modes?: ModeOptions;
	/** Admin account usernames, case-insensitive (default: ADMIN_USERNAMES rules, i.e. `tim`). */
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
	socket: WebSocket;
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
	/** The map lobby this client is in; null before hello and after close. */
	room: Room | null;
	/** `room.map.id` (admin.ts reads it). */
	mapId: string | null;
	spectating: boolean;
	targetId: number | null;
	state: NetState | null;
	ping: number;
	/** Worn cosmetics (docs/economy.md#shop); the default look for guests. */
	loadout: Loadout;
	rate: { state: Window; chat: Window; json: Window; shop: Window; casino: Window };
	helloTimer: NodeJS.Timeout | null;
	closed: boolean;
}

/**
 * One map's lobby (docs/architecture.md#lobbies): its players, its gamemode
 * and its own economy (multiplier, round caps, activity). The mode exists
 * while somebody is in the room and is disposed when the last player leaves,
 * so an empty lobby costs nothing and starts fresh.
 */
interface Room {
	readonly map: MapDef;
	readonly members: Set<Client>;
	mode: ServerMode | null;
	economy: Economy;
}

const ZONE_KINDS = new Set<ZoneKind>(['start', 'stage', 'checkpoint', 'end']);
const PLAYER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Full cvars for a map: its gamemode's profile, then the map's overrides. */
export function mapCvars(map: MapDef): Cvars {
	return sharedMapCvars(map);
}

export class Lobby {
	readonly clients = new Set<Client>();
	private readonly maps: Map<string, MapDef>;
	/** Map lobbies, created on first use and kept (their economy remembers caps and abuse). */
	private readonly rooms = new Map<string, Room>();
	/** Players per map last sent in `lobbies`. */
	private lastLobbies = '';
	private readonly db: Db;
	private readonly now: () => number;
	private readonly maxPlayers: number;
	private readonly maxPerIp: number;
	private readonly log: (msg: string) => void;
	/** Lobby for hellos without a (usable) map. */
	private readonly defaultMapId: string;
	private readonly clock: () => number;
	private timers: NodeJS.Timeout[] = [];
	private closing = false;
	private readonly modeOptions: ModeOptions;
	private readonly rng: () => number;
	private readonly accounts: Accounts;
	/**
	 * Coin balance changes that do not belong to a map (shop, casino, admin,
	 * welcome): reaches every connection. Never joined or ticked; awards are
	 * paid by the room economies.
	 */
	private readonly bank: Economy;
	/** Cosmetics: purchases and worn items (docs/economy.md#shop). */
	private readonly shop: Shop<Client>;
	/** Casino: rolls, bets and payouts (docs/economy.md#casino). */
	readonly casino: Casino<Client>;
	/** Playtime and points of the accounts online (docs/gameplay.md#points-and-playtime). */
	readonly stats: AccountStats;
	readonly admin: AdminController<Client>;

	constructor(opts: LobbyOptions) {
		if (opts.maps.length === 0) {
			throw new Error('No maps available: @surf/shared exports no MAPS (map module not implemented yet?)');
		}
		this.maps = new Map(opts.maps.map((m) => [m.id, m]));
		this.db = opts.db;
		this.now = opts.now ?? Date.now;
		this.maxPlayers = opts.maxPlayers ?? MAX_PLAYERS;
		this.maxPerIp = opts.maxPerIp ?? 0;
		this.log = opts.log ?? ((m) => console.log(m));
		this.accounts = new Accounts(this.db, () => this.now());
		this.stats = new AccountStats(this.db, opts.playClock ?? opts.now, this.log);
		this.defaultMapId = opts.initialMap && this.maps.has(opts.initialMap) ? opts.initialMap : opts.maps[0].id;
		this.rng = opts.rng ?? Math.random;
		this.modeOptions = opts.modes ?? {};
		this.admin = this.createAdmin(opts.adminUsernames ?? parseAdminUsernames(undefined));
		const clock = opts.playClock ?? opts.now ?? (() => performance.now());
		this.clock = clock;
		this.bank = this.createEconomy(null);
		this.shop = new Shop<Client>({
			db: this.db,
			economy: () => this.bank,
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
				balance: (accountId) => this.bank.sendCoinsTo(accountId),
				log: this.log
			},
			opts.casinoRandom
		);
		if (opts.timers !== false) {
			this.timers.push(
				setInterval(() => this.sendSnapshot(), 1000 / SNAPSHOT_HZ),
				setInterval(() => this.sendScoreboard(), SCOREBOARD_MS),
				setInterval(() => this.sendLobbies(), LOBBIES_MS),
				setInterval(() => this.sendPings(), PING_MS),
				setInterval(() => this.stats.flush(), PLAYTIME_FLUSH_MS),
				setInterval(() => this.tickMode(), 1000 / MODE_TICK_HZ)
			);
		}
	}

	/** Lobby that clients join when their hello names no usable map. */
	get currentMap(): MapDef {
		return this.maps.get(this.defaultMapId)!;
	}

	/** The default map lobby's gamemode module (created if nobody is there; tests). */
	get gameMode(): ServerMode {
		return this.modeOf(this.room(this.defaultMapId));
	}

	/** The default map lobby's economy (tests). */
	get economy(): Economy {
		return this.room(this.defaultMapId).economy;
	}

	/** The gamemode module of a map's lobby, null while nobody is in it. */
	modeFor(mapId: string): ServerMode | null {
		return this.rooms.get(mapId)?.mode ?? null;
	}

	/** Economy of a map's lobby (tests). */
	economyFor(mapId: string): Economy {
		return this.room(mapId).economy;
	}

	/** Map lobby a client is in (by lobby id), or null. */
	mapOf(id: number): string | null {
		for (const c of this.clients) if (c.id === id) return c.mapId;
		return null;
	}

	/** Players per map lobby, spectators included; empty lobbies are left out. */
	lobbyCounts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const [id, r] of this.rooms) if (r.members.size > 0) counts[id] = r.members.size;
		return counts;
	}

	/** Advance gamemode rules (timer-driven at MODE_TICK_HZ; public for tests). */
	tickMode(): void {
		for (const r of this.rooms.values()) {
			if (r.members.size === 0) continue;
			r.mode?.tick();
			r.economy.tick();
		}
		this.casino.tick();
		this.shop.tick();
	}

	/** A map's lobby, created on first use. */
	private room(mapId: string): Room {
		let r = this.rooms.get(mapId);
		if (!r) {
			const map = this.maps.get(mapId);
			if (!map) throw new Error(`unknown map ${mapId}`);
			const room: Room = { map, members: new Set(), mode: null, economy: null as unknown as Economy };
			room.economy = this.createEconomy(room);
			this.rooms.set(mapId, room);
			r = room;
		}
		return r;
	}

	/** The room's gamemode, created (with a fresh economy session) when the room had none. */
	private modeOf(r: Room): ServerMode {
		if (!r.mode) {
			r.economy.useMap(r.map);
			r.mode = this.createMode(r);
		}
		return r.mode;
	}

	/** `room` null: the bank (every connection, see `bank`). */
	private createEconomy(room: Room | null): Economy {
		const lobby = this;
		return new Economy(
			{
				db: this.db,
				now: () => this.now(),
				clock: this.clock,
				*players() {
					if (room) yield* room.members;
					else for (const c of lobby.clients) if (c.helloed) yield c;
				},
				send: (p, msg) => this.send(p as Client, msg),
				broadcast: (msg) => (room ? this.broadcastRoom(room, msg) : this.broadcast(msg)),
				systemTo: (p, text) => this.systemTo(p as Client, text),
				totals: (accountId, pointsTotal) => this.stats.setPoints(accountId, pointsTotal),
				isAdmin: (accountId) => this.admin.isAdminAccount(this.db.accountById(accountId)?.username),
				ban: (accountId, reason, ms) => this.admin.autoBan(accountId, reason, ms),
				abuseLogged: () => this.admin.pushState(),
				log: (msg) => this.log(msg),
				stillness: (p) => room?.mode?.stillness?.(p as Client) ?? null
			},
			room?.map ?? this.currentMap
		);
	}

	private createMode(room: Room): ServerMode {
		const host: ModeHost = {
			map: room.map,
			db: this.db,
			economy: room.economy.forMode(),
			now: () => this.now(),
			rng: () => this.rng(),
			*players() {
				yield* room.members;
			},
			send: (p, msg) => {
				room.economy.sent(p as Client, msg);
				this.send(p as Client, msg);
			},
			broadcast: (msg) => this.broadcastRoom(room, msg),
			sendBinary: (p, data) => this.sendRaw(p as Client, Buffer.from(data), true),
			broadcastBinary: (data, droppable = false) => {
				const buf = Buffer.from(data);
				for (const c of room.members) this.sendRaw(c, buf, !droppable);
			},
			system: (text) => this.systemRoom(room, text),
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
				adjustCoins: (accountId, amount) => this.bank.adjust(accountId, amount),
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
		c.socket.close(4009, 'banned');
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

	/** True if `c`'s address already has `maxPerIp` connected clients. Unknown addresses (dev, loopback) are never limited. */
	private ipFull(c: Client): boolean {
		if (this.maxPerIp <= 0 || c.ip === null) return false;
		const key = ipKey(c.ip);
		let n = 0;
		for (const o of this.clients) if (o !== c && o.helloed && o.ip !== null && ipKey(o.ip) === key) n++;
		return n >= this.maxPerIp;
	}

	get playerCount(): number {
		let n = 0;
		for (const c of this.clients) if (c.helloed) n++;
		return n;
	}

	close(): void {
		this.closing = true;
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		this.stats.close();
		for (const r of this.rooms.values()) r.economy.close();
		for (const c of this.clients) c.socket.close(1001, 'server shutting down');
	}

	// -----------------------------------------------------------------------
	// Connections

	/** `ip`: client IP for guest bans (admin.ts clientIp), null when unknown. */
	handleConnection(socket: WebSocket, ip: string | null = null): void {
		if (this.closing) {
			socket.close(1001, 'server shutting down');
			return;
		}
		if (this.clients.size >= this.maxPlayers) {
			socket.send(JSON.stringify({ type: 'full' } satisfies ServerMessage));
			socket.close(4003, 'server full');
			return;
		}
		const c: Client = {
			socket,
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
			room: null,
			mapId: null,
			spectating: false,
			targetId: null,
			state: null,
			ping: 0,
			loadout: emptyLoadout(),
			rate: { state: new Window(), chat: new Window(), json: new Window(), shop: new Window(), casino: new Window() },
			helloTimer: null,
			closed: false
		};
		c.helloTimer = setTimeout(() => {
			if (!c.helloed) socket.close(4000, 'hello timeout');
		}, HELLO_TIMEOUT_MS);
		this.clients.add(c);
		socket.on('message', (data, isBinary) => {
			try {
				this.onMessage(c, data as Buffer, isBinary);
			} catch (err) {
				this.log(`error handling message from #${c.id}: ${(err as Error).message}`);
			}
		});
		socket.on('close', () => this.onClose(c));
		socket.on('error', () => socket.terminate());
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
		this.shop.announce(c);
		this.db.touch(c.playerId, Date.now());
		this.leaveRoom(c, `${c.name} left.`);
		this.log(`leave #${c.id} ${c.name}`);
		this.admin.pushState();
	}

	private kick(c: Client, reason: string): void {
		this.log(`kick #${c.id} ${c.name}: ${reason}`);
		c.socket.close(4008, reason);
		c.socket.terminate();
	}

	private onMessage(c: Client, data: Buffer, isBinary: boolean): void {
		const t = performance.now();
		if (isBinary) {
			const n = c.rate.state.hit(t);
			if (n > RATE.state.kick) return this.kick(c, 'state flood');
			if (n > RATE.state.limit || !c.helloed || c.spectating) return;
			const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
			const s = decodeState(ab);
			if (!s) return;
			const r = c.room;
			if (!r) return;
			c.state = s;
			r.economy.state(c, s);
			r.mode?.state(c, s);
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
		switch (msg.type) {
			case 'zone':
				return this.onZone(c, msg);
			case 'chat': {
				const k = c.rate.chat.hit(t);
				if (k > RATE.chat.kick) return this.kick(c, 'chat flood');
				if (k > RATE.chat.limit) return;
				if (typeof msg.text === 'string') this.onChat(c, msg.text);
				return;
			}
			case 'changeMap':
				if (typeof msg.mapId === 'string') this.moveTo(c, msg.mapId);
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
				if (typeof msg.map === 'string') c.room?.mode?.ghost?.(c, msg.map);
				return;
			case 'fire':
			case 'reload':
			case 'loadout':
			case 'throwKnife':
			case 'placeBeacon':
			case 'callMoab':
			case 'knife':
				// Zombies/infected weapons and hide-and-seek knife (docs/modes.md); the mode validates every field.
				if (!c.spectating) c.room?.mode?.message?.(c, msg);
				return;
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
			case 'pong':
				if (typeof msg.t === 'number' && Number.isFinite(msg.t)) {
					const rtt = t - msg.t;
					if (rtt >= 0 && rtt < 60_000) c.ping = c.ping === 0 ? rtt : c.ping * 0.7 + rtt * 0.3;
				}
				return;
			default:
				return;
		}
	}

	private onHello(c: Client, msg: Extract<ClientMessage, { type: 'hello' }>): void {
		if (typeof msg.playerId !== 'string' || !PLAYER_ID_RE.test(msg.playerId)) {
			c.socket.close(4001, 'bad player id');
			return;
		}
		// Same player connecting again (reload, second tab): drop the old socket.
		for (const o of this.clients) {
			if (o !== c && o.helloed && o.playerId === msg.playerId) {
				o.socket.close(4002, 'connected from another tab');
				this.onClose(o);
			}
		}
		const resumed = msg.token === undefined ? null : this.accounts.resume(msg.token);
		const admin = this.admin.isAdminAccount(resumed?.account.username);
		const ban = this.admin.banFor(resumed?.account.id ?? null, admin, msg.playerId, c.ip);
		if (ban) {
			this.log(`banned hello #${c.id}${resumed ? ` account ${resumed.account.id}` : ''}`);
			this.send(c, this.bannedMessage(ban));
			c.socket.close(4009, 'banned');
			return;
		}
		const guest = this.guestNameFor(typeof msg.name === 'string' ? msg.name : '', msg.playerId);
		const guestName = guest.name;
		if (resumed) this.dropAccountDuplicates(c, resumed.account.id);
		// After the duplicates are gone, so a reload or account takeover never counts twice.
		if (this.ipFull(c)) {
			this.log(`too many connections from one address: #${c.id}`);
			c.socket.close(CLOSE_IP_LIMIT, 'too many connections from this network');
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
		c.loadout = this.shop.loadoutOf(c.accountId);
		if (c.accountId !== null) this.stats.join(c.accountId, c);
		if (c.helloTimer) clearTimeout(c.helloTimer);
		c.helloTimer = null;
		this.db.upsertPlayer(c.playerId, guestName, Date.now());

		const room = this.enterRoom(c, this.helloRoom(msg.map, admin));
		this.send(c, {
			type: 'welcome',
			selfId: c.id,
			map: room.map.id,
			mode: room.map.kind,
			players: [...room.members].map(info),
			cvars: mapCvars(room.map),
			records: this.modeOf(room).records(c),
			account: resumed ? { username: resumed.account.username, admin } : null
		});
		this.send(c, this.admin.mapsMessage());
		this.send(c, { type: 'lobbies', counts: this.lobbyCounts() });
		if (!resumed && guest.taken) {
			this.systemTo(c, `That name belongs to a registered account. Log in to use it; playing as ${guestName}.`);
		}
		if (msg.token !== undefined && !resumed) {
			this.send(c, { type: 'auth', ok: false, error: 'Your session expired. Log in again.' });
		}
		room.economy.join(c);
		this.shop.send(c);
		this.casino.send(c);
		this.modeOf(room).join(c);
		this.broadcastRoom(room, { type: 'join', player: info(c) }, c);
		this.systemRoom(room, `${name} joined.`, c);
		if (msg.version !== PROTOCOL_VERSION) {
			this.systemTo(c, `Protocol version mismatch (server ${PROTOCOL_VERSION}, client ${String(msg.version)}). Reload the page.`);
		}
		this.log(`join #${c.id} ${name} (${room.map.id})`);
		this.admin.pushState();
	}

	// -----------------------------------------------------------------------
	// Map lobbies (docs/architecture.md#lobbies)

	/** The lobby a hello lands in: the map it names when known and open to this player, else the default map. */
	private helloRoom(mapId: unknown, admin: boolean): Room {
		if (typeof mapId === 'string' && this.maps.has(mapId) && (admin || this.admin.isEnabled(mapId))) return this.room(mapId);
		if (admin || this.admin.isEnabled(this.defaultMapId)) return this.room(this.defaultMapId);
		const open = [...this.maps.keys()].find((id) => this.admin.isEnabled(id));
		return this.room(open ?? this.defaultMapId);
	}

	/** Put a client into a room (no messages yet). */
	private enterRoom(c: Client, room: Room): Room {
		c.room = room;
		c.mapId = room.map.id;
		c.state = null;
		c.spectating = false;
		c.targetId = null;
		room.members.add(c);
		return room;
	}

	/** Take a client out of its room and tell the others there (`line`: system chat line). Empty rooms drop their mode. */
	private leaveRoom(c: Client, line: string): void {
		const room = c.room;
		if (!room) return;
		if (c.accountId !== null) room.economy.leaveAccount(c.accountId, c);
		room.mode?.leave(c);
		room.economy.leave(c);
		room.members.delete(c);
		c.room = null;
		c.mapId = null;
		c.state = null;
		c.spectating = false;
		c.targetId = null;
		this.broadcastRoom(room, { type: 'leave', id: c.id });
		this.systemRoom(room, line);
		for (const o of room.members) {
			if (o.spectating && o.targetId === c.id) o.targetId = null;
		}
		if (room.members.size === 0 && room.mode) {
			room.mode.dispose();
			room.mode = null;
		}
	}

	/**
	 * `changeMap`, `!map`: move to the lobby of `mapId`. Players in a disabled
	 * map's lobby stay, but only admins can join one.
	 */
	private moveTo(c: Client, mapId: string): void {
		const map = this.maps.get(mapId);
		if (!map) return this.systemTo(c, `Unknown map "${mapId.slice(0, 64)}".`);
		if (c.room?.map === map) return this.systemTo(c, `You are already playing ${mapTitle(map)}.`);
		if (!c.admin && !this.admin.isEnabled(map.id)) return this.systemTo(c, 'That map is disabled by an admin.');
		this.leaveRoom(c, `${c.name} went to ${this.mapLabel(map.id)}.`);
		const room = this.enterRoom(c, this.room(map.id));
		const mode = this.modeOf(room);
		this.send(c, {
			type: 'mapChange',
			map: map.id,
			mode: map.kind,
			cvars: mapCvars(map),
			records: mode.records(c),
			players: [...room.members].map(info)
		});
		room.economy.join(c);
		mode.join(c);
		this.broadcastRoom(room, { type: 'join', player: info(c) }, c);
		this.systemRoom(room, `${c.name} joined.`, c);
		this.log(`move #${c.id} ${c.name} ${map.id}`);
		this.admin.pushState();
	}

	// -----------------------------------------------------------------------
	// Accounts

	/** One connection per account: a new login drops the older connection (like a duplicate player id). */
	private dropAccountDuplicates(c: Client, accountId: number): void {
		for (const o of this.clients) {
			if (o !== c && o.helloed && o.accountId === accountId) {
				o.socket.close(4002, 'logged in from another tab or device');
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
		if (msg.type === 'register') {
			const t = this.now();
			if (c.registers.blocked('conn', t)) return fail(TOO_MANY);
			c.registers.hit('conn', t);
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
			this.bank.welcome(outcome.account.id);
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
		if (old !== account.username) this.systemNear(c, `${old} logged in as ${account.username}.`);
		this.send(c, { type: 'auth', ok: true, username: account.username, token, records: this.recordsOf(c), admin: c.admin });
		c.room?.economy.account(c);
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
			this.systemNear(o, `${old} is now ${o.name} (the name was registered).`);
		}
	}

	private logout(c: Client): void {
		if (c.accountId !== null) {
			if (c.sessionHash) this.accounts.logout(c.sessionHash);
			const old = c.name;
			this.stats.leave(c.accountId, c);
			c.room?.economy.leaveAccount(c.accountId, c);
			c.accountId = null;
			c.sessionHash = null;
			c.admin = false;
			c.guestName = this.guestNameFor(c.guestName, c.playerId).name;
			this.setName(c, c.guestName);
			if (old !== c.name) this.systemNear(c, `${old} logged out and is now ${c.name}.`);
		}
		this.send(c, { type: 'auth', ok: true, username: null, records: this.recordsOf(c), admin: false });
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
		c.room?.mode?.zone(c, msg.kind, msg.index, msg.tick);
	}

	/** A client's race records in its lobby (empty in non-race modes). */
	private recordsOf(c: Client): MapRecordInfo {
		return c.room ? this.modeOf(c.room).records(c) : EMPTY_RECORDS;
	}

	/** Race records of an account on the default map (empty in non-race modes). */
	records(accountId: number | null): MapRecordInfo {
		return this.gameMode.records({ id: -1, playerId: '', accountId, name: '', spectating: false, state: null, ping: 0 });
	}

	// -----------------------------------------------------------------------
	// Chat and commands

	private onChat(c: Client, raw: string): void {
		const text = sanitizeText(raw, MAX_CHAT);
		if (!text) return;
		const cmd = parseCommand(text);
		if (!cmd) {
			if (c.room) this.broadcastRoom(c.room, { type: 'chat', from: c.name, fromId: c.id, text, ...(c.admin ? { admin: true } : {}) });
			return;
		}
		switch (cmd.cmd) {
			case 'rtv':
				return this.systemTo(c, 'There are no map votes: every map has its own lobby. Pick one in the server browser (Esc › Servers) or type !map <name>.');
			case 'map':
				return this.mapCommand(c, cmd.name);
			case 'top':
			case 'pb':
				if (!c.room?.mode?.command(c, cmd)) this.systemTo(c, `!${cmd.cmd} is not available in this mode.`);
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
		this.systemNear(c, `${old} is now known as ${name}.`);
		this.admin.pushState();
	}

	/** Change the display name and tell everyone (no chat line). */
	private setName(c: Client, name: string): void {
		if (name === c.name) return;
		c.name = name;
		if (c.room) this.broadcastRoom(c.room, { type: 'rename', id: c.id, name });
	}

	/** `!map`: list the lobbies with players, or join the map whose title or id matches best. */
	private mapCommand(c: Client, query: string): void {
		const q = query.trim().toLowerCase();
		if (!q) {
			const busy = Object.entries(this.lobbyCounts()).sort((a, b) => b[1] - a[1]);
			this.systemTo(c, busy.length ? `Playing now: ${busy.map(([id, n]) => `${this.mapLabel(id)} (${n})`).join(', ')}` : 'Nobody is playing.');
			this.systemTo(c, 'Join a map with !map <name>, or pick one in the server browser (Esc › Servers).');
			return;
		}
		const all = [...this.maps.values()];
		const hit =
			all.find((m) => m.id.toLowerCase() === q || mapTitle(m).toLowerCase() === q) ??
			all.find((m) => m.id.toLowerCase().includes(q) || mapTitle(m).toLowerCase().includes(q));
		if (!hit) return this.systemTo(c, `No map matching "${query.slice(0, 64)}".`);
		this.moveTo(c, hit.id);
	}

	private specCommand(c: Client, name: string): void {
		if (!name) {
			if (c.spectating) return this.setSpectate(c, false, null);
			const target = [...(c.room?.members ?? [])].find((o) => o !== c && !o.spectating);
			return this.setSpectate(c, true, target?.id ?? null);
		}
		const q = name.toLowerCase();
		const others = [...(c.room?.members ?? [])].filter((o) => o !== c && !o.spectating);
		const target =
			others.find((o) => o.name.toLowerCase() === q) ?? others.find((o) => o.name.toLowerCase().includes(q));
		if (!target) return this.systemTo(c, `No player matching "${name}".`);
		this.setSpectate(c, true, target.id);
	}

	private setSpectate(c: Client, spectating: boolean, targetId: number | null): void {
		const room = c.room;
		if (!room) return;
		if (spectating) {
			const target = [...room.members].find((o) => o.id === targetId && o !== c && !o.spectating);
			targetId = target ? target.id : null;
		} else {
			targetId = null;
		}
		if (c.spectating === spectating && c.targetId === targetId) return;
		const changed = c.spectating !== spectating;
		c.spectating = spectating;
		c.targetId = targetId;
		if (changed) c.state = null;
		this.broadcastRoom(room, { type: 'spectating', id: c.id, spectating, targetId });
		if (changed) {
			room.economy.spectate(c);
			room.mode?.spectate(c, spectating);
		}
	}

	private mapLabel(id: string): string {
		const m = this.maps.get(id);
		return m ? `${modeOf(m).label} · ${mapTitle(m)}` : id;
	}

	// -----------------------------------------------------------------------
	// Periodic sends

	/** Each lobby gets the states of its own players. */
	sendSnapshot(): void {
		for (const room of this.rooms.values()) {
			const entries: SnapshotEntry[] = [];
			for (const c of room.members) if (!c.spectating && c.state) entries.push({ id: c.id, ...c.state });
			if (entries.length === 0) continue;
			const buf = Buffer.from(encodeSnapshot(entries));
			for (const c of room.members) this.sendRaw(c, buf);
		}
	}

	/** A lobby's rows (default: the default map's) plus what is the same in every mode: admin marker and account totals. */
	scoreRows(mapId = this.defaultMapId): ScoreRow[] {
		const room = this.rooms.get(mapId);
		if (!room?.mode) return [];
		const byId = new Map<number, Client>();
		for (const c of room.members) byId.set(c.id, c);
		return room.mode.scoreRows().map((r) => {
			const c = byId.get(r.id);
			const totals = c && c.accountId !== null ? this.stats.totals(c.accountId) : null;
			return {
				...r,
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
		const richest = this.richest();
		for (const [id, room] of this.rooms) {
			if (room.members.size > 0) this.broadcastRoom(room, { type: 'scoreboard', rows: this.scoreRows(id), richest });
		}
	}

	/** `lobbies` to everyone when a count changed since the last one (timer at LOBBIES_MS; public for tests). */
	sendLobbies(): void {
		const counts = this.lobbyCounts();
		const key = JSON.stringify(Object.entries(counts).sort());
		if (key === this.lastLobbies) return;
		this.lastLobbies = key;
		this.broadcast({ type: 'lobbies', counts });
	}

	sendPings(): void {
		const t = Math.round(performance.now());
		this.broadcast({ type: 'ping', t });
	}

	// -----------------------------------------------------------------------
	// Send helpers

	private sendRaw(c: Client, data: string | Buffer, reliable = false): void {
		if (c.socket.readyState !== c.socket.OPEN) return;
		// Drop frames to clients with a large backlog instead of buffering forever.
		if (typeof data !== 'string' && !reliable && c.socket.bufferedAmount > 1 << 20) return;
		c.socket.send(data);
	}

	private send(c: Client, msg: ServerMessage): void {
		this.sendRaw(c, JSON.stringify(msg));
	}

	private broadcast(msg: ServerMessage, except?: Client): void {
		const s = JSON.stringify(msg);
		for (const c of this.clients) if (c.helloed && c !== except) this.sendRaw(c, s);
	}

	private broadcastRoom(room: Room, msg: ServerMessage, except?: Client): void {
		const s = JSON.stringify(msg);
		for (const c of room.members) if (c !== except) this.sendRaw(c, s);
	}

	/** System chat line to every lobby. */
	private system(text: string, except?: Client): void {
		this.broadcast({ type: 'chat', from: null, fromId: null, text: text.slice(0, 512), system: true }, except);
	}

	private systemRoom(room: Room, text: string, except?: Client): void {
		this.broadcastRoom(room, { type: 'chat', from: null, fromId: null, text: text.slice(0, 512), system: true }, except);
	}

	/** System chat line to the lobby `c` is in. */
	private systemNear(c: Client, text: string): void {
		if (c.room) this.systemRoom(c.room, text);
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
