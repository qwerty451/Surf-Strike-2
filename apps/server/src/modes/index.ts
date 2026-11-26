/** Server gamemode factory (docs/modes.md). */
import { modeOf } from '@surf/shared';
import { HnsMode, hnsEnvOptions, type HnsModeOptions } from './hns.ts';
import { InfectedMode, type InfectedModeOptions } from './infected.ts';
import { RaceMode } from './race.ts';
import { TagMode, type TagModeOptions } from './tag.ts';
import { TournamentMode, type TournamentModeOptions } from './tournament.ts';
import type { ModeHost, ServerMode } from './types.ts';
import { ZombiesMode, type ZombiesModeOptions } from './zombies.ts';

export interface ModeOptions {
	infected?: InfectedModeOptions;
	tag?: TagModeOptions;
	zombies?: ZombiesModeOptions;
	/** Hide and seek round lengths; default from HNS_HIDE_SECS / HNS_SEEK_SECS env, else the rule defaults. */
	hns?: HnsModeOptions;
	/** Tournament phase lengths (tests); default the rule constants. */
	tournament?: TournamentModeOptions;
}

export function createServerMode(host: ModeHost, opts: ModeOptions = {}): ServerMode {
	const mode = modeOf(host.map);
	switch (mode.family) {
		case 'race':
			return new RaceMode(host);
		case 'tag':
			return new TagMode(host, opts.tag);
		case 'coop':
			return new ZombiesMode(host, opts.zombies);
		case 'infected':
			return new InfectedMode(host, opts.infected);
		case 'hns':
			return new HnsMode(host, { ...hnsEnvOptions(), ...opts.hns });
		case 'tournament':
			return new TournamentMode(host, opts.tournament);
	}
}

export type { ModeHost, ModePlayer, ServerMode } from './types.ts';
export { HnsMode, InfectedMode, RaceMode, TagMode, TournamentMode, ZombiesMode };
