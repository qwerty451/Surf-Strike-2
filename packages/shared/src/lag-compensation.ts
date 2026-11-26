/** Limit how much transport RTT contributes to the combat rewind window. */
export const MAX_REWIND_RTT_MS = 150;
/** Largest client interpolation delay accepted by render-time rewind. */
export const MAX_RENDER_INTERPOLATION_MS = 200;
/** Allow for clock estimation and the frame between aiming and sending the shot. */
export const RENDER_TIME_SLACK_MS = 32;

/** Maximum growth and shrink of the adaptive client delay per ms of wall time. */
export const RENDER_DELAY_GROW_RATE = 0.45;
export const RENDER_DELAY_SHRINK_RATE = 0.12;

export function renderTimeBudgetMs(rttMs: number): number {
	return rttMs + MAX_RENDER_INTERPOLATION_MS + RENDER_TIME_SLACK_MS;
}

/** Validate a claimed server timestamp, then clamp it to the mode's available history. */
export function clampRenderTime(claimedMs: number, nowMs: number, rttMs: number, historyMs: number): number | null {
	if (!Number.isFinite(claimedMs) || !Number.isFinite(nowMs) || !Number.isFinite(rttMs) || !Number.isFinite(historyMs)) return null;
	if (rttMs <= 0 || historyMs < 0) return null;
	const age = nowMs - claimedMs;
	if (age < 0 || age > renderTimeBudgetMs(rttMs)) return null;
	return Math.max(claimedMs, nowMs - historyMs);
}
