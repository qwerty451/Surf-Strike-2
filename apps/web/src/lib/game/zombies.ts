/**
 * Zombies client (docs/modes.md#zombies). Online it predicts the local weapon
 * (fire rate, ammo, reload), sends `fire`/`reload`/`loadout`, draws zombies
 * from interpolated BIN_ZOMBIES frames and shows the server's events. Solo it
 * runs the shared `ZombiesGame` itself, so the mode is playable offline.
 * game.ts owns the player, camera and input; this module owns everything
 * zombies-specific behind a small host interface.
 */
import {
	buildCollisionWorld,
	gatedWorld,
	isWeaponId,
	rayZombie,
	VIEW_HEIGHT,
	WEAPONS,
	WeaponState,
	ZM_LOADOUT_SECS,
	ZM_PLAYER_HP,
	ZM_PZ_RESPAWN_SECS,
	ZM_SLOW_MS,
	ZM_TURN_SECS,
	ZM_ZOMBIE_SPEED,
	ZOMBIE_HP,
	zmSlowFactor,
	ZombiesGame,
	zmEventRoute,
	type ClientMessage,
	type GatedWorld,
	type Cvars,
	type MapDef,
	type Vec3,
	type WeaponId,
	type ZmEvent,
	type ZmStateView,
	type ZmTeam,
	type ZombieFrame
} from '@surf/shared';
import { INTERP_DELAY_MS } from '../net/interp.js';
import { ZombieBuffer, type ZombieSample } from '../net/zombie-interp.js';
import type { HeldItem } from '../render/character/held.js';
import type { ZombieRenderer } from '../render/zombies.js';
import type { KillFeedLine, ZombiesView } from './contract.js';
import { FIRE_BUFFER_MS, forwardDir, liveKillFeed, pushKillFeed, slotAction, spreadDir } from './zombies-view.js';

/** Player id of the local player in solo. */
export const SOLO_ID = 1;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const SOLO_VIEW_MS = 200;

export type ZmSound = 'shot-pistol' | 'shot-lmg' | 'shot-sniper' | 'knife' | 'reload' | 'casing' | 'shell' | 'hit' | 'hurt' | 'groan' | 'checkpoint';

export interface ZmHost {
	online(): boolean;
	selfId(): number;
	send(msg: ClientMessage): void;
	zombieRenderer(): ZombieRenderer | null;
	name(id: number): string;
	notice(text: string): void;
	/** Teleport the local player (spawn, checkpoint respawn, fall-out). */
	teleport(x: number, y: number, z: number, yaw: number): void;
	sound(name: ZmSound, at?: Vec3): void;
	/** Zoom: horizontal FOV at 4:3, or null for the cvar FOV. */
	setZoom(fov: number | null): void;
	/** Knockback on the local player (player-zombie hit by a survivor). */
	push(vx: number, vy: number): void;
}

export class ZombiesClient {
	/** Map collision plus closed gates: the local player moves in this world. */
	readonly world: GatedWorld;
	private solo: ZombiesGame | null = null;
	private soloViewAt = 0;
	private ws = new WeaponState();
	private buffer = new ZombieBuffer();
	private samples: ZombieSample[] = [];
	private state: ZmStateView | null = null;
	private stateAt = 0;
	private hp = ZM_PLAYER_HP;
	private alive = true;
	private loadoutEndsAt = 0;
	private fireHeld = false;
	private firePressAt = -Infinity;
	private scoped = false;
	private hitMarker: ZombiesView['hitMarker'] = null;
	private feed: KillFeedLine[] = [];
	private feedId = 0;
	private flash: ZombiesView['flash'] = null;
	private hurtAt = 0;
	private summary: ZombiesView['summary'] = null;
	private viewKey = '';
	private view: ZombiesView | null = null;
	private lastGroan = 0;
	private team: ZmTeam = 'survivor';
	/** Survivor weapon (kept while on the zombie side). */
	private loadout: WeaponId = 'pistol';
	/** Player-zombie hit slow (local movement). */
	private slowUntil = 0;
	private slowStacks = 0;
	/** Not alive: rising / respawning as a zombie at about this time. */
	private respawnAt = 0;
	private gateKey = '';
	private readonly base;

	constructor(
		private readonly host: ZmHost,
		private readonly map: MapDef,
		private readonly cvars: Cvars,
		now: number
	) {
		this.base = buildCollisionWorld(map);
		this.world = gatedWorld(this.base, map.zombies?.gates ?? []);
		host.zombieRenderer()?.setGates(map.zombies?.gates ?? [], now);
		if (!host.online()) this.startSolo(now);
	}

	private startSolo(now: number): void {
		this.solo = new ZombiesGame({ map: this.map, world: this.base, cvars: this.cvars, now });
		// The local player moves in the solo game's gated world.
		(this as { world: GatedWorld }).world = this.solo.world;
		this.solo.syncPlayers([SOLO_ID], now);
		this.handle(this.solo.update(now), now);
		this.state = this.solo.view(now);
		this.stateAt = now;
	}

	get me(): number {
		return this.solo ? SOLO_ID : this.host.selfId();
	}

	get isSolo(): boolean {
		return this.solo !== null;
	}

	/** Player max speed: the held weapon (CS-style weapon speed), or zombie speed with hit slows. */
	maxSpeed(now = performance.now()): number {
		if (this.team === 'zombie') return ZM_ZOMBIE_SPEED * zmSlowFactor(now < this.slowUntil ? this.slowStacks : 0);
		return WEAPONS[this.ws.weapon].moveSpeed;
	}

	get isZombie(): boolean {
		return this.team === 'zombie';
	}

	/** A remote player is on the zombie side (zombie look). */
	isZombiePlayer(id: number): boolean {
		return this.state?.players.some((p) => p.id === id && p.team === 'zombie') ?? false;
	}

	/** Weapon a remote survivor holds (third person); null for zombies and unknown players. */
	heldOf(id: number): HeldItem | null {
		const p = this.state?.players.find((q) => q.id === id);
		return p && p.team !== 'zombie' && p.weapon !== 'claws' ? p.weapon : null;
	}

	/** Down: no movement, camera follows a teammate. */
	get down(): boolean {
		return !this.alive;
	}

	/** Remote players not in play (rising or respawning as zombies) are hidden. */
	isDown(id: number): boolean {
		return this.state?.players.some((p) => p.id === id && !p.alive) ?? false;
	}

	private loadoutOpen(now: number): boolean {
		const phase = this.state?.phase ?? 'waiting';
		return this.alive && this.team === 'survivor' && (phase !== 'playing' || now < this.loadoutEndsAt);
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
		const zoom = WEAPONS[this.ws.weapon].zoomFov;
		this.setScoped(zoom !== null && !this.scoped);
	}

	private setScoped(on: boolean): void {
		if (on === this.scoped) return;
		this.scoped = on;
		this.host.setZoom(on ? WEAPONS[this.ws.weapon].zoomFov : null);
	}

	/** Keys 1-4 (always handled). */
	slot(n: number, now: number): boolean {
		const a = slotAction(n, this.loadoutOpen(now));
		if (!a) return true;
		if (this.team !== 'survivor') return true;
		if (a.weapon === this.ws.weapon) return true;
		this.equip(a.weapon);
		if (this.solo) this.handle(this.solo.loadout(SOLO_ID, a.weapon, now), now);
		else this.host.send({ type: 'loadout', weapon: a.weapon });
		return true;
	}

	private setTeam(team: ZmTeam): void {
		if (team === this.team) return;
		this.team = team;
		this.setScoped(false);
		if (team === 'zombie') this.ws.equip('claws');
		else {
			this.slowUntil = 0;
			this.ws.equip(this.loadout);
		}
		this.host.zombieRenderer()?.setWeapon(this.ws.weapon);
	}

	private equip(w: WeaponId): void {
		if (w !== 'claws') this.loadout = w;
		this.ws.equip(w);
		this.setScoped(false);
		this.host.zombieRenderer()?.setWeapon(w);
	}

	reload(now: number): void {
		if (!this.alive || this.team !== 'survivor' || !this.ws.startReload(now)) return;
		this.setScoped(false);
		this.host.sound('reload');
		if (this.solo) this.solo.reload(SOLO_ID, now);
		else this.host.send({ type: 'reload' });
	}

	/** Chat `!r`: solo restarts the round; online rounds restart by themselves. */
	chatRestart(now: number): void {
		if (this.solo) {
			this.host.zombieRenderer()?.clear();
			this.host.zombieRenderer()?.setWeapon(this.ws.weapon);
			this.feed = [];
			this.startSolo(now);
			this.host.notice('Round restarted.');
		} else this.host.notice('Zombie Run rounds restart by themselves after a win or a wipe (use !rtv to change map).');
	}

	// ---------------------------------------------------------------------
	// Simulation tick (64 Hz, after the local player moved)

	tick(now: number, origin: Vec3, eyeZ: number, pitch: number, yaw: number, ducked: boolean): void {
		this.ws.update(now);
		if (this.solo) {
			if (this.alive) this.solo.setPlayerPos(SOLO_ID, { x: origin.x, y: origin.y, z: origin.z, ducked });
			this.handle(this.solo.update(now), now);
			if (now - this.soloViewAt >= SOLO_VIEW_MS) this.applyState(this.solo.view(now), now);
		}
		if (!this.alive) {
			this.fireHeld = false;
			return;
		}
		const phase = this.state?.phase ?? 'waiting';
		if (phase === 'waiting') return;
		const def = WEAPONS[this.ws.weapon];
		const want = (this.fireHeld && def.automatic) || now - this.firePressAt < FIRE_BUFFER_MS;
		if (!want) return;
		if (!this.ws.melee && this.ws.mag <= 0) {
			this.firePressAt = -Infinity;
			if (!this.ws.reloading(now)) this.reload(now);
			return;
		}
		if (!this.ws.fire(now)) return;
		this.firePressAt = -Infinity;
		this.shoot(now, { x: origin.x, y: origin.y, z: eyeZ }, pitch, yaw);
		if (this.ws.weapon === 'sniper') this.setScoped(false); // bolt: unscope after the shot
	}

	private renderTick(): number {
		return this.solo ? this.solo.tick : this.buffer.tick;
	}

	private shoot(now: number, eye: Vec3, pitch: number, yaw: number): void {
		const def = WEAPONS[this.ws.weapon];
		const fwd = forwardDir(pitch, yaw);
		const dir = spreadDir(fwd, this.scoped ? def.scopedSpread : def.spread);
		const r = this.host.zombieRenderer();
		r?.fired(now);
		if (def.id !== 'claws') this.host.sound(def.id === 'knife' ? 'knife' : (`shot-${def.id}` as ZmSound));
		const shot = { weapon: def.id, origin: eye, dir, tick: this.renderTick() };
		if (def.magazine > 0 && r) {
			// Cosmetic tracer from the muzzle to the first thing hit on screen.
			const end = { x: eye.x + dir.x * def.range, y: eye.y + dir.y * def.range, z: eye.z + dir.z * def.range };
			let t = this.world.trace(eye, end, ZERO, ZERO).fraction * def.range;
			for (const z of this.drawn()) {
				const h = rayZombie(eye, dir, z, t);
				if (h) t = h.t;
			}
			const yr = (yaw * Math.PI) / 180;
			const muzzle = { x: eye.x + fwd.x * 18 + Math.sin(yr) * 7, y: eye.y + fwd.y * 18 - Math.cos(yr) * 7, z: eye.z + fwd.z * 18 - 6 };
			r.tracer(muzzle, { x: eye.x + dir.x * t, y: eye.y + dir.y * t, z: eye.z + dir.z * t }, now);
		}
		if (this.solo) this.handle(this.solo.fire(SOLO_ID, shot, now).events, now);
		else this.host.send({ type: 'fire', ...shot });
	}

	/** Zombies as drawn this frame (solo: the simulation; online: interpolated). */
	private drawn(): ZombieSample[] {
		return this.samples;
	}

	// ---------------------------------------------------------------------
	// Server input

	onZombies(frame: ZombieFrame, arrival: number): void {
		if (!this.solo) this.buffer.push(frame, arrival);
	}

	onModeState(m: ZmStateView, now: number): void {
		if (!this.solo) this.applyState(m, now);
	}

	private applyState(m: ZmStateView, now: number): void {
		this.state = m;
		const gk = m.gates.map((g) => g.state).join(',');
		if (gk !== this.gateKey) {
			this.gateKey = gk;
			for (const [i, g] of m.gates.entries()) {
				if (!this.solo) this.world.setOpen(i, g.state === 'open');
				this.host.zombieRenderer()?.setGateState(i, g.state, now);
			}
		}
		this.stateAt = now;
		this.soloViewAt = now;
		const me = m.players.find((p) => p.id === this.me);
		if (me) {
			this.hp = me.hp;
			if (me.team !== this.team) this.setTeam(me.team);
			if (me.alive !== this.alive) {
				this.alive = me.alive;
				if (!me.alive) this.setScoped(false);
			}
		}
		if (m.phase !== 'ended') this.summary = null;
	}

	onEvent(ev: ZmEvent, now: number): void {
		if (!this.solo) this.handle([ev], now);
	}

	private handle(events: ZmEvent[], now: number): void {
		const me = this.me;
		for (const ev of events) {
			const route = zmEventRoute(ev);
			if (route.to !== undefined && route.to !== me) continue;
			if (route.except !== undefined && route.except === me) continue;
			this.apply(ev, now);
		}
	}

	private apply(ev: ZmEvent, now: number): void {
		const r = this.host.zombieRenderer();
		const me = this.me;
		switch (ev.e) {
			case 'phase':
				if (ev.phase === 'countdown') this.flash = { text: `Round ${ev.round} · pick a weapon (1-4)`, at: now };
				else if (ev.phase === 'playing') this.flash = { text: 'Go! Reach the evac point', at: now };
				if (this.state) this.state = { ...this.state, phase: ev.phase };
				if (ev.phase === 'countdown') {
					this.feed = [];
					r?.clear();
					r?.setWeapon(this.ws.weapon);
				}
				break;
			case 'spawn': {
				this.host.teleport(ev.x, ev.y, ev.z, ev.yaw);
				this.hp = ev.hp;
				this.alive = true;
				this.setTeam(ev.team);
				this.ws.equip(ev.team === 'zombie' ? 'claws' : this.loadout);
				if (ev.reason === 'zombie') this.flash = { text: 'You are a zombie · hunt the survivors', at: now };
				const countdownLeft = this.state?.phase === 'countdown' ? Math.max(0, this.state.timeLeft * 1000 - (now - this.stateAt)) : 0;
				this.loadoutEndsAt = now + countdownLeft + ZM_LOADOUT_SECS * 1000;
				r?.setWeapon(this.ws.weapon);
				break;
			}
			case 'hit':
				this.hitMarker = { at: now, head: ev.head, kill: ev.kill };
				r?.flash(ev.zid, now);
				this.host.sound('hit');
				break;
			case 'kill': {
				const killer = ev.by === me ? 'You' : this.host.name(ev.by);
				const victim = ev.pid !== undefined ? ` › ${ev.pid === me ? 'you' : this.host.name(ev.pid)}` : '';
				if (ev.pid === me) {
					this.alive = false;
					this.respawnAt = now + ZM_PZ_RESPAWN_SECS * 1000;
					this.flash = { text: 'Killed · respawning as a zombie', at: now };
				}
				const line: KillFeedLine = {
					id: ++this.feedId,
					text: `${killer} · ${WEAPONS[ev.weapon].label}${ev.head ? ' · headshot' : ''}${victim}`,
					head: ev.head,
					mine: ev.by === me,
					at: now
				};
				this.feed = pushKillFeed(this.feed, line, now);
				if (ev.pid === undefined) r?.kill(ev.zid, { id: ev.zid, x: ev.x, y: ev.y, z: ev.z, yaw: ev.yaw, flags: 0 }, now);
				break;
			}
			case 'shot':
				if (ev.len > 0) {
					const o = ev.o;
					r?.tracer({ x: o.x, y: o.y, z: o.z - 6 }, { x: o.x + ev.d.x * ev.len, y: o.y + ev.d.y * ev.len, z: o.z + ev.d.z * ev.len }, now);
				}
				if (ev.weapon !== 'claws') this.host.sound(ev.weapon === 'knife' ? 'knife' : (`shot-${ev.weapon}` as ZmSound), ev.o);
				break;
			case 'hurt':
				if (ev.id === me) {
					this.hp = ev.hp;
					this.hurtAt = now;
					this.host.sound('hurt');
				}
				break;
			case 'down':
				if (ev.id === me) {
					this.alive = false;
					this.setScoped(false);
					this.setTeam('zombie');
					this.respawnAt = now + ZM_TURN_SECS * 1000;
					if (!this.solo) this.flash = { text: 'You turned! You rise as a zombie…', at: now };
				} else
					this.feed = pushKillFeed(
						this.feed,
						{ id: ++this.feedId, text: `${this.host.name(ev.id)} turned`, head: false, mine: ev.by === me, at: now },
						now
					);
				break;
			case 'zhurt':
				if (ev.id !== me) break;
				this.hp = ev.hp;
				this.hurtAt = now;
				this.slowStacks = ev.stacks;
				this.slowUntil = now + ZM_SLOW_MS;
				this.host.push(ev.kx, ev.ky);
				break;
			case 'gate': {
				const n = this.map.zombies?.gates.length ?? 0;
				this.flash = {
					text: ev.state === 'counting' ? `Gate ${ev.index + 1} opens in ${ev.secs} s · hold out` : ev.index === n - 1 ? 'Last gate open · get to the boat!' : `Gate ${ev.index + 1} open`,
					at: now
				};
				if (ev.state === 'open') {
					this.world.setOpen(ev.index, true);
					this.host.zombieRenderer()?.setGateState(ev.index, 'open', now);
				} else this.host.zombieRenderer()?.setGateState(ev.index, ev.state, now);
				this.host.sound('checkpoint');
				break;
			}
			case 'checkpoint': {
				const n = this.state?.checkpoints ?? 0;
				this.flash = { text: `Checkpoint ${ev.index}${n ? `/${n}` : ''} · healed`, at: now };
				this.host.sound('checkpoint');
				break;
			}
			case 'ammo':
				if (ev.id !== me || !isWeaponId(ev.weapon)) break;
				if (ev.weapon !== this.ws.weapon) this.equip(ev.weapon);
				this.ws.mag = ev.mag;
				this.ws.reserve = ev.reserve;
				break;
			case 'end': {
				const top = ev.topId !== null ? `${ev.topId === me ? 'You' : this.host.name(ev.topId)} (${ev.topKills})` : null;
				this.summary = { won: ev.won, secs: ev.secs, kills: ev.kills, top };
				this.flash = { text: ev.won ? 'Evacuated!' : 'Overrun!', at: now };
				if (this.solo)
					this.host.notice(`${ev.won ? 'Evacuated!' : 'Overrun!'} Round ${ev.round}: ${Math.round(ev.secs)} s, ${ev.kills} kills.`);
				break;
			}
		}
	}

	// ---------------------------------------------------------------------
	// Frame

	/** Draw zombies and the viewmodel; returns the HUD view (same object while nothing changed). */
	frame(now: number, viewmodel: boolean, speed: number): ZombiesView {
		const r = this.host.zombieRenderer();
		if (this.solo) {
			this.samples.length = 0;
			for (const z of this.solo.zombies.values()) {
				const o = z.body.origin;
				this.samples.push({ id: z.id, x: o.x, y: o.y, z: o.z, yaw: z.yaw, flags: this.solo.zombieFlags(z), hp: z.hp / 8 });
			}
		} else this.buffer.sample(now - INTERP_DELAY_MS, this.samples);
		if (r) {
			r.sync(this.samples, now);
			r.setWeapon(this.ws.weapon);
			r.updateViewmodel(now, viewmodel && this.alive && !this.scoped, this.ws.reloadProgress(now), speed, undefined, this.ws.mag);
		}
		// A groan now and then from the nearest zombies (the sound is silent if not shipped).
		if (this.samples.length > 0 && now - this.lastGroan > 2500) {
			this.lastGroan = now;
			const z = this.samples[Math.floor(Math.random() * this.samples.length)]!;
			this.host.sound('groan', { x: z.x, y: z.y, z: z.z + VIEW_HEIGHT });
		}
		return this.buildView(now);
	}

	private buildView(now: number): ZombiesView {
		const s = this.state;
		const ws = this.ws;
		const reloading = ws.reloading(now);
		const loadoutOpen = this.loadoutOpen(now);
		if (this.hitMarker && now - this.hitMarker.at > 400) this.hitMarker = null;
		if (this.flash && now - this.flash.at > 3000) this.flash = null;
		const feed = liveKillFeed(this.feed, now);
		if (feed.length !== this.feed.length) this.feed = feed;
		const key = [
			s?.phase,
			s?.round,
			this.stateAt,
			this.hp,
			this.alive,
			ws.weapon,
			ws.mag,
			ws.reserve,
			reloading,
			loadoutOpen,
			this.hitMarker?.at,
			this.feed.length && this.feed[0]!.id,
			this.feed.length,
			this.flash?.at,
			this.hurtAt,
			this.scoped,
			this.summary ? 1 : 0,
			this.team,
			this.gateKey
		].join('|');
		if (key === this.viewKey && this.view) return this.view;
		this.viewKey = key;
		const me = s?.players.find((p) => p.id === this.me);
		this.view = {
			phase: s?.phase ?? 'waiting',
			round: s?.round ?? 0,
			endsAt: s && (s.phase === 'countdown' || s.phase === 'ended') ? this.stateAt + s.timeLeft * 1000 : 0,
			startedAt: s && s.phase === 'playing' ? this.stateAt - s.elapsed * 1000 : null,
			team: this.team,
			gate: this.gateView(),
			respawnAt: this.alive ? 0 : this.respawnAt,
			hp: this.hp,
			maxHp: this.team === 'zombie' ? ZOMBIE_HP : ZM_PLAYER_HP,
			alive: this.alive,
			weapon: ws.weapon,
			weaponLabel: WEAPONS[ws.weapon].label,
			mag: ws.mag,
			magSize: WEAPONS[ws.weapon].magazine,
			reserve: ws.reserve,
			reloadEndsAt: reloading ? ws.reloadEndsAt : 0,
			reloadMs: WEAPONS[ws.weapon].reloadMs,
			loadoutOpen,
			loadoutEndsAt: s?.phase === 'playing' ? this.loadoutEndsAt : 0,
			checkpoint: s?.checkpoint ?? 0,
			checkpoints: s?.checkpoints ?? 0,
			progress: s?.progress ?? 0,
			zombies: s?.zombies ?? 0,
			teamKills: s?.kills ?? 0,
			myKills: me?.kills ?? 0,
			hitMarker: this.hitMarker,
			killFeed: this.feed,
			flash: this.flash,
			hurtAt: this.hurtAt,
			down: this.alive ? null : { targetName: '' },
			scoped: this.scoped,
			summary: this.summary,
			online: !this.solo
		};
		return this.view;
	}

	/** The next gate that is not open yet (HUD), or null when all are open. */
	private gateView(): ZombiesView['gate'] {
		const gates = this.state?.gates ?? [];
		const i = gates.findIndex((g) => g.state !== 'open');
		if (i < 0) return null;
		const g = gates[i]!;
		return { index: i, count: gates.length, state: g.state === 'counting' ? 'counting' : 'closed', opensAt: g.state === 'counting' ? this.stateAt + g.secsLeft * 1000 : 0 };
	}

	/** Solo scoreboard row values. */
	soloRow(): { kills: number; deaths: number; alive: boolean } {
		const v = this.solo?.playerView(SOLO_ID);
		return { kills: v?.kills ?? 0, deaths: v?.deaths ?? 0, alive: (v?.team ?? 'survivor') === 'survivor' };
	}

	/** Solo: the local game's state (score panel); null online. */
	soloState(): ZmStateView | null {
		return this.solo ? this.state : null;
	}

	dispose(): void {
		this.setScoped(false);
		this.host.zombieRenderer()?.clear();
		this.buffer.clear();
	}
}
