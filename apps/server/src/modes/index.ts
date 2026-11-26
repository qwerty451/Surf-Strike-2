/** Server gamemode factory (docs/modes.md). */
import { modeOf } from '@surf/shared';
import { DefenseMode, type DefenseModeOptions } from './defense.ts';
import { HnsMode, hnsEnvOptions, type HnsModeOptions } from './hns.ts';
import { InfectedMode, type InfectedModeOptions } from './infected.ts';
import { RaceMode } from './race.ts';
import { TagMode, type TagModeOptions } from './tag.ts';
import type { ModeHost, ServerMode } from './types.ts';
import { ZombiesMode, type ZombiesModeOptions } from './zombies.ts';

export interface ModeOptions {
	infected?: InfectedModeOptions;
	tag?: TagModeOptions;
	zombies?: ZombiesModeOptions;
	/** Hide and seek round lengths; default from HNS_HIDE_SECS / HNS_SEEK_SECS env, else the rule defaults. */
	hns?: HnsModeOptions;
	/** Zombie Defense phase lengths and spawning (tests). */
	defense?: DefenseModeOptions;
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
		case 'defense':
			return new DefenseMode(host, opts.defense);
	}
}

export type { ModeHost, ModePlayer, ServerMode } from './types.ts';
export { DefenseMode, HnsMode, InfectedMode, RaceMode, TagMode, ZombiesMode };
