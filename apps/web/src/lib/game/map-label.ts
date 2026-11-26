/** Map labels with their gamemode ("Surf · Kessler"), for chat lines and the server browser. */
import { gameMode, getMap, MAPS, mapTitle, type MapDef } from '@surf/shared';

type MapNames = Pick<MapDef, 'title' | 'size'> & { kind: string };

/** Map label with its category: "Surf · Kessler", "Hide and Seek · Lido Bay (Medium)" (the id when the map is unknown). */
export function mapLabel(id: string, lookup: (id: string) => MapNames | undefined = getMap): string {
	const m = lookup(id);
	return m ? `${gameMode(m.kind).label} · ${mapTitle(m)}` : id;
}

/** `!map <name>`: the map whose id or title is `query` (any case), else the first that contains it. */
export function findMap(query: string, maps: readonly MapDef[] = MAPS): MapDef | null {
	const q = query.trim().toLowerCase();
	if (!q) return null;
	return (
		maps.find((m) => m.id.toLowerCase() === q || mapTitle(m).toLowerCase() === q) ??
		maps.find((m) => m.id.toLowerCase().includes(q) || mapTitle(m).toLowerCase().includes(q)) ??
		null
	);
}
