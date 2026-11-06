# Hyperspace travel and asynchronous destination preparation

A player jump is now a reserved journey, not an immediate world replacement. Both player and NPC transit use `jumpTravelSeconds` (four simulated seconds). The existing in-memory catalog remains the content source; this slice establishes the asynchronous boundary without downloading system JSON or adding workers.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `game/session.ts` | Validate departure, retain its checkpoint, reserve transit, and commit or cancel arrival. |
| `game/jump-travel.ts` | Shared journey duration and the pending player transit record. |
| `content/system-provider.ts` | Asynchronous definition provider; current implementation reads the validated catalog. |
| `game/jump-transition.ts` | Coordinate content/graphics readiness with journey duration, retry, abort, and stale-result disposal. No DOM or Three.js dependency. |
| `ui/prepared-scene.ts`, `ui/system-model.ts` | Prepare destination objects and hulls in batches across animation frames, releasing incomplete resources on failure. |
| `view.ts` | Warm destination shaders, accept prepared resources, and dispose departure graphics. |
| `ui/hyperspace.ts` | Accessible three-phase star-stream/wormhole/arrival overlay with retry/cancel, focus containment, and reduced-motion support. |
| `game/traffic.ts` | Advance all actors through the journey interval using background scheduling before local materialization. |

`dispatch({type:'jump', connectionId})` begins transit after normal gate/access validation. It no longer changes `systemId` immediately. `advanceTransit(dt)` advances the transient journey progress, and `completeJump()` commits only after the duration is satisfied. The browser coordinator additionally requires destination preparation to succeed. Headless tests use an explicit helper to complete transit without a renderer.

## Timing and continuity

The displayed journey progress is separate from persistent game time. While destination work is pending, departure physics and the traffic ledger remain unchanged. When arrival is committed, the clock advances by exactly four seconds and the traffic director advances its actors through that same interval. Loading for one second or twenty seconds produces the same persistent arrival state. Slow preparation holds progress inside the full wormhole phase. The exit into normal stars plays only after destination readiness, so a loading hold never strands the player in a completed arrival animation. There is no wall-clock or offline progression.

Background catch-up uses bounded 1/60-second schedule steps for this short interval, covering flight, charging, transit, waiting and job completion. It runs no physics world and performs no background combat. This reuses the current navigation/policy semantics instead of assuming one large clock increment can resolve every intervening state. It is deliberately limited to intervals of at most 60 seconds; a future large-universe scheduler should use timed events and a work budget before supporting long offline catch-up.

NPC identities, cultures, hull designs, manifests, damage, PDC state and jobs remain ledger-owned. On departure, observed flight legs are rebased from actual positions; ECS adapters detach back to plain records. On arrival, only current destination inhabitants materialize. A followed NPC may already be present because its four-second journey elapsed during yours. Transit-time radio events are discarded, avoiding historical chatter replay at arrival. Fresh local events still use each speaker's own culture.

## Preparation and resource lifetime

The current provider introduces an asynchronous seam around existing catalog data. Heavy objects are generated between animation-frame yields. Models include the controlled hull, saved unmanaged destination hulls, residents and known incoming visitors; each uses its own design/livery. Shader programs are prepared before arrival. The renderer still reconciles the exact live population at arrival, including any changed membership.

The departure world and graphics remain available until preparation succeeds. At successful commit the old ECS world is released, background traffic catches up, the destination world is created, and prepared graphics transfer to `View`. Departure graphics are disposed. No multi-system graphics cache is retained; temporary peak memory includes the departure scene and one candidate destination.

Provider or graphics failures leave departure intact and expose retry/return actions. Cancellation signals propagate to providers and preparation yields. Generation checks discard stale results even if a provider ignores cancellation; late graphics are disposed instead of installed. Access and arrival anchors are checked again before releasing departure. The mechanism guards loading and validation failures; arbitrary exceptions in domain job code are still programming errors, not a transactional database rollback.

## Saving and focus

Schema 6 remains compatible. Saves/exports made during transit return the departure checkpoint captured before reserving the jump. Closing/reloading therefore restores the departure gate, without half a journey, duplicated NPCs or extra consumed time. Arrival writes the normal destination save. A hidden tab does not advance journey progress. Game controls become inert while the separate transit dialog owns interaction; Escape or Return to departure cancels the pending journey.

## Later streaming work

All current system definitions and model-provider code remain bundled at startup. The next provider can fetch detailed content/assets, honoring the supplied `AbortSignal`, while retaining this transition contract. Before unloading detailed system definitions, separate a compact universe/navigation index from visual content: graph routing and background jobs still need system links, gate coordinates, destinations and cultural identity definitions. Asset packages should follow actual hull designs, including foreign visitors and captured ships, rather than destination culture alone.

Large individual objects may still need finer construction batches. Shader warming does not guarantee that all GPU upload work is eliminated. Browser playtesting is required for animation quality, touch ergonomics and frame time; headless tests verify ownership, timing, persistence and failure behavior.

## Gateway visuals and travel choreography

`ui/gateway-model.ts` builds industrial, open-centred gateways with a radial approach axis, two structural hoops, six drive-coil assemblies, light guides and a translucent energy aperture. Static hardware is merged into five material batches. The faint approach envelope retains the existing gameplay radius; routes, IDs and eligibility remain unchanged. The aperture uses a small presentation-only shader uniform animated by `View`, and normal system disposal releases its geometry/materials.

`ui/hyperspace-motion.ts` defines smooth visual envelopes independently of NPC time. Departure expands perspective star trails toward the viewer, the middle phase blends into a curved tunnel, and arrival fades the tunnel out while shortening trails and slowing stars to points. The shared loading-hold fraction sits before the exit boundary. Retrying a failed arrival resumes from this hold instead of skipping deceleration.

`ui/hyperspace-effect.ts` renders a fixed 220-star pool and a bounded tunnel mesh on one 2D canvas, with pixel ratio capped at 1.5. It creates no additional WebGL context. Reduced motion retains a static field and phase fades without forward flight or tunnel rotation. Visual quality and frame time still require browser/phone playtesting.

Destination preparation now includes its seeded environment texture, star field, bounded decoration and lighting. Shader warm-up uses only the destination lights, and accepted arrival disposes departure environment resources. See [ENVIRONMENTS.md](ENVIRONMENTS.md).

The expanded layout increases local travel distances by 5× while preserving four-second hyperspace travel. Revision-0 saved coordinates upgrade before validation; NPC flight legs rebase at normal ship speed, and their charging/transit deadlines remain unchanged. See [SCALE.md](SCALE.md).
