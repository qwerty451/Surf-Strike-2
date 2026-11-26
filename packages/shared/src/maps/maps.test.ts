import { describe, expect, it } from 'vitest';
import { BHOP_CVARS, JUMP_IMPULSE, SURF_CVARS } from '../cvars.ts';
import type { Vec3 } from '../types.ts';
import { DEFAULT_MAP_ID, MAPS, MAP_IDS, SANDBOX, getMap, mapsForMode } from './index.ts';
import { GAME_MODE_IDS, INFECTED_CVARS, isRaceMode, modeOf, tagSpawns, TAG_CVARS } from '../modes/index.ts';
import type { MapDef, Spawn, Zone } from './types.ts';
import {
	boundsOf,
	brushBounds,
	launchStates,
	gapXY,
	rampAngle,
	rampFaceZ,
	simulateTransfer,
	type BoxBrush,
	type Box3,
	type PathNode,
	type RampBrush,
	type SurfTransfer
} from './helpers.ts';
import { AURORA_TRANSFERS } from './surf_aurora.ts';
import { EMBER_TRANSFERS } from './surf_ember.ts';
import { MEADOW_PATH } from './bhop_meadow.ts';
import { CIRCUIT_PATH } from './bhop_circuit.ts';

const ALL: MapDef[] = [...MAPS, SANDBOX];
/** Race-mode maps (surf, bhop): start/end zones, stages/checkpoints. */
const RACE: MapDef[] = ALL.filter((m) => isRaceMode(m.kind));
const TAG: MapDef[] = ALL.filter((m) => m.kind === 'tag');
const GRAVITY = 800;
const HULL_HALF = 16;
const HULL_HEIGHT = 72;
/** Steepest walkable normal z is 0.7 → surf ramps must be steeper than this. */
const MIN_SURF_ANGLE = (Math.acos(0.7) * 180) / Math.PI;

const boxes = (m: MapDef): BoxBrush[] => m.brushes.filter((b): b is BoxBrush => b.type === 'box');
const ramps = (m: MapDef): RampBrush[] => m.brushes.filter((b): b is RampBrush => b.type === 'ramp');
const inBox = (p: Vec3, b: Box3) =>
	p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
const overlaps = (a: Box3, b: Box3, eps = 0.01) =>
	a.min.x < b.max.x - eps &&
	b.min.x < a.max.x - eps &&
	a.min.y < b.max.y - eps &&
	b.min.y < a.max.y - eps &&
	a.min.z < b.max.z - eps &&
	b.min.z < a.max.z - eps;

/** The hull at `s` touches no box and stands on one (top within 1 unit, under the origin). */
function checkStanding(m: MapDef, s: Spawn, what: string) {
	const hull: Box3 = {
		min: { x: s.pos.x - HULL_HALF, y: s.pos.y - HULL_HALF, z: s.pos.z },
		max: { x: s.pos.x + HULL_HALF, y: s.pos.y + HULL_HALF, z: s.pos.z + HULL_HEIGHT }
	};
	for (const b of boxes(m)) expect(overlaps(hull, b), `${m.id} ${what} hull overlaps a box`).toBe(false);
	const ground = boxes(m).find(
		(b) =>
			Math.abs(b.max.z - s.pos.z) <= 1 &&
			s.pos.x >= b.min.x &&
			s.pos.x <= b.max.x &&
			s.pos.y >= b.min.y &&
			s.pos.y <= b.max.y
	);
	expect(ground, `${m.id} ${what} has no ground`).toBeDefined();
}

type ZoneOf<T extends Zone['type']> = Zone & { type: T } & (T extends 'stage' | 'checkpoint' ? { index: number; respawn: Spawn } : unknown);
const zonesOf = <T extends Zone['type']>(m: MapDef, type: T) => m.zones.filter((z): z is ZoneOf<T> => z.type === type);

describe('map registry', () => {
	it('exports the rotation maps in order, original four first', () => {
		expect(MAP_IDS.slice(0, 4)).toEqual(['surf_aurora', 'surf_ember', 'bhop_meadow', 'bhop_circuit']);
		expect(MAPS.map((m) => m.id)).toEqual(MAP_IDS);
		expect(new Set(ALL.map((m) => m.id)).size).toBe(ALL.length);
		expect(DEFAULT_MAP_ID).toBe('surf_aurora');
		expect(MAP_IDS).not.toContain(SANDBOX.id);
	});

	it('getMap finds rotation maps and the sandbox', () => {
		for (const m of ALL) expect(getMap(m.id)).toBe(m);
		expect(getMap('nope')).toBeUndefined();
	});

	it('uses the right physics profile', () => {
		for (const m of RACE) expect(m.cvars).toEqual(m.kind === 'surf' ? SURF_CVARS : BHOP_CVARS);
		for (const m of RACE) expect(modeOf(m).cvars).toBe(m.kind === 'surf' ? SURF_CVARS : BHOP_CVARS);
		expect(modeOf({ kind: 'tag' }).cvars).toBe(TAG_CVARS);
		expect(modeOf({ kind: 'infected' }).cvars).toBe(INFECTED_CVARS);
	});

	it('every map has a known gamemode; mapsForMode partitions the rotation', () => {
		for (const m of ALL) expect(GAME_MODE_IDS).toContain(m.kind);
		expect(GAME_MODE_IDS.flatMap((k) => mapsForMode(k)).length).toBe(MAPS.length);
		expect(mapsForMode('surf').length).toBeGreaterThanOrEqual(2);
		expect(mapsForMode('bhop').length).toBeGreaterThanOrEqual(2);
	});

	it('has at least one tag and one infected map in the rotation', () => {
		expect(mapsForMode('tag').length).toBeGreaterThanOrEqual(1);
		expect(mapsForMode('infected').length).toBeGreaterThanOrEqual(1);
	});
});

describe.each(RACE.map((m) => [m.id, m] as const))('%s', (_id, m) => {
	it('has exactly one start and one end zone', () => {
		expect(zonesOf(m, 'start')).toHaveLength(1);
		expect(zonesOf(m, 'end')).toHaveLength(1);
		expect(overlaps(zonesOf(m, 'start')[0]!, zonesOf(m, 'end')[0]!)).toBe(false);
	});

	it('spawns standing on ground inside the start zone', () => {
		expect(inBox(m.spawn.pos, zonesOf(m, 'start')[0]!)).toBe(true);
		checkStanding(m, m.spawn, 'spawn');
	});

	it('numbers stages / checkpoints contiguously', () => {
		const stages = zonesOf(m, 'stage').map((z) => z.index);
		const cps = zonesOf(m, 'checkpoint').map((z) => z.index);
		if (m.layout === 'staged') {
			expect(cps).toEqual([]);
			expect(stages.length).toBeGreaterThan(0);
			expect([...stages].sort((a, b) => a - b)).toEqual(stages.map((_, i) => i + 2));
		} else {
			expect(stages).toEqual([]);
			expect([...cps].sort((a, b) => a - b)).toEqual(cps.map((_, i) => i + 1));
		}
	});

	it('respawns stand on ground inside their zones, facing travel', () => {
		for (const z of [...zonesOf(m, 'stage'), ...zonesOf(m, 'checkpoint')]) {
			expect(inBox(z.respawn.pos, z), `${z.type} ${z.index} respawn outside zone`).toBe(true);
			checkStanding(m, z.respawn, `${z.type} ${z.index} respawn`);
		}
	});

	it('zones are generous (≥ 128 tall)', () => {
		for (const z of m.zones) {
			if (z.type === 'teleport') continue;
			expect(z.max.z - z.min.z).toBeGreaterThanOrEqual(128 + 16);
		}
	});

	it('every brush material exists in the theme', () => {
		for (const b of m.brushes) expect(m.theme.materials[b.material], b.material).toBeDefined();
	});

	it('has a teleport zone under everything', () => {
		const all = boundsOf(m.brushes);
		const tp = zonesOf(m, 'teleport').find(
			(z) =>
				z.max.z <= all.min.z &&
				z.min.x <= all.min.x &&
				z.min.y <= all.min.y &&
				z.max.x >= all.max.x &&
				z.max.y >= all.max.y
		);
		expect(tp).toBeDefined();
		expect(tp!.to).toBe(m.layout === 'staged' || m.kind === 'bhop' ? 'stage' : 'start');
		expect(m.theme.fogFar).toBeGreaterThanOrEqual(8000);
	});

	it('teleport zones touch no brush, spawn or respawn', () => {
		for (const tp of zonesOf(m, 'teleport')) {
			for (const b of m.brushes) expect(overlaps(tp, brushBounds(b)), 'teleport overlaps a brush').toBe(false);
			for (const s of [m.spawn, ...zonesOf(m, 'stage').map((z) => z.respawn), ...zonesOf(m, 'checkpoint').map((z) => z.respawn)])
				expect(inBox(s.pos, tp)).toBe(false);
		}
	});

	it('box brushes do not intersect each other', () => {
		const bs = boxes(m);
		for (let i = 0; i < bs.length; i++)
			for (let j = i + 1; j < bs.length; j++) expect(overlaps(bs[i]!, bs[j]!), `boxes ${i} and ${j}`).toBe(false);
	});

	it('surf ramps are steeper than the walkable limit', () => {
		for (const r of ramps(m)) expect(rampAngle(r)).toBeGreaterThan(MIN_SURF_ANGLE + 0.4);
	});
});

describe('surf ramp angles', () => {
	// Ramp heights are rounded to 0.001 units, so angles are exact to ~1e-4°.
	it('aurora 50–55°', () => {
		const rs = ramps(getMap('surf_aurora')!);
		expect(rs.length).toBe(12);
		for (const r of rs) {
			expect(rampAngle(r)).toBeGreaterThanOrEqual(50 - 1e-3);
			expect(rampAngle(r)).toBeLessThanOrEqual(55 + 1e-3);
		}
	});
	it('aurora Vs are open at the bottom (no zero-input slide down a closed crease)', () => {
		for (const r of ramps(getMap('surf_aurora')!)) {
			const mid = { x: (r.from.x + r.to.x) / 2, y: 0 };
			// Nothing within a player width (±16, plus margin) of the centre line.
			for (const y of [-24, 0, 24]) expect(rampFaceZ(r, mid.x, y)).toBeNull();
		}
	});
	it('ember 60–65°', () => {
		const rs = ramps(getMap('surf_ember')!);
		for (const r of rs) {
			expect(rampAngle(r)).toBeGreaterThanOrEqual(60 - 1e-6);
			expect(rampAngle(r)).toBeLessThanOrEqual(65 + 1e-6);
		}
	});
	it('ember has an up-ramp and air-turn transfers of 60–90°', () => {
		const rs = ramps(getMap('surf_ember')!);
		expect(rs.some((r) => r.to.z > r.from.z)).toBe(true);
		const yaw = (r: RampBrush) => (Math.atan2(r.to.y - r.from.y, r.to.x - r.from.x) * 180) / Math.PI;
		const turns: number[] = [];
		for (const t of EMBER_TRANSFERS) {
			if (!('ramps' in t.from) || !('ramps' in t.to)) continue;
			let d = Math.abs(yaw(t.to.ramps[0]!) - yaw(t.from.ramps[0]!)) % 360;
			if (d > 180) d = 360 - d;
			turns.push(d);
		}
		expect(turns.filter((d) => d >= 59 && d <= 91).length).toBeGreaterThanOrEqual(2);
	});
});

describe('surf transfers (ballistic, point mass)', () => {
	const cases: Array<[string, SurfTransfer, number[]]> = [
		...AURORA_TRANSFERS.map((t): [string, SurfTransfer, number[]] => [
			`aurora: ${t.label}`,
			t,
			'platform' in t.from ? [0, 250] : [500, 600, 800]
		]),
		...EMBER_TRANSFERS.map((t): [string, SurfTransfer, number[]] => [
			`ember: ${t.label}`,
			t,
			'platform' in t.from ? [0, 250] : [600, 800]
		])
	];
	it.each(cases)('%s', (_label, t, speeds) => {
		for (const speed of speeds) {
			for (const r of simulateTransfer(t, speed, GRAVITY)) {
				expect(r.ok, `${speed} u/s from (${r.start.x.toFixed(0)}, ${r.start.y.toFixed(0)}, ${r.start.z.toFixed(0)}): ${r.reason}`).toBe(true);
			}
		}
	});
	it.each(cases)('%s never passes through a teleport before landing', (label, t, speeds) => {
		const m = getMap(label.startsWith('aurora') ? 'surf_aurora' : 'surf_ember')!;
		const tps = zonesOf(m, 'teleport');
		for (const speed of speeds) {
			const results = simulateTransfer(t, speed, GRAVITY);
			launchStates(t.from, speed).forEach(({ p, vel }, i) => {
				for (let time = 0; time <= results[i]!.time; time += 1 / 128) {
					const at = { x: p.x + vel.x * time, y: p.y + vel.y * time, z: p.z + vel.z * time - 0.5 * GRAVITY * time * time };
					for (const tp of tps) expect(inBox(at, tp), `${speed} u/s at t=${time.toFixed(2)}`).toBe(false);
				}
			});
		}
	});
	it('covers every ramp of both surf maps', () => {
		for (const [m, trs] of [
			['surf_aurora', AURORA_TRANSFERS],
			['surf_ember', EMBER_TRANSFERS]
		] as const) {
			const used = new Set(trs.flatMap((t) => ('ramps' in t.to ? t.to.ramps : [])));
			for (const r of ramps(getMap(m)!)) expect(used.has(r)).toBe(true);
			expect(trs.some((t) => 'platform' in t.to && inBox(t.to.platform.max, zonesOf(getMap(m)!, 'end')[0]!))).toBe(true);
		}
	});
	it('ember long gap rewards speed (500 u/s is not enough, 600 is)', () => {
		const t = EMBER_TRANSFERS.find((x) => x.label.includes('long gap'))!;
		expect(simulateTransfer(t, 600, GRAVITY).every((r) => r.ok)).toBe(true);
		expect(simulateTransfer(t, 500, GRAVITY).some((r) => !r.ok)).toBe(true);
	});
});

/** Airtime of a jump that lands `dh` higher (negative = lower); NaN if unreachable. */
function airtime(dh: number): number {
	const j = JUMP_IMPULSE;
	return (j + Math.sqrt(j * j - 2 * GRAVITY * dh)) / GRAVITY;
}

describe.each([
	['bhop_meadow', MEADOW_PATH, { block: 128, gapMin: 96, gapMax: 160, speed: 290, blocks: [36, 44], sections: 5 }],
	['bhop_circuit', CIRCUIT_PATH, { block: 64, gapMin: 64, gapMax: 240, speed: 400, blocks: [54, 66], sections: 6 }]
] as const)('%s path', (id, path: PathNode[], spec) => {
	const m = getMap(id)!;
	it('matches the map brushes', () => {
		expect(boxes(m).length).toBe(path.length);
		path.forEach((n, i) => {
			expect(boxes(m)[i]!.min).toEqual(n.min);
			expect(boxes(m)[i]!.max).toEqual(n.max);
		});
	});
	it('has the documented block count and sections', () => {
		const jumpable = path.filter((n) => n.kind === 'block' || n.kind === 'strip').length;
		expect(jumpable).toBeGreaterThanOrEqual(spec.blocks[0]);
		expect(jumpable).toBeLessThanOrEqual(spec.blocks[1]);
		expect(path.filter((n) => n.kind === 'checkpoint').length + 1).toBe(spec.sections);
		expect(zonesOf(m, 'checkpoint')).toHaveLength(spec.sections);
		expect(path[0]!.kind).toBe('start');
		expect(path[path.length - 1]!.kind).toBe('end');
	});
	it('block sizes are in range', () => {
		for (const n of path) {
			const sx = n.max.x - n.min.x;
			const sy = n.max.y - n.min.y;
			if (n.kind === 'block') {
				expect(sx).toBeCloseTo(spec.block, 3);
				expect(sy).toBeCloseTo(spec.block, 3);
			} else if (n.kind === 'strip') {
				expect(id).toBe('bhop_circuit');
				expect(Math.min(sx, sy)).toBeGreaterThanOrEqual(32 - 1e-6);
				expect(Math.min(sx, sy)).toBeLessThanOrEqual(48 + 1e-6);
				expect(Math.max(sx, sy)).toBeGreaterThanOrEqual(256 - 1e-6);
			} else {
				expect(Math.min(sx, sy)).toBeGreaterThanOrEqual(256 - 1e-6);
			}
		}
	});
	it('gaps and height changes are in range and jumpable', () => {
		for (let i = 1; i < path.length; i++) {
			const a = path[i - 1]!;
			const b = path[i]!;
			const gap = gapXY(a, b);
			const dh = b.max.z - a.max.z;
			expect(gap, `gap ${i}`).toBeGreaterThanOrEqual(spec.gapMin - 0.01);
			expect(gap, `gap ${i}`).toBeLessThanOrEqual(spec.gapMax + 0.01);
			expect(dh, `rise ${i}`).toBeLessThanOrEqual(id === 'bhop_meadow' ? 16 : 40);
			const t = airtime(dh);
			expect(Number.isNaN(t), `rise ${i} unreachable`).toBe(false);
			expect(spec.speed * t, `jump ${i}: gap ${gap.toFixed(1)}, dh ${dh}`).toBeGreaterThanOrEqual(gap);
		}
	});
	it('tops stay at similar heights', () => {
		const tops = path.map((n) => n.max.z);
		expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(id === 'bhop_meadow' ? 64 : 160);
	});
	it('end zone is separate from the last checkpoint', () => {
		const end = zonesOf(m, 'end')[0]!;
		for (const c of zonesOf(m, 'checkpoint')) expect(overlaps(end, c)).toBe(false);
	});
});

import { buildCollisionWorld } from '../collision/world.ts';
import { HULL_MAX, HULL_MIN } from '../movement/api.ts';
import { MAPS as ALL_MAPS, SANDBOX as SANDBOX_MAP } from './index.ts';

describe.each(TAG.map((m) => [m.id, m] as const))('tag map %s', (_id, m) => {
	const spawns = tagSpawns(m);

	it('is an open map without race zones', () => {
		expect(m.layout).toBe('open');
		for (const z of m.zones) expect(z.type, 'tag maps only use teleport zones').toBe('teleport');
	});

	it('has at least 8 spawns, standing free on ground in the real trace', () => {
		expect(m.spawns?.length ?? 0).toBeGreaterThanOrEqual(8);
		const world = buildCollisionWorld(m);
		for (const [i, s] of [m.spawn, ...spawns].entries()) {
			const p = s.pos;
			expect(world.trace(p, p, HULL_MIN, HULL_MAX).startsolid, `spawn ${i} starts solid`).toBe(false);
			const down = world.trace(p, { ...p, z: p.z - 2 }, HULL_MIN, HULL_MAX);
			expect(down.fraction, `spawn ${i} has no ground`).toBeLessThan(1);
			expect(down.plane.normal.z, `spawn ${i} ground not walkable`).toBeGreaterThanOrEqual(0.7);
		}
	});

	it('spawns are spread out (no two closer than 64 units)', () => {
		for (let i = 0; i < spawns.length; i++)
			for (let j = i + 1; j < spawns.length; j++) {
				const a = spawns[i]!.pos;
				const b = spawns[j]!.pos;
				expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), `spawns ${i}, ${j}`).toBeGreaterThanOrEqual(64);
			}
	});

	it('every brush material exists in the theme', () => {
		for (const b of m.brushes) expect(m.theme.materials[b.material], b.material).toBeDefined();
	});

	it('has a teleport zone under everything that touches no brush or spawn', () => {
		const all = boundsOf(m.brushes);
		const tps = zonesOf(m, 'teleport');
		const below = tps.find(
			(z) =>
				z.max.z <= all.min.z &&
				z.min.x <= all.min.x &&
				z.min.y <= all.min.y &&
				z.max.x >= all.max.x &&
				z.max.y >= all.max.y
		);
		expect(below).toBeDefined();
		for (const tp of tps) {
			for (const b of m.brushes) expect(overlaps(tp, brushBounds(b)), 'teleport overlaps a brush').toBe(false);
			for (const s of [m.spawn, ...spawns]) expect(inBox(s.pos, tp)).toBe(false);
		}
	});
});

describe('spawns are not stuck', () => {
	for (const map of [...ALL_MAPS, SANDBOX_MAP]) {
		it(`${map.id}: spawn and respawns are free in the real trace`, () => {
			const world = buildCollisionWorld(map);
			const points = [map.spawn.pos, ...(map.spawns ?? []).map((s) => s.pos)];
			for (const z of map.zones) if (z.type === 'stage' || z.type === 'checkpoint') points.push(z.respawn.pos);
			for (const p of points) {
				const t = world.trace(p, p, HULL_MIN, HULL_MAX);
				expect(t.startsolid).toBe(false);
				const down = world.trace(p, { ...p, z: p.z - 2 }, HULL_MIN, HULL_MAX);
				expect(down.fraction).toBeLessThan(1);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Zombies maps (docs/maps.md, docs/modes.md#zombies)

import { createPlayer, playerMove } from '../movement/gamemovement.ts';
import { hullInBox, mapCvars as zmMapCvars, WEAPONS as ZM_WEAPONS } from '../modes/index.ts';

const ZOMBIES: MapDef[] = ALL.filter((m) => m.kind === 'zombies');

describe('zombies maps', () => {
	it('the rotation has at least one zombies map', () => {
		expect(mapsForMode('zombies').length).toBeGreaterThanOrEqual(1);
	});
});

describe.each(ZOMBIES.map((m) => [m.id, m] as const))('zombies map %s', (_id, m) => {
	const world = buildCollisionWorld(m);
	const free = (p: Vec3, what: string) => {
		expect(world.trace(p, p, HULL_MIN, HULL_MAX).startsolid, `${what} starts solid`).toBe(false);
		const down = world.trace(p, { ...p, z: p.z - 2 }, HULL_MIN, HULL_MAX);
		expect(down.fraction, `${what} has no ground`).toBeLessThan(1);
		expect(down.plane.normal.z, `${what} ground not walkable`).toBeGreaterThanOrEqual(0.7);
	};
	const cps = zonesOf(m, 'checkpoint').sort((a, b) => a.index - b.index);
	const end = zonesOf(m, 'end');

	it('is a linear route with checkpoints 1..N and one end zone', () => {
		expect(m.layout).toBe('linear');
		expect(m.zombies).toBeDefined();
		expect(cps.length).toBeGreaterThanOrEqual(3);
		expect(cps.map((z) => z.index)).toEqual(cps.map((_, i) => i + 1));
		expect(end.length).toBe(1);
		expect(zonesOf(m, 'start').length + zonesOf(m, 'stage').length).toBe(0);
	});

	it('has at least 4 free start spawns and free checkpoint respawns inside their zones', () => {
		expect(m.spawns?.length ?? 0).toBeGreaterThanOrEqual(4);
		for (const [i, s] of [m.spawn, ...(m.spawns ?? [])].entries()) free(s.pos, `spawn ${i}`);
		for (const z of cps) {
			free(z.respawn.pos, `checkpoint ${z.index} respawn`);
			expect(inBox(z.respawn.pos, z), `checkpoint ${z.index} respawn outside its zone`).toBe(true);
		}
	});

	it('route waypoints and zombie spawn areas stand free on walkable ground', () => {
		const route = m.zombies!;
		expect(route.path.length).toBeGreaterThanOrEqual(2);
		for (const [i, n] of route.path.entries()) free({ ...n, z: n.z + 0.25 }, `waypoint ${i}`);
		expect(route.spawnZones.length).toBeGreaterThanOrEqual(4);
		for (const [i, z] of route.spawnZones.entries()) {
			expect(z.node, `spawn area ${i} node`).toBeGreaterThanOrEqual(0);
			expect(z.node, `spawn area ${i} node`).toBeLessThan(route.path.length);
			expect(z.max.x - z.min.x, `spawn area ${i} too narrow`).toBeGreaterThanOrEqual(64);
			expect(z.max.y - z.min.y, `spawn area ${i} too narrow`).toBeGreaterThanOrEqual(64);
			for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.8], [0.2, 0.8], [0.8, 0.2]] as const) {
				const p = { x: z.min.x + (z.max.x - z.min.x) * fx, y: z.min.y + (z.max.y - z.min.y) * fy, z: z.min.z + 0.25 };
				free(p, `spawn area ${i} (${fx}, ${fy})`);
			}
		}
	});

	it('the route is walkable end to end with the real movement (bot walk, slowest weapon)', () => {
		const cv = { ...zmMapCvars(m), sv_maxspeed: Math.min(...Object.values(ZM_WEAPONS).map((w) => w.moveSpeed)) };
		const path = m.zombies!.path;
		const p = createPlayer({ ...m.spawn.pos });
		let node = 1;
		let reached = 0;
		let inEnd = false;
		for (let t = 0; t < 64 * 180 && !inEnd; t++) {
			const g = path[Math.min(node, path.length - 1)]!;
			const dx = g.x - p.origin.x;
			const dy = g.y - p.origin.y;
			if (Math.hypot(dx, dy) < 32 && node < path.length - 1) node++;
			playerMove(world, p, { pitch: 0, yaw: (Math.atan2(dy, dx) * 180) / Math.PI, forwardmove: 450, sidemove: 0, buttons: 0 }, cv);
			expect(p.origin.z, `fell near waypoint ${node}`).toBeGreaterThan(-100);
			for (const z of cps) if (z.index === reached + 1 && hullInBox(p.origin, false, z)) reached = z.index;
			inEnd = hullInBox(p.origin, false, end[0]!);
		}
		expect(reached, 'checkpoints passed in order').toBe(cps.length);
		expect(inEnd, 'reached the evac zone').toBe(true);
	});

	it('every brush material exists; box brushes do not intersect', () => {
		for (const b of m.brushes) expect(m.theme.materials[b.material], b.material).toBeDefined();
		const bs = boxes(m);
		for (let i = 0; i < bs.length; i++)
			for (let j = i + 1; j < bs.length; j++) expect(overlaps(bs[i]!, bs[j]!), `boxes ${i} and ${j} intersect`).toBe(false);
	});

	it('has a teleport zone under everything; teleports touch no brush, spawn or respawn', () => {
		const all = boundsOf(m.brushes);
		const tps = zonesOf(m, 'teleport');
		expect(tps.some((z) => z.max.z <= all.min.z && z.min.x <= all.min.x && z.min.y <= all.min.y && z.max.x >= all.max.x && z.max.y >= all.max.y)).toBe(true);
		for (const tp of tps) {
			for (const b of m.brushes) expect(overlaps(tp, brushBounds(b)), 'teleport overlaps a brush').toBe(false);
			for (const s of [m.spawn, ...(m.spawns ?? []), ...cps.map((z) => z.respawn)]) expect(inBox(s.pos, tp)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// Zombie Defense maps (docs/maps.md#zombie-defense-maps, docs/modes.md#zombie-defense)

const DEFENSE: MapDef[] = ALL.filter((m) => m.kind === 'defense');

describe('defense maps', () => {
	it('the rotation has at least one defense map', () => {
		expect(mapsForMode('defense').length).toBeGreaterThanOrEqual(1);
	});
});

describe.each(DEFENSE.map((m) => [m.id, m] as const))('defense map %s', (_id, m) => {
	const world = buildCollisionWorld(m);
	const d = m.defense!;
	const { nodes, links } = d?.nav ?? { nodes: [], links: [] };
	const free = (p: Vec3, what: string) => {
		expect(world.trace(p, p, HULL_MIN, HULL_MAX).startsolid, `${what} starts solid`).toBe(false);
		const down = world.trace(p, { ...p, z: p.z - 2 }, HULL_MIN, HULL_MAX);
		expect(down.fraction, `${what} has no ground`).toBeLessThan(1);
		expect(down.plane.normal.z, `${what} ground not walkable`).toBeGreaterThanOrEqual(0.7);
	};
	/** Connected components of the nav graph, optionally without the opening links. */
	const components = (withoutOpenings: boolean): number[] => {
		const isOpening = ([i, j]: [number, number]) => d.openings.some((o) => (i === o.outside && j === o.inside) || (i === o.inside && j === o.outside));
		const adj = nodes.map(() => [] as number[]);
		for (const l of links) {
			if (withoutOpenings && isOpening(l)) continue;
			adj[l[0]]!.push(l[1]);
			adj[l[1]]!.push(l[0]);
		}
		const comp = nodes.map(() => -1);
		let c = 0;
		for (let s = 0; s < nodes.length; s++) {
			if (comp[s] !== -1) continue;
			comp[s] = c;
			const q = [s];
			while (q.length) for (const n of adj[q.pop()!]!) if (comp[n] === -1) ((comp[n] = c), q.push(n));
			c++;
		}
		return comp;
	};

	it('is an open map with defense data and only teleport zones', () => {
		expect(m.layout).toBe('open');
		expect(d).toBeDefined();
		for (const z of m.zones) expect(z.type, 'defense maps only use teleport zones').toBe('teleport');
		const all = boundsOf(m.brushes);
		const tps = zonesOf(m, 'teleport');
		expect(tps.some((z) => z.max.z <= all.min.z && z.min.x <= all.min.x && z.min.y <= all.min.y && z.max.x >= all.max.x && z.max.y >= all.max.y)).toBe(true);
		for (const tp of tps) for (const b of m.brushes) expect(overlaps(tp, brushBounds(b)), 'teleport overlaps a brush').toBe(false);
	});

	it('every brush material exists; box brushes do not intersect', () => {
		for (const b of m.brushes) expect(m.theme.materials[b.material], b.material).toBeDefined();
		const bs = boxes(m);
		for (let i = 0; i < bs.length; i++)
			for (let j = i + 1; j < bs.length; j++) expect(overlaps(bs[i]!, bs[j]!), `boxes ${i} and ${j} intersect`).toBe(false);
	});

	it('nav graph: valid, connected, nodes on walkable floor', () => {
		expect(nodes.length).toBeGreaterThanOrEqual(2);
		for (const [a, b] of links) {
			expect(nodes[a], `link ${a}-${b}`).toBeDefined();
			expect(nodes[b], `link ${a}-${b}`).toBeDefined();
		}
		expect(new Set(components(false)).size, 'nav graph connected').toBe(1);
		for (const [i, n] of nodes.entries()) free({ ...n, z: n.z + 0.25 }, `nav node ${i}`);
	});

	it('openings on several sides, linked outside → inside; the openings split the graph into outside and inside', () => {
		expect(d.openings.length).toBeGreaterThanOrEqual(4);
		expect(new Set(d.openings.map((o) => o.id)).size).toBe(d.openings.length);
		const split = components(true);
		expect(new Set(split).size, 'without the opening links: outside and inside').toBe(2);
		const outC = split[d.openings[0]!.outside]!;
		for (const o of d.openings) {
			expect(nodes[o.outside], `${o.id} outside node`).toBeDefined();
			expect(nodes[o.inside], `${o.id} inside node`).toBeDefined();
			expect(split[o.outside], `${o.id} outside node is outside`).toBe(outC);
			expect(split[o.inside], `${o.id} inside node is inside`).not.toBe(outC);
			expect(o.max.x > o.min.x && o.max.y > o.min.y && o.max.z > o.min.z, `${o.id} box`).toBe(true);
		}
		// Sides: direction of each opening from the centroid of the inside nodes, in 90° sectors.
		const ins = d.openings.map((o) => nodes[o.inside]!);
		const cx = ins.reduce((s, p) => s + p.x, 0) / ins.length;
		const cy = ins.reduce((s, p) => s + p.y, 0) / ins.length;
		const sector = (o: (typeof d.openings)[number]) => {
			const a = Math.atan2((o.min.y + o.max.y) / 2 - cy, (o.min.x + o.max.x) / 2 - cx);
			return ((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4;
		};
		expect(new Set(d.openings.map(sector)).size, 'openings face at least 3 directions').toBeGreaterThanOrEqual(3);
	});

	it('player spawns (>= 4) and turret pads stand inside the base', () => {
		const split = components(true);
		const inC = split[d.openings[0]!.inside]!;
		/** The nav node nearest to p that it reaches in a straight line (same floor). */
		const nearestInside = (p: Vec3): boolean => {
			let best = -1;
			let bd = Infinity;
			for (const [i, n] of nodes.entries()) {
				if (Math.abs(n.z - p.z) > 20) continue;
				const dd = Math.hypot(n.x - p.x, n.y - p.y);
				if (dd >= bd) continue;
				const t = world.trace({ ...p, z: n.z + 0.25 }, { ...n, z: n.z + 0.25 }, HULL_MIN, HULL_MAX);
				if (t.startsolid || t.fraction < 1) continue;
				best = i;
				bd = dd;
			}
			return best >= 0 && split[best] === inC;
		};
		expect(m.spawns?.length ?? 0).toBeGreaterThanOrEqual(4);
		for (const [i, s] of [m.spawn, ...(m.spawns ?? [])].entries()) {
			free(s.pos, `spawn ${i}`);
			expect(nearestInside(s.pos), `spawn ${i} inside the base`).toBe(true);
		}
		expect(d.pads.length).toBeGreaterThanOrEqual(4);
		expect(new Set(d.pads.map((p) => p.id)).size).toBe(d.pads.length);
		for (const p of d.pads) {
			free({ ...p.pos, z: p.pos.z + 0.25 }, p.id);
			expect(nearestInside(p.pos), `${p.id} inside the base`).toBe(true);
		}
	});

	it('zombie spawn areas stand on walkable floor outside, each next to an outside nav node', () => {
		const split = components(true);
		const outC = split[d.openings[0]!.outside]!;
		expect(d.spawnZones.length).toBeGreaterThanOrEqual(4);
		for (const [i, z] of d.spawnZones.entries()) {
			expect(z.max.x - z.min.x, `area ${i} too narrow`).toBeGreaterThanOrEqual(64);
			expect(z.max.y - z.min.y, `area ${i} too narrow`).toBeGreaterThanOrEqual(64);
			for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.8], [0.2, 0.8], [0.8, 0.2]] as const)
				free({ x: z.min.x + (z.max.x - z.min.x) * fx, y: z.min.y + (z.max.y - z.min.y) * fy, z: z.min.z + 0.25 }, `area ${i} (${fx}, ${fy})`);
			expect(nodes[z.node], `area ${i} node`).toBeDefined();
			expect(split[z.node], `area ${i} node is outside`).toBe(outC);
		}
	});
});
