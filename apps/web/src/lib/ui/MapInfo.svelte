<script lang="ts">
	import { gameMode, type GameModeId } from '@surf/shared';

	/** Top-centre map line: the map of this lobby and its gamemode (docs/ui.md#hud). */
	let { mapId, mode }: { mapId: string; mode: GameModeId } = $props();
</script>

<div class="mapinfo ss-panel ss-shadow">
	<span class="map">{mapId}</span>
	<span class="dot">·</span>
	<span class="mode">{gameMode(mode).label}</span>
</div>

<style>
	.mapinfo {
		display: inline-flex;
		align-items: baseline;
		gap: 8px;
		padding: 4px 14px;
		font-size: calc(15px * var(--hud-scale));
	}
	.map {
		font-weight: 600;
		letter-spacing: 0.04em;
	}
	.dot {
		color: var(--text-faint);
	}
	.mode {
		color: var(--text-dim);
	}
</style>
