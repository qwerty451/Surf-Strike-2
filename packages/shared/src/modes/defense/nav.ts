/**
 * Zombie Defense nav graph (MapDef.defense.nav): A* over the map's walkable
 * node graph. Links can be closed per query (a boarded opening, or every
 * opening for zombies that are still outside).
 */
import type { DefenseNav } from '../../maps/types.ts';
import type { Vec3 } from '../../types.ts';

export class NavGraph {
	readonly nodes: readonly Vec3[];
	/** Neighbours and link lengths by node. */
	readonly adj: ReadonlyArray<ReadonlyArray<{ to: number; len: number }>>;

	constructor(nav: DefenseNav) {
		this.nodes = nav.nodes;
		const adj: Array<Array<{ to: number; len: number }>> = nav.nodes.map(() => []);
		for (const [a, b] of nav.links) {
			const pa = nav.nodes[a];
			const pb = nav.nodes[b];
			if (!pa || !pb || a === b) continue;
			const len = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
			adj[a]!.push({ to: b, len });
			adj[b]!.push({ to: a, len });
		}
		this.adj = adj;
	}

	/** Nearest node to a point (XY distance, height counted 4×), optionally only nodes `ok` accepts; -1 if none. */
	nearest(p: Vec3, ok?: (i: number) => boolean): number {
		let best = -1;
		let bestD = Infinity;
		for (let i = 0; i < this.nodes.length; i++) {
			if (ok && !ok(i)) continue;
			const n = this.nodes[i]!;
			const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2 + 4 * (n.z - p.z) ** 2;
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		return best;
	}

	/**
	 * Shortest node path from `from` to `to` (both included), or null. `closed(a, b)`
	 * returns true for links that cannot be used right now.
	 */
	path(from: number, to: number, closed?: (a: number, b: number) => boolean): number[] | null {
		const n = this.nodes.length;
		if (from < 0 || to < 0 || from >= n || to >= n) return null;
		if (from === to) return [from];
		const g = new Float64Array(n).fill(Infinity);
		const f = new Float64Array(n).fill(Infinity);
		const prev = new Int32Array(n).fill(-1);
		const done = new Uint8Array(n);
		const goal = this.nodes[to]!;
		const h = (i: number) => {
			const p = this.nodes[i]!;
			return Math.hypot(goal.x - p.x, goal.y - p.y, goal.z - p.z);
		};
		g[from] = 0;
		f[from] = h(from);
		const open: number[] = [from];
		while (open.length > 0) {
			// Small graphs (a few hundred nodes): a linear scan beats a heap.
			let bi = 0;
			for (let i = 1; i < open.length; i++) if (f[open[i]!]! < f[open[bi]!]!) bi = i;
			const cur = open[bi]!;
			open[bi] = open[open.length - 1]!;
			open.pop();
			if (cur === to) break;
			if (done[cur]) continue;
			done[cur] = 1;
			for (const { to: nb, len } of this.adj[cur]!) {
				if (done[nb] || (closed && closed(cur, nb))) continue;
				const ng = g[cur]! + len;
				if (ng >= g[nb]!) continue;
				g[nb] = ng;
				f[nb] = ng + h(nb);
				prev[nb] = cur;
				open.push(nb);
			}
		}
		if (prev[to] === -1) return null;
		const out = [to];
		for (let c = to; prev[c] !== -1; c = prev[c]!) out.push(prev[c]!);
		return out.reverse();
	}

	/** Length of a node path. */
	length(path: readonly number[]): number {
		let s = 0;
		for (let i = 1; i < path.length; i++) {
			const a = this.nodes[path[i - 1]!]!;
			const b = this.nodes[path[i]!]!;
			s += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
		}
		return s;
	}
}
