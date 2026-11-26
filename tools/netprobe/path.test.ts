import assert from 'node:assert/strict';
import test from 'node:test';
import { BotPath, distance } from './path.ts';

function near(actual: number, expected: number, tolerance = 1e-6) {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
}

test('the straight, surf arc and stop share a continuous path', () => {
	const path = new BotPath(0);
	assert.deepEqual(path.at(1000), { x: 265, y: 0, z: 0, vx: 265, vy: 0, vz: 0 });
	const arc = path.at(3000);
	near(Math.hypot(arc.vx, arc.vy, arc.vz), 1200);
	near(Math.hypot(arc.x - 530, arc.y - 600), 600);
	for (const boundary of [2000, 5000, 9000, 11000, 14000]) {
		assert.ok(distance(path.at(boundary - 0.0001), path.at(boundary)) < 0.001);
	}
	assert.deepEqual(path.at(5500), { ...path.at(5000), vx: 0, vy: 0, vz: 0 });
});

test('velocity agrees with the position derivative on both arcs', () => {
	const path = new BotPath(0);
	for (const ms of [1000, 4000, 7250, 10000]) {
		const now = path.at(ms);
		const a = path.at(ms - 0.01);
		const b = path.at(ms + 0.01);
		near((b.x - a.x) / 0.00002, now.vx);
		near((b.y - a.y) / 0.00002, now.vy);
	}
});

test('short and long teleports preserve x and y and wrap across cycles', () => {
	const path = new BotPath(0);
	assert.deepEqual(path.teleports(0, 16_000), [
		{ ms: 6000, from: 0, to: 384 },
		{ ms: 12000, from: 384, to: 1920 },
		{ ms: 16000, from: 1920, to: 0 }
	]);
	for (const event of path.teleports(-1, 32_000)) {
		const a = path.at(event.ms - 0.0001);
		const b = path.at(event.ms);
		assert.equal(a.z, event.from);
		assert.equal(b.z, event.to);
		assert.ok(Math.hypot(b.x - a.x, b.y - a.y) < 0.001);
	}
	assert.deepEqual(path.at(-100), path.at(15_900));
	const phased = new BotPath(3);
	assert.deepEqual(phased.at(1000), { ...path.at(3625), y: path.at(3625).y + 384 });
	near(phased.teleports(3000, 6000)[0].ms, 3375);
});

test('projection recovers delay on both arcs and keeps geometric error separate', () => {
	const path = new BotPath(3);
	for (const at of [150, 1475, 4600, 7200]) {
		const point = path.at(at);
		const projection = path.project(at + 162, { ...point, z: point.z + 2 }, 100);
		assert.equal(projection.identifiable, true);
		near(projection.ms, at);
		near(projection.error, 2);
	}
});

test('a stationary or retraced pose cannot uniquely identify visual delay', () => {
	const path = new BotPath(0);
	assert.equal(path.project(5550, path.at(5400), 100).identifiable, false);
	assert.equal(path.project(14_400, path.at(13_750), 100).identifiable, false);
});

test('a projected pose at the end of a stop still belongs to the pre-teleport level', () => {
	const path = new BotPath(7);
	const point = path.at(5800);
	const projection = path.project(5980, point, 120);
	assert.equal(path.at(projection.ms).z, point.z);
	assert.equal(path.at(projection.ms).vx, 0);
});
