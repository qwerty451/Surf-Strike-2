/**
 * A tiny Zombie Defense arena for tests and offline development (not in the
 * map rotation): a square base (1024 × 1024 inside, walls 32 thick and 192
 * high) on a flat floor, one door-sized opening in the middle of every wall,
 * four turret pads, four spawn zones 1600 units out and a 17-node nav graph.
 *
 * Nav nodes: 0 centre; 1-4 inside N/E/S/W; 5-8 outside N/E/S/W; 9-12 spawn
 * N/E/S/W; 13-16 corners NE/SE/SW/NW (outside, linking the outside nodes).
 */
import type { BrushDef, DefenseOpening, MapDef } from '../../maps/types.ts';
import type { Vec3 } from '../../types.ts';

/** Half the inside width of the fixture base; walls run from here to +32. */
export const FIXTURE_HALF = 512;
const WALL = 32;
const HEIGHT = 192;
const DOOR_HALF = 48;
const DOOR_TOP = 128;

const SIDES = [
	{ id: 'north', dx: 0, dy: 1, yaw: 90 },
	{ id: 'east', dx: 1, dy: 0, yaw: 0 },
	{ id: 'south', dx: 0, dy: -1, yaw: -90 },
	{ id: 'west', dx: -1, dy: 0, yaw: 180 }
] as const;

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

export function defenseFixtureMap(id = 'defense_fixture'): MapDef {
	const H = FIXTURE_HALF;
	const O = H + WALL;
	const box = (min: Vec3, max: Vec3, material = 'wall'): BrushDef => ({ type: 'box', min, max, material });
	const brushes: BrushDef[] = [box(v(-2600, -2600, -64), v(2600, 2600, 0), 'floor')];
	// North/south walls span the corners; east/west walls fit between them.
	for (const sy of [1, -1]) {
		const y0 = sy > 0 ? H : -O;
		const y1 = sy > 0 ? O : -H;
		brushes.push(box(v(-O, y0, 0), v(-DOOR_HALF, y1, HEIGHT)), box(v(DOOR_HALF, y0, 0), v(O, y1, HEIGHT)));
		brushes.push(box(v(-DOOR_HALF, y0, DOOR_TOP), v(DOOR_HALF, y1, HEIGHT)));
	}
	for (const sx of [1, -1]) {
		const x0 = sx > 0 ? H : -O;
		const x1 = sx > 0 ? O : -H;
		brushes.push(box(v(x0, -H, 0), v(x1, -DOOR_HALF, HEIGHT)), box(v(x0, DOOR_HALF, 0), v(x1, H, HEIGHT)));
		brushes.push(box(v(x0, -DOOR_HALF, DOOR_TOP), v(x1, DOOR_HALF, HEIGHT)));
	}

	const nodes: Vec3[] = [v(0, 0)];
	for (const s of SIDES) nodes.push(v(s.dx * 400, s.dy * 400));
	for (const s of SIDES) nodes.push(v(s.dx * 640, s.dy * 640));
	for (const s of SIDES) nodes.push(v(s.dx * 1600, s.dy * 1600));
	nodes.push(v(900, 900), v(900, -900), v(-900, -900), v(-900, 900));
	const links: [number, number][] = [];
	for (let k = 0; k < 4; k++) links.push([0, 1 + k], [1 + k, 5 + k], [5 + k, 9 + k]);
	links.push([13, 5], [13, 6], [14, 6], [14, 7], [15, 7], [15, 8], [16, 8], [16, 5]);

	const openings: DefenseOpening[] = SIDES.map((s, k) => {
		const along = s.dx === 0;
		const min = along ? v(-DOOR_HALF, s.dy > 0 ? H : -O, 0) : v(s.dx > 0 ? H : -O, -DOOR_HALF, 0);
		const max = along ? v(DOOR_HALF, s.dy > 0 ? O : -H, DOOR_TOP) : v(s.dx > 0 ? O : -H, DOOR_HALF, DOOR_TOP);
		return { id: `${s.id}_door`, name: `${s.id} door`, min, max, outside: 5 + k, inside: 1 + k, ...(k === 3 ? { planks: 4 } : {}) };
	});

	return {
		id,
		title: 'Defense Fixture',
		kind: 'defense',
		difficulty: 'easy',
		layout: 'open',
		cvars: {},
		spawn: { pos: v(0, 0), yaw: 0 },
		spawns: [
			{ pos: v(96, 96), yaw: 45 },
			{ pos: v(-96, 96), yaw: 135 },
			{ pos: v(-96, -96), yaw: -135 },
			{ pos: v(96, -96), yaw: -45 }
		],
		defense: {
			openings,
			pads: [
				{ id: 'pad_ne', pos: v(256, 256), yaw: 45 },
				{ id: 'pad_se', pos: v(256, -256), yaw: -45 },
				{ id: 'pad_sw', pos: v(-256, -256), yaw: -135 },
				{ id: 'pad_nw', pos: v(-256, 256), yaw: 135 }
			],
			spawnZones: SIDES.map((s, k) => ({
				min: v(s.dx * 1600 - 64, s.dy * 1600 - 64, 0),
				max: v(s.dx * 1600 + 64, s.dy * 1600 + 64, 128),
				node: 9 + k
			})),
			nav: { nodes, links }
		},
		brushes,
		zones: [],
		theme: {
			skyTop: 0x1a2030,
			skyHorizon: 0x404860,
			skyBottom: 0x202020,
			fogColor: 0x404860,
			fogNear: 2000,
			fogFar: 8000,
			sunColor: 0xffffff,
			sunIntensity: 1,
			sunDir: { x: 0.3, y: 0.2, z: 1 },
			ambientSky: 0x808080,
			ambientGround: 0x404040,
			ambientIntensity: 1,
			materials: {},
			effects: []
		}
	};
}
