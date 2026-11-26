import { describe, expect, it, vi } from 'vitest';
import { restMotion } from '../../body-motion.ts';
import { INTERP_DELAY_MS, SNAPSHOT_HZ } from '../../protocol.ts';
import type { Vec3 } from '../../types.ts';
import { playerPoint, type PlayerPose } from '../zombies/hitbox.ts';
import { WEAPONS } from '../zombies/weapons.ts';
import { INF_INFECTED_SPEED, INF_STEP_MS } from './game.ts';
import { INF_HISTORY_MS, INF_REWIND_ALLOWANCE_MS, infRewindMs, PoseHistory } from './lagcomp.ts';
import { kitPlaying, KIT_SPAWNS } from './testkit.ts';

const pose = (x: number, over: Partial<PlayerPose> = {}): PlayerPose => ({ x, y: 0, z: 0, yaw: 0, ducked: false, hunched: false, ...over });
const blank = (): PlayerPose => pose(NaN);

describe('infRewindMs', () => {
	it('is ping + interpolation delay + half a snapshot interval, clamped to the history', () => {
		expect(INF_REWIND_ALLOWANCE_MS).toBe(1000 / SNAPSHOT_HZ / 2);
		expect(infRewindMs(0)).toBe(INTERP_DELAY_MS + INF_REWIND_ALLOWANCE_MS);
		expect(infRewindMs(40)).toBe(40 + INTERP_DELAY_MS + INF_REWIND_ALLOWANCE_MS);
		expect(infRewindMs(150)).toBe(150 + INTERP_DELAY_MS + INF_REWIND_ALLOWANCE_MS);
		expect(infRewindMs(1000)).toBe(INF_HISTORY_MS);
		expect(infRewindMs(Infinity)).toBe(INTERP_DELAY_MS + INF_REWIND_ALLOWANCE_MS);
		expect(infRewindMs(NaN)).toBe(INTERP_DELAY_MS + INF_REWIND_ALLOWANCE_MS);
		expect(infRewindMs(-50)).toBe(INTERP_DELAY_MS + INF_REWIND_ALLOWANCE_MS);
	});

	it('the allowance stays inside the thinnest hit box at infected speed', () => {
		// A leg in profile: 4 units either side of its middle, plus the 2 unit pad.
		expect((INF_REWIND_ALLOWANCE_MS / 1000) * INF_INFECTED_SPEED).toBeLessThan(6);
	});
});

describe('PoseHistory', () => {
	it('interpolates between the two samples around a time', () => {
		const h = new PoseHistory(8);
		h.record(1000, 1, pose(0));
		h.record(1020, 2, pose(10));
		h.record(1040, 3, pose(30, { ducked: true, hunched: true }));
		const out = blank();
		h.poseAt(1010, 1040, pose(30), out);
		expect(out).toEqual(pose(5));
		h.poseAt(1025, 1040, pose(30), out);
		expect(out).toMatchObject({ x: 15, ducked: false, hunched: false });
		// Ducked and posture come from the nearer sample.
		h.poseAt(1035, 1040, pose(30), out);
		expect(out).toMatchObject({ x: 25, ducked: true, hunched: true });
		h.poseAt(1020, 1040, pose(30), out);
		expect(out).toEqual(pose(10));
	});

	it('interpolates the motion between the two samples', () => {
		const h = new PoseHistory(8);
		const slow = { ...restMotion(), speed: 0, duck: 0, aim: -0.4 };
		const fast = { ...restMotion(), speed: 200, duck: 1, aim: 0.4 };
		h.record(1000, 1, pose(0, { motion: slow }));
		h.record(1020, 2, pose(10, { motion: fast }));
		const out = blank();
		h.poseAt(1005, 1020, pose(10, { motion: fast }), out);
		expect(out.motion!.speed).toBeCloseTo(50, 9);
		expect(out.motion!.duck).toBeCloseTo(0.25, 9);
		expect(out.motion!.aim).toBeCloseTo(-0.2, 9);
	});

	it('interpolates the view pitch between the two samples', () => {
		const h = new PoseHistory(8);
		h.record(1000, 1, pose(0, { pitch: -20 }));
		h.record(1020, 2, pose(10, { pitch: 20 }));
		const out = blank();
		h.poseAt(1005, 1020, pose(10, { pitch: 20 }), out);
		expect(out.pitch).toBeCloseTo(-10, 9);
		h.poseAt(1015, 1020, pose(10, { pitch: 20 }), out);
		expect(out.pitch).toBeCloseTo(10, 9);
	});

	it('clamps to the oldest sample, and blends from the newest sample to the current pose', () => {
		const h = new PoseHistory(8);
		const out = blank();
		const cur = pose(100);
		h.poseAt(500, 2000, cur, out);
		expect(out).toEqual(cur);
		h.record(1000, 1, pose(0));
		h.record(1020, 2, pose(10));
		h.poseAt(-5000, 1060, cur, out);
		expect(out).toEqual(pose(0));
		h.poseAt(1000, 1060, cur, out);
		expect(out).toEqual(pose(0));
		// Newer than the newest sample: between it (1020) and the current pose (at now 1060).
		h.poseAt(1040, 1060, cur, out);
		expect(out).toEqual(pose(55));
		h.poseAt(1060, 1060, cur, out);
		expect(out).toEqual(cur);
		h.poseAt(9999, 1060, cur, out);
		expect(out).toEqual(cur);
		// Asked at the very time of the newest sample: the current pose.
		h.poseAt(1020, 1020, cur, out);
		expect(out).toEqual(cur);
	});

	it('is a ring: the oldest samples drop out, clear() empties it', () => {
		const h = new PoseHistory(4);
		for (let i = 0; i < 10; i++) h.record(1000 + i * 10, i, pose(i));
		expect(h.size).toBe(4);
		const out = blank();
		h.poseAt(0, 2000, pose(99), out);
		expect(out.x).toBe(6);
		h.poseAt(1085, 2000, pose(99), out);
		expect(out.x).toBeCloseTo(8.5, 9);
		h.clear();
		expect(h.size).toBe(0);
		h.poseAt(1085, 2000, pose(99), out);
		expect(out.x).toBe(99);
	});

	it('finds a pose by sim tick: the newest at or before it, else the oldest', () => {
		const h = new PoseHistory(8);
		const out = blank();
		h.poseAtTick(5, pose(99), out);
		expect(out.x).toBe(99);
		h.record(1000, 10, pose(1));
		h.record(1016, 11, pose(2));
		h.record(1016, 12, pose(3));
		h.poseAtTick(11, pose(99), out);
		expect(out.x).toBe(2);
		h.poseAtTick(12, pose(99), out);
		expect(out.x).toBe(3);
		h.poseAtTick(50, pose(99), out);
		expect(out.x).toBe(3);
		h.poseAtTick(3, pose(99), out);
		expect(out.x).toBe(1);
	});

	it('turns the yaw the short way and does not interpolate across a teleport-sized jump', () => {
		const h = new PoseHistory(8);
		const out = blank();
		h.record(1000, 1, pose(0, { yaw: 350 }));
		h.record(1020, 2, pose(0, { yaw: 10 }));
		h.poseAt(1010, 1020, pose(0), out);
		expect(((out.yaw % 360) + 360) % 360).toBeCloseTo(0, 9);
		h.record(1040, 3, pose(5000, { yaw: 10 }));
		h.poseAt(1030, 1040, pose(5000), out);
		expect(out.x).toBe(5000);
	});
});

describe('lag compensation in the game', () => {
	const SPEED = INF_INFECTED_SPEED;
	const hits = (r: { events: unknown[] }) => r.events.filter((e) => (e as { e: string }).e === 'hit').length;
	/**
	 * Playing with the LMG: Patient Zero (1) crosses along +x at SPEED through
	 * y 600, in profile to survivor 2, who shoots from y 350.
	 * `stepMs`: how often the game is updated (the server: every 31.25 ms).
	 */
	function crossing(stepMs = INF_STEP_MS) {
		const g = kitPlaying([1, 2, 3], { round: 3 });
		const t0 = g.clock.now;
		const xAt = (t: number) => -400 + (SPEED * (t - t0)) / 1000;
		g.put(2, { x: 0, y: 350 });
		g.put(3, { x: 1000, y: -1000 });
		const run = (ms: number) => {
			const end = g.clock.now + ms;
			while (g.clock.now < end) {
				g.put(1, { x: xAt(g.clock.now + stepMs), y: 600 });
				g.advance(stepMs, stepMs);
			}
		};
		/** The middle of the leg (12 up) of Patient Zero standing at `x`: 4 + 2 units of hit box either side. */
		const leg = (x: number): Vec3 => playerPoint({ x, y: 600, z: 0, yaw: 0, ducked: false, hunched: true }, 'shinR', 0.5);
		return { g, xAt, run, leg };
	}
	/**
	 * One shot after `ms` of crossing: at the pose of `rewind` ms ago shifted by `off` along the path,
	 * from straight in front of that pose (square to the path, so only the 12 units of the leg count).
	 */
	function shot(ms: number, rewind: number, off: number, fire: { rewindMs?: number } = { rewindMs: rewind }, stepMs?: number): number {
		const c = crossing(stepMs);
		c.run(ms);
		const x = c.xAt(c.g.clock.now - rewind) + off;
		c.g.put(2, { x, y: 350 });
		return hits(c.g.fireAt(2, c.leg(x), fire));
	}

	it('rewindMs tests the pose of that long ago, between two history samples', () => {
		for (const rewind of [0, 37.3, 100.4, 115.625, 211.9, 390]) {
			expect(shot(1200, rewind, 0), `rewind ${rewind}`).toBe(1);
			// Two body widths ahead of and behind the seen pose: nothing there.
			expect(shot(1200, rewind, 66), `rewind ${rewind} ahead`).toBe(0);
			expect(shot(1200, rewind, -66), `rewind ${rewind} behind`).toBe(0);
			// Even just outside the leg: 4 units of leg, 2 of pad, and a miss at 8.
			expect(shot(1200, rewind, 5), `rewind ${rewind} +5`).toBe(1);
			expect(shot(1200, rewind, -5), `rewind ${rewind} -5`).toBe(1);
			expect(shot(1200, rewind, 8), `rewind ${rewind} +8`).toBe(0);
			expect(shot(1200, rewind, -8), `rewind ${rewind} -8`).toBe(0);
		}
		// Without the rewind the same aim is 30 units behind the target.
		expect(shot(1200, 115.625, 0, {})).toBe(0);
	});

	it('interpolating removes the rounding of a 32 Hz update: a leg in profile is hit at any rewind', () => {
		// Two sim steps per update: samples 31.25 ms (8.3 units at this speed) apart, the leg box is 12 wide.
		for (const rewind of [102, 109, 116, 123, 130, 137, 144, 151]) {
			expect(shot(1250, rewind, 0, { rewindMs: rewind }, INF_STEP_MS * 2), `rewind ${rewind}`).toBe(1);
		}
	});

	it('uses the observed pose for the first tick of a two-tick update', () => {
		const { g, leg } = crossing();
		g.put(1, { x: 0, y: 600 });
		g.advance(INF_STEP_MS);
		const tick = g.game.tick + 1;
		g.put(1, { x: 60, y: 600 });
		g.advance(2 * INF_STEP_MS, 2 * INF_STEP_MS);
		expect(g.game.tick).toBe(tick + 1);
		g.put(2, { x: 60, y: 350 });
		expect(hits(g.fireAt(2, leg(60), { tick }))).toBe(1);
	});

	it('records each player once per observation, even when eight sim ticks catch up', () => {
		const c = crossing(INF_STEP_MS * 2);
		const record = vi.spyOn(PoseHistory.prototype, 'record');
		try {
			c.run(INF_STEP_MS * 2);
			c.g.advance(125, 125);
			expect(record.mock.calls.map(([at]) => at)).toEqual([
				...Array<number>(3).fill(c.g.clock.now - 125),
				...Array<number>(3).fill(c.g.clock.now)
			]);
		} finally {
			record.mockRestore();
		}
	});

	it('keeps the full 400 ms rewind at 32 Hz, even after a 125 ms update gap', () => {
		const c = crossing(INF_STEP_MS * 2);
		c.run(1000);
		const gap = 125;
		c.g.put(1, { x: c.xAt(c.g.clock.now + gap), y: 600 });
		c.g.advance(gap, gap);
		c.run(125);
		const x = c.xAt(c.g.clock.now - INF_HISTORY_MS);
		c.g.put(2, { x, y: 350 });
		expect(hits(c.g.fireAt(2, c.leg(x), { rewindMs: INF_HISTORY_MS }))).toBe(1);
	});

	it('the rewind is clamped to INF_HISTORY_MS', () => {
		// 5 s asked: the pose of 400 ms ago is tested, not an older one and not the current one.
		expect(shot(2000, INF_HISTORY_MS, 0, { rewindMs: 5000 })).toBe(1);
		expect(shot(2000, 1500, 0, { rewindMs: 5000 })).toBe(0);
		expect(shot(2000, 0, 0, { rewindMs: 5000 })).toBe(0);
		// A rewind that is not a number falls back to the tick; a negative one is the current pose.
		expect(shot(2000, 0, 0, { rewindMs: NaN })).toBe(1);
		expect(shot(2000, 0, 0, { rewindMs: -200 })).toBe(1);
	});

	it('never rewinds past a teleport: a fall puts the target at a spawn and the old pose is gone', () => {
		const g = kitPlaying([1, 2, 3], { round: 3 });
		const a = { x: -200, y: 0 };
		g.put(1, a);
		g.put(2, { x: -200, y: -400 });
		g.put(3, { x: 1000, y: 1000 });
		g.advance(1500);
		const tickBefore = g.game.tick;
		g.put(1, { ...a, z: -1000 });
		g.advance(INF_STEP_MS);
		const fall = g.of('spawn').at(-1)!;
		expect(fall).toMatchObject({ id: 1, reason: 'fall' });
		const spawn = { x: fall.x, y: fall.y, z: fall.z };
		g.put(1, spawn);
		g.advance(INF_STEP_MS * 3);
		g.put(2, { x: spawn.x, y: spawn.y + 300, z: spawn.z });
		g.advance(INF_STEP_MS);
		const chest = (p: { x: number; y: number; z?: number }): Vec3 =>
			playerPoint({ x: p.x, y: p.y, z: p.z ?? 0, yaw: fall.yaw, ducked: false, hunched: true }, 'ribs');
		// 300 ms back the target stood at `a`; the shooter is next to the spawn now, so only the spawn pose can be hit.
		expect(hits(g.fireAt(2, chest(spawn), { rewindMs: 300 }))).toBe(1);
		g.advance(INF_STEP_MS * 8);
		g.put(2, { x: -200, y: -400 });
		g.advance(INF_STEP_MS);
		expect(hits(g.fireAt(2, chest(a), { rewindMs: 300 }))).toBe(0);
		g.advance(INF_STEP_MS * 8);
		expect(hits(g.fireAt(2, chest(a), { tick: tickBefore }))).toBe(0);
		// Nor a pose in between the two.
		g.advance(INF_STEP_MS * 8);
		expect(hits(g.fireAt(2, chest({ x: (a.x + spawn.x) / 2, y: (a.y + spawn.y) / 2 }), { rewindMs: 100 }))).toBe(0);
	});

	it('drops the old pose on a flagged client teleport shorter than the distance guard', () => {
		const g = kitPlaying([1, 2, 3], { round: 3 });
		g.put(1, { x: -200, y: 0 });
		g.put(2, { x: -200, y: -400 });
		g.advance(500);
		g.game.setPlayerPos(1, { x: 100, y: 0, z: 0, yaw: 0, ducked: false }, true);
		g.advance(INF_STEP_MS);
		const oldChest = playerPoint({ x: -200, y: 0, z: 0, yaw: 0, ducked: false, hunched: true }, 'ribs');
		expect(hits(g.fireAt(2, oldChest, { rewindMs: 200 }))).toBe(0);
	});

	it('never uses the pose of an earlier stay: a player who leaves and rejoins starts a fresh history', () => {
		const g = kitPlaying([1, 2, 3], { round: 3 });
		const a = { x: -200, y: 0 };
		g.put(1, a);
		g.put(2, { x: -200, y: -400 });
		g.put(3, { x: 1000, y: 1000 });
		g.advance(1500);
		// Player 3 becomes the second infected so the round goes on while Patient Zero is away.
		g.put(1, { x: 960, y: 1000 });
		g.advance(INF_STEP_MS);
		g.fireAt(1, { x: 1000, y: 1000, z: 64 });
		expect(g.game.playerView(3)!.team).toBe('infected');
		g.put(1, a);
		g.advance(500);
		const rejoinTick = g.game.tick;
		g.game.syncPlayers([2, 3], g.clock.now);
		g.game.syncPlayers([1, 2, 3], g.clock.now);
		const join = g.of('spawn', g.game.update(g.clock.now)).find((s) => s.id === 1)!;
		expect(join).toMatchObject({ reason: 'join', team: 'infected' });
		expect(Math.hypot(join.x - a.x, join.y - a.y)).toBeGreaterThan(500);
		g.put(1, { x: join.x, y: join.y, z: join.z });
		g.advance(INF_STEP_MS);
		const chest = (p: { x: number; y: number }): Vec3 => playerPoint({ x: p.x, y: p.y, z: 0, yaw: 0, ducked: false, hunched: true }, 'ribs');
		// The tick of the rejoin itself: its history sample was the pose of the earlier stay.
		expect(hits(g.fireAt(2, chest(a), { tick: rejoinTick }))).toBe(0);
		g.advance(200);
		expect(hits(g.fireAt(2, chest(a), { rewindMs: 400 }))).toBe(0);
		expect(KIT_SPAWNS.some((s) => s.pos.x === join.x && s.pos.y === join.y)).toBe(true);
	});

	it('the history keeps ducked: a shot at where the head was while the target stood', () => {
		const g = kitPlaying([1, 2, 3], { round: 3 });
		g.put(1, { x: 0, y: 0 });
		g.put(2, { x: 0, y: -400 });
		g.put(3, { x: 1000, y: 1000 });
		g.advance(1000);
		g.put(1, { x: 0, y: 0, ducked: true });
		g.advance(200);
		const standing = playerPoint({ x: 0, y: 0, z: 0, yaw: 0, ducked: false, hunched: true }, 'head');
		const hit = (r: { events: unknown[] }) => r.events.find((e) => (e as { e: string }).e === 'hit');
		// Now ducked: the standing head is empty air. 300 ms ago the target stood.
		expect(hit(g.fireAt(2, standing))).toBeUndefined();
		g.advance(100);
		expect(hit(g.fireAt(2, standing, { rewindMs: 300 }))).toMatchObject({ targetId: 1, head: true });
	});

	it('melee rewinds too: a knife swing reaches where the survivor was seen, not where they are now', () => {
		const reach = WEAPONS.knife.range;
		/** Survivor 2 runs away from Patient Zero (knife out, at the origin) along +x at 250 u/s for `ms`. */
		const chase = (ms: number) => {
			const g = kitPlaying([1, 2, 3], { round: 3 });
			const t0 = g.clock.now;
			const xAt = (t: number) => 20 + (250 * (t - t0)) / 1000;
			g.put(1, { x: 0, y: 0 });
			g.put(3, { x: 1000, y: -1000 });
			g.game.selectWeapon(1, 'knife', g.clock.now);
			const end = g.clock.now + ms;
			while (g.clock.now < end) {
				g.put(2, { x: xAt(g.clock.now + INF_STEP_MS), y: 0 });
				g.advance(INF_STEP_MS, INF_STEP_MS);
			}
			return { g, now: xAt(g.clock.now), seen: xAt(g.clock.now - 300) };
		};
		const turned = (g: ReturnType<typeof chase>['g']) => g.game.playerView(2)!.team === 'infected';
		const a = chase(480);
		// The back of the survivor is 7.5 behind the feet: out of reach now, in reach 300 ms ago.
		expect(a.now - 7.5).toBeGreaterThan(reach + 40);
		expect(a.seen - 7.5).toBeLessThan(reach - 5);
		expect(a.g.fireAt(1, { x: 500, y: 0, z: 64 }).ok).toBe(true);
		expect(turned(a.g)).toBe(false);
		// With the rewind: a swing to the side still misses, a swing at the seen pose infects.
		const b = chase(480);
		b.g.fireAt(1, { x: 0, y: 500, z: 64 }, { rewindMs: 300 });
		expect(turned(b.g)).toBe(false);
		const c = chase(480);
		c.g.fireAt(1, { x: 500, y: 0, z: 64 }, { rewindMs: 300 });
		expect(turned(c.g)).toBe(true);
		expect(c.g.of('infect').at(-1)).toMatchObject({ id: 2, by: 1, method: 'claws' });
	});
});
