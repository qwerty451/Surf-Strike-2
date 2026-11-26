# Netprobe

Run from the repository root with Node 24 and `pnpm install --frozen-lockfile`.

```sh
pnpm netprobe --url wss://HOST/ws --bots 8 --seconds 300
pnpm netprobe --url wss://HOST/ws --bots 8 --seconds 300 --loss 1
pnpm netprobe --url wss://HOST/ws --bots 8 --seconds 300 --loss 1 --jitter 10 --burst 180/8000
pnpm netprobe compare path/to/base.json path/to/test.json
```

The default output directory is `tools/netprobe/results`. Use `--out DIR` to save runs elsewhere. Keep the bot count, frame rates, impairment profile and map matched when comparing protocol versions. Each run has a two-second warm-up, followed by the requested measurement duration. Run on an idle surf lobby. The tool sends guest hello, state and pong messages. It records map changes, WebSocket close handshakes, bot leave events and the player count from `/health` after cleanup. SIGINT and SIGTERM close the clients.

Bots use the browser's fixed-step accumulator at 64 Hz with a 60 Hz sender frame clock by default. `--sender-fps 144` changes the sender cadence. Each bot traverses a phased copy of the same 16-second route, with 265 u/s straight runs, 1200 u/s arcs, stops, a reversal, and both sub-1024-u and longer teleports. One observer socket feeds separate copies of the interpolation buffer for 60 and 144 Hz sampling. Use `--fps 60` or `--fps 144` to measure a single rate.

Protocol v1 uses the wire format and the unmodified interpolation logic from `a64f384`. The tool reads the protocol version from `/health` before connecting. For v2 and v3, the adapter loads the browser's server clock, adaptive delay and interpolation buffer. The adapter uses server-assigned sample times when present in v3 snapshots.

## Record and replay

```sh
pnpm netprobe --url wss://HOST/ws --bots 8 --seconds 180 --trace
pnpm netprobe replay path/to/run.trace.json
pnpm --filter server exec tsx ../../tools/net-bench.ts --duration 45 --replay
```

`--trace` writes a separate file with the observer's raw snapshots, clock messages, and render-frame timestamps. It includes the warm-up and can grow by several megabytes per minute. The ordinary result JSON contains aggregates and cannot be replayed.

On v2 and v3 captures, replay compares three controllers on the same received poses and frame cadence. It loads the shared collision map named in the welcome and map changes. Older v2 or v3 traces that change maps need the new map ID in their clear events. `fixed` uses the v1 arrival-timed buffer with 100 ms delay. `previous` uses the adaptive delay policy and 50 ms extrapolation limit from `9f0a37c` with the current interpolation code. `tuned` follows the current browser code. A v1 capture only replays the fixed controller because its packets lack the server timestamps required by the adaptive controllers. Net-bench can run the same replay against its local impairment profiles.

## Metrics

- **Target-time error outside teleports** compares the rendered pose with the bot's true pose at frame time minus configured delay. It excludes target times within 200 ms of a scripted teleport and still includes the effect of transport, relay and buffer timing on continuous motion. **All-frame target-time error** includes those frames. A small error in teleport timing can yield the full jump distance there. **Path error** measures the spatial distance to the closest point on the known path within the last two seconds.
- **Effective delay** is the age of that closest point. Netprobe omits ambiguous times at stops and on retraced sections, poses more than 8 u off the path, and estimates that hit the search bound.
- **Speed wobble** is the RMS difference between speed measured from successive rendered positions and speed over an equal duration on the path at the estimated pose time. It excludes teleport jumps.
- **Underrun** counts frames that need data newer than the buffer has. **Freeze** counts pairs of rendered frames where the pose moves less than 0.01 u while the known path moves. The reported duration sums across bots, and the count over 100 ms is per bot per episode. Missing poses, scripted stops and teleport level changes are excluded.
- **Correction jump** is the magnitude of a frame's displacement minus the expected displacement along the known path over that frame. Replay reports p99 and maximum in world units. It excludes teleport level changes.
- **Teleport slides** are teleports with an observed intermediate height more than 3 u from either endpoint. A teleport counts as a snap if the observer sees the destination within two seconds and draws no intermediate height. JSON records missed and unresolved events. The final two seconds are excluded from the expected teleport count so each counted event has a full observation window.
- **Snapshot payload bytes** count valid binary snapshot message lengths at the observer, after any WebSocket decompression. They exclude framing and TCP/TLS overhead.
- **Snapshot spacing** is measured once on the observer socket and reported at each render rate. **RTT** is measured with a WebSocket ping/pong once per second and includes the route to the peer that answers the ping. Frame intervals report the actual Node timer cadence.

The relay runs on localhost and forwards the encrypted TCP stream to the original address. TLS certificate and hostname verification stay enabled. `--loss 1` holds roughly 1% of the stream chunks for 100 ms to model retransmit latency. It preserves byte order, so later chunks wait behind a held chunk. `--jitter 10` adds a uniform 0 to 10 ms hold to each chunk. `--burst 180/8000` holds both directions for recurring 180 ms intervals every 8 seconds. `--seed` controls the random sequence. The operating system and TLS determine chunk boundaries, so real-world timing can vary with the same seed. Node timers approximate a browser display clock. The live probe runs without a renderer or player input. Replay adds the shared static collision world for v2 and v3.
