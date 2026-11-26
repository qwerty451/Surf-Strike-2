<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { mapTitle, type AdminState, type RichEntry } from '@surf/shared';
	import type { CasinoView, CoinsView, GameApi, MapListEntry, ShopView } from '#lib/game/contract.js';
	import SettingsMenu from '#lib/ui/menu/SettingsMenu.svelte';
	import MapMenu from '#lib/ui/menu/MapMenu.svelte';
	import CoinsMenu from '#lib/ui/menu/CoinsMenu.svelte';
	import CasinoMenu from '#lib/ui/menu/casino/CasinoMenu.svelte';
	import ShopMenu from '#lib/ui/menu/ShopMenu.svelte';
	import InventoryMenu from '#lib/ui/menu/InventoryMenu.svelte';
	import AccountMenu from '#lib/ui/menu/AccountMenu.svelte';
	import AdminMenu from '#lib/ui/menu/AdminMenu.svelte';
	import { isSettingsSection, modeLabel, wrapIndex, type MenuView, type SettingsSectionId } from '#lib/ui/menu/menu.js';

	/**
	 * Esc menu (docs/ui.md#esc-menu): main entries on the left, the open
	 * submenu (Servers, Settings, Shop, Inventory, Coins, Casino, Account) beside them. Esc goes back one
	 * level, then resumes.
	 */
	let {
		cvars,
		api,
		maps = [],
		mapId = '',
		lobbies = null,
		playerCount = 1,
		account = null,
		online = false,
		coins = null,
		shop = null,
		casino = null,
		multiplier = null,
		richest = [],
		adminState = null,
		adminNotice = null,
		blocked = false,
		fullscreenSupported = false
	}: {
		cvars: Record<string, number | string>;
		api: GameApi;
		maps?: MapListEntry[];
		mapId?: string;
		/** Players per map lobby (server browser); null offline. */
		lobbies?: Readonly<Record<string, number>> | null;
		/** Players in this lobby, me included. */
		playerCount?: number;
		account?: { username: string; admin?: boolean } | null;
		online?: boolean;
		/** Coins submenu (null: guest, offline or a server without coins). */
		coins?: CoinsView | null;
		/** Shop and Inventory submenus (null: offline or a server without a shop). */
		shop?: ShopView | null;
		/** Casino submenu (null: offline or a server without one). */
		casino?: CasinoView | null;
		multiplier?: { mult: number; active: number; need: number } | null;
		/** Coins submenu: accounts with the most coins. */
		richest?: readonly RichEntry[];
		/** Admin menu data (server-sent to admin accounts only). */
		adminState?: AdminState | null;
		adminNotice?: { ok: boolean; text: string; at: number } | null;
		/** Another overlay (console) owns the keyboard: ignore Esc and arrows. */
		blocked?: boolean;
		/** Fullscreen can block Ctrl+W here (Chromium). */
		fullscreenSupported?: boolean;
	} = $props();

	/** Dev mock only (`?mockhud&open=maps` or `&view=settings&tab=hud`): start on a submenu. */
	function devStart(): { view: MenuView; section: SettingsSectionId } {
		const fallback = { view: 'main' as MenuView, section: 'mouse' as SettingsSectionId };
		if (!import.meta.env.DEV || typeof location === 'undefined') return fallback;
		const p = new URLSearchParams(location.search);
		if (!p.has('mockhud')) return fallback;
		const v = p.get('open') === 'maps' ? 'maps' : p.get('view');
		const tab = p.get('tab');
		return {
			view: v === 'maps' || v === 'settings' || v === 'shop' || v === 'inventory' || v === 'coins' || v === 'casino' || v === 'account' || v === 'admin' ? v : 'main',
			section: isSettingsSection(tab) ? tab : 'mouse'
		};
	}
	const start = devStart();

	let view: MenuView = $state(start.view);
	let section: SettingsSectionId = $state(start.section);
	let shownItem: string | null = $state(null);

	type Entry = { id: Exclude<MenuView, 'main'> | 'resume'; label: string };
	// "Admin" only for admin accounts (the server decides; it re-checks every request).
	const entries: Entry[] = $derived([
		{ id: 'resume', label: 'Resume' },
		{ id: 'maps', label: 'Servers' },
		{ id: 'settings', label: 'Settings' },
		{ id: 'shop', label: 'Shop' },
		{ id: 'inventory', label: 'Inventory' },
		{ id: 'coins', label: 'Coins' },
		{ id: 'casino', label: 'Casino' },
		{ id: 'account', label: 'Account' },
		...(account?.admin ? [{ id: 'admin', label: 'Admin' } as Entry] : [])
	]);
	// Admin rights lost (logout, disconnect): leave the admin submenu.
	$effect(() => {
		if (view === 'admin' && !account?.admin) view = 'main';
	});
	const buttons: HTMLButtonElement[] = $state([]);
	let content: HTMLDivElement | undefined = $state();

	const current = $derived(maps.find((m) => m.id === mapId));

	onMount(() => {
		// Initial focus: the open submenu, else Resume.
		if (view === 'main') buttons[0]?.focus();
		else focusContent();
	});

	async function focusContent() {
		await tick();
		const el =
			content?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
			content?.querySelector<HTMLElement>('button, input, [tabindex="0"]');
		el?.focus();
	}

	function resume() {
		api.closeSettings();
		api.lockPointer();
	}

	function open(id: (typeof entries)[number]['id']) {
		if (id === 'resume') return resume();
		// Clicking the open entry again folds the submenu back to the main menu.
		if (view === id) view = 'main';
		else go(id);
	}

	/** Open a submenu; `item` is shown first in the inventory. */
	function go(id: MenuView, item: string | null = null) {
		shownItem = item;
		view = id;
		if (id !== 'main') focusContent();
	}

	function back() {
		const was = view;
		view = 'main';
		buttons[entries.findIndex((e) => e.id === was)]?.focus();
	}

	function pickMap(id: string) {
		api.changeMap(id);
		resume();
	}

	function keydown(e: KeyboardEvent) {
		if (blocked || e.defaultPrevented) return;
		if (e.key === 'Escape') {
			// Held Esc leaves fullscreen: only the first press navigates.
			if (e.repeat) return e.preventDefault();
			const t = e.target as HTMLInputElement | null;
			// Esc first clears a non-empty search box.
			if (t?.type === 'search' && t.value) return;
			e.preventDefault();
			if (view === 'main') resume();
			else back();
			return;
		}
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
		if (i < 0) return;
		e.preventDefault();
		buttons[wrapIndex(i, e.key === 'ArrowDown' ? 1 : -1, entries.length)]?.focus();
	}
</script>

<svelte:window onkeydown={keydown} />

<div class="backdrop ss-overlay">
	<nav class="nav" aria-label="Game menu">
		<div class="brand">
			<span class="logo">Surf Strike 2</span>
			{#if current}
				<span class="map ss-label">{mapTitle(current)} · {modeLabel(current.kind)}{#if online}{` · ${playerCount} ${playerCount === 1 ? 'player' : 'players'}`}{/if}</span>
			{/if}
		</div>

		<ul class="entries">
			{#each entries as entry, i (entry.id)}
				{@const active = view === entry.id}
				<li>
					<button
						type="button"
						class="entry"
						class:primary={entry.id === 'resume'}
						class:active
						aria-expanded={entry.id === 'resume' ? undefined : active}
						aria-controls={entry.id === 'resume' ? undefined : 'ss-menu-content'}
						bind:this={buttons[i]}
						onclick={() => open(entry.id)}
					>
						{entry.label}
					</button>
				</li>
			{/each}
		</ul>

		<div class="foot">
			<span class="who">
				{#if account}
					Logged in as <strong>{account.username}</strong>
				{:else}
					Guest · {online ? 'runs are not saved' : 'offline'}
				{/if}
			</span>
			<span class="hint">
				<kbd>Esc</kbd>
				{view === 'main' ? 'resume' : 'back'} · <kbd>↑</kbd><kbd>↓</kbd> navigate · console <kbd>`</kbd>
			</span>
		</div>
	</nav>

	{#if view !== 'main'}
		<div
			class="content ss-panel"
			class:compact={view === 'account'}
			class:wide={view === 'shop' || view === 'inventory' || view === 'coins' || view === 'casino'}
			id="ss-menu-content"
			role="dialog"
			aria-modal="false"
			aria-labelledby="ss-menu-title"
			bind:this={content}
		>
			{#if view === 'settings'}
				<SettingsMenu {cvars} {api} {fullscreenSupported} bind:section />
			{:else if view === 'maps'}
				<MapMenu {maps} {mapId} {online} {lobbies} admin={account?.admin === true} onpick={pickMap} />
			{:else if view === 'shop'}
				<ShopMenu {api} {shop} balance={coins?.balance ?? 0} loggedIn={account !== null} {online} oninventory={(item) => go('inventory', item)} />
			{:else if view === 'inventory'}
				<InventoryMenu {api} {shop} loggedIn={account !== null} {online} initial={shownItem} onshop={() => go('shop')} />
			{:else if view === 'coins'}
				<CoinsMenu {api} {coins} {multiplier} {richest} account={account?.username ?? null} loggedIn={account !== null} {online} />
			{:else if view === 'casino'}
				<CasinoMenu {api} {casino} balance={coins?.balance ?? 0} loggedIn={account !== null} {online} />
			{:else if view === 'admin'}
				<AdminMenu {api} data={adminState} {mapId} notice={adminNotice} />
			{:else}
				<AccountMenu {api} {account} {online} />
			{/if}
		</div>
	{/if}
</div>

<style>
	.backdrop {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		gap: clamp(20px, 3vw, 48px);
		padding: 32px clamp(24px, 6vw, 112px);
		box-sizing: border-box;
		background: linear-gradient(90deg, rgba(0, 0, 0, 0.78) 0%, rgba(0, 0, 0, 0.5) 45%, rgba(0, 0, 0, 0.3) 100%);
		pointer-events: auto;
		font-family: var(--ui-font);
		color: var(--text);
	}
	.nav {
		flex-shrink: 0;
		width: 250px;
		display: flex;
		flex-direction: column;
		gap: 28px;
	}
	.brand {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.logo {
		font: 700 30px/1 var(--ui-font);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.map {
		font-size: 12px;
	}
	.entries {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.entry {
		width: 100%;
		padding: 9px 14px 9px 16px;
		font: 600 22px/1.1 var(--ui-font);
		letter-spacing: 0.08em;
		text-align: left;
		text-transform: uppercase;
		color: var(--text-dim);
		background: transparent;
		border: none;
		border-left: 3px solid transparent;
		border-radius: 0 var(--radius) var(--radius) 0;
		cursor: pointer;
		transition:
			color 0.1s,
			background 0.1s;
	}
	.entry:hover,
	.entry:focus-visible {
		color: var(--text);
		background: linear-gradient(90deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0));
		border-left-color: var(--panel-border-strong);
	}
	.entry.primary {
		color: var(--text);
	}
	.entry.active {
		color: var(--accent);
		background: linear-gradient(90deg, var(--accent-soft), rgba(242, 163, 58, 0));
		border-left-color: var(--accent);
	}
	.foot {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 14px;
		border-top: 1px solid var(--panel-border);
		font-size: 13px;
	}
	.who {
		color: var(--text-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.who strong {
		color: var(--accent);
	}
	.hint {
		color: var(--text-faint);
		font-size: 12px;
		line-height: 1.6;
	}
	kbd {
		display: inline-block;
		min-width: 1.4em;
		padding: 0 4px;
		margin: 0 1px;
		font: 600 11px/1.5 var(--ui-font);
		text-align: center;
		color: var(--text-dim);
		border: 1px solid var(--panel-border-strong);
		border-radius: 2px;
	}
	.content {
		position: relative;
		flex: 0 1 680px;
		min-width: 0;
		height: min(620px, calc(100vh - 64px));
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 20px 22px 16px;
		background: var(--panel-bg-strong);
		font-size: 15px;
		animation: slide-in 0.12s ease-out;
	}
	.content.compact {
		height: auto;
		flex-basis: 440px;
	}
	.content.wide {
		flex-basis: 1020px;
		height: min(720px, calc(100vh - 64px));
	}
	@keyframes slide-in {
		from {
			opacity: 0;
			transform: translateX(-8px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.content {
			animation: none;
		}
	}
</style>
