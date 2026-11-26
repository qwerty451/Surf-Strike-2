/**
 * Dev-only HUD mock (used with `?mockhud`). Builds a reactive HudStateShape
 * with sample data and a GameApi that only flips UI flags, so the UI can be
 * previewed without the engine. Optional `&open=console|settings|maps|auth|scoreboard|chat|desktop`;
 * with `open=settings`, `&view=maps|settings|account` and `&tab=mouse|video|hud|audio`
 * start the Esc menu on a submenu (`&solo=0` makes map changes vote-only; `&view=admin`
 * logs in as an admin and opens the Admin submenu, `&tab=maps|players|bans`; `&rtv=1` shows
 * an RTV request instead of the map vote, `&rtv=cooldown` a declined-request cooldown).
 * Scores: `&mode=<gamemode>` (its score panel and scoreboard), `&players=<n>` (default 5),
 * `&self=<n>` your position, `&old=1` an older server (no leaderboard top, no totals),
 * `&novote=1` without the map vote. Coins: `&coins=<n>` n award popups, `&coins=0` a guest,
 * `&view=coins` the Coins submenu, `&view=shop` the Shop (`&balance=<coins>`, `&noshop` a server without it),
 * `&view=casino` the Casino, playable (`&tab=coinflip|crash|slots`, `&nocasino` a server without it, `&roll=<0..1>` a fixed roll),
 * `&view=inventory` the Inventory (`&items=<n>` owned items, default 130, with made-up ones; 0 = empty), `&ban=<seconds>` the ban screen (`&ban=0` permanent),
 * `&boxnews` loot box news (one of each rarity in turn; `=<rarity or item id>`, `=all` many at once).
 * Infected: `&mode=infected` shows the Infected HUD: `&scene=` one of
 * INF_MOCK_SCENES (infected-mock.ts), `&vote=1` keeps the map vote open, `&keys=0` hides
 * the keys display. `&scale=1` forces `--hud-scale`.
 */
import { cosmeticPrice, COSMETIC_SLOTS, CASINO_MAX_BET, CASINO_MIN, coinflipPayout, crashPayout, crashState, pts, rollCoin, rollCrash, rollSlots, slotPayout, emptyLoadout, gameMode, getCosmetic, isGameModeId, listCosmetics, LOOTBOX, lootItems, registerCosmetic, rollLoot, shopItems, Status, TICK_RATE, type RarityId, type GameModeId, type LootRarity, type ModeState, type ScoreRow, type CasinoOutcome } from '@surf/shared';
import { itemMesh, registerItemMesh } from '#lib/render/character/items.js';
import { CharacterPreview, itemPicture } from '#lib/render/character/preview.js';
import { parseBoxNews, parseCasinoNews, pushBoxNews } from '#lib/game/box-news.js';
import { casinoError, casinoResult, crashStarted, parseCasino } from '#lib/game/casino.js';
import { awardPopup, noticePopup } from '#lib/game/coins.js';
import type { GameApi, GameHandle, HudStateShape } from '#lib/game/contract.js';
import { isDefenseMockScene, mockDefenseState, mockDefenseView, mockMenu, sceneMenu, type DefenseMockScene } from '#lib/ui/defense-mock.js';
import { infMockSpectates, isInfMockScene, mockInfectedView, type InfMockScene } from '#lib/ui/infected-mock.js';

const T = TICK_RATE;

const MOCK_NAMES = ['glidepath', 'you', 'cirrus', 'boreal', 'WWWWWWWWWWWWWWWWWWWWWWWW', 'A name of 24 characters!', 'Guest-4f1a', 'tim'];

const MOCK_WARNING =
	'Your coins are paused for 5 minutes: this looks like point farming. Play normally and nothing else happens; if it continues you are banned for 5 minutes.';

function mockAwards(n: number) {
	const labels = ['Found a hider', 'Playtime', 'Hiding in plain view', 'Evacuated', 'Being chased', 'Shop: hat', 'Coinflip won', 'Crash lost'];
	return Array.from({ length: n }, (_, i) => ({
		at: Date.now() - i * 95_000,
		reason: ['x', 'x', 'x', 'x', 'x', 'shop:hat', 'casino:coinflip', 'casino:crash'][i % labels.length]!,
		label: labels[i % labels.length]!,
		amount: [45, 100, 24, 160, 15, -750, 200, -50][i % labels.length]!,
		mult: i % labels.length === 1 ? 10 : 15
	}));
}

/** Scoreboard rows as the mode's server module builds them. */
function mockRows(mode: GameModeId, n: number, self: number, old: boolean): ScoreRow[] {
	const rows: ScoreRow[] = [];
	for (let i = 0; i < n; i++) {
		const base: ScoreRow = {
			id: i + 1,
			name: i === self - 1 ? 'you' : (MOCK_NAMES.filter((x) => x !== 'you')[i] ?? `player ${i + 1}`),
			rank: null,
			pbTicks: null,
			status: Status.Idle,
			stage: 0,
			ping: 20 + ((i * 17) % 90),
			spectating: false,
			admin: i === 7 || undefined
		};
		if (!old) {
			const guest = i % 3 === 2;
			base.coins = guest ? null : i === 0 ? 1_234_567 : i === 1 ? 745 : 0;
			base.pointsTotal = guest ? null : i === 0 ? 1_234_567 : 0;
			base.playtimeSecs = guest ? null : [987 * 3600 + 34 * 60, 45_260, 59, 2_040][i % 4];
		}
		const score = Math.max(0, 180 - i * 11.3);
		const byMode: Record<GameModeId, Partial<ScoreRow>> = {
			surf: { rank: i < 4 ? i + 1 : null, pbTicks: i < 4 ? Math.round((138.9 + i * 4.2) * T) : null, status: i % 2 ? Status.Running : Status.StartZone, stage: i + 1 },
			bhop: { rank: i + 1, pbTicks: Math.round((58.9 + i * 4.2) * T), status: Status.Running },
			tag: { score, it: i === 1, status: i === 1 ? Status.Tagger : Status.Runner },
			zombies: { kills: Math.max(0, 140 - i * 13), deaths: i % 3, status: i % 4 === 3 ? Status.Down : Status.Alive },
			infected: {
				score: Math.max(0, 2450 - i * 150),
				kills: Math.max(0, 24 - i * 2),
				deaths: i,
				status: i === 2 ? Status.Alpha : i % 2 ? Status.Infected : Status.Alive
			},
			hns: { score, kills: i % 4, status: i % 3 === 1 ? Status.Seeker : Status.Hider },
			defense: { kills: Math.max(0, 90 - i * 9), score: 1200 - i * 90, status: i % 4 === 3 ? Status.Down : Status.Alive }
		};
		rows.push({ ...base, ...byMode[mode] });
	}
	if (n > 1) rows.push({ ...rows[0]!, id: 99, name: 'lurker', status: Status.Spectating, spectating: true });
	return rows;
}

/** What the shop sells (before mockOwned() adds made-up items). */
const MOCK_OFFERS = shopItems().map((i) => ({ id: i.id, price: cosmeticPrice(i)! }));
const MOCK_SLOTS = COSMETIC_SLOTS.filter((s) => s !== 'effect');
const MOCK_WORDS = ['Coral', 'Midnight', 'Neon', 'Dune', 'Frost', 'Ember', 'Moss', 'Violet', 'Salt', 'Copper', 'Glass'];

/** `n` owned items: a few from the shop, all loot, then made-up loot drawn like a real item. */
function mockOwned(n: number): string[] {
	const real = listCosmetics().filter((i) => !i.isDefault && !i.id.startsWith('mock_'));
	const ids = ['hat_cap', 'top_sunset', 'shoes_slides', ...real.filter((i) => cosmeticPrice(i) === null).map((i) => i.id)].slice(0, n);
	const rarities: RarityId[] = ['common', 'common', 'uncommon', 'common', 'rare', 'uncommon', 'common', 'epic'];
	for (let i = 0; ids.length < n; i++) {
		const slot = MOCK_SLOTS[i % MOCK_SLOTS.length]!;
		const like = real.filter((r) => r.slot === slot);
		const base = like[Math.floor(i / MOCK_SLOTS.length) % like.length]!;
		const id = `mock_${slot}_${i}`;
		if (!getCosmetic(id)) {
			registerCosmetic({ id, slot, name: `${MOCK_WORDS[i % MOCK_WORDS.length]} ${base.name.toLowerCase()}`, rarity: rarities[i % rarities.length]! });
			const mesh = itemMesh(base.id);
			if (mesh) registerItemMesh(id, mesh);
		}
		ids.push(id);
	}
	return ids;
}

/** Only what the score metrics read of a mode state. */
function mockState(mode: GameModeId, rows: ScoreRow[]): ModeState | null {
	if (mode === 'surf' || mode === 'bhop') return null;
	if (mode === 'defense') return mockDefenseState(rows);
	const players = rows.map((r, i) => ({ id: r.id, team: r.status === Status.Alive ? 'survivor' : 'infected', streak: i * 3 }));
	return { mode, phase: 'playing', round: 12, progress: 0.43, checkpoint: 2, checkpoints: 5, players } as unknown as ModeState;
}

export function createMockGame(canvas: HTMLCanvasElement, open: string | null): GameHandle {
	const t0 = performance.now();
	const params = new URLSearchParams(location.search);
	const modeParam = params.get('mode');
	const mode: GameModeId = isGameModeId(modeParam) ? modeParam : 'surf';
	const old = params.has('old');
	const selfPos = Number(params.get('self') ?? 2);
	const rows = mockRows(mode, Number(params.get('players') ?? 5), selfPos, old);
	const race = gameMode(mode).family === 'race';
	const coinsN = params.has('coins') ? Number(params.get('coins')) : null;
	const asAdmin = params.get('view') === 'admin' || params.has('admin');
	const sceneParam = params.get('scene');
	const infScene: InfMockScene | null = params.get('mode') === 'infected' ? (isInfMockScene(sceneParam) ? sceneParam : 'survivor') : null;
	const defScene: DefenseMockScene | null = mode === 'defense' ? (isDefenseMockScene(sceneParam) ? sceneParam : 'build') : null;
	let defPage = defScene ? sceneMenu(defScene) : null;
	const scale = params.get('scale');
	if (scale) document.documentElement.style.setProperty('--hud-scale', scale);
	if (params.has('boxall')) mockOwned(130);
	const owned = coinsN === 0 ? [] : mockOwned(Number(params.get('items') ?? 130));
	const hud: HudStateShape = $state({
		online: true,
		connecting: false,
		playerCount: 12,
		maxPlayers: 32,
		mapId: infScene ? 'infected_outpost' : defScene ? 'defense_blackthorn' : 'surf_ember',
		mapTitle: infScene ? 'Outpost' : defScene ? 'Blackthorn Farm' : 'Ember',
		mapTimeLeft: 462,
		gameMode: mode,
		modeFamily: gameMode(mode).family,
		tag: null,
		zombies: null,
		defense: defScene ? mockDefenseView(defScene, t0) : null,
		infected: infScene ? mockInfectedView(infScene, t0) : null,
		hns: null,
		maps: [
			{ id: 'surf_aurora', title: 'Aurora', kind: 'surf', difficulty: 'easy' },
			{ id: 'surf_ember', title: 'Ember', kind: 'surf', difficulty: 'hard' },
			{ id: 'bhop_meadow', title: 'Meadow', kind: 'bhop', difficulty: 'easy' },
			{ id: 'surf_tidal', title: 'Tidal', kind: 'surf', difficulty: 'easy' },
			{ id: 'bhop_quarry', title: 'Quarry', kind: 'bhop', difficulty: 'hard' },
			{ id: 'tag_courtyard', title: 'Courtyard', kind: 'tag', difficulty: 'easy', disabled: true }
		],
		canChangeMap: params.get('solo') !== '0',
		speed: 1287,
		speedTrend: 'up',
		keys: { w: false, a: true, s: false, d: false, jump: true, duck: false },
		runPhase: 'running',
		runTicks: Math.round(72.402 * T),
		stage: 3,
		stageCount: 6,
		stageKind: 'stage',
		unofficial: false,
		splitPopup: { label: 'Stage 3', ticks: Math.round(72.402 * T), delta: Math.round(-0.213 * T), at: t0 },
		pbTicks: race ? Math.round(151.337 * T) : null,
		pbRank: race ? selfPos : null,
		recordTicks: race ? Math.round((selfPos === 1 ? 151.337 : 138.902) * T) : null,
		recordName: race ? 'glidepath' : null,
		recordTop:
			race && !old
				? Array.from({ length: 10 }, (_, i) => ({
						rank: i + 1,
						name: i === selfPos - 1 ? 'you' : (MOCK_NAMES.filter((x) => x !== 'you')[i] ?? `runner ${i + 1}`),
						ticks: Math.round((i === selfPos - 1 ? 151.337 : 138.902 + i * 4.1) * T),
						...(i === selfPos - 1 ? { self: true } : {})
					}))
				: null,
		account: open === 'auth' || coinsN === 0 ? null : asAdmin ? { username: 'Tim', admin: true } : { username: 'you' },
		coins: coinsN === 0 || old ? null : { total: 123_456, balance: params.has('balance') ? Number(params.get('balance')) * 10 : 7_459, recent: mockAwards(30) },
		shop:
			old || params.has('noshop')
				? null
				: {
						items: MOCK_OFFERS,
						owned,
						loadout: owned.length < 3 ? emptyLoadout() : { ...emptyLoadout(), hat: 'hat_cap', shoes: 'shoes_slides' },
						// `&boxall`: made-up items of every rarity too.
						box: { price: LOOTBOX.price, odds: LOOTBOX.odds, items: lootItems().filter((i) => params.has('boxall') || !i.id.startsWith('mock_')).map((i) => i.id) },
						opened: null,
						busy: false,
						notice: null
					},
		casino:
			old || params.has('nocasino')
				? null
				: parseCasino(
						{
							type: 'casino',
							min: CASINO_MIN,
							max: CASINO_MAX_BET,
							net: coinsN === 0 ? 0 : -340,
							recent: Array.from({ length: coinsN === 0 ? 0 : 21 }, (_, i) => ({
								at: Date.now() - i * 60_000,
								game: (['coinflip', 'crash', 'slots'] as const)[i % 3]!,
								bet: 100,
								payout: [200, 0, 100, 0, 153, 500, 0, 420, 0][(i * 4) % 9]!
							}))
						},
						t0,
						coinsN === 0 ? 0 : -400
					),
		multiplier: old ? null : race ? { mult: 10, active: 5, need: 0 } : { mult: 15, active: 6, need: 3 },
		awardPopups: [
			...mockAwards(coinsN ?? 0).map((e) => awardPopup({ type: 'award', base: 30, total: 0, balance: 0, ...e }, t0 + 60_000)),
			...(params.has('warn') ? [noticePopup({ type: 'coinsNotice', tone: 'warn', text: MOCK_WARNING }, t0 + 60_000)] : [])
		],
		boxNews: [],
		ban: params.has('ban')
			? {
					reason: 'Point farming (detected automatically)',
					until: Number(params.get('ban')) > 0 ? t0 + Number(params.get('ban')) * 1000 : null,
					minimized: false
				}
			: null,
		adminState: asAdmin
			? {
					maps: [
						{ id: 'surf_aurora', title: 'Aurora', kind: 'surf', enabled: true },
						{ id: 'surf_ember', title: 'Ember', kind: 'surf', enabled: true },
						{ id: 'surf_tidal', title: 'Tidal', kind: 'surf', enabled: true },
						{ id: 'bhop_meadow', title: 'Meadow', kind: 'bhop', enabled: true },
						{ id: 'bhop_quarry', title: 'Quarry', kind: 'bhop', enabled: true },
						{ id: 'tag_courtyard', title: 'Courtyard', kind: 'tag', enabled: false }
					],
					bans: [
						{ id: 1, username: 'griefer42', kind: 'guest', reason: 'spam', createdAt: Date.now() - 86_400_000, createdBy: 'Tim' },
						{ id: 2, username: 'Smurf', kind: 'account', reason: null, createdAt: Date.now() - 3_600_000, createdBy: 'auto', secondsLeft: 200 }
					],
					abuse: [
						{ id: 2, createdAt: Date.now() - 120_000, username: 'Smurf', action: 'ban', strikes: 6, evidence: 'shadow (round 4): Smurf stayed next to boreal: 20 s without a swing; shadow (round 5): Smurf stayed next to boreal: 20 s without a swing' },
						{ id: 1, createdAt: Date.now() - 400_000, username: 'Smurf', action: 'warning', strikes: 4, evidence: 'shadow (round 4): Smurf stayed next to boreal: 20 s without a swing' }
					],
					players: [
						{ id: 2, name: 'Tim', account: 'Tim', guest: false, admin: true, coins: 87_650 },
						{ id: 1, name: 'glidepath', account: 'glidepath', guest: false, admin: false, coins: 1234, items: ['hat_straw', 'glasses_shades', 'hat_joker'] },
						{ id: 3, name: 'cirrus', guest: true, admin: false },
						{ id: 4, name: 'boreal', account: 'boreal', guest: false, admin: false, coins: 0 }
					]
				}
			: null,
		adminNotice: null,
		authError: null,
		authBusy: false,
		chat: [
			{ id: 1, from: null, text: 'cirrus joined the game', system: true, at: t0 },
			{ id: 2, from: 'cirrus', text: 'gl hf', system: false, at: t0 },
			{ id: 3, from: 'glidepath', text: 'stage 4 ramp is tricky <b>not bold</b>', system: false, at: t0 },
			{ id: 4, from: null, text: 'New map record by glidepath: 02:18.902', system: true, at: t0 }
		],
		chatOpen: open === 'chat',
		vote: params.has('rtv') || params.has('novote') || ((infScene || defScene) && !params.has('vote'))
			? null
			: {
					labels: [
						'Surf · Tidal',
						'Surf · Aurora',
						'Bhop · Meadow',
						'Bhop · Quarry',
						'Tag · Courtyard',
						'Zombie Run · Foundry',
						...(params.get('vote') === '9' ? ['Zombie Defense · Blackthorn Farm', 'Infected · Outpost'] : []),
						'Extend 10 min'
					],
					counts: params.get('vote') === '9' ? [3, 5, 1, 0, 2, 1, 4, 0, 2] : [3, 5, 1, 0, 2, 1, 2],
					endsAt: t0 + 14000,
					duration: 20,
					myVote: 2,
					rtv: false,
					result: null
				},
		rtvRequest:
			params.get('rtv') === '1'
				? {
						initiator: 'glidepath',
						mapLabel: 'Bhop · Meadow',
						yes: 2,
						no: 1,
						needed: 4,
						endsAt: t0 + 14000,
						duration: 20,
						myChoice: null,
						canVote: true,
						result: null
					}
				: null,
		rtvCooldown: params.get('rtv') === 'cooldown' ? { until: t0 + 45_000, reason: 'declined' } : null,
		scoreboardOpen: open === 'scoreboard',
		scoreboard: rows,
		richest: old
			? []
			: [
					{ name: rows[0]?.name ?? 'glidepath', coins: 1_234_567, online: true },
					{ name: 'A name of 24 characters!', coins: 98_210, online: false },
					{ name: 'boreal', coins: 8_020, online: true },
					{ name: 'you', coins: 745, online: true },
					{ name: 'cirrus', coins: 12, online: false }
				],
		selfId: selfPos,
		selfName: 'you',
		modeState: mockState(mode, rows),
		spectating: infScene && infMockSpectates(infScene) ? { targetName: 'glidepath', freeFly: false } : null,
		consoleOpen: open === 'console',
		consoleLines: [
			{ id: 1, text: 'Surf Strike 2 console. Type "help".', kind: 'output' },
			{ id: 2, text: 'sensitivity 2.5', kind: 'input' },
			{ id: 3, text: '"sensitivity" = "2.5"', kind: 'echo' },
			{ id: 4, text: 'Unknown command: foo', kind: 'error' }
		],
		settingsOpen: open === 'settings' || open === 'maps',
		authPanelOpen: open === 'auth' || open === 'name',
		pointerLocked: infScene !== null,
		fullscreenSupported: true,
		desktopOnly: open === 'desktop',
		fps: 144,
		pos: { x: 1024.5, y: -332.25, z: 512, pitch: 4.2, yaw: 91.3, vx: 1200, vy: -460, vz: -88 },
		netGraph: params.has('netgraph')
			? {
					rttMs: 24,
					jitterMs: 2.8,
					interpMs: 63,
					snapHz: 32,
					underruns: 0,
					underrunMs: 0,
					extrapMs: 0,
					dupPct: 0,
					lateCount: 0,
					inBytesPerSec: 18_400,
					outBytesPerSec: 2_816,
					samples: Array.from({ length: 120 }, (_, i) => ({ gapMs: 31.25 + ((i * 7) % 9) - 4, underrun: i === 70, rttMs: 24 + (i % 4) }))
				}
			: null,
		cvars: {
			sensitivity: 2.5,
			m_yaw: 0.022,
			m_pitch: 0.022,
			fov: 90,
			volume: 0.5,
			cl_showfps: 1,
			cl_showkeys: params.get('keys') === '0' ? 0 : 1,
			cl_showpos: 0,
			net_graph: params.has('netgraph') ? Number(params.get('netgraph') || 1) : 0,
			cl_crosshairsize: 5,
			cl_crosshairgap: 1,
			cl_crosshairthickness: 1,
			cl_crosshaircolor_r: 0,
			cl_crosshaircolor_g: 255,
			cl_crosshaircolor_b: 0,
			cl_crosshairdot: 0,
			cl_ghost: 1,
			cl_scorepanel: 1,
			cl_boxnews: 1,
			cl_hideplayers: 0
		}
	});

	const names = ['sensitivity', 'fov', 'volume', 'cl_showfps', 'cl_showkeys', 'cl_showpos', 'cl_crosshairsize', 'connect', 'cvarlist', 'clear'];
	const hist: string[] = [];
	let nextId = 100;

	/** Defense menus: a pick of a page row turns the page, any other pick or close closes. */
	function mockModeUi(a: { kind: 'pick'; index: number } | { kind: 'close' }): void {
		if (!defScene) return;
		const m = mockMenu(defPage);
		const act = a.kind === 'pick' ? m?.acts[a.index] : undefined;
		defPage = act?.t === 'page' ? act.page : a.kind === 'close' ? null : defPage;
		hud.defense = mockDefenseView(defScene, performance.now(), defPage);
	}

	const api: GameApi = {
		exec(line) {
			hist.push(line);
			hud.consoleLines.push({ id: nextId++, text: line, kind: 'input' });
			const [name, value] = line.split(/\s+/);
			if (name === 'clear') hud.consoleLines = [];
			else if (name in hud.cvars && value !== undefined) api.setCvar(name, Number.isFinite(+value) ? +value : value);
			else hud.consoleLines.push({ id: nextId++, text: `Unknown command: ${name}`, kind: 'error' });
		},
		complete: (prefix) => names.filter((n) => n.startsWith(prefix)),
		history: () => hist.slice(),
		sendChat(text) {
			hud.chat.push({ id: nextId++, from: 'you', text, system: false, at: performance.now() });
		},
		setCvar(name, value) {
			hud.cvars[name] = value;
		},
		login(username) {
			hud.account = { username };
			hud.authPanelOpen = false;
		},
		register(username) {
			hud.account = { username };
			hud.authPanelOpen = false;
		},
		logout() {
			hud.account = null;
		},
		playAsGuest(name) {
			hud.cvars.name = name;
			hud.authPanelOpen = false;
		},
		openAuth() {
			hud.settingsOpen = false;
			hud.authPanelOpen = true;
		},
		closeAuth() {
			hud.authPanelOpen = false;
		},
		lockPointer() {
			hud.pointerLocked = true;
		},
		openChat: () => (hud.chatOpen = true),
		closeChat: () => (hud.chatOpen = false),
		toggleConsole: () => (hud.consoleOpen = !hud.consoleOpen),
		closeSettings: () => (hud.settingsOpen = false),
		vote(option) {
			if (hud.vote) hud.vote.myVote = option;
		},
		rtvVote(yes) {
			const r = hud.rtvRequest;
			if (!r || r.myChoice === (yes ? 'yes' : 'no')) return;
			hud.rtvRequest = {
				...r,
				myChoice: yes ? 'yes' : 'no',
				yes: r.yes + (yes ? 1 : 0) - (r.myChoice === 'yes' ? 1 : 0),
				no: r.no + (yes ? 0 : 1) - (r.myChoice === 'no' ? 1 : 0)
			};
		},
		shopBuy(item) {
			const price = hud.shop?.items.find((i) => i.id === item)?.price ?? 0;
			if (!hud.shop || !hud.coins) return;
			if (hud.coins.balance < price) {
				hud.shop = { ...hud.shop, notice: { ok: false, text: 'Not enough coins.' } };
				return;
			}
			hud.coins = { ...hud.coins, balance: hud.coins.balance - price };
			hud.shop = { ...hud.shop, owned: [...hud.shop.owned, item], notice: { ok: true, text: `${getCosmetic(item)?.name} bought.`, bought: item } };
		},
		boxOpen() {
			const s = hud.shop;
			if (!s?.box || !hud.coins || s.busy) return;
			const box = s.box;
			hud.shop = { ...s, busy: true, notice: null };
			setTimeout(() => {
				if (!hud.shop || !hud.coins) return;
				const item = rollLoot(Math.random, box.items.map((id) => getCosmetic(id)!), box.odds)!;
				const duplicate = hud.shop.owned.includes(item.id);
				const refund = duplicate ? (LOOTBOX.refund[item.rarity as keyof typeof LOOTBOX.refund] ?? 0) : 0;
				hud.coins = { ...hud.coins, balance: hud.coins.balance - box.price + refund };
				hud.shop = {
					...hud.shop,
					busy: false,
					owned: duplicate ? hud.shop.owned : [...hud.shop.owned, item.id],
					opened: { n: (hud.shop.opened?.n ?? 0) + 1, item: item.id, duplicate, refund }
				};
			}, 250);
		},
		boxRevealed() {},
		boxScreen() {},
		boxSound() {},
		casinoSound() {},
		crashBuild() {},
		casinoBet(b) {
			const c = hud.casino;
			if (!c || !hud.coins || c.busy) return;
			hud.casino = { ...c, busy: true, error: null };
			const stake = pts(b.bet);
			setTimeout(() => {
				if (!hud.casino || !hud.coins) return;
				if (hud.coins.balance < stake) {
					hud.casino = casinoError(hud.casino, 'Not enough coins.');
					return;
				}
				if (b.game === 'coinflip') {
					const side = rollCoin(mockRoll);
					settle({ game: 'coinflip', bet: stake, payout: coinflipPayout(b.bet, b.side, side), picked: b.side, side });
				} else if (b.game === 'slots') {
					const reels = rollSlots(mockRoll);
					settle({ game: 'slots', bet: stake, payout: slotPayout(b.bet, reels), reels });
				} else {
					hud.coins = { ...hud.coins, balance: hud.coins.balance - stake };
					hud.casino = crashStarted(hud.casino, { bet: stake, auto: b.auto }, performance.now());
					crash = { bet: b.bet, auto: b.auto, crash: rollCrash(mockRoll), startedAt: performance.now() };
					crashTimer = setInterval(() => crashStep(false), 16);
				}
			}, 120);
		},
		crashCashout: () => crashStep(true),
		shopEquip(slot, item) {
			if (hud.shop) hud.shop = { ...hud.shop, loadout: { ...hud.shop.loadout, [slot]: item }, notice: null };
		},
		createPreview: (c) => new CharacterPreview(c, 2),
		modeUi: (a) => mockModeUi(a),
		itemPicture: (id) => itemPicture(2, id),
		minimizeBan(minimized) {
			if (hud.ban) hud.ban = { ...hud.ban, minimized };
		},
		admin(a) {
			const st = hud.adminState;
			if (!st) return;
			const done = (text: string) => (hud.adminNotice = { ok: true, text, at: performance.now() });
			if (a.action === 'setMapEnabled') {
				if (!a.enabled && st.maps.filter((m) => m.enabled).length <= 1) {
					hud.adminNotice = { ok: false, text: 'At least one map must stay enabled.', at: performance.now() };
					hud.adminState = { ...st };
					return;
				}
				hud.adminState = { ...st, maps: st.maps.map((m) => (m.id === a.mapId ? { ...m, enabled: a.enabled } : m)) };
				hud.maps = hud.maps.map((m) => (m.id === a.mapId ? { ...m, disabled: !a.enabled } : m));
				done(`${a.mapId} ${a.enabled ? 'enabled' : 'disabled'}.`);
			} else if (a.action === 'ban') {
				const p = st.players.find((x) => x.id === a.targetId);
				const name = p?.name ?? a.username ?? '?';
				hud.adminState = {
					...st,
					players: st.players.filter((x) => x !== p),
					bans: [
						{ id: Date.now(), username: name, kind: p?.guest ? 'guest' : 'account', reason: a.reason ?? null, createdAt: Date.now(), createdBy: 'Tim' },
						...st.bans
					]
				};
				done(`Banned ${name}.`);
			} else if (a.action === 'unban') {
				hud.adminState = { ...st, bans: st.bans.filter((b) => b.id !== a.banId) };
				done('Unbanned.');
			} else if (a.action === 'forceMap') {
				api.changeMap(a.mapId);
				done(`Changed to ${a.mapId}.`);
			} else if (a.action === 'coins') {
				const players = st.players.map((x) => {
					if (x.account?.toLowerCase() !== a.username.toLowerCase()) return x;
					const n = (a.amount ?? 0) * 10;
					return { ...x, coins: a.op === 'reset' ? 0 : Math.max(0, (x.coins ?? 0) + (a.op === 'add' ? n : -n)) };
				});
				hud.adminState = { ...st, players };
				done(`${a.username}: coins changed.`);
			} else if (a.action === 'takeItem') {
				hud.adminState = { ...st, players: st.players.map((x) => (x.id === a.targetId ? { ...x, items: x.items?.filter((i) => i !== a.item) } : x)) };
				done(`Removed ${getCosmetic(a.item)?.name} from ${st.players.find((x) => x.id === a.targetId)?.name}.`);
			} else if (a.action === 'giveItem') {
				hud.adminState = { ...st, players: st.players.map((x) => (x.id === a.targetId ? { ...x, items: [...(x.items ?? []), a.item] } : x)) };
				done(`${st.players.find((x) => x.id === a.targetId)?.name} got ${getCosmetic(a.item)?.name}.`);
			} else if (a.action === 'extend') {
				done('Extended by 10 minutes.');
			}
		},
		changeMap(id) {
			const m = hud.maps.find((x) => x.id === id);
			if (m) {
				hud.mapId = m.id;
				hud.mapTitle = m.title;
			}
		}
	};

	// Casino: the server's part, played locally with the shared rules.
	const mockRoll = () => (params.has('roll') ? Number(params.get('roll')) : Math.random());
	let crash: { bet: number; auto: number | null; crash: number; startedAt: number } | null = null;
	let crashTimer: ReturnType<typeof setInterval> | undefined;
	function settle(o: CasinoOutcome, taken = 0): void {
		if (!hud.casino || !hud.coins) return;
		hud.coins = { ...hud.coins, balance: hud.coins.balance + taken + o.payout - o.bet };
		hud.casino = casinoResult(hud.casino, { net: hud.casino.net + o.payout - o.bet, ...o }, Date.now());
	}
	function crashStep(cashout: boolean): void {
		const r = crash;
		if (!r) return;
		const s = crashState(r.crash, r.auto, performance.now() - r.startedAt, cashout);
		if (s === 'running') return;
		clearInterval(crashTimer);
		crash = null;
		const at = s === 'crashed' ? null : s.at;
		settle({ game: 'crash', bet: pts(r.bet), payout: at === null ? 0 : crashPayout(r.bet, at), at, crash: r.crash }, pts(r.bet));
	}

	const overlay = () => hud.chatOpen || hud.consoleOpen || hud.settingsOpen || hud.authPanelOpen;
	const down = (e: KeyboardEvent) => {
		if (e.key === '`' && !hud.chatOpen) {
			e.preventDefault();
			api.toggleConsole();
			return;
		}
		if (overlay()) return;
		if (e.key === 'Tab') {
			e.preventDefault();
			hud.scoreboardOpen = true;
		} else if (e.key === 'y') {
			e.preventDefault();
			api.openChat();
		} else if (e.key === 'Escape') {
			hud.pointerLocked = false;
			hud.settingsOpen = true;
		} else if (e.key === 'm') {
			hud.spectating = hud.spectating ? null : { targetName: 'glidepath', freeFly: false };
		} else if (e.key === 'r') {
			hud.splitPopup = { label: 'Stage 4', ticks: hud.runTicks, delta: Math.round(0.42 * T), at: performance.now() };
		} else if (hud.rtvRequest && (e.key === '1' || e.key === '2')) api.rtvVote(e.key === '1');
		else if (hud.defense?.menu && e.key >= '1' && e.key <= '9') mockModeUi({ kind: 'pick', index: Number(e.key) - 1 });
		else if (defScene && (e.key === 'b' || e.key === 'e')) {
			defPage = hud.defense?.menu ? (defPage === 'shop' || defPage === 'pad' || defPage === 'turret' ? null : 'shop') : e.key === 'b' ? 'shop' : 'pad';
			hud.defense = mockDefenseView(defScene, performance.now(), defPage);
		} else if (e.key >= '1' && e.key <= '9') api.vote(Number(e.key));
	};
	const up = (e: KeyboardEvent) => {
		if (e.key === 'Tab') hud.scoreboardOpen = false;
	};
	window.addEventListener('keydown', down);
	window.addEventListener('keyup', up);

	// `&boxnews`: one of each rarity in turn; `&boxnews=<rarity or item id>` only that one, `&boxnews=all` many at once.
	const newsOf = params.get('boxnews');
	let newsN = 0;
	const newsNext = () => {
		const rarities = Object.keys(LOOTBOX.odds) as LootRarity[];
		const rarity = rarities.find((r) => r === newsOf) ?? rarities[newsN % rarities.length];
		const of = lootItems().filter((i) => i.rarity === rarity && !i.id.startsWith('mock_'));
		const item = getCosmetic(newsOf ?? '') ?? of[(newsN * 7) % of.length];
		const name = MOCK_NAMES[newsN % MOCK_NAMES.length];
		const n = parseBoxNews({ type: 'boxNews', id: 9, name, item: item.id, duplicate: newsN++ % 3 === 2 }, performance.now());
		if (n) hud.boxNews = pushBoxNews(hud.boxNews, n);
	};
	const newsTimers: ReturnType<typeof setInterval>[] = [];
	if (newsOf !== null) {
		setTimeout(() => {
			for (let i = 0; i < (newsOf === 'all' ? 12 : 1); i++) newsNext();
		}, 500);
		newsTimers.push(setInterval(newsNext, newsOf === 'all' ? 700 : 6000));
	}

	// `&casinonews`: one win of each tier in turn; `&casinonews=<multiplier>` only that one.
	const winsOf = params.get('casinonews');
	if (winsOf !== null) {
		let i = 0;
		const next = () => {
			const mult = Number(winsOf) || [5, 12.5, 25, 60, 250][i % 5];
			const n = parseCasinoNews({ type: 'casinoNews', id: 9, name: MOCK_NAMES[i % MOCK_NAMES.length], game: i++ % 2 ? 'slots' : 'crash', bet: 100, payout: 100 * mult }, performance.now());
			if (n) hud.boxNews = pushBoxNews(hud.boxNews, n);
		};
		setTimeout(next, 500);
		newsTimers.push(setInterval(next, 4000));
	}

	const ctx = canvas.getContext('2d');
	let raf = 0;
	let infAt = t0;
	const frame = () => {
		const t = (performance.now() - t0) / 1000;
		const s = 1200 + Math.sin(t * 0.8) * 300;
		hud.speedTrend = s > hud.speed + 0.5 ? 'up' : s < hud.speed - 0.5 ? 'down' : 'flat';
		hud.speed = s;
		hud.runTicks = Math.round((72.402 + t) * T);
		hud.mapTimeLeft = Math.max(0, 462 - t);
		// Infected: re-issue the scene so popups, arcs and hit markers stay on screen.
		if (infScene && performance.now() - infAt > 1000) {
			infAt = performance.now();
			hud.infected = mockInfectedView(infScene, infAt);
		}
		if (ctx) {
			const { width: w, height: h } = canvas;
			const g = ctx.createLinearGradient(0, 0, 0, h);
			g.addColorStop(0, '#9fd3ff');
			g.addColorStop(0.55, '#f4f7fb');
			g.addColorStop(0.56, '#5a6470');
			g.addColorStop(1, '#2a2f36');
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, w, h);
		}
		raf = requestAnimationFrame(frame);
	};
	const resize = () => {
		canvas.width = canvas.clientWidth;
		canvas.height = canvas.clientHeight;
	};
	resize();
	window.addEventListener('resize', resize);
	raf = requestAnimationFrame(frame);

	return {
		hud,
		api,
		destroy() {
			cancelAnimationFrame(raf);
			clearInterval(crashTimer);
			for (const t of newsTimers) clearInterval(t);
			window.removeEventListener('keydown', down);
			window.removeEventListener('keyup', up);
			window.removeEventListener('resize', resize);
		}
	};
}
