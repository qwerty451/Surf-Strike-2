import { describe, expect, it, vi } from 'vitest';
import { getMap, Status, type ClientMessage, type MapDef, type NetState, type TrnEvent, type TrnStateView } from '@surf/shared';
import { mockBracket } from '../../ui/tournament-mock.js';
import type { TournamentView } from '../contract.js';
import { fakeHost } from './armed-test-host.js';
import { createClientMode } from './index.js';
import { deckSpawn, TournamentMode } from './tournament.js';

const base = getMap('tag_quayside')!;
const deck = [
	{ pos: { x: 100, y: 0, z: 500 }, yaw: 0 },
	{ pos: { x: 120, y: 0, z: 500 }, yaw: 90 }
];
const map: MapDef = {
	...base,
	kind: 'tournament',
	tournament: {
		duelSpawns: [
			{ pos: { x: -200, y: 0, z: 0 }, yaw: 0 },
			{ pos: { x: 200, y: 0, z: 0 }, yaw: 180 }
		],
		arena: { min: { x: -300, y: -300, z: 0 }, max: { x: 300, y: 300, z: 200 } },
		deck: { min: { x: -300, y: -300, z: 480 }, max: { x: 300, y: 300, z: 520 } },
		deckSpawns: deck
	}
};

const SELF = 7;

/** 8 entrants: me (7) against 3 in round 0 match 1; bets on it. */
function trnState(p: Partial<TrnStateView> = {}): TrnStateView {
	const bracket = mockBracket(8, 0);
	const m = bracket.matches[1]!;
	m.a = 3;
	m.b = SELF;
	bracket.entrants.find((e) => e.id === SELF)!.name = 'Me';
	return {
		phase: 'duel',
		tournament: 1,
		round: 1,
		timeLeft: 90,
		bracket,
		duel: { match: 1, round: 1, hp: [100, 100], freeze: 0 },
		bets: null,
		champion: null,
		...p
	};
}

function setup(online = true) {
	const f = fakeHost(map, 'tournament');
	f.host.online = online;
	const sent: ClientMessage[] = [];
	f.host.send = (m) => void sent.push(m);
	const teleports: unknown[] = [];
	f.host.teleport = (s) => void teleports.push(s);
	(f.host.hud as unknown as { account: unknown }).account = { username: 'me' };
	const mode = createClientMode(f.host) as TournamentMode;
	const view = () => f.hudWrites.at(-1) as TournamentView;
	const state = (s: TrnStateView, now = 1000) => mode.message({ type: 'modeState', mode: 'tournament', ...s }, now);
	const ev = (e: TrnEvent, now = 1000) => mode.message({ type: 'trn', ev: e }, now);
	return { ...f, mode, sent, teleports, view, state, ev };
}

const spawn = (role: 'duelist' | 'spectator', freezeSecs = 0): TrnEvent => ({ e: 'spawn', id: SELF, role, pos: { x: 1, y: 2, z: 3 }, yaw: 90, freezeSecs });

describe('tournament client mode', () => {
	it('is the tournament family module and starts on the deck', () => {
		const { mode, view } = setup();
		expect(mode).toBeInstanceOf(TournamentMode);
		expect(mode.id).toBe('tournament');
		expect(view()).toMatchObject({ phase: 'waiting', knifeOnly: true, weapon: 'knife' });
		expect(deck).toContainEqual(deckSpawn(map));
		expect(deckSpawn({ ...map, tournament: undefined })).toBe(map.spawn);
	});

	it('offline: solo banner, free roam, no throws', () => {
		const { mode, view } = setup(false);
		mode.frame(5);
		expect(view().phase).toBe('solo');
		expect(() => mode.tick(5, 5)).not.toThrow();
		expect(mode.soloRow()).toMatchObject({ status: Status.Spectating });
	});

	it('spawn teleports with freeze: no movement until it ends', () => {
		const { mode, teleports, ev, host } = setup();
		ev(spawn('duelist', 3), 1000);
		expect(teleports).toEqual([{ pos: { x: 1, y: 2, z: 3 }, yaw: 90 }]);
		host.player.velocity.x = 50;
		expect(mode.moveCvars(2000)).toBeNull();
		expect(host.player.velocity.x).toBe(0);
		const cv = mode.moveCvars(4100);
		expect(cv).not.toBeNull();
		expect(cv!.sv_maxspeed).toBeLessThanOrEqual(host.sv.sv_maxspeed);
	});

	it('duelists: sniper, pistol, knife on 1/2/3, sent as loadout', () => {
		const { mode, ev, sent, state, view } = setup();
		state(trnState());
		ev(spawn('duelist'));
		mode.frame(1000);
		expect(view()).toMatchObject({ knifeOnly: false, weapon: 'sniper', role: 'duelist' });
		expect(mode.slot(2, 1100)).toBe(true);
		expect(mode.slot(3, 1200)).toBe(true);
		expect(mode.slot(1, 1300)).toBe(true);
		expect(sent.filter((m) => m.type === 'loadout').map((m) => (m as { weapon: string }).weapon)).toEqual(['pistol', 'knife', 'sniper']);
		const s: NetState = { status: 0, stage: 1, runTicks: 1 } as NetState;
		mode.netState(s);
		expect(s.status).toBe(Status.Alive);
	});

	it('duelists fire once the draw is over: a fire message, ammo from the server', () => {
		const { mode, ev, sent, state, view } = setup();
		state(trnState());
		ev(spawn('duelist'));
		mode.press('attack', true, 2000);
		mode.tick(2000, 2000);
		mode.press('attack', false, 2010);
		const fire = sent.find((m) => m.type === 'fire') as Extract<ClientMessage, { type: 'fire' }>;
		expect(fire).toMatchObject({ type: 'fire', weapon: 'sniper' });
		expect(Math.hypot(fire.dir.x, fire.dir.y, fire.dir.z)).toBeCloseTo(1, 5);
		ev({ e: 'ammo', weapon: 'sniper', mag: 3, reserve: 9 });
		mode.frame(2100);
		expect(view()).toMatchObject({ mag: 3, reserve: 9 });
		mode.restart(2200);
		expect(sent.some((m) => m.type === 'reload')).toBe(true);
	});

	it('no firing during the freeze', () => {
		const { mode, ev, sent, state } = setup();
		state(trnState({ duel: { match: 1, round: 1, hp: [100, 100], freeze: 3 } }), 1000);
		ev(spawn('duelist', 3), 1000);
		mode.press('attack', true, 1500);
		mode.tick(1500, 1500);
		expect(sent.some((m) => m.type === 'fire')).toBe(false);
	});

	it('spectators: knife only; swings go out as fire with the knife', () => {
		const { mode, ev, sent, state, view } = setup();
		state(trnState({ duel: { match: 0, round: 1, hp: [100, 100], freeze: 0 } }));
		ev(spawn('spectator'));
		mode.frame(1000);
		expect(view()).toMatchObject({ knifeOnly: true, weapon: 'knife', role: 'spectator' });
		expect(mode.slot(1, 1100)).toBe(false);
		mode.press('attack', true, 1500);
		mode.tick(1500, 1500);
		expect(sent.filter((m) => m.type === 'fire').map((m) => (m as { weapon: string }).weapon)).toEqual(['knife']);
		expect(sent.some((m) => m.type === 'loadout')).toBe(false);
	});

	it('hits mark, kills feed, tracers of others draw', () => {
		const { mode, ev, state, view, renderer } = setup();
		state(trnState());
		ev(spawn('duelist'));
		ev({ e: 'hit', by: SELF, target: 3, part: 'head', dmg: 100, hp: 0 }, 1500);
		ev({ e: 'kill', by: SELF, target: 3, weapon: 'sniper', head: true, deck: false }, 1500);
		ev({ e: 'shot', id: 3, weapon: 'pistol', origin: { x: 0, y: 0, z: 64 }, end: { x: 100, y: 0, z: 64 } }, 1500);
		mode.frame(1500);
		expect(view().hitMarker).toEqual({ at: 1500, head: true, kill: true });
		expect(view().killFeed.map((k) => k.text)).toEqual(['You · Sniper rifle · headshot › cirrus']);
		expect(vi.mocked(renderer.zombies!.tracer)).toHaveBeenCalled();
		// The other duelist holds what they fired.
		const players = renderer.players!;
		mode.dress(players, { id: 3, name: 'P3', spectating: false, sample: {} as never, hasSample: true });
		expect(vi.mocked(players.setHeld)).toHaveBeenCalledWith(3, 'pistol');
	});

	it('killed: down until the next spawn', () => {
		const { mode, ev, state } = setup();
		state(trnState());
		ev(spawn('duelist'));
		ev({ e: 'kill', by: 3, target: SELF, weapon: 'sniper', head: false, deck: false });
		expect(mode.moveCvars(1100)).toBeNull();
		ev(spawn('duelist', 0), 1200);
		expect(mode.moveCvars(1300)).not.toBeNull();
	});

	it('duel bar: both sides, wins, hp and freeze', () => {
		const { mode, state, view } = setup();
		const s = trnState({ duel: { match: 1, round: 2, hp: [40, 75], freeze: 2 } });
		s.bracket!.matches[1]!.wins = [1, 0];
		state(s, 1000);
		mode.frame(1000);
		const d = view().duel!;
		expect(d.a).toMatchObject({ id: 3, name: 'cirrus', hp: 40, wins: 1, self: false });
		expect(d.b).toMatchObject({ id: SELF, name: 'Me', hp: 75, wins: 0, self: true });
		expect(d.freezeUntil).toBe(3000);
		expect(view().roundLabel).toBe('Quarterfinal');
	});

	it('bets: keys 1/2 and the panel send trnBet; the answer and outcome show', () => {
		const { mode, state, view, sent, ev } = setup();
		const s = trnState({ duel: { match: 0, round: 1, hp: [100, 100], freeze: 5 }, bets: { match: 0, open: true, count: [1, 2] } });
		state(s);
		mode.frame(1000);
		expect(view().bet).toMatchObject({ canBet: true, a: { id: 1, count: 1 }, b: { id: 2, count: 2 } });
		expect(mode.slot(2, 1000)).toBe(true);
		expect(sent.at(-1)).toEqual({ type: 'trnBet', pick: 2 });
		mode.bet(1);
		expect(sent.at(-1)).toEqual({ type: 'trnBet', pick: 1 });
		ev({ e: 'bet', ok: true, match: 0, pick: 2 }, 1100);
		mode.frame(1100);
		expect(view().bet).toMatchObject({ canBet: false, mine: { pick: 2, name: 'glidepath' }, note: { text: 'Your bet: 20 on glidepath', tone: 'ok' } });
		expect(mode.slot(1, 1200)).toBe(false);
		ev({ e: 'betResult', match: 0, outcome: 'won', payout: 40 }, 1300);
		mode.frame(1300);
		expect(view().bet?.note).toMatchObject({ text: 'Bet won · +40 coins', tone: 'won' });
	});

	it('bets: a refusal shows its reason; duelists and guests get no buttons', () => {
		const { mode, state, view, ev, host } = setup();
		state(trnState({ bets: { match: 1, open: true, count: [0, 0] } }));
		mode.frame(1000);
		expect(view().bet?.canBet).toBe(false); // I duel in match 1
		state(trnState({ duel: { match: 0, round: 1, hp: [100, 100], freeze: 5 }, bets: { match: 0, open: true, count: [0, 0] } }));
		ev({ e: 'bet', ok: false, match: 0, pick: null, reason: 'coins' }, 1100);
		mode.frame(1100);
		expect(view().bet?.note).toMatchObject({ tone: 'bad', text: 'Not enough coins (bet is 20)' });
		(host.hud as unknown as { account: unknown }).account = null;
		mode.frame(1200);
		expect(view().bet?.canBet).toBe(false);
	});

	it('a map vote takes the number keys', () => {
		const { mode, state, host } = setup();
		state(trnState());
		host.voteOpen = true;
		expect(mode.slot(1, 1000)).toBe(false);
	});

	it('the bracket shows by itself between duels and at the end', () => {
		const { mode, state, view, ev } = setup();
		state(trnState({ phase: 'bracket', duel: null }));
		mode.frame(1000);
		expect(view().showBracket).toBe(true);
		state(trnState({ phase: 'ended', duel: null, champion: SELF }));
		ev({ e: 'champion', tournament: 1, id: SELF, entrants: 9, prize: 32 }, 1000);
		mode.frame(1000);
		expect(view()).toMatchObject({ showBracket: true, champion: { id: SELF, self: true }, flash: { text: 'You win the tournament!', tone: 'gold' } });
	});

	it('late joiners are told to wait', () => {
		const { mode, state, view } = setup();
		const s = trnState();
		s.bracket!.entrants = s.bracket!.entrants.filter((e) => e.id !== SELF);
		state({ ...s, duel: { match: 0, round: 1, hp: [100, 100], freeze: 0 } });
		mode.frame(1000);
		expect(view()).toMatchObject({ late: true, role: 'spectator' });
	});

	it('dispose clears the HUD and the zoom', () => {
		const { mode, host, renderer } = setup();
		mode.dispose();
		expect(host.hud.tournament).toBeNull();
		expect(vi.mocked(renderer.setFov)).toHaveBeenLastCalledWith(101);
	});
});
