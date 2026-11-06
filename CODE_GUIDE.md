# Reading the Blackwake code

This is a TypeScript browser game with a plain-data simulation, a session/application layer, and a separate Three.js presentation. Treat the content catalog as validated configuration and the session as the application boundary. The project uses familiar services, registries and adapters without requiring a game engine or backend server.

## A useful reading order

1. [Game starts](src/game/start.ts) construct a free-roam session or an optional test scenario. [The session](src/game/session.ts) validates commands and coordinates the captain, local world, traffic and services.
2. [The active world](src/simulation.ts) runs capability-selected ECS phases at a fixed time step. Read [ECS.md](ECS.md), then [storage/scheduling](src/core/ecs/store.ts), [components](src/core/ecs/components.ts), [systems](src/core/ecs/systems.ts) and the [record bridge](src/core/ecs/ship-adapter.ts). [Core records](src/core/model.ts) describe hulls, inputs and projectiles; the core has no DOM, graphics or storage dependency.
3. [Traffic](src/game/traffic.ts) owns persistent NPC records. [Job policies](src/game/traffic/model.ts) choose what an NPC does; [navigation](src/game/traffic/navigation.ts) executes its travel/wait tasks. [The registry](src/game/traffic/registry.ts) connects policies without a job-kind switch in the controller.
4. [Save decoding](src/game/persistence.ts) validates and migrates serialized sessions. [Browser storage](src/game/save-store.ts) supplies interchangeable persistence adapters and an ordered commit queue.
5. [Browser composition](src/main.ts) binds controls and runs the frame loop. [The camera rig](src/flight-camera.ts) selects perspective chase or tactical projection; [the view](src/view.ts) renders current state; [ship models](src/ship-model.ts) supply disposable graphics rather than gameplay rules.
6. [The content loader](src/content/data.ts), [generator](src/content/generation/generate.ts) and [CLI](tools/universe.ts) turn authored JSON into validated systems. [System authoring](SYSTEM_AUTHORING.md) documents the commands.

## TypeScript conventions that matter here

- **Types describe shapes, not runtime objects.** `type`, `interface`, generics and `import type` disappear during compilation. A plain object can implement a service/policy contract structurally; it does not need to inherit a particular class. JSON still needs the explicit validators in the loader and save decoder.
- **`Record<string, T>` is an in-memory string-keyed object**, used for cargo, content registries and saved state. It is not a database record. `Map<K, V>` is a distinct runtime collection, used where keyed mutable lookup is useful; it does not serialize to useful JSON automatically.
- **A `kind` union is a state model.** For example, a motion record is flight, waiting, transit, disabled or retired. Checking `kind` tells the compiler which fields exist in that branch. This replaces a polymorphic object hierarchy with explicitly serializable alternatives.
- **`unknown` requires decoding before use.** `as T` and the postfix `!` only tell the compiler what the programmer believes; neither converts nor validates a value. Some older save boundaries still use `any` behind explicit checks. Registry type assertions stay inside closures that already validated the policy's config and state.
- **Constructor parameter properties declare fields.** `constructor(readonly catalog: ContentCatalog)` both accepts the argument and stores `this.catalog`. Like a C# readonly reference field, it does not make the referenced catalog deeply immutable.
- **Array callbacks resemble LINQ selectors and predicates.** `map`, `filter`, `find`, `some`, `every` and `flatMap` correspond roughly to Select, Where, FirstOrDefault, Any, All and SelectMany. Here their comments identify the domain purpose. A callback is often deferred: an event handler runs after a browser event, not when it is assigned.
- **Arrow functions retain their surrounding `this`.** This matters when passing a class operation into an event, registry or traversal callback. The registered job adapters also retain each policy's concrete generic types through a closure.
- **`Promise`/`async`/`await` express completion, not a worker thread.** Storage uses promises and browser transaction events. The simulation is synchronous and runs on the browser thread. IndexedDB writes resolve on transaction commit; the coordinator orders autosave, imports and scenario switches.

## State, time and resource ownership

`TrafficDirector.actors` owns managed NPC records. When an NPC is local, `World.ships` contains the same live hull object. Physics therefore updates the ledger's hull rather than a detached copy. System snapshots exclude those managed IDs, and the controlled player hull travels separately. This prevents a ship from being saved or respawned twice.

`structuredClone` creates independent plain-data copies at content, snapshot and restoration boundaries. Ordinary assignment does not. A successful command changes domain state; the browser then saves it and displays its returned message. The renderer reads that state and may change its own graphics caches, but does not apply trading or combat rules.

Simulation durations and `dt` are seconds; headings are radians. The flight plane is XY, while Z gives models depth and preserves a path toward spatial expansion. The animation loop advances physics in fixed 1/60-second steps and renders separately. Docking and menus pause simulation time. Storage timestamps use wall-clock time and do not drive traffic schedules.

Saves contain plain persistent records. Renderers, DOM nodes, closures, live projectiles, radio bubbles and cruise activation are transient and rebuilt. IndexedDB is preferred, with localStorage and session-memory fallbacks; the selected adapter reports what durability it actually offers.

Three.js geometries and materials allocate graphics resources beyond ordinary JavaScript object lifetime. Model and scene disposal methods release them explicitly. Flight and inspection use the same registered model factory and attachment contract, so a visual design does not imply different cargo capacity, handling or weapons.

## Reading and maintaining the annotations

Function, method and class comments state purpose, side effects and important constraints. Small callbacks have short comments; policy and persistence contracts explain the boundaries that their implementations must honor. Existing algorithm and extension-point explanations are retained or consolidated into the new purpose comments.

Update a comment with the behavior it documents. Explain a non-obvious unit, state transition, validation rule or ownership assumption where it matters; avoid turning comments into a second line-by-line implementation. Generated [system imports](src/content/system-index.ts) remain generator-owned and contain no functions to annotate.

The broader design and its current limits are in [ARCHITECTURE.md](ARCHITECTURE.md), with focused references for [NPC jobs](TRAFFIC_JOBS.md), [cultures](CULTURES.md) and [system generation](SYSTEM_AUTHORING.md).

The market view is in [src/ui/market.ts](src/ui/market.ts); price, assortment, capacity and transaction rules remain in [services.ts](src/game/services.ts). [MARKETS.md](MARKETS.md) describes the data contracts and current economic limits.

Live spatial ship records use enumerable accessors into ECS components; background records and saved snapshots are plain data. They preserve object identity across traffic/session integration. World membership is explicit (`addShip`/`removeShip`/`replaceShips`), and structural changes inside a tick use deferred commands. Camera state is presentation-only: 3D graphics still navigate the XY plane.

For system travel, read [TRAVEL.md](TRAVEL.md), then [the transition coordinator](src/game/jump-transition.ts) and [the content provider](src/content/system-provider.ts). A jump command reserves departure; explicit arrival waits for both the journey duration and prepared graphics. The session keeps save compatibility by returning its departure checkpoint during transit.

Gateway hardware and energy effects live in [gateway-model.ts](src/ui/gateway-model.ts). The pure [travel motion profile](src/ui/hyperspace-motion.ts) selects the phases rendered by [the canvas effect](src/ui/hyperspace-effect.ts); presentation progress can hold inside the tunnel while the asynchronous provider finishes.

For system appearance, read [ENVIRONMENTS.md](ENVIRONMENTS.md), the [profile validator/resolver](src/content/environments.ts), and [environment resource builder](src/ui/environment-model.ts). Appearance selection uses its own seed stream. The creator resolves size presets to a numeric radius while keeping culture, physical layout and appearance separate.

For physical scale, see [SCALE.md](SCALE.md), [coordinate migration](src/game/spatial-migration.ts), and [exterior station approaches](src/game/station-approach.ts). Authored positions are real world coordinates; station rendering, NPC berths and docking eligibility share the same station-size records. The saved coordinate revision prevents repeated conversion.

For NPC destination planning, start with [the selector](src/game/traffic/destinations.ts), then [long-haul freight](src/game/traffic/jobs/long-haul.ts) and [liner tours](src/game/traffic/jobs/liner.ts). The selector returns a proposed goal plus updated decision memory; the policy commits it as state, and shared navigation executes it without rerolling at gateways. [Stock journey upgrades](src/game/traffic/journey-upgrades.ts) adapt old saves without resetting moving hulls. [TRAFFIC_JOBS.md](TRAFFIC_JOBS.md) describes the behavioral contract and current economic limits.

Normal new-game traffic has five minutes of prehistory, implemented at the [start boundary](src/game/start.ts) through bounded background updates. The shared clock advances with the traffic; active-system membership is rebuilt afterwards. Save restoration bypasses that startup path, and isolated scenarios/tests can disable the warm-up.
