/**
 * Game orchestration: fixed-tick simulation, input/binds, console, run
 * tracking, solo rotation, networking, spectating, audio and rendering.
 * The UI only sees `hud` and `api` (contract.ts).
 */
import {
	buildCollisionWorld,
	createPlayer,
	DEFAULT_MAP_ID,
	DUCK_VIEW_HEIGHT,
	encodeState,
	eyeHeight,
	FLAG_DUCKED,
	FLAG_ON_GROUND,
	FLAG_TELEPORTED,
	formatTenths,
	formatTicks,
	getMap,
	HNS_MAX_REWIND_MS,
	hullInBox,
	INF_HISTORY_MS,
	CLOSE_IP_LIMIT,
	MAP_IDS,
	mapCvars,
	modeOf,
	MAPS,
	MAX_CHAT,
	MAX_REWIND_RTT_MS,
	MAX_TICKS_PER_FRAME,
	HULL_MIN,
	DUCK_HULL_MAX,
	playerMaxs,
	PROTOCOL_VERSION,
	CLOSE_PROTOCOL_MISMATCH,
	passwordError,
	playerMove,
	playerRest,
	renderTimeBudgetMs,
	usernameError,
	mapTitle,
	sanitizeLoadout,
	sanitizeText,
	Status,
	SURF_CVARS,
	SV_BOOL_CVARS,
	TICK_INTERVAL,
	TICK_RATE,
	VIEW_HEIGHT,
	withTeleportSeq,
	ZM_HISTORY_MS,
	type AdminAction,
	type ClientMessage,
	type CollisionWorld,
	type Cvars,
	type GameModeDef,
	type Loadout,
	type Spawn,
	type MapDef,
	type MapRecordInfo,
	type NetState,
	type PlayerInfo,
	type PlayerState,
	type ScoreRow,
	type ServerMessage,
	type SnapshotFrame,
	type UserCmd,
	type Vec3
} from '@surf/shared';
import { GameAudio } from '../audio/audio.js';
import { GameFullscreen } from '../input/fullscreen.js';
import { isBrowserShortcut } from '../input/guard.js';
import { Input } from '../input/input.js';
import { isMoveAction, SubtickSampler } from '../input/subtick.js';
import { AdaptiveDelay } from '../net/adaptive.js';
import type { NetClient } from '../net/client.js';
import { ServerClock } from '../net/clock.js';
import { Connection } from '../net/connection.js';
import { sameOriginWsUrl, serverOverride } from '../net/discovery.js';
import { emptySample, SnapshotBuffer, type Sample } from '../net/interp.js';
import { NetStats } from '../net/stats.js';
import { emptyPose } from '../render/players.js';
import { GameRenderer } from '../render/renderer.js';
import { Binds } from './binds.js';
import { CHAT_HELP, parseChatCommand } from './chat.js';
import { cvarFallback, HOLD_ACTIONS, registerCommands, type CommandContext, type HoldAction } from './commands.js';
import { casinoError, casinoResult, crashStarted, parseCasino } from './casino.js';
import { parseShop, shopNotice } from './shop.js';
import { CharacterPreview, disposeItemPictures, itemPicture, warmItemPictures } from '../render/character/preview.js';
import { parseBoxNews, parseCasinoNews, pushBoxNews } from './box-news.js';
import { applyAward, awardPopup, countdown, noticePopup, pushPopup } from './coins.js';
import { DevConsole, type PrintKind } from './console.js';
import type { CharacterPreviewHandle, ChatLine, ConsoleLine, GameApi } from './contract.js';
import { ClientCvars } from './cvars.js';
import { HudState } from './hud.svelte.js';
import {
	cleanName,
	clearSession,
	isGuest,
	loadName,
	loadPlayerId,
	loadSession,
	saveName,
	saveSession,
	setGuest,
	type StoredSession
} from './identity.js';
import { FixedStep } from './loop.js';
import { browserGhostStore, type GhostStore } from './ghost-store.js';
import { kickedPitch, zoomFov, zoomSensitivity } from './gunfeel.js';
import { createClientMode, startSpawn } from './modes/index.js';
import type { ClientMode, ClientModeHost, ModeView } from './modes/types.js';
import { loadSoloPb, mergeRecordsPush, recordFields, saveSoloPb, type LocalPb } from './records.js';
import { cycleTarget, findTargetByName, specTargets } from './spectate.js';
import { browserStore, STORAGE_KEYS, type KeyValueStore } from './storage.js';
import { findMap, mapLabel } from './map-label.js';

const FREEFLY_SPEED = 1000;
/** Camera of a mode without effects. */
const NO_VIEW: Readonly<ModeView> = Object.freeze({ zoomFov: 0, zoomT: 0, kickPitch: 0, kickYaw: 0, kickRoll: 0 });
const MAX_CHAT_LINES = 100;
const MAX_CONSOLE_LINES = 500;
/** Scoreboard row id of the local player offline. */
const SOLO_ROW_ID = 0;
const FULL_HOLDOFF_MS = 60_000;
const VERSION_HOLDOFF_MS = 60_000;
/** Reconnect this long after a temporary ban lifted (clock and timer slack). */
const BAN_RECONNECT_MS = 1_000;
/** The shop stops waiting for a reply after this long. */
const SHOP_TIMEOUT_MS = 6_000;
const SV_NAMES = Object.keys(SURF_CVARS) as Array<keyof Cvars>;
const SV_BOOL = SV_BOOL_CVARS;

interface Remote {
	id: number;
	name: string;
	spectating: boolean;
	buf: SnapshotBuffer;
	sample: Sample;
	hasSample: boolean;
}

interface Spectate {
	targetId: number | null;
	freeFly: boolean;
	pos: Vec3; // free-fly camera eye
}

function vlerp(a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 {
	out.x = a.x + (b.x - a.x) * t;
	out.y = a.y + (b.y - a.y) * t;
	out.z = a.z + (b.z - a.z) * t;
	return out;
}

type RunTrackerPhase = 'start' | 'running' | 'finished' | 'idle';

function statusPhase(s: number): RunTrackerPhase {
	if (s === Status.StartZone) return 'start';
	if (s === Status.Running) return 'running';
	if (s === Status.Finished) return 'finished';
	return 'idle';
}

/**
 * First solo map: `?map=<id>` when it names a known map (rotation or sandbox),
 * else DEFAULT_MAP_ID. A server's welcome still switches to the server's map.
 */
export function initialMapId(search: string, lastMap: string | null = null): string {
	try {
		const id = new URLSearchParams(search).get('map')?.trim();
		if (id && getMap(id)) return id;
	} catch {
		// malformed query: last or default map
	}
	return lastMap && getMap(lastMap) ? lastMap : DEFAULT_MAP_ID;
}

export class Game implements CommandContext {
	readonly hud = new HudState();
	readonly api: GameApi;
	readonly cvars: ClientCvars;
	readonly binds: Binds;
	private store: KeyValueStore = browserStore;
	private con: DevConsole;
	private input: Input;
	private fullscreen: GameFullscreen;
	/** The refused-keyboard-lock notice was shown. */
	private lockRefused = false;
	private renderer: GameRenderer | null = null;
	private audio = new GameAudio();
	private conn: Connection;
	private step = new FixedStep(TICK_RATE, MAX_TICKS_PER_FRAME);
	private raf = 0;
	private lastFrame = -1;
	private disposed = false;
	private offCvars: () => void;
	private lineId = 0;

	// Identity
	private playerId: string;
	/** Stored session (token + username); the server confirms it on welcome. */
	private session: StoredSession | null = null;
	private sessionScope: string | null = null;
	/** Token sent in the current connection's hello (to detect a rejected session). */
	private helloToken: string | null = null;

	// Map and simulation
	private map!: MapDef;
	private world!: CollisionWorld;
	private player!: PlayerState;
	/** Gamemode of the loaded map (docs/modes.md). */
	private gameMode: GameModeDef = modeOf({ kind: 'surf' });
	/** Everything that mode decides. */
	private client!: ClientMode;
	private readonly modeHost = this.createModeHost();
	private sv: Cvars = { ...SURF_CVARS };
	private tick = 0;
	private pitch = 0;
	private yaw = 0;
	private prevEye: Vec3 = { x: 0, y: 0, z: 0 };
	private currEye: Vec3 = { x: 0, y: 0, z: 0 };
	private renderEye: Vec3 = { x: 0, y: 0, z: 0 };
	private cmd: UserCmd = { pitch: 0, yaw: 0, forwardmove: 0, sidemove: 0, buttons: 0 };
	private held: Record<HoldAction, number> = Object.fromEntries(HOLD_ACTIONS.map((a) => [a, 0])) as Record<HoldAction, number>;
	private pressedKeys = new Map<string, string>();
	/** Movement key changes with timestamps, cut into per-tick subtick events. */
	private sampler = new SubtickSampler();
	/** Timestamp (ms) of the DOM input event being handled, -1 outside one. */
	private inputTime = -1;
	/** The newest tick moved the player (false: frozen or down, no movement sounds). */
	private moves = true;
	private teleported = true;
	private tpSeq = 0;
	private spawnSeq = 0;
	private snapPending = false;
	private mouse = { dx: 0, dy: 0 };

	// Online
	private mode: 'solo' | 'online' = 'solo';
	private net: NetClient | null = null;
	private selfId = -1;
	private shopTimer: ReturnType<typeof setTimeout> | undefined;
	private casinoTimer: ReturnType<typeof setTimeout> | undefined;
	/** Account and its casino net when this session began (kept over reconnects). */
	private casinoSession: { username: string; net: number } | null = null;
	/** The loot box screen is open. */
	private boxScreen = false;
	/** The server holds a result of ours back until it was shown. */
	private boxUnseen = false;
	private remotes = new Map<number, Remote>();
	/** Scratch pose for `players.setPose`. */
	private readonly avatarPose = emptyPose();
	private records: MapRecordInfo | null = null;
	private netState: NetState = {
		tick: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0, flags: 0, status: Status.Idle, stage: 0, runTicks: 0
	};
	private fullNotified = false;
	/** Set by a `banned` message (reason, '' = none) until the 4009 close arrives. */
	private bannedReason: string | null = null;
	/** Seconds until that ban lifts by itself; null = permanent. */
	private bannedSecs: number | null = null;

	// Solo
	private soloPb: LocalPb | null = null;

	// Ghosts (docs/gameplay.md#ghosts): played by the race mode
	private ghostStore: GhostStore = browserGhostStore();
	private ghostWarned = false;
	/** What the record ghost's holder wears. */
	private ghostLook: { map: string; loadout: Loadout } | null = null;
	private lastSoloBoard = 0;

	// Spectate
	private spec: Spectate | null = null;

	// HUD bookkeeping
	private fpsFrames = 0;
	private fpsSince = 0;
	private trendAt = 0;
	private trendSpeed = 0;
	private serverClock = new ServerClock();
	private adaptiveDelay = new AdaptiveDelay();
	private lastRenderServerMs = 0;
	private lastCombatPoseMs = 0;
	private lastClientPing = 0;
	private netStats = new NetStats();
	private lastNetGraph = 0;

	constructor(private canvas: HTMLCanvasElement) {
		this.cvars = new ClientCvars(this.store);
		this.binds = new Binds(this.store);
		this.playerId = loadPlayerId(this.store);
		const storedName = loadName(this.store);
		if (storedName) this.cvars.set('name', storedName);
		this.hud.authPanelOpen = !isGuest(this.store);
		this.hud.cvars = this.cvars.snapshot();
		this.hud.maps = MAPS.map((m) => ({ id: m.id, title: m.title, kind: m.kind, difficulty: m.difficulty, ...(m.size && { size: m.size }) }));

		this.con = new DevConsole({
			print: (t, k) => this.print(t, k),
			fallback: (name, args) => cvarFallback(this, name, args),
			names: () => [...this.cvars.defs.keys(), ...SV_NAMES]
		});
		registerCommands(this.con, this);
		this.offCvars = this.cvars.onChange((name, value) => this.onCvar(name, value));

		try {
			this.renderer = new GameRenderer(canvas);
			this.renderer.setFov(this.cvars.num('fov'));
			// A case that falls is heard where it lands.
			this.renderer.zombies.casings.onLand = (kind, at) => this.client.caseLanded?.(kind, at);
			this.renderer.players.setHidden(this.cvars.num('cl_hideplayers') !== 0);
		} catch (e) {
			this.renderer = null;
			this.print(`WebGL unavailable: ${(e as Error)?.message ?? e}`, 'error');
		}
		this.audio.setVolume(this.cvars.num('volume'));

		this.input = new Input(canvas, {
			key: (n, d, e) => this.onKey(n, d, e),
			button: (n, d, t) => this.onButton(n, d, t),
			wheel: (n, t) => this.onWheel(n, t),
			pointerLock: (l) => this.onPointerLock(l),
			canvasClick: () => {
				if (!this.overlayOpen()) this.lockPointer();
			},
			gesture: () => this.audio.resume(),
			blur: () => this.releaseAll(),
			overlayOpen: () => this.overlayOpen()
		});
		this.fullscreen = new GameFullscreen((ok) => this.onKeyboardLock(ok));
		this.hud.fullscreenSupported = this.fullscreen.supported;

		this.loadMap(initialMapId(typeof location !== 'undefined' ? location.search : '', this.store.get(STORAGE_KEYS.lastMap)));

		this.conn = new Connection(
			{
				connecting: () => {
					this.hud.connecting = true;
				},
				idle: () => {
					this.hud.connecting = false;
				},
				open: (c, scope) => this.onOpen(c, scope),
				message: (m) => this.onMessage(m),
				snapshot: (e, t) => this.onSnapshot(e, t),
				ghost: (f) => this.client.ghostFrame?.(f),
				zombies: (f, t) => this.client.zombies?.(f, t),
				traffic: (dir, bytes, at) => this.netStats.recordTraffic(dir, bytes, at),
				defense: (f, t) => this.client.defense?.(f, t),
				closed: (wasOpen, _url, code) => this.onClosed(wasOpen, code)
			},
			{
				override: typeof location !== 'undefined' ? serverOverride(location.search) : null,
				sameOrigin:
					typeof __SURF_SELF_HOSTED__ !== 'undefined' && __SURF_SELF_HOSTED__ && typeof location !== 'undefined'
						? sameOriginWsUrl(location)
						: null,
				dev: import.meta.env.DEV,
				fetch: (...a) => fetch(...a)
			}
		);

		this.api = {
			exec: (line) => this.con.submit(line),
			complete: (p) => this.con.complete(p),
			history: () => this.con.history(),
			sendChat: (t) => this.sendChat(t),
			setCvar: (n, v) => this.setCvar(n, v),
			login: (u, p) => this.credentials('login', u, p),
			register: (u, p) => this.credentials('register', u, p),
			logout: () => this.logout(),
			playAsGuest: (n) => this.playAsGuest(n),
			openAuth: () => this.openAuth(),
			closeAuth: () => this.closeAuth(),
			lockPointer: () => this.lockPointer(),
			openChat: () => this.openChat(),
			closeChat: () => this.closeChat(),
			toggleConsole: () => this.toggleConsole(),
			closeSettings: () => this.closeSettings(),
			changeMap: (id) => this.changeMap(id),
			trnBet: (pick) => this.client.bet?.(pick),
			minimizeBan: (minimized) => this.minimizeBan(minimized),
			shopBuy: (item) => this.shopRequest({ type: 'shopBuy', item }),
			boxOpen: () => this.shopRequest({ type: 'boxOpen' }),
			boxRevealed: () => this.boxRevealed(),
			boxScreen: (open) => {
				this.boxScreen = open;
				if (!open) this.boxRevealed();
			},
			boxSound: (name) => this.audio.box(name),
			casinoBet: (bet) => this.casinoRequest(bet),
			crashCashout: () => this.casinoRequest({ type: 'crashCashout' }),
			casinoSound: (name) => this.audio.casino(name),
			crashBuild: (mult, out) => this.audio.crashBuild(mult, out),
			shopEquip: (slot, item) => this.shopRequest({ type: 'shopEquip', slot, item }),
			createPreview: (canvas) => this.createPreview(canvas),
			modeUi: (a) => this.client.ui?.(a, performance.now()),
			itemPicture: (id) => itemPicture(this.selfId, id),
			admin: (a) => this.adminAction(a)
		};

		this.print('Surf Strike 2. Type "help" for commands.');
	}

	start(): void {
		this.conn.start();
		this.raf = requestAnimationFrame(this.frame);
	}

	// -----------------------------------------------------------------------
	// Console / chat output
	// -----------------------------------------------------------------------

	print(text: string, kind: PrintKind = 'output'): void {
		const lines = text.split('\n').map((t): ConsoleLine => ({ id: ++this.lineId, text: t, kind }));
		const next = this.hud.consoleLines.concat(lines);
		this.hud.consoleLines = next.length > MAX_CONSOLE_LINES ? next.slice(-MAX_CONSOLE_LINES) : next;
	}

	clearConsole(): void {
		this.hud.consoleLines = [];
	}

	private pushChat(from: string | null, text: string, system = from === null, admin = false): void {
		const line: ChatLine = { id: ++this.lineId, from, text, system, at: performance.now(), ...(admin ? { admin: true } : {}) };
		const next = this.hud.chat.concat(line);
		this.hud.chat = next.length > MAX_CHAT_LINES ? next.slice(-MAX_CHAT_LINES) : next;
		this.audio.chatTick();
	}

	private notice(text: string): void {
		this.pushChat(null, text, true);
	}

	// -----------------------------------------------------------------------
	// Cvars
	// -----------------------------------------------------------------------

	private onCvar(name: string, value: number | string): void {
		this.hud.cvars = this.cvars.snapshot();
		switch (name) {
			case 'volume':
				this.audio.setVolume(Number(value));
				break;
			case 'fov':
				this.renderer?.setFov(this.client?.scopeFov ?? Number(value));
				break;
			case 'cl_hideplayers':
				this.renderer?.players.setHidden(Number(value) !== 0);
				break;
			case 'cl_fullscreen':
				if (Number(value) !== 0) this.fullscreen.enter();
				else this.fullscreen.exit();
				break;
			case 'name':
				saveName(this.store, String(value));
				// Logged in: the username is the display name; this stays the guest name.
				if (this.hud.account) this.notice(`You're logged in as ${this.hud.account.username}. "${value}" is your guest name.`);
				else this.send({ type: 'name', name: String(value) });
				break;
		}
	}

	private setCvar(name: string, value: number | string): void {
		if (this.cvars.has(name)) {
			const err = this.cvars.set(name, value);
			if (err) this.print(err, 'error');
		} else if ((SV_NAMES as string[]).includes(name)) {
			this.svSet(name, String(value));
		} else this.print(`Unknown cvar: ${name}`, 'error');
	}

	svNames(): string[] {
		return SV_NAMES;
	}

	svGet(name: string): number | undefined {
		return this.sv[name as keyof Cvars];
	}

	svSet(name: string, raw: string): void {
		if (this.mode === 'online') {
			this.print('sv_* cvars can only be changed in solo mode.', 'error');
			return;
		}
		let n = Number(raw);
		if (!Number.isFinite(n)) {
			this.print(`${name}: "${raw}" is not a number`, 'error');
			return;
		}
		const key = name as keyof Cvars;
		if (SV_BOOL.has(key)) n = n !== 0 ? 1 : 0;
		if (this.sv[key] === n) return;
		(this.sv as unknown as Record<string, number>)[key] = n;
		if (!this.hud.unofficial) this.print('Physics cvars changed: runs on this map are unofficial until the map reloads.');
		this.hud.unofficial = true;
	}

	// -----------------------------------------------------------------------
	// Map loading
	// -----------------------------------------------------------------------

	mapIds(): string[] {
		return [...MAP_IDS];
	}

	private loadMap(id: string, serverCvars?: Partial<Cvars>, records?: MapRecordInfo | null): void {
		const def = getMap(id) ?? getMap(DEFAULT_MAP_ID);
		if (!def) {
			this.print(`Map "${id}" not found`, 'error');
			return;
		}
		this.map = def;
		this.store.set(STORAGE_KEYS.lastMap, def.id);
		this.world = buildCollisionWorld(def);
		this.player = createPlayer({ ...def.spawn.pos });
		this.gameMode = modeOf(def);
		this.sv = { ...mapCvars(def), ...(serverCvars ?? {}) };
		this.placeAt(startSpawn(def));
		this.teleported = true;
		this.snapEye();
		this.step.reset();

		this.renderer?.loadMap(def);
		const h = this.hud;
		h.mapId = def.id;
		h.mapTitle = mapTitle(def);
		h.gameMode = this.gameMode.id;
		h.modeFamily = this.gameMode.family;
		h.modeState = null;
		h.unofficial = false;
		h.splitPopup = null;
		const staged = def.layout === 'staged';
		h.stageKind = staged ? 'stage' : 'checkpoint';
		let maxIndex = staged ? 1 : 0;
		for (const z of def.zones) {
			if (z.type === (staged ? 'stage' : 'checkpoint') && 'index' in z) maxIndex = Math.max(maxIndex, z.index);
		}
		h.stageCount = maxIndex;
		for (const r of this.remotes.values()) {
			r.buf.clear();
			r.hasSample = false;
		}
		this.lastCombatPoseMs = 0;
		this.netStats.resetPlayers();
		if (this.mode === 'solo') {
			this.records = null;
			this.soloPb = loadSoloPb(this.store, def.id);
		} else this.records = records ?? null;
		this.applyRecords();
		this.startMode();
	}

	/** (Re)create the mode of the current map and connection. */
	private startMode(): void {
		this.client?.dispose();
		this.client = createClientMode(this.modeHost);
	}

	private applyRecords(): void {
		const h = this.hud;
		const f = recordFields(this.mode, this.records, this.soloPb);
		h.pbTicks = f.pbTicks;
		h.pbRank = f.pbRank;
		h.recordTicks = f.recordTicks;
		h.recordName = f.recordName;
		h.recordTop = f.recordTop;
	}

	/**
	 * Play another map. Online: join that map's lobby (docs/architecture.md#lobbies);
	 * the server answers with mapChange and the players there. Solo: load it.
	 */
	changeMap(id: string): void {
		if (this.mode === 'online') {
			if (!MAP_IDS.includes(id)) {
				this.print(`Unknown map "${id}". Maps: ${MAP_IDS.join(', ')}`, 'error');
				return;
			}
			if (id === this.map.id) return;
			this.send({ type: 'changeMap', mapId: id });
			return;
		}
		if (!getMap(id)) {
			this.print(`Unknown map "${id}". Maps: ${MAP_IDS.join(', ')}`, 'error');
			return;
		}
		this.loadMap(id);
	}

	// -----------------------------------------------------------------------
	// Input and binds
	// -----------------------------------------------------------------------

	private overlayOpen(): boolean {
		const h = this.hud;
		return h.chatOpen || h.consoleOpen || h.settingsOpen || h.authPanelOpen || h.desktopOnly || (h.ban !== null && !h.ban.minimized);
	}

	private onKey(name: string, down: boolean, e: KeyboardEvent): boolean {
		const cmd = this.binds.get(name);
		if (this.overlayOpen()) {
			if (down && !e.repeat && cmd === 'toggleconsole' && this.hud.consoleOpen) {
				this.toggleConsole();
				return true;
			}
			return false;
		}
		// Ignore keys typed into other page inputs.
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false;
		if (name === 'escape') {
			// A repeat is a held Esc (leaves fullscreen): the first press already did its work.
			if (!down || e.repeat) return false;
			// Fullscreen keyboard lock hands us Esc with the pointer still locked; the menu opens
			// when the lock is gone (onPointerLock), as it does when the browser handles Esc.
			if (this.input.locked) this.input.exitLock();
			else this.openSettings();
			return true;
		}
		if (down) {
			// Crouch on Ctrl turns game keys into browser shortcuts (Ctrl+W above all). Swallow every
			// one the browser lets us see while playing; with a free cursor, close/new stay with it.
			const shortcut = isBrowserShortcut(name, e);
			if (shortcut && !this.input.locked && (name === 'w' || name === 't' || name === 'n')) return false;
			const swallow = shortcut && this.input.locked;
			if (!cmd) return swallow;
			if (e.repeat) return true;
			this.pressedKeys.set(name, cmd);
			this.inputTime = e.timeStamp;
			this.runBind(cmd, true);
			this.inputTime = -1;
			return true;
		}
		const pressed = this.pressedKeys.get(name);
		if (pressed === undefined) return !!cmd;
		this.pressedKeys.delete(name);
		this.inputTime = e.timeStamp;
		this.runBind(pressed, false);
		this.inputTime = -1;
		return true;
	}

	private onButton(name: string, down: boolean, t: number): void {
		if (this.overlayOpen()) return;
		this.inputTime = t;
		try {
			this.buttonBind(name, down);
		} finally {
			this.inputTime = -1;
		}
	}

	private buttonBind(name: string, down: boolean): void {
		if (down) {
			const cmd = this.binds.get(name);
			if (!cmd) return;
			this.pressedKeys.set(name, cmd);
			this.runBind(cmd, true);
		} else {
			const cmd = this.pressedKeys.get(name);
			if (cmd === undefined) return;
			this.pressedKeys.delete(name);
			this.runBind(cmd, false);
		}
	}

	/** Wheel binds press and release at the same instant (CS2 scroll bhop: both in one subtick). */
	private onWheel(name: string, t: number): void {
		if (this.overlayOpen()) return;
		const cmd = this.binds.get(name);
		if (!cmd) return;
		if (cmd.startsWith('+')) {
			const action = cmd.slice(1) as HoldAction;
			if (HOLD_ACTIONS.includes(action) && action !== 'showscores' && action !== 'bracket') {
				this.inputTime = t;
				this.press(action, true);
				this.press(action, false);
				this.inputTime = -1;
				return;
			}
		}
		this.con.exec(cmd);
	}

	private runBind(cmd: string, down: boolean): void {
		if (cmd.startsWith('+')) {
			if (down) this.con.exec(cmd);
			else this.con.exec(`-${cmd.slice(1).split(/[\s;]/)[0]}`);
		} else if (down) this.con.exec(cmd);
		// E held to repair (Zombie Defense): the mode hears the release of its bound command.
		else if (cmd.trim() === 'beacon') this.client.commandUp?.('beacon', performance.now());
	}

	press(action: HoldAction, down: boolean): void {
		const was = this.held[action] > 0;
		this.held[action] = Math.max(0, this.held[action] + (down ? 1 : -1));
		const is = this.held[action] > 0;
		if (was === is) return;
		if (isMoveAction(action)) this.sampler.push(action, is, this.inputTime >= 0 ? this.inputTime : performance.now());
		switch (action) {
			case 'showscores':
				this.hud.scoreboardOpen = is;
				if (is && this.mode === 'solo') this.refreshSoloBoard(performance.now());
				break;
			case 'bracket':
				this.hud.bracketHeld = is;
				break;
			case 'jump':
				if (is && this.spec) this.toggleFreeFly();
				break;
			case 'attack':
			case 'attack2':
				if (this.spec) {
					if (is) this.cycleSpectate(action === 'attack' ? 1 : -1);
				} else this.client.press?.(action, is, performance.now());
				break;
		}
	}

	private releaseAll(): void {
		for (const a of HOLD_ACTIONS) this.held[a] = 0;
		this.pressedKeys.clear();
		this.client.release?.(performance.now());
		this.sampler.releaseAll(performance.now());
		this.hud.scoreboardOpen = false;
		this.hud.bracketHeld = false;
	}

	private onPointerLock(locked: boolean): void {
		this.hud.pointerLocked = locked;
		if (!locked) {
			this.releaseAll();
			if (!this.overlayOpen()) this.hud.settingsOpen = true;
			return;
		}
		// After the pointer lock, not with it: requestFullscreen uses up the click that both need.
		if (this.cvars.num('cl_fullscreen') !== 0) this.fullscreen.enter();
	}

	private onKeyboardLock(ok: boolean): void {
		if (this.disposed) return;
		if (!ok) {
			if (!this.lockRefused) this.notice('The browser refused the keyboard lock, so Ctrl+W can still close the tab.');
			this.lockRefused = true;
		} else if (!this.store.get(STORAGE_KEYS.fullscreenHint)) {
			// Once per browser.
			this.store.set(STORAGE_KEYS.fullscreenHint, '1');
			this.notice('Fullscreen blocks Ctrl+W (forward + crouch). Esc: menu, hold Esc: leave fullscreen. Turn it off under Settings › Video.');
		}
	}

	private lockPointer(): void {
		this.audio.resume();
		if (this.hud.desktopOnly) return;
		this.input.requestLock();
	}

	private openSettings(): void {
		this.releaseAll();
		this.hud.settingsOpen = true;
	}

	private closeSettings(): void {
		this.hud.settingsOpen = false;
		if (!this.overlayOpen()) this.lockPointer();
	}

	openChat(): void {
		const h = this.hud;
		if (h.consoleOpen || h.settingsOpen || h.authPanelOpen) return;
		this.releaseAll();
		h.chatOpen = true;
	}

	private closeChat(): void {
		this.hud.chatOpen = false;
		if (!this.overlayOpen() && !this.input.locked) this.lockPointer();
	}

	toggleConsole(): void {
		const h = this.hud;
		h.consoleOpen = !h.consoleOpen;
		if (h.consoleOpen) {
			this.releaseAll();
			this.input.exitLock();
		} else if (!this.overlayOpen()) this.lockPointer();
	}

	// -----------------------------------------------------------------------
	// Accounts (docs/gameplay.md#accounts-and-identity)
	// -----------------------------------------------------------------------

	/** Display name: the account username when logged in, else the guest name cvar. */
	private myName(): string {
		return this.hud.account?.username ?? this.cvars.str('name');
	}

	private credentials(kind: 'login' | 'register', username: string, password: string): void {
		const h = this.hud;
		if (h.authBusy) return;
		if (h.account) {
			h.authError = `Already logged in as ${h.account.username}. Log out first.`;
			return;
		}
		if (this.mode !== 'online') {
			h.authError = 'Server offline — play as guest; log in when online.';
			return;
		}
		if (kind === 'register') {
			const bad = usernameError(username) ?? passwordError(password);
			if (bad) {
				h.authError = bad;
				return;
			}
		} else if (!username || !password) {
			h.authError = 'Enter your username and password.';
			return;
		}
		h.authError = null;
		h.authBusy = true;
		this.send({ type: kind, username, password });
	}

	private logout(): void {
		if (this.sessionScope !== null) clearSession(this.store, this.sessionScope);
		this.session = null;
		this.helloToken = null;
		if (!this.hud.account) return;
		this.hud.account = null;
		this.hud.adminState = null;
		if (this.mode === 'online') this.send({ type: 'logout' });
		else this.notice('Logged out.');
	}

	private playAsGuest(raw: string): void {
		const n = cleanName(raw);
		if (!n || this.hud.account) return;
		setGuest(this.store);
		this.cvars.set('name', n);
		saveName(this.store, n);
		this.hud.authPanelOpen = false;
		this.hud.authError = null;
		this.lockPointer();
	}

	private openAuth(): void {
		this.releaseAll();
		this.input.exitLock();
		this.hud.settingsOpen = false;
		this.hud.authError = null;
		this.hud.authPanelOpen = true;
	}

	private closeAuth(): void {
		// Closing the first-visit panel without choosing: play as guest under the current name.
		if (!this.hud.account && !isGuest(this.store)) setGuest(this.store);
		this.hud.authPanelOpen = false;
		this.hud.authError = null;
		if (!this.overlayOpen()) this.lockPointer();
	}

	private minimizeBan(minimized: boolean): void {
		if (!this.hud.ban) return;
		this.hud.ban = { ...this.hud.ban, minimized };
		if (minimized && !this.overlayOpen()) this.lockPointer();
	}

	private onAuth(m: Extract<ServerMessage, { type: 'auth' }>): void {
		const h = this.hud;
		h.authBusy = false;
		if (!m.ok) {
			h.authError = m.error;
			if (!h.authPanelOpen) this.notice(m.error);
			return;
		}
		if (m.records) {
			this.records = m.records;
			this.applyRecords();
		}
		if (m.username === null) {
			h.account = null;
			h.adminState = null;
			this.notice(`Logged out. Playing as guest (${this.cvars.str('name')}); runs are not saved.`);
			return;
		}
		h.account = { username: m.username, admin: m.admin === true };
		h.authError = null;
		if (!h.account.admin) h.adminState = null;
		if (m.token && this.sessionScope !== null) {
			this.session = { token: m.token, username: m.username };
			saveSession(this.store, this.sessionScope, this.session);
		}
		if (h.authPanelOpen) {
			h.authPanelOpen = false;
			// The reply is async (no user gesture): the click hint asks for a click to lock the pointer.
		}
		this.notice(`Logged in as ${m.username}. Your runs are saved to the leaderboard.`);
	}

	// -----------------------------------------------------------------------
	// Shop (docs/ui.md#shop): the server decides; the menu shows its replies.

	private shopRequest(msg: Extract<ClientMessage, { type: 'shopBuy' | 'shopEquip' | 'boxOpen' }>): void {
		const s = this.hud.shop;
		if (!s || s.busy || this.mode !== 'online') return;
		this.hud.shop = { ...s, busy: true, notice: null };
		this.send(msg);
		clearTimeout(this.shopTimer);
		this.shopTimer = setTimeout(() => {
			if (this.hud.shop?.busy) this.hud.shop = { ...this.hud.shop, busy: false, notice: { ok: false, text: 'No answer from the server. Try again.' } };
		}, SHOP_TIMEOUT_MS);
	}

	private boxRevealed(): void {
		if (!this.boxUnseen) return;
		this.boxUnseen = false;
		this.send({ type: 'boxRevealed' });
	}

	/** Casino (docs/ui.md#casino): the server rolls and pays. */
	private casinoRequest(msg: Extract<ClientMessage, { type: 'casinoBet' | 'crashCashout' }>): void {
		const c = this.hud.casino;
		if (!c || c.busy || this.mode !== 'online') return;
		this.hud.casino = { ...c, busy: true, error: null };
		this.send(msg);
		clearTimeout(this.casinoTimer);
		this.casinoTimer = setTimeout(() => {
			if (this.hud.casino?.busy) this.hud.casino = casinoError(this.hud.casino, 'No answer from the server. Try again.');
		}, SHOP_TIMEOUT_MS);
	}

	private onCasino(m: Extract<ServerMessage, { type: 'casino' }>, now: number): void {
		const username = this.hud.account?.username;
		if (username === undefined) this.casinoSession = null;
		else if (this.casinoSession?.username !== username) this.casinoSession = { username, net: m.net };
		this.hud.casino = parseCasino(m, now, this.casinoSession?.net ?? m.net, this.hud.casino);
	}

	private onCasinoResult(m: Extract<ServerMessage, { type: 'casinoResult' }>, now: number): void {
		const c = this.hud.casino;
		if (!c) return;
		clearTimeout(this.casinoTimer);
		this.hud.casino = m.ok ? casinoResult(c, m, Date.now()) : casinoError(c, m.error);
		// A crash round that ends while the menu is closed.
		if (m.ok && m.game === 'crash' && !this.hud.settingsOpen) {
			const text = m.payout > 0 ? `Crash: cashed out, ${formatTenths(m.payout)} coins.` : 'Crash: your bet is lost.';
			this.hud.awardPopups = pushPopup(this.hud.awardPopups, noticePopup({ type: 'coinsNotice', text, tone: 'info' }, now));
		}
	}

	private createPreview(canvas: HTMLCanvasElement): CharacterPreviewHandle | null {
		try {
			return new CharacterPreview(canvas, this.selfId);
		} catch {
			return null; // no second WebGL context
		}
	}

	// -----------------------------------------------------------------------
	// Admin (docs/ui.md#admin): the server decides who is admin and re-checks every request.

	private adminAction(action: AdminAction): void {
		if (this.mode !== 'online' || !this.hud.account?.admin) {
			this.hud.adminNotice = { ok: false, text: 'Admin actions need the server and an admin account.', at: performance.now() };
			return;
		}
		this.send({ type: 'admin', action });
	}

	/** Server's enabled maps (null = all, e.g. offline): disabled maps are greyed in Change map. */
	private applyEnabledMaps(enabled: Set<string> | null): void {
		this.hud.maps = this.hud.maps.map((m) => {
			const disabled = enabled !== null && !enabled.has(m.id);
			if (!!m.disabled === disabled) return m;
			const { disabled: _d, ...rest } = m;
			return disabled ? { ...rest, disabled: true } : rest;
		});
	}

	/** Welcome: confirm or drop the stored session. */
	private applyWelcomeAccount(account: { username: string; admin?: boolean } | null | undefined): void {
		const h = this.hud;
		if (account === undefined) return; // old server without accounts
		if (account) {
			h.account = { username: account.username, admin: account.admin === true };
			if (this.sessionScope !== null && this.session && this.session.username !== account.username) {
				this.session = { ...this.session, username: account.username };
				saveSession(this.store, this.sessionScope, this.session);
			}
			return;
		}
		h.account = null;
		if (this.helloToken) {
			// Stored session unknown or expired: forget it; ask again unless playing as guest.
			if (this.sessionScope !== null) clearSession(this.store, this.sessionScope);
			this.session = null;
			if (!isGuest(this.store)) {
				this.releaseAll();
				h.authPanelOpen = true;
			}
		}
	}

	// -----------------------------------------------------------------------
	// Chat
	// -----------------------------------------------------------------------

	say(text: string): void {
		this.sendChat(text, false);
	}

	private sendChat(raw: string, close = true): void {
		if (close) this.hud.chatOpen = false;
		const text = sanitizeText(raw, MAX_CHAT);
		if (!text) return;
		const cmd = parseChatCommand(text);
		const online = this.mode === 'online';
		if (!cmd) {
			if (online) this.send({ type: 'chat', text });
			else this.pushChat(this.myName(), text, false);
			return;
		}
		switch (cmd.kind) {
			case 'restart':
			case 'back':
				if (this.client.chatRestart) return this.client.chatRestart(performance.now());
				return cmd.kind === 'restart' ? this.restart() : this.back();
			case 'spec':
				return this.spectate(cmd.target);
			case 'map': {
				// Online the server finds the map and moves us (or lists the busy lobbies).
				if (online) return this.send({ type: 'chat', text });
				const m = findMap(cmd.name);
				if (!cmd.name) return this.notice('Usage: !map <name>. Or pick a map in Esc › Servers.');
				if (!m) return this.notice(`No map matching "${cmd.name}".`);
				return this.changeMap(m.id);
			}
			case 'name': {
				if (this.hud.account) return this.notice(`You're logged in as ${this.hud.account.username}. Log out to play under another name.`);
				const n = cleanName(cmd.name);
				if (!n) return this.notice('Usage: !name <new name>');
				this.cvars.set('name', n);
				if (!online) this.notice(`You are now ${n}.`);
				return;
			}
		}
		if (online) {
			// !top, !pb, !help and unknown commands are answered by the server.
			this.send({ type: 'chat', text });
			return;
		}
		switch (cmd.kind) {
			case 'top':
				this.notice('Leaderboards are only available online. Solo runs are not saved to the leaderboard.');
				break;
			case 'pb':
				this.notice(this.soloPb ? `Your solo PB on ${this.map.title}: ${formatTicks(this.soloPb.ticks)}` : `No solo PB on ${this.map.title} yet.`);
				break;
			case 'help':
				this.notice(CHAT_HELP);
				break;
			default:
				this.notice(`Unknown command: !${cmd.name}`);
		}
	}

	// -----------------------------------------------------------------------
	// Gamemode (docs/modes.md)
	// -----------------------------------------------------------------------

	/** What the modes see of the game: live views of its fields, and what they may do. */
	private createModeHost(): ClientModeHost {
		const game = this;
		return {
			get map() { return game.map; },
			get sv() { return game.sv; },
			get world() { return game.world; },
			get player() { return game.player; },
			get tick() { return game.tick; },
			get alpha() { return game.step.alpha; },
			get pitch() { return game.pitch; },
			get yaw() { return game.yaw; },
			get eye() { return game.currEye; },
			get spec() { return game.spec; },
			get remotes() { return game.remotes; },
			get hud() { return game.hud; },
			get audio() { return game.audio; },
			get renderer() { return game.renderer; },
			get online() { return game.mode === 'online'; },
			get selfId() { return game.selfId; },
			get interpDelayMs() { return game.adaptiveDelay.currentMs; },
			get renderServerTimeMs() { return game.lastRenderServerMs; },
			get viewId() { return game.viewId(); },
			get ghostStore() { return game.ghostStore; },
			get ghostLook() { return game.ghostLook; },
			cvar: (name) => this.cvars.num(name),
			myName: () => this.myName(),
			name: (id) => this.remoteName(id),
			send: (msg) => {
				if (msg.type === 'fire' || msg.type === 'knife' || msg.type === 'throwKnife') {
					const renderServerTimeMs = game.combatRenderClaim(performance.now());
					if (renderServerTimeMs !== undefined) return game.send({ ...msg, renderServerTimeMs });
				}
				game.send(msg);
			},
			notice: (text) => this.notice(text),
			print: (text, kind) => this.print(text, kind),
			setAngles: (pitch, yaw) => {
				this.pitch = pitch;
				this.yaw = yaw;
			},
			teleport: (s) => {
				this.placeAt(s);
				this.afterTeleport();
			},
			setWorld: (world) => {
				this.world = world;
			},
			movedInTick: () => {
				this.teleported = true;
				this.snapPending = true;
			},
			moved: () => this.afterTeleport(),
			teleportZones: (spawn) => this.teleportZones(spawn),
			avatarAct: (id, action) => this.renderer?.players.act(id, action),
			rampUnder: (p) => this.rampUnder(p),
			sendState: () => this.sendState(),
			best: () => {
				if (this.mode === 'online') return { ticks: this.records?.pbTicks ?? null, splits: this.records?.pbSplits ?? null };
				return { ticks: this.soloPb?.ticks ?? null, splits: this.soloPb?.splits ?? null };
			},
			saveSoloBest: (ticks, splits) => {
				const pb: LocalPb = { ticks, splits: [...splits] };
				if (!saveSoloPb(this.store, this.map.id, pb)) return false;
				this.soloPb = pb;
				this.applyRecords();
				return true;
			},
			ghostUnavailable: () => {
				if (!this.ghostWarned) this.print('Record ghost unavailable (this browser cannot decode it).', 'error');
				this.ghostWarned = true;
			}
		};
	}

	/** Put the player at a spawn, standing still. */
	private placeAt(s: Spawn): void {
		const p = this.player;
		p.origin.x = s.pos.x;
		p.origin.y = s.pos.y;
		p.origin.z = s.pos.z;
		p.velocity.x = 0;
		p.velocity.y = 0;
		p.velocity.z = 0;
		p.onGround = false;
		this.yaw = s.yaw;
		this.pitch = 0;
	}

	/**
	 * Teleport triggers of modes without a run tracker respawn at `spawn()`, or
	 * move the player to the zone's fixed `dest` (map teleporters, any mode).
	 */
	private teleportZones(spawn: () => Spawn): void {
		const p = this.player;
		for (const z of this.map.zones) {
			if (z.type !== 'teleport' || !hullInBox(p.origin, p.ducked, z)) continue;
			this.placeAt(z.dest ?? spawn());
			this.teleported = true;
			this.snapPending = true;
			return;
		}
	}

	/** E (`beacon`): infected plant a respawn beacon; other modes ignore it. */
	beacon(): void {
		if (!this.spec) this.client.command?.('beacon', performance.now());
	}

	/** B (`shop`): Zombie Defense shop; other modes ignore it. */
	shop(): void {
		if (!this.spec) this.client.command?.('shop', performance.now());
	}

	/** F (`ready`): Zombie Defense ready for the next wave; other modes ignore it. */
	ready(): void {
		if (!this.spec) this.client.command?.('ready', performance.now());
	}

	/** N (`moab`, also key 4): infected survivors call an earned M.O.A.B.; other modes ignore it. */
	moab(): void {
		if (!this.spec) this.client.command?.('moab', performance.now());
	}

	restart(): void {
		if (!this.spec) this.client.restart(performance.now());
	}

	back(): void {
		if (this.spec) return;
		const now = performance.now();
		if (this.client.back) this.client.back(now);
		else this.client.restart(now);
	}

	private afterTeleport(): void {
		this.teleported = true;
		this.snapEye();
		this.hud.splitPopup = null;
	}

	/**
	 * Defensive: a spawn/teleport placed exactly on a floor can start solid in
	 * the trace; nudge up by up to 2 units so movement is not frozen.
	 */
	private unstick(): void {
		const o = this.player.origin;
		const maxs = playerMaxs(this.player);
		if (!this.world.trace(o, o, HULL_MIN, maxs).startsolid) return;
		const base = o.z;
		for (let dz = 0.0625; dz <= 2; dz *= 2) {
			o.z = base + dz;
			if (!this.world.trace(o, o, HULL_MIN, maxs).startsolid) return;
		}
		o.z = base;
	}

	private snapEye(): void {
		this.unstick();
		const p = this.player;
		this.currEye.x = p.origin.x;
		this.currEye.y = p.origin.y;
		this.currEye.z = p.origin.z + eyeHeight(p);
		this.prevEye.x = this.currEye.x;
		this.prevEye.y = this.currEye.y;
		this.prevEye.z = this.currEye.z;
	}

	// -----------------------------------------------------------------------
	// Simulation
	// -----------------------------------------------------------------------

	/** One tick covering the wall-clock interval [start, end) ms (subtick input inside it). */
	private simTick(now: number, start: number, end: number): void {
		const p = this.player;
		const c = this.cmd;
		// Key changes inside this tick become subtick events; the view angle is the one at tick
		// time (sv_subtick_movement_view_angles 0 on CS2 surf/bhop servers).
		this.sampler.buildTick(start, end, c);
		if (!this.spec) {
			c.pitch = this.pitch;
			c.yaw = this.yaw;
			const sv = this.client.moveCvars ? this.client.moveCvars(end) : this.sv;
			this.moves = sv !== null;
			if (sv) playerMove(this.world, p, c, sv, TICK_INTERVAL);
			else playerRest(p);
			this.client.tick(now, end);
			if (p.jumped) this.audio.jump();
			if (p.landedSpeed > 0) this.audio.land(p.landedSpeed);

			this.prevEye.x = this.currEye.x;
			this.prevEye.y = this.currEye.y;
			this.prevEye.z = this.currEye.z;
			this.currEye.x = p.origin.x;
			this.currEye.y = p.origin.y;
			this.currEye.z = p.origin.z + eyeHeight(p);
			if (this.snapPending) {
				this.snapPending = false;
				this.snapEye();
			}
		}
		// State goes out every tick: 64 Hz (docs/architecture.md).
		if (this.mode === 'online') this.sendState(now);
		this.tick++;
	}

	private sendState(now = performance.now()): void {
		if (!this.net) return;
		const p = this.player;
		const s = this.netState;
		s.tick = this.tick;
		s.spawnSeq = this.spawnSeq;
		s.renderServerTimeMs = this.combatRenderClaim(now);
		s.x = p.origin.x;
		s.y = p.origin.y;
		s.z = p.origin.z;
		s.vx = p.velocity.x;
		s.vy = p.velocity.y;
		s.vz = p.velocity.z;
		s.pitch = this.pitch;
		s.yaw = this.yaw;
		if (this.teleported) this.tpSeq = (this.tpSeq + 1) & 0xff;
		s.flags = withTeleportSeq(
			(p.ducked ? FLAG_DUCKED : 0) | (p.onGround ? FLAG_ON_GROUND : 0) | (this.teleported ? FLAG_TELEPORTED : 0),
			this.tpSeq
		);
		this.client.netState(s);
		if (this.spec) s.status = Status.Spectating;
		this.net.sendBinary(encodeState(s));
		this.teleported = false;
	}

	/** Mouse sensitivity factor of the current zoom (`zoom_sensitivity_ratio`); 1 when not zoomed. */
	private zoomSens(): number {
		const v = this.client.view;
		if (!v || v.zoomT <= 0) return 1;
		const fov = this.cvars.num('fov');
		return zoomSensitivity(fov, zoomFov(fov, v.zoomFov, v.zoomT), this.cvars.num('zoom_sensitivity_ratio'), v.zoomT);
	}

	private applyMouse(dtSec: number): void {
		this.input.consumeMouse(this.mouse);
		if (this.overlayOpen() || !this.input.locked) return;
		if (this.spec && !this.spec.freeFly) return;
		const sens = this.cvars.num('sensitivity') * this.zoomSens();
		this.yaw -= this.mouse.dx * sens * this.cvars.num('m_yaw');
		this.pitch += this.mouse.dy * sens * this.cvars.num('m_pitch');
		if (this.pitch > 89) this.pitch = 89;
		if (this.pitch < -89) this.pitch = -89;
		if (this.yaw > 180 || this.yaw <= -180) this.yaw = ((((this.yaw + 180) % 360) + 360) % 360) - 180;
		if (this.spec?.freeFly) this.moveFreeFly(dtSec);
	}

	private moveFreeFly(dt: number): void {
		const s = this.spec!;
		const h = this.held;
		const f = (h.forward > 0 ? 1 : 0) - (h.back > 0 ? 1 : 0);
		const r = (h.moveright > 0 ? 1 : 0) - (h.moveleft > 0 ? 1 : 0);
		if (!f && !r) return;
		const cy = Math.cos((this.yaw * Math.PI) / 180);
		const sy = Math.sin((this.yaw * Math.PI) / 180);
		const cp = Math.cos((this.pitch * Math.PI) / 180);
		const sp = Math.sin((this.pitch * Math.PI) / 180);
		const speed = FREEFLY_SPEED * (h.duck > 0 ? 0.35 : 1) * dt;
		// Source forward (pitch + = down) and right vectors.
		s.pos.x += (cp * cy * f + sy * r) * speed;
		s.pos.y += (cp * sy * f - cy * r) * speed;
		s.pos.z += -sp * f * speed;
	}

	// -----------------------------------------------------------------------
	// Frame
	// -----------------------------------------------------------------------

	private frame = (now: number): void => {
		if (this.disposed) return;
		this.raf = requestAnimationFrame(this.frame);
		const dt = this.lastFrame < 0 ? 0 : now - this.lastFrame;
		this.lastFrame = now;

		this.applyMouse(Math.min(dt, 100) / 1000);
		const n = this.step.advance(dt);
		const stepMs = this.step.stepMs;
		// Wall-clock end of the first tick run now: the newest tick ends `accMs` before this frame.
		let end = now - this.step.accMs - (n - 1) * stepMs;
		for (let i = 0; i < n; i++, end += stepMs) this.simTick(now, end - stepMs, end);

		if (this.mode === 'online' && now - this.lastClientPing >= 1000) {
			this.lastClientPing = now;
			this.net?.send({ type: 'ping', t: now });
		}
		const view = this.updateCamera(now);
		this.updateRemotes(now, dt);
		this.client.frame(now);
		this.updateHud(now, view);
		this.audio.update(Math.min(dt, 100) / 1000, {
			speed: Math.hypot(this.player.velocity.x, this.player.velocity.y),
			onGround: this.player.onGround,
			surfing: this.player.surfing,
			ducked: this.player.ducked,
			active: !this.spec && this.moves
		});
		if (this.renderer) this.renderer.zombies.casings.collision = this.world;
		this.renderer?.render(now / 1000);
	};

	/** Positions the camera; returns the sample shown on the HUD (spectated target) or null. */
	private updateCamera(now: number): Sample | null {
		const r = this.renderer;
		if (this.spec) {
			const s = this.spec;
			const target = s.targetId !== null ? this.remotes.get(s.targetId) : undefined;
			if (!s.freeFly && target?.hasSample) {
				const t = target.sample;
				const eye = t.z + ((t.flags & FLAG_DUCKED) !== 0 ? DUCK_VIEW_HEIGHT : VIEW_HEIGHT);
				s.pos.x = t.x;
				s.pos.y = t.y;
				s.pos.z = eye;
				this.pitch = t.pitch;
				this.yaw = t.yaw;
				r?.setView(t.x, t.y, eye, t.pitch, t.yaw);
				return t;
			}
			r?.setView(s.pos.x, s.pos.y, s.pos.z, this.pitch, this.yaw);
			return s.freeFly ? null : (target?.sample ?? null);
		}
		const e = vlerp(this.prevEye, this.currEye, this.step.alpha, this.renderEye);
		// View recoil moves the camera only; shots follow it (infected.ts `shoot`).
		const v = this.client.view ?? NO_VIEW;
		r?.setView(e.x, e.y, e.z, kickedPitch(this.pitch, v.kickPitch), this.yaw + v.kickYaw, v.kickRoll);
		return null;
	}

	/** Normal of the surf ramp an airborne hull at feet `p` rests on, for the surf stance (visual only). */
	private rampUnder(p: Vec3): Vec3 | null {
		const a = { x: p.x, y: p.y, z: p.z + 2 };
		const n = this.world.trace(a, { x: p.x, y: p.y, z: p.z - 4 }, HULL_MIN, DUCK_HULL_MAX).plane.normal;
		return n.z > 0.1 && n.z < 0.7 ? n : null;
	}

	private get combatHistoryMs(): number | undefined {
		switch (this.gameMode.id) {
			case 'infected':
			case 'tournament': return INF_HISTORY_MS;
			case 'hns': return HNS_MAX_REWIND_MS;
			case 'zombies': return ZM_HISTORY_MS;
		}
	}

	private combatRenderClaim(now: number): number | undefined {
		const historyMs = this.combatHistoryMs;
		if (historyMs === undefined || !this.serverClock.isSynced || this.lastCombatPoseMs <= 0) return undefined;
		const ping = this.hud.scoreboard.find((row) => row.id === this.selfId)?.ping;
		const recentRtt = this.serverClock.minRtt;
		const pathRtt = Math.max(0, recentRtt >= 0 ? recentRtt : (ping ?? 0));
		// Scoreboard ping is the server's transport estimate rounded to the nearest ms.
		const rewindRtt = Math.min(MAX_REWIND_RTT_MS, ping === undefined ? pathRtt : Math.max(0, ping - 0.5));
		const maxAge = Math.min(historyMs, renderTimeBudgetMs(rewindRtt));
		// The clock envelope includes downlink transit, so add the full RTT for receipt.
		const receiveAt = this.serverClock.serverTime(now) + pathRtt;
		return Math.max(this.lastCombatPoseMs, receiveAt - maxAge);
	}

	private updateRemotes(now: number, dtMs: number): void {
		const delayMs = this.adaptiveDelay.update(now, dtMs);
		const renderAt = this.serverClock.renderTime(now, delayMs);
		const combat = this.combatHistoryMs !== undefined;
		this.lastRenderServerMs = renderAt;
		this.lastCombatPoseMs = renderAt;
		this.netStats.setInterpDelay(delayMs);
		if (this.remotes.size === 0) return;
		const players = this.renderer?.players;
		const specTarget = this.spec && !this.spec.freeFly ? this.spec.targetId : null;
		let anyUnderrun = false;
		let anyExtrap = false;
		for (const rm of this.remotes.values()) {
			rm.hasSample = rm.buf.sample(renderAt, rm.sample, this.world, now, !combat);
			const down = this.client.isDown?.(rm.id) ?? false;
			if (rm.hasSample && !rm.spectating && !rm.buf.sourceIdle && now - rm.buf.lastArrival < 3000) {
				if (rm.buf.lastUnderrun) {
					anyUnderrun = true;
					// Protocol v3 carries one rewind time. Keep held poses eligible for it
					// without feeding their caps back into playback for other targets.
					if (combat && !down) this.lastCombatPoseMs = Math.min(this.lastCombatPoseMs, rm.buf.lastRenderMs);
				}
				if (rm.buf.lastExtrapMs > 0) anyExtrap = true;
			}
			if (!players) continue;
			if (!players.has(rm.id)) players.upsert(rm.id, rm.name);
			const s = rm.sample;
			const visible =
				rm.hasSample &&
				!rm.spectating &&
				s.status !== Status.Spectating &&
				rm.id !== specTarget &&
				now - rm.buf.lastArrival < 3000 &&
				!down;
			const pose = this.avatarPose;
			pose.x = s.x;
			pose.y = s.y;
			pose.z = s.z;
			pose.vx = s.vx;
			pose.vy = s.vy;
			pose.vz = s.vz;
			pose.yaw = s.yaw;
			pose.pitch = s.pitch;
			pose.ducked = (s.flags & FLAG_DUCKED) !== 0;
			pose.onGround = (s.flags & FLAG_ON_GROUND) !== 0;
			pose.ramp = visible && !pose.onGround ? this.rampUnder(s) : null;
			this.client.adjustPose?.(pose);
			players.setPose(rm.id, pose, visible);
			this.client.dress?.(players, rm, visible, now);
		}
		this.netStats.recordFrame(now, dtMs, anyUnderrun, anyExtrap);
	}

	private updateHud(now: number, target: Sample | null): void {
		const h = this.hud;
		const p = this.player;
		// Movement readouts: spectated target or local player.
		const vx = target ? target.vx : p.velocity.x;
		const vy = target ? target.vy : p.velocity.y;
		const speed = Math.round(Math.hypot(vx, vy));
		if (h.speed !== speed) h.speed = speed;
		if (now - this.trendAt >= 100) {
			const d = speed - this.trendSpeed;
			const trend = d > 1 ? 'up' : d < -1 ? 'down' : 'flat';
			if (h.speedTrend !== trend) h.speedTrend = trend;
			this.trendSpeed = speed;
			this.trendAt = now;
		}

		if (target) {
			const phase = statusPhase(target.status);
			if (h.runPhase !== phase) h.runPhase = phase;
			if (h.runTicks !== target.runTicks) h.runTicks = target.runTicks;
			if (h.stage !== target.stage) h.stage = target.stage;
		} else {
			const run = this.client.run;
			const phase = run?.phase ?? 'idle';
			if (h.runPhase !== phase) h.runPhase = phase;
			const ticks = run && (phase === 'running' || phase === 'finished') ? run.ticks : 0;
			if (h.runTicks !== ticks) h.runTicks = ticks;
			const stage = run?.stage ?? (h.stageKind === 'stage' ? 1 : 0);
			if (h.stage !== stage) h.stage = stage;
		}

		const k = h.keys;
		const hd = this.held;
		if (k.w !== hd.forward > 0) k.w = hd.forward > 0;
		if (k.s !== hd.back > 0) k.s = hd.back > 0;
		if (k.a !== hd.moveleft > 0) k.a = hd.moveleft > 0;
		if (k.d !== hd.moveright > 0) k.d = hd.moveright > 0;
		if (k.jump !== hd.jump > 0) k.jump = hd.jump > 0;
		if (k.duck !== hd.duck > 0) k.duck = hd.duck > 0;

		this.fpsFrames++;
		if (now - this.fpsSince >= 500) {
			h.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsSince));
			this.fpsFrames = 0;
			this.fpsSince = now;
		}

		if (this.cvars.num('cl_showpos') !== 0) {
			const pos = h.pos;
			const src = target ?? null;
			pos.x = Math.round((src ? src.x : p.origin.x) * 100) / 100;
			pos.y = Math.round((src ? src.y : p.origin.y) * 100) / 100;
			pos.z = Math.round((src ? src.z : p.origin.z) * 100) / 100;
			pos.pitch = Math.round(this.pitch * 100) / 100;
			pos.yaw = Math.round(this.yaw * 100) / 100;
			pos.vx = Math.round(vx * 100) / 100;
			pos.vy = Math.round(vy * 100) / 100;
			pos.vz = Math.round((src ? src.vz : p.velocity.z) * 100) / 100;
		}

		if (this.mode === 'solo' && now - this.lastSoloBoard > 500) this.refreshSoloBoard(now);
		const selfId = this.mode === 'online' ? this.selfId : SOLO_ROW_ID;
		if (h.selfId !== selfId) h.selfId = selfId;
		const selfName = this.myName();
		if (h.selfName !== selfName) h.selfName = selfName;

		if (this.spec) {
			const name = this.spec.targetId !== null ? (this.remotes.get(this.spec.targetId)?.name ?? '') : '';
			const cur = h.spectating;
			if (!cur || cur.targetName !== name || cur.freeFly !== this.spec.freeFly)
				h.spectating = { targetName: name, freeFly: this.spec.freeFly };
		} else if (h.spectating) h.spectating = null;

		const netGraphLevel = this.cvars.num('net_graph');
		if (netGraphLevel <= 0) {
			if (h.netGraph !== null) h.netGraph = null;
		} else if (h.netGraph === null || now - this.lastNetGraph >= 200) {
			this.lastNetGraph = now;
			h.netGraph = this.netStats.view(now, netGraphLevel >= 2);
		}
	}

	private refreshSoloBoard(now: number): void {
		this.lastSoloBoard = now;
		const row: ScoreRow = {
			id: SOLO_ROW_ID,
			name: this.myName(),
			rank: null,
			pbTicks: null,
			status: Status.Runner,
			stage: 0,
			ping: 0,
			spectating: false,
			...this.client.soloRow()
		};
		this.hud.scoreboard = [row];
		const state = this.client.soloState?.();
		if (state) this.hud.modeState = state;
	}

	private remoteName(id: number): string {
		if (id === this.selfId) return this.myName();
		return this.remotes.get(id)?.name ?? `Player ${id}`;
	}

	/** Player whose role the HUD shows: the spectated target, else self. */
	private viewId(): number {
		return this.spec && !this.spec.freeFly && this.spec.targetId !== null ? this.spec.targetId : this.selfId;
	}

	// -----------------------------------------------------------------------
	// Number keys
	// -----------------------------------------------------------------------

	/** Console `slot N` (and `vote N`, the old name kept for saved binds): weapon slots in the armed modes. */
	slot(option: number): void {
		this.client.slot?.(option, performance.now());
	}

	// -----------------------------------------------------------------------
	// Spectating (online only)
	// -----------------------------------------------------------------------

	spectate(query: string): void {
		if (this.mode !== 'online') {
			this.notice('Spectating is only available online.');
			return;
		}
		const q = query.trim();
		if (this.spec && !q) return this.leaveSpectate(true);
		const targets = specTargets(this.remotes.values(), this.selfId);
		const id = q ? findTargetByName(targets, q) : cycleTarget(targets, this.spec?.targetId ?? null, 1);
		if (id === null) {
			this.notice(q ? `No player matching "${q}".` : 'No one to spectate.');
			return;
		}
		this.setSpecTarget(id);
	}

	private setSpecTarget(id: number): void {
		if (!this.spec) {
			this.releaseAll();
			this.spec = { targetId: id, freeFly: false, pos: { ...this.currEye } };
		} else {
			this.spec.targetId = id;
			this.spec.freeFly = false;
		}
		this.send({ type: 'spectate', targetId: id });
	}

	private cycleSpectate(dir: 1 | -1): void {
		if (!this.spec || this.spec.freeFly) return;
		const id = cycleTarget(specTargets(this.remotes.values(), this.selfId), this.spec.targetId, dir);
		if (id !== null && id !== this.spec.targetId) this.setSpecTarget(id);
	}

	private toggleFreeFly(): void {
		if (!this.spec) return;
		this.spec.freeFly = !this.spec.freeFly;
		if (!this.spec.freeFly) {
			const targets = specTargets(this.remotes.values(), this.selfId);
			if (this.spec.targetId === null || !targets.some((t) => t.id === this.spec!.targetId)) {
				const id = cycleTarget(targets, null, 1);
				if (id === null) {
					this.spec.freeFly = true;
					return;
				}
				this.setSpecTarget(id);
			}
		}
	}

	private leaveSpectate(notifyServer: boolean): void {
		if (!this.spec) return;
		this.spec = null;
		if (notifyServer) this.send({ type: 'spectate', targetId: null });
		this.releaseAll();
		this.client.respawn();
	}

	// -----------------------------------------------------------------------
	// Networking
	// -----------------------------------------------------------------------

	private send(msg: ClientMessage): void {
		if (this.mode === 'online') this.net?.send(msg);
	}

	connect(url: string): void {
		if (!this.conn.connect(url)) this.print(`connect: invalid server address "${url}"`, 'error');
		else this.print(`Connecting to ${url}...`);
	}

	disconnect(): void {
		this.conn.disconnect();
		this.print('Disconnected. Playing solo until "connect <url>".');
	}

	status(): string[] {
		return [
			`map: ${this.map.id} (${mapTitle(this.map)})`,
			`mode: ${this.mode}${this.mode === 'online' ? ` (${this.conn.client?.url ?? ''}, id ${this.selfId})` : ''}`,
			`players: ${this.hud.playerCount}`,
			`tick: ${this.tick}`
		];
	}

	private onOpen(client: NetClient, scope: string | null): void {
		if (scope === null || scope !== this.sessionScope) {
			this.sessionScope = scope;
			this.session = scope === null ? null : loadSession(this.store, scope);
			this.hud.account = this.session ? { username: this.session.username } : null;
			this.hud.authPanelOpen = !this.session && !isGuest(this.store);
		}
		this.helloToken = this.session?.token ?? null;
		client.send({
			type: 'hello',
			playerId: this.playerId,
			name: this.cvars.str('name'),
			version: PROTOCOL_VERSION,
			...(this.helloToken ? { token: this.helloToken } : {}),
			// Join the lobby of the map we are on (docs/architecture.md#lobbies).
			map: this.map.id
		});
	}

	private remote(id: number, name?: string): Remote {
		let r = this.remotes.get(id);
		if (!r) {
			r = { id, name: name ?? `Player ${id}`, spectating: false, buf: new SnapshotBuffer(), sample: emptySample(), hasSample: false };
			this.remotes.set(id, r);
		} else if (name !== undefined && r.name !== name) {
			r.name = name;
			this.renderer?.players.upsert(id, name);
		}
		return r;
	}

	private dropRemote(id: number): void {
		this.remotes.delete(id);
		this.renderer?.players.remove(id);
		if (this.spec?.targetId === id) {
			const next = cycleTarget(specTargets(this.remotes.values(), this.selfId), null, 1);
			if (next !== null) this.setSpecTarget(next);
			else {
				this.spec.targetId = null;
				this.spec.freeFly = true;
			}
		}
	}

	private updatePlayerCount(): void {
		this.hud.playerCount = this.mode === 'online' ? this.remotes.size + 1 : 1;
	}

	private onMessage(m: ServerMessage): void {
		const now = performance.now();
		if (m.type === 'welcome') return this.onWelcome(m, now);
		if (m.type === 'full') {
			this.conn.holdOff(FULL_HOLDOFF_MS);
			if (!this.fullNotified) {
				this.notice('Server full. Playing solo; will retry later.');
				this.print('Server full.');
			}
			this.fullNotified = true;
			this.conn.client?.close();
			return;
		}
		if (m.type === 'banned') {
			// Followed by close code 4009 (onClosed stops reconnecting).
			this.bannedReason = m.reason ?? '';
			this.bannedSecs = typeof m.seconds === 'number' && m.seconds > 0 ? m.seconds : null;
			return;
		}
		if (this.mode !== 'online') return;
		switch (m.type) {
			case 'join':
				if (m.player.id !== this.selfId) {
					this.remote(m.player.id, m.player.name).spectating = m.player.spectating;
					this.renderer?.players.setLoadout(m.player.id, sanitizeLoadout(m.player.loadout));
					this.updatePlayerCount();
					this.client.peopleChanged?.();
				}
				break;
			case 'leave':
				this.dropRemote(m.id);
				this.updatePlayerCount();
				this.client.peopleChanged?.();
				break;
			case 'rename':
				if (m.id !== this.selfId) this.remote(m.id, m.name);
				this.client.peopleChanged?.();
				break;
			case 'spectating':
				if (m.id === this.selfId) {
					if (!m.spectating && this.spec) this.leaveSpectate(false);
				} else if (this.remotes.has(m.id)) {
					this.remotes.get(m.id)!.spectating = m.spectating;
					if (m.spectating && this.spec?.targetId === m.id) this.cycleSpectate(1);
				}
				break;
			case 'chat':
				this.pushChat(m.from, m.text, m.system ?? m.from === null, m.admin === true);
				break;
			case 'maps':
				this.applyEnabledMaps(new Set(m.enabled));
				break;
			case 'lobbies':
				this.hud.lobbies = m.counts && typeof m.counts === 'object' ? { ...m.counts } : {};
				break;
			case 'adminState': {
				const { type: _t, ...state } = m;
				this.hud.adminState = state;
				break;
			}
			case 'adminResult':
				if (!m.ok || m.message) {
					this.hud.adminNotice = { ok: m.ok, text: m.ok ? (m.message ?? 'Done.') : (m.error ?? 'Failed.'), at: performance.now() };
				}
				break;
			case 'runResult': {
				this.records = m.records;
				this.applyRecords();
				if (m.pb || m.record) this.audio.recordChime();
				const extra = m.record ? ' New map record!' : m.pb ? ' New personal best!' : '';
				this.notice(`Finished in ${formatTicks(m.ticks)} (rank #${m.rank}).${extra}`);
				break;
			}
			case 'runRejected':
				this.notice(`Run not saved: ${m.reason}`);
				break;
			case 'records':
				this.records = mergeRecordsPush(this.records, m, this.mode, this.map.id);
				this.applyRecords();
				break;
			case 'mapChange':
				// We moved to another map's lobby: its players replace the old ones.
				if (this.spec) this.leaveSpectate(true);
				this.setRemotes(m.players);
				this.hud.scoreboard = [];
				this.hud.multiplier = null;
				this.loadMap(m.map, m.cvars, m.records);
				this.updatePlayerCount();
				this.notice(`Joined ${mapLabel(m.map)} · ${this.hud.playerCount} ${this.hud.playerCount === 1 ? 'player' : 'players'}.`);
				break;
			case 'scoreboard': {
				this.hud.scoreboard = m.rows;
				this.hud.richest = Array.isArray(m.richest) ? m.richest : [];
				const me = m.rows.find((r) => r.id === this.selfId);
				if (me && this.netStats.rtt < 0) this.netStats.recordRtt(me.ping);
				else if (me && me.ping > 0) this.netStats.recordRtt(me.ping);
				break;
			}
			case 'modeState':
				if (m.mode === this.gameMode.id) this.hud.modeState = m;
				this.client.message?.(m, now);
				break;
			case 'zm':
			case 'zd':
			case 'inf':
			case 'hns':
			case 'trn':
				if (m.ev.e === 'spawn' && m.ev.id === this.selfId && m.spawnSeq !== undefined) {
					const step = (m.spawnSeq - this.spawnSeq) & 0xffff;
					if (step >= 0x8000 || m.spawnSeq === 0) break;
					if (step !== 0) {
						this.client.message?.(m, now);
						this.spawnSeq = m.spawnSeq;
					}
					this.send({ type: 'spawnAck', seq: this.spawnSeq });
					break;
				}
				this.client.message?.(m, now);
				break;
			case 'tagged':
				this.client.message?.(m, now);
				break;
			case 'ping':
				this.net?.send({ type: 'pong', t: m.t });
				break;
			case 'pong': {
				const rtt = this.serverClock.observePong(m.t, now, m.serverTime);
				if (rtt >= 0) this.netStats.recordRtt(rtt);
				break;
			}
			case 'auth':
				this.onAuth(m);
				if (m.ok && m.username === null) this.hud.coins = null;
				break;
			case 'coins':
				this.hud.coins = { total: m.total, balance: m.balance, recent: m.recent };
				break;
			case 'award':
				this.hud.coins = applyAward(this.hud.coins, m);
				this.hud.awardPopups = pushPopup(this.hud.awardPopups, awardPopup(m, now));
				break;
			case 'coinsNotice':
				this.hud.awardPopups = pushPopup(this.hud.awardPopups, noticePopup(m, now));
				break;
			case 'cosmetics':
				// The own items come with `shop`.
				if (typeof m.id === 'number' && m.id !== this.selfId) this.renderer?.players.setLoadout(m.id, sanitizeLoadout(m.loadout));
				this.client.peopleChanged?.();
				break;
			case 'ghostLook':
				this.ghostLook = { map: m.map, loadout: sanitizeLoadout(m.loadout) };
				this.client.peopleChanged?.();
				break;
			case 'shop':
				this.hud.shop = { busy: this.hud.shop?.busy ?? false, notice: this.hud.shop?.notice ?? null, opened: this.hud.shop?.opened ?? null, ...parseShop(m) };
				this.client.peopleChanged?.();
				break;
			case 'shopResult':
				clearTimeout(this.shopTimer);
				if (this.hud.shop) this.hud.shop = { ...this.hud.shop, busy: false, notice: shopNotice(m) };
				break;
			case 'boxResult': {
				clearTimeout(this.shopTimer);
				if (m.ok) {
					this.boxUnseen = true;
					if (!this.boxScreen) this.boxRevealed();
				}
				const s = this.hud.shop;
				if (!s) break;
				if (m.ok) this.hud.shop = { ...s, busy: false, notice: null, opened: { n: (s.opened?.n ?? 0) + 1, item: m.item, duplicate: m.duplicate === true, refund: Number(m.refund) || 0 } };
				else this.hud.shop = { ...s, busy: false, notice: { ok: false, text: m.error } };
				break;
			}
			case 'boxNews': {
				const n = parseBoxNews(m, now);
				// The opener has the loot box screen in front of them.
				if (n && !(m.id === this.selfId && this.boxScreen)) this.hud.boxNews = pushBoxNews(this.hud.boxNews, n);
				break;
			}
			case 'casinoNews': {
				const n = parseCasinoNews(m, now);
				if (n) this.hud.boxNews = pushBoxNews(this.hud.boxNews, n);
				break;
			}
			case 'casino':
				this.onCasino(m, now);
				break;
			case 'crashStart':
				clearTimeout(this.casinoTimer);
				if (this.hud.casino) this.hud.casino = crashStarted(this.hud.casino, m, now);
				break;
			case 'casinoResult':
				this.onCasinoResult(m, now);
				break;
			case 'multiplier':
				this.hud.multiplier = { mult: m.mult, active: m.active, need: m.need };
				break;
		}
	}

	private onWelcome(m: Extract<ServerMessage, { type: 'welcome' }>, now: number): void {
		const client = this.conn.client;
		if (!client) return;
		if (m.version !== PROTOCOL_VERSION) return client.close(CLOSE_PROTOCOL_MISMATCH);
		this.net = client;
		this.mode = 'online';
		// The loot box pictures get ready now, not in the middle of a run.
		if (this.cvars.num('cl_boxnews') !== 0) warmItemPictures(m.selfId);
		this.fullNotified = false;
		this.selfId = m.selfId;
		this.spec = null;
		this.spawnSeq = 0;
		this.serverClock.reset();
		this.adaptiveDelay.reset(m.snapshotHz);
		this.lastRenderServerMs = 0;
		if (m.snapshotHz && m.snapshotHz > 0) this.serverClock.setNominalSnapHz(m.snapshotHz);
		if (m.serverTime !== undefined) this.serverClock.seed(now, m.serverTime);
		this.lastClientPing = now;
		client.send({ type: 'ping', t: now });
		this.netStats.reset();
		if (m.snapshotHz && m.snapshotHz > 0) this.netStats.setNominalSnapHz(m.snapshotHz);
		this.netStats.setInterpDelay(this.adaptiveDelay.currentMs);
		this.hud.ban = null;
		this.hud.coins = null;
		this.hud.multiplier = null;
		this.hud.shop = null;
		this.hud.casino = null;
		this.boxUnseen = false;
		this.setRemotes(m.players);
		this.applyWelcomeAccount(m.account);
		this.loadMap(m.map, m.cvars, m.records);
		this.hud.online = true;
		this.hud.connecting = false;
		this.updatePlayerCount();
		this.notice(`Connected. Playing ${mapTitle(this.map)} online.`);
		this.print(`Connected to ${client.url}`);
	}

	/** The players of the lobby we are in (welcome, mapChange), self excluded. */
	private setRemotes(players: readonly PlayerInfo[]): void {
		this.renderer?.players.clear();
		this.remotes.clear();
		for (const p of players) {
			if (p.id === this.selfId) continue;
			this.remote(p.id, p.name).spectating = p.spectating;
			this.renderer?.players.setLoadout(p.id, sanitizeLoadout(p.loadout));
		}
		this.client.peopleChanged?.();
	}

	private onSnapshot(frame: SnapshotFrame, arrival: number): void {
		if (this.mode !== 'online') return;
		const obs = this.serverClock.observeSnapshot(arrival, frame.serverTimeMs, frame.seq);
		this.netStats.recordSnapshot(arrival, {
			serverTimeMs: frame.serverTimeMs,
			seq: frame.seq,
			selfId: this.selfId,
			entries: obs.accepted ? frame.entries : undefined
		});
		if (!obs.accepted) return;
		this.adaptiveDelay.observeSnapshot(arrival, obs);
		for (const e of frame.entries) {
			if (e.id === this.selfId) continue;
			this.remote(e.id).buf.push(e, frame.serverTimeMs, arrival);
		}
	}

	private onClosed(wasOpen: boolean, code = 0): void {
		this.hud.connecting = false;
		this.hud.authBusy = false;
		if (code === 4009 || this.bannedReason !== null) {
			// Banned (docs/architecture.md#admin-and-bans): no reconnect until reload, or until a short ban lifts.
			const secs = this.bannedSecs;
			const reason = this.bannedReason || null;
			if (secs === null) this.conn.disconnect();
			else this.conn.holdOff(secs * 1000 + BAN_RECONNECT_MS);
			const why = reason ? ` Reason: ${reason.replace(/[.!?]?$/, '.')}` : '';
			const how = secs === null ? 'You are banned from this server.' : `You are banned from this server for ${countdown(secs)}.`;
			this.notice(`${how}${why} Playing solo.`);
			this.print(`${how}${why}`, 'error');
			const again = this.hud.ban !== null;
			this.hud.ban = {
				reason,
				until: secs === null ? null : performance.now() + secs * 1000,
				minimized: this.hud.ban?.minimized ?? false
			};
			if (!again) {
				this.releaseAll();
				this.hud.chatOpen = false;
				this.hud.settingsOpen = false;
				this.hud.authPanelOpen = false;
				this.input.exitLock();
			}
			this.bannedSecs = null;
			this.bannedReason = null;
			code = 4009;
		}
		if (code === 4002) {
			// Same player id or account connected from another tab/device: stop here instead of
			// reconnecting (which would kick the other one back).
			this.conn.disconnect();
			this.notice('You connected from another tab or device. Playing solo here; reload the page to reconnect.');
		}
		if (code === CLOSE_PROTOCOL_MISMATCH) {
			this.conn.holdOff(VERSION_HOLDOFF_MS);
			this.notice('The server runs a different version. Reload the page or wait to reconnect.');
		}
		if (code === CLOSE_IP_LIMIT) {
			// Retrying would fail until someone on this network leaves.
			this.conn.disconnect();
			this.notice('Too many players are connected from your network. Playing solo; reload the page to try again.');
		}
		if (this.mode !== 'online') {
			if (wasOpen) this.net = null;
			return;
		}
		this.mode = 'solo';
		this.net = null;
		this.selfId = -1;
		this.spec = null;
		this.hud.online = false;
		this.hud.lobbies = null;
		this.hud.scoreboard = [];
		this.hud.richest = [];
		this.hud.modeState = null;
		this.remotes.clear();
		this.spawnSeq = 0;
		this.serverClock.reset();
		this.adaptiveDelay.reset();
		this.lastRenderServerMs = 0;
		this.lastCombatPoseMs = 0;
		this.netStats.reset();
		this.renderer?.players.clear();
		this.records = null;
		this.hud.adminState = null;
		this.hud.coins = null;
		this.hud.shop = null;
		this.hud.casino = null;
		this.hud.multiplier = null;
		this.applyEnabledMaps(null);
		this.soloPb = loadSoloPb(this.store, this.map.id);
		this.applyRecords();
		if (this.client.offline) this.client.offline();
		else this.startMode();
		this.updatePlayerCount();
		if (code !== 4002 && code !== 4009 && code !== CLOSE_IP_LIMIT && code !== CLOSE_PROTOCOL_MISMATCH) this.notice('Disconnected from server. Playing solo; reconnecting automatically.');
	}

	// -----------------------------------------------------------------------

	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		cancelAnimationFrame(this.raf);
		clearTimeout(this.shopTimer);
		clearTimeout(this.casinoTimer);
		this.offCvars();
		this.client?.dispose();
		this.conn.dispose();
		this.input.dispose();
		this.fullscreen.dispose();
		this.audio.dispose();
		this.renderer?.dispose();
		disposeItemPictures();
		this.renderer = null;
	}
}
