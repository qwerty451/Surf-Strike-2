import { describe, expect, it } from 'vitest';
import type { KillFeedLine } from './contract.js';
import {
	ammoText,
	forwardDir,
	KILL_FEED_MAX,
	KILL_FEED_MS,
	liveKillFeed,
	loadoutChoices,
	pushKillFeed,
	reloadProgress,
	slotAction,
	spreadDir
} from './zombies-view.js';

describe('zombies weapon keys', () => {
	it('1-4 pick a weapon in the loadout window', () => {
		expect(slotAction(1, true)).toEqual({ kind: 'weapon', weapon: 'lmg' });
		expect(slotAction(2, true)).toEqual({ kind: 'weapon', weapon: 'pistol' });
		expect(slotAction(3, true)).toEqual({ kind: 'weapon', weapon: 'knife' });
		expect(slotAction(4, true)).toEqual({ kind: 'weapon', weapon: 'sniper' });
		expect(slotAction(2, false)).toBeNull(); // window closed
		expect(slotAction(9, true)).toBeNull();
	});

	it('loadout choices list the four weapons in key order', () => {
		const c = loadoutChoices();
		expect(c.map((x) => x.slot)).toEqual([1, 2, 3, 4]);
		expect(c.map((x) => x.hits)).toEqual(['8 hits', '4 hits', '1 hit', '1 hit']);
	});
});

describe('zombies HUD logic', () => {
	it('ammo text and low-ammo warning; melee shows a dash', () => {
		expect(ammoText(12, 12, 84)).toEqual({ mag: '12', reserve: '84', low: false });
		expect(ammoText(2, 12, 84).low).toBe(true);
		expect(ammoText(0, 0, 0)).toEqual({ mag: '—', reserve: '', low: false });
	});

	it('reload progress', () => {
		expect(reloadProgress(1000, 0, 1500)).toBe(1);
		expect(reloadProgress(1000, 1750, 1500)).toBeCloseTo(0.5);
		expect(reloadProgress(2000, 1750, 1500)).toBe(1);
	});

	it('kill feed keeps the newest few lines and drops old ones', () => {
		let feed: KillFeedLine[] = [];
		for (let i = 0; i < 8; i++) feed = pushKillFeed(feed, { id: i, text: `k${i}`, head: false, mine: false, at: i * 100 }, i * 100);
		expect(feed.length).toBe(KILL_FEED_MAX);
		expect(feed[0]!.id).toBe(7);
		expect(liveKillFeed(feed, 700 + KILL_FEED_MS).length).toBe(0);
	});

	it('aim direction and spread', () => {
		const f = forwardDir(0, 90);
		expect(f.x).toBeCloseTo(0);
		expect(f.y).toBeCloseTo(1);
		expect(forwardDir(89, 0).z).toBeLessThan(-0.99); // pitch + = down
		let seed = 1;
		const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		for (let i = 0; i < 50; i++) {
			const d = spreadDir({ x: 1, y: 0, z: 0 }, 2, rng);
			expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1);
			expect((Math.acos(d.x) * 180) / Math.PI).toBeLessThanOrEqual(2.0001);
		}
		expect(spreadDir({ x: 0, y: 1, z: 0 }, 0)).toEqual({ x: 0, y: 1, z: 0 });
	});
});
