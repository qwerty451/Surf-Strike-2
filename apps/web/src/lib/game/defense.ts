/**
 * Zombie Defense client (docs/modes.md#zombie-defense). Online it predicts the
 * local weapons (fire rate, ammo, reloads, swaps), sends `fire`/`reload`/`zd`,
 * draws zombies and turrets from interpolated BIN_DEFENSE frames and shows
 * the server's events. Solo it runs the shared `DefenseGame` itself, so the
 * mode is playable offline. game.ts owns the player, camera and input; this
 * module owns everything defense-specific behind a small host interface, and
 * modes/defense.ts puts it behind ClientMode.
 *
 * Keys: 1-5 weapons (ZD_WEAPONS order, owned only), E (`beacon`) held to
 * repair the barricade in front of you or pressed on a turret pad in the build
 * phase (pad menu), B (`shop`) the shop in the build phase, F (`ready`). The
 * shop and the pad menu keep the pointer locked: number keys pick their rows
 * (clicks work too while the cursor is free).
 */
import {
	buildCollisionWorld,
	DefenseGame,
	defenseWorld,
	isZdWeapon,
	rayZombie,
	WEAPONS,
	WeaponState,
	ZD_PAD_RANGE,
	ZD_PLAYER_HP,
	ZD_SHOP,
	ZD_TURRETS,
	ZD_ZOMBIES,
	ZDF_FROSTED,
	ZDT_FIRED,
	ZD_FIRE_FLAG_TICKS,
	zdEventRoute,
	zdIsBossWave,
	type ClientMessage,
	type Cvars,
	type DefenseFrame,
	type DefenseMapInfo,
	type GatedWorld,
	type HitboxPose,
	type MapDef,
	type Vec3,
	type WeaponId,
	type ZdAction,
	type ZdEvent,
	type ZdPlayerStatus,
	type ZdPlayerView,
	type ZdStateView,
	type ZdTurretNet,
	type ZdWeaponId,
	type ZdZombieKind,
	type ZdZombieNet
} from '@surf/shared';
import { INTERP_DELAY_MS } from '../net/interp.js';
import { DefenseBuffer, type TurretShot } from '../net/defense-interp.js';
import type { HeldItem } from '../render/character/held.js';
import type { DefenseRenderer } from '../render/defense.js';
import type { ZombiePose, ZombieRenderer } from '../render/zombies.js';
import type { DefenseView, KillFeedLine } from './contract.js';
import {
	zdPadMenu,
	zdPromptText,
	zdReasonText,
	zdShopMenu,
	zdSlotWeapon,
	zdUseTarget,
	zdWeaponKeys,
	type ZdMenu,
	type ZdShopPage,
	type ZdUseTarget,
	attackText,
	bossWaveText
} from './defense-view.js';
import { FIRE_BUFFER_MS, forwardDir, liveKillFeed, pushKillFeed, spreadDir } from './zombies-view.js';

/** Player id of the local player in solo. */
export const SOLO_ID = 1;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const SOLO_VIEW_MS = 200;
/** One turret's gunshot sound at most this often (a sentry fires every 90-140 ms). */
const TURRET_SOUND_MS = 110;

/** Sounds, all existing recordings played through the infected names (audio/combat.ts INFECTED_SOUNDS and chimes). */
export type DfSound =
	| `shot-${'pistol' | 'smg' | 'striker' | 'lmg' | 'sniper'}`
	| 'reload'
	| 'casing'
	| 'shell'
	| 'hit'
	| 'hitHead'
	| 'hitKill'
	| 'hurt'
	| 'death'
	| 'dryfire'
	| 'handle'
	| 'knifeStick'
	| 'beacon'
	| 'beaconSmash'
	| 'beaconUse'
	| 'round'
	| 'perk';

export interface DfHost {
	online(): boolean;
	selfId(): number;
	send(msg: ClientMessage): void;
	zombieRenderer(): ZombieRenderer | null;
	defenseRenderer(): DefenseRenderer | null;
	name(id: number): string;
	notice(text: string): void;
	teleport(x: number, y: number, z: number, yaw: number): void;
	sound(name: DfSound, at?: Vec3): void;
	/** Zoom: horizontal FOV at 4:3, or null for the cvar FOV. */
	setZoom(fov: number | null): void;
}

/** How each kind is drawn: model scale (as its hitbox), colour and glow. */
export const ZD_KIND_LOOK: Readonly<Record<ZdZombieKind, { scale: number; tint: number; glow?: number }>> = {
	walker: { scale: ZD_ZOMBIES.walker.scale, tint: 0xffffff },
	runner: { scale: ZD_ZOMBIES.runner.scale, tint: 0xffe2a0 },
	brute: { scale: ZD_ZOMBIES.brute.scale, tint: 0xc07468 },
	boss: { scale: ZD_ZOMBIES.boss.scale, tint: 0xa07cc8, glow: 0x2a0a40 }
};
const FROST_TINT = 0x9fd8ff;
const FROST_GLOW = 0x0a2a40;

/** Zombie Run's hitbox scaled about the feet (as DefenseGame's rayScaled). */
function rayKind(o: Vec3, d: Vec3, p: HitboxPose, maxT: number, s: number): { t: number; head: boolean } | null {
	if (s === 1) return rayZombie(o, d, p, maxT);
	const o2 = { x: p.x + (o.x - p.x) / s, y: p.y + (o.y - p.y) / s, z: p.z + (o.z - p.z) / s };
	const h = rayZombie(o2, d, p, maxT / s);
	return h ? { t: h.t * s, head: h.head } : null;
}

/** The drawn pose of a snapshot zombie. */
export function zombiePose(z: ZdZombieNet): ZombiePose {
	const look = ZD_KIND_LOOK[z.kind];
	const frosted = (z.flags & ZDF_FROSTED) !== 0;
	return {
		id: z.id,
		x: z.x,
		y: z.y,
		z: z.z,
		yaw: z.yaw,
		flags: z.flags,
		scale: look.scale,
		tint: frosted && z.kind !== 'boss' ? FROST_TINT : look.tint,
		glow: frosted ? FROST_GLOW : look.glow
	};
}

type MenuState = { page: ZdShopPage } | { page: 'pad'; pad: number };

export class DefenseClient {
	/** Map collision plus boarded openings: the local player moves in this world. */
	readonly world: GatedWorld;
	readonly info: DefenseMapInfo;
	private solo: DefenseGame | null = null;
	private soloViewAt = 0;
	private weapons = new Map<ZdWeaponId, WeaponState>();
	private held: ZdWeaponId = 'pistol';
	private buffer = new DefenseBuffer();
	private zSamples: ZdZombieNet[] = [];
	private tSamples: ZdTurretNet[] = [];
	private shots: TurretShot[] = [];
	private poses: ZombiePose[] = [];
	/** Zombies killed this wave: a late frame never brings one back. */
	private killed = new Set<number>();
	private lastFire = new Map<number, number>();
	private lastTurretSound = new Map<number, number>();
	private state: ZdStateView | null = null;
	private stateAt = 0;
	/** Bumped when an event changes the state between two modeStates (the HUD view key). */
	private rev = 0;
	private status: ZdPlayerStatus = 'waiting';
	private hp = ZD_PLAYER_HP;
	private maxHp = ZD_PLAYER_HP;
	private lastGold: number | null = null;
	private goldPop: DefenseView['goldPop'] = null;
	private fireHeld = false;
	private firePressAt = -Infinity;
	private scoped = false;
	private hitMarker: DefenseView['hitMarker'] = null;
	private feed: KillFeedLine[] = [];
	private feedId = 0;
	private flash: DefenseView['flash'] = null;
	private alert: DefenseView['alert'] = null;
	private hurtAt = 0;
	private summary: DefenseView['summary'] = null;
	private menu: MenuState | null = null;
	private menuNotice: { text: string; ok: boolean; at: number } | null = null;
	private builtMenu: ZdMenu | null = null;
	private repairing = false;
	private target: ZdUseTarget | null = null;
	private pos: Vec3 = { x: 0, y: 0, z: 0 };
	private viewKey = '';
	private view: DefenseView | null = null;
	private readonly base;

	constructor(
		private readonly host: DfHost,
		private readonly map: MapDef,
		private readonly cvars: Cvars,
		now: number
	) {
		const info = map.defense;
		if (!info) throw new Error(`${map.id} has no defense data`);
		this.info = info;
		this.base = buildCollisionWorld(map);
		this.world = defenseWorld(this.base, info);
		this.resetWeapons();
		host.defenseRenderer()?.setMap(info);
		if (!host.online()) this.startSolo(now);
	}

	private startSolo(now: number): void {
		this.solo = new DefenseGame({ map: this.map, world: this.base, cvars: this.cvars, now });
		// The local player moves in the solo game's gated world.
		(this as { world: GatedWorld }).world = this.solo.world;
		this.solo.syncPlayers([SOLO_ID], now);
		this.handle(this.solo.update(now), now);
		this.applyState(this.solo.view(now), now);
	}

	get me(): number {
		return this.solo ? SOLO_ID : this.host.selfId();
	}

	get isSolo(): boolean {
		return this.solo !== null;
	}

	private get ws(): WeaponState {
		return this.weapons.get(this.held)!;
	}

	get alive(): boolean {
		return this.status === 'alive';
	}

	/** Held weapon's move speed (CS-style). */
	maxSpeed(): number {
		return WEAPONS[this.held].moveSpeed;
	}

	/** A remote player who is dead or waiting for the next build phase is not drawn. */
	isDown(id: number): boolean {
		return this.state?.players.some((p) => p.id === id && p.status !== 'alive') ?? false;
	}

	heldOf(id: number): HeldItem | null {
		const p = this.state?.players.find((q) => q.id === id);
		return p ? p.weapon : null;
	}

	private resetWeapons(): void {
		this.weapons.clear();
		this.weapons.set('pistol', new WeaponState('pistol'));
		this.held = 'pistol';
		this.setScoped(false);
		this.host.zombieRenderer()?.setWeapon('pistol');
	}

	private meView(): ZdPlayerView | null {
		return this.state?.players.find((p) => p.id === this.me) ?? null;
	}

	// ---------------------------------------------------------------------
	// Input

	press(action: 'attack' | 'attack2', down: boolean, now: number): void {
		if (action === 'attack') {
			this.fireHeld = down;
			if (down) this.firePressAt = now;
			return;
		}
		if (!down || !this.alive) return;
		const zoom = WEAPONS[this.held].zoomFov;
		this.setScoped(zoom !== null && !this.scoped);
	}

	/** Every button let go (menus, focus loss): the trigger and the repair hold. */
	release(now: number): void {
		this.fireHeld = false;
		this.stopRepair(now);
	}

	private setScoped(on: boolean): void {
		if (on === this.scoped) return;
		this.scoped = on;
		this.host.setZoom(on ? WEAPONS[this.held].zoomFov : null);
	}

	/** Number keys: a menu row while a menu is open, else a weapon. False: the key is not used. */
	slot(n: number, now: number): boolean {
		if (this.menu) {
			this.pick(n - 1, now);
			return true;
		}
		const w = zdSlotWeapon(n, [...this.weapons.keys()]);
		if (w && this.alive) this.swap(w, now);
		return true;
	}

	private swap(w: ZdWeaponId, now: number): void {
		if (w === this.held) return;
		this.ws.reloadEndsAt = 0;
		this.held = w;
		this.ws.deploy(now);
		this.setScoped(false);
		this.host.zombieRenderer()?.setWeapon(w);
		this.host.sound('handle');
		this.act({ a: 'weapon', weapon: w }, now);
	}

	reload(now: number): void {
		if (!this.alive) return;
		const factor = (this.meView()?.reloadLevel ?? 0) > 0 ? ZD_SHOP.reloadFactor : 1;
		if (!this.ws.startReload(now, factor)) return;
		this.setScoped(false);
		this.host.sound('reload');
		if (this.solo) this.solo.reload(SOLO_ID, now);
		else this.host.send({ type: 'reload' });
	}

	/** E down: repair the barricade here, or open / close the pad menu. */
	use(now: number): void {
		if (this.menu?.page === 'pad') return this.closeMenu();
		if (!this.alive) return;
		const t = this.target;
		if (!t) return;
		if (t.kind === 'repair') {
			this.closeMenu();
			if (!this.repairing) {
				this.repairing = true;
				this.act({ a: 'repair', on: true }, now);
			}
		} else this.openMenu({ page: 'pad', pad: t.pad });
	}

	/** E up. */
	useUp(now: number): void {
		this.stopRepair(now);
	}

	private stopRepair(now: number): void {
		if (!this.repairing) return;
		this.repairing = false;
		this.act({ a: 'repair', on: false }, now);
	}

	/** B: open the shop, go back a page, or close it. */
	shop(now: number): void {
		if (this.menu && this.menu.page !== 'pad') {
			if (this.menu.page === 'shop') this.closeMenu();
			else this.openMenu({ page: 'shop' });
			return;
		}
		if (!this.alive) return;
		if (this.state?.phase !== 'build') {
			this.flash = { text: 'The shop opens in the build phase', at: now, tone: 'info' };
			return;
		}
		this.stopRepair(now);
		this.openMenu({ page: 'shop' });
	}

	/** F: ready for the next wave. */
	ready(now: number): void {
		if (!this.alive || this.state?.phase !== 'build') return;
		if (this.meView()?.ready) return;
		this.act({ a: 'ready' }, now);
	}

	private openMenu(m: MenuState): void {
		this.menu = m;
		this.menuNotice = null;
	}

	closeMenu(): void {
		this.menu = null;
		this.menuNotice = null;
		this.builtMenu = null;
	}

	get menuOpen(): boolean {
		return this.menu !== null;
	}

	/** Pick row `index` (0-based) of the open menu. */
	pick(index: number, now: number): void {
		const m = this.buildMenu();
		const a = m?.acts[index];
		if (!m || !a) return;
		const row = m.view.rows[index]!;
		if (a.t === 'close') return this.closeMenu();
		if (a.t === 'page') return this.openMenu({ page: a.page });
		if (row.state === 'owned' || row.state === 'max' || row.state === 'locked') {
			this.menuNotice = { text: row.state === 'locked' ? (row.note ?? 'Not allowed') : row.state === 'max' ? 'Nothing left to buy there' : 'Already yours', ok: false, at: now };
			this.host.sound('dryfire');
			return;
		}
		if (row.state === 'poor') {
			this.menuNotice = { text: `Not enough gold (${row.price} needed)`, ok: false, at: now };
			this.host.sound('dryfire');
			return;
		}
		this.act(a.act, now);
	}

	private act(action: ZdAction, now: number): void {
		if (this.solo) {
			this.handle(this.solo.act(SOLO_ID, action, now), now);
			this.applyState(this.solo.view(now), now);
		} else this.host.send({ type: 'zd', act: action });
	}

	/** Chat `!r`: solo starts a new game; online games restart by themselves. */
	chatRestart(now: number): void {
		if (this.solo) {
			this.host.zombieRenderer()?.clear();
			this.host.defenseRenderer()?.setMap(this.info);
			this.feed = [];
			this.killed.clear();
			this.closeMenu();
			this.resetWeapons();
			this.startSolo(now);
			this.host.notice('New game.');
		} else this.host.notice('Zombie Defense games restart by themselves when everyone is down (Esc › Servers to change map).');
	}

	// ---------------------------------------------------------------------
	// Simulation tick (64 Hz, after the local player moved)

	tick(now: number, origin: Vec3, eyeZ: number, pitch: number, yaw: number, ducked: boolean): void {
		for (const ws of this.weapons.values()) ws.update(now);
		this.pos.x = origin.x;
		this.pos.y = origin.y;
		this.pos.z = origin.z;
		if (this.solo) {
			if (this.alive) this.solo.setPlayerPos(SOLO_ID, { x: origin.x, y: origin.y, z: origin.z, ducked, yaw });
			this.handle(this.solo.update(now), now);
			if (now - this.soloViewAt >= SOLO_VIEW_MS) this.applyState(this.solo.view(now), now);
		}
		this.updateUse(now);
		if (!this.alive) {
			this.fireHeld = false;
			return;
		}
		const phase = this.state?.phase ?? 'waiting';
		if (phase === 'waiting') return;
		const def = WEAPONS[this.held];
		const want = (this.fireHeld && def.automatic) || now - this.firePressAt < FIRE_BUFFER_MS;
		if (!want) return;
		if (this.ws.mag <= 0) {
			this.firePressAt = -Infinity;
			if (!this.ws.reloading(now)) this.reload(now);
			return;
		}
		if (!this.ws.fire(now)) return;
		this.firePressAt = -Infinity;
		this.shoot(now, { x: origin.x, y: origin.y, z: eyeZ }, pitch, yaw);
		if (this.held === 'sniper') this.setScoped(false); // bolt: unscope after the shot
	}

	/** What E does here; drops the repair hold and the pad menu when they no longer apply. */
	private updateUse(now: number): void {
		const s = this.state;
		this.target = s && this.alive ? zdUseTarget(this.pos, this.info, s.openings, s.phase) : null;
		if (this.repairing && this.target?.kind !== 'repair') this.stopRepair(now);
		const m = this.menu;
		if (!m) return;
		if (!this.alive || s?.phase !== 'build') return this.closeMenu();
		if (m.page === 'pad') {
			const p = this.info.pads[m.pad];
			if (!p || Math.hypot(p.pos.x - this.pos.x, p.pos.y - this.pos.y) > ZD_PAD_RANGE + 8) this.closeMenu();
		}
	}

	private renderTick(): number {
		return this.solo ? this.solo.tick : this.buffer.tick;
	}

	private shoot(now: number, eye: Vec3, pitch: number, yaw: number): void {
		const def = WEAPONS[this.held];
		const fwd = forwardDir(pitch, yaw);
		const dir = spreadDir(fwd, this.scoped ? def.scopedSpread : def.spread);
		const r = this.host.zombieRenderer();
		r?.fired(now);
		this.host.sound(`shot-${this.held}`);
		const shot = { weapon: def.id, origin: eye, dir, tick: this.renderTick() };
		if (r) {
			const yr = (yaw * Math.PI) / 180;
			const muzzle = { x: eye.x + fwd.x * 18 + Math.sin(yr) * 7, y: eye.y + fwd.y * 18 - Math.cos(yr) * 7, z: eye.z + fwd.z * 18 - 6 };
			const pellets = Math.max(1, Math.floor(def.pellets ?? 1));
			for (let i = 0; i < pellets; i++) {
				const d = i === 0 ? dir : spreadDir(dir, def.pelletSpread ?? 0);
				r.tracer(muzzle, this.impact(eye, d, def.range), now);
			}
		}
		if (this.solo) this.handle(this.solo.fire(SOLO_ID, shot, now).events, now);
		else this.host.send({ type: 'fire', ...shot });
	}

	/** Cosmetic end of a shot: the first zombie or wall (bullets pass through planks). */
	private impact(eye: Vec3, d: Vec3, range: number): Vec3 {
		const end = { x: eye.x + d.x * range, y: eye.y + d.y * range, z: eye.z + d.z * range };
		let t = this.base.trace(eye, end, ZERO, ZERO).fraction * range;
		for (const z of this.zSamples) {
			const h = rayKind(eye, d, z, t, ZD_ZOMBIES[z.kind].scale);
			if (h) t = h.t;
		}
		return { x: eye.x + d.x * t, y: eye.y + d.y * t, z: eye.z + d.z * t };
	}

	// ---------------------------------------------------------------------
	// Server input

	onFrame(frame: DefenseFrame, arrival: number): void {
		if (!this.solo) this.buffer.push(frame, arrival);
	}

	onModeState(m: ZdStateView, now: number): void {
		if (!this.solo) this.applyState(m, now);
	}

	private applyState(m: ZdStateView, now: number): void {
		const prev = this.state;
		this.state = m;
		this.stateAt = now;
		this.soloViewAt = now;
		this.publishBoard(now);
		const me = m.players.find((p) => p.id === this.me);
		if (me) {
			this.hp = me.hp;
			this.maxHp = me.maxHp;
			if (me.status !== this.status) this.setStatus(me.status, now);
			this.syncWeapons(me.weapons);
			if (this.lastGold !== null && me.gold > this.lastGold) this.goldPop = { amount: me.gold - this.lastGold, at: now };
			this.lastGold = me.gold;
		} else if (this.status !== 'waiting') this.setStatus('waiting', now);
		if (m.phase !== 'build') this.closeMenu();
		if (m.phase !== 'ended') this.summary = null;
		if (prev && prev.phase === 'wave' && m.phase !== 'wave') this.buffer.clear();
	}

	/** Barricades, pads and the gated world from the current state. */
	private publishBoard(now: number): void {
		const m = this.state;
		if (!m) return;
		if (!this.solo) for (const [i, o] of m.openings.entries()) this.world.setOpen(i, o.planks === 0);
		const dr = this.host.defenseRenderer();
		dr?.setOpenings(m.openings, now);
		dr?.setPads(m.pads, m.phase);
	}

	private setStatus(s: ZdPlayerStatus, now: number): void {
		this.status = s;
		if (s !== 'alive') {
			this.setScoped(false);
			this.stopRepair(now);
			this.closeMenu();
		}
	}

	private syncWeapons(list: readonly ZdWeaponId[]): void {
		for (const w of list) if (!this.weapons.has(w)) this.weapons.set(w, new WeaponState(w));
		for (const w of [...this.weapons.keys()]) if (w !== 'pistol' && !list.includes(w)) this.weapons.delete(w);
		if (!this.weapons.has(this.held)) {
			this.held = 'pistol';
			this.host.zombieRenderer()?.setWeapon('pistol');
		}
	}

	onEvent(ev: ZdEvent, now: number): void {
		if (!this.solo) this.handle([ev], now);
	}

	private handle(events: ZdEvent[], now: number): void {
		const me = this.me;
		for (const ev of events) {
			const route = zdEventRoute(ev);
			if (route.to !== undefined && route.to !== me) continue;
			if (route.except !== undefined && route.except === me) continue;
			this.apply(ev, now);
		}
	}

	private name(id: number): string {
		return id === this.me ? 'You' : this.host.name(id);
	}

	private openingName(i: number): string {
		return this.info.openings[i]?.name ?? `opening ${i + 1}`;
	}

	private padSpot(i: number): Vec3 | undefined {
		const p = this.info.pads[i];
		return p ? { x: p.pos.x, y: p.pos.y, z: p.pos.z + 48 } : undefined;
	}

	private apply(ev: ZdEvent, now: number): void {
		const r = this.host.zombieRenderer();
		const dr = this.host.defenseRenderer();
		const me = this.me;
		switch (ev.e) {
			case 'phase': {
				if (this.state) this.state = { ...this.state, phase: ev.phase, wave: ev.wave, round: ev.round };
				this.rev++;
				if (ev.phase === 'build') {
					this.killed.clear();
					this.buffer.clear();
					dr?.idle();
					this.flash =
						ev.wave === 1
							? { text: `Game ${ev.round} · build turrets (E on a pad), shop (B), F when ready`, at: now, tone: 'info' }
							: { text: `Build phase · wave ${ev.wave} next`, at: now, tone: 'info' };
					this.host.sound('round');
				} else if (ev.phase === 'wave') {
					this.killed.clear();
					this.closeMenu();
					const from = attackText(ev.from, this.info.openings.length, (i) => this.openingName(i));
					this.flash = { text: bossWaveText(ev.wave) + from, at: now, tone: zdIsBossWave(ev.wave) ? 'boss' : 'bad' };
					this.host.sound('round');
				}
				this.publishBoard(now);
				break;
			}
			case 'spawn':
				this.host.teleport(ev.x, ev.y, ev.z, ev.yaw);
				this.hp = ev.hp;
				if (ev.reason === 'game') {
					this.resetWeapons();
					this.feed = [];
					this.lastGold = null;
				}
				this.setStatus('alive', now);
				if (ev.reason === 'respawn') this.flash = { text: 'Back in the fight', at: now, tone: 'good' };
				break;
			case 'hit':
				this.hitMarker = { at: now, head: ev.head, kill: ev.kill };
				r?.flash(ev.zid, now);
				this.host.sound(ev.kill ? 'hitKill' : ev.head ? 'hitHead' : 'hit');
				break;
			case 'kill': {
				this.killed.add(ev.zid);
				const kind = ZD_ZOMBIES[ev.kind].label;
				let text: string;
				let mine = ev.by === me;
				if (ev.by === 0 && ev.pad !== undefined) {
					const pad = this.state?.pads[ev.pad];
					const owner = pad?.owner ?? null;
					mine = owner === me;
					const label = pad?.type ? ZD_TURRETS[pad.type].label : 'Turret';
					text = `${owner !== null ? `${this.name(owner)}${owner === me ? 'r' : "'s"} ` : ''}${label} · ${kind}`;
				} else text = `${this.name(ev.by)} · ${ev.weapon ? WEAPONS[ev.weapon].label : '?'} · ${kind}${ev.head ? ' · headshot' : ''}`;
				this.feed = pushKillFeed(this.feed, { id: ++this.feedId, text, head: ev.head, mine, at: now }, now);
				const look = ZD_KIND_LOOK[ev.kind];
				r?.kill(ev.zid, { id: ev.zid, x: ev.x, y: ev.y, z: ev.z, yaw: ev.yaw, flags: 0, scale: look.scale, tint: look.tint }, now);
				if (ev.kind === 'boss') this.flash = { text: `The ${kind} is down!`, at: now, tone: 'good' };
				break;
			}
			case 'shot': {
				const def = WEAPONS[ev.weapon];
				if (r) {
					const o = { x: ev.o.x, y: ev.o.y, z: ev.o.z - 6 };
					if (ev.len > 0) r.tracer(o, { x: ev.o.x + ev.d.x * ev.len, y: ev.o.y + ev.d.y * ev.len, z: ev.o.z + ev.d.z * ev.len }, now);
					const p = ev.pellets ?? [];
					for (let i = 0; i + 3 < p.length; i += 4) r.tracer(o, { x: ev.o.x + p[i]! * p[i + 3]!, y: ev.o.y + p[i + 1]! * p[i + 3]!, z: ev.o.z + p[i + 2]! * p[i + 3]! }, now);
				}
				if (isZdWeapon(def.id)) this.host.sound(`shot-${def.id}`, ev.o);
				break;
			}
			case 'hurt':
				if (ev.id === me) {
					this.hp = ev.hp;
					this.hurtAt = now;
					this.host.sound('hurt');
				}
				break;
			case 'heal':
				if (ev.id === me) this.hp = ev.hp;
				break;
			case 'death':
				if (ev.id === me) {
					this.setStatus('dead', now);
					this.hp = 0;
					this.flash = { text: 'You died · you come back when the wave is cleared', at: now, tone: 'bad' };
					this.host.sound('death');
				} else this.feed = pushKillFeed(this.feed, { id: ++this.feedId, text: `${this.host.name(ev.id)} died`, head: false, mine: false, at: now }, now);
				break;
			case 'ammo': {
				if (ev.id !== me || !isZdWeapon(ev.weapon)) break;
				let ws = this.weapons.get(ev.weapon);
				if (!ws) {
					ws = new WeaponState(ev.weapon);
					this.weapons.set(ev.weapon, ws);
				}
				if (ev.weapon !== this.held) {
					this.held = ev.weapon;
					ws.deploy(now);
					this.setScoped(false);
					r?.setWeapon(ev.weapon);
				}
				ws.mag = ev.mag;
				ws.reserve = ev.reserve;
				break;
			}
			case 'plank': {
				const s = this.state;
				if (s) this.state = { ...s, openings: s.openings.map((o, i) => (i === ev.opening ? { ...o, planks: ev.planks } : o)) };
				this.rev++;
				this.publishBoard(now);
				const at = this.openingSpot(ev.opening);
				if (ev.by === null) this.host.sound('beaconSmash', at);
				else this.host.sound('knifeStick', ev.by === me ? undefined : at);
				break;
			}
			case 'breach':
				this.alert = { text: `The ${this.openingName(ev.opening)} is down!`, at: now };
				this.host.sound('beaconSmash', this.openingSpot(ev.opening));
				break;
			case 'turret': {
				const s = this.state;
				if (s) this.state = { ...s, pads: s.pads.map((p, i) => (i === ev.pad ? { type: ev.type, level: ev.level, owner: ev.op === 'sell' ? null : ev.op === 'build' ? ev.by : p.owner } : p)) };
				this.rev++;
				this.publishBoard(now);
				this.host.sound(ev.op === 'sell' ? 'handle' : 'beacon', this.padSpot(ev.pad));
				if (ev.by !== me && ev.type && ev.op !== 'sell')
					this.feed = pushKillFeed(this.feed, { id: ++this.feedId, text: `${this.host.name(ev.by)} ${ev.op === 'build' ? 'built' : 'upgraded'} a ${ZD_TURRETS[ev.type].label} (L${ev.level})`, head: false, mine: false, at: now }, now);
				break;
			}
			case 'shell':
				dr?.shell(ev.pad, ev.x, ev.y, ev.z, ev.ms, now);
				this.host.sound('shot-sniper', this.padSpot(ev.pad));
				break;
			case 'boom':
				dr?.boom(ev.x, ev.y, ev.z, ev.r, now);
				this.host.sound('beaconSmash', { x: ev.x, y: ev.y, z: ev.z });
				break;
			case 'arc':
				dr?.arc(ev.pad, ev.pts, now);
				this.host.sound('beaconUse', this.padSpot(ev.pad));
				break;
			case 'result': {
				if (ev.id !== me) break;
				const s = this.state;
				if (s) this.state = { ...s, players: s.players.map((p) => (p.id === me ? { ...p, gold: ev.gold } : p)) };
				this.rev++;
				this.lastGold = ev.gold;
				if (ev.act === 'weapon') break;
				if (!ev.ok) {
					this.menuNotice = { text: zdReasonText(ev.reason), ok: false, at: now };
					if (!this.menu) this.flash = { text: zdReasonText(ev.reason), at: now, tone: 'info' };
					this.host.sound('dryfire');
				} else {
					this.menuNotice = { text: ev.act === 'ready' ? 'Ready' : 'Done', ok: true, at: now };
					if (ev.act.startsWith('buy:')) this.host.sound('handle');
					if (ev.act === 'ready') this.closeMenu();
				}
				break;
			}
			case 'ready':
				if (this.state) this.state = { ...this.state, players: this.state.players.map((p) => (p.id === ev.id ? { ...p, ready: true } : p)) };
				this.rev++;
				break;
			case 'boss':
				this.flash = { text: `A ${ZD_ZOMBIES.boss.label} is here · it smashes barricades in one go`, at: now, tone: 'boss' };
				break;
			case 'cleared':
				this.flash = { text: `Wave ${ev.wave} cleared · +${ev.bonus} gold`, at: now, tone: 'good' };
				this.host.sound('perk');
				if (this.solo) this.host.notice(`Wave ${ev.wave} cleared in ${Math.round(ev.secs)} s. +${ev.bonus} gold.`);
				break;
			case 'timeout':
				this.flash = { text: `Wave ${ev.wave} ran too long · ${ev.removed} zombies gave up`, at: now, tone: 'info' };
				break;
			case 'end': {
				const top = ev.topId !== null ? `${this.name(ev.topId)} (${ev.topKills})` : null;
				this.summary = { wave: ev.wave, kills: ev.kills, secs: ev.secs, top };
				this.flash = { text: `Overrun at wave ${ev.wave}`, at: now, tone: 'bad' };
				this.setStatus('waiting', now);
				if (this.solo) this.host.notice(`Overrun at wave ${ev.wave}: ${ev.kills} kills in ${Math.round(ev.secs)} s.`);
				break;
			}
		}
	}

	private openingSpot(i: number): Vec3 | undefined {
		const o = this.info.openings[i];
		return o ? { x: (o.min.x + o.max.x) / 2, y: (o.min.y + o.max.y) / 2, z: (o.min.z + o.max.z) / 2 } : undefined;
	}

	// ---------------------------------------------------------------------
	// Frame

	/** Draw zombies, turrets and the viewmodel; returns the HUD view (same object while nothing changed). */
	frame(now: number, viewmodel: boolean, speed: number): DefenseView {
		const r = this.host.zombieRenderer();
		const dr = this.host.defenseRenderer();
		if (this.solo) {
			const snap = this.solo.snapshot();
			this.zSamples = snap.zombies;
			this.tSamples = snap.turrets;
			this.shots.length = 0;
			for (const t of snap.turrets) {
				if (!(t.flags & ZDT_FIRED)) continue;
				const last = this.lastFire.get(t.pad) ?? -Infinity;
				// The flag stays up ZD_FIRE_FLAG_TICKS ticks; a sentry fires every ≥ 5.
				if (snap.tick - last < ZD_FIRE_FLAG_TICKS) continue;
				this.lastFire.set(t.pad, snap.tick);
				this.shots.push({ pad: t.pad, target: t.target });
			}
		} else this.buffer.sample(now - INTERP_DELAY_MS, this.zSamples, this.tSamples, this.shots);
		this.poses.length = 0;
		for (const z of this.zSamples) if (!this.killed.has(z.id)) this.poses.push(zombiePose(z));
		if (r) {
			r.sync(this.poses, now);
			r.setWeapon(this.held);
			r.updateViewmodel(now, viewmodel && this.alive && !this.scoped, this.ws.reloadProgress(now), speed, undefined, this.ws.mag);
		}
		if (dr) {
			dr.aim(this.tSamples);
			this.turretShots(dr, r, now);
		}
		return this.buildView(now);
	}

	private turretShots(dr: DefenseRenderer, r: ZombieRenderer | null, now: number): void {
		const from = { x: 0, y: 0, z: 0 };
		for (const s of this.shots) {
			const type = this.state?.pads[s.pad]?.type;
			// Mortar and tesla have their own events (shell, arc); frost never fires.
			if (type !== 'sentry' && type !== 'scatter') continue;
			if (!dr.fired(s.pad, now, from)) continue;
			const z = this.zSamples.find((q) => q.id === s.target);
			if (z && r) {
				const sc = ZD_ZOMBIES[z.kind].scale;
				const n = type === 'scatter' ? 4 : 1;
				for (let i = 0; i < n; i++)
					r.tracer({ ...from }, { x: z.x + (Math.random() - 0.5) * 16 * sc, y: z.y + (Math.random() - 0.5) * 16 * sc, z: z.z + (36 + Math.random() * 20) * sc }, now);
			}
			const last = this.lastTurretSound.get(s.pad) ?? -Infinity;
			if (now - last >= TURRET_SOUND_MS) {
				this.lastTurretSound.set(s.pad, now);
				this.host.sound(type === 'scatter' ? 'shot-striker' : 'shot-smg', { ...from });
			}
		}
	}

	private buildMenu(): ZdMenu | null {
		const m = this.menu;
		const me = this.meView();
		const s = this.state;
		if (!m || !me || !s) return null;
		if (m.page === 'pad') {
			const pv = s.pads[m.pad];
			if (!pv) return null;
			const owner = pv.owner;
			const ownerHere = owner !== null && s.players.some((p) => p.id === owner);
			return zdPadMenu(m.pad, pv, me, ownerHere, owner === null ? null : owner === me.id ? 'you' : this.host.name(owner));
		}
		return zdShopMenu(m.page, me, this.info, s.openings);
	}

	private buildView(now: number): DefenseView {
		const s = this.state;
		const ws = this.ws;
		const reloading = ws.reloading(now);
		if (this.hitMarker && now - this.hitMarker.at > 400) this.hitMarker = null;
		if (this.flash && now - this.flash.at > 3500) this.flash = null;
		if (this.alert && now - this.alert.at > 4000) this.alert = null;
		if (this.goldPop && now - this.goldPop.at > 1500) this.goldPop = null;
		if (this.menuNotice && now - this.menuNotice.at > 2500) this.menuNotice = null;
		const feed = liveKillFeed(this.feed, now);
		if (feed.length !== this.feed.length) this.feed = feed;
		const t = this.target;
		const key = [
			s?.phase,
			s?.wave,
			this.stateAt,
			this.rev,
			this.hp,
			this.status,
			this.held,
			ws.mag,
			ws.reserve,
			reloading,
			this.weapons.size,
			this.hitMarker?.at,
			this.feed.length && this.feed[0]!.id,
			this.feed.length,
			this.flash?.at,
			this.alert?.at,
			this.goldPop?.at,
			this.hurtAt,
			this.scoped,
			this.summary ? 1 : 0,
			this.menu ? `${this.menu.page}:${'pad' in this.menu ? this.menu.pad : ''}` : '',
			this.menuNotice?.at,
			t ? `${t.kind}${t.kind === 'repair' ? t.opening : t.pad}` : '',
			this.repairing
		].join('|');
		if (key === this.viewKey && this.view) return this.view;
		this.viewKey = key;
		const me = this.meView();
		const players = s?.players ?? [];
		const living = players.filter((p) => p.status === 'alive');
		let menu = null;
		if (this.menu) {
			this.builtMenu = this.buildMenu();
			menu = this.builtMenu ? { ...this.builtMenu.view, notice: this.menuNotice } : null;
		}
		const def = WEAPONS[this.held as WeaponId];
		this.view = {
			phase: s?.phase ?? 'waiting',
			round: s?.round ?? 0,
			wave: s?.wave ?? 0,
			endsAt: s && (s.phase === 'build' || s.phase === 'ended') ? this.stateAt + s.timeLeft * 1000 : 0,
			startedAt: s && s.phase === 'wave' ? this.stateAt - s.elapsed * 1000 : null,
			left: s?.left ?? 0,
			alive: s?.alive ?? 0,
			teamKills: s?.kills ?? 0,
			status: this.status,
			hp: this.hp,
			maxHp: this.maxHp,
			gold: me?.gold ?? 0,
			goldPop: this.goldPop,
			myKills: me?.kills ?? 0,
			weapon: this.held,
			weaponLabel: def.label,
			mag: ws.mag,
			magSize: def.magazine,
			reserve: ws.reserve,
			reloadEndsAt: reloading ? ws.reloadEndsAt : 0,
			reloadMs: ws.reloadDurationMs || def.reloadMs,
			weapons: zdWeaponKeys([...this.weapons.keys()], this.held),
			team: players.map((p) => ({ id: p.id, name: p.id === this.me ? 'You' : this.host.name(p.id), status: p.status, ready: p.ready, me: p.id === this.me })),
			ready: me?.ready ?? false,
			readyCount: living.filter((p) => p.ready).length,
			livingCount: living.length,
			boss: s?.boss ?? null,
			openings: (s?.openings ?? []).map((o, i) => ({ name: this.openingName(i), planks: o.planks, max: o.max, reinforce: o.reinforce })),
			prompt: t && s ? { text: zdPromptText(t, this.info, s.openings, s.pads, this.repairing), active: this.repairing && t.kind === 'repair' } : null,
			flash: this.flash,
			alert: this.alert,
			hitMarker: this.hitMarker,
			killFeed: this.feed,
			hurtAt: this.hurtAt,
			scoped: this.scoped,
			summary: this.summary,
			menu,
			online: !this.solo
		};
		return this.view;
	}

	/** Solo scoreboard row values. */
	soloRow(): { kills: number; deaths: number; gold: number; status: ZdPlayerStatus } {
		const v = this.solo?.playerView(SOLO_ID);
		return { kills: v?.kills ?? 0, deaths: v?.deaths ?? 0, gold: v?.gold ?? 0, status: v?.status ?? 'waiting' };
	}

	/** Solo: the local game's state (score panel); null online. */
	soloState(): ZdStateView | null {
		return this.solo ? this.state : null;
	}

	dispose(): void {
		this.setScoped(false);
		this.host.zombieRenderer()?.clear();
		this.host.defenseRenderer()?.reset();
		this.buffer.clear();
	}
}
