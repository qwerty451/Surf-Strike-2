/** Zombie Defense on the client (docs/modes.md#zombie-defense): DefenseClient behind ClientMode. */
import { eyeHeight, Status, SURF_CVARS, type Cvars, type DefenseFrame, type ModeState, type NetState, type ScoreRow, type Vec3 } from '@surf/shared';
import type { CaseKind } from '../../render/casings.js';
import type { RemotePlayers } from '../../render/players.js';
import { DefenseClient, type DfHost } from '../defense.js';
import { soundListener, soundSource } from '../infected-listener.js';
import type { ClientMode, ClientModeHost, ModeCommand, ModeServerMessage, ModeUiAction, RemotePlayer } from './types.js';

export class DefenseMode implements ClientMode {
	readonly id = 'defense';
	readonly client: DefenseClient;
	scopeFov: number | null = null;
	/** Physics cvars with the held weapon's max speed. */
	private readonly sv: Cvars = { ...SURF_CVARS };

	constructor(private readonly host: ClientModeHost) {
		const df: DfHost = {
			online: () => host.online,
			selfId: () => host.selfId,
			send: (msg) => host.send(msg),
			zombieRenderer: () => host.renderer?.zombies ?? null,
			defenseRenderer: () => host.renderer?.defense ?? null,
			name: (id) => (host.online ? host.name(id) : host.myName()),
			notice: (text) => host.notice(text),
			teleport: (x, y, z, yaw) => host.teleport({ pos: { x, y, z }, yaw }),
			voteOpen: () => host.voteOpen,
			// Existing recordings through the infected names; heard from the camera (infected-listener.ts).
			sound: (name, at) => host.audio.infected(name, soundSource(at, host.spec, host.remotes), soundListener(host.spec, host.eye), host.yaw),
			setZoom: (fov) => {
				this.scopeFov = fov;
				host.renderer?.setFov(fov ?? host.cvar('fov'));
			}
		};
		const now = performance.now();
		this.client = new DefenseClient(df, host.map, host.sv, now);
		// Boarded openings are solid for the local player too.
		host.setWorld(this.client.world);
		host.hud.defense = this.client.frame(now, false, 0);
	}

	// ---------------------------------------------------------------------
	// Input

	press(action: 'attack' | 'attack2', down: boolean, now: number): void {
		this.client.press(action, down, now);
	}

	release(now: number): void {
		this.client.release(now);
	}

	slot(n: number, now: number): boolean {
		return this.client.slot(n, now);
	}

	command(cmd: ModeCommand, now: number): void {
		if (cmd === 'beacon') this.client.use(now);
		else if (cmd === 'shop') this.client.shop(now);
		else if (cmd === 'ready') this.client.ready(now);
		this.publish(now);
	}

	commandUp(cmd: ModeCommand, now: number): void {
		if (cmd === 'beacon') this.client.useUp(now);
	}

	ui(a: ModeUiAction, now: number): void {
		if (a.kind === 'close') this.client.closeMenu();
		else this.client.pick(a.index, now);
		this.publish(now);
	}

	/** R reloads (chat `!r` restarts in solo). */
	restart(now: number): void {
		this.client.reload(now);
	}

	chatRestart(now: number): void {
		this.client.chatRestart(now);
		// Solo: the new game has barricades of its own.
		this.host.setWorld(this.client.world);
	}

	respawn(): void {
		this.host.teleport(this.host.map.spawn);
	}

	// ---------------------------------------------------------------------
	// Simulation

	/** Weapon move speed; no movement while dead or waiting for the next build phase. */
	moveCvars(): Cvars | null {
		if (!this.client.alive) return null;
		Object.assign(this.sv, this.host.sv);
		this.sv.sv_maxspeed = this.client.maxSpeed();
		return this.sv;
	}

	tick(_now: number, end: number): void {
		const { player: p, pitch, yaw } = this.host;
		this.client.tick(end, p.origin, p.origin.z + eyeHeight(p), pitch, yaw, p.ducked);
	}

	netState(s: NetState): void {
		s.status = this.client.alive ? Status.Alive : Status.Down;
		s.stage = 0;
		s.runTicks = 0;
	}

	// ---------------------------------------------------------------------
	// Frame

	private publish(now: number): void {
		const { hud, player, spec } = this.host;
		const v = this.client.frame(now, !spec, Math.hypot(player.velocity.x, player.velocity.y));
		if (hud.defense !== v) hud.defense = v;
	}

	frame(now: number): void {
		this.publish(now);
	}

	isDown(id: number): boolean {
		return this.client.isDown(id);
	}

	dress(players: RemotePlayers, p: RemotePlayer): void {
		players.setHeld(p.id, this.client.heldOf(p.id));
	}

	caseLanded(kind: CaseKind, at: Vec3): void {
		const h = this.host;
		h.audio.infected(kind === 'shell' ? 'shell' : 'casing', at, soundListener(h.spec, h.eye), h.yaw);
	}

	// ---------------------------------------------------------------------
	// Solo scoreboard

	soloRow(): Partial<ScoreRow> {
		const z = this.client.soloRow();
		return {
			status: z.status === 'alive' ? Status.Alive : z.status === 'dead' ? Status.Down : Status.Idle,
			kills: z.kills,
			deaths: z.deaths,
			score: z.gold,
			it: undefined
		};
	}

	soloState(): ModeState | null {
		const s = this.client.soloState();
		return s && { mode: 'defense', ...s };
	}

	// ---------------------------------------------------------------------
	// Network

	message(m: ModeServerMessage, now: number): void {
		if (m.type === 'modeState') {
			if (m.mode === 'defense') this.client.onModeState(m, now);
		} else if (m.type === 'zd') {
			const ev = m.ev;
			this.client.onEvent(ev, now);
			if (ev.e === 'shot') this.host.avatarAct(ev.by, 'fire');
		}
	}

	defense(f: DefenseFrame, arrival: number): void {
		this.client.onFrame(f, arrival);
	}

	dispose(): void {
		this.client.dispose();
		this.host.hud.defense = null;
	}
}
