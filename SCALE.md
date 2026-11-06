# Larger local systems and stations

The original nine systems now use five times their previous local distances. Station models and their docking envelopes use three times their previous scale. Hull dimensions, normal/cruise speeds, weapons, boarding distances and hyperspace duration are unchanged.

## What changed

- Canonical system radii, station/gateway positions, landmark positions/radii, NPC spawn positions, tour/patrol waypoint coordinates and authored patrol response ranges are 5× their previous values.
- Station size records now use model scales 3, 4.05 and 5.1, with docking radii 495, 570 and 660 metres. Ship geometry retains its previous physical dimensions.
- Gate apertures and jump-eligibility radii retain their physical size. Their approach locations are farther apart, while their close-range interaction matches their existing structure.
- Primary-body depth follows radius so enlarged planets stay beneath the XY flight plane. Universe-chart coordinates are abstract graph positions and remain unchanged.
- Economy, crew, identities, culture, visual profiles, damage, timed station jobs and four-second hyperspace travel are unchanged. Longer local routes take longer at the same speeds; cruise remains the existing 4× travel capability.

The authored JSON contains actual physical coordinates in metres. There is no global render-only coordinate multiplier or a second hidden simulation scale.

## Safe station approaches

`game/station-approach.ts` derives an exterior stop from the station model footprint plus hull clearance. Player autopilot and NPC/generated berths use it, keeping vessels outside large station hardware and inside docking range. Berths turn inward near sector boundaries. Player station picking uses projected world radius, accounting for perspective depth rather than a fixed small touch target. No new collision mesh or station-impact simulation is introduced.

`FlightCamera.setSystemRadius` extends its far plane for larger authored systems without increasing camera distance from the ship or changing zoom. Minimap and chart transforms already use the system radius. Environment counts remain capped rather than growing with system area.

## Creator and generator

Generator version 2 uses the enlarged defaults. Small/medium/large size bands now resolve to 6000–9000, 10000–16000 and 20000–30000 metres. Numeric radius overrides remain independent and support 1200–40000 metres. Placement clearances adapt for deliberately compact numeric overrides. Default layout/primary-body ranges and tour/patrol distances use the larger units; generated station berths use the current station-size palette.

Existing files are still preserved on replay. Previously generated systems retain their original provenance metadata: this scale change is an explicit authored content edit, not a silent regeneration of their layouts or topology.

## Saved voyages

Save schema 6 now includes `spatialVersion`, independently of market/art content revisions. The current content declares coordinate revision 1; legacy content with no declaration remains revision 0.

When loading a revision-0 save against revision-1 content, `game/spatial-migration.ts` converts known local position contracts (`position`, and flight-leg `from`/`to`) and patrol response ranges exactly once, before normal reference/waypoint validation. It includes controlled hulls, ledger actors, unmanaged system snapshots, suspended motion and explicit job destinations. It leaves velocities, timers, cargo, ownership, health and identity unchanged. A saved hull remains the same hull.

Decoded flight legs are then rebased from the migrated actor position to current destinations at unchanged ship speeds. Station destinations resolve to the new exterior berth. Charging, waiting and transit deadlines retain their existing meaning. Reloading a newly saved revision-1 voyage does not multiply coordinates again. Unsupported future or reverse revisions are rejected explicitly.

A pending player jump still saves its departure checkpoint. Coordinate migration happens before its restored departure can resume normal play. The existing ordered browser save queue and export/import remain unchanged.

## Verification limits

Tests cover exact layout factors, unchanged hull handling, exterior docking, legacy save formats, idempotent conversion, waypoint/gateway validity, NPC continuity, generated size overrides, resource/model scale and camera range. Phone playtesting is still needed to assess perceived travel time, station framing and the desired sense of scale.
