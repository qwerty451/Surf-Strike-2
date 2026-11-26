/**
 * Contract between the game engine (src/lib/game, src/lib/render, src/lib/net,
 * src/lib/audio) and the Svelte UI (src/lib/ui, src/routes).
 *
 * The engine owns a single `HudState` instance (implemented as a class with
 * Svelte 5 `$state` fields in `hud.svelte.ts`) and a `GameApi`. The UI reads
 * `HudState` reactively and calls `GameApi` methods; it never touches Three.js
 * or the network directly.
 */
import type {
	AdminAction,
	AdminState,
	GameModeId,
	HnsPhase,
	HnsRole,
	HnsWinner,
	InfPerkId,
	InfPhase,
	InfTeam,
	TrnPhase,
	TrnRole,
	TrnStateView,
	CosmeticItem,
	CosmeticSlot,
	Loadout,
	ModeFamily,
	ModeState,
	PointLogEntry,
	RecordEntry,
	ScoreRow,
	BoxOffer,
	RichEntry,
	CasinoEntry,
	CasinoGame,
	CasinoNewsTier,
	CasinoOutcome,
	ClientMessage,
	ShopOffer,
	TagPhase,
	WeaponId,
	ZmPhase,
	ZmTeam
} from '@surf/shared';

export interface ChatLine {
	id: number;
	from: string | null; // null = system
	text: string; // plain text; UI must render as text (never {@html})
	system: boolean;
	at: number; // performance.now()
	/** Sender is a server admin (server-sent flag; never derived from the name). */
	admin?: boolean;
}

export interface ConsoleLine {
	id: number;
	text: string;
	kind: 'input' | 'output' | 'error' | 'echo';
}

export interface VoteView {
	labels: string[]; // option labels in key order (1..7: up to 6 maps "Surf · Kessler", then extend)
	counts: number[];
	endsAt: number; // performance.now() timestamp
	duration: number; // seconds
	myVote: number | null; // 1-based
	rtv: boolean;
	/** Set after the vote closes: winner label and change time. */
	result: { label: string; changeAt: number } | null;
}

/** Open RTV request: the CS2-style modal at the top (docs/ui.md#rtv-request). */
export interface RtvRequestView {
	initiator: string;
	/** Nominated map label ("Surf · Echo"), or null. */
	mapLabel: string | null;
	yes: number;
	no: number;
	/** Yes votes needed to pass. */
	needed: number;
	endsAt: number; // performance.now() timestamp
	duration: number; // total seconds (countdown bar)
	myChoice: 'yes' | 'no' | null;
	/** False for spectators (they see the modal but cannot vote). */
	canVote: boolean;
	/** Set when the request closed (shown briefly). */
	result: { passed: boolean; at: number } | null;
}

/** A rotation map as listed in the Esc menu's map list (Change map). */
export interface MapListEntry {
	id: string;
	title: string;
	kind: string; // gamemode (surf, bhop, ...)
	difficulty: string;
	/** Maps that come in sizes: shown instead of the difficulty (MapDef.size). */
	size?: 'medium' | 'large';
	/** Disabled by an admin (online): not in votes, greyed in Change map. */
	disabled?: boolean;
}

/** Tag HUD (docs/modes.md#tag); null in race modes. */
/** Zombies kill feed line. */
export interface KillFeedLine {
	id: number;
	text: string;
	head: boolean;
	/** The local player made the kill. */
	mine: boolean;
	at: number;
	/** Infected: a throwing-knife or bank-shot infection, drawn as `by [BADGE] victim`. */
	badge?: { kind: 'knife' | 'bank'; by: string; victim: string };
}

/** Zombies HUD (docs/modes.md#zombies, docs/ui.md#zombies-hud); null in other modes. */
export interface ZombiesView {
	phase: ZmPhase;
	round: number;
	/** performance.now() when the countdown / round summary ends (0 otherwise). */
	endsAt: number;
	/** performance.now() when the round started (playing; negative if that was before the page loaded), null otherwise. */
	startedAt: number | null;
	/** Survivor, or turned into a zombie (claws, zombie HP) for the rest of the round. */
	team: ZmTeam;
	/** The next gate that is not open: closed (go to its unlock area) or counting down. */
	gate: { index: number; count: number; state: 'closed' | 'counting'; opensAt: number } | null;
	/** Not alive: performance.now() of the (zombie) respawn, approximately. */
	respawnAt: number;
	hp: number;
	maxHp: number;
	alive: boolean;
	weapon: WeaponId;
	weaponLabel: string;
	/** Rounds in the magazine / magazine size / reserve; melee weapons have magSize 0. */
	mag: number;
	magSize: number;
	reserve: number;
	/** performance.now() when the reload finishes (0 = not reloading) and its length. */
	reloadEndsAt: number;
	reloadMs: number;
	/** The weapon can still be changed with 1-4 until loadoutEndsAt (performance.now()). */
	loadoutOpen: boolean;
	loadoutEndsAt: number;
	checkpoint: number;
	checkpoints: number;
	/** Front player's route progress 0..1. */
	progress: number;
	zombies: number;
	teamKills: number;
	myKills: number;
	hitMarker: { at: number; head: boolean; kill: boolean } | null;
	killFeed: KillFeedLine[];
	/** Short banner ("Checkpoint 2/5", "Go!"). */
	flash: { text: string; at: number } | null;
	/** Last time the local player was hit (red vignette). */
	hurtAt: number;
	/** Down: watching a teammate until the next checkpoint. */
	down: { targetName: string } | null;
	scoped: boolean;
	/** Round result while the summary shows. */
	summary: { won: boolean; secs: number; kills: number; top: string | null } | null;
	online: boolean;
}

/** Hide and seek HUD (docs/modes.md#hide-and-seek, docs/ui.md#hide-and-seek-hud); null in other modes. */
export interface HnsView {
	/** 'solo' = offline free roam (hide and seek needs a server and 2+ players). */
	phase: HnsPhase | 'solo';
	round: number;
	/** performance.now() when the current phase ends (0 while waiting). */
	endsAt: number;
	/** Role of the local (or spectated) player. */
	role: HnsRole;
	hidersLeft: number;
	seekerNames: string[];
	/** Hiding-phase seeker: black screen with the release countdown. */
	blindfold: boolean;
	/** performance.now() until the local player is frozen after being found (0 = not). */
	frozenUntil: number;
	finds: number;
	/** Short banner ("You were found by Alice", "Last hider!"). */
	flash: { text: string; at: number; tone: 'seeker' | 'hider' | 'info' | 'cash' } | null;
	killFeed: KillFeedLine[];
	/** Round result while the summary shows. */
	summary: { winner: HnsWinner; survivors: string[]; top: string | null } | null;
	/** Cash bag note; null when this round has none (or it cannot pay right now). */
	bag: HnsBagNote | null;
}

/** Cash bag on the HUD: still to come (`at`: performance.now()), out (where it is from here), or taken. */
export type HnsBagNote =
	| { phase: 'pending'; at: number }
	/** `turn`: degrees clockwise from the view direction to the spot, in steps; null close by. */
	| { phase: 'out'; place: string; meters: number; turn: number | null; canTake: boolean }
	| { phase: 'taken'; by: string; mine: boolean };

export interface TagView {
	/** 'solo' = offline free roam (tag needs a server and 2+ players). */
	phase: TagPhase | 'solo';
	round: number;
	/** performance.now() when the round ends (playing) or starts (countdown); 0 otherwise. */
	endsAt: number;
	/** The local (or spectated) player is IT. */
	isIt: boolean;
	/** Tag-back immunity (just tagged someone). */
	immune: boolean;
	itNames: string[];
	/** Seconds not being IT this round. */
	score: number;
	/** Short-lived banner ("You're IT!", "Alice tagged you"). */
	flash: { text: string; at: number } | null;
}

export interface InfectedView {
	/** 'solo' = offline free roam (infected needs a server and 2+ players). */
	phase: InfPhase | 'solo';
	round: number;
	/** performance.now() when grace / round / summary ends (0 in waiting/solo). */
	endsAt: number;
	team: InfTeam;
	/** Patient Zero, until the first infection. */
	alpha: boolean;
	/** Local player is the last remaining survivor (with >=2 infected). */
	lastSurvivor: boolean;
	loadout: WeaponId;
	loadoutLabel: string;
	survivors: number;
	infected: number;
	hp: number;
	maxHp: number;
	alive: boolean;
	respawnAt: number;
	weapon: WeaponId;
	weaponLabel: string;
	mag: number;
	magSize: number;
	reserve: number;
	reloadEndsAt: number;
	reloadMs: number;
	/** Infected: throwing knife is ready to throw. */
	hasKnife: boolean;
	/** Infected: thrown knife is stuck in the world awaiting pickup. */
	knifeOut: boolean;
	/** Infected: my respawn beacon is planted (the next respawn uses it). */
	hasBeacon: boolean;
	/** Infected: distance (metres) from me to my planted beacon, null when none or unknown. */
	beaconDist?: number | null;
	myScore: number;
	myKills: number;
	myDeaths: number;
	hitMarker: { at: number; head: boolean; kill: boolean } | null;
	killFeed: KillFeedLine[];
	flash: { text: string; at: number; tone?: 'neutral' | 'infected' | 'survivor' | 'bonus' } | null;
	/** Timestamp of the latest +20s infection clock bump. */
	timeBonusAt: number;
	/** Timestamp of the latest scavenger ammo refill. */
	scavengerAt: number;
	hurtAt: number;
	/** Timestamp of the latest UAV pulse. */
	uavAt: number;
	scoped: boolean;
	/** Scope overlay progress 0..1 of the two rifles (eased; it comes in over the last part of their aim); absent = follows `scoped`. */
	scopeT?: number;
	/** Aim down sights progress 0..1 (eased) of the held gun, every gun; 0 while spectating. */
	aimT?: number;
	/** Current hip cone half-angle in degrees (grows with fire and movement), whatever the aim; drives the crosshair gap. */
	spreadDeg?: number;
	summary: { winner: 'survivors' | 'infected'; secs: number; survivorsLeft: number; top: string | null } | null;
	/** Spectating someone (or free-fly): local viewmodel, scope, hurt and down panels are hidden. */
	spectating?: boolean;
	/** The spectated player (from the mode state), or null in free-fly / not spectating. */
	spec?: InfSpecView | null;
	/** Infected: distance (units) from me to the latest UAV ping, null when unknown. */
	uavDist?: number | null;
	/** Survivor secondary (slot 2, the pistol) and its label. */
	secondary: WeaponId;
	secondaryLabel: string;
	/** Survivor kill streak this life (0 for infected). */
	streak: number;
	/** Active kill streak perks (survivors; [] for infected). */
	perks: InfPerkId[];
	/** A M.O.A.B. is earned and can be called (N or 4). */
	moabReady: boolean;
	/** A called M.O.A.B. counting down: performance.now() when it detonates. */
	moab: { callerName: string; endsAt: number } | null;
	/** performance.now() of the latest M.O.A.B. detonation (0 = none this round). */
	moabDetonatedAt: number;
	/** My latest perk unlock (toast). */
	perkFlash: { perk: InfPerkId; at: number } | null;
	/** Score popups of the viewed player (me, or the spectate target), oldest first. */
	scorePops?: readonly import('./infected-hud-events.js').InfScorePop[];
	/** Recent hits on me with their direction relative to the view (none while spectating). */
	hurtDirs?: readonly import('./infected-hud-events.js').InfHurtDir[];
	/** Round summary table from the server's stats; null or absent: the one-line summary. */
	summaryRows?: readonly import('./infected-hud-events.js').InfSummaryRow[] | null;
	/** Label of the next round's survivor primary (round summary), when the server sent it. */
	nextLoadoutLabel?: string | null;
	/** Player whose summary row is highlighted: me, or the spectate target. */
	focusId?: number;
	/** Rounds left (magazine + reserve) in slot 1 (primary) and slot 2 (pistol). */
	slotAmmo?: readonly [number, number];
	/** The practice range is open (no round: offline, or waiting for a second player; never while spectating). */
	practice?: boolean;
}

/** One side of the live duel on the tournament duel bar. */
export interface TrnDuelSide {
	id: number;
	name: string;
	hp: number;
	/** Round wins in this duel. */
	wins: number;
	/** The local player. */
	self: boolean;
}

/** Bets on the current or next duel, as the bet panel shows them. */
export interface TrnBetPanel {
	match: number;
	open: boolean;
	a: { id: number; name: string; count: number };
	b: { id: number; name: string; count: number };
	/** The local player may bet now (logged in, not one of the two, no bet yet, bets open). */
	canBet: boolean;
	/** My accepted bet on this match. */
	mine: { pick: number; name: string } | null;
	/** Latest answer or outcome for this match (refusal reason, win, loss, refund). */
	note: { text: string; tone: 'ok' | 'bad' | 'won' | 'lost' | 'refund'; at: number } | null;
}

/** Tournament HUD (docs/modes.md#tournament, docs/ui.md#tournament-hud); null in other modes. */
export interface TournamentView {
	/** 'solo': offline free roam (a tournament needs a server and 2+ players). */
	phase: TrnPhase | 'solo';
	tournament: number;
	/** "Semifinal", "Final" … of the live or next duel ('' outside a tournament). */
	roundLabel: string;
	/** performance.now() when the phase or the duel round ends (0: no clock). */
	endsAt: number;
	/** Role of the viewed player (spectate target, else me). */
	role: TrnRole;
	/** I am not an entrant of the running tournament (joined late). */
	late: boolean;
	/** I am an entrant and was knocked out. */
	out: boolean;
	entrants: number;
	prize: number;
	duel: {
		a: TrnDuelSide;
		b: TrnDuelSide;
		/** Duel round, 1-based. */
		round: number;
		/** performance.now() when the freeze ends (0: live). */
		freezeUntil: number;
	} | null;
	/** Next duel's names between duels (bracket phase). */
	next: { a: string; b: string } | null;
	champion: { id: number; name: string; self: boolean } | null;
	/** Short event banner (duel start, round won, champion). */
	flash: { text: string; sub?: string; at: number; tone: 'duel' | 'win' | 'lose' | 'info' | 'gold' } | null;
	/** The tree overlay shows by itself (bracket and ended phases). */
	showBracket: boolean;
	/** Mode state for the bracket overlay (null before the first). */
	state: TrnStateView | null;
	selfId: number;
	bet: TrnBetPanel | null;
	/** My latest bet outcome, shown for a few seconds even after the bets moved on to the next duel. */
	betResult: { text: string; tone: 'won' | 'lost' | 'refund'; at: number } | null;
	// Weapons of the local player
	alive: boolean;
	/** Spectators carry the knife only. */
	knifeOnly: boolean;
	weapon: WeaponId;
	weaponLabel: string;
	mag: number;
	magSize: number;
	reserve: number;
	reloadEndsAt: number;
	reloadMs: number;
	hitMarker: { at: number; head: boolean; kill: boolean } | null;
	hurtAt: number;
	killFeed: KillFeedLine[];
	/** Sniper scope up (the crosshair hides). */
	scoped: boolean;
	/** Scope overlay progress 0..1. */
	scopeT: number;
	/** Aim progress 0..1 (eased); 0 while spectating. */
	aimT: number;
	/** Spectating someone (or free-fly): local weapons and feedback are hidden. */
	spectating: boolean;
}

/** What the infected HUD shows of a spectated player (only what `modeState` carries). */
export interface InfSpecView {
	id: number;
	name: string;
	team: InfTeam;
	alpha: boolean;
	hp: number;
	maxHp: number;
	alive: boolean;
	score: number;
	weapon: WeaponId;
	weaponLabel: string;
	hasKnife: boolean;
	/** Infected: this player's respawn beacon is planted. */
	hasBeacon: boolean;
	/** Survivor kill streak and active perks (0 / [] for infected). */
	streak: number;
	perks: InfPerkId[];
	/** This player can call a M.O.A.B. */
	moabReady: boolean;
}

/** One award popup or coins notice (docs/ui.md#award-popups). */
export interface AwardPopup {
	id: number;
	at: number; // performance.now()
	/** `+4.5`; '' for a notice. */
	amount: string;
	text: string;
	/** `×1.5`; '' for a notice. */
	mult: string;
	tone: 'award' | 'info' | 'warn';
}

/** Someone opened a loot box (docs/ui.md#box-news). */
export interface BoxNews {
	id: number;
	at: number; // performance.now()
	name: string;
	item: CosmeticItem;
	duplicate: boolean;
}

/** Someone won big in the casino (docs/ui.md#box-news). */
export interface CasinoNews {
	id: number;
	at: number; // performance.now()
	name: string;
	game: CasinoGame;
	tier: CasinoNewsTier;
	/** Payout divided by bet, as text: `12.5×`. */
	mult: string;
	/** Tenths. */
	payout: number;
}

/** The account's coins (docs/economy.md); amounts in tenths. */
export interface CoinsView {
	total: number;
	balance: number;
	/** Newest first. */
	recent: readonly PointLogEntry[];
}

/** The shop (docs/ui.md#shop); prices in tenths of a coin. */
export interface ShopView {
	/** What the server sells; may hold items this client does not know. */
	items: readonly ShopOffer[];
	owned: readonly string[];
	/** Worn items (sanitized). */
	loadout: Loadout;
	/** The loot box on sale; null: older server. */
	box: BoxOffer | null;
	/** Last opened box; `n` counts up, so the same item twice is still a new result. */
	opened: { n: number; item: string; duplicate: boolean; refund: number } | null;
	/** A request waits for the server's reply. */
	busy: boolean;
	/** Last result, shown in the shop and the inventory; `bought`: the item just bought. */
	notice: { ok: boolean; text: string; bought?: string } | null;
}

/** The casino (docs/ui.md#casino); amounts in tenths unless noted. */
export interface CasinoView {
	/** Smallest bet per game and largest bet, whole coins. */
	min: Readonly<Record<CasinoGame, number>>;
	max: number;
	/** Won minus bet, all time; and what it was when this session began. */
	net: number;
	baseline: number;
	/** Newest first. */
	recent: readonly CasinoEntry[];
	/** The running crash round; `startedAt` is performance.now(). */
	crash: { bet: number; auto: number | null; startedAt: number } | null;
	/** Last settled bet; `n` counts up. */
	last: { n: number; outcome: CasinoOutcome } | null;
	/** A request waits for the server's reply. */
	busy: boolean;
	error: { n: number; text: string } | null;
}

export type CasinoBet = Extract<ClientMessage, { type: 'casinoBet' }>;
export type CasinoSound = 'bet' | 'flip' | 'tick' | 'stop' | 'crash' | 'win' | 'big';

/** A live character turntable on a canvas of the UI. */
export interface CharacterPreviewHandle {
	setLoadout(loadout: Loadout): void;
	/** Small pictures of items (data URLs), one per frame. Replaces the pictures still waiting. */
	thumbnails(ids: readonly string[], ready: (id: string, url: string) => void): void;
	dispose(): void;
}

export interface BanView {
	reason: string | null;
	/** performance.now() when it lifts by itself; null = permanent. */
	until: number | null;
	/** The player chose to play solo meanwhile (small notice instead of the screen). */
	minimized: boolean;
}

export interface HudStateShape {
	// Connection / lobby
	online: boolean;
	connecting: boolean;
	playerCount: number;
	maxPlayers: number;
	// Map
	mapId: string;
	mapTitle: string;
	mapTimeLeft: number; // seconds
	// Gamemode (docs/modes.md): race HUD (timer, splits, records) only when modeFamily is 'race'.
	gameMode: GameModeId;
	modeFamily: ModeFamily;
	tag: TagView | null;
	zombies: ZombiesView | null;
	infected: InfectedView | null;
	hns: HnsView | null;
	tournament: TournamentView | null;
	/** Tournament: the bracket hold key (`+bracket`, B) is down. */
	bracketHeld: boolean;
	/** Rotation maps, in rotation order (Esc menu, Change map). */
	maps: MapListEntry[];
	/** Solo, or online as the only connected client: the Esc menu may switch maps directly. */
	canChangeMap: boolean;
	// Movement
	speed: number; // horizontal u/s of the local (or spectated) player
	speedTrend: 'up' | 'down' | 'flat';
	keys: { w: boolean; a: boolean; s: boolean; d: boolean; jump: boolean; duck: boolean };
	// Run
	runPhase: 'start' | 'running' | 'finished' | 'idle';
	runTicks: number;
	stage: number; // current stage or last checkpoint (0 = none)
	stageCount: number; // number of stages (staged) or checkpoints
	stageKind: 'stage' | 'checkpoint';
	unofficial: boolean; // sv_* changed in solo
	splitPopup: { label: string; ticks: number; delta: number | null; at: number } | null;
	pbTicks: number | null;
	pbRank: number | null;
	recordTicks: number | null;
	recordName: string | null;
	/** Race: the map's leaderboard top (null offline or from an older server). */
	recordTop: RecordEntry[] | null;
	// Account (docs/gameplay.md#accounts-and-identity)
	/** Logged-in account; null = guest (runs are not saved to the leaderboard). */
	account: { username: string; admin?: boolean } | null;
	/** Coins of the account; null for guests, offline and on servers without coins. */
	coins: CoinsView | null;
	/** The shop; null offline and on servers without one. */
	shop: ShopView | null;
	/** The casino; null offline and on servers without one. */
	casino: CasinoView | null;
	/** Coins multiplier (tenths), active players and how many this mode needs; null offline and on servers without coins. */
	multiplier: { mult: number; active: number; need: number } | null;
	/** Award popups, oldest first. */
	awardPopups: readonly AwardPopup[];
	/** Latest loot box and casino news, oldest first; the HUD queues and shows them. */
	boxNews: readonly (BoxNews | CasinoNews)[];
	/** Banned from the server (docs/ui.md#ban-screen). */
	ban: BanView | null;
	/** Admin menu data (docs/ui.md#admin); only sent by the server to admin accounts, null otherwise. */
	adminState: AdminState | null;
	/** Result of the last admin action (shown in the Admin menu). */
	adminNotice: { ok: boolean; text: string; at: number } | null;
	/** Last register/login error from the server or offline notice; null when none. */
	authError: string | null;
	/** A register/login request is waiting for the server. */
	authBusy: boolean;
	// Social
	chat: ChatLine[]; // last 100
	chatOpen: boolean;
	vote: VoteView | null;
	rtvRequest: RtvRequestView | null;
	/** No RTV request before `until` (performance.now()): decline cooldown or map-start block. */
	rtvCooldown: { until: number; reason: 'declined' | 'mapStart' } | null;
	scoreboardOpen: boolean;
	/** Rows of the Tab scoreboard and the score panel (solo: one row). */
	scoreboard: ScoreRow[];
	/** Accounts with the most coins, richest first; empty offline and on older servers. */
	richest: readonly RichEntry[];
	/** Id of the local player's row in `scoreboard`. */
	selfId: number;
	/** Name shown for the local player. */
	selfName: string;
	/** Latest mode state, for score metrics that need it (modes/score.ts); null in race modes. */
	modeState: ModeState | null;
	spectating: { targetName: string; freeFly: boolean } | null;
	// Overlays
	consoleOpen: boolean;
	consoleLines: ConsoleLine[]; // last 500
	settingsOpen: boolean;
	/**
	 * Account panel (Login | Register | Play as guest). Replaces the old
	 * first-visit name prompt: open on first visit and when a stored session
	 * is rejected (unless the player already chose guest).
	 */
	authPanelOpen: boolean;
	pointerLocked: boolean;
	/** Fullscreen can block Ctrl+W here (Keyboard Lock API, Chromium). */
	fullscreenSupported: boolean;
	desktopOnly: boolean; // touch-only device detected
	// Debug readouts (only meaningful when the matching cvar is on)
	fps: number;
	pos: { x: number; y: number; z: number; pitch: number; yaw: number; vx: number; vy: number; vz: number };
	// Client cvar mirror for UI (crosshair, showfps, ...). Keys are cvar names.
	cvars: Record<string, number | string>;
}

export interface GameApi {
	/** Run a console line (e.g. "sensitivity 2.5", "bind mouse3 +jump"). Output goes to consoleLines. */
	exec(line: string): void;
	/** Console tab completion: returns matching command/cvar names. */
	complete(prefix: string): string[];
	/** Console history (oldest first). */
	history(): string[];
	/** Send chat text; "!..." commands handled here (local or sent to server). */
	sendChat(text: string): void;
	setCvar(name: string, value: number | string): void;
	/** Log in over the open connection; result lands in hud.account / hud.authError. */
	login(username: string, password: string): void;
	/** Create an account and log in. Same rules as the server (usernameError/passwordError in @surf/shared). */
	register(username: string, password: string): void;
	/** End the session (server and localStorage); back to the guest name. */
	logout(): void;
	/** Choose guest play with this name; closes the account panel. */
	playAsGuest(name: string): void;
	/** Open the account panel (e.g. from the Esc menu). */
	openAuth(): void;
	/** Close the account panel (first visit: same as playing as guest with the current name). */
	closeAuth(): void;
	/** Request pointer lock on the game canvas (call from a click handler). */
	lockPointer(): void;
	openChat(): void;
	closeChat(): void;
	toggleConsole(): void;
	closeSettings(): void;
	/** Cast a vote (1-based). */
	vote(option: number): void;
	/** Answer the open RTV request (same as keys 1 / 2). */
	rtvVote(yes: boolean): void;
	/** Tournament: bet TRN_BET coins on duelist `pick` of the current or next duel (same as keys 1 / 2 while betting). */
	trnBet(pick: number): void;
	/**
	 * Pick a map from Change map: switch at once (solo, or online when alone;
	 * see canChangeMap), otherwise start an RTV request nominating it.
	 */
	changeMap(id: string): void;
	/** Ban screen: play solo until the ban is over (or go back to the screen). */
	minimizeBan(minimized: boolean): void;
	/** Shop (docs/ui.md#shop): buy an item; the reply lands in `shop`. */
	shopBuy(item: string): void;
	/** Buy and open a loot box; the result lands in `shop.opened`, or an error in `shop.notice`. */
	boxOpen(): void;
	/** The opener sees the result: the server may tell everyone. */
	boxRevealed(): void;
	/** The loot box screen opened or closed (closing it also reveals). */
	boxScreen(open: boolean): void;
	/** Loot box sounds; the last two are for the news of others (quieter). */
	boxSound(name: 'open' | 'tick' | 'reveal' | 'rare' | 'news' | 'newsRare'): void;
	/** Casino: place a bet; the result lands in `casino.last` (crash: in `casino.crash` first), an error in `casino.error`. */
	casinoBet(bet: CasinoBet): void;
	/** Cash out the running crash round. */
	crashCashout(): void;
	casinoSound(name: CasinoSound): void;
	/** Crash, every frame: the build-up at this multiplier (1 = start), null ends it; `out`: already cashed out. */
	crashBuild(mult: number | null, out?: boolean): void;
	/** Wear an owned item, or `null` for the slot's default. */
	shopEquip(slot: CosmeticSlot, item: string | null): void;
	/** Turntable of the local player's character; null without WebGL. Dispose it. */
	createPreview(canvas: HTMLCanvasElement): CharacterPreviewHandle | null;
	/** Picture of one item (data URL) without an open shop; null without WebGL. */
	itemPicture(id: string): Promise<string | null>;
	/** Admin menu request (re-checked by the server); replies land in adminState / adminNotice. */
	admin(action: AdminAction): void;
}

/**
 * Entry point, implemented by the engine in `src/lib/game/index.ts`:
 *
 *   export function createGame(canvas: HTMLCanvasElement): GameHandle
 *
 * Keyboard/mouse ownership:
 * - The engine listens on window for keys/mouse and runs binds (movement,
 *   Y = openChat, ` / ~ = toggleConsole, Tab = scoreboard while held, 1-9 map vote /
 *   1-2 RTV request (vote.ts routeVoteKey, ahead of binds),
 *   M spectate, R restart, wheel jump). Pointer-lock loss while no overlay is
 *   open sets settingsOpen = true (browsers swallow Esc when exiting lock).
 * - While chatOpen or consoleOpen or settingsOpen or authPanelOpen is true,
 *   the engine ignores all game binds except the console toggle key (when the
 *   console is open). The UI owns text inputs: Enter/Escape in the chat input
 *   call sendChat/closeChat; Escape in the console calls toggleConsole.
 * - Clicking the canvas while no overlay is open calls lockPointer().
 */
export interface GameHandle {
	hud: HudStateShape; // reactive ($state-backed) object
	api: GameApi;
	destroy(): void;
}
