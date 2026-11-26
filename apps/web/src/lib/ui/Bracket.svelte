<script lang="ts">
	import type { TrnStateView } from '@surf/shared';
	import {
		BRACKET_METRICS,
		BRACKET_METRICS_COMPACT,
		bracketModel,
		bracketWindow,
		fitName,
		type BracketSlot
	} from '#lib/ui/bracket-layout.js';

	/**
	 * Tournament bracket tree (docs/ui.md#tournament-hud): shows by itself between
	 * duels and at the end, and while the bracket key (B) is held. One SVG, scaled
	 * to the window; a narrow window drops the earliest rounds first.
	 */
	let { view, selfId, title }: { view: TrnStateView; selfId: number; title: string } = $props();

	/** Unique per instance: clip path ids. */
	const uid = `br${Math.random().toString(36).slice(2, 8)}`;
	let boxW = $state(0);
	/** Narrow windows use the compact metrics. */
	const compact = $derived(boxW > 0 && boxW < 720);
	const metrics = $derived(compact ? BRACKET_METRICS_COMPACT : BRACKET_METRICS);
	const model = $derived(bracketModel(view, selfId, metrics));
	/** Not below 0.72 of the drawn size: text stays readable, early rounds go instead. */
	const win = $derived(model && boxW > 0 ? bracketWindow(model, boxW, 0.72) : null);
	const nameMax = $derived(compact ? 13 : 18);
	const live = $derived(view.phase === 'duel');

	function wins(s: BracketSlot, forfeit: boolean): string {
		if (forfeit && s.state === 'lost') return 'FF';
		return s.wins === null ? '' : String(s.wins);
	}
</script>

<div class="bracket ss-panel ss-shadow" bind:clientWidth={boxW} role="figure" aria-label="Tournament bracket">
	<div class="head">
		<span class="title">{title}</span>
		{#if win && win.from > 0}<span class="cropped">‹ {win.from} earlier round{win.from === 1 ? '' : 's'}</span>{/if}
	</div>
	{#if model && win}
		<svg viewBox={win.viewBox} style:max-width="{win.width}px" preserveAspectRatio="xMidYMin meet">
			{#each model.columns as c (c.round)}
				{#if c.round >= win.from}
					<text class="col" x={c.x + c.w / 2} y={metrics.headH - 9} text-anchor="middle">{c.label}</text>
				{/if}
			{/each}
			{#each model.connectors as l (l.key)}
				<path class="wire" class:lit={l.lit} d={l.d} />
			{/each}
			{#each model.boxes as b (b.key)}
				{@const rowH = b.pos.h / 2}
				<g class="match" class:current={b.current} class:bye={b.bye} class:done={b.done}>
					<clipPath id="{uid}-{b.key}"><rect x={b.pos.x} y={b.pos.y} width={b.pos.w - 30} height={b.pos.h} /></clipPath>
					<rect class="box" x={b.pos.x} y={b.pos.y} width={b.pos.w} height={b.pos.h} rx="3" />
					<line class="mid" x1={b.pos.x} x2={b.pos.x + b.pos.w} y1={b.pos.y + rowH} y2={b.pos.y + rowH} />
					{#each [b.a, b.b] as s, si (si)}
						{@const y = b.pos.y + rowH * si + rowH / 2}
						<g class="slot {s.state}" class:out={s.out} class:self={s.self} class:left={s.left}>
							{#if s.state === 'won'}<rect class="winbar" x={b.pos.x} y={b.pos.y + rowH * si + 2} width="3" height={rowH - 4} />{/if}
							<text class="name" x={b.pos.x + 9} {y} dominant-baseline="central" clip-path="url(#{uid}-{b.key})">{fitName(s.left ? `${s.name} (left)` : s.name, nameMax)}</text>
							<text class="wins" x={b.pos.x + b.pos.w - 8} {y} text-anchor="end" dominant-baseline="central">{wins(s, b.forfeit)}</text>
						</g>
					{/each}
					{#if b.current}
						<text class="tag" x={b.pos.x + b.pos.w} y={b.pos.y - 4} text-anchor="end">{live ? 'LIVE' : 'NEXT'}</text>
					{/if}
				</g>
			{/each}
			{#each [model.champion] as c (c.id)}
			<g class="champ" class:known={c.id !== null} class:self={c.self}>
				<rect class="box" x={c.pos.x} y={c.pos.y} width={c.pos.w} height={c.pos.h} rx="3" />
				<text class="cup" x={c.pos.x + 12} y={c.pos.y + c.pos.h / 2} dominant-baseline="central">★</text>
				<text class="name" x={c.pos.x + 28} y={c.pos.y + c.pos.h / 2} dominant-baseline="central">{fitName(c.name, nameMax - 2)}</text>
				</g>
			{/each}
		</svg>
	{/if}
</div>

<style>
	.bracket {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: min(1100px, calc(100vw - 32px));
		max-height: calc(100vh - 160px);
		padding: 10px 14px 14px;
		background: var(--panel-bg-strong);
		display: flex;
		flex-direction: column;
		gap: 4px;
		pointer-events: none;
		box-sizing: border-box;
	}
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}
	.title {
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		font-size: calc(15px * var(--hud-scale));
	}
	.cropped {
		color: var(--text-faint);
		font-size: 13px;
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
		max-height: calc(100vh - 210px);
		margin: 0 auto;
		font-family: var(--ui-font);
		overflow: hidden;
	}
	.col {
		fill: var(--text-dim);
		font-size: 12px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.wire {
		fill: none;
		stroke: rgba(255, 255, 255, 0.18);
		stroke-width: 1.5;
	}
	.wire.lit {
		stroke: rgba(242, 163, 58, 0.55);
	}
	.box {
		fill: rgba(20, 24, 31, 0.92);
		stroke: rgba(255, 255, 255, 0.16);
		stroke-width: 1;
	}
	.mid {
		stroke: rgba(255, 255, 255, 0.08);
	}
	.match.bye {
		opacity: 0.42;
	}
	.match.current .box {
		stroke: var(--accent);
		stroke-width: 2;
		fill: rgba(60, 40, 12, 0.92);
	}
	.tag {
		fill: var(--accent);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.12em;
	}
	.name {
		fill: var(--text);
		font-size: 14px;
	}
	.wins {
		fill: var(--text-dim);
		font-family: var(--num-font);
		font-size: 15px;
		font-weight: 600;
	}
	.slot.won .name {
		font-weight: 700;
	}
	.slot.won .wins {
		fill: var(--accent);
	}
	.winbar {
		fill: var(--accent);
	}
	.slot.lost .name {
		fill: var(--text-faint);
		text-decoration: line-through;
	}
	.slot.lost .wins {
		fill: var(--text-faint);
	}
	.slot.out .name {
		fill: var(--text-dim);
	}
	.slot.bye .name,
	.slot.tbd .name {
		fill: var(--text-faint);
		font-style: italic;
	}
	.slot.self .name {
		fill: #ffd37a;
	}
	.slot.self.lost .name {
		fill: rgba(255, 211, 122, 0.5);
	}
	.slot.left .name {
		font-style: italic;
	}
	.champ .box {
		stroke: rgba(255, 210, 90, 0.35);
		stroke-dasharray: 4 3;
	}
	.champ.known .box {
		stroke: #ffd25a;
		stroke-width: 2;
		stroke-dasharray: none;
		fill: rgba(70, 52, 8, 0.92);
	}
	.cup {
		fill: rgba(255, 210, 90, 0.5);
		font-size: 14px;
	}
	.champ.known .cup {
		fill: #ffd25a;
	}
	.champ .name {
		fill: var(--text-faint);
	}
	.champ.known .name {
		fill: #ffe7a8;
		font-weight: 700;
	}
</style>
