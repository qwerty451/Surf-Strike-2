<script lang="ts">
	import type { NetGraphView } from '#lib/game/contract.js';

	let {
		graph,
		level,
		online,
		fps
	}: {
		graph: NetGraphView | null;
		level: number;
		online: boolean;
		fps: number;
	} = $props();

	let canvas: HTMLCanvasElement | undefined = $state();

	const W = 240;
	const H = 48;

	const fmtKb = (bps: number) => `${(bps / 1024).toFixed(1)} KB/s`;
	const fmtRtt = (ms: number) => (ms >= 0 ? `${Math.round(ms)}ms` : '—');

	$effect(() => {
		if (level < 2 || !canvas || !graph) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const samples = graph.samples;
		ctx.clearRect(0, 0, W, H);

		// Reference lines: 31.25 ms (32 Hz target) and 65 ms (stall threshold).
		const maxMs = 100;
		const yOf = (ms: number) => H - Math.min(H, Math.max(0, (ms / maxMs) * H));

		ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		const y32 = Math.round(yOf(31.25)) + 0.5;
		ctx.moveTo(0, y32);
		ctx.lineTo(W, y32);
		ctx.stroke();

		const n = samples.length;
		const barW = 2;
		const startX = W - n * barW;
		for (let i = 0; i < n; i++) {
			const s = samples[i]!;
			const h = Math.max(1, Math.min(H, (s.gapMs / maxMs) * H));
			ctx.fillStyle = s.underrun || s.gapMs > 65 ? '#ff5a4e' : s.gapMs > 38 ? '#f2c45a' : '#5fe07a';
			ctx.fillRect(startX + i * barW, H - h, barW - 0.5, h);
		}

		// Overlay RTT line.
		if (n > 1) {
			ctx.strokeStyle = 'rgba(124, 196, 255, 0.85)';
			ctx.lineWidth = 1.25;
			ctx.beginPath();
			let started = false;
			for (let i = 0; i < n; i++) {
				const s = samples[i]!;
				if (s.rttMs <= 0) continue;
				const x = startX + i * barW + 0.5;
				const y = yOf(Math.min(maxMs, s.rttMs));
				if (!started) {
					ctx.moveTo(x, y);
					started = true;
				} else {
					ctx.lineTo(x, y);
				}
			}
			if (started) ctx.stroke();
		}
	});
</script>

{#if level > 0 && graph}
	<div class="netgraph ss-panel ss-num ss-shadow" aria-label="Network graph">
		<div class="row">
			<span><em class="k">fps</em> {Math.round(fps)}</span>
			{#if online}
				<span><em class="k">rtt</em> {fmtRtt(graph.rttMs)} <em class="dim">(±{graph.jitterMs.toFixed(1)}ms)</em></span>
				<span><em class="k">interp</em> {Math.round(graph.interpMs)}ms</span>
				<span><em class="k">snap</em> {graph.snapHz.toFixed(1)}/s</span>
			{:else}
				<span class="dim">offline (solo)</span>
			{/if}
		</div>
		{#if online}
			<div class="row sub">
				<span class:warn={graph.underruns > 0}>
					<em class="k">und</em> {graph.underruns} ({Math.round(graph.underrunMs)}ms · ext {Math.round(graph.extrapMs)}ms)
				</span>
				<span class:warn={graph.dupPct > 5 || graph.lateCount > 5}>
					<em class="k">dup</em> {graph.dupPct.toFixed(0)}% · <em class="k">late</em> {graph.lateCount}
				</span>
				<span><em class="k">in</em> {fmtKb(graph.inBytesPerSec)} · <em class="k">out</em> {fmtKb(graph.outBytesPerSec)}</span>
			</div>
			{#if level >= 2}
				<canvas bind:this={canvas} width={W} height={H} class="spark"></canvas>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.netgraph {
		padding: 5px 8px;
		font-size: calc(12px * var(--hud-scale));
		font-weight: 600;
		line-height: 1.3;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		white-space: nowrap;
	}
	.row {
		display: flex;
		align-items: baseline;
		gap: 9px;
	}
	.sub {
		font-size: calc(11px * var(--hud-scale));
		color: var(--text-dim);
	}
	.k {
		font-style: normal;
		color: var(--text-dim);
		text-transform: uppercase;
		font-size: 0.85em;
		letter-spacing: 0.05em;
	}
	.dim {
		font-style: normal;
		color: var(--text-dim);
	}
	.warn {
		color: var(--system);
	}
	.spark {
		width: 240px;
		height: 48px;
		margin-top: 2px;
		background: rgba(0, 0, 0, 0.35);
		border: 1px solid var(--panel-border);
		border-radius: 2px;
		display: block;
	}
</style>
