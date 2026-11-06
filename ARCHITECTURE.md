# Blackwake: system travel and trading foundation

Typed NPC job policies, shared traffic execution and ship radio bubbles are implemented below. See [TRAFFIC_JOBS.md](TRAFFIC_JOBS.md) for the extension contract, [CULTURES.md](CULTURES.md) for cultural identity/design/radio configuration, and [FUTURE_WORK.md](FUTURE_WORK.md) for remaining scope.

The game is a persistent voyage through connected local systems. Trading, raiding and introductory guidance use the world; none is a prerequisite for basic flight, docking or jumping. The current content set has thirteen systems, Frontier and Aster cultures, and 21 commodities. The development-time generator produces editable files; shipyards, gravity, background economy and runtime generation remain outside this slice.

See [ECS.md](ECS.md) for component ownership, compatibility adapters, tick order, performance tradeoffs and the planar 3D camera experiment. Workers remain deferred.

Hyperspace uses an asynchronous preparation/commit boundary with four seconds of shared player/NPC transit. [TRAVEL.md](TRAVEL.md) explains timing, safe departure saves, resource ownership and future streaming.

System appearance now uses independent `environmentId` profiles, infrastructure `themeId`, numeric `radius` and culture references. [ENVIRONMENTS.md](ENVIRONMENTS.md) documents seeded variation, authoring flags and bounded rendering resources.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `src/core/model.ts` | Plain domain types, ship definitions, coordinate and collision helpers. No browser or content IDs. |
| `src/core/movement.ts` | Fixed-step movement, optional drive modifiers, turning and the supplied system boundary. |
| `src/core/cruise.ts` | Transient drive state, spool/turn/speed modifiers, combat/projectile exclusion and damage lockout. |
| `src/core/relations.ts` | Explicit per-vessel hostility, separate from ownership and faction. |
| `src/core/pilot.ts`, `ai.ts` | Shared waypoint steering and combat overrides; NPC plans enter through an optional order provider. |
| `src/core/combat.ts` | Broadsides, finite PDC bursts, swept collisions and damage. No raid stages or station logic. |
| `src/simulation.ts`, `src/core/ecs/` | Main-thread spatial ECS: component ownership, ordered capability systems and domain-record adapters. |
| `src/flight-camera.ts`, `src/view.ts` | Perspective chase/tactical projections and disposable graphics, independent of planar simulation. |
| `content/`, `src/content/data.ts`, `catalog.ts`, `universe.ts` | Editable JSON systems/shared definitions, validated loading and browser/CLI parity. |
| `src/content/routes.ts` | Shared deterministic graph routing and connection-access decisions. |
| `src/content/generation/`, `tools/universe.ts` | Seeded layout/preset/traffic factories, paired connection creation, safe file generation and import-index maintenance. |
| `src/content/identity.ts` | Default identity content, stable per-actor design choice and one-time identity resolution. |
| `src/ship-model.ts` | Registered model providers selected by explicit hull design; shared flight/inspection factory. |
| `src/game/session.ts` | Captain, controlled hull, current system, docking state, command validation and system transitions. |
| `src/game/interactions.ts` | Shared physical eligibility for docking, boarding and jumping. |
| `src/game/services.ts` | Station service registry, commodity transactions and repairs. |
| `src/game/activities.ts`, `start.ts` | Optional observers and content-specific starting scenarios. |
| `src/game/traffic.ts` | Stable NPC identities, lifecycle, interruptions, world membership and policy orchestration. No role switch. |
| `src/game/traffic/model.ts`, `navigation.ts` | Discriminated motion states and a shared travel/wait executor, including physical/background flight and jump handoffs. |
| `src/game/traffic/registry.ts`, `jobs/` | Typed policy registry and independent freight, passenger, leisure-liner and police-patrol policies. |
| `src/game/traffic/persistence.ts` | Generic motion validation, policy-owned config/state decoding and legacy traffic migration. |
| `src/game/radio.ts`, `radio-templates.ts` | Bounded, relevant text broadcasts and registered dialogue topics, independent of job execution. |
| `src/game/follow.ts` | Resolve the same actor or its next gate across system boundaries. |
| `src/game/persistence.ts` | Version-6 voyage validation and migrations from versions 1–5. |
| `src/game/save-store.ts` | Async save-store adapters, ordered atomic browser commits and legacy browser-key migration. |
| `src/ui/` | Guidance, service views, visual model providers and escaping. |
| `src/main.ts` | Browser bootstrap, controls, menus and rendering orchestration. |

Commands (`select`, `dock`, `undock`, `jump`, `service`, `attack`, `board`) return a success/failure result. The session validates rules and delegates to modules. Optional activities receive completed facts (`trade`, `docked`, `jumped`, `boarded`, `ship-destroyed`). They cannot grant docking eligibility or stop the world after success. The renderers read state; they do not perform transactions.

## Definitions and state

A `SystemDefinition` contains a stable ID, seed, theme reference, local radius, chart coordinates, landmarks, stations, jump gates and traffic spawns. A traffic spawn declares a ship plus a job kind/config and optional culture override. Each system supplies a default culture. Speaker culture, physical hull design, faction, livery, environment theme and job purpose are independent. The runtime imports authored/generated JSON through a generated static index and `catalogFromData`, registering each system through `ContentCatalog.addSystem`. Development tools read the same files and validation boundary. Register all connected systems, then call `catalog.validate()` and `services.validate(catalog)` before use. Validation rejects duplicate IDs and broken jump references.

A station's `size` resolves to a `StationSize` with visual scale and docking radius. Its `services` are independent declarations. A `modelId` can override the theme's station visual provider. No market or repair behavior lives in a station mesh or size class.

Example declaration using existing behavior:

```ts
{
  id: 'waystation',
  name: 'Waystation',
  position: { x: 300, y: -200, z: 0 },
  size: 'large',
  services: [
    { kind: 'market', config: { profileId: 'a-registered-market' } },
    { kind: 'repair', config: { pricePerPoint: 2 } }
  ]
}
```

Adding another station with known services is content work. A genuinely new service, such as a shipyard, needs its own domain handler in `ServiceRegistry` and presentation provider in `serviceViews`, plus its station declaration. This does not require edits to movement, combat, jumping or the session dispatcher. A validated `replaceControlledShip` capability supports a future docked hull exchange while preserving cargo and crew; no shipyard handler or screen is installed now. Unsupported service declarations are not displayed as functioning features.

Themes are presentation data. Station and landmark visual providers are registered by ID in `src/ui/system-model.ts`. A new appearance needs the corresponding provider if its geometry changes. A new physical effect, such as gravity, would be a separate simulation feature; declaring a black-hole visual does not silently enable gravity.

## Cruise travel

Cruise is a shared simulation capability requested by `Input.cruise`, independent of rendering, culture, NPC job and system definitions. Both hull classes define 4× cruise, 1.5-second spool, reduced turning, a 750 m hostile exclusion range and a three-second damage lockout. Closing hostile projectiles also block spool/boost. Charging/active drives suppress broadsides; PDC defense still runs. Damage disrupts the drive after collision resolution. Non-requesting ships retain the previous movement behavior and the game clock is unchanged.

Player `Navigation` owns the cruise request. It continues using the shared waypoint steering law and withdraws boost inside a conservative approach range derived from maximum cruise speed. Arrival, Stop, menus and new-world/reload behavior reset activation. The compact course row has a touch button, C shortcut, spool/lock/approach status and speed readout. Physical speed checks for docking, boarding and jumping remain authoritative.

The drive controller stores transient state on the active `World`, rather than adding culture/job/save dependencies to a ship. Existing schema-6 saves remain compatible. Saving preserves actual hull position/velocity; reloading starts with cruise off and the restored momentum decelerates normally. Current NPC policies do not request cruise, so background journey timing remains consistent with their existing speeds. An injected NPC order can use the same capability; automatic NPC adoption should also update unobserved leg timing.

## Culture, identity and hulls

Each system has a `cultureId` used to resolve new-spawn defaults. A managed NPC stores its own explicit `cultureId`; the captain stores theirs separately. These values never change merely because a ship jumps or its home system definition is edited. The physical ship stores `designId`, resolved once from the culture's compatible design pool unless explicitly authored. Stable choice uses system seed plus actor ID, independent of population order. A foreign-built hull can be used by a different culture/faction.

`CultureDefinition` references a radio profile and hull-design pools by gameplay class. `ShipDesignDefinition` references a model provider while retaining the existing cutter/merchant gameplay class and statistics. Livery remains an independent overlay. The renderer and inspection preview use the same factory; cached models are invalidated by design/class/livery changes, not by system culture or ownership. Providers retain the ring, engine flame and PDC attachment contract. Pure core `Ship` values may omit presentation identity, but session creation/entry resolves it and schema-5 saves require explicit design IDs.

Capture preserves the hull design and the player's captain culture. The retired NPC ledger record retains its historical culture; no detailed crew-identity simulation is introduced. A future exchange service may supply an explicit foreign design; absent that, the current system supplies the local design default while captain culture stays unchanged.

Radio formatting receives the actual speaker identity. Its culture selects a data-driven radio profile, whose topic templates may contain deterministic phrase variants and named placeholders. Missing topics or unavailable placeholder values fall back to shared formatters; unknown topics without a formatter remain silent. The current system is only used for channel/relevance filtering, never for choosing the speaker's voice. Traffic policies still emit only semantic facts.

Ashen and Kepler use Frontier defaults; Vesper uses the Aster Compact. Culture definitions may supply optional job-keyed `roleDesigns` pools for spawn-time presentation; unknown roles fall back to the gameplay-class pool, and explicit foreign hulls take precedence. Four Aster role designs and three Frontier role variants share the registered provider contract. Sixteen managed actors include visitors in both cultural directions. Naming conventions and cultural station-style defaults remain future content extensions. See [CULTURES.md](CULTURES.md).

## The first route

- Haven, Ashen Reach: rations 12 cr, machine parts 45 cr.
- Relay, Kepler Drift: rations 22 cr, machine parts 26 cr.
- The captain starts docked at Haven with 500 cr and 20 cargo units.
- Taking 10 rations outward and 10 machine parts back yields 790 cr before expenses.

The `trade-route` activity supplies optional guidance. It does not control the market, gate links, or station access. A separate raid start uses the same simulation and station services. Its success is an activity fact, not a global victory state that freezes the world.

## Travel and persistence

Only the active system advances at full physical fidelity. System snapshots own unmanaged local ships and salvage. The traffic ledger exclusively owns managed NPCs, their job config/state, manifests, damage, PDC state, vessel hostility and system membership; snapshots exclude those IDs. Materialization puts the ledger's live ship references into the active world exactly once. Captured or destroyed actors never rematerialize as NPCs. The captain's controlled ship travels separately. Markets persist by globally stable station IDs.

Traffic purpose is supplied by `JobPolicy<Config, State>`. A policy validates its content and saved state, creates its own initial state, and returns the next travel/wait task plus optional announcements. The registry closes over the policy's concrete types; the controller only stores serializable kind/config/state records. Adding a job family does not add branches to the controller or save decoder. See the test-only survey role in `src/traffic-extension.test.ts`. [TRAFFIC_JOBS.md](TRAFFIC_JOBS.md) explains the seeded destination policy and its persistence/performance boundaries.

The shared executor owns a discriminated union: waiting, flight, charging, transit, awaiting-route, interrupted, disabled, captured and destroyed. Flight requires a non-null leg and travel action; egress flight also requires the actual gate and connection IDs. Transit requires explicit arrival-system/gate information and has no local system membership. An interrupted/disabled state carries a local continuation and interruption timestamp; waiting/charging timers pause during interruption. Job records and motion have separate responsibilities.

The original merchants carry commodities between Haven and Relay; Vesper's generated freighter carries cargo to Relay through Ashen, preserving its final job and manifest at intermediate stops. A public connector boards/disembarks passengers between Haven and Relay. Leisure liners follow seeded multi-system tours and return to home ports; authored circuits remain supported. Three freighters run roaming long-haul jobs, selecting a new reachable market only after unloading; assigned-route freighters retain their ports. The shared destination selector uses the navigation access policy, saved decision counters and recent-system history, independently of culture and physical execution. Police patrol Kepler only, responding to explicit nearby attack orders through a policy hook; there are no fines, searches, arrests or general crime simulation yet. Their response can temporarily override their waypoint task. Registered combat posture lets civilian passenger/liner policies evade nearby hostiles while freighters and police retain broadside defense; the core AI has no NPC-family checks. Role-specific manifests and purposes appear in contact details and labels. Livery is independent of hull geometry and job type.

Active travel uses the same waypoint steering law as player navigation, with combat temporarily overriding the job. Separation allows interrupted tasks to resume; engine loss stops them, capture retires them, and destruction ends them. Unobserved legs use scheduled linear travel on the shared simulation clock. Leaving rebases from the last observed position. Menus, docking and a hidden browser pause gameplay; there is no offline progression. Cargo manifests remain separate from the player's market stock/prices. Passenger counts are NPC job state, not a player passenger-contract mechanic.

Radio consumes typed announcement envelopes (topic, values, urgency), never controls jobs. Dialogue formatters register by topic, with speaker-culture profile overrides, so the scheduler has no freight/patrol/passenger switch. Unknown dialogue topics are ignored. It filters by current system and proximity/selection, deduplicates, expires messages, limits simultaneous bubbles to two and prioritizes urgent calls. The UI anchors text over the actual ship and avoids HUD/minimap overlap. Radio presentation is ephemeral; event sequences are saved. Follow tracks any actor ID, resolves its next system while in transit and reacquires it after the player's manual jump.

Jump connections explicitly identify destination system and arrival gate. Ashen has distinct physical exits to Kepler and Vesper. `RouteResolver` uses BFS for fewest jumps and stable connection-ID tie breaking; map, guidance, following and NPC execution share it. Plotted player routes persist across manual jumps, while NPCs automatically execute each hop and unload only at their final port. A route policy hook enforces denied links in player commands and makes NPCs wait/retry; all authored links are open. Traveller-specific permits and local blocked-region physics remain future work. Jump execution checks the current system's connection, undocked state, zone radius and speed. Maps may plot a course from anywhere; they cannot bypass these checks.

Saves use schema version 6, including the plotted player destination and explicit NPC egress gate/connection IDs, plus explicit NPC/captain culture IDs, hull design IDs, enabled-traffic state, simulation clock, typed motion, policy kind/config/state and followed identity. Versions 1–5 are validated and migrated. Schema-5 flights infer their committed gate from the old leg/destination before saving the explicit exit. Missing old NPC culture is resolved once from an explicit authored spawn override or its saved home system; the legacy captain uses the catalog default. Existing identity/design values are retained and validated. Content revision 2 separately upgrades only the three known stock Frontier NPC role designs in old saves, preserving custom/foreign/player/retired hulls and all simulation progress. New Aster identities reconcile once without resetting saves. Unknown references in current saves fail validation rather than being silently replaced. Version-3 freight phases become generic tasks without discarding identity, position, damage, equipment or follow state. New authored identities are reconciled once by stable ID; captured/destroyed records prevent respawn. Unknown job kinds are rejected to preserve unreadable saves rather than silently losing behavior. Trading and raid remain separate slots; the raid start stays a two-ship encounter.

Active domain state stays in memory. `SaveStore` persists a captured JSON snapshot asynchronously in IndexedDB; each slot replacement is one atomic transaction. `SaveCoordinator` orders writes and waits before a scenario switch. The database is outside the fixed-step simulation. IndexedDB failure falls back to explicitly labelled local storage, then session memory if necessary. Failed commits show a persistent warning; they are never reported as saved. Unreadable current saves are preserved until an explicit restart/import. Old localStorage keys are retained after migration.

Persistence belongs to the preview site's browser origin/profile. It is not cloud backup or a guarantee against browser eviction, cleared site data, private browsing, or moving to a different preview origin. Export/import remains the recovery/transfer path; no backend or SQLite runtime is needed.

System generation is implemented as a development-time authoring workflow. Blueprints or a seeded batch command produce ordinary editable system files and paired gate endpoints. New definitions are fully validated before writing. Existing IDs, hand edits and unaffected files are retained; replay is idempotent. Individual files are replaced with rollback attempts on write failures. Shared definitions and the import index are updated only as needed. Independent RNG streams keep unrelated content stable. Existing saves reject unknown references rather than inventing replacement content. See [SYSTEM_AUTHORING.md](SYSTEM_AUTHORING.md).

## Verification

The automated suite exercises the full fly/jump/trade/return route, market accounting and invalid requests, neutral traffic, boarding and PDC behavior, state/save continuity, legacy migration, and a separate raid. Extension checks register an additional system, new station size, custom service and custom visual provider without changing the simulation. A test removes activity observers and still completes trade and travel. Traffic checks cover deliveries, public transport, sightseeing, police patrol/intervention, response limits/deduplication, frozen interrupted timers, physical waypoints, cross-system following, fidelity handoff, disable/capture/destruction, all old traffic phases and invalid policy/motion records. A new test-only survey policy runs, saves, loads and speaks through registered dialogue without changing traffic execution. Radio checks cover facts, relevance, deduplication, expiry and priority. Cultural-identity checks send a visitor into another culture, reload, capture/exchange foreign hulls, edit home defaults, backfill schema-4 saves, verify phrase fallback/variants and exercise registered-model cache invalidation. Universe checks exercise file parity, deterministic generation, paired gates, multi-hop player/NPC routes, following across transfers, closed-route retry, schema-5 migration, CLI dry runs, batch growth and hand-edit preservation. Cruise checks cover spool/max speed for both classes, faster complete trips, automatic braking, short courses, Stop, sharp reroutes, combat/projectile locks, damage cooldown, PDC defense, physical jump eligibility, unaffected world time/NPCs and reload behavior. A fake IndexedDB implementation exercises connection reopen/slot durability, with adapter failure/order and legacy migration checks.

Browser controls and the iPhone preview must still be verified in the actual preview environment; simulation tests do not establish visual or touch behavior.

## Free roam and boarding outcomes

The browser uses `startFreeRoam` for new games and restarts: neutral active traffic, a docked player, and no activity. `startTrading` remains a guided scenario/test fixture. Existing saved activities retain their progress; activities never gate combat, travel, boarding or services. Free roam retains the existing `trading` save-slot key for continuity.

`GameSession.canAttack` supplies the same eligibility used by the flight HUD and command validation; culture is not part of eligibility. Selecting neutral traffic exposes Attack directly. Selection itself never declares hostility. The flight action cancels cruise/navigation orders and enables automatic fire when Attack is chosen. The existing relation, broadside, PDC and job-response systems handle combat against either culture.

The board command accepts `outcome: 'cargo' | 'capture'`; omitted outcomes preserve legacy capture calls. `cargoTransferPlan` computes the exact capacity-aware offer shared by boarding presentation and execution, including commodity sizes. Cargo raids preserve the controlled hull and target identity/ownership/damage, transfer only fitting cargo and emit `cargo-raided`. Capture keeps target cargo, moves fitting player cargo, changes control and retires the managed NPC as captured. Boarding is a fresh act of aggression, even after an earlier fight; existing pursuers retain hostility toward the player after a hull capture. The optional raid observer accepts either cargo plunder or capture before return to port. No save-shape change is required.

## Region-aware authoring and navigation

A validated region registry supplies display names and default cultures. Systems reference optional stable region IDs. The authoring pipeline resolves explicit system culture → region culture → preset culture. Batch CLI supports JSON/comma name lists, inferred counts, validation before writes, explicit `--region` and anchor-region inheritance. The layout preset retains responsibility for environment, stations, services and traffic. Existing files retain hand edits on replay.

The flight jump menu reads `jumpDestinations(game, gateId)`, which returns only direct connections passing physical eligibility and access policy at the selected local gate. It executes a jump without selecting a remote itinerary. Universe planning groups destination choices by region, previews one selected multi-hop route and executes only `plot-route`, including while docked. The graph can preview a destination without mutating saved route state. Intermediate jumps remain explicit. Content revision 3 corrects the six originally misgenerated stock native freighters without changing their simulation progress; ordinary region edits never relabel saved crews.

## Expanded markets

The shared commodity registry now has 21 goods with optional category/description metadata and weighted hold sizes. Individual market profiles own assortments, optional station buy/sell permissions, ask prices and bid prices. `price` retains legacy ask semantics and serves as bid fallback; existing two-good routes remain compatible. New quotes use spreads. UI queries and command validation share marketPrice/marketGoods/marketLimit; a market view never invents a buyer for unsupported cargo.

The separate browser market view renders Buy from local sale offers and Sell from actual player cargo. Sold-out exports remain visible, and unsupported cargo remains aboard and visible in Sell. Category and quantity state are presentation-only. Stock seeding remains additive, preserving saved zeros and accumulated import inventory. The save schema stays 6, with content revision 4 provisioning the two original empty liners once. Normal save/load and tour phases never regenerate looted cargo. Content revision five upgrades the stock roaming jobs while preserving ongoing motion and cargo; it is independent of the spatial coordinate revision. Future generated liners carry catalog Luxury goods; freight respects origin sale permissions, destination bids, supply and capacity. See [MARKETS.md](MARKETS.md).

Coordinate revision 1 expands canonical local layouts by 5× and station sizes/envelopes by 3×. The explicit save `spatialVersion` is independent of art/market content revisions; legacy coordinates migrate once before decoding and flight legs rebase at unchanged speeds. [SCALE.md](SCALE.md) documents the boundaries.
