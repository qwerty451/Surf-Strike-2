import { describe, expect, it } from 'vitest';
import { GAME_MODE_IDS } from '@surf/shared';
import { fitPanel, hudScale, PANEL_WIDTHS, panelArea } from './score-panel.js';

describe('fitPanel', () => {
	it('a normal window fits every mode with its full list', () => {
		for (const mode of GAME_MODE_IDS) {
			for (const [w, h] of [[1920, 1080], [1366, 768], [2560, 1440], [3840, 2160]] as const) {
				const f = fitPanel(w, h, mode, 2);
				expect(f.size, `${mode} ${w}x${h}`).toBe('full');
				expect(f.hidden).toBe(false);
				expect(f.rows, `${mode} ${w}x${h}`).toBeGreaterThanOrEqual(8);
			}
		}
	});
	it('collapses with the width: compact, your row only, hidden', () => {
		expect(fitPanel(PANEL_WIDTHS.compact - 1, 800, 'tag', 0).size).toBe('compact');
		expect(fitPanel(PANEL_WIDTHS.mini - 1, 800, 'tag', 0)).toEqual({ size: 'mini', rows: 1, hidden: false });
		expect(fitPanel(PANEL_WIDTHS.hidden - 1, 800, 'tag', 0).hidden).toBe(true);
	});
	it('fewer rows in a low window, the summary alone, then nothing', () => {
		const rows = [700, 560, 480, 430].map((h) => fitPanel(1280, h, 'infected', 0).rows);
		expect(rows).toEqual([...rows].sort((a, b) => b - a));
		expect(rows[0]).toBeGreaterThan(rows[2]!);
		expect(fitPanel(1280, 360, 'infected', 0).hidden).toBe(true);
		expect(fitPanel(1280, 225, 'surf', 2)).toMatchObject({ rows: 1, hidden: false });
		expect(fitPanel(1280, 210, 'surf', 2)).toMatchObject({ rows: 0, hidden: false });
		expect(fitPanel(1280, 180, 'surf', 2).hidden).toBe(true);
	});
	it('before the window size is known nothing shows', () => {
		expect(fitPanel(0, 0, 'surf', 2).hidden).toBe(true);
	});
	it('the kill feed modes start below a full feed', () => {
		for (const mode of ['zombies', 'infected', 'hns', 'defense'] as const) expect(panelArea(mode).top.px).toBeGreaterThan(panelArea('surf').top.px);
	});
	it('hud scale is the one of theme.css', () => {
		expect([500, 1080, 1620, 4000].map(hudScale)).toEqual([0.85, 1, 1.5, 1.6]);
	});
});
