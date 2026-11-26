/**
 * Reactive HUD state shared with the Svelte UI (contract.ts HudStateShape).
 * Primitives are updated each frame only when they change; arrays use
 * `$state.raw` and are replaced, never mutated.
 */
import { MAX_PLAYERS, type AdminState, type GameModeId, type ModeFamily, type ModeState, type RecordEntry, type RichEntry, type ScoreRow } from '@surf/shared';
import type {
	AwardPopup,
	BoxNews,
	CasinoNews,
	BanView,
	ChatLine,
	CoinsView,
	CasinoView,
	ShopView,
	ConsoleLine,
	HnsView,
	HudStateShape,
	InfectedView,
	MapListEntry,
	NetGraphView,
	RtvRequestView,
	TagView,
	VoteView,
	ZombiesView
} from './contract.js';

export class HudState implements HudStateShape {
	online = $state(false);
	connecting = $state(false);
	playerCount = $state(1);
	maxPlayers = $state(MAX_PLAYERS);

	mapId = $state('');
	mapTitle = $state('');
	mapTimeLeft = $state(0);
	gameMode = $state<GameModeId>('surf');
	modeFamily = $state<ModeFamily>('race');
	tag = $state.raw<TagView | null>(null);
	zombies = $state.raw<ZombiesView | null>(null);
	infected = $state.raw<InfectedView | null>(null);
	hns = $state.raw<HnsView | null>(null);
	maps = $state.raw<MapListEntry[]>([]);
	canChangeMap = $state(true);

	speed = $state(0);
	speedTrend = $state<'up' | 'down' | 'flat'>('flat');
	keys = $state({ w: false, a: false, s: false, d: false, jump: false, duck: false });

	runPhase = $state<'start' | 'running' | 'finished' | 'idle'>('idle');
	runTicks = $state(0);
	stage = $state(0);
	stageCount = $state(0);
	stageKind = $state<'stage' | 'checkpoint'>('checkpoint');
	unofficial = $state(false);
	splitPopup = $state.raw<{ label: string; ticks: number; delta: number | null; at: number } | null>(null);
	pbTicks = $state<number | null>(null);
	pbRank = $state<number | null>(null);
	recordTicks = $state<number | null>(null);
	recordName = $state<string | null>(null);
	recordTop = $state.raw<RecordEntry[] | null>(null);

	account = $state.raw<{ username: string; admin?: boolean } | null>(null);
	coins = $state.raw<CoinsView | null>(null);
	shop = $state.raw<ShopView | null>(null);
	casino = $state.raw<CasinoView | null>(null);
	multiplier = $state.raw<{ mult: number; active: number; need: number } | null>(null);
	awardPopups = $state.raw<readonly AwardPopup[]>([]);
	boxNews = $state.raw<readonly (BoxNews | CasinoNews)[]>([]);
	ban = $state.raw<BanView | null>(null);
	adminState = $state.raw<AdminState | null>(null);
	adminNotice = $state.raw<{ ok: boolean; text: string; at: number } | null>(null);
	authError = $state<string | null>(null);
	authBusy = $state(false);

	chat = $state.raw<ChatLine[]>([]);
	chatOpen = $state(false);
	vote = $state.raw<VoteView | null>(null);
	rtvRequest = $state.raw<RtvRequestView | null>(null);
	rtvCooldown = $state.raw<{ until: number; reason: 'declined' | 'mapStart' } | null>(null);
	scoreboardOpen = $state(false);
	scoreboard = $state.raw<ScoreRow[]>([]);
	richest = $state.raw<readonly RichEntry[]>([]);
	selfId = $state(0);
	selfName = $state('');
	modeState = $state.raw<ModeState | null>(null);
	spectating = $state.raw<{ targetName: string; freeFly: boolean } | null>(null);

	consoleOpen = $state(false);
	consoleLines = $state.raw<ConsoleLine[]>([]);
	settingsOpen = $state(false);
	authPanelOpen = $state(false);
	pointerLocked = $state(false);
	fullscreenSupported = $state(false);
	desktopOnly = $state(false);

	fps = $state(0);
	pos = $state({ x: 0, y: 0, z: 0, pitch: 0, yaw: 0, vx: 0, vy: 0, vz: 0 });
	netGraph = $state.raw<NetGraphView | null>(null);

	cvars = $state.raw<Record<string, number | string>>({});
}
