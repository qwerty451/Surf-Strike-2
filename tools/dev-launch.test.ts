/**
 * Unit tests for the dev launcher's pure helpers; part of the server's `pnpm test`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAME_MODE_IDS, INF_AMMO, MAPS, mapsForMode, SANDBOX, Status, tagSpawns, WEAPONS, ZM_FIRE_TOLERANCE, type InfectedGame, type MapDef } from '../packages/shared/src/index.ts';
import {
	Bot,
	BOT_RING,
	botSpawn,
	botStatus,
	CliError,
	DEFAULT_PORT,
	DEFAULT_WEB_PORT,
	defaultBots,
	dirFromAngles,
	dirTowards,
	drawWaitMs,
	gameUrl,
	launchMaps,
	listText,
	modeOptions,
	parseArgs,
	PATROL_RADIUS,
	PATROL_SPEED,
	patrolPose,
	resolveTarget,
	type AimQuery
} from './dev-launch.ts';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('parseArgs: defaults', () => {
	const o = parseArgs([]);
	assert.equal(o.target, 'surf');
	assert.equal(o.bots, null);
	assert.equal(o.port, DEFAULT_PORT);
	assert.equal(o.webPort, DEFAULT_WEB_PORT);
	assert.equal(o.ctrlPort, DEFAULT_PORT + 1);
	assert.equal(o.db, ':memory:');
	assert.equal(o.fast || o.serverOnly || o.open || o.list || o.help || o.botPatrol, false);
});

test('parseArgs: flags, = form and pnpm "--" separator', () => {
	const o = parseArgs(['--', 'infected', '--bots', '3', '--bot-patrol', '--port=28000', '--web-port', '5200', '--fast', '--grace', '2.5', '--round=30', '--countdown', '1', '--server-only', '--open']);
	assert.equal(o.target, 'infected');
	assert.equal(o.bots, 3);
	assert.equal(o.botPatrol, true);
	assert.equal(o.port, 28000);
	assert.equal(o.ctrlPort, 28001);
	assert.equal(o.webPort, 5200);
	assert.equal(o.fast, true);
	assert.equal(o.grace, 2.5);
	assert.equal(o.round, 30);
	assert.equal(o.countdown, 1);
	assert.equal(o.serverOnly, true);
	assert.equal(o.open, true);
});

test('parseArgs: control port options', () => {
	assert.equal(parseArgs(['--ctrl-port', '9000']).ctrlPort, 9000);
	assert.equal(parseArgs(['--no-ctrl']).ctrlPort, null);
	assert.equal(parseArgs(['--list']).list, true);
	assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs: bad input throws CliError', () => {
	for (const argv of [
		['--bots'],
		['--bots', 'x'],
		['--bots', '-1'],
		['--bots', '99'],
		['--port', '0'],
		['--port', '70000'],
		['--grace', '0'],
		['--round', 'abc'],
		['--wat'],
		['surf', 'bhop'],
		['--ctrl-port', '27016'],
		['--web-port', '27016']
	]) {
		assert.throws(() => parseArgs(argv), CliError, argv.join(' '));
	}
	// --web-port clash is fine without a web server.
	assert.equal(parseArgs(['--web-port', '27016', '--server-only']).webPort, 27016);
});

test('resolveTarget: every mode with maps picks its first map, mapless modes throw CliError', () => {
	for (const mode of GAME_MODE_IDS) {
		const modeMaps = mapsForMode(mode);
		if (modeMaps.length === 0) {
			assert.throws(() => resolveTarget(mode), CliError);
			continue;
		}
		const t = resolveTarget(mode);
		assert.equal(t.mode, mode);
		assert.equal(t.mapId, modeMaps[0]!.id);
	}
	assert.deepEqual(resolveTarget('infected'), { mapId: 'infected_outpost', mode: 'infected' });
});

test('resolveTarget: map ids (any case) and the sandbox', () => {
	for (const m of MAPS) assert.deepEqual(resolveTarget(m.id), { mapId: m.id, mode: m.kind });
	assert.deepEqual(resolveTarget('TAG_QUAYSIDE'), { mapId: 'tag_quayside', mode: 'tag' });
	assert.deepEqual(resolveTarget('sandbox'), { mapId: SANDBOX.id, mode: SANDBOX.kind });
});

test('resolveTarget: unknown target lists modes and maps', () => {
	assert.throws(
		() => resolveTarget('nope'),
		(e: unknown) => e instanceof CliError && /surf, bhop/.test(e.message) && e.message.includes('infected_outpost') && e.message.includes('sandbox')
	);
});

test('launchMaps: rotation plus sandbox', () => {
	assert.equal(launchMaps().length, MAPS.length + 1);
	assert.ok(launchMaps().includes(SANDBOX));
});

test('defaultBots: one for two-player modes', () => {
	assert.equal(defaultBots('tag'), 1);
	assert.equal(defaultBots('infected'), 1);
	assert.equal(defaultBots('surf'), 0);
	assert.equal(defaultBots('bhop'), 0);
	assert.equal(defaultBots('zombies'), 0);
});

test('modeOptions: --fast timers and explicit overrides', () => {
	assert.deepEqual(modeOptions({ fast: false, grace: null, round: null, countdown: null }), { infected: {}, tag: {}, zombies: {} });
	const fast = modeOptions({ fast: true, grace: null, round: null, countdown: null });
	assert.deepEqual(fast.infected, { graceSecs: 4, roundSecs: 90, endSecs: 4, respawnSecs: 2 });
	assert.deepEqual(fast.tag, { intermissionSecs: 3, roundSecs: 60 });
	assert.deepEqual(fast.zombies, { countdownSecs: 3, endSecs: 4 });
	const o = modeOptions({ fast: true, grace: 1, round: 20, countdown: 2 });
	assert.equal(o.infected!.graceSecs, 1);
	assert.equal(o.infected!.roundSecs, 20);
	assert.equal(o.tag!.roundSecs, 20);
	assert.equal(o.tag!.intermissionSecs, 2);
	assert.equal(o.zombies!.countdownSecs, 2);
	assert.equal(o.zombies!.endSecs, 4);
});

test('gameUrl and listText', () => {
	assert.equal(gameUrl(5173, 27016), 'http://localhost:5173/?server=ws://localhost:27016/ws');
	assert.equal(gameUrl(5173, 27016, 'surf_ember'), 'http://localhost:5173/?server=ws://localhost:27016/ws&map=surf_ember');
	const txt = listText();
	for (const mode of GAME_MODE_IDS) assert.ok(txt.includes(`  ${mode}`), mode);
	for (const m of MAPS) assert.ok(txt.includes(m.id), m.id);
	assert.ok(txt.includes('sandbox'));
});

test('botSpawn: uses spawn points from the second one, then fans out', () => {
	const map = MAPS.find((m) => m.id === 'infected_outpost')!;
	const list = tagSpawns(map);
	assert.ok(list.length > 2);
	const first = botSpawn(map, 0);
	assert.deepEqual([first.x, first.y, first.z, first.yaw], [list[1]!.pos.x, list[1]!.pos.y, list[1]!.pos.z, list[1]!.yaw]);
	// All bots that fit on distinct points get distinct points.
	const poses = Array.from({ length: list.length }, (_, i) => botSpawn(map, i));
	assert.equal(new Set(poses.map((p) => `${p.x},${p.y},${p.z}`)).size, list.length);
});

test('botSpawn: single-spawn maps put bots on a ring around it', () => {
	const map = { spawn: { pos: { x: 10, y: 20, z: 30 }, yaw: 90 } };
	const seen = new Set<string>();
	for (let i = 0; i < 6; i++) {
		const p = botSpawn(map, i);
		close(Math.hypot(p.x - 10, p.y - 20), BOT_RING);
		assert.equal(p.z, 30);
		assert.equal(p.yaw, 90);
		seen.add(`${p.x.toFixed(3)},${p.y.toFixed(3)}`);
	}
	assert.equal(seen.size, 6);
	const far = botSpawn(map, 6);
	close(Math.hypot(far.x - 10, far.y - 20), BOT_RING * 2);
});

test('patrolPose: starts on the anchor, stays on the circle, walks at PATROL_SPEED', () => {
	const anchor = { x: 100, y: -50, z: 12, yaw: 0, pitch: 5 };
	for (const phase of [0, 1.3, 4]) {
		const p0 = patrolPose(anchor, 0, phase);
		close(p0.x, anchor.x);
		close(p0.y, anchor.y);
		const cx = anchor.x - Math.cos(phase) * PATROL_RADIUS;
		const cy = anchor.y - Math.sin(phase) * PATROL_RADIUS;
		for (const t of [0.5, 2, 7.25]) {
			const p = patrolPose(anchor, t, phase);
			close(Math.hypot(p.x - cx, p.y - cy), PATROL_RADIUS);
			close(Math.hypot(p.vx, p.vy), PATROL_SPEED);
			close(p.yaw, (Math.atan2(p.vy, p.vx) * 180) / Math.PI);
			assert.equal(p.z, anchor.z);
			assert.equal(p.pitch, anchor.pitch);
		}
	}
});

test('aim helpers', () => {
	const f = dirFromAngles(0, 0);
	close(f.x, 1);
	close(f.y, 0);
	close(f.z, 0);
	const left = dirFromAngles(90, 0);
	close(left.y, 1);
	const down = dirFromAngles(0, 90);
	close(down.z, -1);
	const d = dirTowards({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })!;
	close(d.x, 0.6);
	close(d.y, 0.8);
	assert.equal(dirTowards({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }), null);
});

test('botStatus per mode', () => {
	assert.equal(botStatus('tag'), Status.Runner);
	assert.equal(botStatus('infected'), Status.Alive);
	assert.equal(botStatus('zombies'), Status.Alive);
	assert.equal(botStatus('surf'), Status.StartZone);
});

test('drawWaitMs: the rest of the draw time after a swap, infected only', () => {
	assert.equal(drawWaitMs('infected', 'lmg', 0), WEAPONS.lmg.deployMs);
	assert.equal(drawWaitMs('infected', 'pistol', 100), WEAPONS.pistol.deployMs! - 100);
	assert.equal(drawWaitMs('infected', 'pistol', WEAPONS.pistol.deployMs!), 0);
	assert.equal(drawWaitMs('infected', 'barrett', 10_000), 0);
	// Never swapped (-Infinity ago is Infinity since), and a clock that ran backwards.
	assert.equal(drawWaitMs('infected', 'lmg', Infinity), 0);
	assert.equal(drawWaitMs('infected', 'lmg', -50), WEAPONS.lmg.deployMs);
	// Whole milliseconds, rounded up: a timer never fires early.
	assert.equal(drawWaitMs('infected', 'knife', 0.4), WEAPONS.knife.deployMs);
	// Claws have no draw; the other modes have no draw time at all.
	assert.equal(drawWaitMs('infected', 'claws', 0), 0);
	assert.equal(drawWaitMs('zombies', 'lmg', 0), 0);
	assert.equal(drawWaitMs('tag', 'pistol', 0), 0);
	// The wait covers what the server enforces (its draw time is scaled by the fire tolerance).
	for (const w of ['lmg', 'pistol', 'knife', 'sniper', 'barrett', 'striker', 'smg'] as const) {
		assert.ok(drawWaitMs('infected', w, 0) >= WEAPONS[w].deployMs! * ZM_FIRE_TOLERANCE, w);
	}
});

const until = async (done: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!done()) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((r) => setTimeout(r, 15));
	}
};

test('a bot that swaps and fires at once holds the shot until the weapon is drawn; the server accepts it', async () => {
	const { startServer } = await import('../apps/server/src/server.ts');
	const server = await startServer({
		port: 0,
		dbPath: ':memory:',
		maps: launchMaps(),
		initialMap: 'infected_outpost',
		// A long grace period: the round stays in one phase for the whole test.
		modes: modeOptions({ fast: false, grace: 60, round: null, countdown: null }),
		log: () => {}
	});
	const lobby = server.lobby as unknown as { currentMap: MapDef; gameMode: { game: InfectedGame } };
	const bots = [0, 1].map((i) => new Bot(i, server.port, lobby.currentMap, () => false, () => {}));
	try {
		const game = lobby.gameMode.game;
		const bot = bots[0]!;
		await until(() => bots.every((b) => b.connected) && game.phase === 'grace' && game.weaponOf(bot.selfId) !== null && bot.modeState !== null);
		const pistol = () => game.secondaryOf(bot.selfId)!;
		const full = INF_AMMO.pistol!.mag;
		assert.equal(pistol().mag, full);

		// Swap and fire in one go: the shot is held for the pistol's draw time, then accepted.
		bot.loadout('pistol');
		const delay = bot.fire({});
		assert.ok(delay > 0 && delay <= WEAPONS.pistol.deployMs!, `delay ${delay}`);
		await until(() => game.weaponOf(bot.selfId)!.weapon === 'pistol');
		assert.equal(pistol().mag, full);
		await until(() => pistol().mag === full - 1);

		// Drawn: the next shot leaves at once.
		await new Promise((r) => setTimeout(r, WEAPONS.pistol.fireMs + 50));
		assert.equal(bot.fire({}), 0);
		await until(() => pistol().mag === full - 2);

		// What the hold prevents: the same swap with the shot sent straight away is rejected.
		const raw = bot as unknown as { shoot(q: AimQuery): void };
		const primary = game.primaryOf(bot.selfId)!;
		const before = primary.mag;
		bot.loadout(primary.weapon);
		raw.shoot({});
		await until(() => game.weaponOf(bot.selfId)!.weapon === primary.weapon);
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(primary.mag, before);

		// A held shot is dropped when the bot closes (its gun on the server stays as it was).
		const gun = pistol();
		bot.loadout('pistol');
		assert.ok(bot.fire({}) > 0);
		bot.close();
		await new Promise((r) => setTimeout(r, WEAPONS.pistol.deployMs! + 150));
		assert.equal(gun.mag, full - 2);
	} finally {
		for (const b of bots) b.close();
		await server.close();
	}
});
