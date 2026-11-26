/**
 * Console commands (docs/ui.md#developer-console). Registered against a
 * narrow context so the command table stays independent of the game loop.
 */
import type { DevConsole, PrintKind } from './console.js';
import type { Binds } from './binds.js';
import type { ClientCvars } from './cvars.js';
import { formatCvarValue } from './cvars.js';

export type HoldAction = 'forward' | 'back' | 'moveleft' | 'moveright' | 'jump' | 'duck' | 'showscores' | 'attack' | 'attack2';

export const HOLD_ACTIONS: readonly HoldAction[] = [
	'forward',
	'back',
	'moveleft',
	'moveright',
	'jump',
	'duck',
	'showscores',
	'attack',
	'attack2'
];

export interface CommandContext {
	print(text: string, kind?: PrintKind): void;
	clearConsole(): void;
	cvars: ClientCvars;
	binds: Binds;
	press(action: HoldAction, down: boolean): void;
	openChat(): void;
	toggleConsole(): void;
	say(text: string): void;
	vote(option: number): void;
	spectate(query: string): void;
	restart(): void;
	/** Infected: plant a respawn beacon. Optional: other hosts ignore it. */
	beacon?(): void;
	/** Infected: call an earned M.O.A.B.. Optional: other hosts ignore it. */
	moab?(): void;
	back(): void;
	rtv(): void;
	changeMap(id: string): void;
	mapIds(): string[];
	connect(url: string): void;
	disconnect(): void;
	svNames(): string[];
	svGet(name: string): number | undefined;
	svSet(name: string, raw: string): void;
	status(): string[];
}

export function registerCommands(con: DevConsole, ctx: CommandContext): void {
	const reg = (name: string, help: string, run: (args: string[], raw: string) => void, completeArgs?: (p: string) => string[]) =>
		con.register({ name, help, run, completeArgs });

	for (const a of HOLD_ACTIONS) {
		reg(`+${a}`, `Hold ${a}`, () => ctx.press(a, true));
		reg(`-${a}`, `Release ${a}`, () => ctx.press(a, false));
	}

	reg('help', 'List commands', () => {
		ctx.print('Commands:');
		for (const c of con.list()) {
			if (c.name.startsWith('+') || c.name.startsWith('-')) continue;
			ctx.print(`  ${c.name.padEnd(16)} ${c.help}`);
		}
		ctx.print('Type "cvarlist" for cvars. Hold actions: +forward +back +moveleft +moveright +jump +duck +showscores');
	});
	reg('clear', 'Clear the console', () => ctx.clearConsole());
	reg('echo', 'Print text', (_a, raw) => ctx.print(raw, 'echo'));
	reg('cvarlist', 'List cvars and values', () => {
		for (const d of ctx.cvars.defs.values()) {
			ctx.print(`  ${d.name.padEnd(24)} "${formatCvarValue(ctx.cvars.get(d.name)!)}"  ${d.help}`);
		}
		for (const n of ctx.svNames()) {
			ctx.print(`  ${n.padEnd(24)} "${formatCvarValue(ctx.svGet(n) ?? 0)}"  physics (solo only)`);
		}
	});

	reg(
		'bind',
		'bind <key> <command>: bind a key; bind <key>: show binding',
		(args) => {
			if (args.length === 0) {
				for (const [k, v] of ctx.binds.entries()) ctx.print(`  ${k.padEnd(12)} "${v}"`);
				return;
			}
			if (args.length === 1) {
				const v = ctx.binds.get(args[0].toLowerCase() === '~' ? '`' : args[0].toLowerCase());
				ctx.print(v ? `"${args[0]}" = "${v}"` : `"${args[0]}" is not bound`);
				return;
			}
			const k = ctx.binds.bind(args[0], args.slice(1).join(' '));
			if (!k) ctx.print(`Cannot bind "${args[0]}"`, 'error');
		}
	);
	reg('unbind', 'unbind <key>', (args) => {
		if (!args[0]) return ctx.print('Usage: unbind <key>', 'error');
		if (!ctx.binds.unbind(args[0])) ctx.print(`"${args[0]}" is not bound`, 'error');
	});
	reg('binddefaults', 'Restore default key binds', () => {
		ctx.binds.reset();
		ctx.print('Binds restored to defaults.');
	});

	reg('messagemode', 'Open chat', () => ctx.openChat());
	reg('say', 'say <text>: send chat', (_a, raw) => ctx.say(raw));
	reg('toggleconsole', 'Toggle the console', () => ctx.toggleConsole());
	reg('vote', 'vote <n>: vote in the map vote (1-9), or 1 = yes / 2 = no on an RTV request', (args) => {
		const n = Number(args[0]);
		if (Number.isInteger(n) && n >= 1) ctx.vote(n);
	});
	reg('spectate', 'Toggle spectating; spectate <name>', (_a, raw) => ctx.spectate(raw));
	reg('restart', 'Back to start, timer reset (!r)', () => ctx.restart());
	reg('beacon', 'Infected: plant a respawn beacon at your feet (E)', () => ctx.beacon?.());
	reg('moab', 'Infected: call your earned M.O.A.B. (N)', () => ctx.moab?.());
	reg('back', 'Back to current stage or checkpoint (!back)', () => ctx.back());
	reg('rtv', 'Request a map vote (!rtv)', () => ctx.rtv());
	reg(
		'map',
		'map <id>: change map (solo, or online when alone; else an RTV request nominating it)',
		(args) => {
			if (!args[0]) {
				ctx.print(`Maps: ${ctx.mapIds().join(', ')}`);
				return;
			}
			ctx.changeMap(args[0]);
		},
		() => ctx.mapIds()
	);
	reg('maps', 'List maps', () => ctx.print(`Maps: ${ctx.mapIds().join(', ')}`));
	reg('connect', 'connect <url>: connect to a server', (args) => {
		if (!args[0]) return ctx.print('Usage: connect <url>', 'error');
		ctx.connect(args[0]);
	});
	reg('disconnect', 'Disconnect and play solo', () => ctx.disconnect());
	reg('status', 'Connection and map status', () => {
		for (const l of ctx.status()) ctx.print(l);
	});
}

/**
 * Fallback for cvar names: `name` prints, `name value` sets.
 * Returns false when the name is not a cvar.
 */
export function cvarFallback(ctx: CommandContext, name: string, args: string[]): boolean {
	if (ctx.cvars.has(name)) {
		const d = ctx.cvars.defs.get(name)!;
		if (args.length === 0) {
			ctx.print(`"${name}" = "${formatCvarValue(ctx.cvars.get(name)!)}" (default "${formatCvarValue(d.default)}") - ${d.help}`);
			return true;
		}
		const err = ctx.cvars.set(name, typeof d.default === 'string' ? args.join(' ') : args[0]);
		if (err) ctx.print(err, 'error');
		return true;
	}
	if (ctx.svNames().includes(name)) {
		if (args.length === 0) ctx.print(`"${name}" = "${formatCvarValue(ctx.svGet(name) ?? 0)}"`);
		else ctx.svSet(name, args[0]);
		return true;
	}
	return false;
}
