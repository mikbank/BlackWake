# Spatial ECS and the 3D presentation prototype

The active local world now runs through an entity/component/system store on the main thread. The voyage, traffic ledger, content catalog and station services retain their existing domain boundaries. ECS is useful for composing spatial capabilities; it does not replace every application record.

## Ownership and the record bridge

`World.entities` is an `EntityStore<SpatialComponents>`. An entity is a stable string identity. A component is mutable data in a map keyed by that identity. A system selects capabilities and runs an algorithm over their records. TypeScript's component-key generic checks the shape at compile time; it does not allocate a runtime class or validate imported JSON.

Transforms, motion, hull health, ownership, propulsion, broadside reload, PDC state, cruise state, control, cargo, crew and appearance are separate components. Debris can have transform/motion without cargo or a hull. A stationary weapon platform can have weapons without crew or propulsion. Removing a capability removes its behavior. Existing gameplay still creates normal ships; the component-only examples are regression fixtures, not new station-combat features.

The traffic ledger must retain the *same* ship object that jobs, boarding and persistence already reference. `ship-adapter.ts` therefore turns the materialized record's fields into enumerable accessors over its components. There is one live value, not a record copy synchronized every frame. Replacing a component is visible through the record immediately. On removal/unload, the adapter restores ordinary data properties before destroying components. Background NPCs then remain plain domain records.

This bridge is intentionally pragmatic. It preserves existing APIs and save schema 6, at the cost of property-access indirection and a less obvious runtime object shape. Spatial systems query capabilities; domain consumers can continue reading a ship DTO. New code must use `addShip`, `removeShip` or `replaceShips` for membership: `world.ships` returns a derived list, so pushing into it cannot create an entity.

## Tick order and structural changes

`World.step` supplies explicit frame resources to this schedule:

1. `capture`: start positions/health for swept collision and damage detection.
2. `reload`: weapon timers, independent of propulsion.
3. `flight`: steering, cruise, NPC fire and movement for capability-selected bodies.
4. `entity-gunnery`: explicit weapon orders for component-only platforms.
5. `player-gunnery`: the controlled ship's selected hostile target.
6. `point-defence`: physical interception bursts from equipped defenders.
7. `projectiles`: swept broadside/PDC collision and damage.
8. `damage`: drive disruption after actual damage.

The flight phase keeps the previous per-ship AI → cruise → fire → movement ordering. Splitting these into population-wide phases would change what later ships observe during the same tick. That is a gameplay change, so this migration preserves the order rather than silently claiming equivalent behavior. A one-off comparison against the previous loop matched 3,600 frames, including combat and cruise.

Systems may mutate component values immediately. Adding/removing/replacing components or entities during a tick is forbidden; defer those operations through `frame.commands.defer(...)`. The FIFO queue applies after the schedule unlocks. This prevents queries from observing a half-constructed entity. Failed phases discard pending commands; component-value changes are not transactional or rolled back.

Extensions register a uniquely named phase with `world.schedule.add(system, 'known-phase')`. Ordering and shared frame resources are explicit; this is not an automatic dependency scheduler or parallel executor.

Broadside shells and PDC rounds remain transient subsystem-owned arrays. Relations, the clock and event buffers are shared resources. Turning every short-lived projectile into a map entity would add complexity without a demonstrated benefit for this population. NPC purposes/cultures, radio selection, markets and browser storage are still domain systems outside the spatial tick.

## Performance and workers

This implementation favors inspectable maps and ordinary objects. Queries allocate membership snapshots and row objects. The adapter adds getter/setter calls. ECS does **not** imply faster JavaScript, cache-friendly storage, or fewer draw calls. Profile the browser before replacing these maps with dense arrays, cached queries or typed-array pools. The regression suite establishes behavior and composition, not a mobile frame-rate guarantee.

No workers are used. A later worker iteration should move one authoritative simulation boundary behind serializable commands and render snapshots; see [FUTURE_WORK.md](FUTURE_WORK.md). The current accessor records, closures and Three.js objects are not a worker message format.

## 3D test scope

`FlightCamera` owns a perspective chase rig with Z-up, damped heading, speed-dependent distance and bounded target bias. The existing ship models are volumetric; stations/gates now use solid structures, planets use deterministic local textures and atmosphere shells, and the backdrop surrounds the camera. No remote artwork or new rendering dependency is required.

Flight, collisions, docking, weapons and navigation remain on XY at Z=0. Perspective rays intersect that plane; a sky tap returns no destination. Labels, contact picking and radio use the active projection, including a behind-camera visibility check. Menu → Camera or V switches to the retained north-up tactical view. The rig snaps on system changes so unrelated system coordinates are not interpolated.

This is a camera/presentation experiment, not six-degree-of-freedom flight. Full spatial gameplay would need orientation/steering, collisions, targeting, approach volumes and input design changes beyond this renderer. Pixel ratio is capped at 1.75, with no dynamic shadows or postprocessing added. Camera/projection and resource-lifetime tests run without WebGL; actual image quality, phone touch ergonomics and GPU performance still require playing the preview.

System transitions now reserve departure during asynchronous destination preparation. Arrival releases the old spatial world, advances background jobs through the shared four-second transit interval, and materializes the current destination population. See [TRAVEL.md](TRAVEL.md).
