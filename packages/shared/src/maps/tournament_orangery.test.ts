import { describe, expect, it } from 'vitest';
import { buildCollisionWorld } from '../collision/world.ts';
import { mapCvars, TOURNAMENT_CVARS } from '../modes/index.ts';
import { HULL_MAX, HULL_MIN, IN_DUCK, IN_JUMP, type PlayerState } from '../movement/api.ts';
import { createPlayer, playerMove } from '../movement/gamemovement.ts';
import type { Vec3 } from '../types.ts';
import { TICK_INTERVAL } from '../units.ts';
import { getMap, mapsForMode } from './index.ts';
import { brushBounds, dirXY, type Box3, type BoxBrush } from './helpers.ts';
import { COVER_TOP, HALF_X, HALF_Y, mirrorBox, RAIL_TOP, RIB_BOTTOM, ROOF_BOTTOM, ROOF_TOP, tournament_orangery as m } from './tournament_orangery.ts';

/** Same as SPAWN_CLEARANCE in ./index.ts (spawns are authored on floor tops and lifted at load). */
const CLEARANCE = 0.25;
const HULL_H = HULL_MAX.z;

const trn = m.tournament!;
const world = buildCollisionWorld(m);
const boxes = m.brushes.filter((b): b is BoxBrush => b.type === 'box');
const solids = boxes.filter((b) => b.solid !== false);
const cvars = mapCvars(m);

const overlaps = (a: Box3, b: Box3, eps = 0.01) =>
	a.min.x < b.max.x - eps &&
	b.min.x < a.max.x - eps &&
	a.min.y < b.max.y - eps &&
	b.min.y < a.max.y - eps &&
	a.min.z < b.max.z - eps &&
	b.min.z < a.max.z - eps;
const inBox = (p: Vec3, b: Box3) =>
	p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
/** Strictly inside a solid box (point sample). */
const inSolid = (p: Vec3) =>
	solids.some((b) => p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z);
const key = (b: BoxBrush) => `${b.material}|${b.solid === false ? 0 : 1}|${b.min.x},${b.min.y},${b.min.z}|${b.max.x},${b.max.y},${b.max.z}`;
const mirrorSpawn = (s: { pos: Vec3; yaw: number }) => ({ pos: { x: -s.pos.x, y: -s.pos.y, z: s.pos.z }, yaw: (((s.yaw + 180) % 360) + 360) % 360 });
const normYaw = (y: number) => ((y % 360) + 360) % 360;

function standsFree(p: Vec3): { solid: boolean; ground: boolean } {
	const t = world.trace(p, p, HULL_MIN, HULL_MAX);
	const down = world.trace(p, { ...p, z: p.z - 2 }, HULL_MIN, HULL_MAX);
	return { solid: t.startsolid, ground: down.fraction < 1 && down.plane.normal.z >= 0.7 };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface BotRun {
	/** Lowest / highest origin z seen. */
	minZ: number;
	maxZ: number;
	/** Highest hull top seen. */
	maxHead: number;
	/** Top horizontal speed seen. */
	maxSpeed: number;
	/** First tick whose origin was inside `forbid`, or -1. */
	entered: number;
	/** Horizontal extent of the origin. */
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

/**
 * Real playerMove with the tournament cvars: hold jump (auto bhop), air
 * strafe with a slow yaw sweep, change heading at random, duck in the air
 * at random (crouch jumps). Starts with `speed` along `yaw`.
 */
function bot(start: Vec3, yaw0: number, speed: number, secs: number, seed: number, forbid: Box3): BotRun {
	const r = rng(seed);
	const p: PlayerState = createPlayer({ ...start });
	const d = dirXY(yaw0);
	p.velocity = { x: d.x * speed, y: d.y * speed, z: 0 };
	let yaw = yaw0;
	let side = 1;
	const run: BotRun = { minZ: Infinity, maxZ: -Infinity, maxHead: -Infinity, maxSpeed: 0, entered: -1, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
	for (let tick = 0; tick < secs / TICK_INTERVAL; tick++) {
		if (r() < 0.02) yaw += (r() - 0.5) * 240;
		if (r() < 0.05) side = -side;
		yaw += side * 2.5;
		const duck = !p.onGround && r() < 0.6 ? IN_DUCK : 0;
		playerMove(world, p, { pitch: 0, yaw, forwardmove: r() < 0.3 ? 0 : 450, sidemove: side * 450, buttons: IN_JUMP | duck }, cvars, TICK_INTERVAL);
		const o = p.origin;
		run.minZ = Math.min(run.minZ, o.z);
		run.maxZ = Math.max(run.maxZ, o.z);
		run.maxHead = Math.max(run.maxHead, o.z + (p.ducked ? 54 : HULL_H));
		run.maxSpeed = Math.max(run.maxSpeed, Math.hypot(p.velocity.x, p.velocity.y));
		run.minX = Math.min(run.minX, o.x);
		run.maxX = Math.max(run.maxX, o.x);
		run.minY = Math.min(run.minY, o.y);
		run.maxY = Math.max(run.maxY, o.y);
		if (run.entered < 0 && inBox(o, forbid)) run.entered = tick;
	}
	return run;
}

describe('tournament_orangery', () => {
	it('is the open tournament map in the rotation with the tournament physics (plain bhop)', () => {
		expect(getMap('tournament_orangery')).toBe(m);
		expect(mapsForMode('tournament')).toContain(m);
		expect(m.kind).toBe('tournament');
		expect(m.layout).toBe('open');
		expect(mapCvars(m)).toEqual(TOURNAMENT_CVARS);
		expect(cvars.sv_air_speed_cap).toBe(0);
		for (const z of m.zones) expect(z.type).toBe('teleport');
		expect(m.hns).toBeUndefined();
		expect(m.zombies).toBeUndefined();
	});

	it('every brush is a box with a theme material; glass roof and rails use glass materials', () => {
		expect(boxes).toHaveLength(m.brushes.length);
		for (const b of boxes) {
			expect(m.theme.materials[b.material], b.material).toBeDefined();
			expect(b.max.x).toBeGreaterThan(b.min.x);
			expect(b.max.y).toBeGreaterThan(b.min.y);
			expect(b.max.z).toBeGreaterThan(b.min.z);
		}
		const roof = boxes.filter((b) => b.min.z === ROOF_BOTTOM && b.max.z === ROOF_TOP);
		expect(roof).toHaveLength(1);
		expect(m.theme.materials[roof[0]!.material]!.glass).toBe(true);
		expect(m.theme.materials[roof[0]!.material]!.edgeColor).toBeDefined();
		const known = ['aurora', 'embers', 'clouds', 'gridFloor', 'lavaSea', 'snowFloor'];
		for (const e of m.theme.effects) expect(known).toContain(e.type);
		expect(m.theme.fogFar).toBeGreaterThan(m.theme.fogNear);
	});

	it('solid boxes never intersect', () => {
		for (let i = 0; i < solids.length; i++)
			for (let j = i + 1; j < solids.length; j++) expect(overlaps(solids[i]!, solids[j]!), `${key(solids[i]!)} × ${key(solids[j]!)}`).toBe(false);
	});

	it('is point-symmetric: every brush has a twin at (−x, −y) with the same size and material', () => {
		const count = new Map<string, number>();
		for (const b of boxes) count.set(key(b), (count.get(key(b)) ?? 0) + 1);
		for (const b of boxes) {
			const t = mirrorBox(b);
			expect(count.get(key(t)) ?? 0, `no twin for ${key(b)}`).toBe(count.get(key(b)));
		}
		// The mirror really is a point mirror (an involution that flips x and y).
		const b = boxes[5]!;
		expect(key(mirrorBox(mirrorBox(b)))).toBe(key(b));
	});

	it('duel spawns mirror each other and face each other', () => {
		const [a, b] = trn.duelSpawns;
		const ma = mirrorSpawn(a);
		expect(ma.pos.x).toBeCloseTo(b.pos.x, 6);
		expect(ma.pos.y).toBeCloseTo(b.pos.y, 6);
		expect(ma.pos.z).toBeCloseTo(b.pos.z, 6);
		expect(normYaw(ma.yaw)).toBeCloseTo(normYaw(b.yaw), 6);
		const da = dirXY(a.yaw);
		const db = dirXY(b.yaw);
		const ab = { x: b.pos.x - a.pos.x, y: b.pos.y - a.pos.y };
		expect(da.x * ab.x + da.y * ab.y, 'A faces B').toBeGreaterThan(0.99 * Math.hypot(ab.x, ab.y));
		expect(-(db.x * ab.x + db.y * ab.y), 'B faces A').toBeGreaterThan(0.99 * Math.hypot(ab.x, ab.y));
		// The deck spawns are point-symmetric as a set too.
		for (const s of trn.deckSpawns) {
			const t = mirrorSpawn(s);
			expect(trn.deckSpawns.some((u) => Math.hypot(u.pos.x - t.pos.x, u.pos.y - t.pos.y, u.pos.z - t.pos.z) < 1e-6)).toBe(true);
		}
	});

	it('duel spawns stand free on the floor inside the arena; deck spawns on the glass inside the deck', () => {
		for (const [i, s] of trn.duelSpawns.entries()) {
			expect(s.pos.z, `duel spawn ${i} lifted`).toBeCloseTo(CLEARANCE, 6);
			const r = standsFree(s.pos);
			expect(r.solid, `duel spawn ${i} starts solid`).toBe(false);
			expect(r.ground, `duel spawn ${i} has no ground`).toBe(true);
			expect(inBox(s.pos, trn.arena), `duel spawn ${i} outside the arena`).toBe(true);
		}
		expect(trn.deckSpawns.length).toBeGreaterThanOrEqual(8);
		for (const [i, s] of trn.deckSpawns.entries()) {
			expect(s.pos.z, `deck spawn ${i} lifted`).toBeCloseTo(ROOF_TOP + CLEARANCE, 6);
			const r = standsFree(s.pos);
			expect(r.solid, `deck spawn ${i} starts solid`).toBe(false);
			expect(r.ground, `deck spawn ${i} has no ground`).toBe(true);
			expect(inBox(s.pos, trn.deck), `deck spawn ${i} outside the deck`).toBe(true);
			// Standing on glass.
			const down = world.trace(s.pos, { ...s.pos, z: s.pos.z - 2 }, HULL_MIN, HULL_MAX);
			expect(down.fraction).toBeLessThan(1);
			for (let j = i + 1; j < trn.deckSpawns.length; j++) {
				const t = trn.deckSpawns[j]!;
				expect(Math.hypot(s.pos.x - t.pos.x, s.pos.y - t.pos.y), `deck spawns ${i}, ${j}`).toBeGreaterThanOrEqual(256);
			}
		}
		// The schema's fallback spawn and spawn list are the deck spawns.
		expect(m.spawns).toBe(trn.deckSpawns);
		expect(m.spawn).toBe(trn.deckSpawns[0]);
		// The arena and the deck are disjoint, the deck above the arena.
		expect(overlaps(trn.arena, trn.deck)).toBe(false);
		expect(trn.deck.min.z).toBeGreaterThanOrEqual(trn.arena.max.z);
		const ax = trn.arena.max.x - trn.arena.min.x;
		const ay = trn.arena.max.y - trn.arena.min.y;
		expect(ax).toBeGreaterThanOrEqual(1200);
		expect(ax).toBeLessThanOrEqual(1800);
		expect(ay).toBeGreaterThanOrEqual(800);
		expect(ay).toBeLessThanOrEqual(1200);
	});

	it('the hall is sealed: floor, walls and the glass roof leave no gap (point samples every 8 units, 8 outside every face)', () => {
		const STEP = 8;
		const OUT = 8;
		const misses: string[] = [];
		const check = (p: Vec3, face: string) => {
			if (!inSolid(p)) misses.push(`${face} (${p.x}, ${p.y}, ${p.z})`);
		};
		for (let x = -HALF_X + STEP / 2; x < HALF_X; x += STEP)
			for (let y = -HALF_Y + STEP / 2; y < HALF_Y; y += STEP) {
				check({ x, y, z: -OUT }, 'floor');
				check({ x, y, z: ROOF_BOTTOM + OUT }, 'roof');
			}
		for (let z = STEP / 2 - 0; z < ROOF_BOTTOM; z += STEP) {
			for (let x = -HALF_X + STEP / 2; x < HALF_X; x += STEP) {
				check({ x, y: HALF_Y + OUT, z }, 'north wall');
				check({ x, y: -HALF_Y - OUT, z }, 'south wall');
			}
			for (let y = -HALF_Y + STEP / 2; y < HALF_Y; y += STEP) {
				check({ x: HALF_X + OUT, y, z }, 'east wall');
				check({ x: -HALF_X - OUT, y, z }, 'west wall');
			}
		}
		expect(misses.slice(0, 10)).toEqual([]);
		// The roof is all glass.
		const glass = solids.filter((b) => m.theme.materials[b.material]!.glass);
		for (let x = -HALF_X + 4; x < HALF_X; x += 64)
			for (let y = -HALF_Y + 4; y < HALF_Y; y += 64) {
				const p = { x, y, z: (ROOF_BOTTOM + ROOF_TOP) / 2 };
				expect(glass.some((b) => inBox(p, b)), `roof not glass at (${x}, ${y})`).toBe(true);
			}
	});

	it('the deck is walled in up to the clip (point samples outside every deck edge)', () => {
		const misses: string[] = [];
		for (let z = ROOF_TOP + 4; z < RAIL_TOP + 200; z += 8) {
			for (let x = -HALF_X + 4; x < HALF_X; x += 8) {
				for (const y of [HALF_Y + 8, -HALF_Y - 8]) if (!inSolid({ x, y, z })) misses.push(`(${x}, ${y}, ${z})`);
			}
			for (let y = -HALF_Y + 4; y < HALF_Y; y += 8) {
				for (const x of [HALF_X + 8, -HALF_X - 8]) if (!inSolid({ x, y, z })) misses.push(`(${x}, ${y}, ${z})`);
			}
		}
		expect(misses.slice(0, 10)).toEqual([]);
	});

	it('hull traces out of the hall stop inside it (grid of points, ±x, ±y, +z)', () => {
		const far = 4096;
		for (const z of [CLEARANCE + 2, 120, 260, ROOF_BOTTOM - HULL_H - 4]) {
			for (let x = -HALF_X + 64; x < HALF_X; x += 192)
				for (let y = -HALF_Y + 64; y < HALF_Y; y += 192) {
					const p = { x, y, z };
					if (world.trace(p, p, HULL_MIN, HULL_MAX).startsolid) continue;
					for (const [dx, dy, dz] of [
						[far, 0, 0],
						[-far, 0, 0],
						[0, far, 0],
						[0, -far, 0],
						[0, 0, far]
					] as const) {
						const t = world.trace(p, { x: x + dx, y: y + dy, z: z + dz }, HULL_MIN, HULL_MAX);
						expect(t.fraction, `escape from (${x}, ${y}, ${z}) towards (${dx}, ${dy}, ${dz})`).toBeLessThan(1);
						expect(Math.abs(t.endpos.x), 'stays inside x').toBeLessThanOrEqual(HALF_X - 16 + 0.1);
						expect(Math.abs(t.endpos.y), 'stays inside y').toBeLessThanOrEqual(HALF_Y - 16 + 0.1);
						expect(t.endpos.z + HULL_H, 'stays under the roof').toBeLessThanOrEqual(ROOF_BOTTOM + 0.1);
					}
				}
		}
	});

	it('hull traces down from the deck stop on the glass (spawns and edge points)', () => {
		const pts: Vec3[] = trn.deckSpawns.map((s) => s.pos);
		for (let x = -HALF_X + 16; x <= HALF_X - 16; x += 32) for (const y of [HALF_Y - 16, -HALF_Y + 16]) pts.push({ x, y, z: ROOF_TOP + 40 });
		for (let y = -HALF_Y + 16; y <= HALF_Y - 16; y += 32) for (const x of [HALF_X - 16, -HALF_X + 16]) pts.push({ x, y, z: ROOF_TOP + 40 });
		for (const p of pts) {
			if (world.trace(p, p, HULL_MIN, HULL_MAX).startsolid) continue; // lamp posts in the corners
			const t = world.trace(p, { ...p, z: -1000 }, HULL_MIN, HULL_MAX);
			expect(t.endpos.z, `fell through at (${p.x}, ${p.y})`).toBeGreaterThanOrEqual(ROOF_TOP - 0.1);
			// Outward traces from the deck edge stop at the rail.
			for (const [dx, dy] of [
				[2048, 0],
				[-2048, 0],
				[0, 2048],
				[0, -2048]
			] as const) {
				const o = world.trace({ ...p, z: ROOF_TOP + 1 }, { x: p.x + dx, y: p.y + dy, z: ROOF_TOP + 1 }, HULL_MIN, HULL_MAX);
				expect(Math.abs(o.endpos.x)).toBeLessThanOrEqual(HALF_X - 16 + 0.1);
				expect(Math.abs(o.endpos.y)).toBeLessThanOrEqual(HALF_Y - 16 + 0.1);
			}
		}
	});

	it('spectators bhopping and crouch-jumping on the deck never leave it (playerMove, every deck spawn, rails and corners)', () => {
		const starts: Array<{ p: Vec3; yaw: number }> = trn.deckSpawns.map((s) => ({ p: s.pos, yaw: s.yaw }));
		// Along the rails, running into them, and into the corners.
		for (const x of [-600, 0, 600]) {
			starts.push({ p: { x, y: HALF_Y - 40, z: ROOF_TOP + CLEARANCE }, yaw: 90 });
			starts.push({ p: { x, y: -HALF_Y + 40, z: ROOF_TOP + CLEARANCE }, yaw: -90 });
		}
		for (const y of [-400, 0, 400]) {
			starts.push({ p: { x: HALF_X - 40, y, z: ROOF_TOP + CLEARANCE }, yaw: 0 });
			starts.push({ p: { x: -HALF_X + 40, y, z: ROOF_TOP + CLEARANCE }, yaw: 180 });
		}
		for (const [x, y, yaw] of [
			[600, 380, 35],
			[-600, 380, 145],
			[-600, -380, -145],
			[600, -380, -35]
		] as const)
			starts.push({ p: { x, y, z: ROOF_TOP + CLEARANCE }, yaw });
		let fastest = 0;
		let highest = -Infinity;
		for (const [i, s] of starts.entries()) {
			for (const speed of [250, 1200, 3000]) {
				const r = bot(s.p, s.yaw, speed, 6, 1000 + i * 7 + speed, trn.arena);
				fastest = Math.max(fastest, r.maxSpeed);
				highest = Math.max(highest, r.maxZ);
				const what = `start ${i} at ${speed} u/s`;
				expect(r.entered, `${what}: entered the arena`).toBe(-1);
				expect(r.minZ, `${what}: dropped below the glass`).toBeGreaterThanOrEqual(ROOF_TOP - 0.1);
				expect(r.maxZ, `${what}: rose near the rail top`).toBeLessThan(RAIL_TOP - 24);
				expect(r.minX, what).toBeGreaterThanOrEqual(-HALF_X + 16 - 0.1);
				expect(r.maxX, what).toBeLessThanOrEqual(HALF_X - 16 + 0.1);
				expect(r.minY, what).toBeGreaterThanOrEqual(-HALF_Y + 16 - 0.1);
				expect(r.maxY, what).toBeLessThanOrEqual(HALF_Y - 16 + 0.1);
			}
		}
		expect(fastest, 'the bot really moved fast').toBeGreaterThan(1000);
		expect(highest, 'the bot really crouch-jumped').toBeGreaterThan(ROOF_TOP + 60);
	});

	it('duelists jumping from the highest cover stay under the roof and never reach the deck', () => {
		// The highest tops in the hall (below the ribs, not reaching the roof).
		const hall = solids.filter(
			(b) => b.max.z < RIB_BOTTOM && b.max.z > 0 && Math.abs(b.min.x) <= HALF_X && Math.abs(b.max.x) <= HALF_X && Math.abs(b.min.y) <= HALF_Y && Math.abs(b.max.y) <= HALF_Y
		);
		const highest = Math.max(...hall.map((b) => b.max.z));
		expect(highest, 'nothing in the hall lets a jump reach the ribs').toBeLessThan(RIB_BOTTOM - HULL_H - 70);
		const cover = hall.filter((b) => b.max.z === COVER_TOP);
		expect(cover.length).toBeGreaterThanOrEqual(2);
		// Every top at or above the balustrade: standing on it, crouch-bhop at speed in every direction.
		const tops = hall.filter((b) => b.max.z >= 128);
		let maxHead = -Infinity;
		let maxFeet = -Infinity;
		let n = 0;
		for (const b of tops) {
			const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.max.z + CLEARANCE };
			if (world.trace(c, c, HULL_MIN, HULL_MAX).startsolid) continue;
			for (const yaw of [0, 90, 180, 270]) {
				for (const speed of [0, 600, 2000]) {
					const r = bot(c, yaw, speed, 3, n++, trn.deck);
					maxHead = Math.max(maxHead, r.maxHead);
					maxFeet = Math.max(maxFeet, r.maxZ);
					expect(r.entered, `from ${b.material} top ${b.max.z}: reached the deck`).toBe(-1);
					expect(r.maxZ + HULL_H, 'under the roof').toBeLessThanOrEqual(ROOF_BOTTOM + 0.1);
				}
			}
		}
		expect(n).toBeGreaterThan(0);
		expect(maxFeet, 'the bot really jumped from the top cover').toBeGreaterThan(COVER_TOP + 60);
		// The canopy jump: from the highest cover the head stays well under the ribs.
		expect(maxHead).toBeLessThan(RIB_BOTTOM - 40);
		// Duel spawns, bhopping around the hall for a while.
		for (const [i, s] of trn.duelSpawns.entries())
			for (const speed of [250, 1500]) {
				const r = bot(s.pos, s.yaw, speed, 10, 50 + i * 3 + speed, trn.deck);
				expect(r.entered, `duelist ${i}: reached the deck`).toBe(-1);
				expect(r.maxZ + HULL_H, 'under the roof').toBeLessThanOrEqual(ROOF_BOTTOM + 0.1);
				expect(r.minZ).toBeGreaterThanOrEqual(-0.1);
			}
	});

	it('the roof is high enough for jumps and sightlines over all cover', () => {
		expect(ROOF_BOTTOM).toBeGreaterThanOrEqual(384);
		const cover = solids.filter((b) => b.max.z < RIB_BOTTOM && Math.abs(b.max.x) <= HALF_X && Math.abs(b.max.y) <= HALF_Y && Math.abs(b.min.x) <= HALF_X && Math.abs(b.min.y) <= HALF_Y);
		// Standable cover (not wall lanterns) stays ≤ COVER_TOP; the ribs are > 3 jumps above it.
		const standable = cover.filter((b) => m.theme.materials[b.material] && b.material !== 'lantern');
		expect(Math.max(...standable.map((b) => b.max.z))).toBe(COVER_TOP);
		expect(RIB_BOTTOM - COVER_TOP).toBeGreaterThan(HULL_H + 66 + 100);
		// The spawn-to-spawn line is blocked (no free snipe at round start).
		const [a, b] = trn.duelSpawns;
		const eye = (p: Vec3) => ({ x: p.x, y: p.y, z: p.z + 64 });
		const t = world.trace(eye(a.pos), eye(b.pos), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
		expect(t.fraction).toBeLessThan(1);
	});

	it('the garden outside stays outside the walls or under the floor', () => {
		for (const br of m.brushes) {
			const bb = brushBounds(br);
			const inside = bb.min.x < HALF_X && bb.max.x > -HALF_X && bb.min.y < HALF_Y && bb.max.y > -HALF_Y;
			if (!inside) continue;
			// Inside the walls' footprint: floor (≤ 0), the hall contents, the roof, or deck lamp posts.
			expect(['lawn', 'cypress', 'trunk'].includes(br.material) && bb.min.z < 0 && bb.max.z > 0, `garden brush in the hall: ${br.material}`).toBe(false);
		}
	});
});
