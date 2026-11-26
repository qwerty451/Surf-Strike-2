/**
 * Wire protocol (docs/architecture.md#protocol-sketch).
 * JSON text frames for reliable events, binary frames for state/snapshots.
 */
import type { CasinoGame, CoinSide, SlotReels } from './casino.ts';
import type { CosmeticSlot, Loadout, RarityId } from './cosmetics.ts';
import type { Cvars } from './cvars.ts';
import type { MapDef } from './maps/types.ts';
import type { GameModeId } from './modes/index.ts';
import type { HnsEvent, HnsStateView } from './modes/hns.ts';
import type { InfEvent, InfStateView } from './modes/infected/game.ts';
import type { TagPhase, TagScore } from './modes/tag.ts';
import type { ZmEvent, ZmStateView } from './modes/zombies/game.ts';
import type { WeaponId } from './modes/zombies/weapons.ts';
import type { Vec3 } from './types.ts';
import { TICK_RATE } from './units.ts';

export const PROTOCOL_VERSION = 3;
export const CLOSE_PROTOCOL_MISMATCH = 4006;
/** WebSocket subprotocol that sends a database identity before hello. */
export const SERVER_ID_PROTOCOL = 'surf-server-identity';
export const MAX_PLAYERS = 32;
/** Close code: too many clients from this IP address (docs/architecture.md#connection-limit). */
export const CLOSE_IP_LIMIT = 4010;
export const MAX_NAME = 24;
export const MAX_CHAT = 128;
/** Snapshots (all players' states) go to every client at this rate (Hz). */
export const SNAPSHOT_HZ = 32;
/**
 * Clients draw remote players this far in the past (ms), interpolated between
 * snapshots. Server lag compensation rewinds by the same amount.
 */
export const INTERP_DELAY_MS = 100;

/** Player status shown on the scoreboard. */
export const Status = {
	StartZone: 0,
	Running: 1,
	Finished: 2,
	Spectating: 3,
	Idle: 4,
	/** Tag: this player is IT. */
	Tagger: 5,
	/** Tag: running from IT. */
	Runner: 6,
	/** Zombies: alive in the round. */
	Alive: 7,
	/** Zombies: down, waiting for the next checkpoint. */
	Down: 8,
	/** Hide and seek: hiding this round. */
	Hider: 9,
	/** Hide and seek: seeking (picked at round start or found). */
	Seeker: 10,
	/** Infected: Patient Zero (the first infected, until the first infection). */
	Alpha: 11,
	/** Infected: turned player hunting with claws and throwing knife. */
	Infected: 12
} as const;
export type Status = (typeof Status)[keyof typeof Status];

/** State flag bits. */
export const FLAG_DUCKED = 1;
export const FLAG_ON_GROUND = 2;
/** Set on the first state packet after a teleport (restart, !back, trigger). */
export const FLAG_TELEPORTED = 4;
/**
 * 8-bit wrapping teleport generation packed above the three low flags in memory. Incremented by the
 * sender on every teleport so the change survives 64->32 Hz server relay
 * overwriting and dropped snapshots.
 */
export const FLAG_TELEPORT_SEQ_SHIFT = 3;
export const FLAG_TELEPORT_SEQ_MASK = 0xff << FLAG_TELEPORT_SEQ_SHIFT;

export function teleportSeq(flags: number): number {
	return (flags & FLAG_TELEPORT_SEQ_MASK) >>> FLAG_TELEPORT_SEQ_SHIFT;
}

export function withTeleportSeq(flags: number, seq: number): number {
	return (flags & ~FLAG_TELEPORT_SEQ_MASK) | ((seq & 0xff) << FLAG_TELEPORT_SEQ_SHIFT);
}

export type VoteOption = { kind: 'map'; mapId: string } | { kind: 'extend' };

export interface PlayerInfo {
	id: number;
	name: string;
	spectating: boolean;
	/** Equipped cosmetics; absent when nothing is equipped (and on older servers). Use `sanitizeLoadout`. */
	loadout?: Loadout;
}

export interface ScoreRow {
	id: number;
	name: string;
	rank: number | null; // map rank, null = no PB
	pbTicks: number | null;
	status: Status;
	stage: number; // current stage/checkpoint for status text
	ping: number;
	spectating: boolean;
	/** Tag: seconds not being IT this round (absent in race modes). */
	score?: number;
	/** Tag: this player is IT. */
	it?: boolean;
	/** Server-side admin (docs/gameplay.md#admin); set only by the server, never by the client. */
	admin?: boolean;
	/** Zombies: kills and downs this round. */
	kills?: number;
	deaths?: number;
	/**
	 * Account totals, any mode (docs/gameplay.md#points-and-playtime): lifetime
	 * earned points (not the spendable balance) and seconds online. Null for
	 * guests, absent on older servers: shown as a dash.
	 */
	pointsTotal?: number | null;
	playtimeSecs?: number | null;
	/** Whole coins the account has now, rounded down; null and absent as above. */
	coins?: number | null;
}

/** One of the richest accounts of the server (Tab scoreboard). */
export interface RichEntry {
	name: string;
	/** Whole coins, rounded down. */
	coins: number;
	/** Connected now. */
	online: boolean;
}

/** Entries in `scoreboard.richest`. */
export const RICHEST = 5;

/**
 * Mode-specific state for non-race gamemodes (docs/modes.md). Sent on every
 * change and once per second; race modes never send it.
 */
export interface TagModeState {
	mode: 'tag';
	phase: TagPhase;
	round: number;
	/** Seconds until the round ends (playing) or starts (countdown); 0 while waiting. */
	timeLeft: number;
	it: number[];
	/** Players with tag-back immunity. */
	immune: number[];
	scores: TagScore[];
}

/** Zombies round state (docs/modes.md#zombies). */
export interface ZombiesModeState extends ZmStateView {
	mode: 'zombies';
}

/** Infected round state (docs/modes.md#infected). */
export interface InfectedModeState extends InfStateView {
	mode: 'infected';
}

/** Hide and seek round state (docs/modes.md#hide-and-seek). */
export interface HnsModeState extends HnsStateView {
	mode: 'hns';
}

export type ModeState = TagModeState | ZombiesModeState | InfectedModeState | HnsModeState;

/** One line of a map's leaderboard. */
export interface RecordEntry {
	/** 1-based; ties share the better rank. */
	rank: number;
	name: string;
	ticks: number;
	/** The receiving player's own time. */
	self?: boolean;
}

/** Leaderboard entries in `MapRecordInfo.top`. */
export const RECORDS_TOP = 10;

export interface MapRecordInfo {
	pbTicks: number | null;
	pbSplits: number[] | null;
	rank: number | null;
	recordTicks: number | null;
	recordName: string | null;
	/** Race maps: the first RECORDS_TOP times (absent on older servers and in other modes). */
	top?: RecordEntry[];
}

export type ClientMessage =
	| {
			type: 'hello';
			playerId: string;
			/** Guest name; ignored when `token` logs the player in (the username is used). */
			name: string;
			version: number;
			/** Session token from an earlier `auth` reply: auto-login. */
			token?: string;
	  }
	/** Accounts (docs/gameplay.md#accounts-and-identity): work on the open socket, answered with `auth`. */
	| { type: 'register'; username: string; password: string }
	| { type: 'login'; username: string; password: string }
	| { type: 'logout' }
	| { type: 'zone'; kind: 'start' | 'stage' | 'checkpoint' | 'end'; index: number; tick: number }
	| { type: 'chat'; text: string }
	| { type: 'vote'; option: number } // 1-based option index
	/** Same as `rtvRequest` without a nomination (`!rtv`). */
	| { type: 'rtv' }
	/** Start an RTV request (docs/gameplay.md#map-rotation-and-voting), optionally nominating a map; on an open request: a yes vote. */
	| { type: 'rtvRequest'; mapId?: string }
	/** Answer the open RTV request (keys 1 = yes, 2 = no). */
	| { type: 'rtvVote'; yes: boolean }
	| { type: 'changeMap'; mapId: string } // lone player only (docs/gameplay.md)
	| { type: 'spectate'; targetId: number | null } // null = leave spectate
	| { type: 'name'; name: string }
	| { type: 'ping'; t: number }
	| { type: 'pong'; t: number }
	/** Race maps: ask for the map's record ghost; answered with a BIN_GHOST frame (docs/gameplay.md#ghosts). */
	| { type: 'getGhost'; map: string }
	/**
	 * Zombies (docs/modes.md#zombies): a shot or knife swing. `origin` is the eye,
	 * `dir` a unit vector, `tick` the zombie sim tick the shooter was looking at
	 * (from BIN_ZOMBIES, interpolated) for lag compensation.
	 */
	| { type: 'spawnAck'; seq: number }
	| { type: 'fire'; weapon: WeaponId; origin: Vec3; dir: Vec3; tick: number; renderServerTimeMs?: number }
	| { type: 'reload' }
	/** Zombies: pick the weapon for this life (only while the loadout window is open). */
	| { type: 'loadout'; weapon: WeaponId }
	/** Infected: throw a throwing knife from eye `origin` along unit `dir`. */
	| { type: 'throwKnife'; origin: Vec3; dir: Vec3; renderServerTimeMs?: number }
	/** Infected: place a respawn beacon at the feet. */
	| { type: 'placeBeacon' }
	/** Infected: a survivor calls their earned M.O.A.B. (kill streak; detonates after a countdown). */
	| { type: 'callMoab' }
	/**
	 * Hide and seek (docs/modes.md#hide-and-seek): a seeker's knife swing.
	 * `origin` is the eye, `dir` a unit vector; the server resolves the hit
	 * (lag-compensated against the hiders' recent positions).
	 */
	| { type: 'knife'; origin: Vec3; dir: Vec3; renderServerTimeMs?: number }
	/** Shop (docs/economy.md#shop): answered with `shopResult` and, on success, a fresh `shop`. */
	| { type: 'shopBuy'; item: string }
	/** Buy and open a loot box: answered with `boxResult`. Only when `shop.box` was sent. */
	| { type: 'boxOpen' }
	/** The opener has seen the result of the last box: the server tells everyone (`boxNews`). Ignored without one. */
	| { type: 'boxRevealed' }
	/** Wear an owned item, or `null` for the slot's default. */
	| { type: 'shopEquip'; slot: CosmeticSlot; item: string | null }
	/** Casino (docs/economy.md#casino), only when `casino` was sent; `bet` in whole coins. Answered with `casinoResult` (crash: `crashStart`, then `casinoResult` at its end). */
	| { type: 'casinoBet'; game: 'coinflip'; bet: number; side: CoinSide }
	| { type: 'casinoBet'; game: 'slots'; bet: number }
	/** `auto`: cash out by itself at this multiplier (hundredths); null: only by hand. */
	| { type: 'casinoBet'; game: 'crash'; bet: number; auto: number | null }
	/** Cash out the running crash round; counts when the server receives it. */
	| { type: 'crashCashout' }
	/** Admin menu (docs/gameplay.md#admin): re-checked on the server, ignored for non-admins. */
	| { type: 'admin'; action: AdminAction };

/** Admin requests; every one is answered with `adminResult` and (for admins) `adminState`. */
export type AdminAction =
	| { action: 'setMapEnabled'; mapId: string; enabled: boolean }
	/** Ban a connected player (`targetId` = lobby id) or an account by username (offline ban). */
	| { action: 'ban'; targetId?: number; username?: string; reason?: string }
	| { action: 'unban'; banId: number }
	/** Change to any map at once (disabled ones too). */
	| { action: 'forceMap'; mapId: string }
	/** Add ADMIN_EXTEND seconds to the current map. */
	| { action: 'extend' }
	/** Change an account's coin balance (docs/economy.md#admin-changes); `amount` is whole coins, not used by `reset`. */
	| { action: 'coins'; username: string; op: 'add' | 'subtract' | 'reset'; amount?: number }
	/** Give a cosmetic item to a connected account (`targetId` = lobby id). */
	| { action: 'giveItem'; targetId: number; item: string }
	/** Take an owned item away from a connected account (no refund). */
	| { action: 'takeItem'; targetId: number; item: string }
	/** Just ask for a fresh `adminState`. */
	| { action: 'listBans' };

/** Seconds the admin "extend" button adds. */
export const ADMIN_EXTEND = 10 * 60;
/** Most coins one admin `coins` action adds or takes. */
export const ADMIN_COINS_MAX = 100_000;
/** Max length of a ban reason. */
export const MAX_BAN_REASON = 128;

export interface AdminMapInfo {
	id: string;
	title: string;
	kind: GameModeId;
	/** Map size tag, for maps that come in several sizes (MapDef.size). */
	size?: MapDef['size'];
	enabled: boolean;
}

export interface AdminBanInfo {
	id: number;
	/** Account username or guest name at ban time. */
	username: string;
	/** 'account' = account ban; 'guest' = player key (and IP when known). */
	kind: 'account' | 'guest';
	reason: string | null;
	createdAt: number;
	createdBy: string;
	/** Seconds until the ban lifts by itself; absent: permanent. */
	secondsLeft?: number;
}

/** A warning or ban of the abuse detection (docs/economy.md#abuse-and-collusion). */
export interface AdminAbuseInfo {
	id: number;
	createdAt: number;
	username: string;
	/** 'exempt': an admin account that would have been banned. */
	action: 'warning' | 'ban' | 'exempt';
	strikes: number;
	/** What was seen, one line. */
	evidence: string;
}

export interface AdminPlayerInfo {
	id: number;
	name: string;
	/** Account username when logged in. */
	account?: string;
	guest: boolean;
	/** Admins cannot be banned. */
	admin: boolean;
	/** Balance of the account in tenths (absent for guests and on older servers). */
	coins?: number;
	/** Item ids the account owns (absent for guests and on older servers). */
	items?: string[];
}

export interface AdminState {
	maps: AdminMapInfo[];
	bans: AdminBanInfo[];
	players: AdminPlayerInfo[];
	/** Latest automatic warnings and bans, newest first (absent on older servers). */
	abuse?: AdminAbuseInfo[];
}

/** One line of the account's point log. */
export interface PointLogEntry {
	/** Wall clock (ms). */
	at: number;
	/** Reason id (economy.ts AWARDS); `shop:<item>` for purchases, `casino:<game>` for bets. */
	reason: string;
	/** Display text. */
	label: string;
	/** Tenths of a point; negative for purchases and lost bets. */
	amount: number;
	/** Multiplier in tenths. */
	mult: number;
}

/** Entries in `coins.recent`. */
export const RECENT_AWARDS = 30;

export type ServerMessage =
	| { type: 'serverIdentity'; serverId: string }
	| {
			type: 'welcome';
			version: number;
			/** Stable SQLite identity, absent on older servers. */
			serverId?: string;
			selfId: number;
			map: string;
			/** Gamemode of `map` (optional for old servers: derive from the map). */
			mode?: GameModeId;
			mapTimeLeft: number; // seconds
			players: PlayerInfo[];
			cvars: Partial<Cvars>;
			records: MapRecordInfo;
			/** Logged-in account (hello token accepted), null for guests. Absent on old servers. */
			account?: AccountInfo | null;
			/** Server monotonic clock (ms) when `welcome` was sent (clock sync seed). */
			serverTime?: number;
			/** Active server snapshot rate (Hz); defaults to SNAPSHOT_HZ when absent. */
			snapshotHz?: number;
	  }
	| { type: 'full' }
	| { type: 'join'; player: PlayerInfo }
	| { type: 'leave'; id: number }
	| { type: 'rename'; id: number; name: string }
	| { type: 'spectating'; id: number; spectating: boolean; targetId: number | null }
	| {
			type: 'chat';
			from: string | null;
			fromId: number | null;
			text: string;
			system?: boolean;
			/** Sender is a server admin (set by the server; drives the chat marker). */
			admin?: boolean;
	  }
	| {
			type: 'runResult';
			ticks: number;
			rank: number;
			pb: boolean; // new PB
			record: boolean; // new map record
			splits: number[];
			records: MapRecordInfo;
	  }
	| { type: 'runRejected'; reason: string }
	/**
	 * The map's leaderboard changed (someone else set a PB or the record):
	 * this player's records on `map` (own PB/rank, map record) right now.
	 */
	| { type: 'records'; map: string; records: MapRecordInfo }
	| { type: 'voteStart'; options: VoteOption[]; duration: number; rtv: boolean }
	| { type: 'voteUpdate'; counts: number[] }
	| { type: 'voteEnd'; winner: VoteOption; countdown: number }
	/**
	 * RTV request opened (`started`) or its counts changed; also sent on join
	 * while one is open. `duration`: seconds left. Passes at `yes >= needed`.
	 */
	| {
			type: 'rtvRequest';
			started: boolean;
			initiatorId: number;
			initiator: string;
			mapId: string | null;
			duration: number;
			yes: number;
			no: number;
			needed: number;
	  }
	/** RTV request closed; when passed a `voteStart` follows. `cooldown`: seconds until the next request (declines). */
	| { type: 'rtvRequestEnd'; passed: boolean; reason: 'passed' | 'timeout' | 'rejected' | 'cancelled'; cooldown: number }
	/** No RTV request for `seconds` (map-start block or decline cooldown); sent on join and map change while it applies. */
	| { type: 'rtvCooldown'; seconds: number; reason: 'declined' | 'mapStart' }
	| {
			type: 'mapChange';
			map: string;
			mode?: GameModeId;
			mapTimeLeft: number;
			cvars: Partial<Cvars>;
			records: MapRecordInfo;
	  }
	| ({ type: 'modeState' } & ModeState)
	| { type: 'tagged'; by: number; target: number }
	/** Zombies event (spawn/teleport, hit marker, kill feed, tracer, hurt, down, checkpoint, ammo, round end). */
	| { type: 'zm'; ev: ZmEvent; spawnSeq?: number }
	/** Infected event (spawn, alpha, infect, hit, kill, shot, hurt, ammo, throwing knife, UAV pulse, round end). */
	| { type: 'inf'; ev: InfEvent; spawnSeq?: number }
	/** Hide and seek event (spawn/teleport to that player; swing, found, round flow to everyone). */
	| { type: 'hns'; ev: HnsEvent; spawnSeq?: number }
	| { type: 'timeLeft'; mapTimeLeft: number }
	/** `richest`: the accounts with the most coins, richest first, online or not (absent on older servers). */
	| { type: 'scoreboard'; rows: ScoreRow[]; richest?: RichEntry[] }
	| { type: 'ping'; t: number }
	/** Reply to a client `ping`: echoes `t` and carries the server monotonic time (ms). */
	| { type: 'pong'; t: number; serverTime: number }
	/**
	 * Reply to register/login/logout, or to a rejected hello token.
	 * ok with a username: logged in (`token` is new on register/login);
	 * ok with username null: logged out. `records` are the player's race
	 * records on the current map after the change.
	 */
	| { type: 'auth'; ok: true; username: string | null; token?: string; records?: MapRecordInfo; admin?: boolean }
	| { type: 'auth'; ok: false; error: string }
	/** Maps players may pick (votes, Change map): sent after `welcome` and to everyone on every change. */
	| { type: 'maps'; enabled: string[] }
	/** Admins only: reply to an `admin` request, and pushed when players or bans change. */
	| ({ type: 'adminState' } & AdminState)
	| { type: 'adminResult'; ok: boolean; error?: string; message?: string }
	/**
	 * Sent right before close code 4009: the client stops reconnecting until
	 * reload, or for `seconds` when the ban lifts by itself.
	 */
	| { type: 'banned'; reason: string | null; seconds?: number }
	/**
	 * Points and coins (docs/economy.md#wire). All optional: older clients
	 * ignore them, newer clients do without. Amounts are tenths of a point.
	 * `coins`: the account's totals and latest log entries, after `welcome`,
	 * `auth` and purchases.
	 */
	| { type: 'coins'; total: number; balance: number; recent: PointLogEntry[] }
	/** The account earned something. */
	| ({ type: 'award'; total: number; balance: number; base: number } & PointLogEntry)
	/** Current multiplier (tenths), active players and the number this mode needs to pay (0: none). On join and every change. */
	| { type: 'multiplier'; mult: number; active: number; need: number }
	/** Private notice about coins (guest hint, abuse warning), shown with the award popups. */
	| { type: 'coinsNotice'; text: string; tone: 'info' | 'warn' }
	/**
	 * Shop (docs/economy.md#shop), optional like the coins messages: what the
	 * server sells (tenths of a coin), and what this account owns and wears
	 * (empty for guests). After `welcome`, `auth` and every change.
	 */
	| { type: 'shop'; items: ShopOffer[]; owned: string[]; loadout: Loadout; box?: BoxOffer }
	/** Reply to `shopBuy` (`item` bought) and `shopEquip`; `error` is for display. */
	| { type: 'shopResult'; action: 'buy' | 'equip'; item: string | null; ok: boolean; error?: string }
	/** Reply to `boxOpen`, rolled by the server. `refund`: tenths given back because it was already owned. */
	| { type: 'boxResult'; ok: true; item: string; duplicate: boolean; refund: number }
	| { type: 'boxResult'; ok: false; error: string }
	/** A player opened a loot box and has seen the result (to everyone, the opener included). Item ids may be unknown. */
	| { type: 'boxNews'; id: number; name: string; item: string; duplicate: boolean }
	/** A player won big in the casino (`casinoNewsTier`), to everyone, the winner included. Tenths of a coin. */
	| { type: 'casinoNews'; id: number; name: string; game: CasinoGame; bet: number; payout: number }
	/** What the holder of the map's record ghost wears (with the ghost frame). Use `sanitizeLoadout`. */
	| { type: 'ghostLook'; map: string; loadout: Loadout }
	/** A player's equipped cosmetics changed (to everyone, the player included). Use `sanitizeLoadout`. */
	| { type: 'cosmetics'; id: number; loadout: Loadout }
	/**
	 * Casino (docs/economy.md#casino), optional like the shop: after `welcome` and
	 * `auth`. `min` and `max` are whole coins, every other amount is tenths. Guests
	 * get no results. `crash`: the round that is still running.
	 */
	| { type: 'casino'; min: Record<CasinoGame, number>; max: number; net: number; recent: CasinoEntry[]; crash?: { bet: number; auto: number | null; elapsed: number } }
	/** A crash round has started: the bet is taken, the multiplier climbs from now on. */
	| { type: 'crashStart'; bet: number; auto: number | null }
	/** A settled bet. `net`: won minus bet of the account, all time. */
	| ({ type: 'casinoResult'; ok: true; net: number } & CasinoOutcome)
	/** `error` is for display. `game` null: an unknown game. */
	| { type: 'casinoResult'; ok: false; game: CasinoGame | null; error: string };

/** A settled casino bet; tenths. */
export interface CasinoEntry {
	at: number;
	game: CasinoGame;
	bet: number;
	payout: number;
}

export type CasinoOutcome = { bet: number; payout: number } & (
	| { game: 'coinflip'; picked: CoinSide; side: CoinSide }
	| { game: 'slots'; reels: SlotReels }
	/** Hundredths. `at`: where it was cashed out, null when it crashed first; `crash`: where the round ended. */
	| { game: 'crash'; at: number | null; crash: number }
);

/** The loot box the server sells (docs/economy.md#loot-box). */
export interface BoxOffer {
	/** Tenths of a coin. */
	price: number;
	/** Weight per rarity (lootChances). */
	odds: Partial<Record<RarityId, number>>;
	/** Ids of everything it can hold. */
	items: string[];
}

export interface ShopOffer {
	id: string;
	/** Tenths of a coin. */
	price: number;
}

export interface AccountInfo {
	username: string;
	/** Admin account (server config ADMIN_USERNAMES); only used to show the admin menu. */
	admin?: boolean;
}

// ---------------------------------------------------------------------------
// Binary frames
// ---------------------------------------------------------------------------

export const BIN_STATE = 1;
export const BIN_SNAPSHOT = 2;
/**
 * S->C record ghost for a map (docs/gameplay.md#ghosts), the reply to
 * `getGhost` and pushed on a new record. Layout and helpers: ./ghost.ts.
 */
export const BIN_GHOST = 3;

export interface NetState {
	/** Last applied server spawn, echoed in every client state. Zero means none. */
	spawnSeq?: number;
	/** Last server timestamp rendered by this client, sent in combat states. */
	renderServerTimeMs?: number;
	tick: number;
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	pitch: number;
	yaw: number;
	flags: number;
	status: Status;
	stage: number;
	runTicks: number;
}

const STATE_BODY = 4 + 4 * 8 + 1 + 1 + 1 + 4 + 2 + 1; // 46
export const STATE_SIZE = 1 + STATE_BODY;
const TIMED_STATE_SIZE = STATE_SIZE + 8;

/** Snapshot v2 position quantisation: int24 at 1/8 unit (±1,048,576 u covers all maps). */
export const SNAP_POS_SCALE = 8;
const I24_MIN = -8388608;
const I24_MAX = 8388607;
export const SNAP_POS_MIN = I24_MIN / SNAP_POS_SCALE;
export const SNAP_POS_MAX = I24_MAX / SNAP_POS_SCALE;
export const SNAP_VEL_MIN = -32768;
export const SNAP_VEL_MAX = 32767;
/** u24 runTicks covers 72.8 hours at 64 Hz. */
export const SNAP_RUN_TICKS_MAX = 0xffffff;
const SNAP_ANGLE_SCALE = 65536 / 360;

/** Snapshot header flag: entries include race `stage` (u8) + `runTicks` (u24). */
export const SNAP_FLAG_RACE = 1;
/** Snapshot header flag: entries carry server-assigned sample times. */
const SNAP_FLAG_SAMPLE_TIME = 2;
const SNAP_SOURCE_IDLE = 0x80;
const SNAP_SAMPLE_SCALE = 8; // 1/8 ms per signed 24-bit offset
const SNAP_SAMPLE_BYTES = 3;
/** Snapshot header: u8 kind, u8 flags, u8 count, u16 seq, f64 serverTimeMs. */
export const SNAPSHOT_HEADER_SIZE = 13;
/** Per-entry bytes without race fields: u16 id, u32 tick, 3×i24 pos, 3×i16 vel, 2×u16 ang, u8 flags, u8 status, u8 teleport generation. */
export const SNAPSHOT_ENTRY_BASE = 28;
/** Per-entry bytes with race fields (+ u8 stage, u24 runTicks). */
export const SNAPSHOT_ENTRY_RACE = 32;

function toDataView(buf: ArrayBuffer | Uint8Array): DataView {
	return buf instanceof Uint8Array ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength) : new DataView(buf);
}

function writeBody(v: DataView, o: number, s: NetState): number {
	v.setUint32(o, s.tick >>> 0, true);
	v.setFloat32(o + 4, s.x, true);
	v.setFloat32(o + 8, s.y, true);
	v.setFloat32(o + 12, s.z, true);
	v.setFloat32(o + 16, s.vx, true);
	v.setFloat32(o + 20, s.vy, true);
	v.setFloat32(o + 24, s.vz, true);
	v.setFloat32(o + 28, s.pitch, true);
	v.setFloat32(o + 32, s.yaw, true);
	v.setUint8(o + 36, s.flags & ~FLAG_TELEPORT_SEQ_MASK);
	v.setUint8(o + 37, s.status & 0xff);
	v.setUint8(o + 38, s.stage & 0xff);
	v.setUint32(o + 39, s.runTicks >>> 0, true);
	v.setUint16(o + 43, s.spawnSeq ?? 0, true);
	v.setUint8(o + 45, teleportSeq(s.flags));
	return o + STATE_BODY;
}

function readBody(v: DataView, o: number): NetState {
	const spawnSeq = v.getUint16(o + 43, true);
	return {
		...(spawnSeq === 0 ? {} : { spawnSeq }),
		tick: v.getUint32(o, true),
		x: v.getFloat32(o + 4, true),
		y: v.getFloat32(o + 8, true),
		z: v.getFloat32(o + 12, true),
		vx: v.getFloat32(o + 16, true),
		vy: v.getFloat32(o + 20, true),
		vz: v.getFloat32(o + 24, true),
		pitch: v.getFloat32(o + 28, true),
		yaw: v.getFloat32(o + 32, true),
		flags: withTeleportSeq(v.getUint8(o + 36), v.getUint8(o + 45)),
		status: v.getUint8(o + 37) as Status,
		stage: v.getUint8(o + 38),
		runTicks: v.getUint32(o + 39, true)
	};
}

export function encodeState(s: NetState): ArrayBuffer {
	const renderTime = s.renderServerTimeMs;
	const buf = new ArrayBuffer(renderTime === undefined ? STATE_SIZE : TIMED_STATE_SIZE);
	const v = new DataView(buf);
	v.setUint8(0, BIN_STATE);
	writeBody(v, 1, s);
	if (renderTime !== undefined) v.setFloat64(STATE_SIZE, renderTime, true);
	return buf;
}

export function decodeState(buf: ArrayBuffer | Uint8Array): NetState | null {
	if (buf.byteLength !== STATE_SIZE && buf.byteLength !== TIMED_STATE_SIZE) return null;
	const v = toDataView(buf);
	if (v.getUint8(0) !== BIN_STATE) return null;
	const s = readBody(v, 1);
	if (
		!Number.isFinite(s.x) ||
		!Number.isFinite(s.y) ||
		!Number.isFinite(s.z) ||
		!Number.isFinite(s.vx) ||
		!Number.isFinite(s.vy) ||
		!Number.isFinite(s.vz) ||
		!Number.isFinite(s.pitch) ||
		!Number.isFinite(s.yaw)
	) {
		return null;
	}
	if (v.byteLength === TIMED_STATE_SIZE) {
		const renderTime = v.getFloat64(STATE_SIZE, true);
		if (Number.isFinite(renderTime)) s.renderServerTimeMs = renderTime;
	}
	return s;
}

export interface SnapshotEntry extends NetState {
	id: number;
	/** Server-assigned pose time in ms. Absent on v2 snapshots. */
	sampleTimeMs?: number;
	/** The sender's tick is stalled or slow, as seen by the relay. */
	sourceIdle?: boolean;
}

export interface SnapshotFrame {
	/** 16-bit wrapping snapshot sequence number (0..65535). */
	seq: number;
	/** Server monotonic timestamp (ms) when this snapshot was built. */
	serverTimeMs: number;
	entries: SnapshotEntry[];
}

function clampI24(n: number): number {
	return Math.max(I24_MIN, Math.min(I24_MAX, n));
}

function writeI24(v: DataView, o: number, n: number): void {
	n = clampI24(n);
	v.setUint8(o, n & 0xff);
	v.setUint8(o + 1, (n >> 8) & 0xff);
	v.setUint8(o + 2, (n >> 16) & 0xff);
}

function readI24(v: DataView, o: number): number {
	const u = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16);
	return (u << 8) >> 8;
}

/** Normalize to the wire time. Round absolute ticks before subtraction to keep repeated samples stable. */
export function snapshotSampleTimeMs(sampleMs: number, frameMs: number): number {
	const base = Math.round(frameMs * SNAP_SAMPLE_SCALE);
	const delta = Math.round(sampleMs * SNAP_SAMPLE_SCALE) - base;
	return (base + clampI24(delta)) / SNAP_SAMPLE_SCALE;
}

function writeI16Clamped(v: DataView, o: number, val: number): void {
	let n = Math.round(val);
	if (n < SNAP_VEL_MIN) n = SNAP_VEL_MIN;
	else if (n > SNAP_VEL_MAX) n = SNAP_VEL_MAX;
	v.setInt16(o, n, true);
}

function writeU24Clamped(v: DataView, o: number, val: number): void {
	let n = Math.round(val);
	if (n < 0) n = 0;
	else if (n > SNAP_RUN_TICKS_MAX) n = SNAP_RUN_TICKS_MAX;
	v.setUint8(o, n & 0xff);
	v.setUint8(o + 1, (n >>> 8) & 0xff);
	v.setUint8(o + 2, (n >>> 16) & 0xff);
}

function readU24(v: DataView, o: number): number {
	return v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16);
}

function packSnapAngle(deg: number): number {
	return Math.round(deg * SNAP_ANGLE_SCALE) & 0xffff;
}

function unpackSnapAngle(q: number): number {
	const d = q / SNAP_ANGLE_SCALE;
	return d > 180 ? d - 360 : d;
}

/**
 * At 32 players, snapshots with sample times use 1005 B (non-race) or
 * 1133 B (race). Untimed v2 snapshots use 909 B or 1037 B.
 */
export function encodeSnapshot(entries: readonly SnapshotEntry[], serverTimeMs = 0, seq = 0): ArrayBuffer {
	const count = Math.min(255, entries.length);
	let hasRace = false;
	let timed = false;
	for (let i = 0; i < count; i++) {
		const e = entries[i]!;
		if (e.stage !== 0 || e.runTicks !== 0) hasRace = true;
		if (e.sampleTimeMs !== undefined) timed = true;
	}
	const baseStride = hasRace ? SNAPSHOT_ENTRY_RACE : SNAPSHOT_ENTRY_BASE;
	const stride = baseStride + (timed ? SNAP_SAMPLE_BYTES : 0);
	const frameTime = Math.round(serverTimeMs * SNAP_SAMPLE_SCALE);
	const buf = new ArrayBuffer(SNAPSHOT_HEADER_SIZE + count * stride);
	const v = new DataView(buf);
	v.setUint8(0, BIN_SNAPSHOT);
	v.setUint8(1, (hasRace ? SNAP_FLAG_RACE : 0) | (timed ? SNAP_FLAG_SAMPLE_TIME : 0));
	v.setUint8(2, count);
	v.setUint16(3, seq & 0xffff, true);
	v.setFloat64(5, serverTimeMs, true);
	let o = SNAPSHOT_HEADER_SIZE;
	for (let i = 0; i < count; i++) {
		const e = entries[i]!;
		v.setUint16(o, e.id & 0xffff, true);
		v.setUint32(o + 2, e.tick >>> 0, true);
		writeI24(v, o + 6, Math.round(e.x * SNAP_POS_SCALE));
		writeI24(v, o + 9, Math.round(e.y * SNAP_POS_SCALE));
		writeI24(v, o + 12, Math.round(e.z * SNAP_POS_SCALE));
		writeI16Clamped(v, o + 15, e.vx);
		writeI16Clamped(v, o + 17, e.vy);
		writeI16Clamped(v, o + 19, e.vz);
		v.setUint16(o + 21, packSnapAngle(e.pitch), true);
		v.setUint16(o + 23, packSnapAngle(e.yaw), true);
		const flags = (e.flags & ~FLAG_TELEPORT_SEQ_MASK) | (timed && e.sourceIdle ? SNAP_SOURCE_IDLE : 0);
		v.setUint8(o + 25, flags);
		v.setUint8(o + 26, e.status & 0xff);
		v.setUint8(o + 27, teleportSeq(e.flags));
		if (hasRace) {
			v.setUint8(o + 28, e.stage & 0xff);
			writeU24Clamped(v, o + 29, e.runTicks);
		}
		if (timed) {
			const sampleTime = Math.round((e.sampleTimeMs ?? serverTimeMs) * SNAP_SAMPLE_SCALE);
			writeI24(v, o + baseStride, sampleTime - frameTime);
		}
		o += stride;
	}
	return buf;
}

export function decodeSnapshot(buf: ArrayBuffer | Uint8Array): SnapshotFrame | null {
	if (buf.byteLength < SNAPSHOT_HEADER_SIZE) return null;
	const v = toDataView(buf);
	if (v.getUint8(0) !== BIN_SNAPSHOT) return null;
	const snapFlags = v.getUint8(1);
	if ((snapFlags & ~(SNAP_FLAG_RACE | SNAP_FLAG_SAMPLE_TIME)) !== 0) return null;
	const hasRace = (snapFlags & SNAP_FLAG_RACE) !== 0;
	const timed = (snapFlags & SNAP_FLAG_SAMPLE_TIME) !== 0;
	const n = v.getUint8(2);
	const baseStride = hasRace ? SNAPSHOT_ENTRY_RACE : SNAPSHOT_ENTRY_BASE;
	const stride = baseStride + (timed ? SNAP_SAMPLE_BYTES : 0);
	if (buf.byteLength !== SNAPSHOT_HEADER_SIZE + n * stride) return null;
	const seq = v.getUint16(3, true);
	const serverTimeMs = v.getFloat64(5, true);
	if (!Number.isFinite(serverTimeMs)) return null;
	const frameTime = Math.round(serverTimeMs * SNAP_SAMPLE_SCALE);
	if (timed && !Number.isSafeInteger(frameTime)) return null;
	const entries: SnapshotEntry[] = new Array(n);
	let o = SNAPSHOT_HEADER_SIZE;
	for (let i = 0; i < n; i++) {
		const flags = v.getUint8(o + 25);
		entries[i] = {
			id: v.getUint16(o, true),
			tick: v.getUint32(o + 2, true),
			x: readI24(v, o + 6) / SNAP_POS_SCALE,
			y: readI24(v, o + 9) / SNAP_POS_SCALE,
			z: readI24(v, o + 12) / SNAP_POS_SCALE,
			vx: v.getInt16(o + 15, true),
			vy: v.getInt16(o + 17, true),
			vz: v.getInt16(o + 19, true),
			pitch: unpackSnapAngle(v.getUint16(o + 21, true)),
			yaw: unpackSnapAngle(v.getUint16(o + 23, true)),
			flags: withTeleportSeq(flags & ~SNAP_SOURCE_IDLE, v.getUint8(o + 27)),
			status: v.getUint8(o + 26) as Status,
			stage: hasRace ? v.getUint8(o + 28) : 0,
			runTicks: hasRace ? readU24(v, o + 29) : 0,
			...(timed ? {
				sampleTimeMs: (frameTime + readI24(v, o + baseStride)) / SNAP_SAMPLE_SCALE,
				sourceIdle: (flags & SNAP_SOURCE_IDLE) !== 0
			} : {})
		};
		o += stride;
	}
	return { seq, serverTimeMs, entries };
}

/** Format ticks as mm:ss.mmm. */
export function formatTicks(ticks: number, tickRate = TICK_RATE): string {
	const ms = Math.round((ticks / tickRate) * 1000);
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	const r = ms % 1000;
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

/** Strip control chars and trim; limit length. HTML-escaping is done at render time. */
export function sanitizeText(text: string, max: number): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
