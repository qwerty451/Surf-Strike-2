import { describe, expect, it } from 'vitest';
import { parseChatCommand } from './chat.js';
import { cleanName, loadPlayerId, uuidV4 } from './identity.js';
import { FixedStep } from './loop.js';
import { loadSoloPb, saveSoloPb, splitDelta } from './records.js';
import { cycleTarget, findTargetByName, specTargets } from './spectate.js';
import { memoryStore } from './storage.js';
import { mapLabel } from './map-label.js';
import { horizontalFov, verticalFovFromHorizontal43 } from '../render/fov.js';

describe('fov', () => {
	it('90 at 4:3 is 73.74 vertical and 106.26 at 16:9', () => {
		const v = verticalFovFromHorizontal43(90);
		expect(v).toBeCloseTo(73.7398, 3);
		expect(horizontalFov(v, 16 / 9)).toBeCloseTo(106.26, 2);
		expect(horizontalFov(v, 4 / 3)).toBeCloseTo(90, 6);
	});
});

describe('FixedStep', () => {
	it('runs 64 ticks per second regardless of frame rate', () => {
		for (const fps of [60, 144, 240]) {
			const s = new FixedStep(64, 8);
			let ticks = 0;
			for (let i = 0; i < fps; i++) ticks += s.advance(1000 / fps);
			expect(Math.abs(ticks - 64)).toBeLessThanOrEqual(1);
		}
	});
	it('caps ticks per frame and drops the backlog', () => {
		const s = new FixedStep(64, 8);
		expect(s.advance(500)).toBe(8);
		expect(s.advance(1)).toBeLessThanOrEqual(1);
		expect(s.alpha).toBeGreaterThanOrEqual(0);
		expect(s.alpha).toBeLessThan(1);
	});
});

describe('chat commands', () => {
	it('parses commands', () => {
		expect(parseChatCommand('hello')).toBeNull();
		expect(parseChatCommand('!r')).toEqual({ kind: 'restart' });
		expect(parseChatCommand('!RESTART')).toEqual({ kind: 'restart' });
		expect(parseChatCommand('!spec  bob ')).toEqual({ kind: 'spec', target: 'bob' });
		expect(parseChatCommand('!name New Name')).toEqual({ kind: 'name', name: 'New Name' });
		expect(parseChatCommand('!wat x')).toEqual({ kind: 'unknown', name: 'wat', args: 'x' });
		expect(parseChatCommand('!map  ember ')).toEqual({ kind: 'map', name: 'ember' });
		expect(parseChatCommand('!rtv')).toEqual({ kind: 'unknown', name: 'rtv', args: '' });
	});
});

describe('records', () => {
	it('keeps only better solo PBs', () => {
		const st = memoryStore();
		expect(loadSoloPb(st, 'm')).toBeNull();
		expect(saveSoloPb(st, 'm', { ticks: 1000, splits: [100, 500] })).toBe(true);
		expect(saveSoloPb(st, 'm', { ticks: 1200, splits: [] })).toBe(false);
		expect(saveSoloPb(st, 'm', { ticks: 900, splits: [90] })).toBe(true);
		expect(loadSoloPb(st, 'm')).toEqual({ ticks: 900, splits: [90] });
	});
	it('computes split deltas', () => {
		expect(splitDelta([100, 200], 1, 180)).toBe(-20);
		expect(splitDelta([100], 1, 180)).toBeNull();
		expect(splitDelta(null, 0, 1)).toBeNull();
	});
});

describe('identity', () => {
	it('generates v4 UUIDs and keeps them', () => {
		expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const st = memoryStore();
		expect(loadPlayerId(st)).toBe(loadPlayerId(st));
		expect(cleanName('  \u0001 ')).toBeNull();
	});
});

describe('spectate targets', () => {
	const players = [
		{ id: 5, name: 'Zed', spectating: false },
		{ id: 1, name: 'me', spectating: false },
		{ id: 3, name: 'Alice', spectating: false },
		{ id: 4, name: 'Spec', spectating: true }
	];
	const t = specTargets(players, 1);
	it('excludes self and spectators', () => expect(t.map((p) => p.id)).toEqual([3, 5]));
	it('cycles with wrap', () => {
		expect(cycleTarget(t, null, 1)).toBe(3);
		expect(cycleTarget(t, 3, 1)).toBe(5);
		expect(cycleTarget(t, 5, 1)).toBe(3);
		expect(cycleTarget(t, 3, -1)).toBe(5);
		expect(cycleTarget([], null, 1)).toBeNull();
	});
	it('finds by name', () => {
		expect(findTargetByName(t, 'ali')).toBe(3);
		expect(findTargetByName(t, 'ED')).toBe(5);
		expect(findTargetByName(t, 'x')).toBeNull();
	});
});

describe('map labels', () => {
	it('labels maps with their gamemode', () => {
		expect(mapLabel('x', () => ({ title: 'Title', kind: 'bhop' }))).toBe('Bhop · Title');
		expect(mapLabel('x', () => ({ title: 'Quay', kind: 'tag' }))).toBe('Tag · Quay');
		expect(mapLabel('hns_lido')).toBe('Hide and Seek · Lido Bay (Large)');
		expect(mapLabel('hns_lido_m')).toBe('Hide and Seek · Lido Bay (Medium)');
		expect(mapLabel('x', () => ({ title: 'Lab', kind: 'zombies' }))).toBe('Zombie Run · Lab');
		expect(mapLabel('x', () => ({ title: 'Outpost', kind: 'infected' }))).toBe('Infected · Outpost');
		expect(mapLabel('x', () => undefined)).toBe('x');
	});
});
