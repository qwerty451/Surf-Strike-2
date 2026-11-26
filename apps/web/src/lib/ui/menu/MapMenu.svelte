<script lang="ts">
	import type { MapListEntry } from '#lib/game/contract.js';
	import { mapTitle } from '@surf/shared';
	import Tabs from '#lib/ui/menu/Tabs.svelte';
	import { busyMaps, filterMaps, groupMapsByMode, lobbyPlayers, mapSelectable, mapTag, modeLabel, playersLabel, totalPlayers } from '#lib/ui/menu/menu.js';

	/**
	 * Server browser (docs/ui.md#server-browser): every map is its own lobby.
	 * Online, a pick joins whoever plays there; offline it loads the map solo.
	 */
	let {
		maps,
		mapId,
		online = false,
		lobbies = null,
		admin = false,
		onpick
	}: {
		maps: MapListEntry[];
		mapId: string;
		online?: boolean;
		/** Players per map lobby (null offline). */
		lobbies?: Readonly<Record<string, number>> | null;
		/** Admins may join lobbies of maps an admin disabled. */
		admin?: boolean;
		onpick: (id: string) => void;
	} = $props();

	const ALL = '__all';
	const groups = $derived(groupMapsByMode(maps));
	const currentMap = $derived(maps.find((m) => m.id === mapId));
	// Open on All (with Playing now on top); a tab shows one mode.
	let picked = $state<string | null>(null);
	const category = $derived.by(() => {
		const want = picked ?? ALL;
		return want === ALL || groups.some((g) => g.id === want) ? want : ALL;
	});
	let query = $state('');
	const counts = $derived(online ? lobbies : null);
	const total = $derived(totalPlayers(counts));
	const modePlayers = (g: { maps: MapListEntry[] }) => g.maps.reduce((n, m) => n + lobbyPlayers(counts, m.id), 0);

	const tabs = $derived([
		{ id: ALL, label: 'All', count: maps.length },
		...groups.map((g) => ({ id: g.id, label: g.label, count: g.maps.length }))
	]);
	const busy = $derived(category === ALL && !query.trim() ? busyMaps(maps, counts) : []);
	const shown = $derived(
		groups
			.filter((g) => category === ALL || g.id === category)
			.map((g) => ({ ...g, maps: filterMaps(g.maps, query) }))
			.filter((g) => g.maps.length > 0)
	);
</script>

<header class="head">
	<h2 id="ss-menu-title">Servers</h2>
	{#if currentMap}
		<span class="now">You are on <strong>{mapTitle(currentMap)}</strong> · {modeLabel(currentMap.kind)}</span>
	{/if}
</header>

<p class="notice" role="status">
	{#if online}
		Every map is its own lobby: pick one to join the players there. <span class="total">{playersLabel(total)} online.</span>
	{:else}
		Offline: a pick loads the map solo. Online, every map is its own lobby.
	{/if}
</p>

<div class="bar">
	<Tabs {tabs} selected={category} onselect={(id) => (picked = id)} label="Map categories" idPrefix="ss-maps" />
	<input
		class="ss-input search"
		type="search"
		placeholder="Filter maps"
		aria-label="Filter maps by name or id"
		bind:value={query}
	/>
</div>

<div class="body" id="ss-maps-panel" role="tabpanel" aria-labelledby="ss-maps-tab-{category}">
	{#if busy.length > 0}
		<section class="group" aria-labelledby="ss-maps-group-busy">
			<h3 class="group-title ss-label" id="ss-maps-group-busy">Playing now</h3>
			<ul class="maps">
				{#each busy as m (m.id)}
					<li>{@render row(m, true)}</li>
				{/each}
			</ul>
		</section>
	{/if}
	{#each shown as g (g.id)}
		{@const n = modePlayers(g)}
		<section class="group" aria-labelledby="ss-maps-group-{g.id}">
			<h3 class="group-title ss-label" class:sr-only={category !== ALL} id="ss-maps-group-{g.id}">
				{g.label}{#if n > 0}<span class="group-count">{` · ${playersLabel(n)}`}</span>{/if}
			</h3>
			<ul class="maps">
				{#each g.maps as m (m.id)}
					<li>{@render row(m, false)}</li>
				{/each}
			</ul>
		</section>
	{:else}
		<p class="empty">No maps match “{query.trim()}”.</p>
	{/each}
</div>

{#snippet row(m: MapListEntry, withMode: boolean)}
	{@const current = m.id === mapId}
	{@const players = lobbyPlayers(counts, m.id)}
	{#if !current && mapSelectable(m, admin)}
		<button
			type="button"
			class="map"
			title={online ? `Join ${mapTitle(m)} (${playersLabel(players).toLowerCase()})` : `Play ${mapTitle(m)} solo`}
			onclick={() => onpick(m.id)}
		>
			{@render entry(m, players, current, withMode)}
			<span class="act">{online ? 'Join' : 'Play'}</span>
		</button>
	{:else}
		<div class="map readonly" class:current class:off={m.disabled} aria-current={current ? 'true' : undefined}>
			{@render entry(m, players, current, withMode)}
		</div>
	{/if}
{/snippet}

{#snippet entry(m: MapListEntry, players: number, current: boolean, withMode: boolean)}
	<span class="title">{m.title}</span>
	<span class="id">{withMode ? modeLabel(m.kind) : m.id}</span>
	{#if current}<span class="tag-now">You are here</span>{/if}
	{#if m.disabled}<span class="tag-off">Disabled by admin</span>{/if}
	{#if online}<span class="players ss-num" class:busy={players > 0}>{playersLabel(players)}</span>{/if}
	{@const tag = mapTag(m)}
	<span class="diff {tag.cls}">{tag.label}</span>
{/snippet}

<style>
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}
	.head h2 {
		margin: 0;
		font: 700 22px/1 var(--ui-font);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.now {
		font-size: 13px;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.now strong {
		color: var(--accent);
	}
	.total {
		color: var(--text);
		font-weight: 600;
	}
	.group-count {
		color: var(--good);
		letter-spacing: 0.08em;
	}
	.players {
		flex-shrink: 0;
		min-width: 72px;
		font-size: 12px;
		text-align: right;
		color: var(--text-faint);
	}
	.players.busy {
		color: var(--good);
		font-weight: 600;
	}
	.act {
		flex-shrink: 0;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	button.map:hover .act,
	button.map:focus-visible .act {
		color: var(--accent);
	}
	.notice {
		margin: 0;
		padding: 8px 12px;
		font-size: 14px;
		color: var(--system);
		background: rgba(242, 196, 90, 0.08);
		border: 1px solid rgba(242, 196, 90, 0.3);
		border-radius: var(--radius);
	}
	.bar {
		display: flex;
		align-items: flex-end;
		gap: 12px;
	}
	.bar :global(.tabs) {
		flex: 1;
		min-width: 0;
	}
	.search {
		width: 170px;
		padding: 5px 9px;
		margin-bottom: 4px;
		font-size: 14px;
	}
	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding-right: 4px;
	}
	.group-title {
		margin: 0 0 4px;
		font-size: 12px;
	}
	.maps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.map {
		box-sizing: border-box;
		width: 100%;
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 8px 12px;
		font: inherit;
		color: var(--text);
		text-align: left;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid transparent;
		border-left: 2px solid transparent;
		border-radius: 2px;
	}
	button.map {
		cursor: pointer;
	}
	button.map:hover,
	button.map:focus-visible {
		background: rgba(255, 255, 255, 0.07);
		border-color: var(--panel-border-strong);
		outline: none;
	}
	.map.current {
		border-left-color: var(--accent);
		background: var(--accent-soft);
	}
	.readonly {
		color: var(--text-dim);
	}
	.title {
		font-size: 16px;
		font-weight: 600;
	}
	.map.current .title {
		color: var(--accent);
	}
	.id {
		flex: 1;
		min-width: 0;
		font-size: 13px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag-now {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.diff {
		flex-shrink: 0;
		min-width: 44px;
		padding: 3px 7px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-align: center;
		text-transform: uppercase;
		color: var(--text-dim);
		border: 1px solid var(--panel-border-strong);
		border-radius: 2px;
	}
	.diff-easy {
		color: var(--good);
		border-color: rgba(95, 224, 122, 0.45);
	}
	.size-medium,
	.size-large {
		color: var(--accent);
		border-color: var(--panel-border-strong);
	}
	.diff-hard {
		color: var(--bad);
		border-color: rgba(255, 90, 78, 0.45);
	}
	.map.off .title {
		color: var(--text-faint);
	}
	.tag-off {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.empty {
		margin: 8px 0;
		color: var(--text-faint);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
