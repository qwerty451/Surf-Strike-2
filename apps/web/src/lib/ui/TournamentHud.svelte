<script lang="ts">
	import { TRN_ROUND_WINS } from '@surf/shared';
	import type { TournamentView } from '#lib/game/contract.js';
	import { ammoText, reloadProgress } from '#lib/game/zombies-view.js';
	import { betAcceptedText, betButtonText, betCountText, championText, coinsText, hpFrac, phaseLine, pips, startText } from '#lib/game/tournament-view.js';
	import Bracket from '#lib/ui/Bracket.svelte';
	import { fadeOpacity, formatClock } from '#lib/ui/format.js';
	import { hitKind, hitOpacity, scopeOverlay } from '#lib/ui/infected-hud.js';

	/**
	 * Tournament HUD (docs/ui.md#tournament-hud). `top`: duel bar and banners
	 * under the map info; `screen`: scope, hit marker, kill feed, weapon, bet
	 * panel and the bracket overlay. `interactive`: the cursor is free (pointer
	 * not locked), so the bet buttons can be clicked; locked, keys 1 / 2 bet.
	 */
	let {
		t,
		now,
		part,
		bracketHeld = false,
		interactive = false,
		onbet = () => {}
	}: { t: TournamentView; now: number; part: 'top' | 'screen'; bracketHeld?: boolean; interactive?: boolean; onbet?: (pick: number) => void } = $props();

	const left = $derived(t.endsAt > 0 ? Math.max(0, (t.endsAt - now) / 1000) : 0);
	const freezeLeft = $derived(t.duel && t.duel.freezeUntil > now ? (t.duel.freezeUntil - now) / 1000 : 0);
	const flashOpacity = $derived(t.flash ? fadeOpacity(now - t.flash.at, 2400, 800) : 0);
	const line = $derived(phaseLine(t.phase, t.late, t.out));
	const watching = $derived(t.spectating);
	const hit = $derived(!watching && t.hitMarker ? hitKind(t.hitMarker) : null);
	const hitShown = $derived(hit && t.hitMarker ? hitOpacity(now - t.hitMarker.at, hit) : 0);
	const hurt = $derived(!watching && t.hurtAt > 0 ? fadeOpacity(now - t.hurtAt, 80, 420) * 0.8 : 0);
	const scope = $derived(watching ? null : scopeOverlay(t.scopeT, t.scoped));
	const ammo = $derived(ammoText(t.mag, t.magSize, t.reserve));
	const reload = $derived(t.reloadEndsAt > 0 ? reloadProgress(now, t.reloadEndsAt, t.reloadMs) : 1);
	const showBracket = $derived((t.showBracket || bracketHeld) && t.state?.bracket != null);
	const bracketTitle = $derived(
		t.phase === 'ended' ? `Tournament ${t.tournament} · final standings` : `Tournament ${t.tournament}${t.roundLabel ? ` · ${t.roundLabel}` : ''}`
	);
	const noteOpacity = $derived(t.bet?.note ? fadeOpacity(now - t.bet.note.at, t.bet.note.tone === 'ok' ? 600000 : 5000, 800) : 0);
</script>

{#if part === 'top'}
	<div class="trn top" aria-live="polite">
		{#if t.duel}
			{@const d = t.duel}
			<div class="duel ss-panel ss-shadow">
				{#each [d.a, d.b] as s, i (s.id)}
					<div class="side" class:right={i === 1} class:self={s.self} class:dead={s.hp <= 0}>
						<div class="who">
							<span class="nm">{s.name}</span>
							<span class="pips" aria-label="{s.wins} round wins">
								{#each pips(s.wins, TRN_ROUND_WINS) as on, k (k)}<i class:on></i>{/each}
							</span>
						</div>
						<div class="hpbar" aria-label="{Math.max(0, Math.round(s.hp))} HP">
							<div class="fill" class:low={s.hp <= 30} style:width="{Math.round(hpFrac(s.hp) * 100)}%"></div>
							<span class="hpnum ss-num">{Math.max(0, Math.round(s.hp))}</span>
						</div>
					</div>
					{#if i === 0}
						<div class="mid">
							<span class="ss-label">{t.roundLabel || 'Duel'} · R{d.round}</span>
							<span class="clock ss-num" class:low={freezeLeft <= 0 && left <= 15}>{formatClock(left)}</span>
						</div>
					{/if}
				{/each}
			</div>
			{#if freezeLeft > 0}
				<div class="freeze"><span class="ss-label">Round {d.round} starts in</span> <span class="ss-num">{Math.ceil(freezeLeft)}</span></div>
			{/if}
		{:else if t.phase === 'starting'}
			<div class="banner ss-panel ss-shadow">
				<span class="role">Tournament {t.tournament}</span>
				<span class="msg">starts in</span>
				<span class="clock ss-num">{Math.ceil(left)}</span>
			</div>
			<div class="sub">{startText(t.entrants, t.prize)}</div>
		{:else if t.phase === 'bracket'}
			<div class="banner ss-panel ss-shadow">
				<span class="role">{t.roundLabel || 'Next duel'}</span>
				{#if t.next}<span class="msg">{t.next.a} <span class="vs">vs</span> {t.next.b}</span>{/if}
				<span class="clock ss-num">{Math.ceil(left)}</span>
			</div>
		{:else if t.phase === 'ended'}
			<div class="banner ss-panel ss-shadow gold">
				<span class="role">{t.champion ? championText(t.champion.name, t.champion.self) : 'Tournament over'}</span>
				<span class="msg">Prize {coinsText(t.prize)}</span>
				<span class="dim">next in <span class="ss-num">{Math.ceil(left)}</span></span>
			</div>
		{:else}
			<div class="banner ss-panel ss-shadow waiting">
				<span class="role">Tournament</span>
				{#if line}<span class="msg">{line}</span>{/if}
			</div>
		{/if}
		{#if line && t.phase !== 'solo' && t.phase !== 'waiting'}<div class="sub watch">{line}</div>{/if}
		{#if t.flash && flashOpacity > 0}
			<div class="flash {t.flash.tone}" style:opacity={flashOpacity}>
				{t.flash.text}{#if t.flash.sub}<span class="fsub">{t.flash.sub}</span>{/if}
			</div>
		{/if}
	</div>
{:else}
	{#if hurt > 0}<div class="vignette" style:opacity={hurt} aria-hidden="true"></div>{/if}
	{#if scope}
		<div class="scope" style:opacity={scope.opacity} aria-hidden="true">
			<div class="lens" style:--lens={scope.scale}></div>
			<div class="hair h"></div>
			<div class="hair v"></div>
		</div>
	{/if}
	{#if hit && hitShown > 0 && t.hitMarker}
		{#key t.hitMarker.at}
			<div class="hitmarker hm-{hit}" style:opacity={hitShown} aria-hidden="true"><i></i><i></i><i></i><i></i>{#if t.hitMarker.head}<b></b>{/if}</div>
		{/key}
	{/if}

	<div class="killfeed">
		{#each t.killFeed as k (k.id)}
			<div class="kill" class:mine={k.mine} class:hs={k.head}>{k.text}</div>
		{/each}
	</div>

	{#if showBracket && t.state}
		<Bracket view={t.state} selfId={t.selfId} title={bracketTitle} />
	{/if}

	{#if t.bet}
		{@const b = t.bet}
		<div class="bet ss-panel ss-shadow" class:open={b.canBet}>
			<div class="bhead">
				<span class="ss-label">{b.open ? 'Bets open' : 'Bets closed'}</span>
				{#if b.canBet && !interactive}<span class="dim">keys <b>1</b> / <b>2</b> · Esc for the cursor</span>{/if}
			</div>
			{#if b.canBet}
				<div class="picks">
					{#each [b.a, b.b] as s, i (s.id)}
						<button class="pick" disabled={!interactive} tabindex={interactive ? 0 : -1} onclick={() => onbet(s.id)}>
							<span class="key">{i + 1}</span>
							<span class="ptext">{betButtonText(s.name)}</span>
							<span class="count ss-num">{betCountText(s.count)}</span>
						</button>
					{/each}
				</div>
			{:else}
				<div class="tally">
					<span>{b.a.name} <span class="ss-num dim">{betCountText(b.a.count)}</span></span>
					<span class="vs">vs</span>
					<span>{b.b.name} <span class="ss-num dim">{betCountText(b.b.count)}</span></span>
				</div>
			{/if}
			{#if b.note && noteOpacity > 0}
				<div class="note {b.note.tone}" style:opacity={noteOpacity}>{b.note.text}</div>
			{:else if b.mine}
				<div class="note ok">{betAcceptedText(b.mine.name)}</div>
			{/if}
		</div>
	{/if}

	{#if !watching && t.phase !== 'ended'}
		<div class="weapon ss-panel ss-shadow">
			<span class="wname">{t.weaponLabel}</span>
			{#if t.knifeOnly}
				<span class="hint"><b>LMB</b> Knife{#if t.phase !== 'solo'} · spectators fight on the deck{/if}</span>
			{:else}
				<span class="slots">
					<span class="slot" class:active={t.weapon === 'sniper'}><span class="cap">1</span>Sniper</span>
					<span class="slot" class:active={t.weapon === 'pistol'}><span class="cap">2</span>Pistol</span>
					<span class="slot" class:active={t.weapon === 'knife'}><span class="cap">3</span>Knife</span>
				</span>
				{#if t.magSize > 0}
					<span class="ammo ss-num"><span class="mag" class:low={ammo.low}>{ammo.mag}</span><span class="res"> / {ammo.reserve}</span></span>
				{/if}
				{#if reload < 1}<div class="reload"><div class="fill" style:width="{Math.round(reload * 100)}%"></div></div>{/if}
			{/if}
		</div>
	{/if}
{/if}

<style>
	.top {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		font-size: calc(15px * var(--hud-scale));
		max-width: calc(100vw - 32px);
	}
	.banner {
		display: inline-flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: baseline;
		gap: 4px 14px;
		padding: 6px 18px;
		max-width: 100%;
		box-sizing: border-box;
	}
	.banner.gold {
		background: rgba(70, 52, 8, 0.85);
		border-color: rgba(255, 210, 90, 0.8);
	}
	.role {
		font-weight: 700;
		font-size: 1.25em;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.msg,
	.dim {
		color: var(--text-dim);
	}
	.vs {
		color: var(--text-faint);
		font-size: 0.85em;
		margin: 0 4px;
	}
	.clock {
		font-weight: 600;
		font-size: 1.25em;
	}
	.clock.low {
		color: #ff7070;
	}
	.sub {
		color: var(--text-dim);
		text-shadow: var(--shadow-text);
	}
	.sub.watch {
		color: #bfe4ff;
		font-weight: 600;
	}
	/* Duel bar: name, pips and HP on each side, round and clock in the middle. */
	.duel {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: 14px;
		padding: 6px 14px;
		width: min(640px, calc(100vw - 32px));
		box-sizing: border-box;
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}
	.side.right {
		align-items: flex-end;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: 100%;
		min-width: 0;
	}
	.right .who {
		flex-direction: row-reverse;
	}
	.nm {
		font-weight: 700;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.self .nm {
		color: #ffd37a;
	}
	.dead .nm {
		color: var(--text-faint);
		text-decoration: line-through;
	}
	.pips {
		display: inline-flex;
		gap: 4px;
		flex: none;
	}
	.pips i {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		border: 1.5px solid rgba(255, 255, 255, 0.5);
		box-sizing: border-box;
	}
	.pips i.on {
		background: var(--accent);
		border-color: var(--accent);
	}
	.hpbar {
		position: relative;
		width: 100%;
		height: 12px;
		background: rgba(255, 255, 255, 0.1);
		overflow: hidden;
	}
	.hpbar .fill {
		height: 100%;
		background: var(--good);
		transition: width 120ms linear;
	}
	.hpbar .fill.low {
		background: var(--bad);
	}
	.right .hpbar .fill {
		margin-left: auto;
	}
	.hpnum {
		position: absolute;
		top: 50%;
		left: 4px;
		transform: translateY(-50%);
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
		text-shadow: 0 0 3px #000;
	}
	.right .hpnum {
		left: auto;
		right: 4px;
	}
	.mid {
		display: flex;
		flex-direction: column;
		align-items: center;
		white-space: nowrap;
	}
	.freeze {
		font-weight: 700;
		color: #bfe4ff;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		text-shadow: var(--shadow-text);
	}
	.freeze .ss-num {
		font-size: 1.8em;
		vertical-align: middle;
	}
	.flash {
		margin-top: 4px;
		display: flex;
		flex-direction: column;
		align-items: center;
		font-size: 1.5em;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: #fff;
		text-align: center;
		text-shadow:
			0 0 12px rgba(242, 163, 58, 0.7),
			0 2px 4px rgba(0, 0, 0, 0.9);
	}
	.flash .fsub {
		font-size: 0.6em;
		font-weight: 600;
		color: var(--text-dim);
	}
	.flash.win {
		color: #b8ffc6;
	}
	.flash.lose {
		color: #ffb0a8;
		text-shadow:
			0 0 12px rgba(255, 60, 40, 0.7),
			0 2px 4px rgba(0, 0, 0, 0.9);
	}
	.flash.gold {
		color: #ffe08a;
		font-size: 1.9em;
	}
	.vignette {
		position: absolute;
		inset: 0;
		pointer-events: none;
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
		transform: translate(-50%, -50%) scale(var(--lens, 1));
		border-radius: 50%;
		box-shadow: 0 0 0 200vmax #000;
	}
	.hair {
		position: absolute;
		background: rgba(0, 0, 0, 0.9);
	}
	.hair.h {
		left: calc(50% - 35vmin);
		right: calc(50% - 35vmin);
		top: 50%;
		height: 1px;
	}
	.hair.v {
		top: calc(50% - 35vmin);
		bottom: calc(50% - 35vmin);
		left: 50%;
		width: 1px;
	}
	.hitmarker {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 26px;
		height: 26px;
		transform: translate(-50%, -50%);
		--len: 8px;
		--th: 2px;
		--col: #fff;
	}
	.hitmarker.hm-head {
		width: 30px;
		height: 30px;
		--len: 11px;
		--th: 3px;
		--col: #ffd24a;
	}
	.hitmarker.hm-kill {
		width: 44px;
		height: 44px;
		--len: 14px;
		--th: 3px;
		--col: #ff5a5a;
	}
	.hitmarker i {
		position: absolute;
		width: var(--len);
		height: var(--th);
		background: var(--col);
		box-shadow: 0 0 2px #000;
	}
	.hitmarker i:nth-child(1) {
		left: 0;
		top: calc((var(--len) - var(--th)) / 2);
		transform: rotate(45deg);
	}
	.hitmarker i:nth-child(2) {
		right: 0;
		top: calc((var(--len) - var(--th)) / 2);
		transform: rotate(-45deg);
	}
	.hitmarker i:nth-child(3) {
		left: 0;
		bottom: calc((var(--len) - var(--th)) / 2);
		transform: rotate(-45deg);
	}
	.hitmarker i:nth-child(4) {
		right: 0;
		bottom: calc((var(--len) - var(--th)) / 2);
		transform: rotate(45deg);
	}
	.hitmarker b {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 6px;
		height: 6px;
		margin: -3px 0 0 -3px;
		background: #ffd24a;
		box-shadow: 0 0 2px #000;
		transform: rotate(45deg);
	}
	.killfeed {
		position: absolute;
		top: max(54px, calc(14px + 44px * var(--hud-scale)));
		right: 18px;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		font-size: calc(13px * var(--hud-scale));
		max-width: calc(100vw - 32px);
	}
	.kill {
		background: rgba(8, 12, 18, 0.6);
		padding: 2px 8px;
	}
	.kill.mine {
		border: 1px solid rgba(255, 120, 120, 0.7);
	}
	.kill.hs {
		color: #ffd37a;
	}
	/* Bet panel: above the speedometer, clickable with a free cursor. */
	.bet {
		position: absolute;
		left: 50%;
		bottom: calc(110px * var(--hud-scale));
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 8px 12px;
		width: max-content;
		max-width: calc(100vw - 32px);
		box-sizing: border-box;
		font-size: calc(14px * var(--hud-scale));
		pointer-events: auto;
	}
	.bet.open {
		border-color: rgba(242, 163, 58, 0.6);
	}
	.bhead {
		display: flex;
		gap: 12px;
		align-items: baseline;
		flex-wrap: wrap;
		justify-content: center;
	}
	.bhead b {
		color: var(--text);
	}
	.picks {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: center;
		max-width: 100%;
	}
	.pick {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 5px 10px;
		font: inherit;
		color: var(--text);
		background: rgba(242, 163, 58, 0.14);
		border: 1px solid rgba(242, 163, 58, 0.6);
		border-radius: var(--radius);
		cursor: pointer;
		max-width: 100%;
		min-width: 0;
	}
	.pick:hover:not(:disabled) {
		background: rgba(242, 163, 58, 0.3);
	}
	.pick:disabled {
		cursor: default;
	}
	.pick .key {
		flex: none;
		min-width: 1.3em;
		padding: 0 3px;
		font-weight: 700;
		color: #000;
		background: var(--accent);
		border-radius: 2px;
	}
	.ptext {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.count {
		flex: none;
		color: var(--text-dim);
	}
	.tally {
		display: flex;
		gap: 8px;
		align-items: baseline;
		flex-wrap: wrap;
		justify-content: center;
	}
	.note {
		font-weight: 600;
	}
	.note.ok {
		color: #ffd37a;
	}
	.note.bad,
	.note.lost {
		color: #ff9a90;
	}
	.note.won {
		color: var(--good);
	}
	.note.refund {
		color: var(--info);
	}
	.weapon {
		position: absolute;
		right: 18px;
		bottom: 18px;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
		padding: 6px 12px;
		min-width: 150px;
		font-size: calc(14px * var(--hud-scale));
	}
	.wname {
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.hint {
		color: var(--text-dim);
	}
	.hint b {
		color: var(--text);
	}
	.slots {
		display: flex;
		gap: 6px;
	}
	.slot {
		color: var(--text-faint);
		font-size: 0.9em;
	}
	.slot.active {
		color: var(--text);
		font-weight: 600;
	}
	.cap {
		display: inline-block;
		margin-right: 3px;
		padding: 0 3px;
		border: 1px solid currentColor;
		border-radius: 2px;
		font-size: 0.85em;
	}
	.ammo {
		font-size: 1.6em;
		font-weight: 700;
		line-height: 1;
	}
	.mag.low {
		color: var(--bad);
	}
	.res {
		color: var(--text-dim);
		font-size: 0.7em;
	}
	.reload {
		width: 100%;
		height: 3px;
		background: rgba(255, 255, 255, 0.12);
	}
	.reload .fill {
		height: 100%;
		background: var(--accent);
	}
</style>
