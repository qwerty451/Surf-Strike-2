import { describe, expect, it } from 'vitest';
import type { RotationEvent } from './rotation.ts';
import {
	CHANGE_COUNTDOWN,
	EXTEND_DURATION,
	MAP_DURATION,
	MAX_VOTE_MAPS,
	RTV_BLOCK,
	RTV_DECLINE_COOLDOWN,
	RTV_REQUEST_DURATION,
	VOTE_AT,
	VOTE_DURATION
} from './rotation.ts';
import { MapRotation } from './rotation-impl.ts';

const MAPS = ['a', 'b', 'c', 'd'];
const S = 1000;

function make(rng = () => 0) {
	return new MapRotation({ maps: MAPS, current: 'a', now: 0, rng });
}

const ofType = <T extends RotationEvent['type']>(ev: RotationEvent[] | { error: string }, t: T) =>
	(Array.isArray(ev) ? ev : []).filter((e) => e.type === t) as Extract<RotationEvent, { type: T }>[];

describe('MapRotation', () => {
	it('counts down 15 minutes', () => {
		const r = make();
		expect(r.current).toBe('a');
		expect(r.timeLeft(0)).toBe(MAP_DURATION);
		expect(r.timeLeft(60 * S)).toBe(MAP_DURATION - 60);
		expect(r.timeLeft(10_000 * S)).toBe(0);
	});

	it('honours a shorter map duration and RTV lockout (dev override)', () => {
		const r = new MapRotation({ maps: MAPS, current: 'a', now: 0, rng: () => 0, mapDuration: 60, rtvBlock: 15 });
		expect(r.timeLeft(0)).toBe(60);
		expect(r.rtv('x', 1, 10 * S)).toEqual({ error: 'Rock the vote is available in 5 s.' });
		expect(ofType(r.update((60 - VOTE_AT) * S, 1), 'voteStart')).toHaveLength(1);
		const ch = ofType(r.update((60 - VOTE_AT + VOTE_DURATION + CHANGE_COUNTDOWN) * S, 1), 'mapChange');
		// Resolution and change may take two updates (vote end, then countdown).
		const change = ch[0] ?? ofType(r.update((60 + 60) * S, 1), 'mapChange')[0];
		expect(change.timeLeft).toBe(60);
	});

	it('opens a vote at 0:30 left with 3 maps + extend', () => {
		const r = make();
		expect(r.update((MAP_DURATION - VOTE_AT - 1) * S, 3)).toEqual([]);
		const ev = r.update((MAP_DURATION - VOTE_AT) * S, 3);
		const vs = ofType(ev, 'voteStart')[0];
		expect(vs.duration).toBe(VOTE_DURATION);
		expect(vs.rtv).toBe(false);
		expect(vs.options).toEqual([
			{ kind: 'map', mapId: 'b' },
			{ kind: 'map', mapId: 'c' },
			{ kind: 'map', mapId: 'd' },
			{ kind: 'extend' }
		]);
		expect(r.vote).not.toBeNull();
		// Does not open twice.
		expect(ofType(r.update((MAP_DURATION - VOTE_AT + 1) * S, 3), 'voteStart')).toEqual([]);
	});

	it('most votes wins; vote changes allowed; 5 s countdown then mapChange', () => {
		const r = make();
		const t0 = (MAP_DURATION - VOTE_AT) * S;
		r.update(t0, 3);
		expect(ofType(r.castVote('p1', 2, t0 + 1), 'voteUpdate')[0].counts).toEqual([0, 1, 0, 0]);
		r.castVote('p2', 2, t0 + 2);
		r.castVote('p3', 1, t0 + 3);
		expect(ofType(r.castVote('p3', 2, t0 + 4), 'voteUpdate')[0].counts).toEqual([0, 3, 0, 0]);
		expect(r.castVote('p3', 9, t0 + 5)).toEqual([]);
		const tEnd = t0 + VOTE_DURATION * S;
		const end = r.update(tEnd, 3);
		expect(end).toEqual([{ type: 'voteEnd', winner: { kind: 'map', mapId: 'c' }, countdown: CHANGE_COUNTDOWN }]);
		expect(r.update(tEnd + 4 * S, 3)).toEqual([]);
		expect(r.current).toBe('a');
		const mc = r.update(tEnd + CHANGE_COUNTDOWN * S, 3);
		expect(mc).toEqual([{ type: 'mapChange', map: 'c', timeLeft: MAP_DURATION }]);
		expect(r.current).toBe('c');
		expect(r.timeLeft(tEnd + CHANGE_COUNTDOWN * S)).toBe(MAP_DURATION);
	});

	it('no votes picks a random other map; ties are random', () => {
		const r = make(() => 0.99);
		const t0 = (MAP_DURATION - VOTE_AT) * S;
		r.update(t0, 1);
		const end = ofType(r.update(t0 + VOTE_DURATION * S, 1), 'voteEnd')[0];
		expect(end.winner).toEqual({ kind: 'map', mapId: 'd' });

		const r2 = make(() => 0.99);
		r2.update(t0, 2);
		r2.castVote('x', 1, t0);
		r2.castVote('y', 2, t0);
		expect(ofType(r2.update(t0 + VOTE_DURATION * S, 2), 'voteEnd')[0].winner).toEqual({ kind: 'map', mapId: 'c' });
		const r3 = make(() => 0);
		r3.update(t0, 2);
		r3.castVote('x', 1, t0);
		r3.castVote('y', 2, t0);
		expect(ofType(r3.update(t0 + VOTE_DURATION * S, 2), 'voteEnd')[0].winner).toEqual({ kind: 'map', mapId: 'b' });
	});

	it('extend adds 10:00, at most twice', () => {
		const r = make();
		let t = (MAP_DURATION - VOTE_AT) * S;
		for (let i = 0; i < 2; i++) {
			const vs = ofType(r.update(t, 1), 'voteStart')[0];
			expect(vs.options.at(-1)).toEqual({ kind: 'extend' });
			r.castVote('solo', 4, t);
			const before = r.timeLeft(t + VOTE_DURATION * S);
			const ev = r.update(t + VOTE_DURATION * S, 1);
			expect(ofType(ev, 'voteEnd')[0]).toEqual({ type: 'voteEnd', winner: { kind: 'extend' }, countdown: 0 });
			const ext = ofType(ev, 'extended')[0];
			expect(ext.timeLeft).toBeCloseTo(before + EXTEND_DURATION, 6);
			expect(r.current).toBe('a');
			t = t + VOTE_DURATION * S + (ext.timeLeft - VOTE_AT) * S;
		}
		expect(r.extendCount).toBe(2);
		const vs = ofType(r.update(t, 1), 'voteStart')[0];
		expect(vs.options).toHaveLength(3);
		expect(vs.options.some((o) => o.kind === 'extend')).toBe(false);
	});

	it('rtv blocked for the first 20 seconds', () => {
		expect(RTV_BLOCK).toBe(20);
		const r = make();
		const res = r.rtv('p1', 1, 5 * S);
		expect(res).toEqual({ error: expect.stringContaining('15 s') });
		expect(Array.isArray(r.rtv('p1', 1, 20 * S))).toBe(true);
	});

	it('forceMap changes at once and cancels the vote', () => {
		const r = make();
		const t0 = (MAP_DURATION - VOTE_AT) * S;
		r.update(t0, 1);
		expect(r.vote).not.toBeNull();
		expect(r.forceMap('zzz', t0)).toBeNull();
		expect(r.forceMap('b', t0 + S)).toEqual({ type: 'mapChange', map: 'b', timeLeft: MAP_DURATION });
		expect(r.vote).toBeNull();
		expect(r.current).toBe('b');
		expect(r.timeLeft(t0 + S)).toBe(MAP_DURATION);
		expect(r.update(t0 + 2 * S, 1)).toEqual([]);
	});

	it('rtv needs a third of voters and opens a vote without extend', () => {
		const r = make();
		const t = RTV_BLOCK * S;
		const a = r.rtv('p1', 7, t);
		expect(ofType(a, 'rtvRequest')[0]).toEqual({
			type: 'rtvRequest',
			started: true,
			initiator: 'p1',
			mapId: null,
			duration: RTV_REQUEST_DURATION,
			yes: 1,
			no: 0,
			needed: 3
		});
		expect(ofType(a, 'voteStart')).toHaveLength(0);
		expect(r.rtv('p1', 7, t)).toEqual({ error: expect.any(String) });
		expect(ofType(r.rtv('p2', 7, t), 'voteStart')).toHaveLength(0);
		const c = r.rtv('p3', 7, t);
		const vs = ofType(c, 'voteStart')[0];
		expect(vs.rtv).toBe(true);
		expect(vs.options.some((o) => o.kind === 'extend')).toBe(false);
		expect(r.rtv('p4', 5, t)).toEqual({ error: expect.any(String) });
		const end = ofType(r.update(t + VOTE_DURATION * S, 5), 'voteEnd')[0];
		expect(end.winner.kind).toBe('map');
		const mc = ofType(r.update(t + (VOTE_DURATION + CHANGE_COUNTDOWN) * S, 5), 'mapChange')[0];
		expect(mc.map).not.toBe('a');
		// rtv blocked again on the new map.
		expect(r.rtv('p1', 5, t + (VOTE_DURATION + CHANGE_COUNTDOWN + 1) * S)).toEqual({ error: expect.any(String) });
	});

	it('solo rtv opens at once', () => {
		const r = make();
		const ev = r.rtv('me', 1, RTV_BLOCK * S);
		expect(ofType(ev, 'voteStart')).toHaveLength(1);
	});

	it('rtv threshold re-checked when voters leave', () => {
		const r = make();
		const t = RTV_BLOCK * S;
		r.rtv('p1', 4, t); // need 2
		expect(ofType(r.update(t + 100, 4), 'voteStart')).toHaveLength(0);
		r.removeVoter('p4');
		expect(ofType(r.update(t + 200, 3), 'voteStart')).toHaveLength(1);
	});

	it('removeVoter drops their ballot', () => {
		const r = make();
		const t0 = (MAP_DURATION - VOTE_AT) * S;
		r.update(t0, 2);
		r.castVote('x', 1, t0);
		r.removeVoter('x');
		expect(ofType(r.update(t0 + 100, 1), 'voteUpdate')[0].counts).toEqual([0, 0, 0, 0]);
	});

	it('rtvNeeded', () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 32].map(MapRotation.rtvNeeded)).toEqual([1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 11]);
	});

	it('limits options to 8 random other maps', () => {
		const r = new MapRotation({ maps: 'abcdefghij'.split(''), current: 'a', now: 0, rng: () => 0.5 });
		const vs = ofType(r.update((MAP_DURATION - VOTE_AT) * S, 1), 'voteStart')[0];
		expect(MAX_VOTE_MAPS).toBe(8);
		expect(vs.options.filter((o) => o.kind === 'map')).toHaveLength(8);
		expect(vs.options.some((o) => o.kind === 'map' && o.mapId === 'a')).toBe(false);
	});

	it('isEnabled filter: disabled maps never come up in votes, rtv or random picks', () => {
		const disabled = new Set(['b', 'c']);
		const r = new MapRotation({ maps: MAPS, current: 'a', now: 0, rng: () => 0, isEnabled: (id) => !disabled.has(id) });
		const vs = ofType(r.update((MAP_DURATION - VOTE_AT) * S, 3), 'voteStart')[0];
		expect(vs.options).toEqual([{ kind: 'map', mapId: 'd' }, { kind: 'extend' }]);
		// No votes: the random pick is an enabled map too.
		const end = ofType(r.update((MAP_DURATION - VOTE_AT + VOTE_DURATION) * S, 3), 'voteEnd')[0];
		expect(end.winner).toEqual({ kind: 'map', mapId: 'd' });
	});

	it('isEnabled is live and only the current map left means no rtv', () => {
		const disabled = new Set<string>();
		const r = new MapRotation({ maps: MAPS, current: 'a', now: 0, rng: () => 0, isEnabled: (id) => !disabled.has(id) });
		for (const m of ['b', 'c', 'd']) disabled.add(m);
		expect(r.rtv('x', 1, RTV_BLOCK * S)).toEqual({ error: 'There are no other maps.' });
		disabled.delete('c');
		const ev = r.rtv('x', 1, RTV_BLOCK * S);
		expect(ofType(ev, 'voteStart')[0].options).toEqual([{ kind: 'map', mapId: 'c' }]);
	});

	it('forceMap ignores isEnabled; extendBy adds time outside votes', () => {
		const r = new MapRotation({ maps: MAPS, current: 'a', now: 0, rng: () => 0, isEnabled: (id) => id !== 'b' });
		expect(r.forceMap('b', 5 * S)).toEqual({ type: 'mapChange', map: 'b', timeLeft: MAP_DURATION });
		expect(r.current).toBe('b');
		expect(r.forceMap('zz', 5 * S)).toBeNull();
		const ext = r.extendBy(EXTEND_DURATION, 5 * S);
		expect(ext).toEqual({ type: 'extended', timeLeft: MAP_DURATION + EXTEND_DURATION });
		expect(r.extendCount).toBe(0);
		// The scheduled vote opens later, at 0:30 of the extended time.
		expect(ofType(r.update((5 + MAP_DURATION - VOTE_AT) * S, 1), 'voteStart')).toHaveLength(0);
		const late = (5 + MAP_DURATION + EXTEND_DURATION - VOTE_AT) * S;
		expect(ofType(r.update(late, 1), 'voteStart')).toHaveLength(1);
		expect(r.extendBy(60, late)).toBeNull();
	});
});

// Categories: s* surf, b* bhop, t* tag, z* zombies, i* infected, h* hide and seek, d* Zombie Defense.
const KIND: Record<string, string> = { s: 'surf', b: 'bhop', t: 'tag', z: 'zombies', i: 'infected', h: 'hns', d: 'defense' };
const kindOf = (id: string) => KIND[id[0]] ?? 'other';
const CAT_MAPS = ['s1', 's2', 's3', 's4', 'b1', 'b2', 'b3', 't1', 't2', 'z1', 'z2', 'i1', 'i2', 'h1', 'h2', 'd1', 'd2'];
const mapIds = (opts: { kind: string; mapId?: string }[]) => opts.filter((o) => o.kind === 'map').map((o) => o.mapId!);
const kinds = (ids: string[]) => ids.map(kindOf);

function catRotation(opts: { maps?: string[]; current?: string; rng?: () => number; isEnabled?: (id: string) => boolean } = {}) {
	return new MapRotation({
		maps: opts.maps ?? CAT_MAPS,
		current: opts.current ?? 's1',
		now: 0,
		rng: opts.rng ?? (() => 0.5),
		kindOf,
		isEnabled: opts.isEnabled
	});
}
const timedVote = (r: MapRotation) => ofType(r.update((MAP_DURATION - VOTE_AT) * S, 1), 'voteStart')[0];

describe('MapRotation vote options by category', () => {
	it('2 surf and 1 map of every other mode in category order, extend as option 9', () => {
		for (const x of [0, 0.3, 0.7, 0.99]) {
			const vs = timedVote(catRotation({ rng: () => x }));
			const ids = mapIds(vs.options);
			expect(kinds(ids)).toEqual(['surf', 'surf', 'bhop', 'tag', 'zombies', 'infected', 'hns', 'defense']);
			expect(new Set(ids).size).toBe(8);
			expect(ids).not.toContain('s1');
			expect(vs.options).toHaveLength(9);
			expect(vs.options[8]).toEqual({ kind: 'extend' });
		}
	});

	it('fills free slots from other categories, fewer only without enough maps', () => {
		// No zombies/infected/hns/tournament, one tag map: free slots taken by surf/bhop extras.
		const maps = ['s1', 's2', 's3', 's4', 'b1', 'b2', 'b3', 't1'];
		const ids = mapIds(timedVote(catRotation({ maps })).options);
		expect(ids).toHaveLength(7);
		expect(new Set(ids).size).toBe(7);
		expect(ids).toContain('t1');
		expect(kinds(ids).filter((k) => k === 'surf').length).toBeGreaterThanOrEqual(2);
		expect(kinds(ids).filter((k) => k === 'bhop').length).toBeGreaterThanOrEqual(2);
		// Stable order by category.
		const order = ['surf', 'bhop', 'tag', 'zombies', 'infected', 'hns', 'defense'];
		const k = kinds(ids).map((c) => order.indexOf(c));
		expect([...k].sort((a, b) => a - b)).toEqual(k);
		// Only 3 other maps: 3 options.
		expect(mapIds(timedVote(catRotation({ maps: ['s1', 's2', 'b1', 'z1'] })).options)).toEqual(['s2', 'b1', 'z1']);
	});

	it('no votes: the winner is a random map from the ballot', () => {
		for (const x of [0, 0.5, 0.99]) {
			const r = catRotation({ rng: () => x });
			const ids = mapIds(timedVote(r).options);
			const end = ofType(r.update((MAP_DURATION - VOTE_AT + VOTE_DURATION) * S, 1), 'voteEnd')[0];
			expect(end.winner.kind).toBe('map');
			expect(ids).toContain((end.winner as { mapId: string }).mapId);
		}
	});

	it('excludes disabled and current maps', () => {
		const off = new Set(['s2', 's3', 'z1', 'z2']);
		const ids = mapIds(timedVote(catRotation({ isEnabled: (id) => !off.has(id) })).options);
		expect(ids).toHaveLength(8);
		for (const m of [...off, 's1']) expect(ids).not.toContain(m);
		expect(ids).toContain('s4');
	});

	it('a nominated map replaces a slot of its own category', () => {
		for (const x of [0, 0.5, 0.99]) {
			const r = catRotation({ rng: () => x });
			const ev = r.requestRtv('p1', 1, RTV_BLOCK * S, 'b3');
			const ids = mapIds(ofType(ev, 'voteStart')[0].options);
			expect(ids).toContain('b3');
			expect(kinds(ids)).toEqual(['surf', 'surf', 'bhop', 'tag', 'zombies', 'infected', 'hns', 'defense']);
		}
		// RTV votes have no extend option.
		const r = catRotation();
		const vs = ofType(r.requestRtv('p1', 1, RTV_BLOCK * S, 't2'), 'voteStart')[0];
		expect(vs.options.some((o) => o.kind === 'extend')).toBe(false);
		expect(mapIds(vs.options)).toContain('t2');
	});
});

describe('MapRotation RTV request', () => {
	const t = RTV_BLOCK * S;
	const req = (r: MapRotation, id: string, voters: number, at = t, map: string | null = null) => r.requestRtv(id, voters, at, map);

	it('passes at exactly ceil(n/3) yes votes and opens the vote', () => {
		const r = make();
		const a = req(r, 'p1', 7); // need 3
		expect(ofType(a, 'voteStart')).toHaveLength(0);
		expect(r.request?.needed).toBe(3);
		expect(ofType(r.rtvVote('p2', true, 7, t + S), 'rtvRequest')[0]).toMatchObject({ started: false, yes: 2, no: 0, needed: 3 });
		expect(ofType(r.rtvVote('p3', false, 7, t + S), 'rtvRequest')[0]).toMatchObject({ yes: 2, no: 1 });
		const ev = r.rtvVote('p4', true, 7, t + 2 * S);
		expect(ofType(ev, 'rtvRequestEnd')[0]).toEqual({ type: 'rtvRequestEnd', passed: true, reason: 'passed', cooldown: 0 });
		expect(ofType(ev, 'voteStart')[0].rtv).toBe(true);
		expect(r.request).toBeNull();
		// Passing sets no cooldown (the vote blocks requests meanwhile).
		expect(r.rtvAvailableIn(t + 3 * S)).toBeNull();
	});

	it('declines on timeout, then a 60 s cooldown', () => {
		expect(RTV_DECLINE_COOLDOWN).toBe(60);
		const r = make();
		req(r, 'p1', 4); // need 2
		expect(r.update(t + (RTV_REQUEST_DURATION - 1) * S, 4)).toEqual([]);
		const end = r.update(t + RTV_REQUEST_DURATION * S, 4);
		expect(end).toEqual([{ type: 'rtvRequestEnd', passed: false, reason: 'timeout', cooldown: 60 }]);
		const t1 = t + (RTV_REQUEST_DURATION + 15) * S;
		expect(req(r, 'p2', 4, t1)).toEqual({ error: 'Map vote declined — try again in 45 s.' });
		expect(r.rtvAvailableIn(t1)).toEqual({ seconds: 45, reason: 'declined' });
		expect(Array.isArray(req(r, 'p2', 4, t + (RTV_REQUEST_DURATION + 60) * S))).toBe(true);
	});

	it('declines early when enough no votes make passing impossible', () => {
		const r = make();
		req(r, 'p1', 4); // need 2, 3 others undecided
		expect(ofType(r.rtvVote('p2', false, 4, t), 'rtvRequestEnd')).toHaveLength(0);
		expect(ofType(r.rtvVote('p3', false, 4, t), 'rtvRequestEnd')).toHaveLength(0);
		const ev = r.rtvVote('p4', false, 4, t);
		expect(ofType(ev, 'rtvRequestEnd')[0]).toMatchObject({ passed: false, reason: 'rejected', cooldown: 60 });
		expect(r.rtvVote('p4', true, 4, t)).toEqual({ error: 'No map vote request is open.' });
	});

	it('drops votes of players who leave and recomputes the threshold', () => {
		const r = make();
		req(r, 'p1', 7); // need 3
		r.rtvVote('p2', true, 7, t);
		r.removeVoter('p2');
		expect(ofType(r.update(t + 100, 6), 'rtvRequest')[0]).toMatchObject({ yes: 1, needed: 2 });
		// Three players left: need 1, p1's yes is enough.
		const ev = r.update(t + 200, 3);
		expect(ofType(ev, 'rtvRequestEnd')[0].passed).toBe(true);
		expect(ofType(ev, 'voteStart')).toHaveLength(1);
	});

	it('rejects nominating the current, a disabled or an unknown map', () => {
		const r = new MapRotation({ maps: MAPS, current: 'a', now: 0, rng: () => 0, isEnabled: (id) => id !== 'c' });
		expect(req(r, 'p1', 4, t, 'a')).toEqual({ error: 'That map is already being played.' });
		expect(req(r, 'p1', 4, t, 'c')).toEqual({ error: 'That map is disabled by an admin.' });
		expect(req(r, 'p1', 4, t, 'zz')).toEqual({ error: 'Unknown map "zz".' });
		expect(r.request).toBeNull();
		expect(ofType(req(r, 'p1', 4, t, 'd'), 'rtvRequest')[0].mapId).toBe('d');
	});

	it('one request at a time; !rtv on an open request is a yes vote', () => {
		const r = make();
		req(r, 'p1', 7);
		expect(req(r, 'p2', 7, t, 'b')).toEqual({ error: expect.stringContaining('already open') });
		expect(ofType(req(r, 'p2', 7), 'rtvRequest')[0].yes).toBe(2);
		expect(req(r, 'p2', 7)).toEqual({ error: expect.any(String) });
	});

	it('no request during a vote, a pending change or the map-start block', () => {
		const r = make();
		expect(req(r, 'p1', 4, 5 * S)).toEqual({ error: 'Rock the vote is available in 15 s.' });
		expect(r.rtvAvailableIn(5 * S)).toEqual({ seconds: 15, reason: 'mapStart' });
		const t0 = (MAP_DURATION - VOTE_AT) * S;
		r.update(t0, 4);
		expect(req(r, 'p1', 4, t0)).toEqual({ error: 'A vote is already in progress.' });
		r.update(t0 + VOTE_DURATION * S, 4);
		expect(req(r, 'p1', 4, t0 + VOTE_DURATION * S)).toEqual({ error: 'The map is about to change.' });
	});

	it('the timed vote cancels an open request without a cooldown', () => {
		const r = make();
		const t0 = (MAP_DURATION - VOTE_AT) * S;
		req(r, 'p1', 4, t0 - S);
		const ev = r.update(t0, 4);
		expect(ofType(ev, 'rtvRequestEnd')[0]).toMatchObject({ passed: false, reason: 'cancelled', cooldown: 0 });
		expect(ofType(ev, 'voteStart')).toHaveLength(1);
	});
});
