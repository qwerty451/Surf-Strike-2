/**
 * Engine entry point (contract.ts): `createGame(canvas)` returns the reactive
 * HUD state, the API the UI calls, and `destroy()`.
 */
import type { GameApi, GameHandle } from './contract.js';
import { Game } from './game.js';
import { HudState } from './hud.svelte.js';

/** Touch-only device: no fine pointer and no hover anywhere. */
export function isTouchOnly(): boolean {
	if (typeof matchMedia !== 'function') return false;
	try {
		return !matchMedia('(any-pointer: fine)').matches && !matchMedia('(any-hover: hover)').matches;
	} catch {
		return false;
	}
}

const noop = () => {};
const inertApi: GameApi = {
	exec: noop,
	complete: () => [],
	history: () => [],
	sendChat: noop,
	setCvar: noop,
	login: noop,
	register: noop,
	logout: noop,
	playAsGuest: noop,
	openAuth: noop,
	closeAuth: noop,
	lockPointer: noop,
	openChat: noop,
	closeChat: noop,
	toggleConsole: noop,
	closeSettings: noop,
	changeMap: noop,
	minimizeBan: noop,
	shopBuy: noop,
	boxOpen: noop,
	boxRevealed: noop,
	boxScreen: noop,
	boxSound: noop,
	casinoBet: noop,
	crashCashout: noop,
	casinoSound: noop,
	crashBuild: noop,
	shopEquip: noop,
	createPreview: () => null,
	modeUi: () => {},
	itemPicture: () => Promise.resolve(null),
	trnBet: noop,
	admin: noop
};

export function createGame(canvas: HTMLCanvasElement): GameHandle {
	if (isTouchOnly()) {
		const hud = new HudState();
		hud.desktopOnly = true;
		return { hud, api: inertApi, destroy: noop };
	}
	const game = new Game(canvas);
	// Dev-only QA hook: lets browser automation inspect/script the engine
	// (`window.__surf`). Stripped from production builds by the DEV guard.
	if (import.meta.env.DEV) (globalThis as { __surf?: Game }).__surf = game;
	game.start();
	return { hud: game.hud, api: game.api, destroy: () => game.destroy() };
}

export type { GameApi, GameHandle, HudStateShape } from './contract.js';
