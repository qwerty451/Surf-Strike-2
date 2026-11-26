/**
 * tournament_orangery — the first Tournament map (docs/modes.md#tournament).
 * An old garden orangery at dusk: a pale limestone hall with a terracotta
 * floor, white cast-iron columns and planters of orange trees, closed by a
 * glass roof on iron ribs. Two duelists fight in the hall; everyone else
 * stands on the glass roof (the deck) and watches from above.
 *
 * Point-symmetric through the centre: every brush has a twin at (−x, −y)
 * with the same size and material (centre pieces are their own twin), so
 * neither side has an advantage. Duelist A spawns west facing east,
 * duelist B east facing west.
 *
 * Hall 1536 × 1024 (x [−768, 768], y [−512, 512]), floor top z = 0. Cover:
 *
 *   C   Fountain: a 192 × 192 basin (rim 40) with a shallow pool and an iron
 *       column up to the roof ribs; it blocks the spawn-to-spawn sightline.
 *   W/E Spawn planters (hedge top 56) in front of each spawn.
 *   NW/SE Raised terrace (96) in a corner with a jump step (48) and a stone
 *       balustrade (top 128).
 *   Four iron columns (to the roof) on stone plinths; two crate stacks
 *       (32 / 64 / 96) on the flanks; low walls (48); long hedge planters
 *       (72) by the long walls; potted orange trees (canopies 104–184: a
 *       head bonks under them from the pot, but a running jump from the
 *       balustrade lands on top, the highest cover).
 *
 * Roof: iron ribs (z 432–448) under one glass slab (448–464) that spans
 * the hall from wall to wall. The highest cover is 184 (wall lanterns at
 * 256 are the highest tops of all), so a crouch jump from anything in the
 * hall (head ≤ ~394) stays under the ribs.
 *
 * Deck: the glass top (z 464), 1536 × 1024, closed by the walls (stone
 * parapet to 504), a glass rail and brass handrail to 600 and an invisible
 * clip to 848 over the whole wall footprint. A standing jump on the glass
 * rises ~66, so nobody gets near the rail top, and the glass is sealed into
 * the walls: spectators cannot get down and duelists cannot get up.
 *
 * Outside (decoration, unreachable): a lawn at −64 with hedges, cypresses
 * and pilasters on the walls.
 */
import type { MapDef, Spawn, Theme, TournamentMapInfo, Zone } from './types.ts';
import type { BoxBrush } from './helpers.ts';
import { v3 } from './helpers.ts';
import { block, yawTowards } from './tag-helpers.ts';

/** Half sizes of the hall interior (inner wall faces). */
export const HALF_X = 768;
export const HALF_Y = 512;
const WALL_T = 64;
/** Underside of the glass roof (= bottom of the iron ribs' glass). */
export const ROOF_BOTTOM = 448;
/** Top of the glass roof: the deck floor. */
export const ROOF_TOP = 464;
/** Bottom of the roof ribs hanging under the glass. */
export const RIB_BOTTOM = 432;
/** Stone parapet top (walls continue above the glass). */
const PARAPET = ROOF_TOP + 40;
/** Top of the glass rail; the brass handrail sits on it. */
const RAIL_GLASS_TOP = ROOF_TOP + 128;
export const RAIL_TOP = RAIL_GLASS_TOP + 8;
/** Top of the invisible clip over the wall footprint. */
export const CLIP_TOP = ROOF_TOP + 384;
/** Rail glass thickness (inner edge of the wall tops). */
const RAIL_T = 16;
/** Terrace balustrade top. */
const BALUSTRADE_TOP = 128;
/** Highest cover a duelist can stand on: the orange tree canopies, reached by a running jump from the balustrade. */
export const COVER_TOP = 184;

const boxes: BoxBrush[] = [];

/** Point mirror through the map centre: (x, y, z) → (−x, −y, z). */
export function mirrorBox(b: BoxBrush): BoxBrush {
	return { type: 'box', min: v3(-b.max.x, -b.max.y, b.min.z), max: v3(-b.min.x, -b.min.y, b.max.z), material: b.material, ...(b.solid === false ? { solid: false } : {}) };
}
/** Add a brush and its mirror twin. */
function pair(b: BoxBrush): void {
	boxes.push(b, mirrorBox(b));
}
/** Add a brush that is its own mirror twin (centred on the map centre). */
function self(b: BoxBrush): void {
	if (b.min.x !== -b.max.x || b.min.y !== -b.max.y) throw new Error('tournament_orangery: self brush is not centred');
	boxes.push(b);
}

// --- Floor and lawn ---------------------------------------------------------------
// Flagstone aisle along the duel axis, terracotta either side.
self(block(-HALF_X, HALF_X, -128, 128, -64, 0, 'flagstone'));
pair(block(-HALF_X, HALF_X, 128, HALF_Y, -64, 0, 'terracotta'));
// Lawn under the whole building (the walls stand on it).
self(block(-2560, 2560, -2560, 2560, -128, -64, 'lawn'));

// --- Walls, parapet, rail, clip ------------------------------------------------------
const OX = HALF_X + WALL_T;
const OY = HALF_Y + WALL_T;
// West / east walls span the corners; north / south walls fit between them.
pair(block(-OX, -HALF_X, -OY, OY, -64, PARAPET, 'wallStone'));
pair(block(-HALF_X, HALF_X, HALF_Y, OY, -64, PARAPET, 'wallStone'));
// Glass rail on the inner edge of the wall tops, brass handrail on it.
pair(block(-HALF_X - RAIL_T, -HALF_X, -HALF_Y - RAIL_T, HALF_Y + RAIL_T, PARAPET, RAIL_GLASS_TOP, 'railGlass'));
pair(block(-HALF_X, HALF_X, HALF_Y, HALF_Y + RAIL_T, PARAPET, RAIL_GLASS_TOP, 'railGlass'));
pair(block(-HALF_X - RAIL_T, -HALF_X, -HALF_Y - RAIL_T, HALF_Y + RAIL_T, RAIL_GLASS_TOP, RAIL_TOP, 'brass'));
pair(block(-HALF_X, HALF_X, HALF_Y, HALF_Y + RAIL_T, RAIL_GLASS_TOP, RAIL_TOP, 'brass'));
// Invisible clip: over the outer wall tops from the parapet, over the rail from the handrail.
pair(block(-OX, -HALF_X - RAIL_T, -OY, OY, PARAPET, CLIP_TOP, 'clip'));
pair(block(-HALF_X - RAIL_T, HALF_X + RAIL_T, HALF_Y + RAIL_T, OY, PARAPET, CLIP_TOP, 'clip'));
pair(block(-HALF_X - RAIL_T, -HALF_X, -HALF_Y - RAIL_T, HALF_Y + RAIL_T, RAIL_TOP, CLIP_TOP, 'clip'));
pair(block(-HALF_X, HALF_X, HALF_Y, HALF_Y + RAIL_T, RAIL_TOP, CLIP_TOP, 'clip'));
// Stone coping band along the outer face, just under the parapet (outside the hall).
pair(block(-OX - 16, -OX, -OY - 16, OY + 16, PARAPET - 24, PARAPET, 'coping'));
pair(block(-OX, OX, OY, OY + 16, PARAPET - 24, PARAPET, 'coping'));
// Exterior pilasters (between the lawn and the coping).
for (const x of [-512, -256, 0, 256, 512]) pair(block(x - 24, x + 24, OY, OY + 32, -64, PARAPET - 24, 'pilaster'));
for (const y of [-256, 0, 256]) pair(block(-OX - 32, -OX, y - 24, y + 24, -64, PARAPET - 24, 'pilaster'));

// --- Glass roof on iron ribs ---------------------------------------------------------
self(block(-HALF_X, HALF_X, -HALF_Y, HALF_Y, ROOF_BOTTOM, ROOF_TOP, 'glass'));
self(block(-8, 8, -HALF_Y, HALF_Y, RIB_BOTTOM, ROOF_BOTTOM, 'iron'));
for (const x of [-512, -256]) pair(block(x - 8, x + 8, -HALF_Y, HALF_Y, RIB_BOTTOM, ROOF_BOTTOM, 'iron'));
// Wall lanterns (tops at 256: even standing on one, a jump stays under the ribs).
for (const x of [-384, 384]) pair(block(x - 10, x + 10, HALF_Y - 14, HALF_Y, 224, 256, 'lantern'));
for (const y of [-256, 256]) pair(block(-HALF_X, -HALF_X + 14, y - 10, y + 10, 224, 256, 'lantern'));

// --- Centre: fountain and iron column -------------------------------------------------
pair(block(-96, 96, 80, 96, 0, 40, 'stone')); // north / south rim
pair(block(-96, -80, -80, 80, 0, 40, 'stone')); // west / east rim
self(block(-80, 80, -80, 80, 0, 8, 'water'));
self(block(-24, 24, -24, 24, 8, RIB_BOTTOM, 'column'));

// --- One side (west, duelist A); every piece gets its twin at (−x, −y) ------------------
// Spawn planter with a hedge top.
pair(block(-560, -528, -160, 160, 0, 32, 'planter'));
pair(block(-560, -528, -160, 160, 32, 56, 'hedge'));
// Raised terrace in the north-west corner, jump step, balustrade on its south edge.
pair(block(-HALF_X, -544, 288, HALF_Y, 0, 96, 'stone'));
pair(block(-544, -480, 352, 448, 0, 48, 'stone'));
pair(block(-736, -608, 288, 304, 96, BALUSTRADE_TOP, 'balustrade'));
// Iron columns on stone plinths (to the roof).
for (const y of [288, -288]) {
	pair(block(-360, -280, y - 40, y + 40, 0, 16, 'stone'));
	pair(block(-344, -296, y - 24, y + 24, 16, ROOF_BOTTOM, 'column'));
}
// Crate stack on the south flank: step 32, crate 64, small crate 96.
pair(block(-176, -144, -352, -304, 0, 32, 'crate'));
pair(block(-240, -176, -352, -288, 0, 64, 'crate'));
pair(block(-232, -184, -344, -296, 64, 96, 'crate'));
// Low wall south-west of the fountain.
pair(block(-432, -416, -224, -64, 0, 48, 'balustrade'));
// Long hedge planter by the north wall.
pair(block(-224, -96, 384, 448, 0, 40, 'planter'));
pair(block(-224, -96, 384, 448, 40, 72, 'hedge'));
// Potted orange trees: pot, trunk, canopy (too high to stand on, too low to jump over).
for (const [x, y] of [
	[-448, 160],
	[-576, -352]
] as const) {
	pair(block(x - 24, x + 24, y - 24, y + 24, 0, 40, 'pot'));
	pair(block(x - 8, x + 8, y - 8, y + 8, 40, 104, 'trunk'));
	pair(block(x - 48, x + 48, y - 48, y + 48, 104, COVER_TOP, 'foliage'));
}

// --- Deck: lamp posts in the corners ------------------------------------------------------
for (const [x, y] of [
	[-HALF_X, HALF_Y - 32],
	[HALF_X - 32, HALF_Y - 32]
] as const) {
	pair(block(x, x + 32, y, y + 32, ROOF_TOP, ROOF_TOP + 224, 'iron'));
	pair(block(x + 4, x + 28, y + 4, y + 28, ROOF_TOP + 224, ROOF_TOP + 256, 'lantern'));
}

// --- Garden outside (decoration) -----------------------------------------------------------
pair(block(-1024, 1024, 800, 864, -64, 32, 'hedge'));
pair(block(-1120, -1056, -640, 640, -64, 32, 'hedge'));
for (const [x, y] of [
	[-1280, 1024],
	[1280, 1024],
	[-1600, 320]
] as const) {
	pair(block(x - 12, x + 12, y - 12, y + 12, -64, 0, 'trunk'));
	pair(block(x - 56, x + 56, y - 56, y + 56, 0, 352, 'cypress'));
}

// --- Spawns (feet on the floor; the registry lifts them by SPAWN_CLEARANCE) ----------------
const duelA: Spawn = { pos: v3(-672, 0, 0), yaw: 0 };
const duelB: Spawn = { pos: v3(672, 0, 0), yaw: 180 };
const deckSpawns: Spawn[] = [];
for (const x of [-576, -192, 192, 576])
	for (const y of [-320, 0, 320]) {
		const pos = v3(x, y, ROOF_TOP);
		deckSpawns.push({ pos, yaw: yawTowards(pos, { x: 0, y: 0 }) });
	}

const tournament: TournamentMapInfo = {
	duelSpawns: [duelA, duelB],
	arena: { min: v3(-HALF_X + 16, -HALF_Y + 16, 0), max: v3(HALF_X - 16, HALF_Y - 16, ROOF_BOTTOM) },
	deck: { min: v3(-HALF_X + 16, -HALF_Y + 16, ROOF_TOP), max: v3(HALF_X - 16, HALF_Y - 16, RAIL_TOP) },
	deckSpawns
};

const brushes = [...boxes];
const zones: Zone[] = [];

// --- Theme: dusk over a walled garden --------------------------------------------------------
const theme: Theme = {
	skyTop: 0x27325e,
	skyHorizon: 0xf2a86c,
	skyBottom: 0x5c4256,
	fogColor: 0xd99a78,
	fogNear: 2400,
	fogFar: 9000,
	sunColor: 0xffb878,
	sunIntensity: 1.3,
	sunDir: v3(0.62, -0.38, 0.42),
	ambientSky: 0xb0bce0,
	ambientGround: 0x7a5a40,
	ambientIntensity: 0.7,
	materials: {
		terracotta: { color: 0xb0603c, topColor: 0xbe6c45, noise: 0.12, noiseScale: 64, roughness: 0.85 },
		flagstone: { color: 0xa8a090, topColor: 0xb6ad9b, noise: 0.1, noiseScale: 96, roughness: 0.9 },
		lawn: { color: 0x3f5f2e, topColor: 0x4a6c34, noise: 0.14, noiseScale: 192, roughness: 0.95 },
		wallStone: { color: 0xd8ccb4, topColor: 0xe0d5be, noise: 0.08, noiseScale: 192, roughness: 0.9 },
		coping: { color: 0xbfb39b, topColor: 0xc8bca4, edgeColor: 0x8a7f6a, noise: 0.06, noiseScale: 96, roughness: 0.85 },
		pilaster: { color: 0xcabda3, topColor: 0xd4c7ad, noise: 0.07, noiseScale: 128, roughness: 0.9 },
		stone: { color: 0xc9bea6, topColor: 0xd3c8b0, noise: 0.08, noiseScale: 128, roughness: 0.88 },
		balustrade: { color: 0xe2d8c4, topColor: 0xece2ce, edgeColor: 0xa89c84, noise: 0.06, noiseScale: 64, roughness: 0.8 },
		column: { color: 0xece8de, topColor: 0xf4f0e6, edgeColor: 0xb8b0a0, noise: 0.04, noiseScale: 64, roughness: 0.45 },
		iron: { color: 0xe6e2d8, topColor: 0xf0ece2, edgeColor: 0xa8a090, noise: 0.04, noiseScale: 64, roughness: 0.45 },
		brass: { color: 0xb08a3c, topColor: 0xc89c48, edgeColor: 0xffd27a, noise: 0.05, noiseScale: 32, roughness: 0.35 },
		glass: { color: 0xd4ecf2, glass: true, opacity: 0.2, edgeColor: 0xfff0d8, noise: 0, roughness: 0.1 },
		railGlass: { color: 0xd4ecf2, glass: true, opacity: 0.28, edgeColor: 0xfff0d8, noise: 0, roughness: 0.1 },
		planter: { color: 0x3a5440, topColor: 0x44604a, edgeColor: 0x24382a, noise: 0.06, noiseScale: 48, roughness: 0.7 },
		hedge: { color: 0x3b6630, topColor: 0x467538, noise: 0.18, noiseScale: 24, roughness: 0.95 },
		pot: { color: 0xb5653e, topColor: 0x8a4a2c, noise: 0.1, noiseScale: 32, roughness: 0.85 },
		trunk: { color: 0x5a4030, noise: 0.14, noiseScale: 16, roughness: 0.95 },
		foliage: { color: 0x4a7a36, topColor: 0x568a3e, seamColor: 0xffa030, noise: 0.18, noiseScale: 24, roughness: 0.95 },
		cypress: { color: 0x2c4a2a, topColor: 0x345632, noise: 0.16, noiseScale: 32, roughness: 0.95 },
		crate: { color: 0xa98250, topColor: 0xb8915e, edgeColor: 0x5e4122, noise: 0.12, noiseScale: 48, roughness: 0.85 },
		water: { color: 0x3f8aa0, topColor: 0x4c9ab0, opacity: 0.75, edgeColor: 0x9ad8e8, noise: 0.06, noiseScale: 64, roughness: 0.15 },
		lantern: { color: 0xffd58a, topColor: 0xffe2a8, edgeColor: 0xffc060, seamColor: 0xffb040, noise: 0.04, noiseScale: 16, roughness: 0.3 },
		/** Invisible clip over the wall tops (collision only). */
		clip: { color: 0xffffff, opacity: 0, noise: 0 }
	},
	effects: [
		{ type: 'clouds', color: 0xffd8c0, count: 14, height: 3200 },
		// Fireflies over the garden and in the hall.
		{ type: 'embers', color: 0xffe890, count: 70, area: { min: v3(-2000, -2000, -40), max: v3(2000, 2000, 600) } }
	]
};

export const tournament_orangery: MapDef = {
	id: 'tournament_orangery',
	title: 'Orangery',
	kind: 'tournament',
	difficulty: 'easy',
	layout: 'open',
	cvars: {},
	spawn: deckSpawns[0]!,
	spawns: deckSpawns,
	tournament,
	brushes,
	zones,
	theme
};
