import { describe, expect, it } from 'vitest';
import { getMap, mapCvars, type ZmStateView } from '@surf/shared';
import { ZombiesClient, type ZmHost } from './zombies.js';

const host = {
	online: () => true,
	selfId: () => 7,
	send: () => {},
	zombieRenderer: () => null,
	name: () => '',
	notice: () => {},
	teleport: () => {},
	sound: () => {},
	setZoom: () => {},
	push: () => {}
} satisfies ZmHost;

const state = (phase: ZmStateView['phase'], elapsed: number): ZmStateView => ({
	phase, round: 1, timeLeft: 0, elapsed, checkpoint: 0, checkpoints: 5, progress: 0, zombies: 0, kills: 0, gates: [], players: []
});

describe('Zombie Run HUD', () => {
	it('the round clock is right for a player who joins mid-round, right after loading the page', () => {
		const map = getMap('zombies_lowtide')!;
		const c = new ZombiesClient(host, map, mapCvars(map), 5000);
		c.onModeState(state('playing', 100), 5000);
		expect(c.frame(5000, false, 0).startedAt).toBe(-95_000);
		c.onModeState(state('countdown', 0), 6000);
		expect(c.frame(6000, false, 0).startedAt).toBeNull();
	});
});
