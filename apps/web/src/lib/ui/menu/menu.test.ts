import { describe, expect, it } from 'vitest';
import { GAME_MODE_IDS, type AdminMapInfo } from '@surf/shared';
import type { MapListEntry } from '#lib/game/contract.js';
import { CLIENT_CVARS } from '#lib/game/cvars.js';
import {
	canDisableMap,
	groupAdminMaps,
	isAdminTab,
	parseAdminCoins,
	mapSelectable,
	busyMaps,
	lobbyPlayers,
	playersLabel,
	totalPlayers,
	clampCvar,
	cvarDefault,
	difficultyRank,
	filterMaps,
	groupMapsByMode,
	mapTag,
	isSettingsSection,
	modeLabel,
	SETTINGS_SECTIONS,
	sectionDefaults,
	sectionIsDefault,
	sortMaps,
	wrapIndex
} from './menu.js';

const m = (id: string, kind: string, difficulty: string, title = id): MapListEntry => ({ id, title, kind, difficulty });

const MAPS: MapListEntry[] = [
	m('tag_yard', 'tag', 'easy', 'Yard'),
	m('surf_ember', 'surf', 'hard', 'Ember'),
	m('bhop_meadow', 'bhop', 'easy', 'Meadow'),
	m('surf_aurora', 'surf', 'easy', 'Aurora'),
	m('surf_zen', 'surf', 'easy', 'Zen'),
	m('kz_peak', 'kz', 'hard', 'Peak')
];

describe('difficulty order', () => {
	it('ranks easy before hard and unknown last', () => {
		expect(difficultyRank('easy')).toBeLessThan(difficultyRank('hard'));
		expect(difficultyRank('HARD')).toBe(difficultyRank('hard'));
		expect(difficultyRank('insane')).toBeGreaterThan(difficultyRank('hard'));
	});

	it('sorts by difficulty, then title, without mutating', () => {
		const input = MAPS.filter((x) => x.kind === 'surf');
		const before = input.map((x) => x.id);
		expect(sortMaps(input).map((x) => x.id)).toEqual(['surf_aurora', 'surf_zen', 'surf_ember']);
		expect(input.map((x) => x.id)).toEqual(before);
	});
});

describe('size tags', () => {
	const lido = (id: string, size: 'medium' | 'large'): MapListEntry => ({ ...m(id, 'hns', 'easy', 'Lido Bay'), size });

	it('replaces the difficulty badge; other maps keep it', () => {
		expect(mapTag(lido('a', 'medium'))).toEqual({ label: 'Medium', cls: 'size-medium' });
		expect(mapTag(lido('b', 'large'))).toEqual({ label: 'Large', cls: 'size-large' });
		expect(mapTag(m('c', 'surf', 'hard'))).toEqual({ label: 'hard', cls: 'diff-hard' });
	});

	it('sorts same-titled maps medium before large and filters by size', () => {
		const maps = [lido('big', 'large'), lido('mid', 'medium')];
		expect(sortMaps(maps).map((x) => x.id)).toEqual(['mid', 'big']);
		expect(filterMaps(maps, 'lido medium').map((x) => x.id)).toEqual(['mid']);
	});
});

describe('groupMapsByMode', () => {
	it('groups in registry order with labels, unknown kinds last', () => {
		const groups = groupMapsByMode(MAPS);
		expect(groups.map((g) => g.id)).toEqual(['surf', 'bhop', 'tag', 'kz']);
		expect(groups.map((g) => g.label)).toEqual(['Surf', 'Bhop', 'Tag', 'Kz']);
		expect(groups[0].maps.map((x) => x.id)).toEqual(['surf_aurora', 'surf_zen', 'surf_ember']);
	});

	it('leaves out modes without maps', () => {
		const groups = groupMapsByMode([m('bhop_a', 'bhop', 'easy')]);
		expect(groups).toHaveLength(1);
		expect(groups[0].id).toBe('bhop');
	});

	it('follows the registry so new modes need no UI change', () => {
		expect(GAME_MODE_IDS.slice(0, 3)).toEqual(['surf', 'bhop', 'tag']);
		expect(groupMapsByMode(MAPS, ['tag', 'surf']).map((g) => g.id)).toEqual(['tag', 'surf', 'bhop', 'kz']);
	});

	it('labels modes from GAME_MODES', () => {
		expect(modeLabel('surf')).toBe('Surf');
		expect(modeLabel('')).toBe('Other');
	});
});

describe('filterMaps', () => {
	it('matches title or id, case-insensitive, all words', () => {
		expect(filterMaps(MAPS, '  ').length).toBe(MAPS.length);
		expect(filterMaps(MAPS, 'EMB').map((x) => x.id)).toEqual(['surf_ember']);
		expect(filterMaps(MAPS, 'surf_').length).toBe(3);
		expect(filterMaps(MAPS, 'surf zen').map((x) => x.id)).toEqual(['surf_zen']);
		expect(filterMaps(MAPS, 'nope')).toEqual([]);
	});
});

describe('wrapIndex', () => {
	it('wraps both ways', () => {
		expect(wrapIndex(0, -1, 4)).toBe(3);
		expect(wrapIndex(3, 1, 4)).toBe(0);
		expect(wrapIndex(1, 1, 4)).toBe(2);
		expect(wrapIndex(0, 1, 0)).toBe(0);
	});
});

describe('settings sections', () => {
	it('only lists real client cvars, each once', () => {
		const names = SETTINGS_SECTIONS.flatMap((s) => s.cvars);
		expect(new Set(names).size).toBe(names.length);
		for (const n of names) expect(CLIENT_CVARS.some((d) => d.name === n)).toBe(true);
		expect(isSettingsSection('hud')).toBe(true);
		expect(isSettingsSection('nope')).toBe(false);
	});

	it('gives engine defaults', () => {
		expect(sectionDefaults('mouse')).toEqual([
			['sensitivity', 2],
			['zoom_sensitivity_ratio', 1],
			['m_yaw', 0.022],
			['m_pitch', 0.022],
			['cl_aimtoggle', 0]
		]);
		expect(cvarDefault('cl_ghost')).toBe(1);
		expect(cvarDefault('nope', 7)).toBe(7);
	});

	it('detects default state', () => {
		expect(sectionIsDefault({}, 'audio')).toBe(true);
		expect(sectionIsDefault({ volume: 0.5 }, 'audio')).toBe(true);
		expect(sectionIsDefault({ volume: '0.5' }, 'audio')).toBe(true);
		expect(sectionIsDefault({ volume: 0.2 }, 'audio')).toBe(false);
	});

	it('clamps to console ranges', () => {
		expect(clampCvar('fov', 500)).toBe(130);
		expect(clampCvar('volume', -1)).toBe(0);
		expect(clampCvar('cl_crosshaircolor_r', 12.6)).toBe(13);
		expect(clampCvar('unknown', 9)).toBe(9);
	});
});

describe('admin menu helpers', () => {
	const maps = [
		{ id: 'tag_q', title: 'Quayside', kind: 'tag', enabled: true },
		{ id: 'surf_b', title: 'Bravo', kind: 'surf', enabled: false },
		{ id: 'surf_a', title: 'Alpha', kind: 'surf', enabled: true },
		{ id: 'odd_x', title: 'Odd', kind: 'oddmode', enabled: true }
	] as AdminMapInfo[];

	it('groups by gamemode in registry order, titles A-Z, unknown kinds last', () => {
		const g = groupAdminMaps(maps);
		expect(g.map((x) => x.id)).toEqual(['surf', 'tag', 'oddmode']);
		expect(g[0].maps.map((m) => m.id)).toEqual(['surf_a', 'surf_b']);
		expect(g[2].label).toBe('Oddmode');
	});

	it('never offers to disable the last enabled map', () => {
		expect(canDisableMap(maps, 'surf_a')).toBe(true);
		expect(canDisableMap(maps, 'surf_b')).toBe(false); // already off
		const one = maps.map((m) => ({ ...m, enabled: m.id === 'surf_a' }));
		expect(canDisableMap(one, 'surf_a')).toBe(false);
	});

	it('disabled maps are selectable for admins only; tab ids', () => {
		expect(mapSelectable({ disabled: true }, false)).toBe(false);
		expect(mapSelectable({ disabled: true }, true)).toBe(true);
		expect(mapSelectable({}, false)).toBe(true);
		expect(isAdminTab('bans')).toBe(true);
		expect(isAdminTab('nope')).toBe(false);
	});

	it('coin amounts: whole numbers the server accepts', () => {
		expect([' 50 ', '1', '100000'].map(parseAdminCoins)).toEqual([50, 1, 100000]);
		for (const bad of ['', '0', '-5', '1.5', '1e3', 'x', '100001', null]) expect(parseAdminCoins(bad)).toBeNull();
	});
});

describe('server browser', () => {
	const list: MapListEntry[] = [
		{ id: 'surf_a', title: 'Alpha', kind: 'surf', difficulty: 'easy' },
		{ id: 'surf_b', title: 'Bravo', kind: 'surf', difficulty: 'hard' },
		{ id: 'tag_c', title: 'Charlie', kind: 'tag', difficulty: 'easy' },
		{ id: 'zm_d', title: 'Delta', kind: 'zombies', difficulty: 'easy' }
	];
	it('counts players per lobby; missing, bad and offline counts are 0', () => {
		const counts = { surf_a: 2, tag_c: 5, zm_d: -1, nope: 3 };
		expect(lobbyPlayers(counts, 'surf_a')).toBe(2);
		expect(lobbyPlayers(counts, 'surf_b')).toBe(0);
		expect(lobbyPlayers(counts, 'zm_d')).toBe(0);
		expect(lobbyPlayers(null, 'surf_a')).toBe(0);
		expect(totalPlayers(counts)).toBe(10);
		expect(totalPlayers(null)).toBe(0);
	});
	it('playing now: busiest first, then by title; empty and unknown maps left out', () => {
		expect(busyMaps(list, { surf_a: 2, tag_c: 5, nope: 9 }).map((m) => m.id)).toEqual(['tag_c', 'surf_a']);
		expect(busyMaps(list, { surf_b: 1, surf_a: 1 }).map((m) => m.id)).toEqual(['surf_a', 'surf_b']);
		expect(busyMaps(list, null)).toEqual([]);
	});
	it('labels', () => {
		expect([0, 1, 4].map(playersLabel)).toEqual(['Empty', '1 player', '4 players']);
	});
});
