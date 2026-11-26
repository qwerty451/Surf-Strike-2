<script lang="ts">
	import { gameMode, scoreboardColumns, splitScoreboard, type GameModeId, type ModeState, type RichEntry, type ScoreRow } from '@surf/shared';
	import RichList from '#lib/ui/RichList.svelte';

	let {
		rows,
		mapTitle,
		mapId,
		playerCount,
		maxPlayers,
		staged,
		mode = 'surf',
		selfId,
		state = null,
		richest = [],
		account = null
	}: {
		rows: ScoreRow[];
		mapTitle: string;
		mapId: string;
		playerCount: number;
		maxPlayers: number;
		staged: boolean;
		mode?: GameModeId;
		/** Row of the local player (highlighted). */
		selfId: number;
		/** Mode state for metrics that need it. */
		state?: ModeState | null;
		/** Accounts with the most coins, richest first. */
		richest?: readonly RichEntry[];
		/** The local player's account (highlighted among them). */
		account?: string | null;
	} = $props();

	const def = $derived(gameMode(mode).score);
	const columns = $derived(scoreboardColumns(def));
	const split = $derived(splitScoreboard(rows, def));
	const ctx = $derived({ state, staged });
</script>

<div class="backdrop">
	<div class="middle">
	<section class="board ss-panel" aria-label="Scoreboard">
		<header>
			<div class="map">
				<span class="title">{mapTitle || mapId}</span>
				{#if mapTitle && mapTitle !== mapId}<span class="id">{mapId}</span>{/if}
			</div>
			<div class="meta">
				<span><span class="ss-label">Mode</span> <span class="ss-num">{gameMode(mode).label}</span></span>
				<span><span class="ss-label">Players</span> <span class="ss-num">{playerCount} / {maxPlayers}</span></span>
			</div>
		</header>
		<div class="scroll">
		<table>
			<thead>
				<tr>
					<th class="name">Name</th>
					{#each columns as col (col.id)}
						<th class:num={col.num} class:minor={col.minor} style:width="calc({col.width} * var(--em))">{col.label}</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each split.players as r (r.id)}
					{@const mark = def.mark?.(r)}
					<tr class={mark?.tone ?? ''} class:self={r.id === selfId}>
						<td class="name">{#if mark?.text}<span class="chip">{mark.text}</span>{/if}{r.name}{#if r.admin} <span class="admin-mark" title="Server admin">ADMIN</span>{/if}</td>
						{#each columns as col (col.id)}
							<td class:num={col.num} class:ss-num={col.num} class:text={!col.num} class:minor={col.minor}>{col.text(r, ctx)}</td>
						{/each}
					</tr>
				{:else}
					<tr><td colspan={columns.length + 1} class="empty">No players</td></tr>
				{/each}
			</tbody>
		</table>
		</div>
		{#if split.spectators.length > 0}
			<div class="specs">
				<span class="ss-label">Spectators ({split.spectators.length})</span>
				<span class="list">{split.spectators.map((s) => s.name).join(', ')}</span>
			</div>
		{/if}
	</section>
	</div>
	{#if richest.length > 0}
		<div class="rich ss-panel"><RichList {richest} {account} /></div>
	{/if}
</div>

<style>
	.backdrop {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 3vh 0 2.5vh;
		box-sizing: border-box;
		background: rgba(0, 0, 0, 0.25);
		pointer-events: none;
	}
	.middle {
		flex: 1;
		min-height: 0;
		width: 100%;
		display: grid;
		place-items: center;
	}
	.rich {
		flex: none;
		width: min(calc(1040px * var(--hud-scale)), 94vw);
		box-sizing: border-box;
		padding: 9px 12px 11px;
		/* Over the speed and timer: nothing may shine through. */
		background: rgba(12, 14, 18, 0.97);
		font-size: calc(15px * var(--hud-scale));
	}
	.board {
		--em: calc(15px * var(--hud-scale));
		width: min(calc(1040px * var(--hud-scale)), 94vw);
		max-height: min(80vh, 100%);
		overflow: hidden;
		display: flex;
		flex-direction: column;
		background: var(--panel-bg-strong);
		font-size: calc(15px * var(--hud-scale));
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		padding: 14px 18px 10px;
		border-bottom: 1px solid var(--panel-border);
	}
	.map {
		display: flex;
		flex-direction: column;
	}
	.title {
		font-size: 1.6em;
		font-weight: 700;
		letter-spacing: 0.02em;
	}
	.id {
		color: var(--text-dim);
		font-size: 0.85em;
	}
	.meta {
		display: flex;
		gap: 20px;
		align-items: baseline;
	}
	.meta .ss-num {
		font-size: 1.2em;
		font-weight: 600;
	}
	.scroll {
		overflow-y: auto;
		min-height: 0;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
	}
	.admin-mark {
		margin-left: 5px;
		font-size: 0.7em;
		font-weight: 700;
		letter-spacing: 0.1em;
		color: var(--accent);
	}
	.chip {
		display: inline-block;
		padding: 0 6px;
		margin-right: 6px;
		border-radius: 3px;
		font-size: 0.72em;
		font-weight: 700;
		letter-spacing: 0.08em;
	}
	tr.it .chip {
		background: #d42222;
		color: #fff;
	}
	tr.it td.name,
	tr.seeker td.name {
		color: #ff9a9a;
	}
	tr.infected .chip {
		background: #8e1018;
		color: #fff;
	}
	tr.infected td.name {
		color: #ff8a8a;
	}
	tr.alpha .chip {
		background: #d6680c;
		color: #1a0d00;
	}
	tr.alpha td.name {
		color: #ffc27a;
	}
	tr.zombie td.name {
		color: #9fe08a;
	}
	th {
		position: sticky;
		top: 0;
		background: rgba(12, 14, 18, 0.95);
		font-size: calc(11px * var(--hud-scale));
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-dim);
		text-align: left;
		box-sizing: border-box;
		padding: 8px 9px 6px;
		vertical-align: bottom;
	}
	td {
		padding: 5px 9px;
		border-top: 1px solid rgba(255, 255, 255, 0.05);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	tbody tr:nth-child(odd) td {
		background: rgba(255, 255, 255, 0.025);
	}
	tbody tr.infected td {
		background: rgba(142, 16, 24, 0.14);
	}
	tbody tr.alpha td {
		background: rgba(214, 104, 12, 0.16);
	}
	tbody tr.self td {
		background: var(--accent-soft);
	}
	tbody tr.self td.name {
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.name {
		font-weight: 600;
	}
	th.name,
	td.name {
		padding-left: 18px;
	}
	th:last-child,
	td:last-child {
		padding-right: 18px;
	}
	.num {
		text-align: right;
	}
	td.num {
		font-size: 1.1em;
		font-weight: 600;
	}
	td.text {
		color: var(--text-dim);
	}
	.empty {
		color: var(--text-faint);
		text-align: center;
	}
	.specs {
		padding: 10px 18px 14px;
		border-top: 1px solid var(--panel-border);
		display: flex;
		gap: 10px;
		align-items: baseline;
	}
	.list {
		color: var(--text-dim);
	}
	/* Small windows: drop what matters least, then let the header wrap. */
	@media (max-width: 860px) {
		.minor {
			display: none;
		}
		header {
			flex-direction: column;
			align-items: flex-start;
			gap: 6px;
		}
		th,
		td {
			padding-left: 5px;
			padding-right: 5px;
		}
		.board {
			--em: calc(13px * var(--hud-scale));
			font-size: var(--em);
		}
	}
</style>
