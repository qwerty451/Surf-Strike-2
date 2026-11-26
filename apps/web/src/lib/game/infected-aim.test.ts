/**
 * Aiming down sights in the infected client (docs/modes.md#infected): Mouse2
 * held (or toggled with `aimToggle`, the `cl_aimtoggle` cvar), a per-gun aim
 * time, the aimed FOV the host zooms to, no aim spread fully aimed, the aimed
 * recoil set, the aimed move speed, what leaves the aim, the HUD fields, and
 * that the knife, the claws, spectators and the practice range behave.
 */
import { readFileSync } from 'node:fs';
import { INF_PRESETS, INF_SECONDARY, INF_STEP_MS, WEAPONS, type ClientMessage, type InfEvent, type InfStateView, type Vec3, type WeaponId } from '@surf/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZombieRenderer } from '../render/zombies.js';
import { CLIENT_CVARS } from './cvars.js';
import {
	AIM,
	AIM_GUN_KICK,
	AIM_SOURCE_FOV,
	aimFov,
	aimKickSet,
	aimMoveFactor,
	aimStep,
	crosshairOpacity,
	ease,
	GunKick,
	kickedPitch,
	RECOIL,
	RECOIL_REF_FOV,
	RECOIL_SOURCE,
	screenScale,
	SPREAD,
	ViewKick,
	zoomFov,
	zoomSensitivity,
	zoomStep,
	ZOOM_MS,
	type VmFeel
} from './gunfeel.js';
import { InfPractice } from './infected-practice.js';
import { InfectedClient, type InfHost, type InfSound } from './infected.js';
import { forwardDir } from './zombies-view.js';

const GUNS: readonly WeaponId[] = [...INF_PRESETS, INF_SECONDARY];
const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const tan = (deg: number) => Math.tan((deg * Math.PI) / 360);
const degBetween = (a: Vec3, b: Vec3) => (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) * 180) / Math.PI;

afterEach(() => vi.restoreAllMocks());

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

/** Me (id 1) holding `weapon` in a playing round (or offline: the practice range); the host records what the client reports. */
function setup(weapon: WeaponId = 'smg', opts: { online?: boolean; team?: 'survivor' | 'infected'; hasKnife?: boolean; phase?: 'playing' | 'waiting' } = {}) {
	const online = opts.online ?? true;
	const sent: ClientMessage[] = [];
	const sounds: InfSound[] = [];
	const zoom: Array<number | null> = [];
	const cam = { pitch: 0, yaw: 0, fov: 0, t: 0 };
	const vm: { visible: boolean; feel: VmFeel | null } = { visible: false, feel: null };
	const zr = {
		setWeapon: () => {},
		setOffhandKnife: () => {},
		thrown: () => {},
		fired: () => {},
		tracer: () => {},
		updateViewmodel: (_now: number, visible: boolean, _reload: number, _speed: number, feel?: VmFeel) => {
			vm.visible = visible;
			vm.feel = feel ? { ...feel } : null;
		},
		clear: () => {}
	} as unknown as ZombieRenderer;
	const host: InfHost = {
		online: () => online,
		selfId: () => 1,
		send: (m) => void sent.push(m),
		zombieRenderer: () => zr,
		infectedRenderer: () => null,
		name: (id) => `P${id}`,
		notice: () => {},
		teleport: () => {},
		sound: (n) => void sounds.push(n),
		setZoom: (f) => void zoom.push(f),
		push: () => {},
		zoomProgress: (fov, t) => {
			cam.fov = fov;
			cam.t = t;
		},
		setViewKick: (pitch, yaw) => {
			cam.pitch = pitch;
			cam.yaw = yaw;
		},
		spawns: () => [{ pos: { x: 400, y: 0, z: 0 }, yaw: 0 }]
	};
	const c = new InfectedClient(host, 0);
	const team = opts.team ?? 'survivor';
	if (online) {
		const me = team === 'infected' ? pv(1, { team, weapon: 'claws', hasKnife: !!opts.hasKnife }) : pv(1, { weapon });
		c.onModeState({ phase: opts.phase ?? 'playing', round: 1, timeLeft: 120, loadout: weapon === INF_SECONDARY ? 'lmg' : weapon, secondary: 'pistol', moab: null, alphaId: null, survivors: 1, infected: 1, players: [me, pv(2, { team: 'infected', weapon: 'claws' })], knives: [], beacons: [] }, 0);
		const spawn: InfEvent = { e: 'spawn', id: 1, x: 0, y: 0, z: 0, yaw: 0, hp: 5, team, alpha: false, weapon: team === 'infected' ? 'claws' : weapon, mag: WEAPONS[weapon].magazine, reserve: 50, hasKnife: !!opts.hasKnife, reason: 'round' };
		c.onEvent(spawn, 0);
	}
	let now = 0;
	/** Frames and ticks at 64 Hz up to `t`. */
	const to = (t: number, vel: Vec3 = ORIGIN, onGround = true) => {
		while (now + INF_STEP_MS <= t) {
			now += INF_STEP_MS;
			c.frame(now, true, 0);
			c.tick(now, ORIGIN, 64, 0, 0, false, vel, onGround);
		}
		now = Math.max(now, t);
		return c.frame(now, true, 0);
	};
	/** One trigger pull now; the direction of the shot it fired, if any. */
	const shot = (): Vec3 | null => {
		const n = sent.length;
		const hits = c.practicing;
		c.press('attack', true, now);
		c.tick(now, ORIGIN, 64, 0, 0, false);
		c.press('attack', false, now);
		const m = sent.slice(n).find((x) => x.type === 'fire');
		return m && m.type === 'fire' ? m.dir : hits ? { x: NaN, y: NaN, z: NaN } : null;
	};
	return { c, sent, sounds, zoom, cam, vm, to, shot, at: () => now };
}

describe('aim data (G9)', () => {
	it('every gun has an aim time, a source FOV and a move factor from the source table; melee has none', () => {
		const want: Record<string, [number, number, number]> = {
			pistol: [200, 65, 0.8],
			smg: [200, 55, 0.8],
			lmg: [379, 55, 0.4],
			striker: [200, 55, 0.4],
			sniper: [400, 15, 0.4],
			barrett: [400, 15, 0.4]
		};
		for (const w of GUNS) {
			const a = AIM[w]!;
			expect([a.aimMs, a.sourceFov, a.move], w).toEqual(want[w]!.map((v, i) => (i === 2 ? expect.closeTo(v, 9) : v)));
			// The kick calibration and the aim read the same source row.
			expect(a.sourceFov, w).toBe(RECOIL_SOURCE[w]!.fov);
		}
		expect(AIM.knife).toBeUndefined();
		expect(AIM.claws).toBeUndefined();
	});

	it('aimed FOV: the source magnification on the player FOV; the pistol does not zoom; the rifles zoom to their scope', () => {
		for (const fov of [70, 90, 110, 130])
			for (const w of ['smg', 'lmg', 'striker'] as const) {
				const f = aimFov(fov, w);
				expect(tan(fov) / tan(f), `${w} ${fov}`).toBeCloseTo(tan(AIM_SOURCE_FOV) / tan(55), 9);
				expect(f).toBeLessThan(fov);
			}
		expect(aimFov(90, 'smg')).toBeCloseTo(78.5, 1);
		expect(aimFov(90, 'pistol')).toBeCloseTo(90, 9);
		expect(aimFov(110, 'pistol')).toBeCloseTo(110, 9);
		expect(aimFov(110, 'sniper')).toBe(40);
		expect(aimFov(90, 'barrett')).toBe(38);
		expect(aimFov(90, 'knife')).toBe(90);
	});

	it('sensitivity follows the zoom through zoom_sensitivity_ratio (the pistol: only the ratio)', () => {
		for (const ratio of [1, 0.8]) {
			const t = 1;
			const smg = aimFov(90, 'smg');
			expect(zoomSensitivity(90, zoomFov(90, smg, t), ratio, t)).toBeCloseTo((ratio * tan(smg)) / tan(90), 9);
			expect(zoomSensitivity(90, zoomFov(90, aimFov(90, 'pistol'), t), ratio, t)).toBeCloseTo(ratio, 9);
			// At the hip nothing changes, whatever the ratio.
			expect(zoomSensitivity(90, zoomFov(90, smg, 0), ratio, 0)).toBe(1);
		}
	});

	it('aimed recoil: the source values on the aimed FOV (x1.570 for every unscoped gun); the rifles aim with the scoped set', () => {
		const k = Math.tan(Math.PI / 4) / Math.tan((32.5 * Math.PI) / 180);
		expect(k).toBeCloseTo(1.5697, 4);
		for (const w of ['pistol', 'smg', 'lmg', 'striker'] as const) {
			const s = RECOIL_SOURCE[w]!;
			const a = RECOIL[w]!.aimed!;
			expect(a.pitchMin, w).toBeCloseTo(s.pitchMin * k, 9);
			expect(a.pitchMax, w).toBeCloseTo(s.pitchMax * k, 9);
			expect(a.yawMin, w).toBeCloseTo(s.yawMin * k, 9);
			expect(a.yawMax, w).toBeCloseTo(s.yawMax * k, 9);
			expect(a.centerSpeed, w).toBeCloseTo(s.centerSpeed * k, 9);
			// On screen at the aimed FOV it moves the picture as far as the source's aimed shot.
			expect(a.pitchMax * screenScale(aimFov(RECOIL_REF_FOV, w), s.fov)).toBeCloseTo(s.pitchMax, 9);
		}
		for (const w of ['sniper', 'barrett'] as const) expect(RECOIL[w]!.aimed).toBe(RECOIL[w]!.scoped);
		// In between the sets blend; at 0 it is the hip set itself.
		const d = RECOIL.lmg!;
		expect(aimKickSet(d, 0)).toBe(d.hip);
		expect(aimKickSet(d, 1).pitchMax).toBeCloseTo(d.aimed!.pitchMax, 9);
		expect(aimKickSet(d, 0.5).pitchMax).toBeCloseTo((d.hip.pitchMax + d.aimed!.pitchMax) / 2, 9);
		expect(aimKickSet(d, 0.5).centerSpeed).toBeCloseTo((d.hip.centerSpeed + d.aimed!.centerSpeed) / 2, 9);
	});

	it('aim progress is linear over the aim time both ways; the move factor blends with it', () => {
		expect(aimStep(0, true, 100, 200)).toBeCloseTo(0.5, 9);
		expect(aimStep(0.5, true, 500, 200)).toBe(1);
		expect(aimStep(1, false, 50, 200)).toBeCloseTo(0.75, 9);
		expect(aimStep(0.1, false, 500, 200)).toBe(0);
		expect(aimStep(0.4, true, -5, 200)).toBe(0.4);
		expect(aimMoveFactor('lmg', 0)).toBe(1);
		expect(aimMoveFactor('lmg', 1)).toBeCloseTo(0.4, 9);
		expect(aimMoveFactor('lmg', 0.5)).toBeCloseTo(0.7, 9);
		expect(aimMoveFactor('knife', 1)).toBe(1);
		expect(aimMoveFactor('claws', 1)).toBe(1);
	});

	it('the crosshair fades out with the aim and is hidden fully aimed', () => {
		expect(crosshairOpacity(undefined)).toBe(1);
		expect(crosshairOpacity(0)).toBe(1);
		expect(crosshairOpacity(0.5)).toBe(0.5);
		expect(crosshairOpacity(1)).toBe(0);
	});

	it('the HUD hides the crosshair through crosshairOpacity(aimT) and fades it on the way', () => {
		const hud = readFileSync(new URL('../ui/Hud.svelte', import.meta.url), 'utf8');
		const line = hud.split('\n').find((l) => l.includes('<Crosshair '))!;
		expect(line).toContain('crosshairOpacity(hud.infected?.aimT ?? hud.tournament?.aimT) > 0');
		expect(line).toContain('opacity={crosshairOpacity(hud.infected?.aimT ?? hud.tournament?.aimT)}');
		const cross = readFileSync(new URL('../ui/Crosshair.svelte', import.meta.url), 'utf8');
		expect(cross).toMatch(/style:opacity=\{opacity < 1 \? opacity : undefined\}/);
	});

	it('the aim toggle is a cvar, off (hold) by default, in the mouse settings', async () => {
		const def = CLIENT_CVARS.find((d) => d.name === 'cl_aimtoggle')!;
		expect(def).toMatchObject({ default: 0, bool: true });
		const { SETTINGS_SECTIONS } = await import('../ui/menu/menu.js');
		expect(SETTINGS_SECTIONS.find((s) => s.id === 'mouse')!.cvars).toContain('cl_aimtoggle');
	});
});

describe('Mouse2 aims (G9)', () => {
	it('held by default: aims while held, lets go on release', () => {
		const u = setup('smg');
		u.to(100);
		u.c.press('attack2', true, u.at());
		const v = u.to(100 + AIM.smg!.aimMs + 20);
		expect(v.aimT).toBe(1);
		u.c.press('attack2', false, u.at());
		expect(u.to(u.at() + AIM.smg!.aimMs + 20).aimT).toBe(0);
	});

	it('toggle: a press aims, the next press stops; releases do nothing', () => {
		const u = setup('smg');
		u.c.aimToggle = true;
		u.to(100);
		u.c.press('attack2', true, u.at());
		u.c.press('attack2', false, u.at() + 10);
		expect(u.to(400).aimT).toBe(1);
		u.c.press('attack2', true, u.at());
		u.c.press('attack2', false, u.at() + 10);
		expect(u.to(700).aimT).toBe(0);
	});

	it('every gun takes its own aim time to come up, easing in and out', () => {
		for (const w of GUNS) {
			const u = setup(w);
			u.to(100);
			u.c.press('attack2', true, 100);
			const ms = AIM[w]!.aimMs;
			const half = u.to(100 + ms / 2).aimT!;
			expect(half, w).toBeGreaterThan(0.3);
			expect(half, w).toBeLessThan(0.7);
			expect(u.to(100 + ms * 0.8).aimT, w).toBeLessThan(1);
			expect(u.to(100 + ms + 20).aimT, w).toBe(1);
			// The host zooms to the gun's aimed FOV along the eased progress.
			expect(u.cam.fov, w).toBeCloseTo(aimFov(RECOIL_REF_FOV, w), 9);
			expect(u.cam.t, w).toBe(1);
			const t0 = u.at();
			u.c.press('attack2', false, t0);
			const out = u.to(t0 + ms / 4).aimT!;
			expect(out, w).toBeGreaterThan(0.7);
			expect(out, w).toBeLessThan(1);
			expect(u.to(t0 + ms + 20).aimT, w).toBe(0);
			expect(u.cam.t, w).toBe(0);
		}
	});

	it('the FOV moves over the last ZOOM_MS of the aim, or the whole aim when it is shorter (G4)', () => {
		for (const w of GUNS) {
			const ms = AIM[w]!.aimMs;
			const window = Math.min(ms, ZOOM_MS);
			const from = 1 - window / ms;
			expect(zoomStep(0, ms), w).toBe(0);
			expect(zoomStep(from, ms), w).toBeCloseTo(0, 9);
			expect(zoomStep(from + (1 - from) / 2, ms), w).toBeCloseTo(0.5, 9);
			expect(zoomStep(1, ms), w).toBe(1);
			expect(window, w).toBeGreaterThanOrEqual(100);
			expect(window, w).toBeLessThanOrEqual(200);
		}
	});

	it("the zoom follows the player's FOV", () => {
		const u = setup('lmg');
		u.c.fov = 110;
		u.to(100);
		u.c.press('attack2', true, 100);
		u.to(600);
		expect(u.cam.fov).toBeCloseTo(aimFov(110, 'lmg'), 9);
		expect(tan(110) / tan(u.cam.fov)).toBeCloseTo(tan(65) / tan(55), 9);
	});

	it('a weapon still being drawn can start to aim', () => {
		const u = setup('lmg');
		u.to(100);
		u.c.slot(2, 100);
		expect(u.to(110).aimT).toBe(0);
		u.c.press('attack2', true, 120);
		// The pistol's draw (deployMs) is still running.
		expect(120 + 30).toBeLessThan(100 + WEAPONS.pistol.deployMs!);
		expect(u.to(150).aimT).toBeGreaterThan(0);
		expect(u.to(120 + AIM.pistol!.aimMs + 20).aimT).toBe(1);
	});

	it('the knife has no aim; the claws keep the throwing knife on Mouse2', () => {
		const u = setup('lmg');
		u.to(100);
		u.c.slot(3, 100);
		u.to(500);
		u.c.press('attack2', true, 500);
		const v = u.to(900);
		expect(v).toMatchObject({ weapon: 'knife', aimT: 0, scoped: false });
		expect(u.c.maxSpeed(900)).toBe(WEAPONS.knife.moveSpeed);
		expect(u.vm.feel!.aim).toBe(0);
		// Toggle mode does not latch an aim on the knife either.
		u.c.press('attack2', false, 900);
		u.c.aimToggle = true;
		u.c.press('attack2', true, 910);
		expect(u.to(1300).aimT).toBe(0);

		const z = setup('lmg', { team: 'infected', hasKnife: true });
		z.to(100);
		z.c.press('attack2', true, 100);
		z.to(120);
		expect(z.sent.map((m) => m.type)).toContain('throwKnife');
		const zv = z.to(600);
		expect(zv).toMatchObject({ weapon: 'claws', aimT: 0 });
		expect(z.cam.t).toBe(0);
	});
});

describe('what leaves the aim (G9)', () => {
	const aimed = (w: WeaponId = 'smg', toggle = false) => {
		const u = setup(w);
		u.c.aimToggle = toggle;
		u.to(100);
		u.c.press('attack2', true, 100);
		if (toggle) u.c.press('attack2', false, 110);
		expect(u.to(100 + AIM[w]!.aimMs + 20).aimT).toBe(1);
		return u;
	};

	it('reload: the aim drops while reloading; a held aim comes back after, a toggled one stays off', () => {
		for (const toggle of [false, true]) {
			const u = aimed('smg', toggle);
			for (let i = 0; i < 3; i++) u.shot(), u.to(u.at() + WEAPONS.smg.fireMs + 5);
			u.c.reload(u.at());
			expect(u.c.frame(u.at(), true, 0).reloadEndsAt).toBeGreaterThan(0);
			expect(u.to(u.at() + 260).aimT).toBe(0);
			const done = u.at() + WEAPONS.smg.reloadMs + 300;
			expect(u.to(done).aimT, 'toggle ' + toggle).toBe(toggle ? 0 : 1);
		}
	});

	it('swap: the new weapon comes up at the hip at once', () => {
		for (const toggle of [false, true]) {
			const u = aimed('smg', toggle);
			u.c.slot(2, u.at());
			expect(u.c.frame(u.at(), true, 0)).toMatchObject({ weapon: 'pistol', aimT: 0 });
			// A held aim then aims the pistol; a toggled one is off.
			expect(u.to(u.at() + 300).aimT, 'toggle ' + toggle).toBe(toggle ? 0 : 1);
		}
	});

	it('death, spectating and the round end let go of the aim', () => {
		const a = aimed();
		a.c.onEvent({ e: 'kill', by: 2, targetId: 1, weapon: 'claws', head: false, x: 0, y: 0, z: 0, yaw: 0 }, a.at());
		expect(a.c.frame(a.at() + 1, true, 0).aimT).toBe(0);
		expect(a.cam.t).toBe(0);

		const s = aimed();
		s.c.setSpectate(true, 2);
		expect(s.c.frame(s.at() + 1, true, 0)).toMatchObject({ aimT: 0, scopeT: 0 });
		expect(s.cam.t).toBe(0);
		// Back from spectating the button has to be pressed again.
		s.c.setSpectate(false, null);
		expect(s.to(s.at() + 500).aimT).toBe(0);

		const e = aimed('barrett');
		e.c.onEvent({ e: 'end', winner: 'survivors', round: 1, secs: 120, survivorsLeft: 1, topId: null, topScore: 0 }, e.at());
		expect(e.zoom.at(-1)).toBeNull();
		expect(e.to(e.at() + 500)).toMatchObject({ aimT: 0, scoped: false });
	});

	it('pointer lock lost (game.ts releases Mouse2): a held aim lets go, a toggled one stays', () => {
		const h = aimed('smg', false);
		h.c.press('attack2', false, h.at());
		expect(h.to(h.at() + 300).aimT).toBe(0);
		const t = aimed('smg', true);
		t.c.press('attack2', false, t.at());
		expect(t.to(t.at() + 300).aimT).toBe(1);
	});
});

describe('aimed fire (G10)', () => {
	it('fully aimed there is no aim spread: the shot leaves along the view; in between the cone blends', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1);
		for (const w of GUNS) {
			const u = setup(w);
			u.to(100);
			const hip = degBetween(u.shot()!, forwardDir(0, 0));
			expect(hip, w).toBeCloseTo(SPREAD[w]!.min, 6);
			u.to(100 + 2000);
			u.c.press('attack2', true, u.at());
			const start = u.at();
			const ms = AIM[w]!.aimMs;
			u.to(start + ms / 2);
			const t = ease((u.at() - start) / ms);
			const half = degBetween(u.shot()!, forwardDir(0, 0));
			expect(half, w).toBeCloseTo(SPREAD[w]!.min * (1 - t), 4);
			u.to(u.at() + 3000);
			expect(degBetween(u.shot()!, forwardDir(0, 0)), w).toBeLessThan(1e-6);
		}
	});

	it('the shotgun keeps its pellet cone when aimed', () => {
		const u = setup('striker');
		u.to(100);
		u.c.press('attack2', true, 100);
		u.to(600);
		const d = u.shot()!;
		expect(degBetween(d, forwardDir(0, 0))).toBeLessThan(1e-6);
		// The pellets are the server's, around this direction.
		expect(WEAPONS.striker.pelletSpread).toBe(4);
	});

	it('an aimed shot kicks with the aimed set, a hip shot with the hip set', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1);
		for (const [w, aim] of [['smg', 0], ['smg', 1], ['lmg', 1], ['pistol', 1]] as const) {
			const u = setup(w);
			u.to(100);
			if (aim) u.c.press('attack2', true, 100);
			u.to(900);
			const t0 = u.at();
			u.shot();
			const ref = new ViewKick(() => 1);
			ref.update(t0);
			ref.kickWith(aim ? RECOIL[w]!.aimed! : RECOIL[w]!.hip, t0);
			u.to(t0 + 50);
			ref.update(u.at());
			expect(u.cam.pitch, w + ' ' + aim).toBeCloseTo(ref.pitch, 9);
			expect(u.cam.yaw, w + ' ' + aim).toBeCloseTo(ref.yaw, 9);
		}
	});
});

describe('gun kick while aimed (G10)', () => {
	it('through iron sights a share of the gun kick turns the next shot, as far as the sights show it; from the hip and through a scope it does not', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1);
		for (const w of GUNS) {
			for (const aim of [false, true]) {
				const u = setup(w);
				u.to(100);
				if (aim) u.c.press('attack2', true, 100);
				u.to(900);
				const t0 = u.at();
				const first = u.shot()!;
				// Next shot as soon as the gun allows: the gun kick is still up.
				u.to(t0 + WEAPONS[w].fireMs + 1);
				const t1 = u.at();
				const view = new ViewKick(() => 1);
				view.update(t0);
				view.kickWith(aim ? RECOIL[w]!.aimed! : RECOIL[w]!.hip, t0);
				view.update(t1);
				const gun = new GunKick(() => 1);
				gun.update(t0);
				gun.kick(w, t0);
				gun.update(t1);
				const shown = u.vm.feel!.gun!;
				const second = u.shot()!;
				const g = aim && WEAPONS[w].zoomFov === null ? AIM_GUN_KICK : 0;
				const want = forwardDir(kickedPitch(0, view.pitch - g * gun.pitch), view.yaw + g * gun.yaw);
				const name = w + (aim ? ' aimed' : ' hip');
				expect(degBetween(first, forwardDir(0, 0)), name).toBeLessThan(aim ? 1e-6 : 90);
				if (aim) expect(degBetween(second, want), name).toBeLessThan(1e-6);
				// The viewmodel shows the same share of it while aimed through iron sights (all of it otherwise).
				expect(shown.pitch, name).toBeCloseTo(gun.pitch * (g > 0 ? g : 1), 6);
				if (g > 0) expect(degBetween(second, forwardDir(kickedPitch(0, view.pitch), view.yaw)), name).toBeGreaterThan(0.05);
			}
		}
	});

	it('mid-aim, before the FOV moves, the shown gun kick already follows the aim (LMG)', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1);
		const u = setup('lmg');
		u.to(900);
		u.c.press('attack2', true, 900);
		u.to(900 + AIM.lmg!.aimMs * 0.4);
		const t0 = u.at();
		expect(u.shot()).not.toBeNull();
		const v = u.to(t0 + 5);
		const t1 = u.at();
		expect(zoomStep(v.aimT!, AIM.lmg!.aimMs)).toBe(0);
		const gun = new GunKick(() => 1);
		gun.update(t0);
		gun.kick('lmg', t0);
		gun.update(t1);
		// Already cut by the aim (it would be the whole kick if it waited for the zoom), not yet down to the aimed share.
		const share = u.vm.feel!.gun!.pitch / gun.pitch;
		expect(share).toBeLessThan(0.9);
		expect(share).toBeGreaterThan(AIM_GUN_KICK);
	});
});

describe('movement while aimed (G9)', () => {
	it("max speed drops by the gun's aimed move factor, eased in with the aim", () => {
		for (const w of GUNS) {
			const u = setup(w);
			u.to(100);
			expect(u.c.maxSpeed(100), w).toBe(WEAPONS[w].moveSpeed);
			u.c.press('attack2', true, 100);
			u.to(100 + AIM[w]!.aimMs + 20);
			expect(u.c.maxSpeed(u.at()), w).toBeCloseTo(WEAPONS[w].moveSpeed * AIM[w]!.move, 9);
		}
		const u = setup('lmg');
		u.to(100);
		u.c.press('attack2', true, 100);
		u.to(100 + AIM.lmg!.aimMs / 2);
		const s = u.c.maxSpeed(u.at());
		expect(s).toBeLessThan(WEAPONS.lmg.moveSpeed);
		expect(s).toBeGreaterThan(WEAPONS.lmg.moveSpeed * AIM.lmg!.move);
	});
});

describe('HUD and viewmodel (G9)', () => {
	it('aimT for every gun; scopeT and scoped only for the rifles; the viewmodel aims and the rifles hide once fully scoped', () => {
		for (const w of GUNS) {
			const u = setup(w);
			u.to(100);
			u.c.press('attack2', true, 100);
			const mid = u.to(100 + AIM[w]!.aimMs / 2);
			expect(u.vm.visible, w).toBe(true);
			expect(u.vm.feel!.aim, w).toBeCloseTo(ease((u.at() - 100) / AIM[w]!.aimMs), 9);
			const v = u.to(100 + AIM[w]!.aimMs + 20);
			const rifle = WEAPONS[w].zoomFov !== null;
			expect(v.aimT, w).toBe(1);
			expect(v.scoped, w).toBe(rifle);
			expect(v.scopeT, w).toBe(rifle ? 1 : 0);
			// The scope overlay waits for the rifle to come up: nothing of it halfway, all of it fully aimed.
			expect(mid.scopeT, w).toBe(0);
			if (rifle) expect(u.to(100 + AIM[w]!.aimMs * 0.8).scopeT, w).toBeGreaterThan(0);
			expect(u.vm.visible, w).toBe(!rifle);
			expect(u.vm.feel!.aim, w).toBe(1);
			// The draw no longer lowers the gun for the scope.
			expect(u.vm.feel!.lower, w).toBe(0);
			expect(crosshairOpacity(v.aimT)).toBe(0);
		}
	});
});

describe('practice range (G9)', () => {
	for (const mode of ['offline', 'waiting for players'] as const) {
		it(`${mode}: aim, zoom and pinpoint shots work on the range; nothing is sent`, () => {
			vi.spyOn(Math, 'random').mockReturnValue(1);
			const shots = vi.spyOn(InfPractice.prototype, 'shot');
			const u = setup('lmg', { online: mode !== 'offline', phase: mode === 'offline' ? 'playing' : 'waiting' });
			u.to(200);
			expect(u.c.practicing).toBe(true);
			const w = u.c.weapon;
			u.c.press('attack2', true, u.at());
			const v = u.to(u.at() + AIM[w]!.aimMs + 20);
			expect(v.aimT).toBe(1);
			expect(u.cam.fov).toBeCloseTo(aimFov(RECOIL_REF_FOV, w), 9);
			expect(u.c.maxSpeed(u.at())).toBeCloseTo(WEAPONS[w].moveSpeed * AIM[w]!.move, 9);
			// A fully aimed shot on the range leaves along the view (random pinned to the cone's edge).
			u.to(u.at() + 2000);
			u.shot();
			expect(shots).toHaveBeenCalledTimes(1);
			const dir = shots.mock.calls[0]![2];
			expect(degBetween(dir, forwardDir(0, 0))).toBeLessThan(1e-6);
			// Key 4 tries the next primary: the swap leaves the aim, the held button aims it.
			u.c.slot(4, u.at());
			expect(u.c.frame(u.at(), true, 0).aimT).toBe(0);
			expect(u.to(u.at() + 600).aimT).toBe(1);
			expect(u.sent.filter((m) => m.type !== 'loadout')).toEqual([]);
			expect(u.sent.filter((m) => m.type === 'fire')).toEqual([]);
		});
	}
});
