import { describe, expect, it } from 'vitest';
import { GAME_MODE_IDS, GAME_MODES, gameMode } from './index.ts';
import { Status, type ModeState, type RecordEntry, type ScoreRow } from '../protocol.ts';
import { TICK_RATE } from '../units.ts';
import {
	buildScorePanel,
	capRows,
	formatPlaytime,
	formatPoints,
	scoreboardColumns,
	splitScoreboard,
	statusText,
	trnRoundLabel,
	trnStatusText,
	type ScorePanelInput
} from './score.ts';

const row = (p: Partial<ScoreRow>): ScoreRow => ({
	id: 0,
	name: 'a',
	rank: null,
	pbTicks: null,
	status: Status.Idle,
	stage: 0,
	ping: 0,
	spectating: false,
	...p
});

const NO_RECORDS = { pbTicks: null, pbRank: null, recordTicks: null, recordName: null, top: null };
const input = (p: Partial<ScorePanelInput>): ScorePanelInput => ({
	rows: [],
	selfId: 1,
	selfName: 'Me',
	online: true,
	state: null,
	staged: true,
	records: NO_RECORDS,
	...p
});
const panel = (mode: string, p: Partial<ScorePanelInput>, max?: number) =>
	buildScorePanel(gameMode(mode).score, gameMode(mode).label, input(p), max);
/** The Tab scoreboard as text: column id -> cell. */
const cells = (mode: string, r: ScoreRow, state: ModeState | null = null) =>
	Object.fromEntries(scoreboardColumns(gameMode(mode).score).map((c) => [c.id, c.text(r, { state, staged: true })]));

describe('formats', () => {
	it('playtime', () => {
		expect(formatPlaytime(12 * 3600 + 34 * 60 + 59)).toBe('12h 34m');
		expect(formatPlaytime(3600 + 5 * 60)).toBe('1h 05m');
		expect(formatPlaytime(1234 * 3600)).toBe('1234h 00m');
		expect(formatPlaytime(34 * 60)).toBe('34m');
		expect(formatPlaytime(59)).toBe('<1m');
		expect(formatPlaytime(0)).toBe('<1m');
		for (const v of [null, undefined, NaN, -1]) expect(formatPlaytime(v)).toBe('–');
	});
	it('points', () => {
		expect([0, 999, 1000, 1234567].map(formatPoints)).toEqual(['0', '999', '1,000', '1,234,567']);
		expect(formatPoints(null)).toBe('–');
		expect(formatPoints(undefined)).toBe('–');
	});
	it('status text', () => {
		expect(statusText(row({ status: Status.StartZone }))).toBe('Start zone');
		expect(statusText(row({ status: Status.Running, stage: 3 }))).toBe('Stage 3');
		expect(statusText(row({ status: Status.Running, stage: 3 }), false)).toBe('Running');
		expect(statusText(row({ status: Status.Running, stage: 0 }))).toBe('Running');
		expect(statusText(row({ status: Status.Finished }))).toBe('Finished');
		expect(statusText(row({ spectating: true, status: Status.Running }))).toBe('Spectating');
		expect([Status.Tagger, Status.Runner, Status.Alive, Status.Down, Status.Alpha, Status.Infected].map((status) => statusText(row({ status })))).toEqual([
			'IT',
			'Runner',
			'Survivor',
			'Zombie',
			'Alpha',
			'Infected'
		]);
	});
});

describe('Tab scoreboard', () => {
	it('every mode ends with coins and total playtime', () => {
		for (const id of GAME_MODE_IDS) {
			const cols = scoreboardColumns(GAME_MODES[id].score);
			expect(cols.slice(-2).map((c) => c.label)).toEqual(['Coins', 'Total playtime']);
			expect(new Set(cols.map((c) => c.id)).size).toBe(cols.length);
		}
	});
	it('every column of every mode survives a bare row from an older server', () => {
		for (const id of GAME_MODE_IDS) {
			const c = cells(id, row({}));
			expect(Object.values(c).every((t) => typeof t === 'string' && !/NaN|undefined|null/.test(t)), id).toBe(true);
			expect([c.coins, c.totalPlaytime]).toEqual(['–', '–']);
		}
	});
	it('account totals and guests', () => {
		expect(cells('tag', row({ coins: 1234, playtimeSecs: 45_296 }))).toMatchObject({ coins: '1,234', totalPlaytime: '12h 34m' });
		expect(cells('tag', row({ coins: null, playtimeSecs: null }))).toMatchObject({ coins: '–', totalPlaytime: '–' });
	});
	it('mode values', () => {
		expect(cells('surf', row({ rank: 2, pbTicks: TICK_RATE * 72.402, status: Status.Running, stage: 3 }))).toMatchObject({ rank: '#2', pb: '01:12.402', status: 'Stage 3' });
		expect(cells('tag', row({ score: 42.25 })).score).toBe('42.3');
		expect(cells('infected', row({ score: 149.6, kills: 3, deaths: 1 }))).toMatchObject({ score: '150', kills: '3', deaths: '1', streak: '–' });
		expect(cells('zombies', row({ kills: 7, deaths: 2 }))).toMatchObject({ kills: '7', turned: '2' });
		expect(cells('hns', row({ score: 61, kills: 2, status: Status.Seeker }))).toMatchObject({ role: 'Seeker', finds: '2', survived: '01:01' });
	});
	it('infected streak comes from the mode state, survivors only', () => {
		const state = {
			mode: 'infected',
			players: [
				{ id: 1, team: 'survivor', streak: 5 },
				{ id: 2, team: 'infected', streak: 0 },
				{ id: 3, team: 'survivor' }
			]
		} as unknown as ModeState;
		expect([1, 2, 3, 4].map((id) => cells('infected', row({ id }), state).streak)).toEqual(['5', '–', '0', '–']);
		expect(cells('infected', row({ id: 1 }), { mode: 'tag' } as ModeState).streak).toBe('–');
	});
	it('order per mode, spectators split out', () => {
		const names = (mode: string, rows: ScoreRow[]) => splitScoreboard(rows, gameMode(mode).score).players.map((r) => r.name);
		const rows = [row({ name: 'nopb' }), row({ name: 'slow', pbTicks: 900 }), row({ name: 'spec', spectating: true, pbTicks: 1 }), row({ name: 'fast', pbTicks: 500 }), row({ name: 'also' })];
		expect(names('bhop', rows)).toEqual(['fast', 'slow', 'also', 'nopb']);
		expect(splitScoreboard(rows, GAME_MODES.bhop.score).spectators.map((r) => r.name)).toEqual(['spec']);
		expect(rows[0]!.name).toBe('nopb'); // not mutated
		expect(names('tag', [row({ name: 'b', score: 10 }), row({ name: 'a', score: 42.5 }), row({ name: 'c', score: 10 })])).toEqual(['a', 'b', 'c']);
		expect(names('zombies', [row({ name: 'b', kills: 1 }), row({ name: 'a', kills: 9 })])).toEqual(['a', 'b']);
		expect(names('hns', [row({ name: 'b', score: 5, kills: 0 }), row({ name: 'a', score: 5, kills: 2 })])).toEqual(['a', 'b']);
		expect(names('infected', [row({ name: 'b', score: 50, kills: 1 }), row({ name: 'a', score: 50, kills: 3 })])).toEqual(['a', 'b']);
	});
	it('marks', () => {
		expect(GAME_MODES.tag.score.mark!(row({ it: true }))?.text).toBe('IT');
		expect(GAME_MODES.tag.score.mark!(row({}))).toBeNull();
		expect(GAME_MODES.infected.score.mark!(row({ status: Status.Alpha }))?.tone).toBe('alpha');
		expect(GAME_MODES.infected.score.mark!(row({ status: Status.Infected }))?.tone).toBe('infected');
		expect(GAME_MODES.infected.score.mark!(row({ status: Status.Alive }))).toBeNull();
	});
});

describe('capRows', () => {
	const l = ['a', 'b', 'c', 'd', 'e'];
	const pick = (self: number, max: number) => capRows(l, self, max).map((r) => (r.gap ? '…' : '') + r.item).join('');
	it('keeps the first rows and always your own', () => {
		expect(pick(0, 3)).toBe('abc');
		expect(pick(2, 3)).toBe('abc');
		expect(pick(3, 3)).toBe('ab…d');
		expect(pick(4, 3)).toBe('ab…e');
		expect(pick(4, 1)).toBe('…e');
		expect(pick(-1, 2)).toBe('ab');
		expect(pick(4, 0)).toBe('');
		expect(pick(4, Infinity)).toBe('abcde');
	});
});

describe('race score panel', () => {
	const top: RecordEntry[] = Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, name: `P${i + 1}`, ticks: 1000 + i * 64 }));
	const recs = (p: Partial<ScorePanelInput['records']>) => ({ records: { pbTicks: null, pbRank: null, recordTicks: 1000, recordName: 'P1', top, ...p } });
	const list = (v: ReturnType<typeof panel>) => v.rows.map((r) => `${r.gap ? '…' : ''}${r.place} ${r.name}${r.self ? '*' : ''}`);
	const summary = (v: ReturnType<typeof panel>) => v.summary.map((l) => [l.label, l.text, l.note ?? ''].join('|'));

	it('top entries, no PB', () => {
		const v = panel('surf', recs({}));
		expect(v.title).toBe('Map records');
		expect(list(v)).toEqual(['1 P1', '2 P2', '3 P3', '4 P4', '5 P5', '6 P6']);
		expect(v.rows[0]!.cells).toEqual(['00:15.625']);
		expect(summary(v)).toEqual(['Personal best|–|']);
	});
	it('own row inside the list and the gap to the record', () => {
		const v = panel('bhop', recs({ top: top.map((e, i) => (i === 2 ? { ...e, self: true } : e)), pbTicks: 1128, pbRank: 3 }));
		expect(list(v)[2]).toBe('3 P3*');
		expect(summary(v)).toEqual(['Personal best|00:17.625|#3', 'Gap to record|+2.000|']);
	});
	it('own row further down the sent top, and below it', () => {
		const inTop = panel('surf', recs({ top: top.map((e, i) => (i === 8 ? { ...e, self: true } : e)), pbTicks: 1512, pbRank: 9 }));
		expect(list(inTop)).toEqual(['1 P1', '2 P2', '3 P3', '4 P4', '5 P5', '…9 P9*']);
		const below = panel('surf', recs({ pbTicks: 4000, pbRank: 37 }), 4);
		expect(list(below)).toEqual(['1 P1', '2 P2', '3 P3', '…37 Me*']);
		expect(list(panel('surf', recs({ pbTicks: 4000, pbRank: 37 }), 1))).toEqual(['…37 Me*']);
	});
	it('record holder', () => {
		const v = panel('surf', recs({ top: [{ ...top[0]!, self: true }], pbTicks: 1000, pbRank: 1 }));
		expect(list(v)).toEqual(['1 P1*']);
		expect(summary(v)[1]).toBe('Gap to record|Record holder|');
	});
	it('older server: only the record and your own time', () => {
		expect(list(panel('surf', recs({ top: null, pbTicks: 1500, pbRank: 4 })))).toEqual(['1 P1', '…4 Me*']);
		expect(list(panel('surf', recs({ top: null, pbTicks: 1000, pbRank: 1 })))).toEqual(['1 P1*']);
		expect(list(panel('surf', recs({ top: null, pbTicks: 1064, pbRank: 2 })))).toEqual(['1 P1', '2 Me*']);
	});
	it('empty map and offline (local PB only)', () => {
		const none = panel('surf', { records: { ...NO_RECORDS, top: [] } });
		expect([none.rows, none.empty]).toEqual([[], 'No times yet']);
		const solo = panel('surf', { online: false, records: { ...NO_RECORDS, pbTicks: 640 } });
		expect(solo.rows).toEqual([]);
		expect(solo.empty).toBe('Offline: no map records');
		expect(summary(solo)).toEqual(['Personal best|00:10.000|']);
	});
});

describe('standing score panel', () => {
	const rows = Array.from({ length: 12 }, (_, i) => row({ id: i + 1, name: `P${i + 1}`, score: 100 - i, kills: 12 - i, status: Status.Runner, it: i === 1 }));
	it('tag: best first, capped at 8 with yourself always shown', () => {
		const v = panel('tag', { rows, selfId: 11, state: { mode: 'tag', round: 3 } as ModeState });
		expect([v.title, v.subtitle]).toEqual(['Tag', 'Round 3']);
		expect(v.heads.map((h) => h.label)).toEqual(['Not IT']);
		expect(v.rows).toHaveLength(8);
		expect(v.rows[1]!.mark?.short).toBe('IT');
		expect(v.rows[7]).toMatchObject({ place: '11', name: 'P11', self: true, gap: true, cells: ['90.0'] });
		expect(v.hidden).toBe(4);
	});
	it('a spectator gets no own row', () => {
		const v = panel('tag', { rows: [...rows, row({ id: 50, spectating: true })], selfId: 50 }, 3);
		expect(v.rows.map((r) => r.name)).toEqual(['P1', 'P2', 'P3']);
		expect(v.rows.some((r) => r.self)).toBe(false);
	});
	it('zombies: kills, turned and route progress while playing', () => {
		const state = { mode: 'zombies', phase: 'playing', round: 2, progress: 0.434, checkpoint: 2, checkpoints: 5 } as ModeState;
		const v = panel('zombies', { rows: [row({ id: 1, kills: 9, deaths: 1, status: Status.Down })], state });
		expect(v.heads.map((h) => h.id)).toEqual(['kills', 'turned']);
		expect(v.rows[0]!.cells).toEqual(['9', '1']);
		expect(v.summary).toEqual([{ id: 'progress', label: 'Route', text: '43%', note: '2/5' }]);
		expect(panel('zombies', { rows, state: { ...state, phase: 'countdown' } as ModeState }).summary).toEqual([]);
	});
	it('hide and seek and infected columns', () => {
		expect(panel('hns', { rows }).heads.map((h) => h.id)).toEqual(['role', 'finds', 'survived']);
		expect(panel('infected', { rows }).heads.map((h) => h.id)).toEqual(['score', 'kills', 'streak']);
	});
	it('no mode state yet, nobody playing', () => {
		for (const id of GAME_MODE_IDS) expect(() => panel(id, {})).not.toThrow();
		expect(panel('hns', {}).empty).toBe('No players');
	});
});

describe('tournament score', () => {
	const bracket = (n: number) => ({
		size: 2 ** Math.ceil(Math.log2(n)),
		entrants: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, seed: i, out: false, left: false })),
		matches: []
	});
	const trn = (p: object) => ({ mode: 'tournament', phase: 'duel', tournament: 1, round: 1, timeLeft: 30, bracket: bracket(5), duel: null, bets: null, champion: null, ...p }) as ModeState;
	it('round labels count back from the final', () => {
		expect([1, 2, 3, 4].map((r) => trnRoundLabel(r, 16))).toEqual(['Round 1', 'Quarterfinal', 'Semifinal', 'Final']);
		expect(trnRoundLabel(1, 2)).toBe('Final');
		expect(trnRoundLabel(1, 4)).toBe('Semifinal');
		expect(trnRoundLabel(0, 8)).toBe('');
	});
	it('status: in, out, watching', () => {
		expect(trnStatusText(row({ status: Status.Alive }))).toBe('In');
		expect(trnStatusText(row({ status: Status.Down }))).toBe('Out');
		expect(trnStatusText(row({ status: Status.Spectating }))).toBe('Watching');
		expect(trnStatusText(row({ status: Status.Alive, spectating: true }))).toBe('Watching');
		expect(trnStatusText(row({ status: Status.Idle }))).toBe('–');
	});
	it('live entrants first, then by duels won and kills; watchers apart', () => {
		const rows = [
			row({ id: 1, name: 'out-big', status: Status.Down, score: 3, kills: 9 }),
			row({ id: 2, name: 'in-1', status: Status.Alive, score: 1, kills: 2 }),
			row({ id: 3, name: 'in-2', status: Status.Alive, score: 2, kills: 1 }),
			row({ id: 4, name: 'watch', status: Status.Spectating }),
			row({ id: 5, name: 'in-1b', status: Status.Alive, score: 1, kills: 4 })
		];
		const def = gameMode('tournament').score;
		const split = splitScoreboard(rows, def);
		expect(split.players.map((r) => r.name)).toEqual(['in-2', 'in-1b', 'in-1', 'out-big']);
		expect(split.spectators.map((r) => r.name)).toEqual(['watch']);
		expect(cells('tournament', rows[2]!)).toMatchObject({ trnStatus: 'In', duels: '2', kills: '1' });
		expect(cells('tournament', row({}))).toMatchObject({ duels: '0', kills: '0' });
	});
	it('panel: bracket round, prize, coins', () => {
		const rows = [row({ id: 1, status: Status.Alive, score: 1 })];
		const v = panel('tournament', { rows, state: trn({ round: 2, bracket: bracket(8) }) });
		expect([v.title, v.subtitle]).toEqual(['Tournament', 'Semifinal']);
		expect(v.heads.map((h) => h.id)).toEqual(['trnStatus', 'duels', 'kills']);
		expect(v.summary).toEqual([{ id: 'prize', label: 'Prize', text: '32 coins', note: '8 entrants' }]);
		expect(panel('tournament', { rows, state: trn({ bracket: bracket(3) }) }).summary[0]).toMatchObject({ text: '2 coins' });
		expect(panel('tournament', { rows, state: trn({ phase: 'waiting', round: 0, bracket: null }) })).toMatchObject({ subtitle: '', summary: [] });
		expect(panel('tournament', { rows, state: trn({ bracket: null, round: 3 }) }).subtitle).toBe('Round 3');
	});
});

describe('coins line', () => {
	const line = (mode: string, coins: ScorePanelInput['coins']) => panel(mode, { coins }).summary.find((l) => l.id === 'coins');
	it('multiplier and active players in every mode', () => {
		for (const id of GAME_MODE_IDS) expect(line(id, { mult: 10, active: 2, need: 0 }), id).toEqual({ id: 'coins', label: 'Coins', text: '×1.0', note: '2 active' });
		expect(line('tag', { mult: 15, active: 6, need: 3 })).toMatchObject({ text: '×1.5', note: '6 active', tone: 'good' });
	});
	it('off below the minimum, absent on older servers and offline', () => {
		expect(line('hns', { mult: 13, active: 4, need: 5 })).toMatchObject({ text: 'Off', note: '4/5 active', tone: 'bad' });
		expect(line('hns', null)).toBeUndefined();
		expect(line('hns', undefined)).toBeUndefined();
	});
});
