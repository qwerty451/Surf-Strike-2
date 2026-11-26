/**
 * defense_blackthorn — Zombie Defense map (docs/modes.md#zombie-defense,
 * docs/maps.md). Blackthorn Farm: a walled stone farmstead on open fields at
 * harvest-moon dusk, with an orchard, a windmill, haystacks and a hedgerow
 * all round. Ground at z = 0.
 *
 *   Base (the farmyard)    inner x [-768, 768]  y [-640, 640]   walls 48 thick
 *                          (outer x [-816, 816] y [-688, 688])
 *   North / south walls    0..168 solid with the openings cut in, a 40-tall firing
 *                          slot 168..208 between posts (too low for even the
 *                          ducked hull, 54), solid again 208..272, and a roof
 *                          272..288 over the wall-walk
 *   Wall-walks             timber decks at z 128 along the inside of the north and
 *                          south walls (y ±[512, 640]), each reached by one flight
 *                          of 8 steps (NW corner climbing north, SE corner climbing
 *                          south); players shoot into the yard and out through the slot
 *   West / east walls      0..272 solid with the openings cut in
 *   Openings (8)           a door and a window on every side, the south gate (wide);
 *                          doors stand on the floor, windows on a 16-high sill
 *                          (one step), so zombies walk through every one
 *   Yard                   a covered well in the middle, hay bales, crates, a cart
 *   Fields                 zombie spawn areas ~1100 out from every wall (two per
 *                          side), an orchard (NW), a windmill (NE), haystacks (SE),
 *                          a shed (E), a farm track south from the gate; a 256-tall
 *                          hedgerow bounds the fields at x ±2688, y ±2560
 *
 * The walls are too tall to jump (lowest top outside is 168) and nothing
 * climbable stands near them outside, so the openings are the only way in.
 * Brushes never intersect. Nav nodes: a ring 192 outside the walls, one node
 * 64 outside and 80 inside every opening, an octagon around the well, the two
 * stair flights and the wall-walks.
 */
import type { DefenseMapInfo, DefenseOpening, DefensePad, DefenseSpawnZone, MapDef, Spawn, Theme, Zone } from './types.ts';
import type { Box3, BoxBrush } from './helpers.ts';
import type { Vec3 } from '../types.ts';
import { boundsOf, teleportBelow, v3 } from './helpers.ts';
import { block, pillar, stairs } from './tag-helpers.ts';

const boxes: BoxBrush[] = [];
const add = (b: BoxBrush): BoxBrush => (boxes.push(b), b);
const addAll = (bs: BoxBrush[]): BoxBrush[] => (boxes.push(...bs), bs);

// --- Dimensions -----------------------------------------------------------------------
/** Inner faces of the base walls. */
const IX = 768;
const IY = 640;
/** Wall thickness. */
const T = 48;
const OX = IX + T;
const OY = IY + T;
/** North/south walls: lower part, firing slot, upper part, roof. */
const SLOT_BOTTOM = 168;
const SLOT_TOP = 208;
const WALL_TOP = 272;
const ROOF_TOP = 288;
/** Wall-walk deck (top) and its depth from the wall. */
const WALK = 128;
const WALK_IN = 512;
/** Fields: inner faces of the hedgerow, and the ground's extent. */
const FX = 2688;
const FY = 2560;
const HEDGE_T = 96;

// --- Ground -----------------------------------------------------------------------------
// Partition: farmyard cobbles, the farm track south from the gate, grass elsewhere.
const GX = FX + HEDGE_T;
const GY = FY + HEDGE_T;
const TRACK = 96;
const ground = addAll([
	block(-IX, IX, -IY, IY, -64, 0, 'yard'),
	block(-GX, GX, IY, GY, -64, 0, 'grass'), // north
	block(-GX, -IX, -IY, IY, -64, 0, 'grass'), // west
	block(IX, GX, -IY, IY, -64, 0, 'grass'), // east
	block(-GX, -TRACK, -GY, -IY, -64, 0, 'grass'), // south, west of the track
	block(TRACK, GX, -GY, -IY, -64, 0, 'grass'), // south, east of the track
	block(-TRACK, TRACK, -GY, -IY, -64, 0, 'track')
]);

// --- Openings -----------------------------------------------------------------------------
type Side = 'north' | 'south' | 'west' | 'east';
interface OpeningSpec {
	id: string;
	name: string;
	side: Side;
	/** Gap along the wall (x for north/south, y for west/east). */
	a: number;
	b: number;
	/** Sill top and lintel bottom. */
	z0: number;
	z1: number;
	planks?: number;
}
const DOOR = { z0: 0, z1: 128 };
const WINDOW = { z0: 16, z1: 112 };
const OPENING_SPECS: OpeningSpec[] = [
	{ id: 'north_door', name: 'north door', side: 'north', a: -320, b: -208, ...DOOR },
	{ id: 'north_window', name: 'north window', side: 'north', a: 336, b: 432, ...WINDOW },
	{ id: 'east_door', name: 'east door', side: 'east', a: 208, b: 320, ...DOOR },
	{ id: 'east_window', name: 'east window', side: 'east', a: -256, b: -160, ...WINDOW },
	{ id: 'south_gate', name: 'south gate', side: 'south', a: -96, b: 96, z0: 0, z1: 144, planks: 8 },
	{ id: 'south_window', name: 'south window', side: 'south', a: -560, b: -464, ...WINDOW },
	{ id: 'west_window', name: 'west window', side: 'west', a: 160, b: 256, ...WINDOW },
	{ id: 'west_door', name: 'west door', side: 'west', a: -320, b: -208, ...DOOR }
];

/** Box of a span along a wall side (u along the wall, z up), the full wall thickness. */
function wallBox(side: Side, u0: number, u1: number, z0: number, z1: number, material: string): BoxBrush {
	switch (side) {
		case 'north':
			return block(u0, u1, IY, OY, z0, z1, material);
		case 'south':
			return block(u0, u1, -OY, -IY, z0, z1, material);
		case 'west':
			return block(-OX, -IX, u0, u1, z0, z1, material);
		case 'east':
			return block(IX, OX, u0, u1, z0, z1, material);
	}
}

/**
 * One wall: solid from 0 to `top` between `from` and `to`, with every opening
 * of that side cut in (stone jambs, a sill under windows, a dark lintel above).
 */
function buildWall(side: Side, from: number, to: number, top: number): void {
	const gaps = OPENING_SPECS.filter((o) => o.side === side).sort((p, q) => p.a - q.a);
	let u = from;
	for (const g of gaps) {
		if (g.a > u) add(wallBox(side, u, g.a, 0, top, 'stone'));
		if (g.z0 > 0) add(wallBox(side, g.a, g.b, 0, g.z0, 'sill'));
		const lintelTop = Math.min(top, g.z1 + 24);
		add(wallBox(side, g.a, g.b, g.z1, lintelTop, 'lintel'));
		if (top > lintelTop) add(wallBox(side, g.a, g.b, lintelTop, top, 'stone'));
		u = g.b;
	}
	if (to > u) add(wallBox(side, u, to, 0, top, 'stone'));
}

// North and south walls run corner to corner; west and east fit between them.
buildWall('north', -OX, OX, SLOT_BOTTOM);
buildWall('south', -OX, OX, SLOT_BOTTOM);
buildWall('west', -IY, IY, WALL_TOP);
buildWall('east', -IY, IY, WALL_TOP);

// Firing slot posts, the upper wall and the roof over the wall-walks.
const SLOT_POSTS = [-512, -256, 0, 256, 512];
for (const side of ['north', 'south'] as const) {
	add(wallBox(side, -OX, -IX, SLOT_BOTTOM, SLOT_TOP, 'stone'));
	add(wallBox(side, IX, OX, SLOT_BOTTOM, SLOT_TOP, 'stone'));
	for (const x of SLOT_POSTS) add(wallBox(side, x - 16, x + 16, SLOT_BOTTOM, SLOT_TOP, 'timber'));
	add(wallBox(side, -OX, OX, SLOT_TOP, WALL_TOP, 'stone'));
}
const ROOF_IN = WALK_IN - 16;
const ROOF_OUT = OY + 16;
add(block(-OX, OX, ROOF_IN, ROOF_OUT, WALL_TOP, ROOF_TOP, 'roof'));
add(block(-OX, OX, -ROOF_OUT, -ROOF_IN, WALL_TOP, ROOF_TOP, 'roof'));
// Coping on the west and east walls (between the roofs).
add(block(-OX - 8, -IX + 8, -ROOF_IN, ROOF_IN, WALL_TOP, WALL_TOP + 16, 'coping'));
add(block(IX - 8, OX + 8, -ROOF_IN, ROOF_IN, WALL_TOP, WALL_TOP + 16, 'coping'));

// --- Wall-walks and stairs -------------------------------------------------------------------
const walkN = add(block(-IX, IX, WALK_IN, IY, WALK - 16, WALK, 'deck'));
const walkS = add(block(-IX, IX, -IY, -WALK_IN, WALK - 16, WALK, 'deck'));
/** Stair flights: x span, 8 steps of 16 × 32 from y = ±256 up to the deck edge. */
const STAIR_NW = { x0: -640, x1: -512 };
const STAIR_SE = { x0: 512, x1: 640 };
const stairsNW = addAll(
	stairs({ foot: { x: (STAIR_NW.x0 + STAIR_NW.x1) / 2, y: WALK_IN - 256 }, dir: '+y', steps: 8, width: 128, rise: 16, run: 32, material: 'deck' })
);
const stairsSE = addAll(
	stairs({ foot: { x: (STAIR_SE.x0 + STAIR_SE.x1) / 2, y: -WALK_IN + 256 }, dir: '-y', steps: 8, width: 128, rise: 16, run: 32, material: 'deck' })
);
// Roof posts on the deck's inner edge (not at the stair landings).
const ROOF_POSTS = [-384, -128, 128, 384, 640];
for (const x of ROOF_POSTS) {
	add(block(x - 8, x + 8, WALK_IN, WALK_IN + 16, WALK, WALL_TOP, 'timber'));
	add(block(-x - 8, -x + 8, -WALK_IN - 16, -WALK_IN, WALK, WALL_TOP, 'timber'));
}
// Corbels under the decks on the wall face (clear of the openings, above head height).
for (const x of [-640, -448, -128, 192, 640]) {
	add(block(x - 12, x + 12, IY - 24, IY, 80, WALK - 16, 'timber'));
	add(block(-x - 12, -x + 12, -IY, -IY + 24, 80, WALK - 16, 'timber'));
}
// Lanterns on the inner faces of the west and east walls, and under the roofs.
for (const y of [-448, 0, 448]) {
	add(block(-IX, -IX + 10, y - 8, y + 8, 152, 184, 'lantern'));
	add(block(IX - 10, IX, y - 8, y + 8, 152, 184, 'lantern'));
}
for (const x of [-256, 256]) {
	add(block(x - 8, x + 8, WALK_IN + 40, WALK_IN + 56, WALL_TOP - 40, WALL_TOP, 'lantern'));
	add(block(x - 8, x + 8, -WALK_IN - 56, -WALK_IN - 40, WALL_TOP - 40, WALL_TOP, 'lantern'));
}

// --- Yard -------------------------------------------------------------------------------------
// Covered well: stone ring, four posts, a little roof (well above head height).
add(block(-64, 64, -64, 64, 0, 40, 'well'));
for (const [x, y] of [
	[-56, -56],
	[56, -56],
	[-56, 56],
	[56, 56]
] as const)
	add(pillar(x, y, 12, 40, 136, 'timber'));
add(block(-88, 88, -88, 88, 136, 152, 'roof'));
// Hay bales and crate stacks between the well and the yard ring (cover).
add(block(176, 272, 192, 256, 0, 48, 'hay'));
add(block(192, 256, 192, 256, 48, 96, 'hay'));
add(block(-272, -176, -256, -192, 0, 48, 'hay'));
add(block(-256, -192, 160, 224, 0, 64, 'crate'));
add(block(192, 256, -224, -160, 0, 64, 'crate'));
add(block(192, 240, -160, -112, 0, 40, 'crate'));
// Corners: bales in the south-west, a hay cart in the north-east (under the deck).
add(block(-760, -600, -600, -520, 0, 48, 'hay'));
add(block(-760, -680, -520, -440, 0, 48, 'hay'));
add(block(560, 720, 456, 552, 0, 56, 'cart'));
add(block(576, 704, 472, 536, 56, 88, 'hay'));

// --- Fields -------------------------------------------------------------------------------------
// Hedgerow round the fields (the map boundary).
add(block(-GX, GX, FY, GY, 0, 256, 'hedge'));
add(block(-GX, GX, -GY, -FY, 0, 256, 'hedge'));
add(block(-GX, -FX, -FY, FY, 0, 256, 'hedge'));
add(block(FX, GX, -FY, FY, 0, 256, 'hedge'));

/** Orchard tree: trunk, canopy and a smaller crown (the canopy starts above head height). */
function tree(x: number, y: number, h = 128): void {
	add(pillar(x, y, 24, 0, h, 'bark'));
	add(block(x - 88, x + 88, y - 88, y + 88, h, h + 112, 'leaves'));
	add(block(x - 56, x + 56, y - 56, y + 56, h + 112, h + 176, 'leaves'));
}
for (const [x, y] of [
	[-1600, 1280],
	[-1856, 1280],
	[-1344, 1536],
	[-1600, 1536],
	[-1856, 1536],
	[-1472, 1856],
	[-1728, 1856],
	[-2048, 1792]
] as const)
	tree(x, y);
// Lone trees by the hedge.
tree(2304, -2240, 160);
tree(-2304, -2048, 144);
tree(1216, 2304, 160);

// Windmill (NE): stone tower, cap, sails facing the farm.
const MILL = { x: 1728, y: 1600 };
add(block(MILL.x - 112, MILL.x + 112, MILL.y - 112, MILL.y + 112, 0, 448, 'millStone'));
add(block(MILL.x - 136, MILL.x + 136, MILL.y - 136, MILL.y + 136, 448, 496, 'roof'));
add(block(MILL.x - 72, MILL.x + 72, MILL.y - 72, MILL.y + 72, 496, 544, 'roof'));
add(block(MILL.x - 24, MILL.x + 24, MILL.y - 160, MILL.y - 112, 360, 408, 'timber')); // hub
const SAIL = { y0: MILL.y - 152, y1: MILL.y - 136 };
add(block(MILL.x - 16, MILL.x + 16, SAIL.y0, SAIL.y1, 408, 720, 'sail')); // up
add(block(MILL.x - 16, MILL.x + 16, SAIL.y0, SAIL.y1, 64, 360, 'sail')); // down
add(block(MILL.x - 336, MILL.x - 24, SAIL.y0, SAIL.y1, 368, 400, 'sail')); // left
add(block(MILL.x + 24, MILL.x + 336, SAIL.y0, SAIL.y1, 368, 400, 'sail')); // right
add(block(MILL.x - 48, MILL.x + 48, MILL.y - 120, MILL.y - 112, 0, 112, 'timber')); // door

// Haystacks (SE).
for (const [x, y] of [
	[1408, -1408],
	[1664, -1216],
	[1600, -1664]
] as const) {
	add(block(x - 96, x + 96, y - 64, y + 64, 0, 96, 'hay'));
	add(block(x - 72, x + 72, y - 48, y + 48, 96, 160, 'hay'));
}
// Shed (E): timber walls under a roof.
add(block(1408, 1664, -96, 96, 0, 160, 'shed'));
add(block(1392, 1680, -112, 112, 160, 176, 'roof'));
// Abandoned cart on the farm track, a scarecrow in the north field.
add(block(-320, -176, -1600, -1504, 0, 56, 'cart'));
add(pillar(960, 1344, 12, 0, 144, 'timber'));
add(block(904, 954, 1338, 1350, 112, 124, 'timber')); // arms either side of the post
add(block(966, 1016, 1338, 1350, 112, 124, 'timber'));
add(block(948, 972, 1332, 1356, 144, 176, 'hay'));
// Lamps by the gate and at the field corners of the yard.
for (const [x, y] of [
	[-176, -768],
	[176, -768],
	[-880, 1072],
	[880, -1072]
] as const) {
	add(pillar(x, y, 12, 0, 160, 'timber'));
	add(block(x - 10, x + 10, y - 10, y + 10, 160, 184, 'lantern'));
}

// --- Nav graph ---------------------------------------------------------------------------------
const nodes: Vec3[] = [];
const names = new Map<string, number>();
const node = (name: string, x: number, y: number, z = 0): number => {
	if (names.has(name)) throw new Error(`defense_blackthorn: duplicate nav node ${name}`);
	names.set(name, nodes.length);
	nodes.push(v3(x, y, z));
	return nodes.length - 1;
};
const links: [number, number][] = [];
const link = (a: string, b: string): void => {
	const i = names.get(a);
	const j = names.get(b);
	if (i === undefined || j === undefined) throw new Error(`defense_blackthorn: unknown nav node ${i === undefined ? a : b}`);
	links.push([i, j]);
};

/** Nav ring 192 outside the walls. */
const RX = OX + 192;
const RY = OY + 192;
/** Opening nodes: 64 outside the outer face, 80 inside the inner face. */
const OUT = 64;
const IN = 80;

const openings: DefenseOpening[] = [];
/** Ring nodes per side (along-wall coordinate), corners added separately. */
const ringU: Record<Side, number[]> = { north: [-640, 640], south: [-640, 640], west: [-480, 480], east: [-480, 480] };
for (const s of OPENING_SPECS) {
	const c = (s.a + s.b) / 2;
	ringU[s.side].push(c);
	const [ox, oy, ix, iy] =
		s.side === 'north'
			? [c, OY + OUT, c, IY - IN]
			: s.side === 'south'
				? [c, -OY - OUT, c, -IY + IN]
				: s.side === 'west'
					? [-OX - OUT, c, -IX + IN, c]
					: [OX + OUT, c, IX - IN, c];
	const outside = node(`out_${s.id}`, ox, oy);
	const inside = node(`in_${s.id}`, ix, iy);
	const o = wallBox(s.side, s.a, s.b, s.z0, s.z1, '');
	openings.push({ id: s.id, name: s.name, min: o.min, max: o.max, outside, inside, ...(s.planks ? { planks: s.planks } : {}) });
	link(`out_${s.id}`, `in_${s.id}`);
}
// Outside ring, walked round anticlockwise from the north-east corner.
node('ring_ne', RX, RY);
node('ring_nw', -RX, RY);
node('ring_sw', -RX, -RY);
node('ring_se', RX, -RY);
const ringName = (side: Side, u: number) => `ring_${side}_${u}`;
const ringPos = (side: Side, u: number): [number, number] =>
	side === 'north' ? [u, RY] : side === 'south' ? [u, -RY] : side === 'west' ? [-RX, u] : [RX, u];
const ringOrder: string[] = [];
const sideRun = (side: Side, desc: boolean) => [...ringU[side]].sort((p, q) => (desc ? q - p : p - q));
ringOrder.push('ring_ne');
for (const u of sideRun('north', true)) ringOrder.push(ringName('north', u));
ringOrder.push('ring_nw');
for (const u of sideRun('west', true)) ringOrder.push(ringName('west', u));
ringOrder.push('ring_sw');
for (const u of sideRun('south', false)) ringOrder.push(ringName('south', u));
ringOrder.push('ring_se');
for (const u of sideRun('east', false)) ringOrder.push(ringName('east', u));
for (const side of ['north', 'south', 'west', 'east'] as const)
	for (const u of ringU[side]) node(ringName(side, u), ...ringPos(side, u));
for (let i = 0; i < ringOrder.length; i++) link(ringOrder[i]!, ringOrder[(i + 1) % ringOrder.length]!);
for (const s of OPENING_SPECS) link(`out_${s.id}`, ringName(s.side, (s.a + s.b) / 2));

// Spawn areas: two per side, ~1100 out from the walls, each feeding a ring node.
const spawnZones: DefenseSpawnZone[] = [];
const ZONE_DIST = 1824; // inner edge (from the base centre) along y; x sides add 64
for (const side of ['north', 'south', 'west', 'east'] as const) {
	for (const u of [-1, 1].map((k) => k * (side === 'north' || side === 'south' ? 640 : 480))) {
		const name = `spawn_${side}_${u}`;
		let min: Vec3;
		let max: Vec3;
		let at: [number, number];
		if (side === 'north' || side === 'south') {
			const sgn = side === 'north' ? 1 : -1;
			const y0 = sgn * ZONE_DIST;
			const y1 = sgn * (ZONE_DIST + 192);
			min = v3(u - 128, Math.min(y0, y1), 0);
			max = v3(u + 128, Math.max(y0, y1), 128);
			at = [u, sgn * (ZONE_DIST - 48)];
		} else {
			const sgn = side === 'east' ? 1 : -1;
			const x0 = sgn * (ZONE_DIST + 64);
			const x1 = sgn * (ZONE_DIST + 256);
			min = v3(Math.min(x0, x1), u - 128, 0);
			max = v3(Math.max(x0, x1), u + 128, 128);
			at = [sgn * (ZONE_DIST + 16), u];
		}
		const n = node(name, at[0], at[1]);
		link(name, ringName(side, u));
		spawnZones.push({ min, max, node: n });
	}
}

// Inside: an octagon round the well, the stair flights, the wall-walks.
const C = 400;
const yard: Array<[string, number, number]> = [
	['yard_n', 0, C],
	['yard_ne', C, C],
	['yard_e', C, 0],
	['yard_se', C, -C],
	['yard_s', 0, -C],
	['yard_sw', -C, -C],
	['yard_w', -C, 0],
	['yard_nw', -C, C]
];
for (const [n, x, y] of yard) node(n, x, y);
for (let i = 0; i < yard.length; i++) link(yard[i]![0], yard[(i + 1) % yard.length]![0]);
const STAIR_X = { nw: (STAIR_NW.x0 + STAIR_NW.x1) / 2, se: (STAIR_SE.x0 + STAIR_SE.x1) / 2 };
node('stair_nw_foot', STAIR_X.nw, 208);
node('stair_nw_top', STAIR_X.nw, WALK_IN + 32, WALK);
node('stair_se_foot', STAIR_X.se, -208);
node('stair_se_top', STAIR_X.se, -WALK_IN - 32, WALK);
link('stair_nw_foot', 'stair_nw_top');
link('stair_se_foot', 'stair_se_top');
const WALK_Y = 600;
const walkNodes = (tag: string, sgn: number, xs: number[]) => {
	const ns = xs.map((x) => node(`walk_${tag}_${x}`, x, sgn * WALK_Y, WALK));
	for (let i = 1; i < ns.length; i++) links.push([ns[i - 1]!, ns[i]!]);
	return ns;
};
walkNodes('n', 1, [-704, STAIR_X.nw, -256, 256, 704]);
walkNodes('s', -1, [-704, -256, 256, STAIR_X.se, 704]);
link('stair_nw_top', `walk_n_${STAIR_X.nw}`);
link('stair_se_top', `walk_s_${STAIR_X.se}`);
// Opening insides into the yard.
link('in_north_door', 'yard_nw');
link('in_north_door', 'yard_n');
link('in_north_window', 'yard_ne');
link('in_north_window', 'yard_n');
link('in_south_gate', 'yard_s');
link('in_south_gate', 'yard_sw');
link('in_south_gate', 'yard_se');
link('in_south_window', 'yard_sw');
link('in_west_door', 'yard_w');
link('in_west_door', 'yard_sw');
link('in_west_window', 'yard_w');
link('in_west_window', 'stair_nw_foot');
link('in_east_door', 'yard_e');
link('in_east_door', 'yard_ne');
link('in_east_window', 'yard_e');
link('in_east_window', 'stair_se_foot');
link('stair_nw_foot', 'yard_w');
link('stair_se_foot', 'yard_e');

const nav = { nodes, links };

// --- Turret pads --------------------------------------------------------------------------------
const pad = (id: string, x: number, y: number, z: number, yaw: number): DefensePad => ({ id, pos: v3(x, y, z), yaw });
const pads: DefensePad[] = [
	pad('pad_walk_nw', -256, WALK_IN + 24, WALK, -90),
	pad('pad_walk_ne', 256, WALK_IN + 24, WALK, -90),
	pad('pad_walk_sw', -256, -WALK_IN - 24, WALK, 90),
	pad('pad_walk_se', 256, -WALK_IN - 24, WALK, 90),
	pad('pad_west', -576, 0, 0, 180),
	pad('pad_east', 576, 0, 0, 0),
	pad('pad_north', 0, 256, 0, 90),
	pad('pad_south', 0, -256, 0, -90)
];

// --- Player spawns (round the well, facing out) ------------------------------------------------
const spawns: Spawn[] = (
	[
		[-128, 160, 135],
		[128, 160, 45],
		[-128, -160, -135],
		[128, -160, -45],
		[-288, 0, 180],
		[288, 0, 0],
		[0, 144, 90],
		[0, -144, -90]
	] as const
).map(([x, y, yaw]) => ({ pos: v3(x, y, 0), yaw }));

const defense: DefenseMapInfo = { openings, pads, spawnZones, nav };

const brushes = [...boxes];
const zones: Zone[] = [teleportBelow(brushes, boundsOf(brushes).min.z, 'start', 512, 2048)];

// --- Theme: harvest-moon dusk over the fields -----------------------------------------------------
const theme: Theme = {
	skyTop: 0x16162e,
	skyHorizon: 0xc8683a,
	skyBottom: 0x3a2a30,
	fogColor: 0x4c3c44,
	fogNear: 900,
	fogFar: 7600,
	sunColor: 0xffa060,
	sunIntensity: 0.8,
	sunDir: v3(-0.55, 0.62, 0.22),
	ambientSky: 0x7c80a8,
	ambientGround: 0x4a3a2a,
	ambientIntensity: 0.62,
	materials: {
		grass: { color: 0x3e4a2a, topColor: 0x4a5a30, noise: 0.24, noiseScale: 96, roughness: 0.95 },
		track: { color: 0x6a5238, topColor: 0x76603f, noise: 0.22, noiseScale: 48, roughness: 0.95 },
		yard: { color: 0x5e584e, topColor: 0x6e675a, noise: 0.28, noiseScale: 24, roughness: 0.95 },
		stone: { color: 0x7a7266, topColor: 0x6a645a, noise: 0.24, noiseScale: 40, roughness: 0.92 },
		sill: { color: 0x5a544c, topColor: 0x645e54, noise: 0.18, noiseScale: 32, roughness: 0.9 },
		lintel: { color: 0x3e3428, topColor: 0x4a3e30, noise: 0.22, noiseScale: 32, roughness: 0.9 },
		coping: { color: 0x58524a, topColor: 0x4e4a44, noise: 0.16, noiseScale: 64, roughness: 0.9 },
		roof: { color: 0x5a3026, topColor: 0x6e3a2c, noise: 0.2, noiseScale: 24, roughness: 0.85 },
		deck: { color: 0x5e4630, topColor: 0x6e5238, noise: 0.25, noiseScale: 40, roughness: 0.9 },
		timber: { color: 0x3e2e20, topColor: 0x4a3828, noise: 0.22, noiseScale: 48, roughness: 0.9 },
		well: { color: 0x6c665c, topColor: 0x3a4652, noise: 0.26, noiseScale: 24, roughness: 0.9 },
		hay: { color: 0xb08a40, topColor: 0xc49a4a, noise: 0.3, noiseScale: 16, roughness: 0.95 },
		crate: { color: 0x7c6040, topColor: 0x8c6e4a, edgeColor: 0x3a2a18, noise: 0.25, noiseScale: 32, roughness: 0.9 },
		cart: { color: 0x5a3e28, topColor: 0x664830, edgeColor: 0x2a1e14, noise: 0.22, noiseScale: 32, roughness: 0.9 },
		shed: { color: 0x4e4234, topColor: 0x5a4c3c, noise: 0.24, noiseScale: 32, roughness: 0.9 },
		hedge: { color: 0x22301c, topColor: 0x2c3c22, noise: 0.35, noiseScale: 48, roughness: 0.95 },
		bark: { color: 0x3a2a1e, noise: 0.25, noiseScale: 24, roughness: 0.95 },
		leaves: { color: 0x34461e, topColor: 0x4a5a26, noise: 0.35, noiseScale: 40, roughness: 0.95 },
		millStone: { color: 0x8a8274, topColor: 0x787064, noise: 0.22, noiseScale: 48, roughness: 0.9 },
		sail: { color: 0xc8bea4, topColor: 0xb4aa92, edgeColor: 0x3e2e20, noise: 0.12, noiseScale: 64, roughness: 0.8 },
		lantern: { color: 0x2a2420, edgeColor: 0xffb45a, seamColor: 0xffa040, noise: 0.05, noiseScale: 64, roughness: 0.5 }
	},
	effects: [
		{ type: 'clouds', color: 0x6a5a66, count: 24, height: 3000 },
		// Fireflies over the yard and the near fields.
		{ type: 'embers', color: 0xffd27a, count: 90, area: { min: v3(-1600, -1600, 16), max: v3(1600, 1600, 240) } }
	]
};

export const defense_blackthorn: MapDef = {
	id: 'defense_blackthorn',
	title: 'Blackthorn Farm',
	kind: 'defense',
	difficulty: 'easy',
	layout: 'open',
	cvars: {},
	spawn: spawns[0]!,
	spawns,
	defense,
	brushes,
	zones,
	theme
};

/** Design data for the map tests. */
export const BLACKTHORN = {
	/** Inner and outer faces of the base walls. */
	inner: { min: v3(-IX, -IY, 0), max: v3(IX, IY, 0) } as Box3,
	outer: { min: v3(-OX, -OY, 0), max: v3(OX, OY, 0) } as Box3,
	/** Inner faces of the hedgerow round the fields. */
	fields: { min: v3(-FX, -FY, 0), max: v3(FX, FY, 0) } as Box3,
	slot: { bottom: SLOT_BOTTOM, top: SLOT_TOP },
	wallTop: WALL_TOP,
	walk: WALK,
	walks: [walkN, walkS],
	stairs: [stairsNW, stairsSE],
	ground,
	/** Nav node index by name. */
	nodes: names
};
