import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runProbe, type Config, type Result } from './run.ts';
import { replayProbe, type ProbeTrace } from './trace.ts';

const usage = `pnpm netprobe --url wss://HOST/ws [--bots 8] [--seconds 300]
  --fps 60,144     Observer render rates. Both use the same observer socket.
  --sender-fps 60  Bot display rate, 60 or 144. Simulation runs at 64 Hz.
  --loss 1        Percentage of TCP stream chunks held for 100 ms.
  --jitter 10     Maximum extra delay per chunk, in ms.
  --burst 180/8000
                  Hold traffic for 180 ms every 8000 ms.
  --seed 42       Reuse the pseudo-random delay sequence.
  --trace         Save raw observer arrivals and render frames to a sidecar.
  --out DIR       JSON directory. Defaults to tools/netprobe/results.

pnpm netprobe compare BASE.json TEST.json
pnpm netprobe replay TRACE.json [TRACE.json ...]`;

function numberOption(name: string, value: string, min: number, max: number, integer = false): number {
	const n = Number(value);
	if (value.trim() === '' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
		throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
	}
	return n;
}

function inputPath(path: string): string {
	return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

function parseRun(args: string[]): { config: Config; out: string; trace: boolean } | null {
	const { values } = parseArgs({
		args,
		options: {
			url: { type: 'string' },
			bots: { type: 'string', default: '8' },
			seconds: { type: 'string', default: '300' },
			fps: { type: 'string', default: '60,144' },
			'sender-fps': { type: 'string', default: '60' },
			loss: { type: 'string', default: '0' },
			jitter: { type: 'string', default: '0' },
			burst: { type: 'string' },
			seed: { type: 'string', default: '42' },
			out: { type: 'string' },
			trace: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h' }
		}
	});
	if (values.help) return null;
	if (!values.url) throw new Error('--url is required. Use --help for options.');
	const url = new URL(values.url);
	if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash) {
		throw new Error('--url must be a ws: or wss: URL without credentials or a fragment');
	}
	const fps = [...new Set(values.fps.split(',').map((value) => Number(value)))];
	const senderFps = Number(values['sender-fps']);
	if (fps.some((value) => value !== 60 && value !== 144)) throw new Error('--fps must be 60, 144, or 60,144');
	if (senderFps !== 60 && senderFps !== 144) throw new Error('--sender-fps must be 60 or 144');
	let burst: Config['burst'] = null;
	if (values.burst !== undefined) {
		const parts = values.burst.split('/');
		if (parts.length !== 2) throw new Error('--burst expects DURATION_MS/PERIOD_MS');
		const durationMs = numberOption('burst duration', parts[0], 1, 1000, true);
		const periodMs = numberOption('burst period', parts[1], durationMs + 1, 3_600_000, true);
		burst = { durationMs, periodMs };
	}
	return {
		config: {
			url, fps, senderFps, burst,
			bots: numberOption('bots', values.bots, 1, 16, true),
			seconds: numberOption('seconds', values.seconds, 1, 3600),
			lossPct: numberOption('loss', values.loss, 0, 100),
			jitterMs: numberOption('jitter', values.jitter, 0, 1000),
			seed: numberOption('seed', values.seed, 0, 0xffffffff, true)
		},
		trace: values.trace,
		out: values.out ? inputPath(values.out) : fileURLToPath(new URL('./results/', import.meta.url))
	};
}

function fmt(n: number | null, places = 1): string {
	return n === null ? 'n/a' : n.toFixed(places);
}

type Observer = Result['observers'][number];

function rows(o: Observer, run: Result): Record<string, string> {
	const s = o.interArrivalMs;
	const pct = (ms: number) => fmt(o.measuredBotMs ? 100 * ms / o.measuredBotMs : null, 2);
	const stalls = (episodes: Observer['freezes']) =>
		`${fmt(episodes.totalMs, 0)} / ${pct(episodes.totalMs)}% / ${episodes.over100Ms}`;
	return {
		'Target-time error outside teleports RMS / p99 (u)': `${fmt(o.positionErrorOutsideTeleportsU?.rms ?? null)} / ${fmt(o.positionErrorOutsideTeleportsU?.p99 ?? null)}`,
		'All-frame target-time error RMS / p99 (u)': `${fmt(o.positionErrorU.rms)} / ${fmt(o.positionErrorU.p99)}`,
		'Path error RMS (u)': fmt(o.pathErrorU.rms),
		'Target delay p50 (ms)': fmt(o.configuredDelayMs.p50),
		'Effective delay p50 / p95 (ms)': `${fmt(o.effectiveDelayMs.p50)} / ${fmt(o.effectiveDelayMs.p95)}`,
		'Speed wobble RMS (u/s)': fmt(o.speedWobbleUps.rms),
		'Underrun total bot-ms / % / >100ms': stalls(o.underruns),
		'Freeze total bot-ms / % / >100ms': stalls(o.freezes),
		'Teleport slides / expected': `${o.teleports.slides} / ${o.teleports.expected}`,
		'Snapshot spacing p50 / p95 / p99 / max (ms)': [s.p50, s.p95, s.p99, s.max].map((n) => fmt(n)).join(' / '),
		'Snapshot payload bytes total / mean': run.snapshotBytes == null
			? 'n/a'
			: `${run.snapshotBytes} / ${fmt(run.snapshotBytes / run.receivedSnapshots)}`,
		'WebSocket RTT p50 / p95 (ms)': `${fmt(o.rttMs.p50)} / ${fmt(o.rttMs.p95)}`,
		'Observer frame interval p95 / p99 (ms)': `${fmt(o.frameIntervalsMs.p95)} / ${fmt(o.frameIntervalsMs.p99)}`
	};
}

function table(columns: Record<string, Record<string, string>>): void {
	const titles = Object.keys(columns);
	const keys = Object.keys(columns[titles[0]]);
	const labelWidth = Math.max(...keys.map((key) => key.length));
	const widths = titles.map((title) => Math.max(title.length, ...Object.values(columns[title]).map((v) => v.length)));
	console.log([('Metric').padEnd(labelWidth), ...titles.map((title, i) => title.padStart(widths[i]))].join('  '));
	for (const key of keys) {
		console.log([key.padEnd(labelWidth), ...titles.map((title, i) => columns[title][key].padStart(widths[i]))].join('  '));
	}
}

async function resultAt(path: string): Promise<Result> {
	const result = JSON.parse(await readFile(inputPath(path), 'utf8')) as Result;
	if (result?.schema !== 1 || !Array.isArray(result.observers) || result.observers.length === 0) {
		throw new Error(`Unrecognized netprobe result: ${path}`);
	}
	return result;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === 'replay') {
		if (args.length < 2) throw new Error('Usage: pnpm netprobe replay TRACE.json [TRACE.json ...]');
		for (const path of args.slice(1)) {
			const trace = JSON.parse(await readFile(inputPath(path), 'utf8')) as ProbeTrace;
			console.log(path);
			for (const { fps, controllers } of replayProbe(trace)) {
				console.log(`${fps} Hz, v${trace.protocol}`);
				table(Object.fromEntries(Object.entries(controllers).map(([name, metrics]) => [name, {
					'Effective delay p50 / p95 (ms)': `${fmt(metrics.effectiveDelayMs.p50)} / ${fmt(metrics.effectiveDelayMs.p95)}`,
					'Freeze (bot-s)': fmt(metrics.freezes.totalMs / 1000, 3),
					'Held frames': String(metrics.freezes.frames),
					'Correction jump p99 / max (u)': `${fmt(metrics.correctionJumpU.p99)} / ${fmt(metrics.correctionJumpU.max)}`,
					'Target-time error outside teleports RMS (u)': fmt(metrics.positionErrorOutsideTeleportsU.rms),
					'All-frame target-time error RMS (u)': fmt(metrics.positionErrorU.rms)
				}])));
			}
		}
		return;
	}
	if (args[0] === 'compare') {
		if (args.length !== 3) throw new Error('Usage: pnpm netprobe compare BASE.json TEST.json');
		const [base, test] = await Promise.all(args.slice(1).map(resultAt));
		const { seconds: baseSeconds, ...baseSettings } = base.settings;
		const { seconds: testSeconds, ...testSettings } = test.settings;
		if (JSON.stringify(baseSettings) !== JSON.stringify(testSettings) || baseSeconds !== testSeconds || base.startMap !== test.startMap) {
			console.error('Run settings or start maps differ. Check both JSON files before attributing changes to the protocol.');
		}
		console.log(`Base v${base.protocol}: ${base.url}\nTest v${test.protocol}: ${test.url}`);
		for (const left of base.observers) {
			const right = test.observers.find((o) => o.fps === left.fps);
			if (right) table({ [`Base ${left.fps} Hz`]: rows(left, base), [`Test ${right.fps} Hz`]: rows(right, test) });
		}
		if (!base.observers.some((left) => test.observers.some((right) => right.fps === left.fps))) {
			throw new Error('Results have no observer frame rate in common');
		}
		return;
	}
	const options = parseRun(args);
	if (!options) {
		console.log(usage);
		return;
	}
	const stop = new AbortController();
	const interrupt = () => stop.abort(new Error('Probe interrupted'));
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', interrupt);
	try {
		await mkdir(options.out, { recursive: true });
		const { result, trace } = await runProbe(options.config, stop.signal, options.trace);
		const stamp = result.startedAt.replace(/[:.]/g, '-');
		const host = new URL(result.url).hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
		const { lossPct, jitterMs, burst } = result.settings;
		const profile = `loss${lossPct}-jitter${jitterMs}${burst ? `-burst${burst.durationMs}x${burst.periodMs}` : ''}`;
		const name = `${stamp}-${host}-${profile}`;
		const file = resolve(options.out, `${name}.json`);
		if (trace) {
			const traceFile = resolve(options.out, `${name}.trace.json`);
			await writeFile(traceFile, JSON.stringify(trace) + '\n', { flag: 'wx' });
			console.log(traceFile);
		}
		await writeFile(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
		console.log(`v${result.protocol}, ${result.settings.bots} bots, ${fmt(result.actualSeconds)} s, ${result.receivedSnapshots} snapshots`);
		table(Object.fromEntries(result.observers.map((o) => [`${o.fps} Hz`, rows(o, result)])));
		console.log(file);
	} finally {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', interrupt);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
