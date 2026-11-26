/**
 * The recoil kick is fixed. The camera always shows all of it and every shot
 * follows it; a player cannot reduce or switch it off. Nothing scales it: no
 * cvar, no settings entry, no console command, no host option and not
 * `prefers-reduced-motion`.
 */
import { readFileSync } from 'node:fs';
import { INF_STEP_MS, type ClientMessage, type InfEvent, type InfStateView, type Vec3, type WeaponId } from '@surf/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_SECTIONS } from '../ui/menu/menu.js';
import { registerCommands, type CommandContext } from './commands.js';
import type { DevConsole } from './console.js';
import { CLIENT_CVARS, ClientCvars } from './cvars.js';
import { kickedPitch, RECOIL_REF_FOV, ViewKick } from './gunfeel.js';
import { InfectedClient, type InfHost } from './infected.js';
import { memoryStore, STORAGE_KEYS } from './storage.js';
import { forwardDir } from './zombies-view.js';

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const PITCH = 3;
const YAW = 20;
const T0 = 1000;

// Random pinned to 0: the spread adds nothing to a shot, so its direction is the kicked view itself.
beforeEach(() => {
	vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

type PlayerView = InfStateView['players'][number];
const pv = (id: number, over: Partial<PlayerView> = {}): PlayerView => ({
	id,
	team: 'survivor',
	alpha: false,
	hp: 5,
	alive: true,
	score: 0,
	kills: 0,
	deaths: 0,
	weapon: 'lmg',
	hasKnife: false,
	hasBeacon: false,
	streak: 0,
	perks: [],
	moabReady: false,
	...over
});

interface Frame {
	t: number;
	/** Camera kick reported for this frame (degrees). */
	pitch: number;
	yaw: number;
	roll: number;
	/** Direction of the shot fired in this tick, if one was. */
	dir: Vec3 | null;
}

/**
 * Me as a survivor in a playing round, the trigger held for `ms` with frames
 * and ticks at 64 Hz. `extra`: more host members, as a host might carry them.
 */
function spray(weapon: WeaponId, ms: number, extra: Record<string, unknown> = {}, aim = false): Frame[] {
	const sent: ClientMessage[] = [];
	const cam = { pitch: 0, yaw: 0, roll: 0 };
	const base: InfHost = {
		online: () => true,
		selfId: () => 1,
		send: (m) => void sent.push(m),
		zombieRenderer: () => null,
		infectedRenderer: () => null,
		name: (id) => `P${id}`,
		notice: () => {},
		teleport: () => {},
		sound: () => {},
		setZoom: () => {},
		push: () => {},
		setViewKick: (pitch, yaw, roll) => {
			cam.pitch = pitch;
			cam.yaw = yaw;
			cam.roll = roll;
		}
	};
	const host: InfHost = Object.assign(base, extra);
	const c = new InfectedClient(host, 0);
	const state: InfStateView = {
		phase: 'playing',
		round: 1,
		timeLeft: 120,
		loadout: weapon,
		secondary: 'pistol',
		moab: null,
		alphaId: null,
		survivors: 1,
		infected: 1,
		players: [pv(1, { weapon }), pv(2, { team: 'infected', weapon: 'claws' })],
		knives: [],
		beacons: []
	};
	c.onModeState(state, 0);
	const spawn: InfEvent = { e: 'spawn', id: 1, x: 0, y: 0, z: 0, yaw: 0, hp: 5, team: 'survivor', alpha: false, weapon, mag: 100, reserve: 0, hasKnife: false, reason: 'round' };
	c.onEvent(spawn, 0);
	const out: Frame[] = [];
	if (aim) {
		// Aimed down sights (Mouse2 held) and fully up before the trigger.
		c.press('attack2', true, 0);
		for (let t = 0; t < T0; t += INF_STEP_MS) c.frame(t, true, 0);
	}
	c.press('attack', true, T0);
	for (let t = T0; t < T0 + ms; t += INF_STEP_MS) {
		c.frame(t, true, 0);
		const n = sent.length;
		c.tick(t, ORIGIN, 64, PITCH, YAW, false);
		const fire = sent.length > n ? sent[sent.length - 1]! : null;
		out.push({ t, pitch: cam.pitch, yaw: cam.yaw, roll: cam.roll, dir: fire && fire.type === 'fire' ? { ...fire.dir } : null });
	}
	return out;
}

const text = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('the recoil kick cannot be reduced', () => {
	for (const weapon of ['lmg', 'smg', 'pistol'] as const) {
		it(`${weapon}: the camera shows the whole recoil and every shot follows it`, () => {
			const frames = spray(weapon, 1500);
			const shots = frames.filter((f) => f.dir);
			expect(shots.length).toBeGreaterThan(weapon === 'pistol' ? 0 : 12);
			// The same shots through a view kick of its own: nothing between it and the camera.
			const ref = new ViewKick(() => 0);
			let peak = 0;
			let shot = 0;
			for (const f of frames) {
				ref.update(f.t);
				expect(f.pitch).toBeCloseTo(ref.pitch, 9);
				expect(f.yaw).toBeCloseTo(ref.yaw, 9);
				expect(f.roll).toBeCloseTo(ref.roll, 9);
				peak = Math.max(peak, Math.hypot(f.pitch, f.yaw));
				if (!f.dir) continue;
				const want = forwardDir(kickedPitch(PITCH, ref.pitch), YAW + ref.yaw);
				expect(f.dir.x).toBeCloseTo(want.x, 9);
				expect(f.dir.y).toBeCloseTo(want.y, 9);
				expect(f.dir.z).toBeCloseTo(want.z, 9);
				ref.kick(weapon, f.t, false, shot++);
			}
			// Full strength: the spray throws the view well off the aim point.
			expect(peak).toBeGreaterThan(1);
		});
	}

	it('aimed down sights: the camera shows the whole aimed recoil set, and nothing scales it either', () => {
		const frames = spray('smg', 1500, {}, true);
		const ref = new ViewKick(() => 0);
		let shot = 0;
		for (const f of frames) {
			ref.update(f.t);
			expect(f.pitch).toBeCloseTo(ref.pitch, 9);
			expect(f.yaw).toBeCloseTo(ref.yaw, 9);
			if (f.dir) ref.kick('smg', f.t, 1, shot++);
		}
		expect(shot).toBeGreaterThan(12);
		expect(Math.max(...frames.map((f) => Math.hypot(f.pitch, f.yaw)))).toBeGreaterThan(1);
		const baseline = spray('lmg', 1200, {}, true);
		for (const extra of [{ viewKickScale: () => 0 }, { recoilScale: () => 0 }, { aimKickScale: () => 0 }]) expect(spray('lmg', 1200, extra, true)).toEqual(baseline);
	});

	it('host options and cvar values change neither the kick nor where the shots go', () => {
		const baseline = spray('lmg', 1200);
		expect(baseline.some((f) => Math.hypot(f.pitch, f.yaw) > 1)).toBe(true);
		// What a host used to offer, and what one might invent.
		const options: Array<Record<string, unknown>> = [{ viewKickScale: () => 0 }, { viewKickScale: () => 0.5 }, { kickScale: () => 0 }, { viewKick: 0 }, { recoilScale: () => 0 }];
		for (const extra of options) expect(spray('lmg', 1200, extra), Object.keys(extra)[0]).toEqual(baseline);
		// Every client cvar at each end of its range, read the way the game host once read `cl_viewkick`.
		for (const def of CLIENT_CVARS) {
			if (typeof def.default !== 'number') continue;
			for (const value of [def.min ?? 0, def.max ?? 1]) {
				const cvars = new ClientCvars(memoryStore());
				expect(cvars.set(def.name, value), def.name).toBeNull();
				const extra = { viewKickScale: () => cvars.num('cl_viewkick'), cvars };
				expect(spray('lmg', 1200, extra), `${def.name} ${value}`).toEqual(baseline);
			}
		}
	});

	it('prefers-reduced-motion does not soften it', () => {
		const baseline = spray('lmg', 1200);
		vi.stubGlobal('matchMedia', (query: string) => ({ matches: /reduce/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
		expect(spray('lmg', 1200)).toEqual(baseline);
		// The modules that make and apply the kick never ask.
		for (const file of ['./gunfeel.ts', './infected.ts', './modes/infected.ts', './game.ts']) expect(text(file).match(/reduced[\s-]?motion|matchMedia/gi) ?? [], file).toEqual([]);
	});

	it('no cvar, settings entry or console command for it', () => {
		expect(CLIENT_CVARS.filter((d) => /viewkick/i.test(d.name))).toEqual([]);
		expect(SETTINGS_SECTIONS.flatMap((s) => s.cvars).filter((n) => /kick|recoil/i.test(n))).toEqual([]);
		// A value saved by an older build is dropped, and the console cannot set it.
		const store = memoryStore({ [STORAGE_KEYS.cvars]: JSON.stringify({ cl_viewkick: 0, sensitivity: 3 }) });
		const cvars = new ClientCvars(store);
		expect(cvars.num('sensitivity')).toBe(3);
		expect(cvars.has('cl_viewkick')).toBe(false);
		expect(Object.keys(cvars.snapshot()).filter((n) => /viewkick/i.test(n))).toEqual([]);
		expect(cvars.set('cl_viewkick', 0)).toBe('Unknown cvar: cl_viewkick');
		const names: string[] = [];
		registerCommands({ register: (d: { name: string }) => void names.push(d.name) } as unknown as DevConsole, {} as CommandContext);
		expect(names.length).toBeGreaterThan(10);
		expect(names.filter((n) => /kick|recoil/i.test(n))).toEqual([]);
	});

	it('the host has no kick scale, and the game applies the kick as reported', () => {
		// Compile-time: this line stops type-checking when InfHost gets the member back.
		const noScale: 'viewKickScale' extends keyof InfHost ? false : true = true;
		expect(noScale).toBe(true);
		for (const file of ['./cvars.ts', './gunfeel.ts', './infected.ts', './modes/infected.ts', './game.ts', './commands.ts', '../ui/menu/menu.ts', '../ui/menu/SettingsMenu.svelte']) {
			expect(text(file).match(/cl_viewkick|viewKickScale|kickScale|hiddenKick/g) ?? [], file).toEqual([]);
		}
		// The infected host stores the kick unscaled and reads no cvar but the zoom's `fov`.
		const mode = text('./modes/infected.ts');
		const from = mode.indexOf('const inf: InfHost = {');
		const host = mode.slice(from, mode.indexOf('this.client = new InfectedClient(', from));
		expect(from).toBeGreaterThan(0);
		expect(host).toMatch(/setViewKick: \(pitch, yaw, roll\) => \{\s*view\.kickPitch = pitch;\s*view\.kickYaw = yaw;\s*view\.kickRoll = roll;\s*\}/);
		expect([...host.matchAll(/\bcvar\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['fov']);
		// The camera adds exactly that offset to the view angles.
		expect(text('./game.ts')).toMatch(/const v = this\.client\.view \?\? NO_VIEW;\s*r\?\.setView\([^;]*kickedPitch\(this\.pitch, v\.kickPitch\), this\.yaw \+ v\.kickYaw, v\.kickRoll\)/);
		// The renderer turns the camera by that roll.
		expect(text('../render/renderer.ts')).toMatch(/this\.camera\.rotation\.z = roll \* \(Math\.PI \/ 180\);/);
		// The calibration reads a constant FOV, never the `fov` cvar: gun feel touches no cvar at all.
		expect(RECOIL_REF_FOV).toBe(90);
		expect(text('./gunfeel.ts').match(/cvars|\.num\(/g) ?? []).toEqual([]);
	});
});
