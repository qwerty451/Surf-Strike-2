import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeSnapshot, getMap, Status } from '@surf/shared';
import { BotPath } from './path.ts';
import { replayProbe, type ProbeTrace } from './trace.ts';

function movingTrace(): ProbeTrace {
	const path = new BotPath(0);
	const trace: ProbeTrace = {
		schema: 1, protocol: 3, start: 1000, measuredStart: 1100, measuredEnd: 1300,
		botIds: [1], fps: [60, 144],
		events: [[1000, 'timing', { type: 'welcome', selfId: 2, map: 'sandbox', serverTime: 500 }]]
	};
	for (let i = 0; i < 4; i++) {
		const t = i * 31.25;
		const payload = encodeSnapshot([{
			id: 1, tick: i * 2, ...path.at(t), sampleTimeMs: 500 + t,
			pitch: 0, yaw: 0, flags: 0, status: Status.Running, stage: 0, runTicks: 0
		}], 500 + t, i);
		trace.events.push([1000 + t, 'snapshot', Buffer.from(payload).toString('base64')]);
	}
	trace.events.push([1100, 'frame', 60, 16], [1125, 'frame', 144, 7], [1230, 'frame', 60, 130], [1247, 'frame', 60, 17]);
	return trace;
}

test('replays the same arrivals at each recorded frame rate', () => {
	const [slow, fast] = replayProbe(movingTrace(), { map: { ...getMap('sandbox')!, brushes: [] } });
	assert.equal(slow.controllers.fixed.frames, 3);
	assert.equal(slow.controllers.fixed.configuredDelayMs.p50, 100);
	assert.equal(slow.controllers.fixed.freezes.totalMs, 17);
	assert.ok(slow.controllers.previous.underruns.frames > 0);
	assert.equal(slow.controllers.tuned.freezes.totalMs, 0);
	assert.ok(slow.controllers.fixed.correctionJumpU.max! > 0);
	assert.equal(fast.controllers.fixed.frames, 1);
	assert.equal(fast.controllers.tuned.frames, 1);
});

test('v3 replay measures a pose held by the map hull sweep', () => {
	const trace = movingTrace();
	trace.fps = [60];
	const [{ controllers }] = replayProbe(trace, { map: {
		...getMap('sandbox')!,
		brushes: [{ type: 'box', min: { x: 41.5, y: -128, z: -128 }, max: { x: 70, y: 128, z: 128 }, material: 'concrete' }]
	} });
	assert.equal(controllers.tuned.freezes.frames, 1);
	assert.equal(controllers.tuned.freezes.totalMs, 17);
});

test('rejects summaries that have no raw trace', () => {
	assert.throws(() => replayProbe({ schema: 1 } as ProbeTrace), /recorded with --trace/);
});
