# Purposeful traffic and ship radio — implementation notes

The first slice from the architecture discussion is implemented. See [ARCHITECTURE.md](ARCHITECTURE.md) for the boundaries.

## Implemented

- Assigned freight, seeded roaming long-haul deliveries, scheduled passenger service, multi-system leisure tours and police patrols run through typed registered job policies and shared travel/wait execution. Destination decisions/history persist; tours return home and deliveries retain their targets through intermediate jumps.
- Stable identity, NPC culture, hull design, manifest, damage, job phase and system membership live in one authoritative ledger. The captain has a separate culture.
- Culture-specific design pools and radio profiles are registered independently of jobs/factions/themes; visitors retain their identity across jumps/save/load. Frontier and Aster Compact assets include differentiated transport, freight, liner and patrol silhouettes; Aster traffic visits Frontier ports.
- Active ships fly physical waypoint routes; unobserved legs advance by a game-clock schedule. Handoffs preserve observed positions.
- Combat interrupts a job. Engine loss, capture and destruction have explicit outcomes.
- Follow tracks the same ship across player-commanded system jumps.
- Player cruise provides 4× travel after spool-up, automatic approach slowdown, combat/fire lockout, continued PDC defense and compact touch/keyboard controls. It uses the shared simulation input without accelerating world time.
- Radio is exclusively **text bubbles over speaking ships**, driven by actual events. Relevance, deduplication, priority, expiry and simultaneous-message limits protect readability.
- In-memory domain records and asynchronous IndexedDB snapshot persistence are separate. Older saves migrate; originals and export/import remain available.

## Deliberate limits / later work

- The current thirteen-system population has twenty NPCs across freight, public transport, leisure and police jobs. Development-time population generation is implemented; runtime population streaming and escorts remain future work.
- Travel supports local destinations and multi-hop system routes through a shared resolver. Seeded destination planning is implemented; weighted path costs and demand-driven contracts remain future work.
- Police respond to explicit nearby attack orders, pursue within their response range, and resume patrol. General witnessed-crime detection, jurisdiction/reputation, fines, searches, arrests and surrender mechanics remain future work.
- Passenger counts belong to NPC job state. Player passenger contracts, fares and passenger management are not implemented.
- Loading/unloading uses a timed berth position. Congestion, reserved docking slots, queues and station capacity are not simulated yet.
- Manifests are real cargo but background deliveries do not consume the player's finite market stocks or move prices. Economic integration should be an explicit balance decision.
- Unobserved travel is approximate linear movement. No background combat or wall-clock/offline progression.
- More NPC behaviors should preserve coherent identity and observable purpose; measure before expanding population/fidelity.
- Browser-only saves can be cleared/evicted or separated by browser/origin. Export/import is the backup path. No cloud account/backend or browser SQLite is required for this prototype.

## System authoring / generator — implemented

- Nine-system region-based network, with distinct exits and shared multi-hop route resolution.
- Editable JSON definitions and a shared browser/tool validation boundary.
- Blueprint, individual-create, paired-connect and seeded batch-generation commands; presets reference registered cultures, services and job families.
- Independent seed streams, provenance, preserved IDs, idempotent replay, dry-run output, hand-edit preservation and generated imports.
- Shared multi-hop route resolution for map, guidance, following and NPC travel. Final manifests survive intermediate transfers.
- Vesper was generated, then its primary/station descriptions and names were customized. Replaying the blueprint preserves those peculiarities.
- Schema 6 preserves route targets/committed exits and migrates versions 1–5. See [SYSTEM_AUTHORING.md](SYSTEM_AUTHORING.md).

## Later extensions

- Traveller-specific permits, reputation and persistent gate-closure state. A shared global access-policy hook already blocks jumps and makes NPCs wait/retry, but all current connections are open.
- Restricted/hazard/impassable regions, including physical movement/pathfinding enforcement.
- Larger-universe map pan/zoom and population streaming beyond the current authored traffic budget.
- More culture assets, naming conventions, station styles, station radio replies and detailed crew identities.

- Automatic NPC cruise policy and matching background travel estimates can be added together later; the current cruise slice changes player travel only.

## Worker architecture — explicitly deferred

The spatial ECS now runs on the main thread. A later experiment can isolate the fixed-step simulation in one dedicated Web Worker while keeping DOM and Three.js rendering on the main thread. Use command messages into the simulation and versioned plain-data snapshots/events out; interpolate render poses between ticks. Keep one authoritative owner for mutable state rather than sharing the current accessor-backed Ship records across threads.

Start with ordinary structured-clone messages and measure their cost at the actual population. Transferable typed-array snapshots are a later option. SharedArrayBuffer is not a prerequisite and requires cross-origin isolation headers supported by the preview host. Workers do not reduce GPU draw calls or automatically make small simulations faster. Persistence handoff, traffic transitions, pause behavior and save consistency need explicit ownership before moving the boundary.

Full 3D flight is also deferred. The current perspective chase camera leaves XY navigation/combat intact; spatial orientation, targeting and touch input need their own design slice.

## Hyperspace loading boundary — implemented

Player/NPC transit share a four-second duration. Destination preparation yields across frames, warms shaders, supports retry/abort, and preserves departure saves and NPC continuity. Content is still served from the bundled catalog; a compact navigation index plus streamed definitions/assets is the next scaling step. See [TRAVEL.md](TRAVEL.md).

## System environment profiles — implemented

Six data-defined environments vary seeded backgrounds, stars, lighting, dust and bounded decorative rocks. System size, infrastructure palette and culture remain separate. The creator supports fixed profiles, seeded pools and physical size overrides. Expanding toward 25–30 looks is content work within the current recipes; streamed artwork and additional recipes remain later extensions. See [ENVIRONMENTS.md](ENVIRONMENTS.md).
