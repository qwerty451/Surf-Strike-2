<script lang="ts">
	import type { DefenseView } from '#lib/game/contract.js';
	import { ammoText, formatRoundClock, reloadProgress } from '#lib/game/zombies-view.js';
	import { fadeOpacity } from '#lib/ui/format.js';
	import DefenseMenu from '#lib/ui/DefenseMenu.svelte';

	let {
		d,
		now,
		interactive = false,
		side = true,
		onpick = () => {},
		onclose = () => {}
	}: { d: DefenseView; now: number; interactive?: boolean; side?: boolean; onpick?: (index: number) => void; onclose?: () => void } = $props();

	const ammo = $derived(ammoText(d.mag, d.magSize, d.reserve));
	const reload = $derived(d.reloadEndsAt > 0 ? reloadProgress(now, d.reloadEndsAt, d.reloadMs) : 1);
	const left = $derived(d.endsAt > 0 ? Math.max(0, (d.endsAt - now) / 1000) : 0);
	const elapsed = $derived(d.startedAt !== null ? (now - d.startedAt) / 1000 : 0);
	const flashOpacity = $derived(d.flash ? fadeOpacity(now - d.flash.at, 2600, 800) : 0);
	const alertOpacity = $derived(d.alert ? fadeOpacity(now - d.alert.at, 3000, 900) : 0);
	const hitOpacity = $derived(d.hitMarker ? fadeOpacity(now - d.hitMarker.at, 120, 220) : 0);
	const hurtOpacity = $derived(d.hurtAt > 0 ? fadeOpacity(now - d.hurtAt, 80, 420) : 0);
	const popOpacity = $derived(d.goldPop ? fadeOpacity(now - d.goldPop.at, 900, 500) : 0);
	const hpFrac = $derived(d.maxHp > 0 ? Math.max(0, Math.min(1, d.hp / d.maxHp)) : 0);
	const urgent = $derived(d.phase === 'build' && left <= 5);
</script>

{#if hurtOpacity > 0}<div class="vignette" style:opacity={hurtOpacity * 0.8}></div>{/if}

{#if d.scoped}
	<div class="scope" aria-hidden="true">
		<div class="lens"></div>
		<div class="hair h"></div>
		<div class="hair v"></div>
	</div>
{/if}

<div class="round" data-top-hud aria-live="polite">
	{#if d.phase === 'build'}
		<div class="banner ss-panel ss-shadow build">
			<span class="role">Wave {d.wave}</span>
			<span class="msg">in</span>
			<span class="clock ss-num" class:urgent>{Math.ceil(left)} s</span>
			<span class="stat"><span class="ss-label">Ready</span> <span class="ss-num">{d.readyCount}/{d.livingCount}</span></span>
			{#if d.status === 'alive' && !d.ready}<span class="dim">F ready · B shop</span>{/if}
		</div>
	{:else if d.phase === 'wave'}
		<div class="banner ss-panel ss-shadow wave">
			<span class="role">Wave {d.wave}</span>
			<span class="clock ss-num">{formatRoundClock(elapsed)}</span>
			<span class="stat"><span class="ss-label">Zombies left</span> <span class="ss-num">{d.left}</span></span>
			<span class="stat"><span class="ss-label">Kills</span> <span class="ss-num">{d.myKills}</span><span class="dim ss-num"> / {d.teamKills}</span></span>
		</div>
		{#if d.boss !== null}
			<div class="boss" title="Behemoth">
				<span class="bname">Behemoth</span>
				<div class="bar"><div class="fill" style:width="{Math.round(d.boss * 100)}%"></div></div>
			</div>
		{/if}
	{:else if d.phase === 'ended'}
		<div class="banner ss-panel ss-shadow summary">
			<span class="role">Overrun</span>
			{#if d.summary}
				<span class="msg ss-num">wave {d.summary.wave} · {formatRoundClock(d.summary.secs)} · {d.summary.kills} kills{d.summary.top ? ` · top ${d.summary.top}` : ''}</span>
			{/if}
			<span class="dim">new game in <span class="ss-num">{Math.ceil(left)}</span></span>
		</div>
	{:else}
		<div class="banner ss-panel ss-shadow"><span class="msg">Waiting for players</span></div>
	{/if}
	{#if d.alert && alertOpacity > 0}
		<div class="alert" style:opacity={alertOpacity}>{d.alert.text}</div>
	{/if}
	{#if d.flash && flashOpacity > 0}
		<div class="flash {d.flash.tone}" style:opacity={flashOpacity}>{d.flash.text}</div>
	{/if}
</div>

{#if hitOpacity > 0 && d.hitMarker}
	<div class="hitmarker" class:head={d.hitMarker.head} class:kill={d.hitMarker.kill} style:opacity={hitOpacity} aria-hidden="true">
		<i></i><i></i><i></i><i></i>
	</div>
{/if}

{#if d.prompt && !d.menu}
	<div class="prompt" class:active={d.prompt.active}>{d.prompt.text}</div>
{/if}

{#if d.status === 'dead' && d.phase === 'wave'}
	<div class="down ss-panel ss-shadow">
		<div class="title">You died</div>
		<div class="msg">You come back when the others clear the wave</div>
	</div>
{:else if d.status === 'waiting' && d.phase === 'wave'}
	<div class="down ss-panel ss-shadow wait">
		<div class="title">Next build phase</div>
		<div class="msg">You join the defence when this wave is over</div>
	</div>
{/if}

{#if d.menu}
	<DefenseMenu menu={d.menu} gold={d.gold} {now} {interactive} {onpick} {onclose} />
{:else if side}
	<div class="side">
		<div class="panel ss-panel ss-shadow">
			<div class="ss-label">Barricades</div>
			{#each d.openings as o, i (i)}
				<div class="opening" class:broken={o.planks === 0} class:low={o.planks > 0 && o.planks * 2 < o.max}>
					<span class="oname">{o.name}{o.reinforce > 0 ? ` ${'+'.repeat(o.reinforce)}` : ''}</span>
					<span class="planks">
						{#each Array.from({ length: o.max }, (_, k) => k) as k (k)}<i class:on={k < o.planks}></i>{/each}
					</span>
				</div>
			{/each}
		</div>
		{#if d.team.length > 1 || d.phase === 'build'}
			<div class="panel ss-panel ss-shadow team">
				<div class="ss-label">Team</div>
				{#each d.team as p (p.id)}
					<div class="mate" class:me={p.me} class:dead={p.status !== 'alive'}>
						<span class="mname">{p.name}</span>
						<span class="mstate">{p.status === 'dead' ? 'dead' : p.status === 'waiting' ? 'next wave' : d.phase === 'build' ? (p.ready ? '✓ ready' : '…') : ''}</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<div class="killfeed">
	{#each d.killFeed as k (k.id)}
		<div class="kill" class:mine={k.mine} class:hs={k.head}>{k.text}</div>
	{/each}
</div>

<div class="status">
	<div class="gold ss-panel ss-shadow">
		<span class="ss-label">Gold</span>
		<span class="gnum ss-num">{d.gold}</span>
		{#if d.goldPop && popOpacity > 0}<span class="pop ss-num" style:opacity={popOpacity}>+{d.goldPop.amount}</span>{/if}
	</div>
	<div class="hp ss-panel ss-shadow">
		<span class="ss-label">Health <span class="ss-num hpnum">{Math.max(0, Math.ceil(d.hp))}/{d.maxHp}</span></span>
		<div class="hpbar" class:low={hpFrac <= 0.3}><div class="fill" style:width="{Math.round(hpFrac * 100)}%"></div></div>
	</div>
	<div class="weapon ss-panel ss-shadow">
		<span class="wname">{d.weaponLabel}</span>
		<span class="ammo ss-num"><span class="mag" class:low={ammo.low}>{ammo.mag}</span><span class="res"> / {ammo.reserve}</span></span>
		{#if reload < 1}<div class="reload"><div class="fill" style:width="{Math.round(reload * 100)}%"></div></div>{/if}
		{#if d.weapons.length > 1}
			<div class="wkeys">
				{#each d.weapons as w (w.key)}<span class="wk ss-num" class:on={w.held} title={w.label}>{w.key}</span>{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.round {
		position: absolute;
		top: 64px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		font-size: calc(15px * var(--hud-scale));
	}
	.banner {
		display: inline-flex;
		align-items: baseline;
		gap: 14px;
		padding: 6px 18px;
		white-space: nowrap;
	}
	.banner.wave {
		background: rgba(90, 30, 24, 0.8);
		border-color: rgba(255, 140, 110, 0.6);
	}
	.summary {
		background: rgba(140, 20, 20, 0.78);
	}
	.role {
		font-weight: 700;
		font-size: 1.25em;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.clock {
		font-weight: 600;
		font-size: 1.2em;
	}
	.clock.urgent {
		color: #ff8a6a;
	}
	.dim,
	.msg {
		color: var(--text-dim);
	}
	.boss {
		display: flex;
		align-items: center;
		gap: 8px;
		color: #d8b8ff;
		text-shadow: 0 1px 3px #000;
	}
	.bname {
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		font-size: 0.8em;
	}
	.boss .bar {
		width: 280px;
		height: 8px;
		background: rgba(0, 0, 0, 0.55);
		border: 1px solid rgba(200, 160, 255, 0.6);
	}
	.boss .fill {
		height: 100%;
		background: linear-gradient(90deg, #8a3cff, #d070ff);
	}
	.alert {
		font-size: 1.45em;
		font-weight: 800;
		color: #ff5a4a;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		text-shadow:
			0 0 10px rgba(255, 40, 20, 0.7),
			0 2px 4px rgba(0, 0, 0, 0.9);
	}
	.flash {
		margin-top: 2px;
		font-size: 1.4em;
		font-weight: 700;
		color: #fff;
		text-shadow: 0 2px 4px rgba(0, 0, 0, 0.9);
	}
	.flash.good {
		color: #b8ffa0;
	}
	.flash.bad {
		color: #ffb0a0;
	}
	.flash.boss {
		color: #e0c0ff;
		font-size: 1.6em;
		text-shadow:
			0 0 14px rgba(160, 80, 255, 0.8),
			0 2px 4px rgba(0, 0, 0, 0.9);
	}
	.prompt {
		position: absolute;
		left: 50%;
		top: 60%;
		transform: translateX(-50%);
		padding: 4px 14px;
		background: rgba(8, 12, 18, 0.65);
		border: 1px solid rgba(255, 210, 120, 0.55);
		color: #ffe7b0;
		font-weight: 600;
		font-size: calc(15px * var(--hud-scale));
		white-space: nowrap;
	}
	.prompt.active {
		border-color: #9fe08a;
		color: #c8ffb0;
	}
	.hitmarker {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 28px;
		height: 28px;
		transform: translate(-50%, -50%);
	}
	.hitmarker i {
		position: absolute;
		width: 9px;
		height: 2px;
		background: #fff;
		box-shadow: 0 0 2px #000;
	}
	.hitmarker.head i {
		background: #ffd24a;
	}
	.hitmarker.kill i {
		background: #ff5a5a;
		width: 12px;
	}
	.hitmarker i:nth-child(1) {
		left: 0;
		top: 4px;
		transform: rotate(45deg);
	}
	.hitmarker i:nth-child(2) {
		right: 0;
		top: 4px;
		transform: rotate(-45deg);
	}
	.hitmarker i:nth-child(3) {
		left: 0;
		bottom: 4px;
		transform: rotate(-45deg);
	}
	.hitmarker i:nth-child(4) {
		right: 0;
		bottom: 4px;
		transform: rotate(45deg);
	}
	.vignette {
		position: absolute;
		inset: 0;
		background: radial-gradient(ellipse at center, transparent 45%, rgba(200, 0, 0, 0.6) 100%);
	}
	.scope {
		position: absolute;
		inset: 0;
		overflow: hidden;
	}
	.lens {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 80vmin;
		height: 80vmin;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		box-shadow: 0 0 0 200vmax #000;
	}
	.hair {
		position: absolute;
		background: rgba(0, 0, 0, 0.9);
	}
	.hair.h {
		left: 10%;
		right: 10%;
		top: 50%;
		height: 1px;
	}
	.hair.v {
		top: 10%;
		bottom: 10%;
		left: 50%;
		width: 1px;
	}
	.down {
		position: absolute;
		left: 50%;
		top: 58%;
		transform: translateX(-50%);
		padding: 10px 22px;
		text-align: center;
		background: rgba(110, 24, 20, 0.8);
		font-size: calc(15px * var(--hud-scale));
	}
	.down.wait {
		background: rgba(20, 40, 70, 0.8);
	}
	.down .title {
		font-size: 1.4em;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.side {
		position: absolute;
		left: 18px;
		top: 30%;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: calc(13px * var(--hud-scale));
	}
	.panel {
		padding: 6px 10px;
		min-width: 190px;
	}
	.opening {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		padding: 1px 0;
	}
	.oname {
		text-transform: capitalize;
	}
	.planks {
		display: flex;
		gap: 2px;
	}
	.planks i {
		width: 7px;
		height: 10px;
		background: rgba(0, 0, 0, 0.4);
		border: 1px solid rgba(200, 160, 110, 0.4);
	}
	.planks i.on {
		background: #b07a44;
	}
	.opening.low .oname {
		color: #ffd24a;
	}
	.opening.broken .oname {
		color: #ff6a5a;
		font-weight: 700;
	}
	.mate {
		display: flex;
		justify-content: space-between;
		gap: 12px;
	}
	.mate.me .mname {
		color: #ffd27a;
	}
	.mate.dead {
		opacity: 0.55;
	}
	.mstate {
		color: var(--text-dim);
	}
	.killfeed {
		position: absolute;
		top: 54px;
		right: 18px;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		font-size: calc(13px * var(--hud-scale));
	}
	.kill {
		background: rgba(8, 12, 18, 0.6);
		padding: 2px 8px;
	}
	.kill.mine {
		border: 1px solid rgba(255, 210, 120, 0.7);
	}
	.kill.hs {
		color: #ffd24a;
	}
	.status {
		position: absolute;
		right: 18px;
		bottom: 22px;
		display: flex;
		gap: 10px;
		align-items: stretch;
		font-size: calc(15px * var(--hud-scale));
	}
	.hp,
	.weapon,
	.gold {
		padding: 6px 14px;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 4px;
	}
	.gold {
		position: relative;
		align-items: flex-start;
	}
	.gnum {
		font-size: 1.6em;
		font-weight: 700;
		color: #ffd24a;
	}
	.pop {
		position: absolute;
		top: -18px;
		right: 8px;
		color: #ffe27a;
		font-weight: 700;
		text-shadow: 0 1px 3px #000;
	}
	.hpnum {
		color: #e8f0e0;
		margin-left: 6px;
	}
	.hpbar {
		width: 150px;
		height: 10px;
		background: rgba(0, 0, 0, 0.45);
		border: 1px solid rgba(255, 255, 255, 0.35);
	}
	.hpbar .fill {
		height: 100%;
		background: #e8f0e0;
	}
	.hpbar.low .fill {
		background: #ff6a5a;
	}
	.reload {
		width: 110px;
		height: 6px;
		background: rgba(0, 0, 0, 0.45);
	}
	.reload .fill {
		height: 100%;
		background: #ffd27a;
	}
	.wname {
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		font-size: 0.85em;
		color: var(--text-dim);
	}
	.ammo {
		font-size: 1.6em;
		font-weight: 700;
	}
	.ammo .res {
		font-size: 0.6em;
		color: var(--text-dim);
	}
	.mag.low {
		color: #ff7070;
	}
	.wkeys {
		display: flex;
		gap: 4px;
	}
	.wk {
		width: 16px;
		text-align: center;
		font-size: 0.75em;
		border: 1px solid rgba(255, 255, 255, 0.35);
		color: var(--text-dim);
	}
	.wk.on {
		color: #ffd27a;
		border-color: #ffd27a;
	}
</style>
