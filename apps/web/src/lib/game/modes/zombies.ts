/** Zombie Run on the client (docs/modes.md#zombies): ZombiesClient behind ClientMode. */
import {
	eyeHeight,
	randomSpawn,
	Status,
	SURF_CVARS,
	type Cvars,
	type ModeState,
	type NetState,
	type ScoreRow,
	type Vec3,
	type ZombieFrame
} from '@surf/shared';
import type { CaseKind } from '../../render/casings.js';
import type { RemotePlayers } from '../../render/players.js';
import { soundListener, soundSource } from '../infected-listener.js';
import { ZombiesClient, type ZmHost } from '../zombies.js';
import type { ClientMode, ClientModeHost, ModeServerMessage, RemotePlayer } from './types.js';

export class ZombiesMode implements ClientMode {
	readonly id = 'zombies';
	readonly client: ZombiesClient;
	scopeFov: number | null = null;
	/** Physics cvars with the held weapon's max speed. */
	private readonly sv: Cvars = { ...SURF_CVARS };

	constructor(private readonly host: ClientModeHost) {
		const zm: ZmHost = {
			online: () => host.online,
			selfId: () => host.selfId,
			send: (msg) => host.send(msg),
			zombieRenderer: () => host.renderer?.zombies ?? null,
			name: (id) => (host.online ? host.name(id) : host.myName()),
			notice: (text) => host.notice(text),
			teleport: (x, y, z, yaw) => host.teleport({ pos: { x, y, z }, yaw }),
			// Heard from the camera: the spectator camera while spectating (infected-listener.ts).
			sound: (name, at) => host.audio.zombies(name, soundSource(at, host.spec, host.remotes), soundListener(host.spec, host.eye), host.yaw),
			setZoom: (fov) => {
				this.scopeFov = fov;
				host.renderer?.setFov(fov ?? host.cvar('fov'));
			},
			push: (vx, vy) => {
				host.player.velocity.x = vx;
				host.player.velocity.y = vy;
			}
		};
		const now = performance.now();
		this.client = new ZombiesClient(zm, host.map, host.sv, now);
		// Closed gates are solid for the local player too.
		host.setWorld(this.client.world);
		host.hud.zombies = this.client.frame(now, false, 0);
	}

	// ---------------------------------------------------------------------
	// Input

	press(action: 'attack' | 'attack2', down: boolean, now: number): void {
		this.client.press(action, down, now);
	}

	/** The trigger lets go with the button. */
	release(now: number): void {
		this.client.press('attack', false, now);
	}

	slot(n: number, now: number): boolean {
		return this.client.slot(n, now);
	}

	/** R reloads (chat `!r` restarts). */
	restart(now: number): void {
		this.client.reload(now);
	}

	chatRestart(now: number): void {
		this.client.chatRestart(now);
		// Solo: the new round has gates of its own.
		this.host.setWorld(this.client.world);
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
		this.client.tick(end, p.origin, p.origin.z + eyeHeight(p), pitch, yaw, p.ducked);
	}

	netState(s: NetState): void {
		s.status = this.client.down ? Status.Down : Status.Alive;
		s.stage = 0;
		s.runTicks = 0;
	}

	// ---------------------------------------------------------------------
	// Frame

	frame(now: number): void {
		const { hud, player, spec, renderServerTimeMs } = this.host;
		const v = this.client.frame(now, !spec, Math.hypot(player.velocity.x, player.velocity.y), renderServerTimeMs || undefined);
		if (hud.zombies !== v) hud.zombies = v;
	}

	isDown(id: number): boolean {
		return this.client.isDown(id);
	}

	dress(players: RemotePlayers, p: RemotePlayer): void {
		players.setHeld(p.id, this.client.heldOf(p.id));
		players.setZombie(p.id, this.client.isZombiePlayer(p.id));
	}

	caseLanded(kind: CaseKind, at: Vec3): void {
		const h = this.host;
		h.audio.zombies(kind === 'shell' ? 'shell' : 'casing', at, soundListener(h.spec, h.eye), h.yaw);
	}

	// ---------------------------------------------------------------------
	// Solo scoreboard

	soloRow(): Partial<ScoreRow> {
		const z = this.client.soloRow();
		return { status: z.alive ? Status.Alive : Status.Down, kills: z.kills, deaths: z.deaths, score: undefined, it: undefined };
	}

	soloState(): ModeState | null {
		const s = this.client.soloState();
		return s && { mode: 'zombies', ...s };
	}

	// ---------------------------------------------------------------------
	// Network

	message(m: ModeServerMessage, now: number): void {
		if (m.type === 'modeState') {
			if (m.mode === 'zombies') this.client.onModeState(m, now);
		} else if (m.type === 'zm') {
			const ev = m.ev;
			this.client.onEvent(ev, now);
			if (ev.e === 'shot') this.host.avatarAct(ev.by, ev.weapon === 'knife' || ev.weapon === 'claws' ? 'swing' : 'fire');
		}
	}

	zombies(f: ZombieFrame, arrival: number): void {
		this.client.onZombies(f, arrival);
	}

	dispose(): void {
		this.client.dispose();
		this.host.hud.zombies = null;
	}
}
