import { describe, expect, it } from 'vitest';
import { buildCollisionWorld } from '../collision/world.ts';
import { BHOP_CVARS, SURF_CVARS } from '../cvars.ts';
import { IN_JUMP } from '../movement/api.ts';
import { createPlayer, playerMove } from '../movement/gamemovement.ts';
import type { MapDef } from '../maps/types.ts';
import {
	HNS_END_SECS,
	HNS_FOUND_FREEZE_SECS,
	HNS_HIDE_SECS,
	HNS_KNIFE,
	HNS_SEEK_SECS,
	HNS_START_SECS,
	HnsGame,
	hnsSpawns,
	knifeHit,
	overSpeedCap,
	seekerCount,
	touchesBag,
	type HnsEvent,
	type HnsPos
} from './hns.ts';
import { GAME_MODES, HNS_CVARS, mapCvars } from './index.ts';

const map: Pick<MapDef, 'spawn' | 'spawns' | 'hns'> = {
	spawn: { pos: { x: 0, y: 0, z: 0 }, yaw: 0 },
	hns: {
		hiderSpawns: Array.from({ length: 8 }, (_, i) => ({ pos: { x: 1000 + i * 100, y: 0, z: 0 }, yaw: 90 })),
		seekerSpawns: [
			{ pos: { x: -500, y: 0, z: 0 }, yaw: 0 },
			{ pos: { x: -500, y: 100, z: 0 }, yaw: 0 }
		]
	}
};

const at = (x: number, y = 0, z = 0, ducked = false): HnsPos => ({ x, y, z, ducked });

/** Game on a fake clock; players placed with `place`. */
function setup(n: number, rng = () => 0) {
	let now = 1_000_000;
	const g = new HnsGame({ now, map, rng });
	const ids = Array.from({ length: n }, (_, i) => i + 1);
	const events: HnsEvent[] = [];
	const step = (ms = 0, active: number[] = ids) => {
		now += ms;
		const ev = g.update(now, active);
		events.push(...ev);
		return ev;
	};
	const place = (id: number, p: HnsPos) => g.setPos(id, p, now);
	return { g, ids, events, step, place, now: () => now };
}

/** Run from waiting to the seeking phase. */
function toSeeking(s: ReturnType<typeof setup>) {
	s.step();
	s.step(HNS_START_SECS * 1000);
	expect(s.g.phase).toBe('hiding');
	s.step(HNS_HIDE_SECS * 1000);
	expect(s.g.phase).toBe('seeking');
}

const swingAt = (s: ReturnType<typeof setup>, by: number, target: HnsPos, rewind = 0) => {
	const eye = { x: target.x - 40, y: target.y, z: target.z + 64 };
	s.place(by, at(eye.x, eye.y, eye.z - 64));
	return s.g.swing(by, { origin: eye, dir: { x: 1, y: 0, z: 0 } }, s.now(), rewind);
};

describe('hns registry and physics', () => {
	it('registers the mode with its own family, cvars and columns', () => {
		const m = GAME_MODES.hns;
		expect(m.family).toBe('hns');
		expect(m.label).toBe('Hide and Seek');
		expect(m.minPlayers).toBe(2);
		expect(m.score.columns.map((c) => c.id)).toEqual(['role', 'finds', 'survived', 'ping']);
		expect(HNS_CVARS.sv_enablebunnyhopping).toBe(0);
		expect(HNS_CVARS.sv_air_speed_cap).toBe(0);
		expect(HNS_CVARS.sv_maxspeed).toBe(250);
		expect(HNS_CVARS.sv_autobunnyhopping).toBe(1);
		expect(mapCvars({ kind: 'hns', cvars: {} }).sv_air_speed_cap).toBe(0);
	});

	it('no mode has a hard air speed cap', () => {
		expect(SURF_CVARS.sv_air_speed_cap).toBe(0);
		expect(BHOP_CVARS.sv_air_speed_cap).toBe(0);
		for (const id of ['surf', 'bhop', 'tag', 'zombies', 'infected', 'hns'] as const) expect(GAME_MODES[id].cvars.sv_air_speed_cap).toBe(0);
	});

	it('soft-caps bhop speed exactly like Infected', () => {
		const w = buildCollisionWorld({ brushes: [{ type: 'box', min: { x: -20000, y: -20000, z: -64 }, max: { x: 20000, y: 20000, z: 0 }, material: 'x' }] });
		const run = (cvars: typeof HNS_CVARS) => {
			const p = createPlayer({ x: 0, y: 0, z: 1 });
			p.velocity.x = 280;
			let yaw = 0;
			let max = 0;
			for (let i = 0; i < 64 * 20; i++) {
				yaw += 1.2;
				playerMove(w, p, { pitch: 0, yaw, forwardmove: 0, sidemove: -250, buttons: IN_JUMP }, cvars);
				max = Math.max(max, Math.hypot(p.velocity.x, p.velocity.y));
			}
			return max;
		};
		expect(run(BHOP_CVARS)).toBeGreaterThan(400);
		expect(run(HNS_CVARS)).toBe(run(GAME_MODES.infected.cvars as typeof HNS_CVARS));
		expect(run(HNS_CVARS)).toBeGreaterThan(286);
		expect(run(HNS_CVARS)).toBeLessThan(350);
	});

	it('flags state speeds over the cap', () => {
		expect(overSpeedCap(350, 0)).toBe(false);
		expect(overSpeedCap(500, 400)).toBe(true);
	});
});

describe('seekerCount and spawns', () => {
	it('picks one seeker, two from 8 players', () => {
		expect(seekerCount(2)).toBe(1);
		expect(seekerCount(7)).toBe(1);
		expect(seekerCount(8)).toBe(2);
		expect(seekerCount(20)).toBe(2);
	});

	it('falls back to spawns / spawn without hns data', () => {
		const s = hnsSpawns({ spawn: map.spawn, spawns: [map.spawn, map.spawn] });
		expect(s.hiders).toHaveLength(2);
		expect(s.seekers).toEqual([map.spawn]);
	});
});

describe('knifeHit', () => {
	const fwd = { x: 1, y: 0, z: 0 };
	it('hits a hull in reach and in the cone', () => {
		expect(knifeHit({ x: 0, y: 0, z: 64 }, fwd, at(60))).toBeCloseTo(44);
		expect(knifeHit({ x: 0, y: 0, z: 64 }, fwd, at(16 + HNS_KNIFE.reach + 1))).toBeNull();
	});
	it('misses behind and to the side', () => {
		expect(knifeHit({ x: 0, y: 0, z: 64 }, fwd, at(-50))).toBeNull();
		expect(knifeHit({ x: 0, y: 0, z: 64 }, fwd, at(50, 50))).toBeNull();
	});
	it('reaches a ducked hider below the eye', () => {
		const d = Math.hypot(1, 0, -0.5);
		expect(knifeHit({ x: 0, y: 0, z: 64 }, { x: 1 / d, y: 0, z: -0.5 / d }, at(50, 0, 0, true))).not.toBeNull();
	});
});

describe('HnsGame round flow', () => {
	it('waits below 2 players, then counts down and starts hiding', () => {
		const s = setup(1);
		s.step();
		expect(s.g.phase).toBe('waiting');
		s.step(0, [1, 2]);
		expect(s.g.phase).toBe('starting');
		s.step(HNS_START_SECS * 1000, [1, 2]);
		expect(s.g.phase).toBe('hiding');
		expect(s.g.seekers).toHaveLength(1);
		expect(s.g.hiders).toHaveLength(1);
	});

	it('spawns hiders at distinct hider spawns and freezes seekers until release', () => {
		const s = setup(4);
		s.step();
		const ev = s.step(HNS_START_SECS * 1000);
		const spawns = ev.filter((e): e is Extract<HnsEvent, { e: 'spawn' }> => e.e === 'spawn');
		expect(spawns).toHaveLength(4);
		const seeker = s.g.seekers[0]!;
		const hiderXs = spawns.filter((e) => e.role === 'hider').map((e) => e.pos.x);
		expect(new Set(hiderXs).size).toBe(3);
		expect(hiderXs.every((x) => x >= 1000)).toBe(true);
		const sk = spawns.find((e) => e.id === seeker)!;
		expect(sk.pos.x).toBe(-500);
		expect(sk.freezeSecs).toBe(HNS_HIDE_SECS);
		expect(s.g.isFrozen(seeker, s.now())).toBe(true);
		// Seekers cannot swing while hiding.
		expect(s.g.swing(seeker, { origin: { x: -500, y: 0, z: 64 }, dir: { x: 1, y: 0, z: 0 } }, s.now()).ok).toBe(false);
		s.step(HNS_HIDE_SECS * 1000);
		expect(s.g.phase).toBe('seeking');
		expect(s.g.isFrozen(seeker, s.now())).toBe(false);
		expect(s.events.some((e) => e.e === 'release')).toBe(true);
	});

	it('pulls a frozen seeker who walks away back to the spawn', () => {
		const s = setup(2);
		s.step();
		s.step(HNS_START_SECS * 1000);
		const seeker = s.g.seekers[0]!;
		s.place(seeker, at(-500, 0));
		expect(s.step(100).filter((e) => e.e === 'spawn')).toHaveLength(0);
		s.place(seeker, at(-300, 0));
		const pulls = s.step(100).filter((e) => e.e === 'spawn');
		expect(pulls).toEqual([expect.objectContaining({ id: seeker, role: 'seeker', pos: { x: -500, y: 0, z: 0 } })]);
		expect(s.g.posAt(seeker, s.now() - 100)).toMatchObject(at(-500, 0));
	});

	it('knife kill converts the hider into a frozen seeker at a seeker spawn', () => {
		const s = setup(3);
		toSeeking(s);
		const [seeker] = s.g.seekers;
		const hider = s.g.hiders[0]!;
		s.place(hider, at(2000, 0));
		const res = swingAt(s, seeker!, at(2000, 0));
		expect(res.ok && res.hit).toBe(hider);
		expect(s.g.role(hider)).toBe('seeker');
		expect(s.g.finds(seeker!)).toBe(1);
		expect(res.events).toContainEqual(expect.objectContaining({ e: 'found', by: seeker, target: hider, hidersLeft: 1 }));
		expect(res.events).toContainEqual(expect.objectContaining({ e: 'spawn', id: hider, role: 'seeker', freezeSecs: HNS_FOUND_FREEZE_SECS }));
		expect(res.events.some((e) => e.e === 'lastHider')).toBe(true);
		expect(s.g.isFrozen(hider, s.now())).toBe(true);
		s.step(HNS_FOUND_FREEZE_SECS * 1000 + 1);
		expect(s.g.isFrozen(hider, s.now())).toBe(false);
	});

	it('misses out of reach, rejects too-fast swings and hiders swinging', () => {
		const s = setup(2);
		toSeeking(s);
		const seeker = s.g.seekers[0]!;
		const hider = s.g.hiders[0]!;
		s.place(hider, at(2000, 0));
		s.place(seeker, at(1800, 0));
		const r1 = s.g.swing(seeker, { origin: { x: 1800, y: 0, z: 64 }, dir: { x: 1, y: 0, z: 0 } }, s.now());
		expect(r1.ok && r1.hit).toBe(null);
		const r2 = s.g.swing(seeker, { origin: { x: 1800, y: 0, z: 64 }, dir: { x: 1, y: 0, z: 0 } }, s.now() + 100);
		expect(r2.ok).toBe(false);
		expect(s.g.swing(hider, { origin: { x: 2000, y: 0, z: 64 }, dir: { x: 1, y: 0, z: 0 } }, s.now()).ok).toBe(false);
		// Origin far from the seeker's own position.
		const r3 = s.g.swing(seeker, { origin: { x: 1960, y: 0, z: 64 }, dir: { x: 1, y: 0, z: 0 } }, s.now() + 1000);
		expect(r3.ok).toBe(false);
	});

	it('lag compensation: hits where the seeker saw the hider', () => {
		const s = setup(2);
		toSeeking(s);
		const seeker = s.g.seekers[0]!;
		const hider = s.g.hiders[0]!;
		s.place(hider, at(2000, 0));
		s.step(200);
		s.place(hider, at(2000, 300)); // moved away since
		expect(s.g.posAt(hider, s.now() - 200)).toMatchObject({ x: 2000, y: 0 });
		const res = swingAt(s, seeker, at(2000, 0), 200);
		expect(res.ok && res.hit).toBe(hider);
	});

	it('drops the old hider pose at the round spawn', () => {
		const s = setup(2);
		s.step();
		s.place(2, at(0));
		const spawns = s.step(HNS_START_SECS * 1000);
		const spawn = spawns.find((e) => e.e === 'spawn' && e.id === 2);
		if (spawn?.e !== 'spawn') throw new Error('missing hider spawn');
		s.place(2, { ...spawn.pos, ducked: false });
		expect(s.g.posAt(2, s.now() - 200)).toMatchObject(spawn.pos);
	});

	it('does not hit between the two sides of a hider teleport', () => {
		const s = setup(2);
		toSeeking(s);
		const seeker = s.g.seekers[0]!;
		const hider = s.g.hiders[0]!;
		s.place(hider, at(2000, 0));
		s.step(80);
		s.g.setPos(hider, at(2000, 300), s.now(), true);
		expect(swingAt(s, seeker, at(2000, 150), 40)).toMatchObject({ ok: true, hit: null });
	});

	it('line of sight blocks knife hits', () => {
		let now = 0;
		const g = new HnsGame({ now, map, rng: () => 0, los: () => false });
		g.update(now, [1, 2]);
		now += (HNS_START_SECS + HNS_HIDE_SECS) * 1000;
		g.update(now - HNS_HIDE_SECS * 1000, [1, 2]);
		g.update(now, [1, 2]);
		const seeker = g.seekers[0]!;
		const hider = g.hiders[0]!;
		g.setPos(hider, at(100, 0), now);
		g.setPos(seeker, at(50, 0), now);
		const res = g.swing(seeker, { origin: { x: 50, y: 0, z: 64 }, dir: { x: 1, y: 0, z: 0 } }, now);
		expect(res.ok && res.hit).toBe(null);
	});

	it('seekers win when the last hider is found', () => {
		const s = setup(3);
		toSeeking(s);
		const seeker = s.g.seekers[0]!;
		for (const h of s.g.hiders) {
			s.step(HNS_KNIFE.swingMs);
			s.place(h, at(2000, 0));
			swingAt(s, seeker, at(2000, 0));
		}
		expect(s.g.phase).toBe('ended');
		expect(s.g.winner).toBe('seekers');
		expect(s.g.hiders).toHaveLength(0);
	});

	it('hiders win at time-out, with survived time and the summary', () => {
		const s = setup(3);
		toSeeking(s);
		const hiders = s.g.hiders;
		s.step(HNS_SEEK_SECS * 1000);
		expect(s.g.phase).toBe('ended');
		expect(s.g.winner).toBe('hiders');
		const end = s.events.find((e): e is Extract<HnsEvent, { e: 'end' }> => e.e === 'end')!;
		expect(end.survivors).toEqual(hiders);
		expect(s.g.survived(hiders[0]!)).toBe(HNS_SEEK_SECS);
	});

	it('announces 60/30/10 s warnings once each', () => {
		const s = setup(2);
		toSeeking(s);
		for (let t = 0; t < HNS_SEEK_SECS - 1; t++) s.step(1000);
		expect(s.events.filter((e) => e.e === 'warn').map((e) => (e as { secs: number }).secs)).toEqual([60, 30, 10]);
	});

	it('next round re-picks seekers, preferring those who have not sought', () => {
		const s = setup(3);
		toSeeking(s);
		const first = s.g.seekers[0]!;
		s.step(HNS_SEEK_SECS * 1000);
		s.step(HNS_END_SECS * 1000);
		expect(s.g.phase).toBe('hiding');
		expect(s.g.round).toBe(2);
		expect(s.g.seekers).not.toContain(first);
		const second = s.g.seekers[0]!;
		s.step(HNS_HIDE_SECS * 1000);
		s.step(HNS_SEEK_SECS * 1000);
		s.step(HNS_END_SECS * 1000);
		expect(s.g.seekers).not.toContain(first);
		expect(s.g.seekers).not.toContain(second);
	});

	it('late joiners during a round become seekers (frozen while hiding)', () => {
		const s = setup(2);
		s.step();
		s.step(HNS_START_SECS * 1000);
		const ev = s.step(1000, [1, 2, 3]);
		expect(s.g.role(3)).toBe('seeker');
		expect(ev).toContainEqual(expect.objectContaining({ e: 'spawn', id: 3, role: 'seeker' }));
		expect(s.g.isFrozen(3, s.now())).toBe(true);
		s.step(HNS_HIDE_SECS * 1000, [1, 2, 3]);
		s.step(1000, [1, 2, 3, 4]);
		expect(s.g.role(4)).toBe('seeker');
		expect(s.g.isFrozen(4, s.now())).toBe(false);
	});

	it('a hider becomes seeker when every seeker leaves; seekers win when all hiders leave', () => {
		const s = setup(3);
		toSeeking(s);
		const seeker = s.g.seekers[0]!;
		const rest = s.ids.filter((i) => i !== seeker);
		const ev = s.step(100, rest);
		expect(ev.some((e) => e.e === 'newSeeker')).toBe(true);
		expect(s.g.seekers).toHaveLength(1);
		expect(s.g.hiders).toHaveLength(1);

		const t = setup(4);
		toSeeking(t);
		const sk = t.g.seekers;
		t.step(100, [...sk, t.g.hiders[0]!]);
		expect(t.g.phase).toBe('seeking');
		// The last hider leaves; a late joiner (seeker) keeps the lobby at 2.
		t.step(100, [...sk, 99]);
		expect(t.g.phase).toBe('ended');
		expect(t.g.winner).toBe('seekers');
	});

	it('cancels the round below 2 players', () => {
		const s = setup(2);
		toSeeking(s);
		const ev = s.step(100, [1]);
		expect(ev).toContainEqual({ e: 'waiting', cancelled: true });
		expect(s.g.phase).toBe('waiting');
		expect(s.g.role(1)).toBe('hider');
	});

	it('view lists roles, finds and freeze time', () => {
		const s = setup(2);
		s.step();
		s.step(HNS_START_SECS * 1000);
		const v = s.g.view(s.now());
		expect(v.phase).toBe('hiding');
		expect(v.timeLeft).toBe(HNS_HIDE_SECS);
		expect(v.seekers).toHaveLength(1);
		expect(v.players.find((p) => p.role === 'seeker')!.frozen).toBe(HNS_HIDE_SECS);
	});
});

describe('cash bag', () => {
	const bagMap = { ...map, hns: { ...map.hns!, cashBag: { pos: { x: 0, y: 0, z: 0 }, place: 'here' } } };
	function bagGame(allowed = true, rng = () => 0) {
		let now = 1_000_000;
		const g = new HnsGame({ now, map: bagMap, rng, bagAllowed: () => allowed });
		const step = (ms = 0) => g.update((now += ms), [1, 2, 3, 4, 5]);
		step();
		step(HNS_START_SECS * 1000);
		step(HNS_HIDE_SECS * 1000);
		expect(g.phase).toBe('seeking');
		return { g, step, now: () => now, place: (id: number, p: HnsPos) => g.setPos(id, p, now) };
	}

	it('appears once, halfway through the seeking phase, with 4 to 10 coins', () => {
		for (const [r, coins] of [
			[0, 4],
			[0.5, 7],
			[0.9999, 10]
		] as const) {
			const s = bagGame(true, () => r);
			expect(s.g.view(s.now()).bag).toEqual({ phase: 'pending', secs: HNS_SEEK_SECS / 2 });
			expect(s.step((HNS_SEEK_SECS / 2) * 1000 - 1).some((e) => e.e === 'bag')).toBe(false);
			expect(s.step(1)).toContainEqual({ e: 'bag', pos: { x: 0, y: 0, z: 0 }, place: 'here' });
			expect(s.g.bagCoins).toBe(coins);
			expect(s.g.view(s.now()).bag).toEqual({ phase: 'out', pos: { x: 0, y: 0, z: 0 }, place: 'here' });
			expect(s.step(5000).some((e) => e.e === 'bag')).toBe(false);
		}
	});

	it('does not appear without enough players, and not on maps without a spot', () => {
		const s = bagGame(false);
		expect(s.g.view(s.now()).bag).toBeNull();
		expect(s.step((HNS_SEEK_SECS / 2) * 1000).some((e) => e.e === 'bag')).toBe(false);
		expect(s.g.bagCoins).toBeNull();
		const t = setup(5);
		toSeeking(t);
		expect(t.step((HNS_SEEK_SECS / 2) * 1000).some((e) => e.e === 'bag')).toBe(false);
	});

	it('is reached by touch, by living hiders only, and taken once', () => {
		const s = bagGame();
		s.step((HNS_SEEK_SECS / 2) * 1000);
		const seeker = s.g.seekers[0]!;
		const hider = s.g.hiders[0]!;
		s.place(seeker, at(0));
		expect(s.g.reachesBag(seeker)).toBe(false);
		expect(s.g.takeBag(seeker, 0)).toEqual([]);
		s.place(hider, at(300));
		expect(s.g.reachesBag(hider, true)).toBe(false);
		s.place(hider, at(30));
		expect(s.g.reachesBag(hider)).toBe(true);
		expect(s.g.takeBag(hider, 56)).toEqual([{ e: 'bagTaken', by: hider, coins: 4, paid: 56 }]);
		expect(s.g.reachesBag(hider)).toBe(false);
		expect(s.g.view(s.now()).bag).toEqual({ phase: 'taken', by: hider, coins: 4 });
	});

	it('sweeps the way between two packets, but never a teleport', () => {
		const bag = { x: 0, y: 0, z: 0 };
		expect(touchesBag(at(60, 20), bag)).toBe(false);
		expect(touchesBag(at(60, 20), bag, at(-60, 20))).toBe(true);
		expect(touchesBag(at(100, 0), bag, at(-100, 0))).toBe(false);
		expect(touchesBag(at(10, 0, 40), bag)).toBe(true);
		expect(touchesBag(at(10, 0, 120), bag)).toBe(false);
	});
});
