/** Infected on the client (docs/modes.md#infected): InfectedClient behind ClientMode. */
import {
	clampInfVelocity,
	eyeHeight,
	randomSpawn,
	Status,
	SURF_CVARS,
	tagSpawns,
	type Cvars,
	type NetState,
	type ScoreRow,
	type Vec3
} from '@surf/shared';
import type { CaseKind } from '../../render/casings.js';
import type { AvatarPose, RemotePlayers } from '../../render/players.js';
import { addKnockback, zoomFov } from '../gunfeel.js';
import { InfectedClient, type InfHost } from '../infected.js';
import { soundListener, soundSource } from '../infected-listener.js';
import type { ClientMode, ClientModeHost, ModeCommand, ModeServerMessage, ModeView, RemotePlayer } from './types.js';

export class InfectedMode implements ClientMode {
	readonly id = 'infected';
	readonly client: InfectedClient;
	/** Scope and view recoil, as the client reports them. */
	readonly view: Readonly<ModeView>;
	/** Physics cvars with the held weapon's max speed. */
	private readonly sv: Cvars = { ...SURF_CVARS };

	constructor(private readonly host: ClientModeHost) {
		const view: ModeView = { zoomFov: 0, zoomT: 0, kickPitch: 0, kickYaw: 0, kickRoll: 0 };
		this.view = view;
		const inf: InfHost = {
			online: () => host.online,
			selfId: () => host.selfId,
			send: (msg) => host.send(msg),
			zombieRenderer: () => host.renderer?.zombies ?? null,
			infectedRenderer: () => host.renderer?.infected ?? null,
			remotePlayers: () => host.renderer?.players ?? null,
			name: (id) => host.name(id),
			notice: (text) => host.notice(text),
			teleport: (x, y, z, yaw) => host.teleport({ pos: { x, y, z }, yaw }),
			// Heard from the camera: the spectator camera while spectating (infected-listener.ts).
			sound: (name, at) => host.audio.infected(name, soundSource(at, host.spec, host.remotes), soundListener(host.spec, host.eye), host.yaw),
			// The zoom eases: the camera follows `zoomProgress` every frame instead of snapping here.
			setZoom: () => {},
			// Knockback is an impulse on top of the player's velocity, capped along the hit (gunfeel.ts).
			push: (vx, vy) => addKnockback(host.player.velocity, vx, vy),
			zoomProgress: (fov, t) => {
				view.zoomFov = fov;
				view.zoomT = t;
				host.renderer?.setFov(zoomFov(host.cvar('fov'), fov, t));
			},
			setViewKick: (pitch, yaw, roll) => {
				view.kickPitch = pitch;
				view.kickYaw = yaw;
				view.kickRoll = roll;
			},
			spawns: () => tagSpawns(host.map)
		};
		const now = performance.now();
		this.client = new InfectedClient(inf, now, host.world);
		host.hud.infected = this.client.frame(now, false, 0);
	}

	// ---------------------------------------------------------------------
	// Input

	press(action: 'attack' | 'attack2', down: boolean, now: number): void {
		this.client.press(action, down, now);
	}

	/** The trigger and a held aim let go with the button; a toggled aim stays. */
	release(now: number): void {
		this.client.press('attack', false, now);
		this.client.press('attack2', false, now);
	}

	slot(n: number, now: number): boolean {
		return this.client.slot(n, now);
	}

	command(cmd: ModeCommand, now: number): void {
		if (cmd === 'beacon') this.client.placeBeacon(now);
		else this.client.callMoab(now);
	}

	/** R reloads the primary or the pistol. */
	restart(now: number): void {
		this.client.reload(now);
	}

	/** Solo (and while the server waits for players) respawns, not a spectator; online rounds restart by themselves. */
	chatRestart(): void {
		if (this.client.localFallouts) {
			if (!this.host.spec) this.respawn();
		} else this.host.notice('Infected rounds restart by themselves (Esc › Servers to change map).');
	}

	respawn(): void {
		this.host.teleport(randomSpawn(this.host.map));
	}

	// ---------------------------------------------------------------------
	// Simulation

	/** Weapon (or claws) move speed; no movement while down. */
	moveCvars(end: number): Cvars | null {
		if (this.client.down) return null;
		Object.assign(this.sv, this.host.sv);
		this.sv.sv_maxspeed = this.client.maxSpeed(end);
		return this.sv;
	}

	tick(_now: number, end: number): void {
		const { player: p, pitch, yaw } = this.host;
		this.client.tick(end, p.origin, p.origin.z + eyeHeight(p), pitch, yaw, p.ducked, p.velocity, p.onGround);
		// No server round (solo / waiting): fall-outs respawn locally.
		if (this.client.localFallouts) this.host.teleportZones(() => randomSpawn(this.host.map));
	}

	netState(s: NetState): void {
		s.status = this.client.isAlpha ? Status.Alpha : this.client.isInfected ? Status.Infected : Status.Alive;
		s.stage = 0;
		s.runTicks = 0;
	}

	// ---------------------------------------------------------------------
	// Frame

	frame(now: number): void {
		const h = this.host;
		const c = this.client;
		// Spectating: the HUD shows the target, local viewmodel and input are off.
		c.setSpectate(!!h.spec, h.spec && !h.spec.freeFly ? h.viewId : null);
		c.viewYaw = h.yaw;
		// Aim down sights: the FOV it magnifies and whether Mouse2 holds or toggles it.
		c.fov = h.cvar('fov');
		c.aimToggle = h.cvar('cl_aimtoggle') !== 0;
		const v = c.frame(now, !h.spec, Math.hypot(h.player.velocity.x, h.player.velocity.y));
		if (h.hud.infected !== v) h.hud.infected = v;
	}

	isDown(id: number): boolean {
		return this.client.isDown(id);
	}

	/** As the server poses the hit body (a false claim moves both no further than the mode allows). */
	adjustPose(pose: AvatarPose): void {
		clampInfVelocity(pose);
	}

	/** What its players hold is set by the client (infected-feedback.ts syncHeld). */
	dress(players: RemotePlayers, p: RemotePlayer, _visible: boolean, now: number): void {
		players.setInfected(p.id, this.client.roleOf(p.id), now);
	}

	caseLanded(kind: CaseKind, at: Vec3): void {
		const h = this.host;
		h.audio.infected(kind === 'shell' ? 'shell' : 'casing', at, soundListener(h.spec, h.eye), h.yaw);
	}

	// ---------------------------------------------------------------------
	// Solo scoreboard

	soloRow(): Partial<ScoreRow> {
		const z = this.client.soloRow();
		return { status: Status.Alive, kills: z.kills, deaths: z.deaths, score: z.score, it: undefined };
	}

	// ---------------------------------------------------------------------
	// Network

	message(m: ModeServerMessage, now: number): void {
		if (m.type === 'modeState') {
			if (m.mode === 'infected') this.client.onModeState(m, now);
		} else if (m.type === 'inf') this.client.onEvent(m.ev, now); // shots move the avatars too (infected-feedback.ts shotFeedback)
	}

	dispose(): void {
		this.client.dispose();
		this.host.renderer?.setFov(this.host.cvar('fov'));
		this.host.hud.infected = null;
	}
}
