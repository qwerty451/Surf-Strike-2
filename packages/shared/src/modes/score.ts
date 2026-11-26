/**
 * Score display per gamemode (docs/modes.md#score-display): the Tab scoreboard
 * columns, the always-on score panel and how rows are ordered and marked.
 *
 * Everything the two views show comes from the mode's `ModeScoreDef`
 * (`GAME_MODES[id].score`); the Svelte components only render the result. To
 * show a new metric, add a `ScoreMetric` (a column) or a `PanelSummary` (a line
 * under the list) to the mode's definition below.
 *
 * All inputs may come from an older server, so every optional field has a
 * fallback here.
 */
import type { ModeState, RecordEntry, ScoreRow } from '../protocol.ts';
import { formatMultiplier } from '../economy.ts';
import { formatTicks, Status } from '../protocol.ts';
import { TICK_RATE } from '../units.ts';

/** Shown for a missing value (no PB, guest totals, older server). */
export const NO_VALUE = '–';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Run time difference in ticks → `−0.213` / `+1.050` / `+1:02.500`. Zero is `±0.000`. */
export function formatDelta(deltaTicks: number, tickRate = TICK_RATE): string {
	const ms = Math.round((Math.abs(deltaTicks) / tickRate) * 1000);
	if (ms === 0) return '±0.000';
	const sign = deltaTicks < 0 ? '−' : '+';
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	const r = String(ms % 1000).padStart(3, '0');
	return m > 0 ? `${sign}${m}:${String(s).padStart(2, '0')}.${r}` : `${sign}${s}.${r}`;
}

/** Seconds → `mm:ss` (rounded up, never negative). */
export function formatClock(seconds: number): string {
	const t = Math.max(0, Math.ceil(seconds));
	return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Total playtime in seconds → `12h 34m`, `34m`, `<1m`; missing (guest, offline, older server) → `–`. */
export function formatPlaytime(secs: number | null | undefined): string {
	if (typeof secs !== 'number' || !Number.isFinite(secs) || secs < 0) return NO_VALUE;
	const m = Math.floor(secs / 60);
	if (m < 1) return '<1m';
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Whole points or coins with thousands separators; missing → `–`. */
export function formatPoints(points: number | null | undefined): string {
	if (typeof points !== 'number' || !Number.isFinite(points)) return NO_VALUE;
	return String(Math.round(points)).replace(/\B(?=(\d{3})+$)/g, ',');
}

/** Status / role column text. */
export function statusText(row: Pick<ScoreRow, 'status' | 'stage' | 'spectating'>, staged = true): string {
	if (row.spectating) return 'Spectating';
	switch (row.status) {
		case Status.StartZone:
			return 'Start zone';
		case Status.Running:
			return staged && row.stage > 0 ? `Stage ${row.stage}` : 'Running';
		case Status.Finished:
			return 'Finished';
		case Status.Spectating:
			return 'Spectating';
		case Status.Tagger:
			return 'IT';
		case Status.Runner:
			return 'Runner';
		case Status.Alive:
			return 'Survivor';
		case Status.Down:
			return 'Zombie';
		case Status.Alpha:
			return 'Alpha';
		case Status.Infected:
			return 'Infected';
		case Status.Hider:
			return 'Hider';
		case Status.Seeker:
			return 'Seeker';
		default:
			return 'Idle';
	}
}

// ---------------------------------------------------------------------------
// Definition types
// ---------------------------------------------------------------------------

/** What a metric may read besides its row. */
export interface ScoreContext {
	/** Latest `modeState` of the current mode (null in race modes, before the first one, and mostly offline). */
	state: ModeState | null;
	/** Staged race map ("Stage 3" instead of "Running"). */
	staged: boolean;
}

/** One per-player value: a Tab scoreboard column, and a score panel column with `panel`. */
export interface ScoreMetric {
	id: string;
	/** Tab scoreboard header. */
	label: string;
	/** Score panel header (default: label). */
	short?: string;
	/** Right-aligned, number font. */
	num: boolean;
	/** Tab scoreboard column width in em. */
	width: number;
	/** Also a column of the score panel's standing. */
	panel?: boolean;
	/** First to go when the window is narrow. */
	minor?: boolean;
	text(row: ScoreRow, ctx: ScoreContext): string;
}

/** Role marker in front of a name. `tone` picks the row colour in the UI. */
export interface ScoreMark {
	/** Tab scoreboard chip; '' = colour only (a column already says it). */
	text: string;
	/** Score panel chip; '' = colour only. */
	short: string;
	tone: ScoreTone;
}
export type ScoreTone = 'it' | 'infected' | 'alpha' | 'zombie' | 'seeker';

/** A label/value line under the score panel's list. */
export interface PanelLine {
	label: string;
	text: string;
	note?: string;
	tone?: 'good' | 'bad';
}
export interface PanelSummary {
	id: string;
	/** Null: nothing to show right now. */
	line(input: ScorePanelInput): PanelLine | null;
}

export interface ModeScoreDef {
	/** Tab scoreboard columns in order (besides name and the totals); `panel` ones are the standing's columns too. */
	columns: readonly ScoreMetric[];
	/** Best player first. */
	compare(a: ScoreRow, b: ScoreRow): number;
	mark?(row: ScoreRow): ScoreMark | null;
	panel: {
		/** `records`: the map's leaderboard; `standing`: the players in the current game. */
		list: 'records' | 'standing';
		/** Panel title (default: the mode's label). */
		title?: string;
		/** Right side of the title ("Round 3"). */
		subtitle?(input: ScorePanelInput): string;
		/** Rows shown at most, yourself included. */
		maxRows: number;
		summary: readonly PanelSummary[];
	};
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const int = (v: number | undefined): string => String(Math.round(v ?? 0));

const PING: ScoreMetric = { id: 'ping', label: 'Ping', num: true, width: 4.6, minor: true, text: (r) => String(r.ping) };
const STATUS: ScoreMetric = { id: 'status', label: 'Status', num: false, width: 7.4, text: (r, c) => statusText(r, c.staged) };
const KILLS: ScoreMetric = { id: 'kills', label: 'Kills', num: true, width: 4.8, panel: true, text: (r) => int(r.kills) };

/** The extra columns every mode's Tab scoreboard ends with. */
export const TOTAL_COLUMNS: readonly ScoreMetric[] = [
	{ id: 'coins', label: 'Coins', num: true, width: 6.8, text: (r) => formatPoints(r.coins) },
	{ id: 'totalPlaytime', label: 'Total playtime', num: true, width: 7.6, text: (r) => formatPlaytime(r.playtimeSecs) }
];

/** Coins multiplier and active players, under every mode's list (docs/economy.md#player-multiplier). */
const COINS: PanelSummary = {
	id: 'coins',
	line: ({ coins }) => {
		if (!coins) return null;
		if (coins.active < coins.need) return { label: 'Coins', text: 'Off', note: `${coins.active}/${coins.need} active`, tone: 'bad' };
		return { label: 'Coins', text: formatMultiplier(coins.mult), note: `${coins.active} active`, ...(coins.mult > 10 ? { tone: 'good' as const } : {}) };
	}
};

const byName = (a: ScoreRow, b: ScoreRow) => a.name.localeCompare(b.name);
const desc = (a: number | undefined, b: number | undefined) => (b ?? 0) - (a ?? 0);
const round = (i: ScorePanelInput): string => (i.state && i.state.round > 0 ? `Round ${i.state.round}` : '');

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/** Surf and bhop: the map's leaderboard, your PB and the gap to the record. */
export const RACE_SCORE: ModeScoreDef = {
	columns: [
		{ id: 'rank', label: 'Rank', num: true, width: 4.6, text: (r) => (r.rank === null ? NO_VALUE : `#${r.rank}`) },
		{ id: 'pb', label: 'PB', num: true, width: 7, text: (r) => (r.pbTicks === null ? NO_VALUE : formatTicks(r.pbTicks)) },
		STATUS,
		PING
	],
	compare: (a, b) => (a.pbTicks ?? Infinity) - (b.pbTicks ?? Infinity) || byName(a, b),
	panel: {
		list: 'records',
		title: 'Map records',
		maxRows: 6,
		summary: [
			{
				id: 'pb',
				line: ({ records: r }) => ({
					label: 'Personal best',
					text: r.pbTicks === null ? NO_VALUE : formatTicks(r.pbTicks),
					note: r.pbRank === null ? undefined : `#${r.pbRank}`
				})
			},
			{
				id: 'gap',
				line: ({ records: r }) => {
					if (r.pbTicks === null || r.recordTicks === null) return null;
					const gap = r.pbTicks - r.recordTicks;
					if (gap <= 0) return { label: 'Gap to record', text: 'Record holder', tone: 'good' };
					return { label: 'Gap to record', text: formatDelta(gap), tone: 'bad' };
				}
			},
			COINS
		]
	}
};

export const TAG_SCORE: ModeScoreDef = {
	columns: [
		{ id: 'score', label: 'Time not IT', short: 'Not IT', num: true, width: 6.4, panel: true, text: (r) => (r.score ?? 0).toFixed(1) },
		STATUS,
		PING
	],
	compare: (a, b) => desc(a.score, b.score) || byName(a, b),
	mark: (r) => (r.it ? { text: 'IT', short: 'IT', tone: 'it' } : null),
	panel: { list: 'standing', subtitle: round, maxRows: 8, summary: [COINS] }
};

export const ZOMBIES_SCORE: ModeScoreDef = {
	columns: [
		KILLS,
		{ id: 'turned', label: 'Turned', num: true, width: 5.6, panel: true, minor: true, text: (r) => int(r.deaths) },
		STATUS,
		PING
	],
	compare: (a, b) => desc(a.kills, b.kills) || byName(a, b),
	mark: (r) => (r.status === Status.Down ? { text: '', short: 'Z', tone: 'zombie' } : null),
	panel: {
		list: 'standing',
		subtitle: round,
		maxRows: 8,
		summary: [
			{
				id: 'progress',
				line: ({ state }) => {
					if (state?.mode !== 'zombies' || state.phase !== 'playing') return null;
					return { label: 'Route', text: `${Math.round(state.progress * 100)}%`, note: `${state.checkpoint}/${state.checkpoints}` };
				}
			},
			COINS
		]
	}
};

export const INFECTED_SCORE: ModeScoreDef = {
	columns: [
		{ id: 'score', label: 'Score', num: true, width: 5, panel: true, text: (r) => int(r.score) },
		KILLS,
		{
			id: 'streak',
			label: 'Streak',
			short: 'Strk',
			num: true,
			width: 5.4,
			panel: true,
			minor: true,
			// Not a ScoreRow field: the mode state carries it (survivors only).
			text: (r, { state }) => {
				const p = state?.mode === 'infected' ? state.players.find((x) => x.id === r.id) : undefined;
				return p && p.team === 'survivor' ? String(p.streak ?? 0) : NO_VALUE;
			}
		},
		{ id: 'deaths', label: 'Deaths', num: true, width: 5.6, text: (r) => int(r.deaths) },
		STATUS,
		PING
	],
	compare: (a, b) => desc(a.score, b.score) || desc(a.kills, b.kills) || byName(a, b),
	mark: (r) =>
		r.status === Status.Alpha
			? { text: 'ALPHA', short: 'A', tone: 'alpha' }
			: r.status === Status.Infected
				? { text: 'INFECTED', short: 'INF', tone: 'infected' }
				: null,
	panel: { list: 'standing', subtitle: round, maxRows: 8, summary: [COINS] }
};

export const HNS_SCORE: ModeScoreDef = {
	columns: [
		{ id: 'role', label: 'Role', num: false, width: 7, panel: true, minor: true, text: (r, c) => statusText(r, c.staged) },
		{ id: 'finds', label: 'Finds', num: true, width: 5, panel: true, text: (r) => int(r.kills) },
		{ id: 'survived', label: 'Survived', short: 'Surv', num: true, width: 6.6, panel: true, text: (r) => formatClock(r.score ?? 0) },
		PING
	],
	compare: (a, b) => desc(a.score, b.score) || desc(a.kills, b.kills) || byName(a, b),
	mark: (r) => (r.status === Status.Seeker ? { text: '', short: '', tone: 'seeker' } : null),
	panel: { list: 'standing', subtitle: round, maxRows: 8, summary: [COINS] }
};

/** Tournament (placeholder until the mode's own columns). */
export const TOURNAMENT_SCORE: ModeScoreDef = {
	columns: [KILLS, STATUS, PING],
	compare: (a, b) => desc(a.kills, b.kills) || byName(a, b),
	mark: () => null,
	panel: { list: 'standing', subtitle: round, maxRows: 8, summary: [COINS] }
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Tab scoreboard columns of a mode: its own, then the account totals. */
export function scoreboardColumns(def: ModeScoreDef): ScoreMetric[] {
	return [...def.columns, ...TOTAL_COLUMNS];
}

const isSpectator = (r: ScoreRow) => r.spectating || r.status === Status.Spectating;

/** Players in the mode's order (best first) and spectators by name. */
export function splitScoreboard(rows: readonly ScoreRow[], def: ModeScoreDef): { players: ScoreRow[]; spectators: ScoreRow[] } {
	return {
		players: rows.filter((r) => !isSpectator(r)).sort(def.compare),
		spectators: rows.filter(isSpectator).sort(byName)
	};
}

/** Race records as the panel needs them. */
export interface PanelRecords {
	pbTicks: number | null;
	pbRank: number | null;
	recordTicks: number | null;
	recordName: string | null;
	/** Leaderboard top, best first; null from an older server or offline. */
	top: readonly RecordEntry[] | null;
}

export interface ScorePanelInput extends ScoreContext {
	rows: readonly ScoreRow[];
	/** Row id of the local player. */
	selfId: number;
	/** Name on the local player's own record row. */
	selfName: string;
	online: boolean;
	records: PanelRecords;
	/**
	 * Coins multiplier (tenths), active players and how many the mode needs
	 * before it pays; null or absent offline and on servers without coins.
	 */
	coins?: { mult: number; active: number; need: number } | null;
}

export interface ScorePanelRow {
	key: string;
	/** Position (`1`, `12`). */
	place: string;
	name: string;
	self: boolean;
	mark: ScoreMark | null;
	cells: string[];
	/** Rows were left out between the previous one and this one. */
	gap: boolean;
}

export interface ScorePanelView {
	title: string;
	subtitle: string;
	/** Column headers, aligned with `cells`. */
	heads: { id: string; label: string; num: boolean; minor: boolean }[];
	rows: ScorePanelRow[];
	/** Players or records not listed. */
	hidden: number;
	/** Text instead of rows. */
	empty: string | null;
	summary: (PanelLine & { id: string })[];
}

/**
 * First `max` items; an own item further down replaces the last of them, so
 * you always see yourself (even with `max` 1).
 */
export function capRows<T>(items: readonly T[], selfIndex: number, max: number): { item: T; index: number; gap: boolean }[] {
	const n = Math.max(0, Math.floor(max));
	const out = items.slice(0, n).map((item, index) => ({ item, index, gap: false }));
	if (n > 0 && selfIndex >= n && selfIndex < items.length) {
		out[n - 1] = { item: items[selfIndex]!, index: selfIndex, gap: selfIndex > n - 1 };
	}
	return out;
}

function recordEntries(input: ScorePanelInput): RecordEntry[] {
	const { records: r, selfName } = input;
	if (!input.online) return [];
	const out: RecordEntry[] = [];
	if (Array.isArray(r.top)) out.push(...r.top);
	else if (r.recordTicks !== null) {
		// Older server: only the record itself is known.
		out.push({ rank: 1, name: r.recordName ?? '?', ticks: r.recordTicks, self: r.pbTicks !== null && r.pbRank === 1 && r.pbTicks === r.recordTicks });
	}
	// Your own time when it is not in the sent top.
	if (r.pbTicks !== null && !out.some((e) => e.self)) {
		out.push({ rank: r.pbRank ?? out.length + 1, name: selfName, ticks: r.pbTicks, self: true });
	}
	return out;
}

/** The score panel's content. `maxRows` lowers the mode's own cap (small windows). */
export function buildScorePanel(def: ModeScoreDef, label: string, input: ScorePanelInput, maxRows = Infinity): ScorePanelView {
	const cap = Math.min(def.panel.maxRows, maxRows);
	const base = {
		title: def.panel.title ?? label,
		subtitle: def.panel.subtitle?.(input) ?? '',
		summary: def.panel.summary.flatMap((s) => {
			const line = s.line(input);
			return line ? [{ id: s.id, ...line }] : [];
		})
	};
	if (def.panel.list === 'records') {
		const entries = recordEntries(input);
		const shown = capRows(entries, entries.findIndex((e) => e.self), cap);
		return {
			...base,
			heads: [{ id: 'time', label: 'Time', num: true, minor: false }],
			rows: shown.map(({ item: e, index, gap }) => ({
				key: `${index}:${e.name}`,
				place: String(e.rank),
				name: e.name,
				self: !!e.self,
				mark: null,
				cells: [formatTicks(e.ticks)],
				// Also between the sent top and an own time further down.
				gap: gap || (index > 0 && e.rank > entries[index - 1]!.rank + 1 && !!e.self)
			})),
			hidden: entries.length - shown.length,
			empty: entries.length > 0 ? null : input.online ? 'No times yet' : 'Offline: no map records'
		};
	}
	const metrics = def.columns.filter((m) => m.panel);
	const players = splitScoreboard(input.rows, def).players;
	const shown = capRows(players, players.findIndex((r) => r.id === input.selfId), cap);
	return {
		...base,
		heads: metrics.map((m) => ({ id: m.id, label: m.short ?? m.label, num: m.num, minor: !!m.minor })),
		rows: shown.map(({ item: r, index, gap }) => ({
			key: String(r.id),
			place: String(index + 1),
			name: r.name,
			self: r.id === input.selfId,
			mark: def.mark?.(r) ?? null,
			cells: metrics.map((m) => m.text(r, input)),
			gap
		})),
		hidden: players.length - shown.length,
		empty: players.length > 0 ? null : 'No players'
	};
}
