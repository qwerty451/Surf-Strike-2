/**
 * Map rotation and vote contract (docs/gameplay.md#map-rotation-and-voting).
 * Shared by the server and client solo mode.
 *
 * Implemented in ./rotation-impl.ts:
 *   export class MapRotation {
 *     constructor(opts: { maps: string[]; current: string; now: number; rng?: () => number; mapDuration?: number; rtvBlock?: number;
 *       isEnabled?: (mapId: string) => boolean      // live filter: admin-disabled maps never come up in votes/random picks
 *       kindOf?: (mapId: string) => string })       // map category for VOTE_MAP_SLOTS (default: none, all fill slots)
 *     readonly current: string
 *     timeLeft(now: number): number                 // seconds, >= 0
 *     vote: ActiveVote | null
 *     // Advance; returns events. Call ~10x per second.
 *     update(now: number, voters: number): RotationEvent[]
 *     castVote(voterId: string, option: number, now: number): RotationEvent[]   // 1-based
 *     request: RtvRequestState | null                // open RTV request (docs/gameplay.md#map-rotation-and-voting)
 *     // Start an RTV request (initiator votes yes; optional nominated map), or vote yes on the open one.
 *     requestRtv(voterId: string, voters: number, now: number, mapId?: string | null): RotationEvent[] | { error: string }
 *     rtv(voterId, voters, now)                      // = requestRtv without a nomination (`!rtv`)
 *     rtvVote(voterId: string, yes: boolean, voters: number, now: number): RotationEvent[] | { error: string }
 *     rtvAvailableIn(now: number): { seconds: number; reason: 'declined' | 'mapStart' } | null
 *     removeVoter(voterId: string): void
 *     forceMap(map: string, now: number): RotationEvent | null   // immediate change (lone player, admin; ignores isEnabled); null if unknown
 *     extendBy(seconds: number, now: number): RotationEvent | null   // admin extend; null during a vote or pending change
 *   }
 */
import type { VoteOption } from './protocol.ts';

export const MAP_DURATION = 45 * 60;
export const EXTEND_DURATION = 10 * 60;
export const MAX_EXTENDS = 2;
export const VOTE_AT = 30; // seconds left
export const VOTE_DURATION = 20;
export const CHANGE_COUNTDOWN = 5;
/**
 * Map options per vote, by category (map kind), in display order. Free slots
 * (too few maps in a category) are filled from the other categories, up to
 * MAX_VOTE_MAPS distinct maps. The timed vote adds "Extend" after them.
 */
export const VOTE_MAP_SLOTS: Readonly<Record<string, number>> = Object.freeze({ surf: 2, bhop: 1, tag: 1, zombies: 1, infected: 1, hns: 1, defense: 1 });
export const MAX_VOTE_MAPS = 8;
/** An RTV request passes once a third of the non-spectating players voted yes: ceil(voters / 3), min 1. */
export const RTV_RATIO = 1 / 3;
export const RTV_BLOCK = 20; // seconds after map start
/** Seconds an RTV request stays open for yes/no votes. */
export const RTV_REQUEST_DURATION = 20;
/** Seconds after a declined RTV request before anyone may start another (lobby-wide). */
export const RTV_DECLINE_COOLDOWN = 60;

/** Open RTV request: "<initiator> wants to vote for a new map", players answer yes/no. */
export interface RtvRequestState {
	initiator: string; // voterId
	/** Nominated map: guaranteed a vote option if the request passes. */
	mapId: string | null;
	endsAt: number; // ms timestamp
	yes: Set<string>;
	no: Set<string>;
	/** Yes votes needed, for the voter count last seen. */
	needed: number;
}

export type RtvRequestEndReason = 'passed' | 'timeout' | 'rejected' | 'cancelled';

export interface ActiveVote {
	options: VoteOption[];
	counts: number[];
	endsAt: number; // ms timestamp
	rtv: boolean;
}

export type RotationEvent =
	| { type: 'voteStart'; options: VoteOption[]; duration: number; rtv: boolean }
	| { type: 'voteUpdate'; counts: number[] }
	| { type: 'voteEnd'; winner: VoteOption; countdown: number }
	| { type: 'extended'; timeLeft: number }
	| { type: 'mapChange'; map: string; timeLeft: number }
	/** RTV request started (`started`) or its counts changed. `duration`: seconds left. */
	| {
			type: 'rtvRequest';
			started: boolean;
			initiator: string;
			mapId: string | null;
			duration: number;
			yes: number;
			no: number;
			needed: number;
	  }
	/** RTV request closed. Passed: a vote follows. `cooldown`: seconds until the next request (declines only). */
	| { type: 'rtvRequestEnd'; passed: boolean; reason: RtvRequestEndReason; cooldown: number };
