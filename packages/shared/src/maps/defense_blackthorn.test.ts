import { describe, expect, it } from 'vitest';
import type { CollisionWorld } from '../collision/api.ts';
import { buildCollisionWorld } from '../collision/world.ts';
import { mapCvars } from '../modes/index.ts';
import { DUCK_HULL_MAX, HULL_MAX, HULL_MIN } from '../movement/api.ts';
import { createPlayer, playerMove } from '../movement/gamemovement.ts';
import type { Vec3 } from '../types.ts';
import { defense_blackthorn as m, BLACKTHORN } from './defense_blackthorn.ts';
import { getMap, MAPS } from './index.ts';
import { brushBounds, gapXY, type Box3, type BoxBrush } from './helpers.ts';
import type { DefenseOpening } from './types.ts';

const D = m.defense!;
const { nodes, links } = D.nav;
const boxes = m.brushes.filter((b): b is BoxBrush => b.type === 'box');
/** The map as players see it with every barricade torn down. */
const open = buildCollisionWorld(m);
const openingBrush = (o: DefenseOpening): BoxBrush => ({ type: 'box', min: o.min, max: o.max, material: 'planks' });
/** Every opening boarded (solid), like the mode's gated world at wave start. */
const sealed = buildCollisionWorld({ brushes: [...m.brushes, ...D.openings.map(openingBrush)] });
const { inner, outer, fields } = BLACKTHORN;
const CLEAR = 0.25;
const lift = (p: Vec3, dz = CLEAR): Vec3 => ({ ...p, z: p.z + dz });

const overlaps = (a: Box3, b: Box3, eps = 0.01) =>
	a.min.x < b.max.x - eps &&
	b.min.x < a.max.x - eps &&
	a.min.y < b.max.y - eps &&
	b.min.y < a.max.y - eps &&
	a.min.z < b.max.z - eps &&
	b.min.z < a.max.z - eps;
const inXY = (p: { x: number; y: number }, b: Box3, pad = 0) =>
	p.x > b.min.x + pad && p.x < b.max.x - pad && p.y > b.min.y + pad && p.y < b.max.y - pad;
const centre = (b: Box3): Vec3 => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 });

function standsFree(world: CollisionWorld, p: Vec3): { solid: boolean; ground: boolean } {
	const t = world.trace(p, p, HULL_MIN, HULL_MAX);
	const down = world.trace(p, { ...p, z: p.z - 2 }, HULL_MIN, HULL_MAX);
	return { solid: t.startsolid, ground: down.fraction < 1 && down.plane.normal.z >= 0.7 };
}
function expectFree(world: CollisionWorld, p: Vec3, what: string) {
	const r = standsFree(world, p);
	expect(r.solid, `${what} starts solid`).toBe(false);
	expect(r.ground, `${what} has no walkable ground`).toBe(true);
}

/** Which wall an opening sits in (its thin axis and the sign of its centre). */
function sideOf(o: Box3): 'north' | 'south' | 'west' | 'east' {
	const c = centre(o);
	return o.max.y - o.min.y < o.max.x - o.min.x ? (c.y > 0 ? 'north' : 'south') : c.x > 0 ? 'east' : 'west';
}
/** Side of the base a point outside it lies on (by the larger overhang). */
function sideOfPoint(p: { x: number; y: number }): 'north' | 'south' | 'west' | 'east' {
	const dx = Math.abs(p.x) - outer.max.x;
	const dy = Math.abs(p.y) - outer.max.y;
	return dy > dx ? (p.y > 0 ? 'north' : 'south') : p.x > 0 ? 'east' : 'west';
}

/** Connected components of the nav graph (optionally without some links). */
function components(skip: (l: [number, number]) => boolean = () => false): number[] {
	const comp = nodes.map(() => -1);
	const adj = nodes.map(() => [] as number[]);
	for (const l of links) {
		if (skip(l)) continue;
		adj[l[0]]!.push(l[1]);
		adj[l[1]]!.push(l[0]);
	}
	let c = 0;
	for (let s = 0; s < nodes.length; s++) {
		if (comp[s] !== -1) continue;
		const q = [s];
		comp[s] = c;
		while (q.length) for (const n of adj[q.pop()!]!) if (comp[n] === -1) ((comp[n] = c), q.push(n));
		c++;
	}
	return comp;
}

describe('defense_blackthorn', () => {
	it('is a registered open defense map with only teleport zones', () => {
		expect(getMap('defense_blackthorn')).toBe(m);
		expect(MAPS).toContain(m);
		expect(m.kind).toBe('defense');
		expect(m.layout).toBe('open');
		expect(m.title).toBe('Blackthorn Farm');
		for (const z of m.zones) expect(z.type).toBe('teleport');
		expect(m.zombies).toBeUndefined();
		expect(m.hns).toBeUndefined();
	});

	it('uses only boxes, all with known materials, none intersecting', () => {
		expect(boxes).toHaveLength(m.brushes.length);
		for (const b of boxes) {
			expect(m.theme.materials[b.material], b.material).toBeDefined();
			expect(b.max.x).toBeGreaterThan(b.min.x);
			expect(b.max.y).toBeGreaterThan(b.min.y);
			expect(b.max.z).toBeGreaterThan(b.min.z);
		}
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!), `boxes ${i} and ${j} intersect`).toBe(false);
		// Brush budget in line with the infected maps.
		expect(boxes.length).toBeLessThanOrEqual(400);
	});

	it('has a teleport under everything that touches no brush', () => {
		const tp = m.zones[0]!;
		for (const b of m.brushes) expect(overlaps(tp, brushBounds(b))).toBe(false);
		expect(tp.max.z).toBeLessThanOrEqual(-64);
		expect(tp.min.x).toBeLessThan(fields.min.x);
		expect(tp.max.y).toBeGreaterThan(fields.max.y);
	});

	it('player spawns (>= 4, and the fallback) stand free on the yard floor inside the base', () => {
		expect(m.spawns!.length).toBeGreaterThanOrEqual(4);
		for (const [i, s] of [m.spawn, ...m.spawns!].entries()) {
			expect(inXY(s.pos, inner, 16), `spawn ${i} inside`).toBe(true);
			expectFree(sealed, s.pos, `spawn ${i}`); // registry-lifted already
			for (const o of D.openings)
				expect(overlaps({ min: lift(s.pos, -CLEAR), max: { ...s.pos, z: s.pos.z + 72 } }, o), `spawn ${i} in ${o.id}`).toBe(false);
		}
	});

	describe('openings', () => {
		it('8 openings with unique ids, at least one on every side', () => {
			expect(D.openings.length).toBeGreaterThanOrEqual(6);
			expect(D.openings.length).toBeLessThanOrEqual(10);
			expect(new Set(D.openings.map((o) => o.id)).size).toBe(D.openings.length);
			const sides = new Map<string, number>();
			for (const o of D.openings) sides.set(sideOf(o), (sides.get(sideOf(o)) ?? 0) + 1);
			for (const s of ['north', 'south', 'west', 'east']) expect(sides.get(s), s).toBeGreaterThanOrEqual(1);
		});

		it('boxes span the wall exactly and touch no brush (they fill a gap)', () => {
			for (const o of D.openings) {
				for (const b of boxes) expect(overlaps(o, b), `${o.id} overlaps a brush`).toBe(false);
				const thin = o.max.y - o.min.y < o.max.x - o.min.x ? 'y' : 'x';
				expect(o.min[thin], `${o.id} inner/outer face`).toBe(thin === 'y' ? (o.min.y > 0 ? inner.max.y : outer.min.y) : o.min.x > 0 ? inner.max.x : outer.min.x);
				expect(o.max[thin] - o.min[thin], `${o.id} thickness`).toBe(outer.max.x - inner.max.x);
				const along = thin === 'y' ? 'x' : 'y';
				expect(o.max[along] - o.min[along], `${o.id} too narrow for a zombie`).toBeGreaterThanOrEqual(80);
				expect(o.max.z - o.min.z, `${o.id} too low for a zombie`).toBeGreaterThanOrEqual(80);
				// Each face of the box but the two open ones (outside, inside) is flush against a brush.
				const touches = (axis: 'x' | 'y' | 'z', side: 'min' | 'max') =>
					boxes.some((b) => {
						const face = side === 'min' ? b.max[axis] === o.min[axis] : b.min[axis] === o.max[axis];
						if (!face) return false;
						return (['x', 'y', 'z'] as const).filter((a) => a !== axis).every((a) => b.min[a] <= o.min[a] && b.max[a] >= o.max[a]);
					});
				for (const [axis, sd] of [
					[along, 'min'],
					[along, 'max'],
					['z', 'min'],
					['z', 'max']
				] as const)
					expect(touches(axis, sd), `${o.id}: ${sd} ${axis} face not flush against a brush`).toBe(true);
			}
		});

		it('outside and inside nodes stand free next to the boarded box, on the right sides', () => {
			for (const o of D.openings) {
				const a = nodes[o.outside]!;
				const b = nodes[o.inside]!;
				expect(inXY(a, outer), `${o.id} outside node is in the base`).toBe(false);
				expect(inXY(b, inner, 16), `${o.id} inside node is not in the yard`).toBe(true);
				expectFree(sealed, lift(a), `${o.id} outside node`);
				expectFree(sealed, lift(b), `${o.id} inside node`);
				const c = centre(o);
				expect(Math.hypot(a.x - c.x, a.y - c.y), `${o.id} outside node far`).toBeLessThanOrEqual(128);
				expect(Math.hypot(b.x - c.x, b.y - c.y), `${o.id} inside node far`).toBeLessThanOrEqual(128);
				expect(links.some(([i, j]) => (i === o.outside && j === o.inside) || (i === o.inside && j === o.outside)), `${o.id} link`).toBe(true);
			}
		});

		it('each opening lets a standing hull through when open and stops it when boarded', () => {
			for (const o of D.openings) {
				const a = lift(nodes[o.outside]!);
				const b = lift(nodes[o.inside]!);
				const z = Math.max(a.z, o.min.z + CLEAR);
				const tOpen = open.trace({ ...a, z }, { ...b, z }, HULL_MIN, HULL_MAX);
				expect(tOpen.startsolid || tOpen.fraction < 1, `${o.id} open but blocked`).toBe(false);
				const tShut = sealed.trace({ ...a, z }, { ...b, z }, HULL_MIN, HULL_MAX);
				expect(tShut.fraction, `${o.id} boarded but passable`).toBeLessThan(1);
			}
		});

		it('boarded, the walls are sealed: no ducked hull gets through anywhere (sweep of every wall)', () => {
			const zTop = BLACKTHORN.wallTop + 16 - DUCK_HULL_MAX.z;
			const D0 = 24; // start/end this far off the faces (> hull half width)
			let traces = 0;
			let passedOpen = 0;
			for (const side of ['north', 'south', 'west', 'east'] as const) {
				const ns = side === 'north' || side === 'south';
				const lim = ns ? outer.max.x : inner.max.y;
				for (let u = -lim + 4; u <= lim - 4; u += 8) {
					for (let z = CLEAR; z <= zTop; z += 8) {
						let s: Vec3;
						let e: Vec3;
						if (ns) {
							const sg = side === 'north' ? 1 : -1;
							s = { x: u, y: sg * (outer.max.y + D0), z };
							e = { x: u, y: sg * (inner.max.y - D0), z };
						} else {
							const sg = side === 'east' ? 1 : -1;
							s = { x: sg * (outer.max.x + D0), y: u, z };
							e = { x: sg * (inner.max.x - D0), y: u, z };
						}
						const t = sealed.trace(s, e, HULL_MIN, DUCK_HULL_MAX);
						traces++;
						if (t.startsolid) continue; // start inside a lamp or the wall-walk: not a way through
						expect(t.fraction, `${side} wall passable at u=${u} z=${z}`).toBeLessThan(1);
						const to = open.trace(s, e, HULL_MIN, DUCK_HULL_MAX);
						if (!to.startsolid && to.fraction === 1) passedOpen++;
					}
				}
			}
			expect(traces).toBeGreaterThan(5000);
			// Sanity: the same sweep finds the gaps when the barricades are down.
			expect(passedOpen).toBeGreaterThan(D.openings.length * 10);
		});

		it('nothing outside near the base is high enough to climb over the walls', () => {
			const near = { min: { x: outer.min.x - 256, y: outer.min.y - 256, z: 0 }, max: { x: outer.max.x + 256, y: outer.max.y + 256, z: 0 } };
			for (const b of boxes) {
				if (b.max.z <= 0) continue; // ground
				const inBase = b.min.x >= outer.min.x - 8 && b.max.x <= outer.max.x + 8 && b.min.y >= outer.min.y - 16 && b.max.y <= outer.max.y + 16;
				if (inBase) continue;
				if (gapXY(b, near) > 0) continue;
				// Standing on it and crouch-jumping (~65) must stay well under the wall tops.
				expect(b.max.z + 65, `${b.material} box at (${b.min.x}, ${b.min.y}) too high near the walls`).toBeLessThan(BLACKTHORN.wallTop);
			}
			// Base parts outside the outer faces (roof and coping overhangs) start high up.
			for (const b of boxes) {
				const out = b.min.x < outer.min.x || b.max.x > outer.max.x || b.min.y < outer.min.y || b.max.y > outer.max.y;
				const inBase = b.min.x >= outer.min.x - 8 && b.max.x <= outer.max.x + 8 && b.min.y >= outer.min.y - 16 && b.max.y <= outer.max.y + 16;
				if (out && inBase) expect(b.min.z, `${b.material} overhang`).toBeGreaterThanOrEqual(BLACKTHORN.wallTop);
			}
		});
	});

	describe('nav graph', () => {
		it('nodes stand free on walkable floor (all barricades open)', () => {
			for (const [i, n] of nodes.entries()) expectFree(open, lift(n), `nav node ${i}`);
			for (const [a, b] of links) {
				expect(a).not.toBe(b);
				expect(nodes[a]).toBeDefined();
				expect(nodes[b]).toBeDefined();
			}
		});

		it('is connected, and every way in goes through an opening (outside / inside split)', () => {
			const all = components();
			expect(new Set(all).size).toBe(1);
			const isOpeningLink = ([i, j]: [number, number]) =>
				D.openings.some((o) => (i === o.outside && j === o.inside) || (i === o.inside && j === o.outside));
			const split = components(isOpeningLink);
			expect(new Set(split).size).toBe(2);
			const out = split[D.openings[0]!.outside]!;
			for (const [i, n] of nodes.entries()) {
				const insideBase = inXY(n, inner);
				expect(insideBase ? split[i] !== out : split[i] === out, `node ${i} (${n.x}, ${n.y}) on the wrong side`).toBe(true);
				if (!insideBase) expect(inXY(n, outer), `node ${i} in a wall`).toBe(false);
			}
		});

		it('reaches the wall-walks', () => {
			for (const w of BLACKTHORN.walks) expect(nodes.some((n) => n.z === w.max.z && inXY(n, w))).toBe(true);
		});

		it('every link is walkable straight with the real movement, both ways (barricades open)', () => {
			const cv = mapCvars(m);
			for (const [ia, ib] of links) {
				for (const [from, to] of [
					[ia, ib],
					[ib, ia]
				] as const) {
					const a = nodes[from]!;
					const b = nodes[to]!;
					const p = createPlayer(lift(a));
					const len = Math.hypot(b.x - a.x, b.y - a.y);
					const ux = (b.x - a.x) / len;
					const uy = (b.y - a.y) / len;
					const what = `link ${from} (${a.x}, ${a.y}, ${a.z}) -> ${to} (${b.x}, ${b.y}, ${b.z})`;
					let arrived = false;
					const ticks = Math.ceil((len / 150 + 2) * 64);
					for (let t = 0; t < ticks && !arrived; t++) {
						const dx = b.x - p.origin.x;
						const dy = b.y - p.origin.y;
						playerMove(open, p, { pitch: 0, yaw: (Math.atan2(dy, dx) * 180) / Math.PI, forwardmove: 450, sidemove: 0, buttons: 0 }, cv);
						// Stays on the straight line (nothing deflects it).
						const rx = p.origin.x - a.x;
						const ry = p.origin.y - a.y;
						expect(Math.abs(rx * uy - ry * ux), `${what}: pushed off the line`).toBeLessThan(4);
						expect(p.origin.z, `${what}: fell`).toBeGreaterThan(Math.min(a.z, b.z) - 4);
						arrived = Math.hypot(b.x - p.origin.x, b.y - p.origin.y) < 16 && Math.abs(p.origin.z - b.z) < 4;
					}
					expect(arrived, `${what}: did not arrive`).toBe(true);
				}
			}
		});
	});

	describe('turret pads', () => {
		it('6-10 pads with unique ids, inside the base, standing on floor', () => {
			expect(D.pads.length).toBeGreaterThanOrEqual(6);
			expect(D.pads.length).toBeLessThanOrEqual(10);
			expect(new Set(D.pads.map((p) => p.id)).size).toBe(D.pads.length);
			for (const p of D.pads) {
				expect(inXY(p.pos, inner, 16), `${p.id} outside the base`).toBe(true);
				expectFree(sealed, lift(p.pos), p.id);
				for (const o of D.openings) expect(overlaps({ min: { ...p.pos, x: p.pos.x - 24, y: p.pos.y - 24 }, max: { x: p.pos.x + 24, y: p.pos.y + 24, z: p.pos.z + 72 } }, o)).toBe(false);
			}
			expect(D.pads.some((p) => p.pos.z >= BLACKTHORN.walk), 'a pad on the wall-walk').toBe(true);
		});

		it('pads keep clear of nav links (turrets do not block the zombies)', () => {
			for (const p of D.pads)
				for (const [ia, ib] of links) {
					const a = nodes[ia]!;
					const b = nodes[ib]!;
					if (Math.abs(a.z - p.pos.z) > 32 && Math.abs(b.z - p.pos.z) > 32) continue;
					const vx = b.x - a.x;
					const vy = b.y - a.y;
					const t = Math.max(0, Math.min(1, ((p.pos.x - a.x) * vx + (p.pos.y - a.y) * vy) / (vx * vx + vy * vy)));
					const d = Math.hypot(a.x + vx * t - p.pos.x, a.y + vy * t - p.pos.y);
					expect(d, `${p.id} near link ${ia}-${ib}`).toBeGreaterThanOrEqual(48);
				}
		});

		it('every opening is in sight of at least two pads within 900 units', () => {
			for (const o of D.openings) {
				const c = centre(o);
				const seen = D.pads.filter((p) => {
					const eye = lift(p.pos, 48);
					if (Math.hypot(eye.x - c.x, eye.y - c.y) > 900) return false;
					const t = open.trace(eye, c, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
					return !t.startsolid && t.fraction === 1;
				});
				expect(seen.length, `${o.id} seen by ${seen.map((p) => p.id).join(', ')}`).toBeGreaterThanOrEqual(2);
			}
		});
	});

	describe('zombie spawn areas', () => {
		it('6-10 areas, at least one feeding every side, 900-2000 from the base, inside the fields', () => {
			expect(D.spawnZones.length).toBeGreaterThanOrEqual(6);
			expect(D.spawnZones.length).toBeLessThanOrEqual(10);
			const sides = new Set<string>();
			for (const [i, z] of D.spawnZones.entries()) {
				sides.add(sideOfPoint(centre(z)));
				const d = gapXY(z, outer);
				expect(d, `area ${i} distance`).toBeGreaterThanOrEqual(900);
				expect(d, `area ${i} distance`).toBeLessThanOrEqual(2000);
				expect(z.min.x).toBeGreaterThan(fields.min.x + 64);
				expect(z.max.x).toBeLessThan(fields.max.x - 64);
				expect(z.min.y).toBeGreaterThan(fields.min.y + 64);
				expect(z.max.y).toBeLessThan(fields.max.y - 64);
				expect(z.max.x - z.min.x).toBeGreaterThanOrEqual(64);
				expect(z.max.y - z.min.y).toBeGreaterThanOrEqual(64);
				expect(z.max.z - z.min.z).toBeGreaterThanOrEqual(72);
			}
			expect([...sides].sort()).toEqual(['east', 'north', 'south', 'west']);
		});

		it('stand on walkable floor (min.z = floor top), next to their nav node, which is outside', () => {
			for (const [i, z] of D.spawnZones.entries()) {
				for (const [fx, fy] of [
					[0.5, 0.5],
					[0.15, 0.15],
					[0.85, 0.85],
					[0.15, 0.85],
					[0.85, 0.15]
				] as const)
					expectFree(open, { x: z.min.x + (z.max.x - z.min.x) * fx, y: z.min.y + (z.max.y - z.min.y) * fy, z: z.min.z + CLEAR }, `area ${i} (${fx}, ${fy})`);
				const n = nodes[z.node]!;
				expect(n, `area ${i} node`).toBeDefined();
				expect(inXY(n, outer), `area ${i} node inside the base`).toBe(false);
				expect(gapXY(z, { min: n, max: n }), `area ${i} node far from the area`).toBeLessThanOrEqual(128);
				// The node is reached straight from the area's centre.
				const c = lift({ ...centre(z), z: z.min.z });
				const t = open.trace(c, lift(n), HULL_MIN, HULL_MAX);
				expect(!t.startsolid && t.fraction === 1, `area ${i} to its node`).toBe(true);
			}
		});
	});
});
