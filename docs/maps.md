# Maps

Nine original maps across three gamemodes: surf_aurora (easy), surf_ember, surf_skyrend (staged, 7 stages), surf_hadal (linear, 8 sections); bhop_meadow (easy), bhop_circuit, bhop_reliquary (sunken temple), bhop_rimefall (night glacier); tag_quayside (harbour town, see [modes.md](modes.md)). The four original designs are described below; the newer maps document their layout in their source files. Each has its own theme. None of them copies an existing community map; they use the genre's standard building blocks (surf ramps, transfers, bhop blocks).

## Map format

Maps are TypeScript modules in `packages/shared/maps/`, built from code so both client and server can load them without file downloads.

```ts
interface MapDef {
  id: string;                  // "surf_aurora"
  title: string;               // "Aurora"
  kind: GameModeId;            // the gamemode: 'surf' | 'bhop' | 'tag' | 'zombies' | 'hns' (modes.md)
  difficulty: 'easy' | 'hard';
  size?: 'medium' | 'large'; // maps that come in sizes: shown instead of the difficulty
  layout: 'linear' | 'staged' | 'open';  // 'open' = tag maps
  cvars: Partial<Cvars>;       // overrides on top of the mode's profile (physics.md, modes.md)
  spawn: { pos: Vec3; yaw: number };     // race: in the start zone; tag: fallback spawn
  spawns?: Spawn[];            // tag (required, >= 8): random spawns for joins and fall-outs
  hns?: { hiderSpawns: Spawn[]; seekerSpawns: Spawn[]; seekerCage?: { min: Vec3; max: Vec3 }; cashBag?: { pos: Vec3; place: string } };  // hide and seek (required there): >= 8 hider spawns, >= 2 seeker spawns (modes.md#hide-and-seek)
  defense?: DefenseMapInfo;    // Zombie Defense (required there): openings, turret pads, zombie spawn areas, nav graph (see below)
  brushes: Brush[];            // solid convex brushes
  zones: Zone[];               // start, end, stage/checkpoint, teleport
  theme: Theme;                // sky, fog, palette, lights, materials
}

type Brush =
  | { type: 'box'; min: Vec3; max: Vec3; material: string }
  | { type: 'ramp'; /* triangular prism: base, length, height, side */ material: string }
  | { type: 'convex'; planes: Plane[]; material: string };

type Zone =
  | { type: 'start' | 'end'; min: Vec3; max: Vec3 }
  | { type: 'stage' | 'checkpoint'; index: number; min: Vec3; max: Vec3; respawn: { pos: Vec3; yaw: number } }
  | { type: 'teleport'; min: Vec3; max: Vec3; to: 'stage' | 'start' };
```

Helper functions (`ramp()`, `platform()`, `wall()`, `blockRow()`) keep map files readable. At load, each brush becomes collision planes plus a Three.js mesh. Materials are procedural (shader noise, triplanar mapping), so there are no texture files.

Zones render as CS-style glowing outlines: start green, end red, stages and checkpoints blue. Only race modes draw start/stage/checkpoint outlines; other modes (Zombie Run) use checkpoints internally and draw only the end zone.

### Glass

A material with `glass: true` (and/or `opacity` below 1; glass defaults to 0.3) is see-through: the renderer draws it blended after opaque geometry, from both sides, without depth writes, with a bright fresnel rim; give it an `edgeColor` so its outline reads. Collision is unchanged: glass is as solid as any brush (walls, ceilings, floors, even a surfable glass ramp).

### Fake brushes

Any brush may set `solid: false`: it is rendered exactly like a solid brush (same material, no hint) but `buildCollisionWorld` skips it, so players walk through it. Hide and seek maps use it for clip-through walls, hedges and hollow props (Hammer's `func_illusionary`). A teleport zone with `dest` moves the player to that fixed spawn (secret passages).

### Hard-surf obstacles

`maps/surf-obstacles.ts` has generic builders for obstacles placed ON the intended line (unlike scenery, which keeps ≥ 256 from it): `wallWithHole()` (window or narrow slot in a thick wall), `floorWithHole()` (drop through a slab), `glassPanel()`, `pillar()`, `orientedBox()` (box at any heading; a `convex` brush off-axis), `spiralSteps()` (downward spiral peak steps for `rampChain`). Each obstacle lists the openings (`Gate`s) its intended line flies through. The same module has a route bot (`runRouteBot`: rides chains at a target face fraction, flies transfers with no input, steering to an aim point, through gates, or with a full-rate air-strafe turn) and `gateCrossing()`, so map tests prove with the real physics that a skilled line passes every hole and that sloppier lines (offset, ±15% speed, no air strafe) hit the obstacles.

Race-only rules (one start and one end zone, spawn in the start zone, contiguous stages/checkpoints) apply to race modes. A tag map (`kind: 'tag'`) has `layout: 'open'`, at least 8 `spawns` that stand free on walkable ground in the real collision trace, and only teleport zones, with one under everything. In tag, every teleport zone respawns the player at a random spawn, whatever its `to` says. `mapsForMode(mode)` lists the rotation maps of one mode. `maps/maps.test.ts` checks all of this.

## surf_aurora — easy surf, linear

Theme: dusk over a snowy valley. Aurora ribbons in a dark-blue sky gradient, ice-blue ramps with frosted edges, soft fog.

- Start platform with a drop onto the first ramp.
- 6 long, wide ramp pairs (left/right) at gentle angles (about 50–55° from horizontal).
- Each pair is an open V: the base edges are 128 units apart, so a player who stops surfing falls through the middle (no free slide down a closed crease). The start platform and respawn ledges drop onto the left ramp's face.
- Generous gaps between ramps; every transfer is straight ahead.
- 3 checkpoint zones for splits.
- Falling to the valley floor teleports to the start and resets the timer.
- Target time for a new player: 1:30–2:00.

## surf_ember — surf, staged (rated easy)

Theme: volcanic canyon. Black basalt ramps with glowing orange seams, lava sea below, ember particles, orange haze.

- 6 stages, each with its own start zone and respawn.
- Steeper, narrower ramps (about 60–65°).
- Transfers that need a turn in the air, one up-ramp that needs speed, one long gap that rewards speed from the previous stage.
- Falling into the lava teleports to the current stage start; the timer keeps running.
- Target time for a new player: 4:00+.

## bhop_meadow — easy bhop

Theme: floating grass islands at noon. Bright sky, soft clouds, stone blocks with moss tops.

- About 40 blocks in 5 sections, each section ending in a checkpoint.
- Wide blocks (128 × 128 units) with gaps of 96–160 units.
- Mostly straight lines with a few gentle turns.
- Falling teleports to the last checkpoint.
- Target time for a new player: 1:00–1:30.

## bhop_circuit — hard bhop

Theme: neon circuit board at night. Dark blocks with glowing cyan and magenta edges, grid floor far below.

- About 60 blocks in 6 sections, each ending in a checkpoint.
- Smaller blocks (64 × 64 units), gaps up to 240 units that need built-up speed.
- Sharp strafe turns, a few height changes, and narrow strips.
- Falling teleports to the last checkpoint.
- Target time for a new player: 2:30+.

## surf_kessler — hard surf, staged (6 stages)

Theme: derelict orbital station at night, one neon colour per module. Each stage has its own signature obstacle (details and numbers in `surf_kessler.ts`):

1. Window in a bulkhead between the first two ramps, then twin pillars on the flight to the next platform.
2. A 224 × 256 window between a 120° right curve and a 90° left curve, low ceiling ribs over the second curve.
3. A 540° downward spiral (radius 1200 → 2600) around a reactor core, then a glass floor with a hole: drop through onto the ramp under it.
4. A 70° wall-surf face inside a glass corridor (glass wall beside it, glass lid over it), exit through a hole in a bulkhead.
5. A 130° air-strafe turn through two offset windows, then a 160-wide slot between narrow ramps.
6. A long steep descent, pillars in the long gap, and a final hole into the closed end room.

## surf_ochre — hard surf, linear

Theme: desert canyon at golden hour. Checkpoints are splits; any fall resets to the start. Nine hard moments: a narrow slot in a canyon fin, low arches over a bend, a 450° sinkhole spiral, a glass floor hole onto a ramp below it, hoodoo pillars to strafe around, two glass tubes over switch transfers (one switch ramp is glass), a far speed window off a wave, an up-ramp into a high window followed by a 130° air turn, and arches over the final descent.

## zombies_lowtide — Zombie Run, linear

Theme: an abandoned seaside town at dusk in sea fog. Beach car park (start) → main street with side pockets and a barricade → narrow alley → promenade and a bridge over a creek → cannery yard → harbour road → pier with the evac boat. Five gates split it into six zones, each with a checkpoint and an unlock area before its gate. Zombie Run maps add `zombies: { path, spawnZones, gates }` (`ZombieRoute` in `maps/types.ts`): the waypoint route the AI follows, zombie spawn areas tagged with the route node they feed, and the gates (solid boxes outside `brushes`, an `unlock` area and a route `node`). Map tests check spawns, checkpoint respawns, waypoints and spawn areas stand free, and walk the whole route with the real movement at the slowest weapon speed; shared tests send a zombie from every spawn area to the evac point.

## Zombie Defense maps

A Zombie Defense map (`kind: 'defense'`, `layout: 'open'`) is a base the team holds against waves of zombies coming from every side (modes.md#zombie-defense). `MapDef.spawns` (>= 4) and `spawn` are inside the base. `MapDef.defense` (`DefenseMapInfo` in `maps/types.ts`) has four parts:

- `openings`: the barricades. Each is a box (`min`..`max`) that exactly fills a gap in the base wall: the wall's full thickness, jamb to jamb, sill (or floor) to lintel. It is not in `brushes`: while the opening has at least one plank the mode adds the box to the collision (players and zombies), and bullets pass through it. `outside` and `inside` are nav node indices just outside (where zombies tear planks off) and just inside (where players repair). `planks` defaults to 6.
- `pads`: fixed turret spots inside the base or on its walls (`pos` is the floor point, `yaw` the default facing).
- `spawnZones`: zombie spawn areas outside, boxes standing on walkable floor (`min.z` = floor top), each with the nav `node` its zombies start from.
- `nav`: the AI's walkable graph (`nodes` are feet positions on the floor, `links` undirected node pairs). The straight line of every link is walkable for the player hull with every barricade open, the graph is connected, and every path from outside to inside goes through an opening's `outside` → `inside` link.

`maps/maps.test.ts` checks every defense map: only teleport zones with one under everything, no intersecting boxes, a connected nav graph on walkable floor that splits into exactly an outside and an inside part when the opening links are removed, openings facing at least three directions, spawns and pads inside, spawn areas on floor outside.

## defense_blackthorn — Zombie Defense ("Blackthorn Farm")

Theme: a walled stone farmstead on open fields at harvest-moon dusk, with orange haze on the horizon, fireflies over the yard, lanterns, an orchard (NW), a windmill (NE), haystacks (SE), a shed (E) and a farm track running south from the gate. A 256-tall hedgerow at x ±2688, y ±2560 bounds the fields, with a teleport under the map. 189 box brushes.

- **Base:** the farmyard, inner faces x ±768, y ±640, walls 48 thick (outer x ±816, y ±688). The west and east walls are solid to 272. The north and south walls are solid to 168, then have a 40-tall firing slot (168–208) between timber posts, then are solid again to 272, with a tiled roof (272–288) over the wall-walk. The slot is lower than the ducked hull (54), so nobody fits through it.
- **Wall-walks:** timber decks at z 128 along the inside of the north and south walls (y ±512..640). Each is reached by one flight of 8 steps: the NW flight at x −640..−512 climbs north, the SE flight at x 512..640 climbs south. Players shoot down into the yard and out through the slot. Zombies that get inside can climb up too.
- **Openings (8),** a door and a window on every side. Doors stand on the floor and are 112 wide, 128 tall. Windows are 96 wide on a 16-high sill (one step), 96 tall. The south gate is 192 wide and 144 tall with 8 planks. Their ids are `north_door`, `north_window`, `east_door`, `east_window`, `south_gate`, `south_window`, `west_window` and `west_door`. Nav nodes sit 64 outside the outer face and 80 inside the inner face. The north and south inside nodes are under the decks (headroom 112).
- **Turret pads (8):** four on the wall-walks (`pad_walk_nw`/`ne`/`sw`/`se` at x ±256, y ±536, z 128) and four in the yard (`pad_west` and `pad_east` at x ±576, `pad_north` and `pad_south` at y ±256). Every opening is in sight of at least two pads within 900 units.
- **Yard:** a covered well in the middle, hay bales and crates around it, bales in the SW corner and a hay cart in the NE corner. The 8 player spawns stand round the well, facing out.
- **Zombie spawn areas (8):** two per side, about 1100 out from the walls (north and south at x ±640 and |y| 1824..2016; west and east at y ±480 and |x| 1888..2080). Each feeds a ring of nav nodes 192 outside the walls, which leads to every opening's outside node.

The nav graph has 66 nodes and 82 links: the outside ring, the opening nodes, an octagon round the well, the two stair flights and the wall-walks. `maps/defense_blackthorn.test.ts` checks the map:

- Every nav link is walked both ways with `playerMove`, staying on the straight line, with all barricades open.
- A ducked hull swept every 8 units along and up every wall (from the floor to the roof) is stopped everywhere when all openings are boarded, and gets through at the openings when they are open.
- Each opening box is flush against its jambs, sill and lintel and touches no brush.
- Nothing outside near the base is high enough to climb over the walls.
- Spawns and pads stand on the floor inside the base, and pads keep 48 clear of nav links.
- The spawn areas stand on walkable floor 900–2000 from the base, on every side.

## hns_lido / hns_lido_m — hide and seek, open ("Lido Bay", Large / Medium)

Two sizes under one title; `MapDef.size` is shown instead of the difficulty badge (Change map) and after the title in text (`mapTitle()`: votes, RTV, chat, admin list, scoreboard). The two are built by the same modules (`maps/hns_lido-variant.ts`); the text below is Large (`hns_lido`).

**Medium** (`hns_lido_m`) is the western part, closed at x = 1280: 5888 × 7680 (63.9% of the area, 62.9% of the walkable positions, ~43 s to cross). It has the hotel, old town and chapel, plaza with the security office, hedge maze and gardens, avenue, sewer, promenade, west beach with the huts and lifeguard tower, pier, lighthouse and sea cave; no pool club, car park, boathouse, beach bar or tennis court. `MapBuilder.clip` cuts ground and structure at the edge and leaves out props that would stick out; `maps/hns_lido-medium.ts` builds what stands at the cut: a row of closed houses with café terraces, a closed road tunnel, a locked promenade gate, fallen rocks on the beach and in the sea, and a garden wall with a duck-only culvert (the cliff behind all of it is the boundary). The sewer's underpass stairs move west to x = 864–1152. Teleporters: the pool drain, the elevator and the boathouse crate are gone; the phone boxes link promenade ↔ hotel forecourt, the changing cubicles link beach hut 0 ↔ hut 7; the rest is unchanged (13 in all, 9 hidden). 44 hiding spots, 5 crawlspaces, 17 hider spawns.

A seaside resort in a cove, 9216 × 7680 (x [-4608, 4608], y [-3840, 3840]), built from ~11 900 brushes in `maps/hns_lido*.ts` with the furniture and wall builders in `maps/hns-props.ts`. Design and checklist: [research/hide-and-seek-maps.md](research/hide-and-seek-maps.md).

- **North:** the Grand Hotel (3 storeys, basement, roof with a sealed penthouse; lobby, restaurant, bar, library, kitchen, 21 guest rooms), the hedge maze gardens with a greenhouse and a shed, the car park (two decks on walkable ramps, stair cores, an elevator shaft, container yard).
- **Middle:** the old town (10 two-storey shop houses on a market lane, back yards with a well, a chapel with a crypt and a bell tower), the plaza (fountain, bandstand, kiosks, playground, and the seekers' **security office**), the pool club (sunken pool with see-through water, diving tower, pool house, pump room, tennis court).
- **Avenue / sewer:** a road with parked cars over a sewer tunnel (underpass stairs, crawl pipe to the hotel laundry).
- **South:** promenade, beach (huts on stilts, lifeguard tower, beach bar, boathouse), the pier with an arcade pavilion, knee-deep sea, the lighthouse on the rocks with a sea cave.

`MapDef.hns`: 16 hider spawns around the plaza and beyond; 4 seeker spawns in the security office (`seekerCage` = its interior; one doorway, seekers are frozen there by the mode). 55 declared hiding spots (`LIDO.spots`, each with a floor position) include 25 behind or inside clip-through brushes (fake bookcases, lockers, hedges, rock face, brick wall, vending machine, ceiling tiles, wardrobes, dumpsters, a sarcophagus, a covered boat, a container), roof spots reached by prop climbs, five crouch-jump climbs, five duck-only crawlspaces (hotel ceiling void, laundry pipe, under the beach huts, under the bandstand, the car park duct) and 16 teleporters with fixed destinations (12 hidden: fireplace ↔ penthouse wardrobe, wine cask ↔ crypt, well ↔ sewer drain, maze plinth ↔ belfry bell, elevator → hotel water tank, arcade cabinet → sea cave, boathouse crate → lighthouse gallery, pool drain → pump room; 2 visible pairs: phone boxes, changing cubicles). Every one-way teleporter has a walking way back. The boundary is terraced cliffs with an invisible clip wall to 2048 and an invisible sea wall; a teleport under the map respawns fall-outs.

The **cash bag** spot (`cashBag`, per size in `maps/hns_lido-variant.ts`) is open plaza ground: Large (320, −64, 0), east of the fountain, 326 units from the arena's centre; Medium (−1664, 0, 0), the exact centre, between the bandstand and the chapel. The tests check 96 free units around it, ground, open sky, distance to the centre, spots, teleporters and cage, and that it is walked to without a jump from the cage and every hider spawn.

`hns_lido.test.ts` runs every check on both sizes and proves them with the real collision and movement: no intersecting solid boxes, free spawns and destinations, closed boundary (sampled), non-solid fakes, crawlspaces (stand blocked, duck passes), the crouch-jump climbs with `playerMove`, and a conservative reachability graph (`maps/hns-nav.ts`: 32-unit columns plus explicit points, box-path moves with walk ≤ 18 rise, jump 50, crouch-jump 62, duck-jump 48) showing every spot and teleporter is reachable from the hider spawns and from the cage, nothing reachable is a trap (everything leads back to the cage) or outside the boundary, and the farthest walking route is ~14 200 units (~57 s at 250 u/s).

## Default map

The server and solo mode start on `surf_aurora`.
