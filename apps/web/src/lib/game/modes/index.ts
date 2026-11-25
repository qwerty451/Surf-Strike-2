/** Client gamemode factory (docs/modes.md). */
import { hnsSpawns, modeOf, randomSpawn, type MapDef, type ModeFamily, type Spawn } from '@surf/shared';
import { HnsMode } from './hns.js';
import { InfectedMode } from './infected.js';
import { RaceMode } from './race.js';
import { TagMode } from './tag.js';
import type { ClientMode, ClientModeHost } from './types.js';
import { ZombiesMode } from './zombies.js';

interface ClientModeDef {
	create(host: ClientModeHost): ClientMode;
	/** Where the player stands when the map has loaded, before the mode (or the server) says otherwise. */
	spawn(map: MapDef): Spawn;
}

const pick = (list: readonly Spawn[]): Spawn => list[Math.floor(Math.random() * list.length)]!;

const CLIENT_MODES: Readonly<Record<ModeFamily, ClientModeDef>> = Object.freeze({
	race: { create: (host) => new RaceMode(host), spawn: (map) => map.spawn },
	tag: { create: (host) => new TagMode(host), spawn: randomSpawn },
	coop: { create: (host) => new ZombiesMode(host), spawn: (map) => map.spawn },
	infected: { create: (host) => new InfectedMode(host), spawn: randomSpawn },
	hns: { create: (host) => new HnsMode(host), spawn: (map) => pick(hnsSpawns(map).hiders) },
	// Contract stub: the Zombie Defense client mode replaces this.
	defense: {
		create: () => {
			throw new Error('Zombie Defense client mode is not built yet');
		},
		spawn: (map) => map.spawn
	}
});

/** The mode of the host's map. */
export function createClientMode(host: ClientModeHost): ClientMode {
	return CLIENT_MODES[modeOf(host.map).family].create(host);
}

export function startSpawn(map: MapDef): Spawn {
	return CLIENT_MODES[modeOf(map).family].spawn(map);
}

export type { ClientMode, ClientModeHost } from './types.js';
