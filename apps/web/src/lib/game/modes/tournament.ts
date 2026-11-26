/** Tournament on the client (docs/modes.md#tournament): `TournamentClient` as a `ClientMode`. */
import { eyeHeight, Status, type Cvars, type GameModeId, type MapDef, type NetState, type ScoreRow, type Spawn } from '@surf/shared';
import type { RemotePlayers } from '../../render/players.js';
import { zoomFov } from '../gunfeel.js';
import { soundListener, soundSource } from '../infected-listener.js';
import { TournamentClient, type TrnHost } from '../tournament.js';
import type { ClientMode, ClientModeHost, ModeServerMessage, ModeView, RemotePlayer } from './types.js';

/** A spread-out deck spawn (fall-outs offline, before the server places me). */
export function deckSpawn(map: MapDef, rng: () => number = Math.random): Spawn {
	const list = map.tournament?.deckSpawns ?? [];
	if (list.length === 0) return map.spawn;
	return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;
}

export class TournamentMode implements ClientMode {
	readonly id: GameModeId = 'tournament';
	readonly client: TournamentClient;
	readonly view: Readonly<ModeView>;
	private readonly sv: Cvars;

	constructor(private readonly host: ClientModeHost) {
		const view: ModeView = { zoomFov: 0, zoomT: 0, kickPitch: 0, kickYaw: 0, kickRoll: 0 };
		this.view = view;
		this.sv = { ...host.sv };
		const trn: TrnHost = {
			online: () => host.online,
			selfId: () => host.selfId,
			send: (msg) => host.send(msg),
			name: (id) => host.name(id),
			teleport: (pos, yaw) => host.teleport({ pos, yaw }),
			loggedIn: () => host.hud.account !== null,
			zombieRenderer: () => host.renderer?.zombies ?? null,
			infectedRenderer: () => host.renderer?.infected ?? null,
			remotePlayers: () => host.renderer?.players ?? null,
			sound: (name, at) => host.audio.infected(name, soundSource(at, host.spec, host.remotes), soundListener(host.spec, host.eye), host.yaw),
			zoomProgress: (fov, t) => {
				view.zoomFov = t > 0 ? fov : 0;
				view.zoomT = t;
				host.renderer?.setFov(zoomFov(host.cvar('fov'), fov, t));
			},
			viewId: () => host.viewId
		};
		const now = performance.now();
		this.client = new TournamentClient(trn, now, host.world);
		host.hud.tournament = this.client.frame(now, false, 0);
	}

	// Input

	press(action: 'attack' | 'attack2', down: boolean, now: number): void {
		this.client.press(action, down, now);
	}

	release(now: number): void {
		this.client.release(now);
	}

	/** Duelists swap weapons; spectators may bet with 1 / 2 while betting is open. */
	slot(n: number, now: number): boolean {
		return this.client.slot(n, now);
	}

	bet(pick: number): void {
		this.client.bet(pick);
	}

	/** R reloads the held gun. */
	restart(now: number): void {
		this.client.reload(now);
	}

	/** `!r`: free roam only; the server places everyone during a tournament. */
	chatRestart(): void {
		if (this.client.localFallouts) {
			if (!this.host.spec) this.respawn();
		} else this.host.notice('The tournament places players by itself.');
	}

	respawn(): void {
		this.host.teleport(deckSpawn(this.host.map));
	}

	// Simulation

	/** Frozen (spawn freeze) or dead: no movement. Else the held weapon's speed. */
	moveCvars(end: number): Cvars | null {
		if (this.client.down || this.client.frozen(end)) {
			const v = this.host.player.velocity;
			v.x = v.y = 0;
			if (v.z > 0) v.z = 0;
			return null;
		}
		Object.assign(this.sv, this.host.sv);
		this.sv.sv_maxspeed = Math.min(this.host.sv.sv_maxspeed, this.client.maxSpeed());
		return this.sv;
	}

	tick(_now: number, end: number): void {
		const { player: p, pitch, yaw } = this.host;
		this.client.tick(end, { x: p.origin.x, y: p.origin.y, z: p.origin.z + eyeHeight(p) }, pitch, yaw);
		// No server round: fall-outs respawn on the deck locally.
		if (this.client.localFallouts) this.host.teleportZones(() => deckSpawn(this.host.map));
	}

	netState(s: NetState): void {
		s.status = this.client.myRole === 'duelist' ? Status.Alive : Status.Idle;
		s.stage = 0;
		s.runTicks = 0;
	}

	// Frame

	frame(now: number): void {
		const h = this.host;
		const c = this.client;
		c.setSpectate(!!h.spec, h.spec && !h.spec.freeFly ? h.viewId : null);
		c.fov = h.cvar('fov');
		c.aimToggle = h.cvar('cl_aimtoggle') !== 0;
		const v = c.frame(now, !h.spec, Math.hypot(h.player.velocity.x, h.player.velocity.y));
		if (h.hud.tournament !== v) h.hud.tournament = v;
	}

	isDown(id: number): boolean {
		return this.client.isDown(id);
	}

	/** Duelists hold the gun they last fired, everyone on the deck the knife. */
	dress(players: RemotePlayers, p: RemotePlayer): void {
		players.setHeld(p.id, this.client.heldOf(p.id));
	}

	soloRow(): Partial<ScoreRow> {
		return { status: Status.Spectating, kills: 0, score: 0, it: undefined };
	}

	message(m: ModeServerMessage, now: number): void {
		if (m.type === 'modeState') {
			if (m.mode === 'tournament') this.client.onModeState(m, now);
		} else if (m.type === 'trn') this.client.onEvent(m.ev, now);
	}

	dispose(): void {
		this.client.dispose();
		this.host.renderer?.setFov(this.host.cvar('fov'));
		this.host.hud.tournament = null;
	}
}
