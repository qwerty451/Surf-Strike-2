/**
 * Client gamemode modules (docs/modes.md), the client side of the server's
 * `ServerMode`. game.ts owns the player, camera, input, network, remote
 * players and the HUD shared by all modes; everything a gamemode decides lives
 * behind `ClientMode`. One instance per map. The game replaces it on a map
 * change, and on a disconnect unless the mode adapts in place (`offline`).
 */
import type {
	ClientMessage,
	CollisionWorld,
	Cvars,
	DefenseFrame,
	GameModeId,
	GhostFrame,
	Loadout,
	MapDef,
	ModeState,
	NetState,
	PlayerState,
	RunState,
	ScoreRow,
	ServerMessage,
	Spawn,
	Vec3,
	ZombieFrame
} from '@surf/shared';
import type { GameAudio } from '../../audio/audio.js';
import type { Sample } from '../../net/interp.js';
import type { AvatarPose, RemotePlayers } from '../../render/players.js';
import type { GameRenderer } from '../../render/renderer.js';
import type { CaseKind } from '../../render/casings.js';
import type { HudStateShape } from '../contract.js';
import type { GhostStore } from '../ghost-store.js';
import type { SpecCamera } from '../infected-listener.js';

/** A remote player as the game keeps it; `sample` is the one drawn this frame. */
export interface RemotePlayer {
	readonly id: number;
	readonly name: string;
	readonly spectating: boolean;
	readonly sample: Sample;
	readonly hasSample: boolean;
}

/** Personal best of the local player on this map (online: the account's, solo: this browser's). */
export interface LocalBest {
	ticks: number | null;
	splits: number[] | null;
}

/** What the game gives a mode. Plain members are live: read them when needed, do not copy them at construction. */
export interface ClientModeHost {
	readonly map: MapDef;
	/** Physics cvars of this map (solo: the player can change them). */
	readonly sv: Cvars;
	/** World the local player moves in: the map's, or the one the mode set. */
	readonly world: CollisionWorld;
	readonly player: PlayerState;
	/** Simulation tick being run, and the render fraction between the last two ticks (0..1). */
	readonly tick: number;
	readonly alpha: number;
	/** View angles (degrees). */
	readonly pitch: number;
	readonly yaw: number;
	/** My eye at the newest tick. Not the camera: that is `spec.pos` while spectating. */
	readonly eye: Vec3;
	readonly spec: SpecCamera | null;
	readonly remotes: ReadonlyMap<number, RemotePlayer>;
	readonly hud: HudStateShape;
	readonly audio: GameAudio;
	/** Null without WebGL. */
	readonly renderer: GameRenderer | null;
	readonly online: boolean;
	/** −1 offline. */
	readonly selfId: number;
	/** Current adaptive remote interpolation delay (ms); hook for client-render-time lag compensation. */
	readonly interpDelayMs: number;
	/** Server monotonic time (ms) currently rendered for remote players (`serverClock - interpDelayMs`). */
	readonly renderServerTimeMs: number;
	/** The spectated player (not in free-fly), else me: whose role the HUD shows. */
	readonly viewId: number;
	/** A map vote is open. */
	readonly voteOpen: boolean;
	cvar(name: string): number;
	myName(): string;
	/** Name of any player, me included. */
	name(id: number): string;
	/** Dropped offline. */
	send(msg: ClientMessage): void;
	notice(text: string): void;
	print(text: string, kind?: 'output' | 'error'): void;
	setAngles(pitch: number, yaw: number): void;
	/** Put the player at a spawn, standing still, the view turned with it, as a teleport (nothing interpolates across it). */
	teleport(s: Spawn): void;
	/** The local player moves in this world from now on, instead of the map's (zombies: closed gates are solid). */
	setWorld(world: CollisionWorld): void;
	/** The player was moved by the mode inside a tick: flag it as a teleport, snap the eye at the end of the tick. */
	movedInTick(): void;
	/** The player was moved by the mode outside a tick (restart): flag it as a teleport and snap the eye now. */
	moved(): void;
	/** Teleport zones for modes without a run tracker: move a player in one to its `dest`, else to `spawn()`. */
	teleportZones(spawn: () => Spawn): void;
	/** Third-person recoil or swing of a remote player. */
	avatarAct(id: number, action: 'fire' | 'swing'): void;
	/** Normal of the surf ramp an airborne hull at feet `p` rests on (visual only). */
	rampUnder(p: Vec3): Vec3 | null;

	// Race
	/** Send the state packet of this tick now (before a zone message that the server checks against it). */
	sendState(): void;
	best(): LocalBest;
	/** Solo: save a run if it is this browser's best and show it on the HUD. */
	saveSoloBest(ticks: number, splits: number[]): boolean;
	readonly ghostStore: GhostStore;
	/** What the record ghost's holder wears, as the server last said (any map). */
	readonly ghostLook: { map: string; loadout: Loadout } | null;
	/** Say once per page load that record ghosts cannot be decoded here. */
	ghostUnavailable(): void;
}

/** Camera effects of a mode, read every frame. Aim angles never move: the kick is the camera's alone. */
export interface ModeView {
	/** Horizontal FOV (4:3) being zoomed to, and how far (0..1). 0: not zoomed. */
	zoomFov: number;
	zoomT: number;
	/** Camera offset (degrees): pitch + = down, yaw + = left, roll + = counter-clockwise. */
	kickPitch: number;
	kickYaw: number;
	kickRoll: number;
}

/** Console commands only some modes answer. */
/** `beacon` is E (infected: plant a beacon; Zombie Defense: repair / pad menu), `shop` is B and `ready` is F (Zombie Defense). */
export type ModeCommand = 'beacon' | 'moab' | 'shop' | 'ready';

/** A click in a mode's own menu (Zombie Defense shop and pad menu, while the cursor is free). */
export type ModeUiAction = { kind: 'pick'; index: number } | { kind: 'close' };

/** Server messages the game forwards to the mode as they are; a mode ignores those of others. */
export type ModeServerMessage = Extract<ServerMessage, { type: 'modeState' | 'zm' | 'zd' | 'inf' | 'hns' | 'tagged' }>;

export interface ClientMode {
	/** For tests and the dev console; the game does not read it. */
	readonly id: GameModeId;
	readonly view?: Readonly<ModeView>;
	/** FOV the mode has set (horizontal, 4:3) instead of the cvar's; null or absent: none. Infected eases its own every frame (`view`). */
	readonly scopeFov?: number | null;
	/** Race: the local run. Absent: no timer. */
	readonly run?: Readonly<RunState>;

	// Input (never called while spectating, except `release` and `slot`)
	press?(action: 'attack' | 'attack2', down: boolean, now: number): void;
	/** Every held button was let go (pointer lock or window focus lost, chat, console or a menu opened, spectating started or ended). */
	release?(now: number): void;
	/** Number key. False: the key goes to the map vote. */
	slot?(n: number, now: number): boolean;
	command?(cmd: ModeCommand, now: number): void;
	/** The key of a bound mode command was let go (E held to repair). */
	commandUp?(cmd: ModeCommand, now: number): void;
	/** A click in the mode's menu. */
	ui?(a: ModeUiAction, now: number): void;
	/** R. Not called while spectating. */
	restart(now: number): void;
	/** The `back` command. Absent: `restart`. Not called while spectating. */
	back?(now: number): void;
	/** Chat `!r` and `!b`, also while spectating. Absent: `restart` or `back`, not while spectating. */
	chatRestart?(now: number): void;
	/** Put the player back into play (spectating ended). */
	respawn(): void;

	// Simulation (`end`: wall-clock end of the tick, `now`: this frame)
	/** Physics cvars of this tick, or null: no movement. Absent: the map's. Not called while spectating. */
	moveCvars?(end: number): Cvars | null;
	/** After the movement of a tick. Not called while spectating. */
	tick(now: number, end: number): void;
	/** Fill `status`, `stage` and `runTicks` of the state packet (the game overwrites `status` while spectating). */
	netState(s: NetState): void;

	// Frame
	/** Once per frame after the camera and the remote players, before the shared HUD. Publishes the mode's HUD view. */
	frame(now: number): void;
	/** A remote player who is not in play is not drawn. */
	isDown?(id: number): boolean;
	/** Change a remote player's drawn pose before it is set. */
	adjustPose?(pose: AvatarPose): void;
	/** Looks of a remote player, after its pose was set. An avatar is plain when the mode starts: set only what the mode uses. */
	dress?(players: RemotePlayers, p: RemotePlayer, visible: boolean, now: number): void;
	/** A case of mine or another player's landed. */
	caseLanded?(kind: CaseKind, at: Vec3): void;

	// Solo scoreboard
	soloRow(): Partial<ScoreRow>;
	/** Solo: the mode's state for the score panel. */
	soloState?(): ModeState | null;

	// Network
	message?(m: ModeServerMessage, now: number): void;
	zombies?(f: ZombieFrame, arrival: number): void;
	defense?(f: DefenseFrame, arrival: number): void;
	ghostFrame?(f: GhostFrame): void;
	/** Who is here, what they wear or who I am changed. */
	peopleChanged?(): void;
	/** The connection was lost and `online` is false now: carry on in place. Absent: the game builds the mode anew. */
	offline?(): void;
	/** Leave nothing behind: viewmodel, zoom, meshes and the mode's HUD view. */
	dispose(): void;
}
