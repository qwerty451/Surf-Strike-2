<script lang="ts">
	import { onMount } from 'svelte';
	import { formatWhole, listCosmetics, mapTitle, RARITIES, type AdminState } from '@surf/shared';
	import type { GameApi } from '#lib/game/contract.js';
	import Tabs from '#lib/ui/menu/Tabs.svelte';
	import Toggle from '#lib/ui/menu/Toggle.svelte';
	import { ADMIN_TABS, canDisableMap, groupAdminMaps, isAdminTab, parseAdminCoins, type AdminTabId } from '#lib/ui/menu/menu.js';

	/**
	 * Admin submenu (docs/ui.md#admin): Maps (enable/disable, force change),
	 * Players (coins, ban), Bans (unban), Abuse log. Only shown for admin accounts; the server
	 * re-checks every request, so this is just a remote control.
	 */
	let {
		api,
		data,
		mapId,
		notice = null
	}: {
		api: GameApi;
		data: AdminState | null;
		mapId: string;
		notice?: { ok: boolean; text: string; at: number } | null;
	} = $props();

	function devTab(): AdminTabId {
		if (!import.meta.env.DEV || typeof location === 'undefined') return 'maps';
		const t = new URLSearchParams(location.search).get('tab');
		return isAdminTab(t) ? t : 'maps';
	}

	let tab: AdminTabId = $state(devTab());
	/** Inline confirm: `force:<mapId>`, `ban:<playerId>`, `offline`, `coins:<playerId>`, `item:<playerId>`, `offline-coins`. */
	let confirming: string | null = $state(null);
	let reason = $state('');
	let offlineName = $state('');
	let coins = $state('');
	let item = $state('');
	const itemGroups = Object.entries(RARITIES).map(([id, r]) => ({ name: r.name, items: listCosmetics().filter((i) => i.rarity === id && !i.isDefault) }));
	/** Reset was clicked once and waits for the confirmation. */
	let resetting = $state(false);
	const coinAmount = $derived(parseAdminCoins(coins));
	/** Bumped to redraw a switch the server will refuse (last enabled map). */
	let reset = $state(0);

	const groups = $derived(groupAdminMaps(data?.maps ?? []));
	const maps = $derived(data?.maps ?? []);
	const players = $derived(data?.players ?? []);
	const bans = $derived(data?.bans ?? []);
	const abuse = $derived(data?.abuse ?? []);
	const tabs = $derived(
		ADMIN_TABS.map((t) => ({
			...t,
			count: t.id === 'maps' ? maps.length : t.id === 'players' ? players.length : t.id === 'bans' ? bans.length : abuse.length
		}))
	);

	onMount(() => api.admin({ action: 'listBans' }));

	function ask(key: string) {
		confirming = confirming === key ? null : key;
		reason = '';
		coins = '';
		item = '';
		resetting = false;
	}

	function ban(targetId: number) {
		const r = reason.trim();
		confirming = null;
		api.admin({ action: 'ban', targetId, ...(r ? { reason: r } : {}) });
	}

	function banOffline() {
		const username = offlineName.trim();
		const r = reason.trim();
		confirming = null;
		if (!username) return;
		api.admin({ action: 'ban', username, ...(r ? { reason: r } : {}) });
		offlineName = '';
	}

	function changeCoins(username: string, op: 'add' | 'subtract' | 'reset') {
		if (op === 'reset') {
			if (!resetting) {
				resetting = true;
				return;
			}
			api.admin({ action: 'coins', username, op });
		} else {
			if (coinAmount === null) return;
			api.admin({ action: 'coins', username, op, amount: coinAmount });
		}
		confirming = null;
		resetting = false;
	}

	function moveItem(action: 'giveItem' | 'takeItem', targetId: number) {
		if (item) api.admin({ action, targetId, item });
		confirming = null;
	}

	function when(t: number): string {
		return new Date(t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
	}
</script>

{#snippet coinEditor(username: string)}
	<span class="confirm" role="group" aria-label="Change the coins of {username}">
		{#if resetting}
			<span class="q">Reset {username} to 0 coins?</span>
			<button type="button" class="ss-button danger small" onclick={() => changeCoins(username, 'reset')}>Yes</button>
			<button type="button" class="ss-button ghost small" onclick={() => (resetting = false)}>No</button>
		{:else}
			<input class="ss-input coins" type="text" inputmode="numeric" maxlength="6" placeholder="Coins" aria-label="Amount of coins" autocomplete="off" bind:value={coins} />
			<button type="button" class="ss-button small" disabled={coinAmount === null} onclick={() => changeCoins(username, 'add')}>Add</button>
			<button type="button" class="ss-button ghost small" disabled={coinAmount === null} onclick={() => changeCoins(username, 'subtract')}>Subtract</button>
			<button type="button" class="ss-button danger small" onclick={() => changeCoins(username, 'reset')}>Reset</button>
			<button type="button" class="ss-button ghost small" onclick={() => (confirming = null)}>Cancel</button>
		{/if}
	</span>
{/snippet}

<header class="head">
	<h2 id="ss-menu-title">Admin</h2>
</header>

<Tabs {tabs} selected={tab} onselect={(id) => (tab = id as AdminTabId)} label="Admin sections" idPrefix="ss-admin" />

<div class="body" id="ss-admin-panel" role="tabpanel" aria-labelledby="ss-admin-tab-{tab}">
	{#if !data}
		<p class="empty">Loading…</p>
	{:else if tab === 'maps'}
		{#each groups as g (g.id)}
			<section class="group" aria-labelledby="ss-admin-group-{g.id}">
				<h3 class="group-title ss-label" id="ss-admin-group-{g.id}">{g.label}</h3>
				<ul class="rows">
					{#each g.maps as m (m.id)}
						{@const current = m.id === mapId}
						<li class="row" class:current class:off={!m.enabled}>
							<div class="grow">
								{#key `${m.enabled}:${reset}`}
									<Toggle
										label={mapTitle(m)}
										hint={current ? `${m.id} · you are here` : m.id}
										checked={m.enabled}
										onset={(on) => {
											// The last enabled map stays on: redraw the switch; the server explains why.
											if (!on && !canDisableMap(maps, m.id)) reset++;
											api.admin({ action: 'setMapEnabled', mapId: m.id, enabled: on });
										}}
									/>
								{/key}
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
		<p class="hint">Only admins can join the lobby of a disabled map; players already in it stay. At least one map stays enabled.</p>
	{:else if tab === 'players'}
		<ul class="rows">
			{#each players as p (p.id)}
				<li class="row player">
					<span class="name">{p.name}</span>
					{#if confirming !== `coins:${p.id}` && confirming !== `item:${p.id}`}
						<span class="badge" class:admin={p.admin}>{p.admin ? 'Admin' : p.guest ? 'Guest' : 'Account'}</span>
					{/if}
					{#if p.map}<span class="muted where">{p.map}</span>{/if}
					{#if p.coins !== undefined}<span class="muted balance ss-num">{formatWhole(p.coins)} coins</span>{/if}
					<span class="grow"></span>
					{#if p.account && confirming === `coins:${p.id}`}
						{@render coinEditor(p.account)}
					{:else if p.account && confirming === `item:${p.id}`}
						{@const owned = p.items ?? []}
						{@const has = owned.includes(item)}
						<span class="confirm" role="group" aria-label="Give {p.name} an item, or remove one">
							<select class="ss-input item" aria-label="Item" bind:value={item}>
								<option value="">Pick an item</option>
								{#if owned.length > 0}
									<optgroup label="Owned: remove ({owned.length})">
										{#each itemGroups.flatMap((g) => g.items).filter((i) => owned.includes(i.id)) as i (i.id)}<option value={i.id}>{i.name}</option>{/each}
									</optgroup>
								{/if}
								{#each itemGroups as g (g.name)}
									<optgroup label="Give: {g.name}">
										{#each g.items.filter((i) => !owned.includes(i.id)) as i (i.id)}<option value={i.id}>{i.name}</option>{/each}
									</optgroup>
								{/each}
							</select>
							{#if has}
								<button type="button" class="ss-button danger small" onclick={() => moveItem('takeItem', p.id)}>Remove</button>
							{:else}
								<button type="button" class="ss-button small" disabled={!item} onclick={() => moveItem('giveItem', p.id)}>Give</button>
							{/if}
							<button type="button" class="ss-button ghost small" onclick={() => (confirming = null)}>Cancel</button>
						</span>
					{:else if confirming === `ban:${p.id}`}
						<span class="confirm" role="group" aria-label="Confirm ban">
							<input
								class="ss-input reason"
								type="text"
								maxlength="128"
								placeholder="Reason (optional)"
								aria-label="Ban reason"
								bind:value={reason}
							/>
							<button type="button" class="ss-button danger small" onclick={() => ban(p.id)}>Ban</button>
							<button type="button" class="ss-button ghost small" onclick={() => (confirming = null)}>Cancel</button>
						</span>
					{:else}
						{#if p.account}
							<button type="button" class="ss-button ghost small" onclick={() => ask(`coins:${p.id}`)}>Coins</button>
							<button type="button" class="ss-button ghost small" onclick={() => ask(`item:${p.id}`)}>Item</button>
						{/if}
						{#if !p.admin}
							<button type="button" class="ss-button ghost small" onclick={() => ask(`ban:${p.id}`)}>Ban</button>
						{/if}
					{/if}
				</li>
			{:else}
				<li class="empty">No players connected.</li>
			{/each}
		</ul>
		<form
			class="offline"
			onsubmit={(e) => {
				// Enter does nothing: every action here needs its own button.
				e.preventDefault();
			}}
		>
			<span class="ss-label">Coins or ban of an account by username</span>
			<div class="line">
				<input
					class="ss-input"
					type="text"
					maxlength="24"
					placeholder="Username"
					aria-label="Account username"
					autocomplete="off"
					bind:value={offlineName}
				/>
				{#if confirming === 'offline-coins' && offlineName.trim()}
					{@render coinEditor(offlineName.trim())}
				{:else if confirming === 'offline'}
					<input
						class="ss-input reason"
						type="text"
						maxlength="128"
						placeholder="Reason (optional)"
						aria-label="Ban reason"
						bind:value={reason}
					/>
					<button type="button" class="ss-button danger small" onclick={banOffline}>Ban {offlineName.trim()}</button>
					<button type="button" class="ss-button ghost small" onclick={() => (confirming = null)}>Cancel</button>
				{:else}
					<button type="button" class="ss-button ghost small" disabled={!offlineName.trim()} onclick={() => ask('offline-coins')}>Coins…</button>
					<button type="button" class="ss-button ghost small" disabled={!offlineName.trim()} onclick={() => ask('offline')}>Ban…</button>
				{/if}
			</div>
		</form>
	{:else if tab === 'bans'}
		<ul class="rows">
			{#each bans as b (b.id)}
				<li class="row ban">
					<div class="grow col">
						<span class="name">{b.username} <span class="badge">{b.kind === 'account' ? 'Account' : 'Guest'}</span></span>
						<span class="muted">{b.reason ?? 'No reason'} · {when(b.createdAt)} · by {b.createdBy}{#if b.secondsLeft !== undefined}{' · '}lifts in {Math.ceil(b.secondsLeft / 60)} min{/if}</span>
					</div>
					<button type="button" class="ss-button ghost small" onclick={() => api.admin({ action: 'unban', banId: b.id })}>
						Unban
					</button>
				</li>
			{:else}
				<li class="empty">No bans.</li>
			{/each}
		</ul>
	{:else}
		<ul class="rows">
			{#each abuse as e (e.id)}
				<li class="row ban">
					<div class="grow col">
						<span class="name">
							{e.username}
							<span class="badge" class:bad={e.action !== 'warning'}>
								{e.action === 'warning' ? 'Warning' : e.action === 'ban' ? '5 min ban' : 'Admin, not banned'}
							</span>
						</span>
						<span class="muted evidence">{when(e.createdAt)} · {e.strikes} strikes · {e.evidence}</span>
					</div>
				</li>
			{:else}
				<li class="empty">No automatic warnings or bans.</li>
			{/each}
		</ul>
	{/if}
</div>

{#if notice}
	<p class="notice" class:bad={!notice.ok} role="status">{notice.text}</p>
{/if}

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.head h2 {
		margin: 0;
		font: 700 22px/1 var(--ui-font);
		letter-spacing: 0.1em;
		text-transform: uppercase;
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
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 10px;
		background: rgba(255, 255, 255, 0.03);
		border-left: 2px solid transparent;
		border-radius: 2px;
		min-height: 38px;
	}
	.row.current {
		border-left-color: var(--accent);
		background: var(--accent-soft);
	}
	.row.off :global(.label) {
		color: var(--text-faint);
		text-decoration: line-through;
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.col {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.name {
		font-size: 16px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badge {
		flex-shrink: 0;
		padding: 2px 6px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-dim);
		border: 1px solid var(--panel-border-strong);
		border-radius: 2px;
	}
	.badge.admin {
		color: var(--accent);
		border-color: var(--accent);
	}
	.badge.bad {
		color: var(--bad);
		border-color: var(--bad);
	}
	.muted.evidence {
		white-space: normal;
		line-height: 1.4;
	}
	.muted {
		font-size: 13px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.confirm {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.q {
		font-size: 14px;
		color: var(--system);
	}
	.small {
		padding: 6px 12px;
		font-size: 12px;
		flex-shrink: 0;
	}
	.ghost {
		color: var(--text);
		background: transparent;
		border-color: var(--panel-border-strong);
	}
	.danger {
		color: #fff;
		background: var(--bad);
	}
	.reason {
		width: 170px;
		padding: 5px 8px;
		font-size: 14px;
	}
	.coins {
		width: 70px;
		padding: 5px 8px;
		font-size: 14px;
	}
	.item {
		width: 190px;
		padding: 5px 8px;
		font-size: 14px;
	}
	.item option,
	.item optgroup {
		color: #eee;
		background: #14171c;
	}
	.balance {
		flex-shrink: 0;
	}
	.offline {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 8px;
		padding-top: 12px;
		border-top: 1px solid var(--panel-border);
	}
	.offline .line {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.offline .line > .ss-input:first-child {
		width: 170px;
		padding: 5px 8px;
		font-size: 14px;
	}
	.hint,
	.empty {
		margin: 4px 0;
		font-size: 13px;
		color: var(--text-faint);
		list-style: none;
	}
	.notice {
		margin: 0;
		padding: 7px 12px;
		font-size: 14px;
		color: var(--good);
		background: rgba(95, 224, 122, 0.08);
		border: 1px solid rgba(95, 224, 122, 0.3);
		border-radius: var(--radius);
	}
	.notice.bad {
		color: var(--bad);
		background: rgba(255, 90, 78, 0.08);
		border-color: rgba(255, 90, 78, 0.35);
	}
</style>
