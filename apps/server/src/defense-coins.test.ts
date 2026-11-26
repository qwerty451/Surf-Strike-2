/** Coins of Zombie Defense (docs/economy.md#zombie-defense) on the shared test arena and the real rules. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defenseFixtureMap, pts, Status, type ServerMessage, type Vec3 } from '@surf/shared';
import { modeHost } from './coins-helpers.ts';
import { world, type SimPlayer } from './economy-helpers.ts';
import { DefenseMode } from './modes/defense.ts';
import { netState } from './test-helpers.ts';

const MAP = defenseFixtureMap();

function setup(n: number) {
	const w = world(MAP);
	const players = w.join(n);
	const out: ServerMessage[] = [];
	const mode = new DefenseMode(modeHost(w, out), { firstBuildSecs: 1, buildSecs: 1, endSecs: 1, spawnIntervalScale: 1e9, plan: () => ['walker'] });
	const s = {
		w,
		players,
		mode,
		out,
		ticks(ms: number) {
			for (let t = 0; t < ms; t += 1000 / 32) {
				w.now += 1000 / 32;
				mode.tick();
			}
		},
		at(p: SimPlayer, pos: Vec3) {
			mode.state(p as never, netState(1, pos.x, { y: pos.y, z: pos.z, status: Status.Alive }));
		},
		/** Play the next wave and clear it. */
		clear() {
			w.active();
			s.ticks(1200);
			assert.equal(mode.game.phase, 'wave');
			s.ticks(1200);
			mode.game.zombies.clear();
			s.ticks(100);
			assert.equal(mode.game.phase, 'build');
		},
		/** Lose the current game: a brute next to every living player. */
		lose() {
			w.active();
			s.ticks(1200);
			assert.equal(mode.game.phase, 'wave');
			for (let i = 0; i < 100 && mode.game.phase === 'wave'; i++) {
				for (const p of players) {
					const v = mode.game.playerView(p.id);
					if (v?.status !== 'alive') continue;
					s.at(p, { x: 0, y: 0, z: 0 });
				}
				if (mode.game.zombies.size < 3) mode.game.spawnZombie('brute', { x: 40, y: 0, z: 0.25 });
				s.ticks(250);
			}
			assert.equal(mode.game.phase, 'ended');
			s.ticks(1100);
			assert.equal(mode.game.phase, 'build');
		},
		paid(p: SimPlayer) {
			return w.sent(p, 'award').map((m) => `${m.label ?? m.reason} ${m.base / 10}`);
		}
	};
	mode.tick();
	return s;
}

describe('Zombie Defense coins', () => {
	it('every wave cleared pays everyone in the game, dead or alive; more for later waves', () => {
		const s = setup(2);
		const [a, b] = s.players as [SimPlayer, SimPlayer];
		for (let i = 0; i < 4; i++) s.clear();
		assert.deepEqual(s.paid(a), ['Wave 1 1', 'Wave 2 1', 'Wave 3 1', 'Wave 4 2']);
		assert.deepEqual(s.paid(b), s.paid(a));
		assert.equal(s.w.db.accountStats(a.accountId!).pointsTotal, pts(5));
		assert.equal(
			s.out.some((m) => m.type === 'zd' && m.ev.e === 'cleared'),
			true
		);
	});

	it('the same wave again within the hour decays (100, 50, 25, 10 %, whole points)', () => {
		const s = setup(1);
		const [a] = s.players as [SimPlayer];
		for (let i = 0; i < 4; i++) s.clear();
		s.lose();
		for (let i = 0; i < 4; i++) s.clear();
		assert.deepEqual(s.paid(a), ['Wave 1 1', 'Wave 2 1', 'Wave 3 1', 'Wave 4 2', 'Wave 1 1', 'Wave 2 1', 'Wave 3 1', 'Wave 4 1']);
	});

	it('a player who joins during a wave is not paid for it, but for the next one', () => {
		const s = setup(1);
		s.w.active();
		s.ticks(1200);
		assert.equal(s.mode.game.phase, 'wave');
		const [late] = s.w.join(1) as [SimPlayer];
		s.players.push(late);
		s.ticks(1200);
		assert.equal(s.mode.game.playerView(late.id)!.status, 'waiting');
		s.mode.game.zombies.clear();
		s.ticks(100);
		assert.deepEqual(s.paid(late), []);
		assert.deepEqual(s.paid(s.players[0]!), ['Wave 1 1']);
		s.clear();
		assert.deepEqual(s.paid(late), ['Wave 2 1']);
	});
});
