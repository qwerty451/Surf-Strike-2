<script lang="ts">
	import type { DefenseMenuView } from '#lib/game/contract.js';
	import { fadeOpacity } from '#lib/ui/format.js';

	let {
		menu,
		gold,
		now,
		interactive,
		onpick,
		onclose
	}: { menu: DefenseMenuView; gold: number; now: number; interactive: boolean; onpick: (index: number) => void; onclose: () => void } = $props();

	const noticeOpacity = $derived(menu.notice ? fadeOpacity(now - menu.notice.at, 1600, 600) : 0);
	const priceText = (p: number | null) => (p === null ? '' : p < 0 ? `+${-p}` : String(p));
</script>

<div class="menu ss-panel ss-shadow" role="dialog" aria-label={menu.title}>
	<div class="head">
		<span class="title">{menu.title}</span>
		<span class="gold ss-num" title="Gold">{gold} <span class="coin">g</span></span>
	</div>
	{#if menu.subtitle && menu.kind === 'pad'}<div class="sub">{menu.subtitle}</div>{/if}
	<div class="rows">
		{#each menu.rows as r (r.key)}
			<button
				type="button"
				class="row {r.state}"
				disabled={!interactive}
				onclick={() => onpick(r.key - 1)}
				aria-label="{r.key}: {r.label}"
			>
				<span class="key ss-num">{r.key}</span>
				<span class="body">
					<span class="label">{r.label}{#if r.note}<span class="note ss-num"> {r.note}</span>{/if}</span>
					<span class="detail">{r.detail}</span>
				</span>
				<span class="price ss-num">
					{#if r.state === 'owned'}owned{:else if r.state === 'max'}max{:else if r.state === 'page'}›{:else}{priceText(r.price)}{/if}
				</span>
			</button>
		{/each}
	</div>
	{#if menu.notice && noticeOpacity > 0}
		<div class="notice" class:ok={menu.notice.ok} style:opacity={noticeOpacity}>{menu.notice.text}</div>
	{/if}
	<div class="hint">
		{menu.hint}
		{#if interactive}<button type="button" class="close" onclick={onclose}>close</button>{/if}
	</div>
</div>

<style>
	.menu {
		position: absolute;
		left: 18px;
		top: 26%;
		width: min(390px, 42vw);
		padding: 10px 12px;
		font-size: calc(14px * var(--hud-scale));
		pointer-events: auto;
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 4px;
	}
	.title {
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.gold {
		color: #ffd24a;
		font-weight: 700;
		font-size: 1.15em;
	}
	.coin {
		font-size: 0.75em;
	}
	.sub {
		color: var(--text-dim);
		font-size: 0.9em;
		margin-bottom: 6px;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.row {
		all: unset;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 6px;
		cursor: default;
		border-left: 3px solid transparent;
	}
	.row:not(:disabled) {
		cursor: pointer;
	}
	.row:not(:disabled):hover {
		background: rgba(255, 255, 255, 0.1);
	}
	.row.buy,
	.row.action {
		border-left-color: #9fe08a;
	}
	.row.page {
		border-left-color: rgba(255, 255, 255, 0.35);
	}
	.row.poor .price {
		color: #ff7070;
	}
	.row.poor .label,
	.row.owned,
	.row.max,
	.row.locked {
		opacity: 0.55;
	}
	.key {
		color: #ffd27a;
		font-weight: 700;
		width: 1em;
		text-align: center;
	}
	.body {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.label {
		font-weight: 600;
	}
	.note {
		margin-left: 0.4em;
		color: var(--text-dim);
		font-weight: 400;
		font-size: 0.85em;
	}
	.detail {
		color: var(--text-dim);
		font-size: 0.85em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.price {
		font-weight: 700;
		color: #ffd24a;
		min-width: 3.4em;
		text-align: right;
	}
	.row.owned .price,
	.row.max .price {
		color: #9fe08a;
		font-weight: 600;
	}
	.notice {
		margin-top: 6px;
		color: #ff8a7a;
		font-weight: 600;
	}
	.notice.ok {
		color: #9fe08a;
	}
	.hint {
		margin-top: 6px;
		color: var(--text-dim);
		font-size: 0.85em;
		display: flex;
		justify-content: space-between;
	}
	.close {
		all: unset;
		cursor: pointer;
		text-decoration: underline;
	}
</style>
