import { describe, expect, it } from 'vitest';
import { GAME_MODES, gameMode, isRaceMode, mapCvars, modeOf, TAG_CVARS } from './index.ts';
import {
	itCount,
	randomSpawn,
	TAG_IMMUNITY_SECS,
	TAG_INTERMISSION_SECS,
	TAG_RANGE,
	TAG_ROUND_SECS,
	TagGame,
	tagSpawns,
	tagTouch,
	type TagEvent,
	type TagPos
} from './tag.ts';
import { BHOP_CVARS, SURF_CVARS } from '../cvars.ts';

const at = (x: number, y = 0, z = 0, ducked = false): TagPos => ({ x, y, z, ducked });
const S = 1000;

/** Positions far apart on the X axis (no one touches). */
function spread(ids: number[]): Map<number, TagPos | null> {
	return new Map(ids.map((id) => [id, at(id * 1000)]));
}

/** A game already in round 1 at t = 5 s, with rng 0 (IT = first id). */
function playing(ids: number[]) {
	let now = 0;
	const g = new TagGame({ now, rng: () => 0 });
	const pos = spread(ids);
	g.update(now, pos);
	now = TAG_INTERMISSION_SECS * S;
	const ev = g.update(now, pos);
	expect(ev.some((e) => e.type === 'roundStart')).toBe(true);
	return { g, pos, now };
}

describe('gamemode registry', () => {
	it('classifies modes', () => {
		expect(isRaceMode('surf')).toBe(true);
		expect(isRaceMode('bhop')).toBe(true);
		expect(isRaceMode('tag')).toBe(false);
		expect(gameMode('nope').id).toBe('surf');
		expect(GAME_MODES.tag.minPlayers).toBe(2);
		expect(GAME_MODES.tag.score.columns.map((c) => c.id)).toContain('score');
		expect(GAME_MODES.surf.score.columns.map((c) => c.id)).toContain('pb');
	});

	it('mapCvars layers the map over the mode profile', () => {
		expect(mapCvars({ kind: 'bhop', cvars: {} })).toEqual(BHOP_CVARS);
		expect(mapCvars({ kind: 'surf', cvars: { sv_gravity: 600 } }).sv_gravity).toBe(600);
		expect(mapCvars({ kind: 'surf', cvars: {} }).sv_airaccelerate).toBe(SURF_CVARS.sv_airaccelerate);
		expect(modeOf({ kind: 'tag' }).cvars).toBe(TAG_CVARS);
	});
});

describe('tagTouch', () => {
	it('needs horizontal distance within range', () => {
		expect(tagTouch(at(0), at(TAG_RANGE))).toBe(true);
		expect(tagTouch(at(0), at(TAG_RANGE + 0.1))).toBe(false);
		expect(tagTouch(at(0, 0), at(28, 28))).toBe(true); // 39.6
		expect(tagTouch(at(0, 0), at(29, 29))).toBe(false); // 41.0
	});

	it('needs the hulls to overlap vertically', () => {
		expect(tagTouch(at(0, 0, 0), at(10, 0, 72))).toBe(true); // standing on the head: touching
		expect(tagTouch(at(0, 0, 0), at(10, 0, 73))).toBe(false);
		expect(tagTouch(at(0, 0, 0, true), at(10, 0, 55))).toBe(false); // ducked hull is 54 tall
		expect(tagTouch(at(10, 0, 55), at(0, 0, 0, true))).toBe(false);
		expect(tagTouch(at(0, 0, 100), at(10, 0, 30))).toBe(true);
	});
});

describe('spawn helpers', () => {
	const spawn = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
	const spawns = [1, 2, 3].map((x) => ({ pos: { x, y: 0, z: 0 }, yaw: 0 }));
	it('falls back to the single spawn', () => {
		expect(tagSpawns({ spawn })).toEqual([spawn]);
		expect(randomSpawn({ spawn })).toBe(spawn);
	});
	it('picks from the list', () => {
		expect(randomSpawn({ spawn, spawns }, () => 0)).toBe(spawns[0]);
		expect(randomSpawn({ spawn, spawns }, () => 0.999)).toBe(spawns[2]);
		expect(randomSpawn({ spawn, spawns }, () => 1)).toBe(spawns[2]);
	});
});

describe('TagGame round flow', () => {
	it('waits with fewer than 2 players: no IT, no score', () => {
		const g = new TagGame({ now: 0 });
		expect(g.update(0, spread([1]))).toEqual([]);
		expect(g.update(60 * S, spread([1]))).toEqual([]);
		expect(g.phase).toBe('waiting');
		expect(g.it).toEqual([]);
		expect(g.score(1)).toBe(0);
		expect(g.timeLeft(60 * S)).toBe(0);
	});

	it('counts down when a second player joins, then starts a round with one IT', () => {
		const g = new TagGame({ now: 0, rng: () => 0.99 });
		g.update(0, spread([1]));
		const ev = g.update(1 * S, spread([1, 2]));
		expect(ev).toEqual([{ type: 'countdown', endsAt: (1 + TAG_INTERMISSION_SECS) * S }]);
		expect(g.phase).toBe('countdown');
		expect(g.timeLeft(2 * S)).toBe(TAG_INTERMISSION_SECS - 1);
		expect(g.update(5.9 * S, spread([1, 2]))).toEqual([]);
		const start = g.update(6 * S, spread([1, 2]));
		expect(start).toEqual([{ type: 'roundStart', round: 1, it: [2], endsAt: (6 + TAG_ROUND_SECS) * S }]);
		expect(g.phase).toBe('playing');
		expect(g.isIt(2)).toBe(true);
	});

	it('two ITs from 8 players, never everyone', () => {
		expect(itCount(2)).toBe(1);
		expect(itCount(7)).toBe(1);
		expect(itCount(8)).toBe(2);
		const { g } = playing([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(g.it).toHaveLength(2);
	});

	it('scores runners for time not being IT and ends the round with a ranking', () => {
		const { g, pos, now } = playing([1, 2, 3]);
		expect(g.it).toEqual([1]);
		g.update(now + 10 * S, pos);
		expect(g.score(1)).toBe(0);
		expect(g.score(2)).toBe(10);
		expect(g.score(3)).toBe(10);
		// Updates past the end only count up to the round end.
		const ev = g.update(now + TAG_ROUND_SECS * S + 2 * S, pos);
		const end = ev.find((e): e is Extract<TagEvent, { type: 'roundEnd' }> => e.type === 'roundEnd')!;
		expect(end.round).toBe(1);
		expect(end.ranking).toEqual([
			{ id: 2, score: TAG_ROUND_SECS },
			{ id: 3, score: TAG_ROUND_SECS },
			{ id: 1, score: 0 }
		]);
		expect(g.phase).toBe('countdown');
		expect(g.it).toEqual([]);
		// Scores stay visible during the intermission, reset at the next round.
		expect(g.score(2)).toBe(TAG_ROUND_SECS);
		const next = g.update(now + TAG_ROUND_SECS * S + 2 * S + TAG_INTERMISSION_SECS * S, pos);
		expect(next.find((e) => e.type === 'roundStart')).toMatchObject({ round: 2 });
		expect(g.score(2)).toBe(0);
	});

	it('cancels the round and waits when players drop below 2', () => {
		const { g, now } = playing([1, 2]);
		const ev = g.update(now + S, spread([2]));
		expect(ev).toEqual([{ type: 'waiting', cancelled: true }]);
		expect(g.phase).toBe('waiting');
		expect(g.it).toEqual([]);
	});

	it('hands IT to a runner when the IT leaves mid-round', () => {
		const { g, now } = playing([1, 2, 3]);
		expect(g.it).toEqual([1]);
		const ev = g.update(now + S, spread([2, 3]));
		expect(ev).toEqual([{ type: 'newIt', id: 2 }]);
		expect(g.it).toEqual([2]);
	});

	it('late joiners start as runners with 0 score', () => {
		const { g, now } = playing([1, 2]);
		g.update(now + 10 * S, spread([1, 2]));
		g.update(now + 20 * S, spread([1, 2, 3]));
		expect(g.isIt(3)).toBe(false);
		expect(g.score(3)).toBe(0);
		g.update(now + 30 * S, spread([1, 2, 3]));
		expect(g.score(3)).toBe(10);
		expect(g.score(2)).toBe(30);
	});
});

describe('TagGame tagging', () => {
	it('IT tags a touching runner; roles swap; the old IT is immune for 3 s', () => {
		const { g, now } = playing([1, 2, 3]);
		const pos = new Map<number, TagPos | null>([
			[1, at(0)],
			[2, at(30)],
			[3, at(5000)]
		]);
		const ev = g.update(now + S, pos);
		expect(ev).toEqual([{ type: 'tag', by: 1, target: 2 }]);
		expect(g.it).toEqual([2]);
		expect(g.immune(now + S)).toEqual([1]);
		// Still touching: no tag-back during immunity.
		expect(g.update(now + 2 * S, pos)).toEqual([]);
		expect(g.update(now + (1 + TAG_IMMUNITY_SECS) * S - 1, pos)).toEqual([]);
		// Immunity over: tag back.
		expect(g.update(now + (1 + TAG_IMMUNITY_SECS) * S, pos)).toEqual([{ type: 'tag', by: 2, target: 1 }]);
		expect(g.it).toEqual([1]);
	});

	it('tags when two players surfing at 1600 u/s cross between checks', () => {
		const { g, now } = playing([1, 2]);
		const pos = new Map([[1, at(-25)], [2, at(25)]]);
		expect(g.update(now + 31.25, pos)).toEqual([]);
		pos.set(1, at(25));
		pos.set(2, at(-25));
		expect(g.update(now + 62.5, pos)).toEqual([{ type: 'tag', by: 1, target: 2 }]);
	});

	it('ignores a crossing at separate heights or across a teleport', () => {
		const { g, now } = playing([1, 2]);
		const pos = new Map([[1, at(-25)], [2, at(25, 0, 80)]]);
		expect(g.update(now + 31.25, pos)).toEqual([]);
		pos.set(1, at(25));
		pos.set(2, at(-25, 0, 80));
		expect(g.update(now + 62.5, pos)).toEqual([]);
		pos.set(2, at(-25));
		expect(g.update(now + 93.75, pos)).toEqual([]);
		pos.set(2, at(75));
		expect(g.update(now + 125, pos, new Set([2]))).toEqual([]);
	});

	it('uses the crouched hull before the standing half of a sweep', () => {
		const { g, now } = playing([1, 2]);
		const pos = new Map([[1, at(0, 0, 0, true)], [2, at(-50, 0, 55)]]);
		expect(g.update(now + 100, pos)).toEqual([]);
		pos.set(1, at(0));
		pos.set(2, at(200, 0, 55));
		expect(g.update(now + 131.25, pos)).toEqual([]);
	});

	it('does not chain: a newly tagged IT cannot tag in the same update', () => {
		const { g, now } = playing([1, 2, 3]);
		const pos = new Map<number, TagPos | null>([
			[1, at(0)],
			[2, at(30)],
			[3, at(60)] // touches 2, not 1
		]);
		expect(g.update(now + S, pos)).toEqual([{ type: 'tag', by: 1, target: 2 }]);
		expect(g.update(now + S + 31, pos)).toEqual([{ type: 'tag', by: 2, target: 3 }]);
		expect(g.it).toEqual([3]);
		expect(g.immune(now + S + 31)).toEqual([1, 2]);
	});

	it('tags the closest runner; players without a position are ignored', () => {
		const { g, now } = playing([1, 2, 3, 4]);
		const pos = new Map<number, TagPos | null>([
			[1, at(0)],
			[2, at(35)],
			[3, at(20)],
			[4, null]
		]);
		expect(g.update(now + S, pos)).toEqual([{ type: 'tag', by: 1, target: 3 }]);
		const pos2 = new Map<number, TagPos | null>([
			[1, null],
			[2, at(9000)],
			[3, at(0)],
			[4, null]
		]);
		expect(g.update(now + 2 * S, pos2)).toEqual([]);
	});

	it('IT time costs score: being tagged stops the clock', () => {
		const { g, now } = playing([1, 2]);
		const apart = spread([1, 2]);
		g.update(now + 10 * S, apart);
		g.update(now + 10 * S, new Map([[1, at(0)], [2, at(10)]]));
		expect(g.it).toEqual([2]);
		g.update(now + 30 * S, apart);
		expect(g.score(1)).toBe(20);
		expect(g.score(2)).toBe(10);
		expect(g.scores()[0]).toEqual({ id: 1, score: 20 });
	});

	it('two ITs never tag each other', () => {
		const { g, now } = playing([1, 2, 3, 4, 5, 6, 7, 8]);
		const [a, b] = g.it as [number, number];
		const pos = spread([1, 2, 3, 4, 5, 6, 7, 8]);
		pos.set(a, at(0, 0, 0));
		pos.set(b, at(10, 0, 0));
		expect(g.update(now + S, pos)).toEqual([]);
		expect(g.it).toEqual([a, b].sort((x, y) => x - y));
	});
});
