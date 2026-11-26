/**
 * Built-in maps of every gamemode (docs/modes.md). Rotation order:
 * surf_aurora, surf_ember, bhop_meadow, bhop_circuit, then newer maps.
 */
import type { GameModeId } from '../modes/index.ts';
import type { MapDef, Spawn } from './types.ts';
import { surf_aurora } from './surf_aurora.ts';
import { surf_ember } from './surf_ember.ts';
import { bhop_meadow } from './bhop_meadow.ts';
import { bhop_circuit } from './bhop_circuit.ts';
import { surf_skyrend } from './surf_skyrend.ts';
import { surf_hadal } from './surf_hadal.ts';
import { bhop_reliquary } from './bhop_reliquary.ts';
import { bhop_rimefall } from './bhop_rimefall.ts';
import { surf_kessler } from './surf_kessler.ts';
import { surf_ochre } from './surf_ochre.ts';
import { tag_quayside } from './tag_quayside.ts';
import { zombies_lowtide } from './zombies_lowtide.ts';
import { infected_outpost } from './infected_outpost.ts';
import { infected_terminal } from './infected_terminal.ts';
import { infected_foundry } from './infected_foundry.ts';
import { hns_lido, hns_lido_m } from './hns_lido.ts';
import { tournament_orangery } from './tournament_orangery.ts';
import { SANDBOX } from './sandbox.ts';

/**
 * Spawns and respawns are authored on floor tops. A hull exactly touching a
 * floor counts as solid in the Source box trace, so lift them slightly, as
 * Source players always rest DIST_EPSILON above the ground.
 */
export const SPAWN_CLEARANCE = 0.25;

function liftSpawns(map: MapDef): MapDef {
	// Tag spawn lists may share objects with `spawn`: lift each object once.
	// Hide and seek spawns, tournament duel/deck spawns and fixed teleport destinations are authored on floors too.
	const lifted = new Set<Spawn>();
	const dests = map.zones.flatMap((z) => (z.type === 'teleport' && z.dest ? [z.dest] : []));
	for (const s of [map.spawn, ...(map.spawns ?? []), ...(map.hns?.hiderSpawns ?? []), ...(map.hns?.seekerSpawns ?? []), ...(map.tournament?.duelSpawns ?? []), ...(map.tournament?.deckSpawns ?? []), ...dests]) {
		if (lifted.has(s)) continue;
		lifted.add(s);
		s.pos = { ...s.pos, z: s.pos.z + SPAWN_CLEARANCE };
	}
	for (const z of map.zones) {
		if (z.type === 'stage' || z.type === 'checkpoint') {
			z.respawn = { ...z.respawn, pos: { ...z.respawn.pos, z: z.respawn.pos.z + SPAWN_CLEARANCE } };
		}
	}
	return map;
}

/** The rotation maps (all gamemodes), in rotation order. */
export const MAPS: MapDef[] = [
	surf_aurora,
	surf_ember,
	bhop_meadow,
	bhop_circuit,
	surf_skyrend,
	surf_hadal,
	bhop_reliquary,
	bhop_rimefall,
	surf_kessler,
	surf_ochre,
	tag_quayside,
	zombies_lowtide,
	infected_outpost,
	infected_terminal,
	infected_foundry,
	hns_lido,
	hns_lido_m,
	tournament_orangery
].map(liftSpawns);
liftSpawns(SANDBOX);

/** Physics/zone test map; loadable by id but not part of the rotation. */
export { SANDBOX };

export const MAP_IDS: string[] = MAPS.map((m) => m.id);

export const DEFAULT_MAP_ID = 'surf_aurora';

const byId = new Map<string, MapDef>([...MAPS, SANDBOX].map((m) => [m.id, m]));

/** Look up a rotation map or the sandbox by id. */
export function getMap(id: string): MapDef | undefined {
	return byId.get(id);
}

/** Tag texts of MapDef.size. */
export const MAP_SIZE_LABELS: Readonly<Record<'medium' | 'large', string>> = Object.freeze({ medium: 'Medium', large: 'Large' });

/** Title for text-only places (votes, chat): maps that come in sizes name theirs ("Lido Bay (Medium)"). */
export function mapTitle(m: Pick<MapDef, 'title' | 'size'>): string {
	return m.size ? `${m.title} (${MAP_SIZE_LABELS[m.size]})` : m.title;
}

/** Rotation maps of one gamemode, in rotation order. */
export function mapsForMode(mode: GameModeId): MapDef[] {
	return MAPS.filter((m) => m.kind === mode);
}
