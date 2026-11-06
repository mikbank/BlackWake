# System authoring and generation

The game loads ordinary JSON definitions. The generator is a development tool; generated files become editable content, and the browser needs no filesystem access or generation service.

## Current network

```text
Kepler Drift ←→ Ashen Reach ←→ Vesper ←→ Lacuna
                                       ├─ Halcyon ─┬─ Ilex
                                       │           └─ Meridian
                                       └─ Nacre ────── Brume
```

Ashen has separate physical exits for Kepler and Vesper. Vesper was created with the checked-in `content/expansions/vesper.json` blueprint, then customized: its primary is **The Lantern** and its station is **Lantern Anchorage**. The original IDs and generation metadata remain intact. Its freighter carries a delivery to Relay through Ashen without unloading at that intermediate stop.

Player cruise (touch button or C) provides faster local travel with automatic slowdown near each exit. NPCs currently retain their existing travel speed/schedules. The universe map groups destinations by region and previews one route at a time; plotting never executes a jump. The separate jump menu lists only valid direct connections from the current physical exit. It guides to the correct next exit. Every jump still requires reaching that exit and slowing down, and the player explicitly initiates each jump. Plotted destinations persist across intermediate jumps/save/load. Stop or a new manual flight destination cancels the plotted route. Follow remains a separate identity-tracking order.

## Files

| Path | Purpose |
| --- | --- |
| `content/universe.json` | Ordered system IDs and shared cultures, designs, radio profiles, themes, sizes, goods and markets |
| `content/systems/<id>.json` | One complete editable local system |
| `content/presets.json` | Authoring presets: environment/culture references, layout ranges, station/services, market bands and traffic mix |
| `content/expansions/*.json` | Optional small blueprints describing new systems and graph connections |
| `src/content/system-index.ts` | Generated static JSON imports for browser/Node parity; do not hand-edit |
| `src/content/data.ts` | Shared loading/validation boundary |
| `src/content/routes.ts` | Shared directed graph resolver and access-policy seam |
| `tools/universe.ts` | CLI entrypoint |

Existing hand-authored IDs—Haven, Relay, ships and the Ashen–Kepler gates—are preserved. `createCatalog()` remains the game entry point. Both browser and CLI use the same catalog, service and NPC-policy validation. `prebuild`/`pretest` check that the generated import index matches the manifest; `predev` synchronizes it.

## Commands

From the project directory:

```bash
npm run universe:validate
npm run universe:sync
```

Validation is read-only and checks source references plus import-index freshness. Sync validates and updates generated imports; use it after manually adding a file and manifest entry. Editing an existing system requires no import-index change.

Create one additional system and connect it to an existing neighbor:

```bash
npm run system:create -- --id nova --name Nova --seed 83 --preset frontier --connect ashen --x 2 --y 1 --dry-run
npm run system:create -- --id nova --name Nova --seed 83 --preset frontier --connect ashen --x 2 --y 1
```

`--connect` also accepts comma-separated existing IDs. A normal gate has one destination. The helper chooses separated outer gate positions, creates both endpoints, and fills reciprocal arrival references. Creating an already-existing ID fails; it never regenerates that system.

Connect two existing systems without rebuilding either:

```bash
npm run system:connect -- --from nova --to kepler
```

An already-paired connection is a no-op. Inconsistent one-way pairs require explicit repair rather than overwriting authored gates.

Generate a larger seeded tree with one command:

```bash
npm run universe:generate -- --names '["Aureole","Cairn","Pelagos"]' --seed 42 --prefix frontier-sector --anchor vesper --region lantern-marches --preset frontier --dry-run
```

Remove `--dry-run` to write it. IDs are `frontier-sector-001` through `frontier-sector-003`; their names come from the supplied list. `--names` accepts a JSON string array or a comma-separated list and supplies the count automatically. If `--count` is also provided, it must match exactly. Names must be nonempty, unique within the batch, and at most 60 characters. Extend the full name list with the same prefix/seed to add systems; existing files and names stay intact. Legacy `--count` without `--names` still produces numbered names. The first node connects to the anchor and subsequent nodes form a branching tree. For exact topology, use a blueprint instead of batch options:

```bash
npm run universe:generate -- --blueprint content/expansions/vesper.json
```

This command is safe to rerun: Vesper's hand edits are preserved. Output reports created/retained IDs, added connections and changed paths, rather than dumping every generated definition. `--root <content-directory>` supports isolated authoring/test copies.

## Blueprint shape

```json
{
  "schemaVersion": 1,
  "systems": [
    {"id":"nova","name":"Nova","seed":83,"preset":"frontier","chart":{"x":2,"y":1}}
  ],
  "connections": [{"from":"ashen","to":"nova"}]
}
```

All new systems are created before links and traffic, so a blueprint may connect several newly created nodes. Existing system IDs are retained during blueprint replay. Connections only patch the relevant gate arrays. New markets and manifest entries are added without rewriting unrelated content. The complete expansion is validated before any writes; individual files are replaced and write errors trigger rollback attempts.

Keep IDs stable when renaming objects. Removing referenced systems/stations/gates or moving a gate used by a saved flight can require save migration; cosmetic names and descriptions can be edited directly. Files are authoritative after generation: changing a preset or seed does not retroactively rebuild existing systems.

## Deterministic generation

Each generated system records `generatorVersion`, seed and preset ID. Purpose/object-keyed RNG streams independently choose primary, station count, individual stations and market goods. Increasing traffic does not rearrange the system. Layout checks keep stations separated and gates outside the central layout. Adding links leaves existing gate positions intact.

The current Frontier preset references the existing Frontier culture/theme, generates a planet, one station with market/repair services and a freight ship. Generated commercial jobs choose a reachable partner, preferring a more distant port to exercise multi-hop travel. Presets can select registered cultures, sizes, services and a different traffic mix. Authoring-specific traffic factories are registered separately from runtime job policies; built-ins cover assigned freight, roaming `long-haul`, passenger, multi-system liner tours and patrol. The `long-haul` preset uses the Frontier layout with a roaming hauler; region and explicit culture overrides still apply. For example: `npm run system:create -- --id outer-harbour --name "Outer Harbour" --seed 932 --preset long-haul --connect vesper --x 8 --y 3`. Liner traffic templates produce roaming tours by default; hand-authored `routing: "circuit"` configs can instead provide explicit cross-system `stops`. Runtime roaming jobs discover future reachable systems automatically; generation only supplies home ports and preferences. A new job family may need its own config-generation factory, while runtime traffic execution stays unchanged.

The six systems beyond Vesper are **Lacuna, Halcyon, Nacre, Ilex, Meridian, and Brume**. Their stable internal IDs remain `drift-001` through `drift-006`, preserving saves, markets and gate endpoints. This command replays their creation without overwriting existing edits:

```bash
npm run universe:generate -- --names '["Lacuna","Halcyon","Nacre","Ilex","Meridian","Brume"]' --seed 4106 --prefix drift --anchor vesper --region lantern-marches --preset frontier
```

The equivalent explicit topology is in `content/expansions/lantern-marches.json`. The `frontier` preset supplies layout/services/traffic configuration; the region supplies Aster culture. Each system has a planet, a market/repair station and a freighter.

## Kepler Frontier expansion

Four additional systems inherit Kepler Drift's `ashen-frontier` region and Frontier culture: **Cinder, Sable, Redoubt and Farpoint**. Reach Cinder directly from Kepler Drift, Sable and Redoubt from Cinder, and Farpoint from Sable. Each has a planet, a market/repair station and a Frontier freighter. Existing saves discover their gateways and reconcile the new actors once without resetting existing journeys.

Replay the batch safely with:

```bash
npm run universe:generate -- --names '["Cinder","Sable","Redoubt","Farpoint"]' --seed 6107 --prefix kepler-frontier --anchor kepler --region ashen-frontier --preset frontier
```

The equivalent explicit definition is [content/expansions/kepler-frontier.json](content/expansions/kepler-frontier.json). Roaming freighters and liners can select these destinations on subsequent stops; committed journeys retain their targets.

## Regions and cultural defaults

`content/universe.json.regions` defines stable region IDs, display names and default `cultureId`. Systems optionally reference `regionId`; older regionless definitions remain valid. **Ashen Frontier** contains Ashen and Kepler and defaults to Frontier culture. **Lantern Marches** contains Vesper and its six outer systems and defaults to the Aster Compact.

Batch generation uses `--region` when supplied, otherwise the anchor’s region. Single-system creation uses `--region` or inherits the shared region of its connected neighbours. Blueprints may supply `regionId` per system and an optional `cultureId` override for enclaves/border systems. Culture precedence is explicit system override → region default → preset default. Region culture is resolved when a system is created, independently of theme, faction and job. Changing a region does not automatically reassign existing crew identities or designs.

Content revision 3 corrects only the six stock freighters from the original wrongly cultured generation, preserving job/motion/damage/cargo progress. Captured or destroyed ships, custom designs and unrelated visiting crews retain their identities. The NPC ledger and save schema remain unchanged.

The current authoring budget is 256 persistent NPC spawns; the validator rejects larger populations. Systems without traffic can still be authored. Population streaming and large-universe map navigation are separate future extensions; the current playable slice has thirteen systems and twenty persistent NPCs.

## Routing and save continuity

`RouteResolver` uses deterministic breadth-first search: fewest jumps, stable connection-ID tie breaking. Maps, guidance, following, player jump checks and NPC navigation use this graph. A flight toward an exit stores the chosen gate/connection; it does not repeatedly select whichever gate appears first in an array.

A job retains its final destination across intermediate jumps. Arriving at an intermediate system schedules its next physical exit leg and emits a transfer announcement. Arrival at the final port completes the travel primitive and allows the policy's unloading stage. Active/inactive simulation shares these states; identity, damage, manifest and culture remain on the same actor.

Schema 6 saves the chosen exit and plotted player destination. Versions 1–5 migrate; schema-5 exit flights are matched to their existing destination gate while preserving position/progress. New authored NPC identities are added once without replacing captured or destroyed records. Browser persistence/export/import remain unchanged.

The shared route policy can deny graph connections. Player commands enforce it and NPCs wait/retry their current task instead of treating an unreachable destination as a completed delivery. All live links are currently open. Permit/reputation rules, traveller-specific access contexts, persistent closure state and local restricted/impassable regions remain future work. Physical no-fly areas will also need movement/pathfinding enforcement.

`src/universe.test.ts` verifies generated file parity, paired gates, physical eligibility, complete player travel/trade, NPC multi-hop continuity, following/reload, access retry, legacy migration, deterministic layout, replay/hand-edit preservation, bulk extension and invalid-input write protection.

Market preset goods may specify `availability`, `bidPrice`, `buys` and `sells` in addition to price/stock ranges. Per-good seeded availability creates varied station assortments without moving layout objects. Luxury liner templates start with bounded Luxury-category inventory. See [MARKETS.md](MARKETS.md).

## Environment profiles and size overrides

Use `npm run universe:environments` to list the six current appearance profiles and the small/medium/large radius bands. `system:create` accepts `--environment <id>` and either `--size <small|medium|large>` or `--radius <1200..40000>`. Batch generation additionally accepts `--environments <id,id,...>` for seeded variety. These options do not change region/culture inheritance. Blueprint mode expresses the same choices per system as `environmentId`, `size` or `radius`; do not combine blueprint mode with batch flags.

Layout presets may declare an `environmentIds` pool. Explicit choices override that pool. Otherwise selection uses a dedicated visual seed stream, leaving layout, prices, traffic and ship designs unchanged. Runtime content retains only the selected `environmentId` and numeric `radius`. Existing hand-edited systems remain preserved on replay. Dry-run output includes each created system's resolved profile and radius. See [ENVIRONMENTS.md](ENVIRONMENTS.md) for examples and rendering ownership.

Generator version 2 uses the expanded physical layout. Size bands are now small 6000–9000 m, medium 10000–16000 m and large 20000–30000 m. Numeric overrides remain literal metres. Station clearances and generated berths follow the enlarged station palette. See [SCALE.md](SCALE.md) for coordinate/save compatibility.
