/**
 * Map vote helpers: option labels ("Surf · Kessler", "Extend 10 min") and
 * number-key routing for the map vote and the RTV request
 * (docs/ui.md#vote-panel, docs/gameplay.md#map-rotation-and-voting).
 */
import { EXTEND_DURATION, gameMode, getMap, mapTitle, type MapDef, type VoteOption } from '@surf/shared';

type MapNames = Pick<MapDef, 'title' | 'size'> & { kind: string };

/** Map label with its category: "Surf · Kessler", "Hide and Seek · Lido Bay (Medium)" (the id when the map is unknown). */
export function mapLabel(id: string, lookup: (id: string) => MapNames | undefined = getMap): string {
	const m = lookup(id);
	return m ? `${gameMode(m.kind).label} · ${mapTitle(m)}` : id;
}

export function voteLabel(o: VoteOption, lookup: (id: string) => MapNames | undefined = getMap): string {
	if (o.kind === 'extend') return `Extend ${Math.round(EXTEND_DURATION / 60)} min`;
	return mapLabel(o.mapId, lookup);
}

/** Highest number key that votes while a map vote is open (8 maps + extend). */
export const MAP_VOTE_KEYS = 9;

export type VoteKeyRoute = { kind: 'mapVote'; option: number } | { kind: 'rtv'; yes: boolean } | null;

/**
 * Number keys while a vote is up, ahead of (and instead of) their binds:
 * - map vote open: 1–9 vote (keys above the option count do nothing);
 * - RTV request open: 1 = yes, 2 = no; other keys keep their binds;
 * - otherwise null: the key's bind runs (e.g. zombies weapon slots).
 * A map vote and a request are never open together; the map vote wins.
 */
export function routeVoteKey(key: string, s: { mapVoteOptions: number; rtvRequestOpen: boolean }): VoteKeyRoute {
	if (!/^[1-9]$/.test(key)) return null;
	const n = Number(key);
	if (s.mapVoteOptions > 0) return n <= MAP_VOTE_KEYS ? { kind: 'mapVote', option: n } : null;
	if (s.rtvRequestOpen && (n === 1 || n === 2)) return { kind: 'rtv', yes: n === 1 };
	return null;
}
