import { describe, expect, it } from 'vitest';
import { HNS_SPEED_LIMIT, zdSpawnInterval, zdWaveCount } from './modes/index.ts';
import {
	applyMultiplier,
	AWARDS,
	awardLabel,
	decayed,
	DEFENSE_PAY,
	formatMultiplier,
	formatTenths,
	formatWhole,
	HNS_PAY,
	INFECTED_PAY,
	MIN_ACTIVE,
	modeMultiplier,
	MULTIPLIER_MODES,
	playerMultiplier,
	PLAYTIME,
	pts,
	RACE_PAY,
	SPEED_LIMIT,
	raceFinish,
	TAG_PAY,
	tagPlacements,
	ZOMBIES_PAY,
	type AwardDef
} from './economy.ts';

describe('player multiplier', () => {
	it('follows the table in docs/economy.md', () => {
		const table = [10, 10, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 20];
		table.forEach((m, n) => expect(playerMultiplier(n), `${n} players`).toBe(m));
		expect(playerMultiplier(32)).toBe(20);
	});
	it('only in the multiplayer modes', () => {
		expect([...MULTIPLIER_MODES].sort()).toEqual(['defense', 'hns', 'infected', 'tag', 'zombies']);
		expect(modeMultiplier('surf', 20)).toBe(10);
		expect(modeMultiplier('bhop', 20)).toBe(10);
		expect(modeMultiplier('tag', 6)).toBe(15);
	});
	it('gives whole tenths', () => {
		expect(applyMultiplier(pts(3), 15)).toBe(45);
		expect(applyMultiplier(pts(1), 12)).toBe(12);
		expect(applyMultiplier(pts(10), 10)).toBe(100);
	});
});

describe('decay', () => {
	it('race repeats: 100, 50, 25, then 0, rounded up to whole points', () => {
		expect([0, 1, 2, 3, 9].map((n) => decayed(pts(5), RACE_PAY.repeat, n))).toEqual([50, 30, 20, 10, 10]);
		expect([0, 1, 2, 3].map((n) => decayed(pts(15), RACE_PAY.repeat, n))).toEqual([150, 80, 40, 20]);
	});
	it('Zombie Run gates and wins: 100, 50, 25, then 10', () => {
		expect([0, 1, 2, 3, 4].map((n) => decayed(pts(8), ZOMBIES_PAY.repeat, n))).toEqual([80, 40, 20, 10, 10]);
	});
});

describe('payouts', () => {
	it('match docs/economy.md', () => {
		expect(PLAYTIME).toEqual({ points: 100, everyMs: 900_000 });
		expect(
			(['surf', 'bhop'] as const).flatMap((kind) => (['easy', 'hard'] as const).map((difficulty) => raceFinish({ kind, difficulty })))
		).toEqual([40, 150, 50, 120]);
		expect(raceFinish({ kind: 'tag', difficulty: 'easy' })).toBe(0);
		expect(ZOMBIES_PAY.gate(3)).toBe(30);
		expect(ZOMBIES_PAY.evac(5)).toBe(80);
		expect(TAG_PAY.placement).toEqual([30, 20, 10]);
		expect([HNS_PAY.find, HNS_PAY.bagMin, HNS_PAY.bagMax]).toEqual([30, 40, 100]);
		expect([INFECTED_PAY.survive, INFECTED_PAY.surviveEasy, INFECTED_PAY.moab, decayed(INFECTED_PAY.moab, INFECTED_PAY.moabRepeat, 1)]).toEqual([40, 20, 80, 10]);
		expect(MIN_ACTIVE).toEqual({ tag: 3, hns: 3, infected: 4, defense: 1 });
		const caps = Object.fromEntries(Object.entries(AWARDS as Record<string, AwardDef>).map(([k, d]) => [k, d.perRound]));
		expect(caps).toMatchObject({ tagChased: 30, tagTag: 30, hnsChase: 40, hnsChased: 80, hnsView: 60, infKills: 40, infInfect: 50, zombiesKill: 30 });
		expect(AWARDS.tagPlace.minActive).toBe(4);
		expect((Object.keys(AWARDS) as (keyof typeof AWARDS)[]).filter((k) => AWARDS[k].exempt)).toEqual(['raceFirst', 'raceRecord']);
	});
	it('tag placement: time not IT, then time chased, ties share', () => {
		const row = (id: number, score: number, chasedMs = 0) => ({ id, score, chasedMs });
		const paid = (...rows: ReturnType<typeof row>[]) => tagPlacements(rows).map((r) => [r.id, r.place, r.base]);
		expect(paid(row(1, 90), row(2, 180), row(3, 120.04), row(4, 10))).toEqual([[2, 1, 30], [3, 2, 20], [1, 3, 10]]);
		expect(paid(row(1, 180, 5000), row(2, 180, 9000), row(3, 180, 7000))).toEqual([[2, 1, 30], [3, 2, 20], [1, 3, 10]]);
		expect(paid(row(1, 180), row(2, 180), row(3, 50))).toEqual([[1, 1, 20], [2, 1, 20], [3, 3, 10]]);
		expect(paid(row(1, 9), row(2, 5), row(3, 1), row(4, 1))).toEqual([[1, 1, 30], [2, 2, 20], [3, 3, 10], [4, 3, 10]]);
		expect(paid(...[1, 2, 3, 4, 5].map((i) => row(i, 180)))).toEqual([1, 2, 3, 4, 5].map((i) => [i, 1, 10]));
		expect(paid()).toEqual([]);
	});
	it('labels', () => {
		expect(awardLabel('hnsFind')).toBe('Found a hider');
		expect(awardLabel('shop:hat')).toBe('Shop: hat');
		expect(awardLabel('toString')).toBe('toString');
	});
});

describe('speed limits', () => {
	it('hide and seek uses its own limit; all are far above a run or a capped jump', () => {
		expect(SPEED_LIMIT.hns).toBe(HNS_SPEED_LIMIT);
		for (const v of Object.values(SPEED_LIMIT)) expect(v).toBeGreaterThanOrEqual(2 * 286);
	});
});

describe('formats', () => {
	it('tenths', () => {
		expect([45, 40, 0, -120, -5, 12345, 10000].map(formatTenths)).toEqual(['4.5', '4', '0', '-12', '-0.5', '1,234.5', '1,000']);
	});
	it('whole points are rounded down', () => {
		expect([0, 9, 10, 1999, 12_345_678].map(formatWhole)).toEqual(['0', '0', '1', '199', '1,234,567']);
	});
	it('multiplier', () => {
		expect([10, 12, 20].map(formatMultiplier)).toEqual(['×1.0', '×1.2', '×2.0']);
	});
});

describe('Zombie Defense coins', () => {
	it('per wave cleared: 1 for waves 1-3, +1 every 4 waves, at most 5', () => {
		expect([1, 2, 3, 4, 7, 8, 12, 15, 16, 40].map((n) => DEFENSE_PAY.wave(n) / 10)).toEqual([1, 1, 1, 2, 2, 3, 4, 4, 5, 5]);
		expect([0, 1, 2, 3, 4].map((n) => decayed(DEFENSE_PAY.wave(16), DEFENSE_PAY.repeat, n))).toEqual([50, 30, 20, 10, 10]);
	});

	/**
	 * One hour of solo games that die in wave `dieAt`, with the shortest waves
	 * the rules allow (every zombie spawned at the spawn rate, 12 s to walk in
	 * and die) and `build` seconds per build phase (2: Ready right away).
	 * Repeats of a wave number in the hour decay. Base points, no playtime.
	 */
	function hour(dieAt: number, build: number): number {
		let t = 0;
		let points = 0;
		const paid = new Map<number, number[]>();
		while (t < 3600) {
			for (let n = 1; n <= dieAt && t < 3600; n++) {
				t += build + 1 + ((zdWaveCount(n, 1) - 1) * zdSpawnInterval(1)) / 1000 + 12;
				if (n === dieAt || t > 3600) break;
				const times = paid.get(n) ?? [];
				points += decayed(DEFENSE_PAY.wave(n), DEFENSE_PAY.repeat, times.filter((x) => x > t - 3600).length);
				paid.set(n, [...times, t]);
			}
			t += 8;
		}
		return points / 10;
	}

	it('stays within the target rates, endless waves and die-and-restart loops included (docs/economy.md#target-rates)', () => {
		// Playtime adds 40 per hour; the very good rate is 150-190 in all.
		for (let w = 2; w <= 40; w++) expect(hour(w, 2), `die at wave ${w}`).toBeLessThanOrEqual(150);
		// An average game (lost around wave 6-10, full build phases) pays like the other modes.
		for (const w of [6, 8, 10]) {
			expect(hour(w, 30)).toBeGreaterThanOrEqual(40);
			expect(hour(w, 30)).toBeLessThanOrEqual(90);
		}
		// Farming the first waves pays less than playing on.
		expect(hour(3, 2)).toBeLessThan(hour(30, 2));
	});
});
