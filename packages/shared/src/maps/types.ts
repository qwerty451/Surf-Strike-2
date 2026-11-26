import type { Cvars } from '../cvars.ts';
import type { GameModeId } from '../modes/index.ts';
import type { Plane, Vec3 } from '../types.ts';

/** Map definition. See docs/maps.md. */
export interface MapDef {
	id: string; // "surf_aurora"
	title: string; // "Aurora"
	/** The map's gamemode (docs/modes.md). Race modes (surf, bhop) use start/end zones. */
	kind: GameModeId;
	difficulty: 'easy' | 'hard';
	/**
	 * Map size, for maps that come in several sizes under one title (hns_lido /
	 * hns_lido_m). Shown instead of the difficulty tag and after the title.
	 */
	size?: 'medium' | 'large';
	/** Race maps: 'linear' (checkpoints) or 'staged'. Tag maps: 'open'. Zombies maps: 'linear'. */
	layout: 'linear' | 'staged' | 'open';
	/** Physics overrides on top of the mode's profile (GAME_MODES[kind].cvars). */
	cvars: Partial<Cvars>;
	/** Race: start position (inside the start zone). Tag: fallback spawn. */
	spawn: Spawn;
	/**
	 * Tag (required, >= 8): random spawn points for joins, round starts and fall-outs.
	 * Zombies (required, >= 4): the team's start positions.
	 */
	spawns?: Spawn[];
	/** Zombies maps (required there): the route zombies follow and where they spawn (docs/maps.md). */
	zombies?: ZombieRoute;
	/** Hide and seek maps (required there): hider/seeker spawns and the seeker cage (docs/modes.md#hide-and-seek). */
	hns?: HnsMapInfo;
	/** Zombie Defense maps (required there): the base's openings, turret pads, zombie spawns and nav graph. */
	defense?: DefenseMapInfo;
	/** Tournament maps (required there): duel spawns, arena and spectator deck (docs/modes.md#tournament). */
	tournament?: TournamentMapInfo;
	brushes: BrushDef[];
	zones: Zone[];
	theme: Theme;
}

/**
 * Zombies route (docs/modes.md#zombies). The players' escape path is marked by
 * the map's checkpoint zones (1..N, each with a respawn) and its end zone.
 */
export interface ZombieRoute {
	/**
	 * Ordered waypoints (feet positions on the floor) from the start to the
	 * evac point. The straight line between consecutive waypoints is walkable
	 * for the player hull (map tests walk it with the real collision).
	 */
	path: Vec3[];
	/**
	 * Zombie spawn areas: boxes standing on walkable floor (min.z = floor top).
	 * `node` is the path waypoint the area feeds; the spawner only uses areas
	 * near the team's progress and away from players.
	 */
	spawnZones: ZombieSpawnZone[];
	/**
	 * Gates between the route's zones, in route order. A closed gate is a solid
	 * box (not in `brushes`: the mode adds and removes its collision). When at
	 * least half of the living survivors stand in its `unlock` area at once, a
	 * countdown starts; when it ends the gate opens. The last gate leads to the
	 * evac zone.
	 */
	gates: ZombieGate[];
}

/**
 * Hide and seek spawns (docs/modes.md#hide-and-seek). Hiders spawn spread over
 * `hiderSpawns` at round start; seekers (and players converted mid-round)
 * spawn at `seekerSpawns`. During the hiding phase seekers are frozen and
 * blindfolded at their spawn; `seekerCage` (optional) is the box their spawns
 * sit in, used by the server to keep frozen seekers there.
 */
export interface HnsMapInfo {
	/** >= 8 spread-out hider start positions. */
	hiderSpawns: Spawn[];
	/** >= 2 seeker start positions (ideally inside `seekerCage`). */
	seekerSpawns: Spawn[];
	/** Box around the seeker spawns (feet positions inside it). */
	seekerCage?: { min: Vec3; max: Vec3 };
	/** Where the cash bag appears (docs/economy.md#hide-and-seek). Without it the map has no bag. */
	cashBag?: HnsCashBag;
}

/**
 * Tournament map (docs/modes.md#tournament): a small, mirror-symmetric arena
 * under a glass roof; spectators stand on the roof (the deck) and cannot get
 * down into the arena.
 */
export interface TournamentMapInfo {
	/** The two duel spawns, mirror images of each other, facing each other. */
	duelSpawns: [Spawn, Spawn];
	/** The arena's playable box (feet positions inside it). */
	arena: { min: Vec3; max: Vec3 };
	/** The spectator deck on the glass (feet positions inside it). */
	deck: { min: Vec3; max: Vec3 };
	/** >= 8 spread-out spawn points on the deck. */
	deckSpawns: Spawn[];
}

/** A fixed, open spot near the middle of the playable area that is walkable from everywhere. */
export interface HnsCashBag {
	/** Floor point the bag floats above. */
	pos: Vec3;
	/** Where that is, for the announcement: "on the plaza, by the fountain". */
	place: string;
}

/**
 * Zombie Defense map data (docs/modes.md#zombie-defense). Players start inside
 * a base (MapDef.spawns, >= 4, all inside). Zombies spawn outside, walk the nav
 * graph to an opening, tear its barricade down plank by plank and then chase
 * the players inside, also over the nav graph.
 */
export interface DefenseMapInfo {
	/** Windows, doors and breaches in the base wall, on every side of it. */
	openings: DefenseOpening[];
	/** Fixed spots where a turret can be built (inside the base, or on its walls). */
	pads: DefensePad[];
	/** Zombie spawn areas outside the base, spread around it (>= 1 feeding every side). */
	spawnZones: DefenseSpawnZone[];
	/**
	 * Walkable graph for the AI. Node positions are feet positions on the floor;
	 * the straight line of every link is walkable for the player hull with the
	 * real collision and every barricade open (map tests walk them). The graph is
	 * connected, and every path from outside to inside goes through an opening's
	 * `outside` and `inside` nodes.
	 */
	nav: DefenseNav;
}

export interface DefenseNav {
	nodes: Vec3[];
	/** Undirected links between node indices. */
	links: [number, number][];
}

/**
 * A barricade spot. While it has at least one plank, `min`..`max` is solid for
 * players and zombies (not in `brushes`: the mode adds and removes it), but
 * bullets pass through it.
 */
export interface DefenseOpening {
	/** Stable id, unique on the map ("north_window"). */
	id: string;
	/** For chat and HUD: "north window". */
	name: string;
	min: Vec3;
	max: Vec3;
	/** Nav node just outside, where zombies stand while they tear planks off. */
	outside: number;
	/** Nav node just inside, where players stand to repair (and zombies enter). */
	inside: number;
	/** Planks when fully boarded (default 6). */
	planks?: number;
}

export interface DefensePad {
	/** Stable id, unique on the map ("pad_ne"). */
	id: string;
	/** Floor point at the pad's centre; the turret stands on it. */
	pos: Vec3;
	/** Default facing in degrees (0 = +X). */
	yaw: number;
}

export interface DefenseSpawnZone {
	/** Box standing on walkable floor (min.z = floor top), outside the base. */
	min: Vec3;
	max: Vec3;
	/** Nav node next to the box that zombies spawned here start from. */
	node: number;
}

export interface ZombieGate {
	min: Vec3;
	max: Vec3;
	/** Unlock area on the near side of the gate. */
	unlock: { min: Vec3; max: Vec3 };
	/**
	 * Path segment the gate sits on (between waypoints `node` and `node + 1`).
	 * While it is closed, only spawn areas with `node <= this` are used.
	 */
	node: number;
}

export interface ZombieSpawnZone {
	min: Vec3;
	max: Vec3;
	node: number;
}

export interface Spawn {
	pos: Vec3; // feet position (player origin), Source convention
	yaw: number; // degrees, 0 = +X, 90 = +Y
}

/**
 * Brush descriptions. The collision module turns each into a convex solid
 * (planes + bevels + face polygons); the renderer draws the face polygons.
 */
/**
 * Fields every brush may carry. `solid: false` makes a "fake" brush: rendered
 * like any other but with no collision (players pass through it — hide and
 * seek clip-through walls/props). Defaults to solid.
 */
export interface BrushCommon {
	solid?: boolean;
}

export type BrushDef = BrushCommon &
	(
	| { type: 'box'; min: Vec3; max: Vec3; material: string }
	| {
			/**
			 * Triangular prism surf ramp. The peak line runs from `from` to `to`
			 * (may descend or ascend). The cross-section is perpendicular to the
			 * peak line in the XY plane. `height` is the vertical drop from the
			 * peak to the base, `halfWidth` the horizontal distance from peak to
			 * each sloped base edge. side: 'both' = two sloped faces (A-frame),
			 * 'left' / 'right' = one sloped face on that side (seen looking from
			 * `from` towards `to`) and a vertical back face under the peak.
			 */
			type: 'ramp';
			from: Vec3;
			to: Vec3;
			height: number;
			halfWidth: number;
			side: 'both' | 'left' | 'right';
			material: string;
	  }
	| { type: 'convex'; planes: Plane[]; material: string }
	);

export type Zone =
	| { type: 'start' | 'end'; min: Vec3; max: Vec3 }
	| {
			type: 'stage' | 'checkpoint';
			index: number; // stages: 2..N (stage 1 = start zone); checkpoints: 1..N
			min: Vec3;
			max: Vec3;
			respawn: Spawn;
	  }
	| {
			type: 'teleport';
			min: Vec3;
			max: Vec3;
			to: 'stage' | 'start';
			/**
			 * Fixed destination (map teleporters, e.g. hide and seek secret
			 * passages). When set it overrides `to`: the player is moved to
			 * `dest.pos` facing `dest.yaw` with velocity zeroed.
			 */
			dest?: Spawn;
	  };

export interface MaterialDef {
	/** Base albedo, hex (0xRRGGBB). */
	color: number;
	/** Albedo used on faces whose normal z >= 0.7 (tops). Defaults to color. */
	topColor?: number;
	/** Emissive edge lines colour (neon edges). */
	edgeColor?: number;
	/** Emissive noise-crack colour (glowing seams). */
	seamColor?: number;
	/** Procedural noise world scale in units (default 256). */
	noiseScale?: number;
	/** 0..1 noise contrast (default 0.15). */
	noise?: number;
	/** Surface roughness hint 0..1 (default 0.8). */
	roughness?: number;
	/**
	 * Glass: drawn see-through (blended, both sides, after opaque geometry,
	 * bright fresnel rim) but fully solid in collision, like any brush.
	 * Defaults `opacity` to 0.3 when set.
	 */
	glass?: boolean;
	/** 0..1, default 1 (0.3 for glass). Below 1 the material is drawn transparent; collision is unchanged. */
	opacity?: number;
}

export interface Theme {
	skyTop: number;
	skyHorizon: number;
	skyBottom: number;
	fogColor: number;
	fogNear: number;
	fogFar: number;
	sunColor: number;
	sunIntensity: number;
	sunDir: Vec3; // direction towards the sun, Source axes
	ambientSky: number;
	ambientGround: number;
	ambientIntensity: number;
	materials: Record<string, MaterialDef>;
	/** Decorative effects the renderer knows how to draw. */
	effects: Array<
		| { type: 'aurora'; colors: number[]; height: number }
		| { type: 'embers'; color: number; count: number; area: { min: Vec3; max: Vec3 } }
		| { type: 'clouds'; color: number; count: number; height: number }
		| { type: 'gridFloor'; color: number; z: number; size: number }
		| { type: 'lavaSea'; color: number; z: number; size: number }
		| { type: 'snowFloor'; color: number; z: number; size: number }
	>;
}
