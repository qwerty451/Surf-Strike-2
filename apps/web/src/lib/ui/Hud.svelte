<script lang="ts">
	import { onMount } from 'svelte';
	import type { ScorePanelInput } from '@surf/shared';
	import type { GameApi, HudStateShape } from '#lib/game/contract.js';
	import { cvarNum } from '#lib/ui/format.js';
	import Speedometer from '#lib/ui/Speedometer.svelte';
	import Timer from '#lib/ui/Timer.svelte';
	import SplitPopup from '#lib/ui/SplitPopup.svelte';
	import MapInfo from '#lib/ui/MapInfo.svelte';
	import ConnectionStatus from '#lib/ui/ConnectionStatus.svelte';
	import Chat from '#lib/ui/Chat.svelte';
	import ScorePanel from '#lib/ui/ScorePanel.svelte';
	import Crosshair from '#lib/ui/Crosshair.svelte';
	import { crosshairOpacity } from '#lib/game/gunfeel.js';
	import KeysDisplay from '#lib/ui/KeysDisplay.svelte';
	import PosReadout from '#lib/ui/PosReadout.svelte';
	import Scoreboard from '#lib/ui/Scoreboard.svelte';
	import SpectatorBar from '#lib/ui/SpectatorBar.svelte';
	import Console from '#lib/ui/Console.svelte';
	import EscMenu from '#lib/ui/menu/EscMenu.svelte';
	import AuthPanel from '#lib/ui/AuthPanel.svelte';
	import DesktopOnly from '#lib/ui/DesktopOnly.svelte';
	import TagHud from '#lib/ui/TagHud.svelte';
	import ZombiesHud from '#lib/ui/ZombiesHud.svelte';
	import InfectedHud from '#lib/ui/InfectedHud.svelte';
	import BoxNews from '#lib/ui/BoxNews.svelte';
	import AwardPopups from '#lib/ui/AwardPopups.svelte';
	import BanScreen from '#lib/ui/BanScreen.svelte';
	import HnsHud from '#lib/ui/HnsHud.svelte';

	let { hud, api }: { hud: HudStateShape; api: GameApi } = $props();

	// UI clock for fades and countdowns (same timebase as hud timestamps).
	let now = $state(performance.now());
	onMount(() => {
		let raf = 0;
		const loop = () => {
			now = performance.now();
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});

	const race = $derived(hud.modeFamily === 'race');
	const showFps = $derived(cvarNum(hud.cvars, 'cl_showfps', 0) !== 0);
	const showKeys = $derived(cvarNum(hud.cvars, 'cl_showkeys', 0) !== 0);
	const showPos = $derived(cvarNum(hud.cvars, 'cl_showpos', 0) !== 0);
	const showScorePanel = $derived(cvarNum(hud.cvars, 'cl_scorepanel', 1) !== 0 && !hud.scoreboardOpen);
	const scoreInput: ScorePanelInput = $derived({
		rows: hud.scoreboard,
		selfId: hud.selfId,
		selfName: hud.selfName,
		online: hud.online,
		state: hud.modeState,
		staged: hud.stageKind === 'stage',
		records: {
			pbTicks: hud.pbTicks,
			pbRank: hud.pbRank,
			recordTicks: hud.recordTicks,
			recordName: hud.recordName,
			top: hud.recordTop
		},
		coins: hud.multiplier
	});
	const modal = $derived((hud.ban !== null && !hud.ban.minimized) || hud.consoleOpen || hud.settingsOpen || hud.authPanelOpen);
	const clickHint = $derived(!hud.pointerLocked && !modal && !hud.chatOpen && !hud.desktopOnly);
</script>

{#if hud.desktopOnly}
	<DesktopOnly />
{:else}
	<div class="hud" class:under-menu={hud.settingsOpen && !hud.authPanelOpen}>
		{#if hud.hns}<HnsHud h={hud.hns} {now} part="screen" />{/if}
		<div class="top-centre" data-top-hud>
			<MapInfo mapId={hud.mapId} mode={hud.gameMode} />
			{#if hud.spectating}<SpectatorBar spectating={hud.spectating} />{/if}
			{#if hud.tag}<TagHud tag={hud.tag} {now} />{/if}
			{#if hud.hns}<HnsHud h={hud.hns} {now} part="top" />{/if}
		</div>

		<div class="top-right">
			<ConnectionStatus
				online={hud.online}
				connecting={hud.connecting}
				playerCount={hud.playerCount}
				maxPlayers={hud.maxPlayers}
				{showFps}
				fps={hud.fps}
			/>
		</div>

		<div class="top-left">
			{#if showPos}<PosReadout pos={hud.pos} speed={hud.speed} />{/if}
			{#if hud.ban?.minimized}<BanScreen ban={hud.ban} {now} {api} />{/if}
			<AwardPopups popups={hud.awardPopups} {now} max={5} />
		</div>

		{#if hud.zombies}<ZombiesHud z={hud.zombies} {now} />{/if}
		{#if hud.infected}<InfectedHud inf={hud.infected} {now} />{/if}
		{#if showScorePanel}<ScorePanel mode={hud.gameMode} input={scoreInput} unofficial={race && hud.unofficial} />{/if}
		{#if !hud.zombies?.scoped && !hud.infected?.scoped && !hud.hns?.blindfold && crosshairOpacity(hud.infected?.aimT) > 0}<Crosshair cvars={hud.cvars} spreadDeg={hud.infected?.spreadDeg} opacity={crosshairOpacity(hud.infected?.aimT)} />{/if}

		<div class="below-crosshair">
			{#if clickHint}
				<div class="click-hint ss-panel ss-shadow">Click to play</div>
			{/if}
			{#if showKeys}<KeysDisplay keys={hud.keys} />{/if}
		</div>

		<div class="bottom-centre">
			{#if race}<div class="split-slot"><SplitPopup split={hud.splitPopup} {now} /></div>{/if}
			<Speedometer speed={hud.speed} trend={hud.speedTrend} />
			{#if race && (!hud.spectating || !hud.spectating.freeFly)}
				<Timer
					ticks={hud.runTicks}
					phase={hud.runPhase}
					stage={hud.stage}
					stageCount={hud.stageCount}
					kind={hud.stageKind}
				/>
			{/if}
		</div>

		<div class="bottom-left">
			<Chat lines={hud.chat} open={hud.chatOpen} {now} {api} />
		</div>

		{#if hud.scoreboardOpen}
			<Scoreboard
				rows={hud.scoreboard}
				mapTitle={hud.mapTitle}
				mapId={hud.mapId}
				playerCount={hud.playerCount}
				maxPlayers={hud.maxPlayers}
				staged={hud.stageKind === 'stage'}
				mode={hud.gameMode}
				selfId={hud.selfId}
				state={hud.modeState}
				richest={hud.richest}
				account={hud.account?.username ?? null}
			/>
		{/if}
	</div>

	{#if hud.settingsOpen && !hud.authPanelOpen}<EscMenu
			cvars={hud.cvars}
			{api}
			account={hud.account}
			online={hud.online}
			coins={hud.coins}
			shop={hud.shop}
			casino={hud.casino}
			multiplier={hud.multiplier}
			richest={hud.richest}
			maps={hud.maps}
			mapId={hud.mapId}
			lobbies={hud.lobbies}
			playerCount={hud.playerCount}
			adminState={hud.adminState}
			adminNotice={hud.adminNotice}
			blocked={hud.consoleOpen}
			fullscreenSupported={hud.fullscreenSupported}
		/>{/if}
	{#if hud.authPanelOpen}<AuthPanel
			{api}
			online={hud.online}
			connecting={hud.connecting}
			error={hud.authError}
			busy={hud.authBusy}
			guestName={String(hud.cvars.name ?? '')}
		/>{/if}
	<BoxNews
		news={hud.boxNews}
		{now}
		{api}
		enabled={cvarNum(hud.cvars, 'cl_boxnews', 1) !== 0}
		hidden={hud.consoleOpen || (hud.ban !== null && !hud.ban.minimized)}
		menu={hud.settingsOpen && !hud.authPanelOpen}
	/>
	{#if hud.ban && !hud.ban.minimized}<BanScreen ban={hud.ban} {now} {api} />{/if}
	{#if hud.consoleOpen}<Console lines={hud.consoleLines} {api} isOpen={() => hud.consoleOpen} />{/if}
{/if}

<style>
	.hud {
		position: absolute;
		inset: 0;
		pointer-events: none;
		user-select: none;
		color: var(--text);
		font-family: var(--ui-font);
	}
	/* Esc menu open: the game stays visible behind it, the HUD does not. */
	.under-menu {
		opacity: 0;
	}
	.top-centre {
		position: absolute;
		top: 14px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}
	.top-right {
		position: absolute;
		top: 14px;
		right: 18px;
	}
	.top-left {
		position: absolute;
		top: 14px;
		left: 18px;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
	}
	.below-crosshair {
		position: absolute;
		left: 50%;
		top: calc(50% + 48px);
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
	}
	.click-hint {
		padding: 6px 16px;
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		animation: pulse 2.4s ease-in-out infinite;
	}
	.bottom-centre {
		position: absolute;
		left: 50%;
		bottom: 26px;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}
	.split-slot {
		min-height: calc(34px * var(--hud-scale));
		display: flex;
		align-items: flex-end;
		margin-bottom: 4px;
	}
	.bottom-left {
		position: absolute;
		left: 18px;
		bottom: 22px;
	}
	@keyframes pulse {
		50% {
			opacity: 0.6;
		}
	}
</style>
