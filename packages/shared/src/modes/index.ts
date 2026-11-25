/**
 * Gamemode registry (docs/modes.md). A map's `kind` names its gamemode; the
 * mode decides the default physics profile, whether the race timer and zones
 * run (race family: surf, bhop) or the mode has its own rules (tag), and
 * what the scoreboard and score panel show.
 *
 * Adding a mode: extend `GameModeId`, add a `GAME_MODES` entry, then plug in a
 * server rules module (apps/server/src/modes) and client HUD (docs/modes.md).
 */
import { BHOP_CVARS, SURF_CVARS, type Cvars } from '../cvars.ts';
import type { MapDef } from '../maps/types.ts';
import { DEFENSE_SCORE, HNS_SCORE, INFECTED_SCORE, RACE_SCORE, TAG_SCORE, ZOMBIES_SCORE, type ModeScoreDef } from './score.ts';

export type GameModeId = 'surf' | 'bhop' | 'tag' | 'zombies' | 'infected' | 'hns' | 'defense';

/**
 * Rule family. 'race': RunTracker timer, start/end/stage/checkpoint zones,
 * run validation and leaderboards. Any other family has its own rules module.
 */
export type ModeFamily = 'race' | 'tag' | 'coop' | 'infected' | 'hns' | 'defense';

export interface GameModeDef {
	id: GameModeId;
	label: string;
	/** One-line description for help text and docs. */
	description: string;
	family: ModeFamily;
	/** Default physics profile; a map's own `cvars` override it. */
	cvars: Readonly<Cvars>;
	/** Players needed before the mode's rules run (race: 1). */
	minPlayers: number;
	/** Tab scoreboard columns and score panel (score.ts, docs/modes.md#score-display). */
	score: ModeScoreDef;
}

/**
 * Tag physics: modern (CS2) jump like bhop, but surf-level air acceleration so
 * chases stay readable and the small surf sections still work.
 */
export const TAG_CVARS: Readonly<Cvars> = Object.freeze({
	...BHOP_CVARS,
	sv_airaccelerate: 150
});

/**
 * Zombies physics: surf ground movement (CS2 accelerate/friction), autobhop on
 * but CS2's bunnyhop cap (sv_enablebunnyhopping 0: 286 u/s on each jump) and
 * a moderate air acceleration, so it plays as run-and-gun. Players' max speed
 * comes from the held weapon (docs/modes.md#zombies).
 */
export const ZOMBIES_CVARS: Readonly<Cvars> = Object.freeze({
	...SURF_CVARS,
	sv_airaccelerate: 30,
	sv_enablebunnyhopping: 0
});

/**
 * Infected physics: same run-and-gun profile as zombies (capped bhop, lower
 * air acceleration, movement speeds driven by the held weapon / claws).
 */
export const INFECTED_CVARS: Readonly<Cvars> = ZOMBIES_CVARS;

/**
 * Hide and seek physics (docs/modes.md#hide-and-seek): CS2 ground movement
 * (surf profile: accelerate 6.5, friction 5.2, 250 run speed) with the same
 * soft bhop cap as Zombie Run and Infected: each jump trims the speed to 286
 * u/s, strafing gains some back in the air (about 300 u/s on average).
 */
export const HNS_CVARS: Readonly<Cvars> = Object.freeze({
	...SURF_CVARS,
	sv_airaccelerate: ZOMBIES_CVARS.sv_airaccelerate,
	sv_enablebunnyhopping: 0,
	sv_maxspeed: 250
});

export const GAME_MODES: Readonly<Record<GameModeId, GameModeDef>> = Object.freeze({
	surf: {
		id: 'surf',
		label: 'Surf',
		description: 'Race down surf ramps against the clock.',
		family: 'race',
		cvars: SURF_CVARS,
		minPlayers: 1,
		score: RACE_SCORE
	},
	bhop: {
		id: 'bhop',
		label: 'Bhop',
		description: 'Race over bunnyhop blocks against the clock.',
		family: 'race',
		cvars: BHOP_CVARS,
		minPlayers: 1,
		score: RACE_SCORE
	},
	tag: {
		id: 'tag',
		label: 'Tag',
		description: 'Whoever is IT tags someone else; score is time spent not being IT.',
		family: 'tag',
		cvars: TAG_CVARS,
		minPlayers: 2,
		score: TAG_SCORE
	},
	zombies: {
		id: 'zombies',
		label: 'Zombie Run',
		description: 'Co-op: follow the route to the evac point and hold back the zombie horde.',
		family: 'coop',
		cvars: ZOMBIES_CVARS,
		minPlayers: 1,
		score: ZOMBIES_SCORE
	},
	infected: {
		id: 'infected',
		label: 'Infected',
		description: 'Infected: survivors outlast the timer, the infected hunt with claws and throwing knives.',
		family: 'infected',
		cvars: INFECTED_CVARS,
		minPlayers: 2,
		score: INFECTED_SCORE
	},
	hns: {
		id: 'hns',
		label: 'Hide and Seek',
		description: 'Hiders hide; seekers hunt them with knives. Found hiders become seekers. Hiders win if anyone survives the clock.',
		family: 'hns',
		cvars: HNS_CVARS,
		minPlayers: 2,
		score: HNS_SCORE
	},
	defense: {
		id: 'defense',
		label: 'Zombie Defense',
		description: 'Co-op: barricade the base, build turrets and hold out against endless, growing waves of zombies.',
		family: 'defense',
		cvars: ZOMBIES_CVARS,
		minPlayers: 1,
		score: DEFENSE_SCORE
	}
});

export const GAME_MODE_IDS = Object.keys(GAME_MODES) as GameModeId[];

export function isGameModeId(v: unknown): v is GameModeId {
	return typeof v === 'string' && Object.hasOwn(GAME_MODES, v);
}

/** Mode definition by id (unknown ids fall back to surf). */
export function gameMode(id: string): GameModeDef {
	return isGameModeId(id) ? GAME_MODES[id] : GAME_MODES.surf;
}

/** The gamemode a map is played in. */
export function modeOf(map: Pick<MapDef, 'kind'>): GameModeDef {
	return gameMode(map.kind);
}

export function isRaceMode(id: string): boolean {
	return gameMode(id).family === 'race';
}

/** Full physics cvars for a map: its mode's profile, then the map's overrides. */
export function mapCvars(map: Pick<MapDef, 'kind' | 'cvars'>): Cvars {
	return { ...modeOf(map).cvars, ...map.cvars } as Cvars;
}

export * from './score.ts';
export * from './hns.ts';
export * from './tag.ts';
export * from './zombies/index.ts';
export * from './infected/index.ts';
