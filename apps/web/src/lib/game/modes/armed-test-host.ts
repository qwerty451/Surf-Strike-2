/** Test double of ClientModeHost for the modes with weapons (zombies, infected, tournament). */
import { buildCollisionWorld, createPlayer, mapCvars, type MapDef } from '@surf/shared';
import { vi } from 'vitest';
import { emptySample } from '../../net/interp.js';
import type { InfectedRenderer } from '../../render/infected.js';
import type { RemotePlayers } from '../../render/players.js';
import type { GameRenderer } from '../../render/renderer.js';
import type { ZombieRenderer } from '../../render/zombies.js';
import type { ClientModeHost, RemotePlayer } from './types.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** An object whose every method is a mock. */
export function mocks<T extends object>(own: Partial<T> = {}): T {
	const members: Record<string | symbol, unknown> = { ...own };
	return new Proxy(members, { get: (t, k) => (k in t ? t[k] : (t[k] = vi.fn())) }) as unknown as T;
}

/** Online as player 7, at the map's spawn. `hudWrites`: every HUD view the mode published, oldest first. */
export function fakeHost(map: MapDef, view: 'zombies' | 'infected' | 'tournament') {
	const hudWrites: unknown[] = [];
	const hud = {
		get [view]() {
			return hudWrites.at(-1) ?? null;
		},
		set [view](v: unknown) {
			hudWrites.push(v);
		}
	};
	const cvars: Record<string, number> = { fov: 101, cl_aimtoggle: 0 };
	const renderer = mocks<GameRenderer>({
		zombies: mocks<ZombieRenderer>({ casings: mocks<ZombieRenderer['casings']>() }),
		infected: mocks<InfectedRenderer>({ fx: mocks<InfectedRenderer['fx']>() }),
		players: mocks<RemotePlayers>()
	});
	const base: Partial<Mutable<ClientModeHost>> = {
		map,
		sv: mapCvars(map),
		world: buildCollisionWorld(map),
		player: createPlayer({ ...map.spawn.pos }),
		pitch: 0,
		yaw: 30,
		eye: { x: 1, y: 2, z: 3 },
		spec: null,
		remotes: new Map<number, RemotePlayer>(),
		hud: hud as unknown as ClientModeHost['hud'],
		audio: mocks(),
		renderer,
		online: true,
		selfId: 7,
		viewId: 7,
		voteOpen: false,
		cvar: (n) => cvars[n]!,
		myName: () => 'Me',
		name: (id) => `P${id}`
	};
	const host = mocks<Mutable<ClientModeHost>>(base);
	host.setWorld = (world) => {
		host.world = world;
	};
	return { host, hudWrites, cvars, renderer };
}

export const remote = (id: number): RemotePlayer => ({ id, name: `P${id}`, spectating: false, sample: emptySample(), hasSample: true });
