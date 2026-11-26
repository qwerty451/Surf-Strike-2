/**
 * Space for the score panel (docs/ui.md#score-panel): the free strip on the
 * right between other HUD elements, and how much of the panel fits in it. No
 * DOM, no Svelte: unit-tested in node. What the panel shows is defined per mode
 * in packages/shared/src/modes/score.ts.
 */
import type { GameModeId } from '@surf/shared';

/** A length `px + scaled × --hud-scale`, as the HUD's own offsets are written. */
interface Len {
	px: number;
	scaled: number;
}
/** Space other HUD elements take on the right edge, from the top and from the bottom. */
export interface PanelArea {
	top: Len;
	bottom: Len;
}

/** Below the connection status. */
const TOP: Len = { px: 64, scaled: 0 };
/** Below a full kill feed (KILL_FEED_MAX lines from 54 px). */
const BELOW_KILL_FEED: Len = { px: 96, scaled: 84 };
const BOTTOM: Len = { px: 40, scaled: 0 };

const AREAS: Partial<Record<GameModeId, PanelArea>> = {
	// Above health and weapon.
	zombies: { top: BELOW_KILL_FEED, bottom: { px: 34, scaled: 74 } },
	// Above health, weapon, the perk track and its toast.
	infected: { top: BELOW_KILL_FEED, bottom: { px: 34, scaled: 186 } },
	hns: { top: BELOW_KILL_FEED, bottom: BOTTOM },
	// Below the kill feed, above the weapon panel.
	tournament: { top: BELOW_KILL_FEED, bottom: { px: 34, scaled: 74 } }
};

export function panelArea(mode: GameModeId): PanelArea {
	return AREAS[mode] ?? { top: TOP, bottom: BOTTOM };
}

export function cssLen(l: Len): string {
	return `calc(${l.px}px + ${l.scaled}px * var(--hud-scale))`;
}

/** `--hud-scale` of theme.css. */
export function hudScale(windowHeight: number): number {
	return Math.min(1.6, Math.max(0.85, windowHeight / 1080));
}

// Heights at scale 1; ScorePanel.svelte sets them as fixed line heights.
export const PANEL_ROW = 21;
export const PANEL_HEAD = 44;
export const PANEL_LINE = 20;
/** Borders, paddings and gaps (not scaled). */
export const PANEL_CHROME = 22;

export type PanelSize = 'full' | 'compact' | 'mini';

export interface PanelFit {
	/** full; compact: narrower, without minor columns; mini: only your own row. */
	size: PanelSize;
	/** List rows that fit (0: only the summary). */
	rows: number;
	/** No room at all. */
	hidden: boolean;
}

/** Widths below which the panel shrinks, then shows only your row, then goes away. */
export const PANEL_WIDTHS = { compact: 1000, mini: 820, hidden: 480 } as const;

export function fitPanel(windowWidth: number, windowHeight: number, mode: GameModeId, summaryLines: number): PanelFit {
	const s = hudScale(windowHeight);
	const { top, bottom } = panelArea(mode);
	const space = windowHeight - (top.px + bottom.px) - (top.scaled + bottom.scaled) * s;
	const size: PanelSize = windowWidth < PANEL_WIDTHS.mini ? 'mini' : windowWidth < PANEL_WIDTHS.compact ? 'compact' : 'full';
	const left = space - PANEL_CHROME - (PANEL_HEAD + summaryLines * PANEL_LINE) * s;
	const rows = Math.max(0, Math.floor(left / (PANEL_ROW * s)));
	return {
		size,
		rows: size === 'mini' ? Math.min(1, rows) : rows,
		hidden: windowWidth < PANEL_WIDTHS.hidden || left < 0 || (rows === 0 && summaryLines === 0)
	};
}
