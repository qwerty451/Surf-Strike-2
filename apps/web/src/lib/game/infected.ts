/**
 * Infected client (docs/modes.md#infected). Online it predicts the local
 * weapons (fire rate, ammo, reload), sends `fire`/`reload`/`loadout`/
 * `throwKnife`, steps throwing knives smoothly between server events and
 * shows the server's events. Offline there is no round (infected needs a
 * server and 2+ players): free roam with a waiting banner. Without a round,
 * offline or while the server waits for a second player, the practice range
 * (./infected-practice.ts) lets the local player shoot at target dummies.
 * game.ts owns the player, camera and input; this module owns everything
 * infected-specific behind a small host interface.
 *
 * Server rules this mirrors (packages/shared/src/modes/infected/game.ts):
 * - A survivor is infected in place: `infect` for me, then `ammo` 'claws'.
 * - Infected have claws only, Patient Zero too; on older servers Patient Zero
 *   has the guns until an `ammo` 'claws' event.
 * - `ammo` with `scavenger: true` names the primary (or, with the scavenger
 *   perk, the pistol) even while another slot is held: a reserve update only.
 * - Survivors carry three slots: [1] the round preset, [2] the pistol
 *   (INF_SECONDARY, its own INF_AMMO), [3] the knife. `spawn` only carries the
 *   held gun, so the pistol starts from INF_AMMO wherever the server hands out
 *   fresh guns (round and join spawns as a survivor).
 * - Kill streak perks (INF_PERK_KILLS) come from `perk` events and the state;
 *   the client mirrors their prediction factors (reload, cadence, spread,
 *   speed). A M.O.A.B. is earned with `moabReady`, called with `callMoab`,
 *   counts down (`moabCall`) and ends the round (`moabDetonate`, then `end`).
 * - Remote roles come from `players[].alpha`, not `alphaId` (which stays set).
 * - Respawn beacons: one per infected; placing again replaces it
 *   (`beaconDestroy` with `by: null`, then `beaconPlace`). The next respawn
 *   consumes it (`beaconUse`, then `spawn` reason 'beacon').
 */
import {
	INF_AMMO,
	INF_BEACON_COOLDOWN_MS,
	INF_BEACON_HIT_Z,
	INF_INFECTED_HP,
	INF_INFECTED_SPEED,
	INF_KNIFE_GRAVITY,
	INF_PRESETS,
	INF_RESPAWN_SECS,
	INF_SECONDARY,
	INF_SLEIGHT_RELOAD_FACTOR,
	INF_SPECIALIST_CADENCE_FACTOR,
	INF_STEADY_SPEED_FACTOR,
	INF_STEADY_SPREAD_FACTOR,
	INF_SURVIVOR_HP,
	infPerksForStreak,
	isWeaponId,
	WEAPONS,
	WeaponState,
	ZM_SLOW_MS,
	zmSlowFactor,
	type ClientMessage,
	type CollisionWorld,
	type InfBeaconView,
	type InfEvent,
	type InfKnifeView,
	type InfMethod,
	type InfPerkId,
	type InfStateView,
	type InfTeam,
	type Spawn,
	type Vec3,
	type WeaponId
} from '@surf/shared';
import type { BeaconRenderPose, InfectedRenderer, KnifeRenderPose } from '../render/infected.js';
import type { RemotePlayers } from '../render/players.js';
import { hitFeedback, killFeedback, localImpact, moabFeedback, reloadFeedback, shotFeedback, syncHeld, syncReloads, turnFeedback } from './infected-feedback.js';
import { BOLT_MS, FP_BOLTS, FP_RELOADS, MAG_IN_LEAD_MS, type Clip, type CueSound } from '../render/fp-clips.js';
import type { ZombieRenderer } from '../render/zombies.js';
import type { InfectedView, InfSpecView, KillFeedLine } from './contract.js';
import { InfFeedback } from './infected-hud-events.js';
import { pickFeedback } from './infected-pick.js';
import { InfPractice, nextPrimary, practiceRefill, type PracticeTarget } from './infected-practice.js';
import { FIRE_BUFFER_MS, forwardDir, liveKillFeed, pushKillFeed, spreadDir } from './zombies-view.js';
import {
	AIM,
	aimFov,
	aimMoveFactor,
	aimSpread,
	aimStep,
	AIM_GUN_KICK,
	Bloom,
	ease,
	hipSpread,
	kickedPitch,
	MAX_PENDING_SWAPS,
	RECOIL_REF_FOV,
	restVmFeel,
	GunKick,
	SWAP_ACK_MS,
	ViewKick,
	VM_DRY_MS,
	VM_LAND_MIN_SPEED,
	VM_LAND_MS,
	VM_LAND_SPEED,
	vmBump,
	vmDraw,
	VmSway,
	ZOOM_MS,
	zoomFov,
	zoomStep,
	type AimInput,
	type VmFeel
} from './gunfeel.js';

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
/**
 * `fire.tick`: the client never learns the infected sim tick, and the server
 * clamps it into its history window, so a huge tick means "no rewind".
 */
export const INF_FIRE_TICK_NOW = 2 ** 31 - 1;
/** Stale `modeState.hasKnife` is ignored this long after a local throw or pickup. */
const KNIFE_GRACE_MS = 600;
/** Flying knives snap to `modeState` only when this far off (units). */
const KNIFE_SNAP_DIST = 160;
/** A knife missing from `modeState` is kept this long after its event (ordering slack). */
const KNIFE_KEEP_MS = 500;
const FLASH_MS = 3000;
/** Hammer units per metre (HUD beacon distance). */
const UNITS_PER_M = 39.37;
const HIT_MS = 400;
/** Cosmetic pellet tracers per shotgun trigger pull (the server resolves every pellet). */
const PELLET_TRACERS_MIN = 5;
const PELLET_TRACERS_MAX = 8;

export type InfSound =
	| 'shot-pistol'
	| 'shot-lmg'
	| 'shot-sniper'
	| 'shot-barrett'
	| 'shot-striker'
	| 'shot-smg'
	| 'knife'
	| 'claws'
	| 'throw'
	| 'reload'
	| 'hit'
	| 'hurt'
	| 'round'
	| 'alpha'
	| 'uav'
	| 'beacon'
	| 'perk'
	| 'moabReady'
	| 'moab'
	| 'moabDetonate'
	/** Trigger pulled with an empty magazine and no reserve. */
	| 'dryfire'
	/** Weapon swap (the new weapon comes up). */
	| 'draw'
	/** Scope raised or lowered. */
	| 'scope'
	/** The bolt, slide or feed cover of a reload closes. */
	| 'reloadDone'
	/** My reload: the gun taken up, its magazine out and in. */
	| 'handle'
	| 'magOut'
	| 'magIn'
	/** The sniper's bolt after a shot. */
	| 'bolt'
	/** A case (brass, shotgun shell) falls. */
	| 'casing'
	| 'shell'
	/** A bullet hit world geometry (positional). */
	| 'impact'
	/** My shot hit a head / killed (variants of 'hit'). */
	| 'hitHead'
	| 'hitKill'
	/** An infected died (positional). */
	| 'death'
	/** A survivor turned infected (positional; mine without a position). */
	| 'infect'
	| 'knifeBounce'
	| 'knifeStick'
	| 'knifePickup'
	/** A survivor smashed a respawn beacon / an infected respawned on one (positional). */
	| 'beaconSmash'
	| 'beaconUse';

/** Kill streak perk names and their unlock toast (hardline is the base perk). */
export const INF_PERK_INFO: Readonly<Record<InfPerkId, { name: string; toast: string }>> = Object.freeze({
	hardline: { name: 'Hardline', toast: 'HARDLINE · Streaks need one kill less' },
	sleight: { name: 'Sleight', toast: 'SLEIGHT OF HAND · 2× Reload' },
	scavenger: { name: 'Scavenger', toast: 'SCAVENGER PRO · Full Resupply' },
	steady: { name: 'Steady Aim', toast: 'STEADY AIM · Tight Spread + Speed' },
	specialist: { name: 'Specialist', toast: 'SPECIALIST BONUS! All Perks Active +250' }
});

/** Full HP of a team (the HUD shows it for infected only: one hit infects a survivor). */
export function infMaxHp(team: InfTeam): number {
	return team === 'infected' ? INF_INFECTED_HP : INF_SURVIVOR_HP;
}

/** Cosmetic tracers per trigger pull: 1, or 5-8 for a shotgun. */
export function pelletTracers(weapon: WeaponId): number {
	const n = Math.floor(WEAPONS[weapon].pellets ?? 1);
	return n > 1 ? Math.max(PELLET_TRACERS_MIN, Math.min(PELLET_TRACERS_MAX, n)) : 1;
}

/** Mode ammo (INF_AMMO) for a fresh weapon state. */
function limitAmmo(ws: WeaponState): void {
	const a = INF_AMMO[ws.weapon];
	if (!a) return;
	ws.mag = a.mag;
	ws.reserve = a.reserve;
}

function samePerks(a: readonly InfPerkId[], b: readonly InfPerkId[]): boolean {
	return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** Role shown on remote players. */
export type InfRole = 'none' | 'infected' | 'alpha';

export interface InfHost {
	online(): boolean;
	selfId(): number;
	send(msg: ClientMessage): void;
	/** Viewmodel and tracers. */
	zombieRenderer(): ZombieRenderer | null;
	/** Throwing knives and UAV pulses. */
	infectedRenderer(): InfectedRenderer | null;
	/** Remote avatars: hit flash, turn ease, held weapons, muzzle flashes. Optional: hosts without avatars leave it out. */
	remotePlayers?(): RemotePlayers | null;
	name(id: number): string;
	notice(text: string): void;
	/** Teleport the local player (spawn, fall-out). */
	teleport(x: number, y: number, z: number, yaw: number): void;
	sound(name: InfSound, at?: Vec3): void;
	/** Zoom: horizontal FOV at 4:3, or null for the cvar FOV. */
	setZoom(fov: number | null): void;
	/**
	 * Eased zoom, every frame while the scope moves or is up: the scope's FOV
	 * (horizontal at 4:3) and its eased 0..1 progress. A host with this member
	 * eases the camera from it instead of snapping on `setZoom`.
	 */
	zoomProgress?(fov: number, t: number): void;
	/** Camera recoil offset on top of the view angles, every frame (degrees; pitch + = down, yaw + = left, roll + = counter-clockwise). */
	setViewKick?(pitch: number, yaw: number, roll: number): void;
	/** Knockback on the local player (hit by a bullet). */
	push(vx: number, vy: number): void;
	/** Map spawn points: where the practice range puts its targets. Optional: a host without them has no targets. */
	spawns?(): readonly Spawn[];
}

interface LocalKnife extends KnifeRenderPose {
	/** Last event or state update that touched it (ms). */
	at: number;
}

/** Remote role from a player view (the Alpha until the first infection). */
export function infRole(p: { team: InfTeam; alpha: boolean } | undefined): InfRole {
	if (!p || p.team !== 'infected') return 'none';
	return p.alpha ? 'alpha' : 'infected';
}

/** Kill feed text of an infection. */
export function infectText(victim: string, by: string | null, method: InfMethod): string {
	if (by === null) return `${victim} turned`;
	const how = method === 'bank' ? 'bank-shot knife' : method === 'knife' ? 'throwing knife' : method === 'gun' ? 'gun' : 'claws';
	return `${by} · ${how} › ${victim}`;
}

/** Step a flying knife by `dt` seconds (gravity only; the server sends bounces and sticks). */
export function stepKnife(k: { x: number; y: number; z: number; vx: number; vy: number; vz: number }, dt: number): void {
	k.x += k.vx * dt;
	k.y += k.vy * dt;
	k.z += k.vz * dt - 0.5 * INF_KNIFE_GRAVITY * dt * dt;
	k.vz -= INF_KNIFE_GRAVITY * dt;
}

/** Share of a rifle's aim (linear) after which its scope overlay comes in. */
const SCOPE_OVERLAY_FROM = 0.6;
/** My tracers start this far ahead of the eye (units). */
const TRACER_AHEAD = 18;

export class InfectedClient {
	private readonly solo: boolean;
	private state: InfStateView | null = null;
	private stateAt = 0;
	/** Local round clock end (bumped by +20 s infections before the next state). */
	private endsAt = 0;
	private phase: InfectedView['phase'];
	private round = 0;
	private loadout: WeaponId = INF_PRESETS[0]!;
	/** Round preset gun (survivors; the Alpha of an older server); ammo only from server events. */
	private primaryWs: WeaponState;
	/** Pistol (slot 2): its own magazine and reserve. */
	private secondaryWs = new WeaponState(INF_SECONDARY);
	/** Knife (survivors) or claws (infected). */
	private meleeWs = new WeaponState('knife');
	private ws: WeaponState;
	private team: InfTeam = 'survivor';
	private alpha = false;
	private hp = INF_SURVIVOR_HP;
	private alive = true;
	private hasKnife = false;
	/** Local throw or pickup time (stale state grace). */
	private knifeAt = -Infinity;
	private respawnAt = 0;
	private slowUntil = 0;
	private slowStacks = 0;
	private fireHeld = false;
	private firePressAt = -Infinity;
	private throwPending = false;
	private scoped = false;
	private hitMarker: InfectedView['hitMarker'] = null;
	private feed: KillFeedLine[] = [];
	private feedId = 0;
	private flash: InfectedView['flash'] = null;
	private timeBonusAt = 0;
	private scavengerAt = 0;
	private hurtAt = 0;
	private uavAt = 0;
	private summary: InfectedView['summary'] = null;
	/** Score popups, hit direction arcs and round summary rows (infected-hud-events.ts). */
	private readonly fb = new InfFeedback({
		me: () => this.me,
		team: () => this.team,
		alive: () => this.alive,
		spectating: () => this.spectating,
		specId: () => this.specId,
		players: () => this.state?.players,
		name: (id) => this.host.name(id)
	});
	/** View yaw in degrees, set by game.ts every frame (hit direction arcs). */
	viewYaw = 0;
	/** Distance from me to the latest UAV ping (infected), null when unknown. */
	private uavDist: number | null = null;
	/** Last eye position from `tick` (UAV distance). */
	private eye: Vec3 | null = null;
	/** Last feet origin from `tick` (beacon distance). */
	private feet: Vec3 | null = null;
	/** Spectating (free-fly or a target): local input and first-person visuals are off. */
	private spectating = false;
	private specId: number | null = null;
	private knives = new Map<number, LocalKnife>();
	private knifeList: KnifeRenderPose[] = [];
	/** Planted respawn beacons by beacon id (state + events). */
	private beacons = new Map<number, BeaconRenderPose>();
	private beaconList: BeaconRenderPose[] = [];
	/** My respawn beacon is planted. */
	private hasBeacon = false;
	/** Earliest local time of the next placement request (mirrors the server cooldown). */
	private nextBeaconAt = 0;
	/** Survivor kill streak this life and the perks it unlocked. */
	private streak = 0;
	private perks: InfPerkId[] = [];
	/** A M.O.A.B. is earned and not called yet. */
	private moabReady = false;
	/** A called M.O.A.B.: caller and local detonation time. */
	private moab: { callerId: number; endsAt: number } | null = null;
	private moabDetonatedAt = 0;
	private perkFlash: InfectedView['perkFlash'] = null;
	private lastFrame = 0;
	private viewKey = '';
	private view: InfectedView | null = null;
	/** Practice range (./infected-practice.ts): target dummies to shoot while there is no round. */
	private readonly practice: InfPractice;

	constructor(
		private readonly host: InfHost,
		now: number,
		/** Map collision for cosmetic tracer length (optional in tests). */
		private readonly world: Pick<CollisionWorld, 'trace'> | null = null
	) {
		this.solo = !host.online();
		this.practice = new InfPractice(host, world);
		this.phase = this.solo ? 'solo' : 'waiting';
		this.primaryWs = new WeaponState(this.loadout);
		limitAmmo(this.primaryWs);
		limitAmmo(this.secondaryWs);
		this.ws = this.primaryWs;
		this.lastFrame = now;
		this.host.zombieRenderer()?.setWeapon(this.ws.weapon);
	}

	get me(): number {
		return this.host.selfId();
	}

	get isSolo(): boolean {
		return this.solo;
	}

	get weapon(): WeaponId {
		return this.ws.weapon;
	}

	get isInfected(): boolean {
		return this.team === 'infected';
	}

	get isAlpha(): boolean {
		return this.alpha;
	}

	get knifeReady(): boolean {
		return this.hasKnife;
	}

	get beaconPlanted(): boolean {
		return this.hasBeacon;
	}

	get isSpectating(): boolean {
		return this.spectating;
	}

	/** Earned M.O.A.B. waiting to be called. */
	get moabAvailable(): boolean {
		return this.moabReady;
	}

	/** Active kill streak perks (survivors). */
	get activePerks(): readonly InfPerkId[] {
		return this.perks;
	}

	private has(perk: InfPerkId): boolean {
		return this.team === 'survivor' && this.perks.includes(perk);
	}

	/** Sleight of hand: reload duration factor. */
	private get reloadFactor(): number {
		return this.has('sleight') ? INF_SLEIGHT_RELOAD_FACTOR : 1;
	}

	/** Specialist: wait-between-shots factor. */
	private get cadenceFactor(): number {
		return this.has('specialist') ? INF_SPECIALIST_CADENCE_FACTOR : 1;
	}

	/** Steady aim: spread factor (aim spread and shotgun pellets). */
	private get spreadFactor(): number {
		return this.has('steady') ? INF_STEADY_SPREAD_FACTOR : 1;
	}

	/**
	 * game.ts, every frame: spectating (free-fly or `targetId`) hides the local
	 * viewmodel, scope and hurt feedback and ignores local weapon input; the HUD
	 * shows the target's role, HP, score and weapon instead.
	 */
	setSpectate(spectating: boolean, targetId: number | null): void {
		const id = spectating ? targetId : null;
		if (spectating === this.spectating && id === this.specId) return;
		this.spectating = spectating;
		this.specId = id;
		if (spectating) {
			this.endPractice();
			this.leaveAim(true);
			this.aimT = 0;
			this.fireHeld = false;
			this.firePressAt = -Infinity;
			this.throwPending = false;
		}
	}

	/** Down: no movement while waiting to respawn. */
	get down(): boolean {
		return !this.alive;
	}

	/** No server round: fall-outs are handled locally (modes/infected.ts; the server skips them while waiting). */
	get localFallouts(): boolean {
		return this.solo || this.phase === 'waiting';
	}

	/** Player max speed: claws speed, or the held weapon (CS-style weapon speed); hit slows. */
	maxSpeed(now = performance.now()): number {
		const slow = zmSlowFactor(now < this.slowUntil ? this.slowStacks : 0);
		if (this.ws.weapon === 'claws' || (this.team === 'infected' && !this.alpha)) return INF_INFECTED_SPEED * slow;
		const steady = this.has('steady') ? INF_STEADY_SPEED_FACTOR : 1;
		// Aiming down sights slows by the gun's aimed move factor, eased in with the aim.
		const aim = aimMoveFactor(this.ws.weapon, ease(this.aimT));
		return WEAPONS[this.ws.weapon].moveSpeed * steady * aim * slow;
	}

	/** Remote player role (look and name tag). */
	roleOf(id: number): InfRole {
		return infRole(this.state?.players.find((p) => p.id === id));
	}

	/** Remote players not in play (respawning) are hidden. */
	isDown(id: number): boolean {
		return this.state?.players.some((p) => p.id === id && !p.alive) ?? false;
	}

	private get playing(): boolean {
		return this.phase === 'playing';
	}

	/** Survivors swap weapons (the Alpha of an older server too); infected only have claws. */
	private get armed(): boolean {
		return this.team === 'survivor' || this.alpha;
	}

	// ---------------------------------------------------------------------
	// Input

	// Gun feel (./gunfeel.ts): view kick, bloom, scope ease and viewmodel motion.
	private readonly viewKick = new ViewKick();
	/** Gun kick of the held gun: shown on the viewmodel, and aimed through iron sights it turns the shots (AIM_GUN_KICK). */
	private readonly gunKick = new GunKick();
	private readonly gunShown = { pitch: 0, yaw: 0 };
	/** Shots of the current trigger pull (the reduced first shots of a view-kick set). */
	private pullShots = 0;
	private readonly bloom = new Bloom();
	private readonly sway = new VmSway();
	/** Viewmodel extras of this frame and the aim input, reused every frame. */
	private readonly vmFeel: VmFeel = restVmFeel();
	private readonly aimIn: AimInput = { bloom: 0, aim: 0, speed: 0, onGround: true, ducked: false, factor: 1 };
	/** Clock of the feel state: the latest `tick`/`frame` time (ms). */
	private feelAt = -Infinity;
	/**
	 * Aim down sights (Mouse2): the button is held (hold mode) or the aim is
	 * toggled on (toggle mode, `aimToggle`).
	 */
	private aimHeld = false;
	/** Aiming now: `aimHeld` and a gun that can aim (alive, in play, not reloading). */
	private aiming = false;
	/** Aim progress 0..1 (linear; eased for the camera, spread, recoil, speed, viewmodel and HUD). */
	private aimT = 0;
	/** Set by game.ts every frame: Mouse2 toggles the aim instead of holding it (`cl_aimtoggle`). */
	aimToggle = false;
	/** Set by game.ts every frame: the player's FOV (horizontal at 4:3), which the aimed FOV magnifies. */
	fov = RECOIL_REF_FOV;
	/**
	 * The host still shows a zoom: one more report brings it back to 0. True at
	 * the start, so a new client clears what a replaced one left behind.
	 */
	private zoomUp = true;
	/** Draw of the held weapon: start and end (ms). */
	private drawAt = -Infinity;
	private drawEndsAt = -Infinity;
	/** The current trigger press may still click on an empty gun; time of the last click. */
	private dryArmed = false;
	private dryAt = -Infinity;
	/** Sounds still to come of the held weapon's running reload, or of its bolt, and the end of that reload (0: a bolt). */
	private cues: { at: number; sound: CueSound }[] = [];
	private cuesOf = 0;
	/** Swaps sent and not acknowledged yet, oldest first. */
	private swaps: Array<{ weapon: WeaponId; at: number }> = [];
	/** Movement at the last tick: speed and stance (spread), turn rates and strafe (sway), landing (dip). */
	private moveSpeed = 0;
	private grounded = true;
	private crouched = false;
	private strafe = 0;
	private climb = 0;
	private turnYaw = 0;
	private turnPitch = 0;
	private lastPitch = 0;
	private lastYaw = 0;
	private lastTickAt = -Infinity;
	private fallSpeed = 0;
	private landAt = -Infinity;
	private landAmp = 0;

	press(action: 'attack' | 'attack2', down: boolean, now: number): void {
		if (this.spectating) return;
		if (action === 'attack') {
			this.fireHeld = down;
			if (down) {
				this.firePressAt = now;
				this.dryArmed = true;
				this.pullShots = 0;
			}
			return;
		}
		// Infected with the throwing knife (the Alpha too while it holds one): Mouse2 throws.
		if (down && this.alive && this.team === 'infected' && this.hasKnife && this.playing) {
			this.throwPending = true;
			return;
		}
		// Aim down sights: held by default, a toggle with `aimToggle`. Only a gun aims.
		if (this.aimToggle) {
			if (down && this.alive && AIM[this.ws.weapon]) this.aimHeld = !this.aimHeld;
		} else this.aimHeld = down && this.alive;
		this.advanceFeel(now, false);
		this.updateAim(now, true);
	}

	/**
	 * Aim from the button and what may block it: a gun that can aim, alive, in
	 * play, not reloading (a held aim comes back when the reload ends). The two
	 * rifles are `scoped` while aiming; `input` (Mouse2) plays the scope sound
	 * when their scope goes up or down, every other change is silent.
	 */
	private updateAim(now: number, input = false): void {
		const def = WEAPONS[this.ws.weapon];
		this.aiming = this.aimHeld && this.alive && !this.spectating && AIM[def.id] !== undefined && !this.ws.reloading(now);
		const scoped = this.aiming && def.zoomFov !== null;
		if (scoped === this.scoped) return;
		this.scoped = scoped;
		this.host.setZoom(scoped ? def.zoomFov : null);
		if (input) this.host.sound('scope');
	}

	/**
	 * Leave the aim. Reload, swap and throw switch a toggled aim off; a held
	 * one stays held and aims again once nothing blocks it. `hard` (death,
	 * spectating, spawn, round end) lets go of the button too.
	 */
	private leaveAim(hard = false, now = this.lastFrame): void {
		if (hard || this.aimToggle) this.aimHeld = false;
		this.updateAim(now);
	}

	/**
	 * Keys 1-4: [1] round preset, [2] pistol, [3] knife, [4] call an earned
	 * M.O.A.B. (same as N). Returns false while spectating.
	 */
	slot(n: number, now: number): boolean {
		if (this.spectating) return false;
		// Practice range: 4 tries the next primary (no M.O.A.B. without a round).
		if (n === 4 && this.practice.active) return this.cyclePrimary(now);
		if (n === 4) {
			if (this.moabReady) this.callMoab(now);
			return true;
		}
		if (!this.alive || !this.armed || this.meleeWs.weapon !== 'knife') return true;
		const want = n === 1 ? this.primaryWs : n === 2 ? this.secondaryWs : n === 3 ? this.meleeWs : null;
		if (!want || want === this.ws) return true;
		this.hold(want, now);
		if (!this.solo && !this.practice.active) {
			// The server acks every swap with an `ammo` event (kept for SWAP_ACK_MS: a refused swap gets none).
			if (this.swaps.length >= MAX_PENDING_SWAPS) this.swaps.shift();
			this.swaps.push({ weapon: want.weapon, at: now });
			this.host.send({ type: 'loadout', weapon: want.weapon });
		}
		return true;
	}

	/**
	 * Swap the held weapon (a swap cancels a reload, like the server). With `now`
	 * (a key press, an `ammo` resync) the weapon is drawn: it cannot fire for its
	 * `deployMs`, as on the server. Without it the server put the weapon in my
	 * hands (spawn, role change, claws): no draw, and swap acks still on their
	 * way are void. `again`: the held slot itself changed (the practice range
	 * swapped its gun, or hands the round guns back).
	 */
	private hold(next: WeaponState, now?: number, again = false): void {
		if (next === this.ws && !again) return;
		this.ws.reloadEndsAt = 0;
		this.cues.length = 0;
		this.ws = next;
		this.gunKick.reset();
		// A swap leaves the aim at once: the new weapon comes up at the hip (a held aim then aims it, even during the draw).
		this.aimT = 0;
		this.leaveAim(false, now);
		this.bloom.reset();
		if (now === undefined) {
			this.swaps.length = 0;
			this.drawAt = this.drawEndsAt = -Infinity;
		} else {
			next.deploy(now);
			this.drawAt = now;
			this.drawEndsAt = now + (next.def.deployMs ?? 0);
			if (next.weapon !== 'claws') this.host.sound('draw');
		}
		this.host.zombieRenderer()?.setWeapon(next.weapon);
	}

	/**
	 * An `ammo` event naming `weapon` arrived: should the client hold it? Not
	 * while acks of newer swaps are on their way: after 1, 2, 1 inside one round
	 * trip the first ack names the pistol, and holding it would flip the weapon
	 * and cancel a reload started since.
	 */
	private swapSettled(weapon: WeaponId, now: number): boolean {
		const q = this.swaps;
		while (q.length > 0 && now - q[0]!.at > SWAP_ACK_MS) q.shift();
		if (q.length > 0 && q[0]!.weapon === weapon) q.shift();
		return q.length === 0;
	}

	reload(now: number): void {
		if (this.spectating || !this.alive) return;
		if (this.ws !== this.primaryWs && this.ws !== this.secondaryWs) return;
		const empty = this.ws.mag === 0;
		if (!this.ws.startReload(now, this.reloadFactor)) return;
		// Each move of the reload sounds when it is seen (render/fp-clips.ts).
		const w = this.ws.weapon;
		if (w !== 'knife' && w !== 'claws') this.cue(FP_RELOADS[w][empty ? 'empty' : 'loaded'], now, this.ws.reloadDurationMs, this.ws.reloadEndsAt);
		this.leaveAim(false, now);
		if (!this.solo && !this.practice.active) this.host.send({ type: 'reload' });
	}

	/** The sounds of a clip that starts now and lasts `ms`. */
	private cue(clip: Clip, now: number, ms: number, of: number): void {
		this.cuesOf = of;
		this.cues = clip.cues.map((c) => ({ at: now + c.t * ms - (c.sound === 'magIn' ? MAG_IN_LEAD_MS : 0), sound: c.sound }));
		this.playCues(now);
	}

	private playCues(now: number): void {
		const q = this.cues;
		if (q.length === 0) return;
		// Cancelled: the rest is not heard. A reload that ended has had its end moved to 0.
		if (!this.alive || (this.cuesOf > 0 && this.ws.reloadEndsAt !== this.cuesOf && now < this.cuesOf)) {
			q.length = 0;
			return;
		}
		while (q.length > 0 && q[0]!.at <= now) this.host.sound(q.shift()!.sound);
	}

	/**
	 * Total aim spread half-angle now (degrees): base, bloom and movement
	 * (halved by Steady Aim).
	 */
	private spreadNow(): number {
		const w = this.ws.weapon;
		if (WEAPONS[w].magazine === 0) return 0;
		const a = this.aimIn;
		a.bloom = this.bloom.value;
		// The hip cone shrinks with the aim progress: nothing left fully aimed.
		a.aim = ease(this.aimT);
		a.speed = this.moveSpeed;
		a.onGround = this.grounded;
		a.ducked = this.crouched;
		a.factor = this.spreadFactor;
		return aimSpread(w, a);
	}

	/** View values in steps of 0.05, so the HUD view is rebuilt per visible step and not every frame. */
	private aimView(): number {
		return this.alive && !this.spectating ? Math.round(ease(this.aimT) * 20) / 20 : 0;
	}

	/** Scope overlay progress of the two rifles: the rifle comes up first, the scope picture takes over in the last part of the aim. */
	private scopeView(): number {
		if (WEAPONS[this.ws.weapon].zoomFov === null || !this.alive || this.spectating) return 0;
		return Math.round(ease((this.aimT - SCOPE_OVERLAY_FROM) / (1 - SCOPE_OVERLAY_FROM)) * 20) / 20;
	}

	/** The crosshair gap: the hip cone, whatever the aim (the crosshair fades out as the sights come up). */
	private spreadView(): number {
		if (!this.alive || this.spectating) return 0;
		this.spreadNow();
		return Math.round(hipSpread(this.ws.weapon, this.aimIn) * 20) / 20;
	}

	/**
	 * Advance the aim, view kick and bloom to `now` (ticks and frames share one
	 * clock). `aim`: then take up what may have changed the aim (a reload that
	 * ended, a weapon that cannot aim); Mouse2 does that itself, with sound.
	 */
	private advanceFeel(now: number, aim = true): void {
		if (this.feelAt === -Infinity) this.feelAt = Math.min(now, this.lastFrame);
		if (aim) this.updateAim(now);
		const dt = now - this.feelAt;
		if (!(dt > 0)) return;
		this.feelAt = now;
		this.aimT = aimStep(this.aimT, this.aiming, dt, AIM[this.ws.weapon]?.aimMs ?? 1);
		this.viewKick.update(now);
		this.bloom.update(now);
	}

	/** Per tick: the feel clock, the sounds of a reload, and the movement that drives spread and sway. */
	private feelTick(now: number, pitch: number, yaw: number, ducked: boolean, velocity: Vec3, onGround: boolean): void {
		this.advanceFeel(now);
		this.playCues(now);
		const dt = now - this.lastTickAt;
		if (dt > 0 && dt < 100) {
			// Shortest way round, so crossing ±180° is not a spin.
			this.turnYaw = (((((yaw - this.lastYaw) % 360) + 540) % 360) - 180) * (1000 / dt);
			this.turnPitch = (pitch - this.lastPitch) * (1000 / dt);
		} else this.turnYaw = this.turnPitch = 0;
		this.lastTickAt = now;
		this.lastPitch = pitch;
		this.lastYaw = yaw;
		const yr = (yaw * Math.PI) / 180;
		this.moveSpeed = Math.hypot(velocity.x, velocity.y);
		this.strafe = velocity.x * Math.sin(yr) - velocity.y * Math.cos(yr);
		this.climb = onGround ? 0 : velocity.z;
		if (onGround && !this.grounded && this.fallSpeed > VM_LAND_MIN_SPEED) {
			this.landAt = now;
			this.landAmp = Math.min(1, this.fallSpeed / VM_LAND_SPEED);
		}
		if (!onGround) this.fallSpeed = Math.max(0, -velocity.z);
		this.grounded = onGround;
		this.crouched = ducked;
	}

	/** Per frame: advance the feel, report the camera kick and zoom to the host, pose the viewmodel extras. */
	private feelFrame(now: number, dt: number): void {
		const live = this.alive && !this.spectating;
		if (!live) {
			this.viewKick.reset();
			this.gunKick.reset();
			this.bloom.reset();
			this.aimT = 0;
		}
		this.advanceFeel(now);
		this.host.setViewKick?.(this.viewKick.pitch, this.viewKick.yaw, this.viewKick.roll);
		// Aimed FOV of the held gun (a swap starts the aim over, so it is always this gun's), over the end of the aim.
		const aim = ease(this.aimT);
		const zoom = ease(zoomStep(this.aimT, AIM[this.ws.weapon]?.aimMs ?? ZOOM_MS));
		if (zoom > 0 || this.zoomUp) {
			this.host.zoomProgress?.(aimFov(this.fov, this.ws.weapon), zoom);
			this.zoomUp = zoom > 0;
		}
		const f = this.vmFeel;
		const s = this.sway;
		if (live) s.update(dt * 1000, this.turnYaw, this.turnPitch, this.strafe, this.climb);
		else s.reset();
		f.x = s.x;
		f.y = s.y;
		f.roll = s.roll;
		f.yaw = s.yaw;
		f.pitch = s.pitch;
		f.land = this.landAmp * vmBump((now - this.landAt) / VM_LAND_MS);
		f.dry = vmBump((now - this.dryAt) / VM_DRY_MS);
		// Lowered by the draw (it lasts the weapon's deploy time); raised to the sights by the aim.
		const drawMs = this.drawEndsAt - this.drawAt;
		f.lower = drawMs > 0 ? vmDraw((now - this.drawAt) / drawMs) : 0;
		f.aim = aim;
		// The gun kick shrinks to the share that turns the shots while aimed through iron sights.
		this.gunKick.update(now);
		const shown = 1 - (1 - AIM_GUN_KICK) * (aim > 0 && WEAPONS[this.ws.weapon].zoomFov === null ? aim : 0);
		this.gunShown.pitch = this.gunKick.pitch * shown;
		this.gunShown.yaw = this.gunKick.yaw * shown;
		f.gun = this.gunShown;
	}

	/**
	 * E: plant a respawn beacon on the ground below me, also in a jump (living infected, round playing).
	 * The server checks ground and cooldown and answers with `beaconPlace`.
	 * Returns whether a request was sent.
	 */
	placeBeacon(now: number): boolean {
		if (this.solo || this.spectating || !this.alive || this.team !== 'infected' || !this.playing) return false;
		if (now < this.nextBeaconAt) return false;
		this.nextBeaconAt = now + INF_BEACON_COOLDOWN_MS;
		this.host.send({ type: 'placeBeacon' });
		return true;
	}

	/**
	 * N or 4 (`moab`): call the earned M.O.A.B. (living survivor, round
	 * playing, none inbound). Optimistic: the ready badge goes at once; a
	 * rejected call comes back with the next state. Returns whether it was sent.
	 */
	callMoab(_now: number): boolean {
		if (this.solo || this.spectating || !this.alive || this.team !== 'survivor' || !this.playing) return false;
		if (!this.moabReady || this.moab) return false;
		this.moabReady = false;
		this.host.send({ type: 'callMoab' });
		return true;
	}

	// ---------------------------------------------------------------------
	// Practice range (./infected-practice.ts)

	/** The practice range is open: shots are resolved here and nothing weapon-related is sent. */
	get practicing(): boolean {
		return this.practice.active;
	}

	/** The practice targets (tests and debugging). */
	practiceTargets(): readonly PracticeTarget[] {
		return this.practice.targets();
	}

	/**
	 * No round and I am in play: offline, or online once the server said it
	 * waits for players (the phase a new client starts in is only a guess).
	 */
	private get practiceOn(): boolean {
		return !this.spectating && this.alive && (this.solo || (this.phase === 'waiting' && this.state !== null));
	}

	/** Per tick without a round: runs the practice range. False when there is none (no firing). */
	private practiceTick(now: number): boolean {
		if (!this.practiceOn) return false;
		const p = this.practice;
		if (!p.active) p.start(now, this.feet, this.eye);
		p.tick(now, this.feet, this.eye);
		// A spent reserve refills (shown like a scavenger refill).
		const a = practiceRefill(this.primaryWs);
		const b = practiceRefill(this.secondaryWs);
		if (a || b) this.scavengerAt = now;
		return true;
	}

	/** Practice key 4: the primary becomes the next preset with fresh ammo, drawn like any swap. */
	private cyclePrimary(now: number): boolean {
		if (!this.alive || this.meleeWs.weapon !== 'knife') return true;
		this.primaryWs.equip(nextPrimary(this.primaryWs.weapon));
		limitAmmo(this.primaryWs);
		this.hold(this.primaryWs, now, true);
		return true;
	}

	/**
	 * The practice range closes (a round starts, or I spectate): the targets go
	 * and the guns are the fresh round guns the server holds for me, the primary
	 * in hand and nothing of the practice left on them. The server's `spawn`
	 * and `ammo` events that follow set the real state.
	 */
	private endPractice(): void {
		if (!this.practice.active) return;
		this.practice.stop();
		this.primaryWs.equip(this.loadout);
		limitAmmo(this.primaryWs);
		this.freshSecondary();
		this.hold(this.primaryWs, undefined, true);
		this.viewKick.reset();
		this.bloom.reset();
		this.hitMarker = null;
		this.scavengerAt = 0;
	}

	// ---------------------------------------------------------------------
	// Simulation tick (64 Hz, after the local player moved)

	/** `velocity` and `onGround`: the player's movement after this tick (spread, viewmodel sway). */
	tick(now: number, origin: Vec3, eyeZ: number, pitch: number, yaw: number, ducked: boolean, velocity: Vec3 = ZERO, onGround = true): void {
		this.feelTick(now, pitch, yaw, ducked, velocity, onGround);
		this.primaryWs.update(now);
		this.secondaryWs.update(now);
		this.eye = { x: origin.x, y: origin.y, z: eyeZ };
		this.feet = { x: origin.x, y: origin.y, z: origin.z };
		if (!this.alive || this.spectating) {
			this.fireHeld = false;
			this.throwPending = false;
			return;
		}
		const eye = { x: origin.x, y: origin.y, z: eyeZ };
		if (this.throwPending) {
			this.throwPending = false;
			if (this.team === 'infected' && this.hasKnife && this.playing) this.throwKnife(now, eye, pitch, yaw);
		}
		// No round: only the practice range fires.
		if ((this.solo || this.phase === 'waiting') && !this.practiceTick(now)) return;
		const def = WEAPONS[this.ws.weapon];
		// A trigger pulled during the draw and still held fires when the draw ends; a tap is kept for FIRE_BUFFER_MS only.
		const drawn = this.fireHeld && this.firePressAt >= this.drawAt && this.firePressAt < this.drawEndsAt;
		const want = (this.fireHeld && def.automatic) || now - this.firePressAt < FIRE_BUFFER_MS || drawn;
		if (!want) return;
		if (!this.ws.melee && this.ws.mag <= 0) {
			this.firePressAt = -Infinity;
			if (this.ws.reloading(now)) return;
			if (this.ws.reserve > 0) this.reload(now);
			else if (this.dryArmed && now >= this.drawEndsAt) {
				// Nothing left to load: one click per trigger press.
				this.dryArmed = false;
				this.dryAt = now;
				this.host.sound('dryfire');
			}
			return;
		}
		// The draw (nextFireAt from `deploy`) and the fire rate both hold the shot back here, never the server.
		if (!this.ws.fire(now, this.cadenceFactor)) return;
		this.firePressAt = -Infinity;
		// Both rifles stay aimed after a shot, the bolt action too while its bolt cycles (held or toggled aim).
		this.shoot(now, eye, pitch, yaw);
	}

	private throwKnife(now: number, eye: Vec3, pitch: number, yaw: number): void {
		this.hasKnife = false;
		this.knifeAt = now;
		this.leaveAim(false, now);
		this.host.zombieRenderer()?.thrown(now);
		this.host.sound('throw');
		this.host.send({ type: 'throwKnife', origin: eye, dir: forwardDir(pitch, yaw) });
	}

	private shoot(now: number, eye: Vec3, pitch: number, yaw: number): void {
		const def = WEAPONS[this.ws.weapon];
		// The shot follows the kicked view (the camera always shows the whole view kick; its roll turns
		// the picture about the aim line). The kick of this shot comes after it, so a first shot from
		// rest goes to the aim point.
		// Aimed through iron sights the gun kick turns the shot too, as far as the sights show it (muzzle up = pitch down).
		this.gunKick.update(now);
		const g = def.zoomFov === null ? AIM_GUN_KICK * ease(this.aimT) : 0;
		const fwd = g > 0 ? forwardDir(kickedPitch(pitch, this.viewKick.pitch - g * this.gunKick.pitch), yaw + this.viewKick.yaw + g * this.gunKick.yaw) : forwardDir(kickedPitch(pitch, this.viewKick.pitch), yaw + this.viewKick.yaw);
		const spread = this.spreadFactor;
		const dir = spreadDir(fwd, this.spreadNow());
		const r = this.host.zombieRenderer();
		r?.fired(now);
		this.host.sound(def.id === 'knife' || def.id === 'claws' ? def.id : (`shot-${def.id}` as InfSound));
		if (def.magazine > 0 && r) {
			// Cosmetic tracers from the muzzle to the first wall (players are resolved by the server).
			// Shotguns: the centre pellet plus a scatter within the (steady-aim tightened) pellet cone.
			const muzzle = this.tracerStart(r, eye, fwd, pitch, yaw);
			const n = pelletTracers(def.id);
			const cone = (def.pelletSpread ?? 0) * spread;
			for (let i = 0; i < n; i++) {
				const d = i === 0 ? dir : spreadDir(dir, cone);
				const end = { x: eye.x + d.x * def.range, y: eye.y + d.y * def.range, z: eye.z + d.z * def.range };
				const t = (this.world?.trace(eye, end, ZERO, ZERO).fraction ?? 1) * def.range;
				r.tracer(muzzle, { x: eye.x + d.x * t, y: eye.y + d.y * t, z: eye.z + d.z * t }, now);
				localImpact(this.host, this.world, eye, d, t, def.range, now, i === 0);
			}
		}
		if (this.practice.active) {
			// Practice range: resolved here against the targets, never sent.
			const hit = this.practice.shot(now, eye, dir, def.id, (def.pelletSpread ?? 0) * spread, this.me);
			if (hit) this.hitMarker = { at: now, head: hit.head, kill: hit.kill };
		} else this.host.send({ type: 'fire', weapon: def.id, origin: eye, dir, tick: INF_FIRE_TICK_NOW });
		const bolt = FP_BOLTS[def.id as keyof typeof FP_BOLTS];
		if (bolt) this.cue(bolt, now, BOLT_MS, 0);
		if (def.magazine > 0) {
			// Hip and aimed recoil blend with the aim progress (gunfeel.ts aimKickSet).
			this.viewKick.kick(def.id, now, ease(this.aimT), this.pullShots++);
			this.gunKick.kick(def.id, now);
			this.bloom.add(def.id, now);
		}
	}

	/** Start of my tracers: beside and below the aim from the hip, at the muzzle as drawn when aimed (below the centre behind a scope). */
	private tracerStart(r: ZombieRenderer, eye: Vec3, fwd: Vec3, pitch: number, yaw: number): Vec3 {
		const yr = (yaw * Math.PI) / 180;
		const start = { x: eye.x + fwd.x * TRACER_AHEAD + Math.sin(yr) * 7, y: eye.y + fwd.y * TRACER_AHEAD - Math.cos(yr) * 7, z: eye.z + fwd.z * TRACER_AHEAD - 6 };
		const aim = ease(this.aimT);
		if (aim <= 0) return start;
		const w = this.ws.weapon;
		const at = this.muzzleAt;
		const drawn = r.muzzleScreen?.(at) ?? false;
		// The vertical half angle is 3/4 of the horizontal one at 4:3 (render/fov.ts).
		const fov = zoomFov(this.fov, aimFov(this.fov, w), ease(zoomStep(this.aimT, AIM[w]?.aimMs ?? ZOOM_MS)));
		const k = TRACER_AHEAD * Math.tan((fov * Math.PI) / 360) * 0.75;
		const right = drawn ? at.right * k : 0;
		const down = drawn ? at.down * k : 6;
		// The camera as it looks now: its forward, right and up.
		const cp = (kickedPitch(pitch, this.viewKick.pitch) * Math.PI) / 180;
		const cy = ((yaw + this.viewKick.yaw) * Math.PI) / 180;
		const sinP = Math.sin(cp);
		const cosP = Math.cos(cp);
		const sinY = Math.sin(cy);
		const cosY = Math.cos(cy);
		const x = eye.x + cosP * cosY * TRACER_AHEAD + sinY * right - cosY * sinP * down;
		const y = eye.y + cosP * sinY * TRACER_AHEAD - cosY * right - sinY * sinP * down;
		const z = eye.z - sinP * TRACER_AHEAD - cosP * down;
		start.x += (x - start.x) * aim;
		start.y += (y - start.y) * aim;
		start.z += (z - start.z) * aim;
		return start;
	}

	private readonly muzzleAt = { right: 0, down: 0 };

	// ---------------------------------------------------------------------
	// Server input

	onModeState(m: InfStateView, now: number): void {
		if (this.solo) return;
		this.state = m;
		this.stateAt = now;
		this.phase = m.phase;
		this.round = m.round;
		this.loadout = m.loadout;
		if (m.phase !== 'waiting') this.endPractice();
		this.endsAt = m.phase === 'waiting' ? 0 : now + m.timeLeft * 1000;
		if (m.phase !== 'ended') this.summary = null;
		const me = m.players.find((p) => p.id === this.me);
		if (me) {
			this.hp = me.hp;
			if (me.team !== this.team || me.alpha !== this.alpha) this.setRole(me.team, me.alpha, me.weapon);
			if (me.alive !== this.alive) {
				this.alive = me.alive;
				if (!me.alive) {
					this.leaveAim(true, now);
					if (this.respawnAt <= now) this.respawnAt = now + INF_RESPAWN_SECS * 1000;
				}
			}
			if (me.hasKnife !== this.hasKnife && now - this.knifeAt > KNIFE_GRACE_MS) this.hasKnife = me.hasKnife;
			this.hasBeacon = me.hasBeacon;
			this.streak = me.streak;
			if (!samePerks(this.perks, me.perks)) this.perks = [...me.perks];
			this.moabReady = me.moabReady;
		}
		const mb = m.moab;
		if (!mb) this.moab = null;
		// Anchored once per call: the state's timeLeft is rounded (re-anchoring jitters).
		else if (!this.moab || this.moab.callerId !== mb.callerId) this.moab = { callerId: mb.callerId, endsAt: now + mb.timeLeft * 1000 };
		this.syncKnives(m.knives, now);
		this.syncBeacons(m.beacons ?? []);
		syncReloads(this.host.remotePlayers?.() ?? null, m);
	}

	/** Beacons from the state replace the local set (events keep it current in between). */
	private syncBeacons(list: readonly InfBeaconView[]): void {
		this.beacons.clear();
		for (const b of list) this.beacons.set(b.id, { id: b.id, ownerId: b.ownerId, x: b.x, y: b.y, z: b.z, yaw: b.yaw });
	}

	/** Drop every beacon (round reset, map switch). */
	private clearBeacons(): void {
		this.beacons.clear();
		this.beaconList.length = 0;
		this.hasBeacon = false;
	}

	/** My planted beacon, if any. */
	private myBeacon(): BeaconRenderPose | null {
		for (const b of this.beacons.values()) if (b.ownerId === this.me) return b;
		return null;
	}

	/** Knives from the state: add unknown ones, drop missing ones, snap only on a large error. */
	private syncKnives(list: readonly InfKnifeView[], now: number): void {
		const seen = new Set<number>();
		for (const k of list) {
			seen.add(k.id);
			const local = this.knives.get(k.id);
			if (!local || k.stuck !== local.stuck || Math.hypot(k.x - local.x, k.y - local.y, k.z - local.z) > KNIFE_SNAP_DIST) {
				this.knives.set(k.id, { ...k, at: now });
			}
		}
		for (const [id, k] of this.knives) if (!seen.has(id) && now - k.at > KNIFE_KEEP_MS) this.knives.delete(id);
	}

	/** Team/role change from the state (missed events): equip what the server says is held. */
	private setRole(team: InfTeam, alpha: boolean, weapon: WeaponId): void {
		this.team = team;
		this.alpha = team === 'infected' && alpha;
		if (team === 'infected') this.clearStreak();
		if (weapon === 'claws') this.holdClaws();
		else this.hold(this.slotFor(weapon));
	}

	/**
	 * The slot that holds `weapon` (knife → melee, pistol → secondary, else the
	 * primary), re-equipped with mode ammo when it held something else.
	 */
	private slotFor(weapon: WeaponId): WeaponState {
		const ws = weapon === 'knife' || weapon === 'claws' ? this.meleeWs : weapon === INF_SECONDARY ? this.secondaryWs : this.primaryWs;
		if (ws.weapon !== weapon) {
			ws.equip(weapon);
			limitAmmo(ws);
		}
		return ws;
	}

	/** Fresh pistol (the server hands out fresh guns: survivor round/join spawns, the Alpha of an older server). */
	private freshSecondary(): void {
		this.secondaryWs.equip(INF_SECONDARY);
		limitAmmo(this.secondaryWs);
	}

	/** Kill streak, perks and an uncalled M.O.A.B. end with the survivor life. */
	private clearStreak(): void {
		this.streak = 0;
		if (this.perks.length) this.perks = [];
		this.moabReady = false;
	}

	private holdClaws(): void {
		if (this.meleeWs.weapon !== 'claws') {
			this.meleeWs.equip('claws');
			if (this.ws === this.meleeWs) this.host.zombieRenderer()?.setWeapon('claws');
		}
		this.primaryWs.reloadEndsAt = 0;
		this.secondaryWs.reloadEndsAt = 0;
		this.hold(this.meleeWs);
	}

	/** Become an infected (in place): claws, throwing knife, infected HP. */
	private turn(now: number, text: string): void {
		this.team = 'infected';
		this.alpha = false;
		this.alive = true;
		this.hasKnife = true;
		this.knifeAt = now;
		this.hp = INF_INFECTED_HP;
		this.slowUntil = 0;
		this.clearStreak();
		this.holdClaws();
		this.flash = { text, at: now, tone: 'infected' };
	}

	onEvent(ev: InfEvent, now: number): void {
		if (!this.solo) this.apply(ev, now);
	}

	private name(id: number | null): string {
		if (id === null) return '';
		return id === this.me ? 'You' : this.host.name(id);
	}

	private line(text: string, mine: boolean, head: boolean, now: number): void {
		this.feed = pushKillFeed(this.feed, { id: ++this.feedId, text, head, mine, at: now }, now);
	}

	private apply(ev: InfEvent, now: number): void {
		const me = this.me;
		const r = this.host.zombieRenderer();
		this.fb.event(ev, now);
		switch (ev.e) {
			case 'phase':
				this.phase = ev.phase;
				this.round = ev.round;
				this.loadout = ev.loadout;
				if (this.state) this.state = { ...this.state, phase: ev.phase, round: ev.round, loadout: ev.loadout };
				// A round starts: the practice range closes before the server's spawn and ammo events apply.
				if (ev.phase !== 'waiting') this.endPractice();
				// The server drops a running M.O.A.B. on every phase change (no event for that).
				this.moab = null;
				if (ev.phase === 'grace') {
					this.moabDetonatedAt = 0;
					this.perkFlash = null;
					this.clearStreak();
					this.feed = [];
					this.summary = null;
					this.knives.clear();
					this.clearBeacons();
					this.nextBeaconAt = 0;
					this.uavAt = 0;
					this.uavDist = null;
					this.slowUntil = 0;
					this.slowStacks = 0;
					this.hurtAt = 0;
					this.hitMarker = null;
					this.timeBonusAt = 0;
					this.scavengerAt = 0;
					this.host.infectedRenderer()?.clear();
					r?.casings?.clear();
					// Everyone gets fresh guns.
					this.host.remotePlayers?.()?.stopReloads();
					this.flash = { text: `Round ${ev.round} · ${WEAPONS[ev.loadout].label} · find a holdout`, at: now, tone: 'survivor' };
					this.host.sound('round');
				} else if (ev.phase === 'playing') {
					if (!this.flash || now - this.flash.at > 200) this.flash = { text: 'Patient Zero is loose!', at: now, tone: 'infected' };
				} else if (ev.phase === 'waiting') {
					this.knives.clear();
					this.clearBeacons();
					this.host.remotePlayers?.()?.stopReloads();
					this.summary = null;
				} else if (ev.phase === 'ended') {
					this.knives.clear();
					this.clearBeacons();
				}
				break;
			case 'spawn': {
				if (ev.id !== me) break;
				this.host.teleport(ev.x, ev.y, ev.z, ev.yaw);
				this.hp = ev.hp;
				this.alive = true;
				this.respawnAt = 0;
				this.team = ev.team;
				this.alpha = ev.team === 'infected' && ev.alpha;
				this.hasKnife = ev.hasKnife;
				this.knifeAt = now;
				this.slowUntil = 0;
				this.leaveAim(true, now);
				this.aimT = 0;
				// A fall-out keeps the life (streak, perks, ammo); every other spawn starts a fresh one.
				if (ev.reason !== 'fall') this.clearStreak();
				// Fresh guns like the server: survivor round/join spawns, and every Alpha (re)spawn of an older server.
				if (ev.reason !== 'fall' && (ev.team === 'survivor' || ev.alpha)) this.freshSecondary();
				if (ev.weapon === 'claws') this.holdClaws();
				else {
					const ws = this.slotFor(ev.weapon);
					if (!ws.melee) {
						ws.mag = ev.mag;
						ws.reserve = ev.reserve;
						ws.reloadEndsAt = 0;
					}
					if (this.meleeWs.weapon !== 'knife' && this.team === 'survivor') this.meleeWs.equip('knife');
					this.hold(ws);
				}
				if (ev.reason === 'respawn') this.flash = { text: 'Respawned · hunt the survivors', at: now, tone: 'infected' };
				else if (ev.reason === 'beacon') {
					this.hasBeacon = false;
					this.flash = { text: 'Respawned at your beacon!', at: now, tone: 'bonus' };
				}
				r?.setWeapon(this.ws.weapon);
				break;
			}
			case 'alpha':
				if (ev.id === me) {
					this.team = 'infected';
					this.alpha = true;
					this.hasKnife = true;
					this.knifeAt = now;
					this.hp = INF_INFECTED_HP;
					this.clearStreak();
					this.freshSecondary();
					this.holdClaws();
					this.flash = { text: 'You are Patient Zero · infect a survivor', at: now, tone: 'infected' };
				} else {
					this.flash = { text: `${this.host.name(ev.id)} is Patient Zero · run!`, at: now, tone: 'survivor' };
				}
				this.line(`${this.name(ev.id)} · Patient Zero`, ev.id === me, false, now);
				this.host.sound('alpha');
				pickFeedback(this.host, ev, me, now);
				break;
			case 'infect': {
				if (ev.timeAdded > 0) {
					// The first infection: Patient Zero is one of many.
					this.alpha = false;
					this.timeBonusAt = now;
					if (this.endsAt > 0) this.endsAt += ev.timeAdded * 1000;
				}
				if (ev.id === me) {
					const by = ev.by === null ? null : this.host.name(ev.by);
					this.turn(now, by ? `Infected by ${by} · hunt the survivors` : 'You turned · hunt the survivors');
				} else if (ev.by === me) {
					this.flash = { text: `You infected ${this.host.name(ev.id)}`, at: now, tone: 'bonus' };
				}
				const victim = this.name(ev.id).replace(/^You$/, 'you');
				const by = ev.by === null ? null : this.name(ev.by);
				this.line(infectText(victim, by, ev.method), ev.by === me, false, now);
				if (by !== null && (ev.method === 'knife' || ev.method === 'bank')) this.feed[0]!.badge = { kind: ev.method, by, victim };
				turnFeedback(this.host, ev, me, now);
				break;
			}
			case 'hit':
				if (ev.by !== me) break;
				this.hitMarker = { at: now, head: ev.head, kill: ev.kill };
				hitFeedback(this.host, ev, now);
				break;
			case 'kill': {
				const victim = ev.targetId === me ? 'you' : this.host.name(ev.targetId);
				this.line(`${this.name(ev.by)} · ${WEAPONS[ev.weapon].label}${ev.head ? ' · headshot' : ''} › ${victim}`, ev.by === me, ev.head, now);
				// My survivor streak counts live (perk events and the state confirm it).
				if (ev.by === me && this.team === 'survivor') this.streak++;
				if (ev.targetId === me) {
					this.alive = false;
					this.respawnAt = now + INF_RESPAWN_SECS * 1000;
					this.fireHeld = false;
					this.leaveAim(true, now);
					this.flash = { text: `Killed by ${this.host.name(ev.by)} · respawning`, at: now, tone: 'infected' };
				}
				killFeedback(this.host, this.state, ev, me, this.viewId(), this.eye, this.roleOf(ev.targetId), now);
				break;
			}
			case 'shot':
				if (ev.by === me) break;
				shotFeedback(this.host, this.world, r, ev, now);
				this.host.sound(ev.weapon === 'knife' || ev.weapon === 'claws' ? ev.weapon : (`shot-${ev.weapon}` as InfSound), ev.o);
				break;
			case 'reload':
				// Mine already played in reload().
				if (ev.id !== me) reloadFeedback(this.host, ev, now);
				break;
			case 'hurt':
				if (ev.id !== me) break;
				this.hp = ev.hp;
				this.hurtAt = now;
				this.slowStacks = ev.stacks;
				this.slowUntil = now + ZM_SLOW_MS;
				this.host.push(ev.kx, ev.ky);
				this.host.sound('hurt');
				break;
			case 'ammo':
				if (ev.id !== me || !isWeaponId(ev.weapon)) break;
				if (ev.scavenger) {
					// Names the primary or the pistol even while another slot is held: a reserve refill only.
					const ws = ev.weapon === this.primaryWs.weapon ? this.primaryWs : ev.weapon === this.secondaryWs.weapon ? this.secondaryWs : null;
					if (ws) {
						ws.reserve = ev.reserve;
						if (this.ws === ws) ws.mag = ev.mag;
					}
					this.scavengerAt = now;
					break;
				}
				if (ev.weapon === 'claws') {
					// Infected in place, Patient Zero at the start, or a refused swing: the role is not decided here.
					this.team = 'infected';
					// Older servers: Patient Zero loses the gun and the role.
					if (this.meleeWs.weapon !== 'claws') this.alpha = false;
					this.clearStreak();
					this.holdClaws();
				} else {
					const ws = this.slotFor(ev.weapon);
					if (!ws.melee) {
						ws.mag = ev.mag;
						ws.reserve = ev.reserve;
					}
					if (this.meleeWs.weapon !== 'knife') this.meleeWs.equip('knife');
					// The ack of a swap I already moved on from only syncs that slot's ammo.
					if (this.swapSettled(ev.weapon, now)) this.hold(ws, now);
				}
				break;
			case 'knifeThrow':
				this.knives.set(ev.id, { id: ev.id, ownerId: ev.ownerId, x: ev.x, y: ev.y, z: ev.z, vx: ev.vx, vy: ev.vy, vz: ev.vz, pitch: 0, yaw: 0, stuck: false, at: now });
				if (ev.ownerId === me) {
					this.hasKnife = false;
					this.knifeAt = now;
				}
				break;
			case 'knifeBounce': {
				this.host.infectedRenderer()?.spark({ x: ev.x, y: ev.y, z: ev.z }, 'bounce', now, { x: ev.vx, y: ev.vy, z: ev.vz });
				this.host.sound('knifeBounce', { x: ev.x, y: ev.y, z: ev.z });
				const k = this.knives.get(ev.id);
				if (!k) break;
				Object.assign(k, { x: ev.x, y: ev.y, z: ev.z, vx: ev.vx, vy: ev.vy, vz: ev.vz, at: now });
				break;
			}
			case 'knifeStick': {
				const prev = this.knives.get(ev.id);
				// The glint backs out along the flight direction (unknown when the throw was missed).
				const dir = prev && !prev.stuck ? { x: prev.vx, y: prev.vy, z: prev.vz } : undefined;
				this.host.infectedRenderer()?.spark({ x: ev.x, y: ev.y, z: ev.z }, 'stick', now, dir);
				this.host.sound('knifeStick', { x: ev.x, y: ev.y, z: ev.z });
				const k = prev ?? { id: ev.id, ownerId: ev.ownerId, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0, stuck: true, at: now };
				Object.assign(k, { x: ev.x, y: ev.y, z: ev.z, vx: 0, vy: 0, vz: 0, pitch: ev.pitch, yaw: ev.yaw, stuck: true, at: now });
				this.knives.set(ev.id, k);
				break;
			}
			case 'knifePickup': {
				// Mine sounds without a position; another player's from where the knife lay.
				const k = this.knives.get(ev.id);
				if (ev.ownerId === me) this.host.sound('knifePickup');
				else if (k) this.host.sound('knifePickup', { x: k.x, y: k.y, z: k.z });
				this.knives.delete(ev.id);
				if (ev.ownerId === me) {
					this.hasKnife = true;
					this.knifeAt = now;
					this.flash = { text: 'Throwing knife retrieved', at: now, tone: 'infected' };
				}
				break;
			}
			case 'knifeRemove':
				this.knives.delete(ev.id);
				break;
			case 'beaconPlace':
				this.beacons.set(ev.id, { id: ev.id, ownerId: ev.ownerId, x: ev.x, y: ev.y, z: ev.z, yaw: ev.yaw });
				if (ev.ownerId === me) {
					this.hasBeacon = true;
					this.flash = { text: 'Respawn beacon planted', at: now, tone: 'bonus' };
					this.host.sound('beacon', { x: ev.x, y: ev.y, z: ev.z });
				}
				break;
			case 'beaconDestroy':
				this.beacons.delete(ev.id);
				// Cleanups (replaced, owner left, round over) vanish quietly; a smash bursts.
				if (ev.by === null) break;
				this.host.infectedRenderer()?.spark({ x: ev.x, y: ev.y, z: ev.z + INF_BEACON_HIT_Z }, 'beacon', now);
				this.host.sound('beaconSmash', { x: ev.x, y: ev.y, z: ev.z + INF_BEACON_HIT_Z });
				if (ev.by === me) {
					this.flash = { text: 'Beacon destroyed! +50', at: now, tone: 'survivor' };
					this.line(`You · Destroyed ${this.host.name(ev.ownerId)}'s beacon (+50)`, true, false, now);
				} else if (ev.ownerId === me) {
					this.hasBeacon = false;
					this.flash = { text: 'Your respawn beacon was destroyed!', at: now, tone: 'infected' };
				}
				break;
			case 'beaconUse':
				this.beacons.delete(ev.id);
				this.host.infectedRenderer()?.spark({ x: ev.x, y: ev.y, z: ev.z + INF_BEACON_HIT_Z }, 'beacon', now);
				this.host.sound('beaconUse', { x: ev.x, y: ev.y, z: ev.z + INF_BEACON_HIT_Z });
				if (ev.ownerId === me) {
					this.hasBeacon = false;
					this.flash = { text: 'Respawned at your beacon!', at: now, tone: 'bonus' };
				}
				break;
			case 'uav':
				this.uavAt = now;
				this.uavDist = this.team === 'infected' && this.eye ? Math.hypot(ev.x - this.eye.x, ev.y - this.eye.y, ev.z - this.eye.z) : null;
				if (this.team === 'infected') this.host.infectedRenderer()?.uavPulse({ x: ev.x, y: ev.y, z: ev.z }, now);
				if (this.team === 'infected' || ev.targetId === me) this.host.sound('uav');
				break;
			case 'perk':
				if (ev.id !== me) {
					if (ev.perk === 'specialist') this.line(`${this.host.name(ev.id)} · SPECIALIST`, false, false, now);
					break;
				}
				this.streak = Math.max(this.streak, ev.streak);
				this.perks = infPerksForStreak(this.streak);
				if (ev.perk === 'specialist') this.line('You · SPECIALIST (+250)', true, false, now);
				this.perkFlash = { perk: ev.perk, at: now };
				this.flash = { text: INF_PERK_INFO[ev.perk].toast, at: now, tone: ev.perk === 'specialist' ? 'bonus' : 'survivor' };
				this.host.sound('perk');
				break;
			case 'moabReady':
				if (ev.id !== me) break;
				this.moabReady = true;
				this.flash = { text: 'M.O.A.B. READY! Press [N] to call it in', at: now, tone: 'bonus' };
				this.host.sound('moabReady');
				break;
			case 'moabCall':
				this.moab = { callerId: ev.by, endsAt: now + ev.secs * 1000 };
				if (ev.by === me) this.moabReady = false;
				this.flash = { text: 'M.O.A.B. INBOUND!', at: now, tone: 'infected' };
				this.line(`${this.name(ev.by)} · called in a M.O.A.B.`, ev.by === me, false, now);
				this.host.sound('moab');
				break;
			case 'moabDetonate':
				this.moab = null;
				this.moabDetonatedAt = now;
				this.flash = { text: `M.O.A.B. DETONATED! ${ev.kills} eliminated`, at: now, tone: 'bonus' };
				this.line(`${this.name(ev.by)} · M.O.A.B. › ${ev.kills} infected`, ev.by === me, false, now);
				moabFeedback(this.host, this.state, this.viewId(), now);
				if (this.team === 'infected' && this.alive) {
					// Every living infected dies (the round ends right after).
					this.alive = false;
					this.respawnAt = now + INF_RESPAWN_SECS * 1000;
					this.fireHeld = false;
					this.leaveAim(true, now);
				}
				this.host.sound('moabDetonate');
				break;
			case 'end': {
				const top = ev.topId !== null ? `${this.name(ev.topId)} (${ev.topScore})` : null;
				this.summary = { winner: ev.winner, secs: ev.secs, survivorsLeft: ev.survivorsLeft, top };
				const won = (ev.winner === 'survivors') === (this.team === 'survivor');
				// A M.O.A.B. ends the round in the same flush: keep its detonation flash.
				if (!(this.moabDetonatedAt > 0 && now - this.moabDetonatedAt < FLASH_MS)) {
					this.flash = { text: ev.winner === 'survivors' ? 'Survivors held out!' : 'Everyone is infected!', at: now, tone: won ? 'bonus' : 'neutral' };
				}
				this.moab = null;
				this.knives.clear();
				this.clearBeacons();
				this.leaveAim(true, now);
				this.host.sound('round');
				break;
			}
		}
	}

	// ---------------------------------------------------------------------
	// Frame

	/** Knives this frame (stepped smoothly between server events). */
	knivesNow(): readonly KnifeRenderPose[] {
		return this.knifeList;
	}

	/** Step knives, draw them and the viewmodel; returns the HUD view (same object while nothing changed). */
	frame(now: number, viewmodel: boolean, speed: number): InfectedView {
		const dt = Math.max(0, Math.min(0.1, (now - this.lastFrame) / 1000));
		this.lastFrame = now;
		this.knifeList.length = 0;
		for (const k of this.knives.values()) {
			if (!k.stuck && dt > 0) stepKnife(k, dt);
			this.knifeList.push(k);
		}
		const ir = this.host.infectedRenderer();
		ir?.syncKnives(this.knifeList, this.me, now);
		this.beaconList.length = 0;
		for (const b of this.beacons.values()) this.beaconList.push(b);
		ir?.syncBeacons(this.beaconList, this.viewId(), this.viewTeam(), now);
		syncHeld(this.host.remotePlayers?.() ?? null, this.state, this.me);
		this.practice.frame();
		this.feelFrame(now, dt);
		const r = this.host.zombieRenderer();
		if (r) {
			r.setWeapon(this.ws.weapon);
			// Throwing knife ready in the left claw (back on pickup / respawn, gone on a throw).
			r.setOffhandKnife(this.team === 'infected' && this.ws.weapon === 'claws' && this.hasKnife && this.alive, now);
			// The rifles' viewmodel goes once the scope is fully up (the scope overlay takes over).
			const scopedIn = WEAPONS[this.ws.weapon].zoomFov !== null && ease(this.aimT) >= 1;
			r.updateViewmodel(now, viewmodel && !this.spectating && this.alive && !scopedIn, this.ws.reloadProgress(now), speed, this.vmFeel, this.ws.mag);
		}
		return this.buildView(now);
	}

	/** The player whose eyes the HUD and beacons follow (spectate target or me). */
	private viewId(): number {
		return this.spectating && this.specId !== null ? this.specId : this.me;
	}

	private viewTeam(): InfTeam {
		const id = this.viewId();
		if (id === this.me) return this.team;
		return this.state?.players.find((p) => p.id === id)?.team ?? 'survivor';
	}

	/** Metres from my feet to my planted beacon, null when none or my position is unknown. */
	private beaconDistance(): number | null {
		const f = this.feet;
		if (!this.hasBeacon || !f) return null;
		const b = this.myBeacon();
		if (!b) return null;
		return Math.round(Math.hypot(b.x - f.x, b.y - f.y, b.z - f.z) / UNITS_PER_M);
	}

	/** Beacons this frame (tests and debugging). */
	beaconsNow(): readonly BeaconRenderPose[] {
		return this.beaconList;
	}

	private lastSurvivor(): boolean {
		const s = this.state;
		return !!s && this.playing && this.team === 'survivor' && this.alive && s.survivors === 1 && s.infected >= 2;
	}

	private buildView(now: number): InfectedView {
		const s = this.state;
		const ws = this.ws;
		const reloading = ws.reloading(now);
		if (this.hitMarker && now - this.hitMarker.at > HIT_MS) this.hitMarker = null;
		if (this.flash && now - this.flash.at > FLASH_MS) this.flash = null;
		const feed = liveKillFeed(this.feed, now);
		if (feed.length !== this.feed.length) this.feed = feed;
		let knifeOut = false;
		if (!this.hasKnife) for (const k of this.knives.values()) if (k.ownerId === this.me) knifeOut = true;
		const me = s?.players.find((p) => p.id === this.me);
		const hasBeacon = this.team === 'infected' && this.hasBeacon;
		const beaconDist = hasBeacon ? this.beaconDistance() : null;
		const key = [
			this.phase,
			this.round,
			this.stateAt,
			this.endsAt,
			this.team,
			this.alpha,
			this.hp,
			this.alive,
			this.respawnAt,
			ws.weapon,
			ws.mag,
			ws.reserve,
			reloading,
			this.hasKnife,
			knifeOut,
			hasBeacon,
			beaconDist,
			this.hitMarker?.at,
			this.feed.length && this.feed[0]!.id,
			this.feed.length,
			this.flash?.at,
			this.timeBonusAt,
			this.scavengerAt,
			this.hurtAt,
			this.uavAt,
			this.scoped,
			this.aimView(),
			this.scopeView(),
			this.spreadView(),
			this.summary ? 1 : 0,
			this.spectating,
			this.specId,
			this.secondaryWs.mag,
			this.secondaryWs.reserve,
			this.streak,
			this.perks.join(','),
			this.moabReady,
			this.moab?.callerId,
			this.moab?.endsAt,
			this.moabDetonatedAt,
			this.perkFlash?.at,
			this.fb.frame(now, this.viewYaw),
			this.primaryWs.mag,
			this.primaryWs.reserve,
			this.practice.active,
			this.primaryWs.weapon
		].join('|');
		if (key === this.viewKey && this.view) return this.view;
		this.viewKey = key;
		const def = WEAPONS[ws.weapon];
		const practice = this.practice.active;
		// Practice range: slot 1 names the gun being tried, not the round's.
		const loadout = practice ? this.primaryWs.weapon : this.loadout;
		this.view = {
			phase: this.phase,
			round: this.round,
			endsAt: this.phase === 'waiting' || this.phase === 'solo' ? 0 : this.endsAt,
			team: this.team,
			alpha: this.alpha,
			lastSurvivor: this.lastSurvivor(),
			loadout,
			loadoutLabel: WEAPONS[loadout].label,
			survivors: s?.survivors ?? 0,
			infected: s?.infected ?? 0,
			hp: this.hp,
			maxHp: infMaxHp(this.team),
			alive: this.alive,
			respawnAt: this.alive ? 0 : this.respawnAt,
			weapon: ws.weapon,
			weaponLabel: def.label,
			mag: ws.mag,
			magSize: def.magazine,
			reserve: ws.reserve,
			reloadEndsAt: reloading ? ws.reloadEndsAt : 0,
			reloadMs: reloading && ws.reloadDurationMs > 0 ? ws.reloadDurationMs : def.reloadMs,
			hasKnife: this.team === 'infected' && this.hasKnife,
			knifeOut,
			hasBeacon,
			beaconDist,
			myScore: me?.score ?? 0,
			myKills: me?.kills ?? 0,
			myDeaths: me?.deaths ?? 0,
			hitMarker: this.hitMarker,
			killFeed: this.feed,
			flash: this.flash,
			timeBonusAt: this.timeBonusAt,
			scavengerAt: this.scavengerAt,
			hurtAt: this.hurtAt,
			uavAt: this.uavAt,
			scoped: this.scoped,
			scopeT: this.scopeView(),
			aimT: this.aimView(),
			spreadDeg: this.spreadView(),
			summary: this.summary,
			spectating: this.spectating,
			spec: this.specView(),
			uavDist: this.uavDist,
			secondary: this.secondaryWs.weapon,
			secondaryLabel: WEAPONS[this.secondaryWs.weapon].label,
			streak: this.team === 'survivor' ? this.streak : 0,
			perks: this.team === 'survivor' ? this.perks : [],
			moabReady: this.team === 'survivor' && this.moabReady,
			moab: this.moab ? { callerName: this.name(this.moab.callerId), endsAt: this.moab.endsAt } : null,
			moabDetonatedAt: this.moabDetonatedAt,
			perkFlash: this.perkFlash,
			scorePops: this.fb.scorePops,
			hurtDirs: this.fb.hurtDirs,
			summaryRows: this.summary ? this.fb.summaryRows : null,
			nextLoadoutLabel: this.summary ? this.fb.nextLoadoutLabel : null,
			focusId: this.viewId(),
			slotAmmo: [this.primaryWs.mag + this.primaryWs.reserve, this.secondaryWs.mag + this.secondaryWs.reserve],
			practice
		};
		return this.view;
	}

	/** The spectated player from the latest state (null in free-fly or when unknown). */
	private specView(): InfSpecView | null {
		const id = this.specId;
		if (id === null || id === this.me) return null;
		const p = this.state?.players.find((q) => q.id === id);
		if (!p) return null;
		return {
			id,
			name: this.host.name(id),
			team: p.team,
			alpha: p.team === 'infected' && p.alpha,
			hp: p.hp,
			maxHp: infMaxHp(p.team),
			alive: p.alive,
			score: p.score,
			weapon: p.weapon,
			weaponLabel: WEAPONS[p.weapon].label,
			hasKnife: p.team === 'infected' && p.hasKnife,
			hasBeacon: p.team === 'infected' && p.hasBeacon,
			streak: p.team === 'survivor' ? p.streak : 0,
			perks: p.team === 'survivor' ? [...p.perks] : [],
			moabReady: p.team === 'survivor' && p.moabReady
		};
	}

	/** Solo scoreboard row values. */
	soloRow(): { kills: number; deaths: number; score: number } {
		return { kills: 0, deaths: 0, score: 0 };
	}

	dispose(): void {
		this.practice.stop();
		this.leaveAim(true);
		this.knives.clear();
		this.knifeList.length = 0;
		this.clearBeacons();
		this.host.zombieRenderer()?.setOffhandKnife(false);
		this.host.infectedRenderer()?.clear();
		this.host.zombieRenderer()?.clear();
	}
}

