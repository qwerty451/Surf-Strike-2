import { describe, expect, it } from 'vitest';
import { Binds } from './binds.js';
import { cvarFallback, registerCommands, type CommandContext, type HoldAction } from './commands.js';
import { DevConsole, splitStatements, tokenize } from './console.js';
import { ClientCvars, parseCvarValue, CLIENT_CVARS } from './cvars.js';
import { memoryStore, STORAGE_KEYS } from './storage.js';

describe('tokenizer', () => {
	it('splits statements on ; outside quotes', () => {
		expect(splitStatements('a 1; b "x;y" ;; c')).toEqual(['a 1', 'b "x;y"', 'c']);
	});
	it('groups quoted tokens', () => {
		expect(tokenize('bind mouse3 "+jump"')).toEqual(['bind', 'mouse3', '+jump']);
		expect(tokenize('say "hello world" again')).toEqual(['say', 'hello world', 'again']);
		expect(tokenize('  ')).toEqual([]);
	});
});

describe('cvar parsing', () => {
	const def = (n: string) => CLIENT_CVARS.find((d) => d.name === n)!;
	it('parses numbers and clamps', () => {
		expect(parseCvarValue(def('volume'), '2')).toEqual({ ok: true, value: 1 });
		expect(parseCvarValue(def('sensitivity'), '2.5')).toEqual({ ok: true, value: 2.5 });
		expect(parseCvarValue(def('cl_crosshaircolor_r'), '12.7')).toEqual({ ok: true, value: 13 });
	});
	it('normalises booleans', () => {
		expect(parseCvarValue(def('cl_showfps'), '5')).toEqual({ ok: true, value: 1 });
		expect(parseCvarValue(def('cl_showfps'), 'off')).toEqual({ ok: true, value: 0 });
	});
	it('rejects garbage', () => {
		expect(parseCvarValue(def('fov'), 'abc').ok).toBe(false);
		expect(parseCvarValue(def('name'), '   ').ok).toBe(false);
	});
	it('limits names to 24 chars', () => {
		const r = parseCvarValue(def('name'), 'x'.repeat(40));
		expect(r.ok && String(r.value).length).toBe(24);
	});
});

describe('ClientCvars persistence', () => {
	it('saves changed values and reloads them', () => {
		const store = memoryStore();
		const a = new ClientCvars(store);
		expect(a.num('sensitivity')).toBe(2);
		expect(a.set('sensitivity', '3.1')).toBeNull();
		const b = new ClientCvars(store);
		expect(b.num('sensitivity')).toBe(3.1);
		expect(b.num('fov')).toBe(90);
	});
	it('survives corrupt storage', () => {
		const store = memoryStore({ [STORAGE_KEYS.cvars]: '{not json' });
		expect(new ClientCvars(store).num('volume')).toBe(0.5);
	});
	it('does not persist name', () => {
		const store = memoryStore();
		new ClientCvars(store).set('name', 'Bob');
		expect(new ClientCvars(store).str('name')).toBe('Player');
	});
});

function makeCtx() {
	const out: string[] = [];
	const store = memoryStore();
	const presses: Array<[HoldAction, boolean]> = [];
	const sv: Record<string, number> = { sv_airaccelerate: 150 };
	const calls: string[] = [];
	const ctx: CommandContext = {
		print: (t) => void out.push(t),
		clearConsole: () => void (out.length = 0),
		cvars: new ClientCvars(store),
		binds: new Binds(store),
		press: (a, d) => void presses.push([a, d]),
		openChat: () => void calls.push('chat'),
		toggleConsole: () => void calls.push('console'),
		say: (t) => void calls.push(`say:${t}`),
		slot: (n) => void calls.push(`slot:${n}`),
		spectate: (q) => void calls.push(`spec:${q}`),
		restart: () => void calls.push('restart'),
		back: () => void calls.push('back'),
		changeMap: (id) => void calls.push(`map:${id}`),
		mapIds: () => ['surf_aurora', 'surf_ember', 'bhop_meadow'],
		connect: (u) => void calls.push(`connect:${u}`),
		disconnect: () => void calls.push('disconnect'),
		svNames: () => Object.keys(sv),
		svGet: (n) => sv[n],
		svSet: (n, v) => void (sv[n] = Number(v)),
		status: () => ['ok']
	};
	const con = new DevConsole({
		print: (t) => void out.push(t),
		fallback: (n, a) => cvarFallback(ctx, n, a),
		names: () => [...ctx.cvars.defs.keys(), ...Object.keys(sv)]
	});
	registerCommands(con, ctx);
	return { con, ctx, out, presses, calls, sv };
}

describe('console commands', () => {
	it('sets and prints cvars', () => {
		const { con, ctx, out } = makeCtx();
		con.exec('sensitivity 1.5');
		expect(ctx.cvars.num('sensitivity')).toBe(1.5);
		con.exec('sensitivity');
		expect(out.at(-1)).toContain('"sensitivity" = "1.5"');
	});
	it('name takes the whole rest of the line', () => {
		const { con, ctx } = makeCtx();
		con.exec('name Big Wave Dave');
		expect(ctx.cvars.str('name')).toBe('Big Wave Dave');
	});
	it('reports unknown commands', () => {
		const { con, out } = makeCtx();
		con.exec('nope 1');
		expect(out.at(-1)).toBe('Unknown command: nope');
	});
	it('routes sv_* to the physics setter', () => {
		const { con, sv } = makeCtx();
		con.exec('sv_airaccelerate 1000');
		expect(sv.sv_airaccelerate).toBe(1000);
	});
	it('hold actions press and release', () => {
		const { con, presses } = makeCtx();
		con.exec('+jump; -jump');
		expect(presses).toEqual([
			['jump', true],
			['jump', false]
		]);
	});
	it('runs game commands', () => {
		const { con, calls } = makeCtx();
		con.exec('map surf_ember; slot 2; vote 3; spectate bob; connect example.com; say hi there');
		expect(calls).toEqual(['map:surf_ember', 'slot:2', 'slot:3', 'spec:bob', 'connect:example.com', 'say:hi there']);
	});
	it('history skips consecutive duplicates', () => {
		const { con } = makeCtx();
		con.submit('fov 100');
		con.submit('fov 100');
		con.submit('volume 0.2');
		expect(con.history()).toEqual(['fov 100', 'volume 0.2']);
	});
	it('echoes submitted lines without a prompt prefix (the UI adds "] ")', () => {
		const { con, out } = makeCtx();
		con.submit('  fov 100 ');
		expect(out[0]).toBe('fov 100');
	});
	it('completes commands, cvars and map ids', () => {
		const { con } = makeCtx();
		expect(con.complete('cl_show')).toEqual(['cl_showfps', 'cl_showkeys', 'cl_showpos']);
		expect(con.complete('sv_air')).toEqual(['sv_airaccelerate']);
		expect(con.complete('map surf')).toEqual(['map surf_aurora', 'map surf_ember']);
		expect(con.complete('+jum')).toEqual([]);
	});
	it('bind / unbind via console', () => {
		const { con, ctx, out } = makeCtx();
		con.exec('bind mouse3 "+jump"');
		expect(ctx.binds.get('mouse3')).toBe('+jump');
		con.exec('bind f say gg; echo nope');
		expect(ctx.binds.get('f')).toBe('say gg');
		con.exec('unbind mouse3');
		expect(ctx.binds.get('mouse3')).toBeUndefined();
		con.exec('bind escape toggleconsole');
		expect(out.at(-1)).toContain('Cannot bind');
	});
	it('clear empties output', () => {
		const { con, out } = makeCtx();
		con.exec('echo hi');
		con.exec('clear');
		expect(out).toEqual([]);
	});
});
