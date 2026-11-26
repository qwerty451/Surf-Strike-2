/**
 * Zombie AI on the real Blackthorn Farm map: zombies get in and reach a
 * player wherever they stand, also up on the wall-walks (stairs, not a
 * straight line off the side of the flight).
 */
import { describe, expect, it } from 'vitest';
import { buildCollisionWorld } from '../../collision/world.ts';
import { MAPS } from '../../maps/index.ts';
import { mapCvars } from '../index.ts';
import { DefenseGame } from './game.ts';

const map = MAPS.find((m) => m.id === 'defense_blackthorn')!;
const world = buildCollisionWorld(map);
const nodes = map.defense!.nav.nodes;
const STEP = 1000 / 32;

/** Seconds until an idle player standing at `pos` is first hit in wave 1, or null within `secs`. */
function firstHit(pos: { x: number; y: number; z: number }, secs = 75): number | null {
	let now = 1_000_000;
	let seed = 11;
	const g = new DefenseGame({
		map,
		world,
		cvars: mapCvars(map),
		now,
		rng: () => (seed = (seed * 16807) % 2147483647) / 2147483647,
		firstBuildSecs: 1,
		buildSecs: 1,
		earlyTear: []
	});
	const at = { ...pos, z: pos.z + 0.25, ducked: false };
	g.syncPlayers([1], now);
	g.update(now);
	for (let t = 0; t < secs * 1000; t += STEP) {
		now += STEP;
		g.setPlayerPos(1, at);
		if (g.update(now).some((e) => e.e === 'hurt')) return t / 1000;
	}
	return null;
}

describe('Blackthorn Farm AI', () => {
	const decks = nodes.filter((n) => n.z >= 120);
	it('has wall-walk nav nodes', () => expect(decks.length).toBeGreaterThanOrEqual(8));
	for (const n of decks) {
		it(`zombies reach a player on the wall-walk at ${n.x}, ${n.y}`, () => {
			expect(firstHit(n)).not.toBeNull();
		});
	}
	it('zombies reach a player in the yard', () => {
		expect(firstHit(map.spawns![0]!.pos)).not.toBeNull();
	});
});
