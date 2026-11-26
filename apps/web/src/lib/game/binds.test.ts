import { describe, expect, it } from 'vitest';
import { Binds, DEFAULT_BINDS, normalizeKeyName } from './binds.js';
import { keyNameFromCode, mouseButtonName } from '../input/keys.js';
import { memoryStore, STORAGE_KEYS, writeJson } from './storage.js';

describe('binds', () => {
	it('has the documented defaults', () => {
		const b = new Binds(memoryStore());
		expect(b.get('w')).toBe('+forward');
		expect(b.get('space')).toBe('+jump');
		expect(b.get('mwheeldown')).toBe('+jump');
		expect(b.get('ctrl')).toBe('+duck');
		expect(b.get('y')).toBe('messagemode');
		expect(b.get('tab')).toBe('+showscores');
		expect(b.get('3')).toBe('slot 3');
		expect(b.get('m')).toBe('spectate');
		expect(b.get('r')).toBe('restart');
		expect(b.get('`')).toBe('toggleconsole');
		expect(b.get('e')).toBe('beacon');
		expect(b.get('n')).toBe('moab');
	});
	it('gives an older saved table the newly added E beacon bind once', () => {
		const store = memoryStore();
		writeJson(store, STORAGE_KEYS.binds, { w: '+forward', mouse1: '+attack' });
		const a = new Binds(store);
		expect(a.get('e')).toBe('beacon');
		expect(a.get('w')).toBe('+forward');
		expect(a.get('r')).toBeUndefined(); // only ADDED_DEFAULTS are filled in
		a.unbind('e');
		expect(new Binds(store).get('e')).toBeUndefined(); // the unbind sticks
	});
	it('does not take E when it is bound to something else, or beacon is on another key', () => {
		const s1 = memoryStore();
		writeJson(s1, STORAGE_KEYS.binds, { e: '+duck' });
		expect(new Binds(s1).get('e')).toBe('+duck');
		const s2 = memoryStore();
		writeJson(s2, STORAGE_KEYS.binds, { f: 'beacon' });
		const b = new Binds(s2);
		expect(b.get('e')).toBeUndefined();
		expect(b.get('f')).toBe('beacon');
	});
	it('gives an older table the Zombie Defense and Tournament keys (5-9, B shop, F ready, G bracket) once', () => {
		const store = memoryStore();
		writeJson(store, STORAGE_KEYS.binds, { w: '+forward', e: 'beacon', n: 'moab' });
		writeJson(store, `${STORAGE_KEYS.binds}.offered`, ['e', 'n']);
		const a = new Binds(store);
		expect(a.get('5')).toBe('slot 5');
		expect(a.get('9')).toBe('slot 9');
		expect(a.get('b')).toBe('shop');
		expect(a.get('f')).toBe('ready');
		expect(a.get('g')).toBe('+bracket');
		a.unbind('b');
		expect(new Binds(store).get('b')).toBeUndefined();
	});
	it('gives a table saved after the E offer the new N moab bind once, and keeps E', () => {
		const store = memoryStore();
		writeJson(store, STORAGE_KEYS.binds, { w: '+forward', e: 'beacon' });
		writeJson(store, `${STORAGE_KEYS.binds}.offered`, ['e']);
		const a = new Binds(store);
		expect(a.get('n')).toBe('moab');
		expect(a.get('e')).toBe('beacon');
		a.unbind('n');
		expect(new Binds(store).get('n')).toBeUndefined(); // the unbind sticks
		// E was unbound before N arrived: it stays unbound.
		const s2 = memoryStore();
		writeJson(s2, STORAGE_KEYS.binds, { w: '+forward' });
		writeJson(s2, `${STORAGE_KEYS.binds}.offered`, ['e']);
		const b = new Binds(s2);
		expect(b.get('e')).toBeUndefined();
		expect(b.get('n')).toBe('moab');
	});
	it('does not take N when it is bound to something else, or moab is on another key', () => {
		const s1 = memoryStore();
		writeJson(s1, STORAGE_KEYS.binds, { n: 'say gg' });
		expect(new Binds(s1).get('n')).toBe('say gg');
		const s2 = memoryStore();
		writeJson(s2, STORAGE_KEYS.binds, { g: 'moab' });
		const b = new Binds(s2);
		expect(b.get('n')).toBeUndefined();
		expect(b.get('g')).toBe('moab');
	});
	it('normalises key names', () => {
		expect(normalizeKeyName('SPACE')).toBe('space');
		expect(normalizeKeyName('~')).toBe('`');
		expect(normalizeKeyName('LCTRL')).toBe('ctrl');
		expect(normalizeKeyName('esc')).toBeNull();
		expect(normalizeKeyName('')).toBeNull();
	});
	it('persists bind and unbind', () => {
		const store = memoryStore();
		const a = new Binds(store);
		a.bind('MOUSE3', '+duck');
		a.unbind('r');
		const b = new Binds(store);
		expect(b.get('mouse3')).toBe('+duck');
		expect(b.get('r')).toBeUndefined();
		b.reset();
		expect(new Binds(store).entries()).toEqual(Object.entries(DEFAULT_BINDS).sort(([x], [y]) => x.localeCompare(y)));
	});
	it('maps DOM codes to bind names', () => {
		expect(keyNameFromCode('KeyW')).toBe('w');
		expect(keyNameFromCode('Digit1')).toBe('1');
		expect(keyNameFromCode('ControlLeft')).toBe('ctrl');
		expect(keyNameFromCode('Backquote')).toBe('`');
		expect(keyNameFromCode('F5')).toBe('f5');
		expect(keyNameFromCode('Space')).toBe('space');
		expect(mouseButtonName(0)).toBe('mouse1');
		expect(mouseButtonName(1)).toBe('mouse3');
		expect(mouseButtonName(2)).toBe('mouse2');
	});
});
