/**
 * Infected HUD feedback (infected-hud-events.ts): what each event pays whom,
 * where a hit came from, the round summary rows, and the same through an
 * InfectedClient. The round tests run the real shared rules: the popups a
 * player saw must add up to the score the server gave them.
 */
import {
	buildCollisionWorld,
	INF_BEACON_HIT_Z,
	INF_PRESETS,
	INF_SCORE_BANK_BONUS,
	INF_SCORE_BEACON_DESTROY,
	INF_SCORE_INFECT,
	INF_SCORE_KILL,
	INF_SCORE_KNIFE_BONUS,
	INF_SCORE_MOAB,
	INF_SCORE_SPECIALIST,
	INF_SCORE_SURVIVE_TICK,
	INF_SCORE_SURVIVE_WIN,
	INF_STEP_MS,
	InfectedGame,
	infEventRoute,
	VIEW_HEIGHT,
	WEAPONS,
	type ClientMessage,
	type InfectedGameOptions,
	type InfEvent,
	type InfMethod,
	type InfPlayerView,
	type InfRoundStat,
	type InfStateView,
	type InfTeam,
	type MapDef,
	type Vec3
} from '@surf/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	hitBearing,
	hitSourceYaw,
	hurtSourceYaw,
	infectSourceYaw,
	INF_HURT_LETHAL_MS,
	INF_HURT_MAX,
	INF_HURT_MS,
	INF_HURT_STEP_DEG,
	INF_POP_MAX,
	INF_POP_MS,
	InfFeedback,
	infScoreAwards,
	infSummaryRows,
	type InfViewer
} from './infected-hud-events.js';
import { InfectedClient, type InfHost } from './infected.js';

const kill = (by: number, targetId = 9, head = false): InfEvent => ({ e: 'kill', by, targetId, weapon: 'lmg', head, x: 0, y: 0, z: 0, yaw: 0 });
const infect = (id: number, by: number | null, method: InfMethod = 'claws', timeAdded = 20): InfEvent => ({ e: 'infect', id, by, method, timeAdded });
/** A thrown-knife infection of `id` by `by` whose knife travelled along (dx, dy). */
const knifed = (id: number, by: number, dx?: number, dy?: number, method: InfMethod = 'knife'): Extract<InfEvent, { e: 'infect' }> => ({ e: 'infect', id, by, method, timeAdded: 20, dx, dy });
const end = (winner: 'survivors' | 'infected', extra: Partial<Extract<InfEvent, { e: 'end' }>> = {}): InfEvent => ({
	e: 'end',
	winner,
	round: 1,
	secs: 61.5,
	survivorsLeft: winner === 'survivors' ? 2 : 0,
	topId: 2,
	topScore: 400,
	...extra
});
const phase = (p: 'grace' | 'playing' | 'ended' | 'waiting', round = 1): InfEvent => ({ e: 'phase', phase: p, round, loadout: 'lmg' });
/** A shot by `by` travelling along world yaw `yaw` (degrees). */
const shot = (by: number, yaw: number): InfEvent => {
	const r = (yaw * Math.PI) / 180;
	return { e: 'shot', by, weapon: 'lmg', o: { x: 0, y: 0, z: 64 }, d: { x: Math.cos(r), y: Math.sin(r), z: 0 }, len: 100 };
};
const hurt = (id: number, extra: Partial<Extract<InfEvent, { e: 'hurt' }>> = {}): Extract<InfEvent, { e: 'hurt' }> => ({ e: 'hurt', id, hp: 3, stacks: 1, kx: 0, ky: 0, ...extra });
const stat = (id: number, extra: Partial<InfRoundStat> = {}): InfRoundStat => ({
	id,
	team: 'survivor',
	alpha: false,
	score: 0,
	kills: 0,
	infections: 0,
	deaths: 0,
	shots: 0,
	hits: 0,
	headshots: 0,
	bestStreak: 0,
	survivedSecs: 0,
	...extra
});

describe('infScoreAwards: what an event pays the viewer', () => {
	const surv: InfViewer = { id: 1, team: 'survivor', alive: true };
	const inf: InfViewer = { id: 1, team: 'infected', alive: true };

	it('kill: the killer, with a headshot label', () => {
		expect(infScoreAwards(kill(1), surv)).toEqual([{ points: INF_SCORE_KILL, label: 'Kill' }]);
		expect(infScoreAwards(kill(1, 9, true), surv)).toEqual([{ points: INF_SCORE_KILL, label: 'Headshot' }]);
		expect(infScoreAwards(kill(2), surv)).toEqual([]);
		expect(infScoreAwards(kill(2, 1), inf)).toEqual([]); // I was the one killed
	});

	it('infection: 150, 200 with a thrown knife, 250 for a bank shot (one popup)', () => {
		expect(infScoreAwards(infect(3, 1, 'claws'), inf)).toEqual([{ points: INF_SCORE_INFECT, label: 'Infection' }]);
		expect(infScoreAwards(infect(3, 1, 'gun'), inf)).toEqual([{ points: 150, label: 'Infection' }]);
		expect(infScoreAwards(infect(3, 1, 'knife'), inf)).toEqual([{ points: INF_SCORE_INFECT + INF_SCORE_KNIFE_BONUS, label: 'Thrown knife' }]);
		expect(infScoreAwards(infect(3, 1, 'bank'), inf)).toEqual([{ points: INF_SCORE_INFECT + INF_SCORE_KNIFE_BONUS + INF_SCORE_BANK_BONUS, label: 'Bank shot' }]);
		expect(infScoreAwards(infect(3, 1, 'bank'), inf)[0]!.points).toBe(250);
		expect(infScoreAwards(infect(3, 2, 'bank'), inf)).toEqual([]);
	});

	it('surviving an infection: every other living survivor, never the victim, the infected or a takeover', () => {
		expect(infScoreAwards(infect(3, 2), surv)).toEqual([{ points: INF_SCORE_SURVIVE_TICK, label: 'Survived' }]);
		expect(infScoreAwards(infect(3, null, 'knife'), surv)).toEqual([{ points: 25, label: 'Survived' }]); // thrower gone
		expect(infScoreAwards(infect(1, 2), surv)).toEqual([]); // me, still a survivor when the event arrives
		expect(infScoreAwards(infect(3, 2), inf)).toEqual([]);
		expect(infScoreAwards(infect(3, 2), { ...surv, alive: false })).toEqual([]);
		// Every infected left and a survivor took over: no time added, nobody paid.
		expect(infScoreAwards(infect(3, null, 'claws', 0), surv)).toEqual([]);
	});

	it('beacon, specialist, M.O.A.B.', () => {
		const smash = (by: number | null): InfEvent => ({ e: 'beaconDestroy', id: 4, ownerId: 5, by, x: 0, y: 0, z: 0 });
		expect(infScoreAwards(smash(1), surv)).toEqual([{ points: INF_SCORE_BEACON_DESTROY, label: 'Beacon' }]);
		expect(infScoreAwards(smash(null), surv)).toEqual([]); // replaced or cleaned up
		expect(infScoreAwards(smash(2), surv)).toEqual([]);
		expect(infScoreAwards({ e: 'perk', id: 1, perk: 'specialist', streak: 7 }, surv)).toEqual([{ points: INF_SCORE_SPECIALIST, label: 'Specialist' }]);
		expect(infScoreAwards({ e: 'perk', id: 1, perk: 'steady', streak: 5 }, surv)).toEqual([]);
		expect(infScoreAwards({ e: 'perk', id: 2, perk: 'specialist', streak: 7 }, surv)).toEqual([]);
		expect(infScoreAwards({ e: 'moabDetonate', by: 1, kills: 4 }, surv)).toEqual([{ points: INF_SCORE_MOAB, label: 'M.O.A.B.' }]);
		expect(infScoreAwards({ e: 'moabDetonate', by: 2, kills: 4 }, surv)).toEqual([]);
	});

	it('surviving the round: living survivors when the survivors win', () => {
		expect(infScoreAwards(end('survivors'), surv)).toEqual([{ points: INF_SCORE_SURVIVE_WIN, label: 'Round won' }]);
		expect(infScoreAwards(end('survivors'), inf)).toEqual([]);
		expect(infScoreAwards(end('infected'), surv)).toEqual([]);
		expect(infScoreAwards(end('infected'), inf)).toEqual([]);
	});

	it('events that pay nothing', () => {
		const none: InfEvent[] = [shot(1, 0), hurt(1), phase('playing'), { e: 'hit', by: 1, targetId: 2, head: true, kill: true }, { e: 'alpha', id: 1 }, { e: 'moabReady', id: 1 }];
		for (const ev of none) expect(infScoreAwards(ev, surv)).toEqual([]);
	});
});

describe('hit direction', () => {
	it('hitSourceYaw: against the travel direction; null without one', () => {
		expect(hitSourceYaw(-1, 0)).toBeCloseTo(0, 9); // travelling -x: it came from +x
		expect(hitSourceYaw(0, -1)).toBeCloseTo(90, 9);
		expect(hitSourceYaw(0, 1)).toBeCloseTo(-90, 9);
		expect(Math.abs(hitSourceYaw(1, 0)!)).toBeCloseTo(180, 9);
		expect(hitSourceYaw(0, 0)).toBeNull();
		expect(hitSourceYaw(Number.NaN, 1)).toBeNull();
	});

	it('hitBearing: clockwise from straight ahead (yaw grows counter-clockwise, so left is negative)', () => {
		// Looking along +x (yaw 0): +y is on the left, -y on the right.
		expect(hitBearing(0, 0)).toBe(0); // in front
		expect(hitBearing(0, 90)).toBe(-90); // left
		expect(hitBearing(0, -90)).toBe(90); // right
		expect(hitBearing(0, 180)).toBe(180); // behind
		expect(hitBearing(0, -180)).toBe(180);
		// Turning towards the source brings it to the front.
		expect(hitBearing(90, 90)).toBe(0);
		expect(hitBearing(-90, 90)).toBe(180);
		// Across the +-180 seam.
		expect(hitBearing(170, -170)).toBe(-20);
		expect(hitBearing(-170, 170)).toBe(20);
		expect(hitBearing(725, 5)).toBe(0);
	});

	it('hurtSourceYaw: the hit direction, else the knockback, else the shot before it', () => {
		// dx/dy win over a knockback that points elsewhere, and work with zero knockback.
		expect(hurtSourceYaw(hurt(1, { dx: 0, dy: -1, kx: 80, ky: 0 }))).toBeCloseTo(90, 9);
		expect(hurtSourceYaw(hurt(1, { dx: -1, dy: 0 }))).toBeCloseTo(0, 9);
		// Older servers: the knockback vector has the same direction.
		expect(hurtSourceYaw(hurt(1, { kx: 0, ky: 40 }))).toBeCloseTo(-90, 9);
		// No direction and no knockback: the shot that came just before it.
		expect(hurtSourceYaw(hurt(1), 33)).toBe(33);
		expect(hurtSourceYaw(hurt(1))).toBeNull();
		// A zero dx/dy is no direction: fall through.
		expect(hurtSourceYaw(hurt(1, { dx: 0, dy: 0, kx: -30, ky: 0 }))).toBeCloseTo(0, 9);
	});
});

describe('infSummaryRows', () => {
	it('one row per player: best score first, accuracy from hits and shots, names resolved', () => {
		const rows = infSummaryRows(
			[
				stat(3, { score: 150, kills: 1, shots: 40, hits: 13 }),
				stat(1, { score: 900, kills: 7, shots: 3, hits: 3, bestStreak: 7 }),
				stat(2, { team: 'infected', alpha: true, score: 150, infections: 2, deaths: 4 }),
				stat(4, { team: 'infected', score: 150, infections: 1, deaths: 1, shots: 10, hits: 99 })
			],
			(id) => `P${id}`
		);
		expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]); // score, then kills + infections, then name
		expect(rows[0]).toEqual({ id: 1, name: 'P1', team: 'survivor', alpha: false, score: 900, kills: 7, infections: 0, deaths: 0, accuracy: 100, bestStreak: 7 });
		expect(rows[1]).toMatchObject({ name: 'P2', team: 'infected', alpha: true, infections: 2, deaths: 4, accuracy: null }); // never fired
		expect(rows[2]!.accuracy).toBe(33); // 13 / 40
		expect(rows[3]!.accuracy).toBe(100); // clamped
		expect(infSummaryRows([], () => '')).toEqual([]);
	});
});

/** An InfFeedback with a host whose answers the test can change. */
function feedback() {
	const s = { me: 1, team: 'survivor' as InfTeam, alive: true, spectating: false, specId: null as number | null, players: [] as InfPlayerView[] };
	const f = new InfFeedback({
		me: () => s.me,
		team: () => s.team,
		alive: () => s.alive,
		spectating: () => s.spectating,
		specId: () => s.specId,
		players: () => s.players,
		name: (id) => `P${id}`
	});
	return { f, s };
}

const pv = (id: number, extra: Partial<InfPlayerView> = {}): InfPlayerView => ({
	id,
	team: 'survivor',
	alpha: false,
	hp: 5,
	alive: true,
	score: 0,
	kills: 0,
	deaths: 0,
	weapon: 'lmg',
	hasKnife: false,
	hasBeacon: false,
	streak: 0,
	perks: ['hardline'],
	moabReady: false,
	...extra
});

describe('InfFeedback: score popups', () => {
	it('a popup per award, oldest first, gone after INF_POP_MS; the list is replaced, not mutated', () => {
		const { f } = feedback();
		const rev0 = f.frame(1000, 0);
		expect(f.scorePops).toEqual([]);
		f.event(kill(1), 1000);
		const first = f.scorePops;
		expect(first).toEqual([{ id: 1, points: 100, label: 'Kill', at: 1000 }]);
		const rev1 = f.frame(1001, 0);
		expect(rev1).not.toBe(rev0);
		f.event(infect(3, 2), 1500);
		expect(f.scorePops.map((p) => `+${p.points} ${p.label}`)).toEqual(['+100 Kill', '+25 Survived']);
		expect(first).toHaveLength(1);
		// Nothing changes between frames while they live.
		const rev2 = f.frame(1600, 0);
		expect(f.frame(1700, 0)).toBe(rev2);
		const pops = f.scorePops;
		f.frame(1000 + INF_POP_MS - 1, 0);
		expect(f.scorePops).toBe(pops);
		f.frame(1000 + INF_POP_MS, 0);
		expect(f.scorePops.map((p) => p.label)).toEqual(['Survived']);
		f.frame(1500 + INF_POP_MS, 0);
		expect(f.scorePops).toEqual([]);
		expect(f.frame(9000, 0)).toBe(f.frame(9001, 0));
	});

	it('simultaneous awards stack as separate popups; at most INF_POP_MAX are kept', () => {
		const { f } = feedback();
		// A M.O.A.B. ends the round in the same flush: both bonuses.
		f.event({ e: 'moabDetonate', by: 1, kills: 3 }, 2000);
		f.event(end('survivors'), 2000);
		expect(f.scorePops.map((p) => `+${p.points} ${p.label}`)).toEqual(['+500 M.O.A.B.', '+250 Round won']);
		expect(new Set(f.scorePops.map((p) => p.id)).size).toBe(2);
		for (let i = 0; i < 6; i++) f.event(kill(1), 2010 + i);
		expect(f.scorePops).toHaveLength(INF_POP_MAX);
		expect(f.scorePops.every((p) => p.label === 'Kill')).toBe(true);
		expect(f.scorePops.at(-1)!.at).toBe(2015);
	});

	it('a new round starts empty', () => {
		const { f } = feedback();
		f.event(kill(1), 100);
		f.event(phase('ended'), 110);
		expect(f.scorePops).toHaveLength(1);
		f.event(phase('grace', 2), 120);
		expect(f.scorePops).toEqual([]);
	});

	it('spectating: popups of the target, nothing in free-fly, nothing of mine', () => {
		const { f, s } = feedback();
		s.players = [pv(1), pv(2), pv(3, { team: 'infected', weapon: 'claws' })];
		f.event(kill(1), 100);
		expect(f.scorePops).toHaveLength(1);
		// Free-fly: my popup goes with the next frame, events that name me pay nothing.
		s.spectating = true;
		f.frame(110, 0);
		expect(f.scorePops).toEqual([]);
		f.event(kill(1), 120);
		f.event(end('survivors'), 121);
		expect(f.scorePops).toEqual([]);
		// Target 2 (a survivor): their kill and their survive bonus, not player 3's infection.
		s.specId = 2;
		f.event(kill(2), 200);
		f.event(infect(4, 3), 210);
		f.event(kill(1), 220);
		expect(f.scorePops.map((p) => `+${p.points} ${p.label}`)).toEqual(['+100 Kill', '+25 Survived']);
		// Another target: the old target's popups are dropped at once.
		s.specId = 3;
		f.frame(230, 0);
		expect(f.scorePops).toEqual([]);
		f.event(infect(5, 3, 'bank'), 240);
		expect(f.scorePops.map((p) => `+${p.points} ${p.label}`)).toEqual(['+250 Bank shot']);
		// A target the state does not know, or myself as target: nothing.
		s.specId = 8;
		f.frame(250, 0);
		f.event(kill(8), 260);
		s.specId = 1;
		f.event(kill(1), 270);
		expect(f.scorePops).toEqual([]);
		// Back in play: the target's popups do not follow me.
		s.specId = 3;
		f.event(infect(6, 3), 300);
		expect(f.scorePops).toHaveLength(1);
		s.spectating = false;
		s.specId = null;
		f.frame(310, 0);
		expect(f.scorePops).toEqual([]);
	});

	it('a player turned by an event is infected even while the mode state still says survivor', () => {
		const { f, s } = feedback();
		s.spectating = true;
		s.specId = 2;
		s.players = [pv(1), pv(2), pv(3)];
		f.event(infect(2, 9), 100); // the target is infected: no popup for them
		expect(f.scorePops).toEqual([]);
		f.event(infect(3, 9), 110); // stale state: still listed as a survivor
		f.event(end('survivors'), 120);
		expect(f.scorePops).toEqual([]);
		// Patient Zero is turned by the alpha event.
		s.specId = 3;
		f.event(phase('grace', 2), 200);
		f.event({ e: 'alpha', id: 3 }, 210);
		f.event(infect(2, 3), 220);
		expect(f.scorePops.map((p) => p.label)).toEqual(['Infection']);
		// The next round forgets it.
		f.event(phase('grace', 3), 300);
		f.event(infect(2, 9), 310);
		expect(f.scorePops.map((p) => p.label)).toEqual(['Survived']);
	});
});

describe('InfFeedback: hit direction arcs', () => {
	it('a hurt with a direction: the arc points at the source and turns with the view', () => {
		const { f } = feedback();
		// Hit travelling along -y: it came from +y, which is on the left when looking along +x.
		f.event(hurt(1, { dx: 0, dy: -1 }), 1000);
		const rev = f.frame(1000, 0);
		expect(f.hurtDirs).toEqual([{ id: 1, at: 1000, bearing: -90, lethal: false }]);
		// Same view: the same list, no new revision.
		const dirs = f.hurtDirs;
		expect(f.frame(1016, 0)).toBe(rev);
		expect(f.frame(1032, 0.4)).toBe(rev); // less than a step
		expect(f.hurtDirs).toBe(dirs);
		// Turning left towards it brings it to the front; turning away puts it behind.
		expect(f.frame(1048, 90)).not.toBe(rev);
		expect(f.hurtDirs[0]!.bearing).toBe(0);
		f.frame(1064, -90);
		expect(f.hurtDirs[0]!.bearing).toBe(180);
		// In between it moves in whole steps.
		f.frame(1080, 45);
		expect(Math.abs(f.hurtDirs[0]!.bearing + 45)).toBeLessThanOrEqual(INF_HURT_STEP_DEG / 2);
		expect(Math.abs(f.hurtDirs[0]!.bearing % INF_HURT_STEP_DEG)).toBe(0);
		// Gone after INF_HURT_MS.
		f.frame(1000 + INF_HURT_MS - 1, 0);
		expect(f.hurtDirs).toHaveLength(1);
		f.frame(1000 + INF_HURT_MS, 0);
		expect(f.hurtDirs).toEqual([]);
	});

	it('zero knockback: the direction comes from dx/dy, or from the shot right before the hurt', () => {
		const { f } = feedback();
		f.event(hurt(1, { dx: 1, dy: 0, kx: 0, ky: 0 }), 100);
		f.frame(100, 0);
		expect(f.hurtDirs[0]).toMatchObject({ bearing: 180 }); // from behind
		// An older server: no dx/dy and no knockback, but the shot of the same flush has the direction.
		f.event(shot(2, -90), 200); // travelling along -y: fired from +y (my left)
		f.event({ e: 'hit', by: 2, targetId: 1, head: false, kill: false }, 200);
		f.event(hurt(1), 200);
		f.frame(200, 0);
		expect(f.hurtDirs.map((h) => h.bearing)).toEqual([180, -90]);
		// A knockback vector alone is enough.
		f.event(hurt(1, { kx: -40, ky: 0 }), 300);
		f.frame(300, 0);
		expect(f.hurtDirs.at(-1)!.bearing).toBe(0);
		// An old shot explains nothing, and a hurt for someone else is not mine.
		f.event(hurt(1), 900);
		f.event(shot(2, 0), 1000);
		f.event(hurt(7, { dx: 1, dy: 0 }), 1000);
		f.frame(1000, 0);
		expect(f.hurtDirs).toHaveLength(3);
	});

	it('the killing blow and an infection point at the attacker through their shot, and stay longer', () => {
		const { f, s } = feedback();
		s.team = 'infected';
		f.event(shot(4, 180), 100); // travelling along -x: fired from +x (in front at yaw 0)
		f.event({ e: 'hit', by: 4, targetId: 1, head: true, kill: true }, 100);
		f.event(kill(4, 1, true), 100);
		f.frame(100, 0);
		expect(f.hurtDirs).toEqual([{ id: 1, at: 100, bearing: 0, lethal: true }]);
		f.frame(100 + INF_HURT_MS + 1, 0);
		expect(f.hurtDirs).toHaveLength(1);
		f.frame(100 + INF_HURT_LETHAL_MS, 0);
		expect(f.hurtDirs).toEqual([]);
		// Claws: the swing is a shot event too. A shot by someone else is not the attacker's.
		s.team = 'survivor';
		f.event(shot(5, 90), 5000);
		f.event(infect(1, 5), 5000);
		f.event(shot(6, 0), 6000);
		f.event(kill(7, 1), 6000);
		f.event(infect(1, null, 'claws', 0), 6000);
		f.frame(6000, 0);
		expect(f.hurtDirs).toEqual([{ id: 2, at: 5000, bearing: 90, lethal: true }]);
	});

	it('infectSourceYaw: the direction the knife travelled, else the shot before it', () => {
		expect(Math.abs(infectSourceYaw(knifed(1, 5, 1, 0))!)).toBe(180); // travelling along +x: thrown from -x
		expect(infectSourceYaw(knifed(1, 5, 0, -1), 30)).toBe(90); // the event's direction beats the shot
		expect(infectSourceYaw(knifed(1, 5), 30)).toBe(30); // no direction: the shot
		expect(infectSourceYaw(knifed(1, 5, 0, 0), 30)).toBe(30); // a zero vector is no direction
		expect(infectSourceYaw(knifed(1, 5, Number.NaN, 1), 30)).toBe(30);
		expect(infectSourceYaw(knifed(1, 5, 1), 30)).toBe(30); // half a vector is none
		expect(infectSourceYaw(knifed(1, 5))).toBeNull();
	});

	it('a thrown-knife infection points back along the knife when the event carries its direction', () => {
		const { f } = feedback();
		// No shot event for a knife in flight. It travelled along -y: thrown from +y, my left at yaw 0.
		f.event(knifed(1, 5, 0, -1), 1000);
		f.frame(1000, 0);
		expect(f.hurtDirs).toEqual([{ id: 1, at: 1000, bearing: -90, lethal: true }]);
		// It turns with the view and lives as long as any killing blow.
		f.frame(1016, 90);
		expect(f.hurtDirs[0]!.bearing).toBe(0);
		f.frame(1000 + INF_HURT_MS + 1, 0);
		expect(f.hurtDirs).toHaveLength(1);
		f.frame(1000 + INF_HURT_LETHAL_MS, 0);
		expect(f.hurtDirs).toEqual([]);
		// A bank shot carries the direction after its last bounce the same way.
		f.event(knifed(1, 5, -1, 0, 'bank'), 5000);
		f.frame(5000, 0);
		expect(f.hurtDirs).toEqual([{ id: 2, at: 5000, bearing: 0, lethal: true }]);
	});

	it('knife direction: it beats a claw swing of the same attacker; without it nothing changes', () => {
		const { f } = feedback();
		// The thrower also swung their claws within the pairing window, facing elsewhere: the knife's own direction wins.
		f.event(shot(5, 180), 1000); // from +x: in front
		f.event(knifed(1, 5, 0, 1), 1040); // travelling along +y: thrown from -y, my right
		f.frame(1040, 0);
		expect(f.hurtDirs.map((h) => h.bearing)).toEqual([90]);
		// An older server sends no direction: no shot, no arc (as before)…
		f.event(knifed(1, 6), 3000);
		f.frame(3000, 0);
		expect(f.hurtDirs).toHaveLength(1);
		// …and with a shot by the thrower just before it, the arc comes from that shot (as before).
		f.event(shot(6, -90), 4000); // from +y: my left
		f.event(knifed(1, 6), 4000);
		f.frame(4000, 0);
		expect(f.hurtDirs.map((h) => h.bearing)).toEqual([-90]);
		// A zero vector is no direction: the shot again, or nothing.
		f.event(shot(7, 0), 7000); // from -x: behind
		f.event(knifed(1, 7, 0, 0), 7000);
		f.event(knifed(1, 8, 0, 0), 7001);
		f.frame(7001, 0);
		expect(f.hurtDirs.map((h) => h.bearing)).toEqual([180]);
		// Someone else's infection and a takeover (no attacker) are not hits on me.
		f.event(knifed(9, 5, 1, 0), 9500);
		f.event({ e: 'infect', id: 1, by: null, method: 'claws', timeAdded: 0, dx: 1, dy: 0 }, 9500);
		f.frame(9500, 0);
		expect(f.hurtDirs).toEqual([]);
	});

	it('at most INF_HURT_MAX arcs; none while spectating; a new round clears them', () => {
		const { f, s } = feedback();
		for (let i = 0; i < INF_HURT_MAX + 2; i++) f.event(hurt(1, { dx: -1, dy: 0 }), 100 + i);
		f.frame(110, 0);
		expect(f.hurtDirs).toHaveLength(INF_HURT_MAX);
		expect(f.hurtDirs[0]!.at).toBe(102);
		s.spectating = true;
		f.frame(120, 0);
		expect(f.hurtDirs).toEqual([]);
		s.spectating = false;
		f.frame(130, 0);
		expect(f.hurtDirs).toHaveLength(INF_HURT_MAX);
		f.event(phase('grace', 2), 140);
		expect(f.hurtDirs).toEqual([]);
		f.frame(150, 0);
		expect(f.hurtDirs).toEqual([]);
	});
});

describe('InfFeedback: round summary', () => {
	it('rows and the next loadout label from the end event; absent without stats; cleared by the next round', () => {
		const { f } = feedback();
		f.event(end('infected'), 100);
		expect(f.summaryRows).toBeNull();
		expect(f.nextLoadoutLabel).toBeNull();
		const rev = f.frame(110, 0);
		f.event(end('survivors', { stats: [stat(2, { score: 50 }), stat(1, { score: 300 })], nextLoadout: 'barrett' }), 200);
		expect(f.frame(210, 0)).not.toBe(rev);
		expect(f.summaryRows!.map((r) => r.name)).toEqual(['P1', 'P2']);
		expect(f.nextLoadoutLabel).toBe(WEAPONS.barrett.label);
		expect(f.nextLoadoutLabel).toBe('.50 cal rifle');
		f.event(phase('ended'), 210);
		expect(f.summaryRows).toHaveLength(2);
		f.event(phase('grace', 2), 300);
		expect(f.summaryRows).toBeNull();
		expect(f.nextLoadoutLabel).toBeNull();
		// An unknown weapon id from a newer server is ignored.
		f.event(end('survivors', { nextLoadout: 'railgun' as never }), 400);
		expect(f.nextLoadoutLabel).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Through the client

const st = (extra: Partial<InfStateView> = {}): InfStateView => ({
	phase: 'playing',
	round: 1,
	timeLeft: 100,
	loadout: 'lmg',
	secondary: 'pistol',
	moab: null,
	alphaId: null,
	survivors: 2,
	infected: 1,
	players: [pv(1), pv(2), pv(3, { team: 'infected', weapon: 'claws' })],
	knives: [],
	beacons: [],
	...extra
});

/** Client 1 in a playing round (survivor with the LMG), fed synthetic events. */
function client() {
	const host: InfHost = {
		online: () => true,
		selfId: () => 1,
		send: () => {},
		zombieRenderer: () => null,
		infectedRenderer: () => null,
		name: (id) => `P${id}`,
		notice: () => {},
		teleport: () => {},
		sound: () => {},
		setZoom: () => {},
		push: () => {}
	};
	const c = new InfectedClient(host, 0);
	c.onModeState(st(), 0);
	return c;
}

describe('InfectedClient view', () => {
	it('score popups, hit arcs and slot ammo reach the view; the view object is rebuilt only on change', () => {
		const c = client();
		const v0 = c.frame(10, true, 0);
		expect(v0).toMatchObject({ scorePops: [], hurtDirs: [], summaryRows: null, nextLoadoutLabel: null, focusId: 1 });
		expect(v0.slotAmmo).toEqual([v0.mag + v0.reserve, WEAPONS.pistol.magazine + 36]);
		c.onEvent(kill(1), 100);
		c.onEvent({ e: 'beaconDestroy', id: 1, ownerId: 3, by: 1, x: 0, y: 0, z: 0 }, 100);
		const v1 = c.frame(110, true, 0);
		expect(v1.scorePops!.map((p) => `+${p.points} ${p.label}`)).toEqual(['+100 Kill', '+50 Beacon']);
		expect(c.frame(126, true, 0)).toBe(v1);
		// Hit from the right while looking along +y (yaw 90): the source is at +x.
		c.viewYaw = 90;
		c.onEvent(hurt(1, { hp: 4, dx: -1, dy: 0 }), 200);
		const v2 = c.frame(210, true, 0);
		expect(v2.hurtAt).toBe(200);
		expect(v2.hurtDirs).toEqual([{ id: 1, at: 200, bearing: 90, lethal: false }]);
		// Standing still: the same object every frame. Turning: a new view with the arc re-aimed.
		expect(c.frame(226, true, 0)).toBe(v2);
		c.viewYaw = 0;
		const v3 = c.frame(242, true, 0);
		expect(v3).not.toBe(v2);
		expect(v3.hurtDirs![0]!.bearing).toBe(0);
		const v4 = c.frame(200 + INF_HURT_MS, true, 0);
		expect(v4.hurtDirs).toEqual([]);
		// With nothing alive the view yaw does not rebuild the view.
		const v5 = c.frame(100 + INF_POP_MS + 10, true, 0);
		expect(v5.scorePops).toEqual([]);
		c.viewYaw = 140;
		expect(c.frame(100 + INF_POP_MS + 26, true, 0)).toBe(v5);
	});

	it('spectating: no arcs, popups of the target, the summary row of the target in focus', () => {
		const c = client();
		c.onEvent(hurt(1, { hp: 4, dx: -1, dy: 0 }), 100);
		c.onEvent(kill(1), 100);
		expect(c.frame(110, true, 0)).toMatchObject({ hurtDirs: [{ bearing: 0 }], scorePops: [{ label: 'Kill' }] });
		c.setSpectate(true, 2);
		const v = c.frame(120, true, 0);
		expect(v).toMatchObject({ spectating: true, hurtDirs: [], scorePops: [], focusId: 2 });
		c.onEvent(kill(2), 130);
		c.onEvent(kill(1), 131);
		expect(c.frame(140, true, 0).scorePops!.map((p) => p.label)).toEqual(['Kill']);
		c.setSpectate(true, null);
		expect(c.frame(150, true, 0)).toMatchObject({ scorePops: [], hurtDirs: [], focusId: 1 });
		c.setSpectate(false, null);
		expect(c.frame(160, true, 0)).toMatchObject({ scorePops: [], focusId: 1 });
	});

	it('round summary: rows with the server stats, the one-line summary without; both go with the round', () => {
		const c = client();
		c.onEvent(end('infected'), 100);
		c.onEvent(phase('ended'), 100);
		let v = c.frame(110, true, 0);
		expect(v.summary).toMatchObject({ winner: 'infected', secs: 61.5, top: 'P2 (400)' });
		expect(v.summaryRows).toBeNull();
		expect(v.nextLoadoutLabel).toBeNull();
		c.onEvent(phase('grace', 2), 200);
		c.onEvent(phase('playing', 2), 300);
		const stats = [stat(1, { score: 350, kills: 1, shots: 8, hits: 2 }), stat(2, { score: 250 }), stat(3, { team: 'infected', alpha: true, infections: 0, deaths: 1 })];
		c.onEvent(end('survivors', { round: 2, stats, nextLoadout: 'striker' }), 400);
		c.onEvent(phase('ended', 2), 400);
		v = c.frame(410, true, 0);
		expect(v.summary).toMatchObject({ winner: 'survivors' });
		expect(v.summaryRows!.map((r) => [r.name, r.score, r.accuracy])).toEqual([
			['P1', 350, 25],
			['P2', 250, null],
			['P3', 0, null]
		]);
		expect(v.summaryRows![2]).toMatchObject({ alpha: true, team: 'infected' });
		expect(v.nextLoadoutLabel).toBe('Auto shotgun');
		expect(v.scorePops!.map((p) => p.label)).toEqual(['Round won']);
		// A state that is no longer 'ended' drops the summary (a missed phase event).
		c.onModeState(st({ phase: 'grace', round: 3 }), 500);
		v = c.frame(510, true, 0);
		expect(v.summary).toBeNull();
		expect(v.summaryRows).toBeNull();
		expect(v.nextLoadoutLabel).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Real rules: one client per player around an InfectedGame

const SPAWNS = [
	{ pos: { x: -1000, y: -1000, z: 0.25 }, yaw: 0 },
	{ pos: { x: -1000, y: 1000, z: 0.25 }, yaw: 0 },
	{ pos: { x: 1000, y: -1000, z: 0.25 }, yaw: 180 },
	{ pos: { x: 1000, y: 1000, z: 0.25 }, yaw: 180 }
];

/** Flat floor, four spread spawns, a fall-out box far below. */
function testMap(): MapDef {
	return {
		id: 'inf_feedback_test',
		title: 'Test',
		kind: 'infected',
		difficulty: 'easy',
		layout: 'open',
		cvars: {},
		spawn: SPAWNS[0]!,
		spawns: SPAWNS,
		brushes: [{ type: 'box', min: { x: -1200, y: -1200, z: -64 }, max: { x: 1200, y: 1200, z: 0 }, material: 'm' }],
		zones: [{ type: 'teleport', min: { x: -5000, y: -5000, z: -3000 }, max: { x: 5000, y: 5000, z: -500 }, to: 'start' }],
		theme: {
			skyTop: 0,
			skyHorizon: 0,
			skyBottom: 0,
			fogColor: 0,
			fogNear: 0,
			fogFar: 1,
			sunColor: 0,
			sunIntensity: 1,
			sunDir: { x: 0, y: 0, z: 1 },
			ambientSky: 0,
			ambientGround: 0,
			ambientIntensity: 1,
			materials: { m: { color: 0 } },
			effects: []
		}
	};
}

const body = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z + 36 });

/**
 * A round in `playing` with the LMG; rng 0 makes the first id Patient Zero.
 * Every popup a client shows is recorded by popup id, so `earned(id)` is
 * what that player was shown in total.
 */
function round(ids: number[], opts: Partial<InfectedGameOptions> = {}) {
	const map = testMap();
	const world = buildCollisionWorld(map);
	const clock = { now: 1_000_000 };
	const game = new InfectedGame({ map, world, now: clock.now, rng: () => 0, graceSecs: 1, endSecs: 1, ...opts });
	game.round = INF_PRESETS.indexOf('lmg');
	const pos = new Map<number, Vec3>();
	const clients = new Map<number, InfectedClient>();
	const shown = new Map<number, Map<number, { points: number; label: string }>>();
	const log: InfEvent[] = [];
	/** Scores at the `end` event (the next grace resets them). */
	let finalScores: Map<number, number> | null = null;

	const record = () => {
		for (const [id, c] of clients) for (const p of c.frame(clock.now, false, 0).scorePops ?? []) shown.get(id)!.set(p.id, p);
	};
	const route = (events: InfEvent[]) => {
		for (const ev of events) {
			log.push(ev);
			if (ev.e === 'end') finalScores = new Map(ids.map((id) => [id, game.playerView(id)!.score]));
			const r = infEventRoute(ev);
			for (const [id, c] of clients) {
				if (r.to !== undefined && r.to !== id) continue;
				if (r.except !== undefined && r.except === id) continue;
				c.onEvent(ev, clock.now);
			}
			record();
		}
	};
	const handle = (id: number, msg: ClientMessage) => {
		const now = clock.now;
		if (msg.type === 'fire') route(game.fire(id, { weapon: msg.weapon, origin: msg.origin, dir: msg.dir, tick: msg.tick }, now).events);
		else if (msg.type === 'throwKnife') route(game.throwKnife(id, msg.origin, msg.dir, now).events);
		else if (msg.type === 'loadout') route(game.selectWeapon(id, msg.weapon, now));
		else if (msg.type === 'reload') game.reload(id, now);
		else if (msg.type === 'placeBeacon') route(game.placeBeacon(id, now).events);
		else if (msg.type === 'callMoab') route(game.callMoab(id, now).events);
	};
	const put = (id: number, x: number, y: number, z = 0.25, yaw = 0) => {
		pos.set(id, { x, y, z });
		game.setPlayerPos(id, { x, y, z, ducked: false, yaw });
	};
	for (const id of ids) {
		const host: InfHost = {
			online: () => true,
			selfId: () => id,
			send: (msg) => handle(id, msg),
			zombieRenderer: () => null,
			infectedRenderer: () => null,
			name: (pid) => `P${pid}`,
			notice: () => {},
			teleport: (x, y, z, yaw) => put(id, x, y, z, yaw),
			sound: () => {},
			setZoom: () => {},
			push: () => {}
		};
		clients.set(id, new InfectedClient(host, clock.now, world));
		shown.set(id, new Map());
	}
	const state = () => {
		const v = game.view(clock.now);
		for (const c of clients.values()) c.onModeState(v, clock.now);
	};
	const step = () => {
		clock.now += INF_STEP_MS;
		route(game.update(clock.now));
	};
	const advance = (ms: number) => {
		const until = clock.now + ms;
		while (clock.now < until) step();
		state();
	};
	const has = (pred: (e: InfEvent) => boolean) => log.some(pred);
	/** Run until `done()`; fails the test when it never happens. */
	const until = (done: () => boolean, maxMs = 4000) => {
		const deadline = clock.now + maxMs;
		while (clock.now < deadline && !done()) step();
		state();
		expect(done()).toBe(true);
	};
	const tick = (id: number, t: Vec3) => {
		const o = pos.get(id)!;
		const dz = t.z - (o.z + VIEW_HEIGHT);
		const pitch = (-Math.atan2(dz, Math.hypot(t.x - o.x, t.y - o.y)) * 180) / Math.PI;
		const yaw = (Math.atan2(t.y - o.y, t.x - o.x) * 180) / Math.PI;
		clients.get(id)!.tick(clock.now, o, o.z + VIEW_HEIGHT, pitch, yaw, false);
	};
	/** Hold attack aimed at `t` until `done()`. */
	const attack = (id: number, t: Vec3, done: () => boolean, maxMs = 4000) => {
		const c = clients.get(id)!;
		c.press('attack', true, clock.now);
		const deadline = clock.now + maxMs;
		while (clock.now < deadline && !done()) {
			tick(id, t);
			step();
		}
		c.press('attack', false, clock.now);
		state();
		expect(done()).toBe(true);
	};
	const earned = (id: number) => [...shown.get(id)!.values()].reduce((sum, p) => sum + p.points, 0);
	const labels = (id: number) => [...shown.get(id)!.values()].map((p) => `+${p.points} ${p.label}`);

	game.syncPlayers(ids, clock.now);
	advance(1200);
	expect(game.phase).toBe('playing');
	return { game, clock, clients, pos, log, put, state, step, advance, has, until, tick, attack, earned, labels, scores: () => finalScores };
}

describe('real rounds: the popups add up to the server score', () => {
	// Recoil and spread draw from Math.random: a fixed sequence, so a streak never misses by chance.
	beforeEach(() => {
		let a = 0x5eed;
		vi.spyOn(Math, 'random').mockImplementation(() => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it('kills, a beacon, claws and thrown-knife infections, survive bonuses; the infected win', () => {
		const h = round([1, 2, 3, 4]);
		const c = (id: number) => h.clients.get(id)!;
		h.put(1, 0, 0);
		h.put(2, 150, 0, 0.25, 180);
		h.put(3, -300, 300);
		h.put(4, 600, 600);
		h.state();

		// Survivor 2 shoots Patient Zero (in front of him, looking along +x): arcs from the front, then the kill.
		c(1).viewYaw = 0;
		h.attack(2, body(h.pos.get(1)!), () => h.has((e) => e.e === 'kill' && e.targetId === 1));
		const hurts = h.log.filter((e) => e.e === 'hurt' && e.id === 1).length;
		expect(hurts).toBeGreaterThan(0);
		expect(h.labels(2)).toEqual(['+100 Kill']);
		expect(h.earned(1)).toBe(0);

		// Patient Zero respawns, plants a beacon; survivor 2 shoots it.
		h.until(() => h.game.playerView(1)!.alive);
		h.put(1, 0, 0);
		h.state();
		expect(c(1).placeBeacon(h.clock.now)).toBe(true);
		const placed = h.log.find((e): e is Extract<InfEvent, { e: 'beaconPlace' }> => e.e === 'beaconPlace')!;
		h.put(1, -600, -600);
		h.state();
		h.attack(2, { x: placed.x, y: placed.y, z: placed.z + INF_BEACON_HIT_Z }, () => h.has((e) => e.e === 'beaconDestroy' && e.by === 2));
		expect(h.labels(2)).toEqual(['+100 Kill', '+50 Beacon']);

		// Patient Zero knifes survivor 3: 150 for him, 25 for the two survivors left.
		c(1).slot(3, h.clock.now);
		h.put(1, -340, 300);
		h.state();
		h.attack(1, body(h.pos.get(3)!), () => h.has((e) => e.e === 'infect' && e.id === 3));
		expect(h.labels(1)).toEqual(['+150 Infection']);
		expect(h.labels(3)).toEqual([]);
		expect(h.labels(4)).toEqual(['+25 Survived']);

		// Player 3, now infected, throws the knife at survivor 4.
		h.put(3, 600, 350);
		h.state();
		c(3).press('attack2', true, h.clock.now);
		h.tick(3, { x: 600, y: 600, z: 52 });
		c(3).press('attack2', false, h.clock.now);
		h.until(() => h.has((e) => e.e === 'infect' && e.id === 4));
		expect(h.log.find((e) => e.e === 'infect' && e.id === 4)).toMatchObject({ by: 3, method: 'knife' });
		expect(h.labels(3)).toEqual(['+200 Thrown knife']);

		// Claws on the last survivor: everyone is infected.
		h.put(1, 110, 0);
		h.state();
		h.attack(1, body(h.pos.get(2)!), () => h.has((e) => e.e === 'end'));
		expect(h.log.find((e) => e.e === 'end')).toMatchObject({ winner: 'infected' });

		const scores = h.scores()!;
		for (const id of [1, 2, 3, 4]) expect([id, h.earned(id)]).toEqual([id, scores.get(id)]);
		expect(scores.get(2)).toBe(INF_SCORE_KILL + INF_SCORE_BEACON_DESTROY + 2 * INF_SCORE_SURVIVE_TICK);
		expect(h.labels(2)).toEqual(['+100 Kill', '+50 Beacon', '+25 Survived', '+25 Survived']);
		expect(scores.get(1)).toBe(2 * INF_SCORE_INFECT);
	});

	it('a kill streak to Specialist and a M.O.A.B.: caller and every living survivor are paid, the survivors win', () => {
		const h = round([1, 2, 3], { respawnSecs: 0.2, moabKills: 8, moabCountdownSecs: 1 });
		const c2 = h.clients.get(2)!;
		h.put(2, 150, 0, 0.25, 180);
		h.put(3, -300, 300);
		for (let n = 1; n <= 8; n++) {
			h.until(() => h.game.playerView(1)!.alive);
			h.put(1, 0, 0);
			h.state();
			h.attack(2, body(h.pos.get(1)!), () => h.log.filter((e) => e.e === 'kill' && e.by === 2).length >= n);
		}
		expect(h.has((e) => e.e === 'perk' && e.id === 2 && e.perk === 'specialist')).toBe(true);
		expect(h.has((e) => e.e === 'moabReady' && e.id === 2)).toBe(true);
		expect(c2.callMoab(h.clock.now)).toBe(true);
		h.until(() => h.has((e) => e.e === 'end'));
		expect(h.has((e) => e.e === 'moabDetonate' && e.by === 2)).toBe(true);
		expect(h.log.find((e) => e.e === 'end')).toMatchObject({ winner: 'survivors' });

		const scores = h.scores()!;
		for (const id of [1, 2, 3]) expect([id, h.earned(id)]).toEqual([id, scores.get(id)]);
		expect(scores.get(2)).toBe(8 * INF_SCORE_KILL + INF_SCORE_SPECIALIST + INF_SCORE_MOAB + INF_SCORE_SURVIVE_WIN);
		expect(h.labels(2).slice(-2)).toEqual(['+500 M.O.A.B.', '+250 Round won']);
		expect(h.labels(2)).toContain('+250 Specialist');
		expect(h.labels(3)).toEqual(['+250 Round won']);
		expect(h.labels(1)).toEqual([]);
	});

	it('the clock runs out: every survivor is paid for the round', () => {
		const h = round([1, 2, 3], { roundSecs: 1 });
		h.until(() => h.has((e) => e.e === 'end'));
		expect(h.log.find((e) => e.e === 'end')).toMatchObject({ winner: 'survivors', survivorsLeft: 2 });
		const scores = h.scores()!;
		for (const id of [1, 2, 3]) expect([id, h.earned(id)]).toEqual([id, scores.get(id)]);
		expect([h.labels(1), h.labels(2), h.labels(3)]).toEqual([[], ['+250 Round won'], ['+250 Round won']]);
	});

	it('a real hit shows where it came from, also after turning', () => {
		// The shot leaves along the aim (random 0: no aim spread), so only the 2 degree steps of the arc remain.
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const h = round([1, 2, 3]);
		const c1 = h.clients.get(1)!;
		h.put(1, 0, 0);
		h.put(2, 0, 200, 0.25, -90); // survivor 2 stands at +y: on Patient Zero's left
		h.put(3, -300, 300);
		h.state();
		c1.viewYaw = 0;
		h.attack(2, body(h.pos.get(1)!), () => h.has((e) => e.e === 'hurt' && e.id === 1));
		const v = c1.frame(h.clock.now, true, 0);
		expect(v.hurtDirs!.length).toBeGreaterThan(0);
		// The 2 degree steps of the arc: within 3 degrees of the left.
		for (const d of v.hurtDirs!) expect(Math.abs(d.bearing + 90)).toBeLessThanOrEqual(3);
		c1.viewYaw = 90; // facing the shooter
		expect(Math.abs(c1.frame(h.clock.now, true, 0).hurtDirs![0]!.bearing)).toBeLessThanOrEqual(3);
		vi.restoreAllMocks();
	});
});
