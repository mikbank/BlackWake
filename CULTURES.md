# Cultural identity, hull design and radio

A system supplies cultural defaults at creation. An NPC retains its own culture when travelling. A physical hull has a specific design, independently of who crews or owns it. Jobs, factions and environment themes remain separate.

## Data ownership

| Value | Owner | Meaning |
| --- | --- | --- |
| `cultureId` | System definition | Default culture for newly spawned inhabitants |
| `cultureId` | Traffic actor | Persistent speaker identity |
| `cultureId` | Captain | Persistent player identity across capture/exchange |
| `designId` | Physical ship | Explicit hull design, including foreign-built ships |
| `radioProfileId` | Culture definition | Topic phrasing for that culture |
| `shipDesigns` | Culture definition | Default designs for each gameplay class |
| `roleDesigns` | Culture definition | Optional design pools keyed by traffic job |
| `modelId` | Ship design | Registered visual provider |
| `factionId`, `job.kind`, `livery`, `themeId` | Their existing records | Allegiance, purpose, paint and environment, respectively |

Creation resolves `spawn.cultureId ?? system.cultureId`, then selects from the culture’s optional `roleDesigns[job.kind]` pool (falling back to `shipDesigns[ship.kind]`) unless the spawn already specifies `ship.designId`. Choice is stable from system seed + actor ID; it never consumes a shared population RNG. These IDs are saved explicitly. Jumping only changes location. Editing a home system affects future spawns, not existing saved identities.

## Live cultures and traffic

Ashen Reach and Kepler Drift supply **Frontier** defaults. Vesper and the six Lantern Marches systems are home to the **Aster Compact**, a community of deep-space habitat cooperatives. Aster crews speak in practical, considerate phrases with occasional dry humour; their hulls use pale ceramic shields, charcoal pressure cells and copper service hoops. Ship design remains independent of crew culture, job, faction and system theme.

| NPC role | Frontier design | Aster design | Live ships |
| --- | --- | --- | --- |
| Freight | Industrial hauler | Cradle: open six-pod cargo frame | 10 |
| Public transport | Connector: rectangular cabin bus | Thread: articulated pressure cells | 2 |
| Leisure liner | Aurora: broad accommodation raft | Commonlight: twin habitats and observation ring | 2 |
| Police patrol | Marshal: compact armored cutter | Warden: diamond cell and separated twin drives | 2 |

The player retains the original industrial cutter. All designs retain existing cutter/merchant gameplay statistics. Managed NPCs use registered job policies independently of culture; adding this culture introduced no new behavior policy. Shared Horizon is an Aster transport starting in Ashen and serving Vesper; Patient Endeavour now carries Aster freight on roaming long-haul deliveries. Vesper Runner remains an explicitly Frontier visitor at the Aster anchorage.

Content revision 2 applies a one-time visual upgrade to the three established stock Frontier transport/liner/patrol NPCs in older saves. It checks stable identity, culture, job, stock design and livery; captured/destroyed ships, the player, foreign/custom hulls and current-revision explicit choices retain their designs. Progress and all simulation state remain intact. New Aster actors reconcile by stable ID once. The save shape stays schema 6.

Select a ship and inspect its contact to rotate the same model used in flight. Radio remains text bubbles over the speaking ships; no audio or station dialogue is added.

## Register a culture

`ContentCatalog` has `cultures`, `shipDesigns` and `radioProfiles` dictionaries. A new culture can reuse assets initially:

```ts
catalog.radioProfiles.formal = {
  id: 'formal',
  templates: {
    'navigation.arrival': [
      '{speaker} requesting approach clearance to {destination}.',
      '{destination} control, {speaker} reporting inbound.'
    ]
  }
};
catalog.cultures.concord = {
  id: 'concord',
  name: 'Concord',
  radioProfileId: 'formal',
  shipDesigns: {
    cutter: ['industrial-cutter'],
    merchant: ['industrial-merchant']
  }
};
```

Assign a system's `cultureId` to use those defaults, or set a traffic spawn's optional `cultureId` for a visitor. Assign an explicit `spawn.ship.designId` to author a foreign-built hull. Its design must match the ship's gameplay class, but need not be in its crew culture's normal design pool. Validate the catalog before creating sessions.

System culture does not select the background/planet palette; `themeId` retains that responsibility. It does not grant hostility, police jurisdiction or a job. Naming profiles and station-style defaults can be added later without moving cultural identity into location-dependent logic.

## Add a different model

Register a `ShipDesignDefinition` with stable `id`, human name, gameplay `kind` and `modelId`; put that ID in the appropriate culture pool. Register a builder under `shipModelBuilders` using its `modelId`.

A provider returns a complete Three.js model in simulation units. It must expose `ring`, `flame` and the named `pdc-0`/`pdc-1` attachments used by the existing renderer; PDC placement should agree with the core mount definitions. A genuinely different weapon layout requires corresponding simulation support.

`createShipModel(ship, catalog.shipDesigns)` is shared by flight rendering and `ShipPreview`. The cache key includes design ID, gameplay class and livery. Changing ownership or entering another culture preserves geometry. Changing design or paint rebuilds the cached model. Missing providers/required attachments fail explicitly. Call `validateShipModelProviders` at graphics bootstrap.

Designs currently change presentation only. Cutter/merchant statistics, handling, cargo capacity and combat rules remain in core definitions. Culture-specific performance would be a separate gameplay decision.

## Speaker-aware radio

Policies emit semantic announcements such as `navigation.arrival` with `{destination}`. They never select a culture, phrase or graphics provider.

`RadioDirector` supplies the actual actor as the speaker. `RadioTemplates` looks up:

```text
speaker.cultureId → culture.radioProfileId → profile.templates[topic]
```

Templates are plain strings with named placeholders. Event values and built-in `{speaker}`/`{culture}` fill them; there is no expression evaluation. An event ID and actor ID choose a stable variant, so repeated formatting does not consume randomness or change the phrase.

An absent culture-specific topic, or a template requiring unavailable values, falls back to the shared registered formatter. An unknown topic with neither a profile phrase nor a shared formatter is silent. The same scheduler still handles relevance, urgency, deduplication, expiry and bubble limits. Current system affects the channel, never the speaker's voice. If station replies are added later, each station should supply its own speaker identity.

## Persistence and capture

Schemas 5 and 6 require explicit NPC/captain cultures and hull design IDs. Core-only `Ship` records may omit visual identity; entering a game session resolves it, and current save imports require it. Versions 1–5 migrate: NPCs backfill from saved home-system culture (known authored home where possible for version 3), the legacy captain uses the catalog default, and missing hull designs resolve once. Migration preserves journey progress, damage, equipment, cargo and follow identity. Cultural history absent from an old schema cannot be reconstructed beyond these defaults.

Capturing a culture-B hull keeps its design, while the player captain retains culture A. The retired NPC ledger record keeps its historical culture. No detailed crew-personality system or player radio mechanic is added. Vessel exchange preserves captain culture and inventory; an unspecified replacement design uses local system defaults.

Unknown identity/design references and class mismatches fail validation rather than silently changing a ship. The browser save UI preserves unreadable saves and keeps JSON export/import available.

`src/culture.test.ts` exercises foreign-system visits and reloads, foreign capture/exchange, changed home defaults, independent faction/job/identity, schema-4 migration, voice variants/fallback, stable design selection, unchanged physics and provider/cache invalidation without needing browser graphics.

The generator now references registered culture IDs from its presets and preserves them in ordinary system definitions. Generated NPCs resolve the same culture/design defaults as authored NPCs; intermediate routing does not alter identity. See [SYSTEM_AUTHORING.md](SYSTEM_AUTHORING.md).

Regions supply defaults during generation; an explicit system culture can override them for enclaves. NPC culture remains independent of current region. Content revision 3 specifically corrects the six original stock freighters from the misconfigured Drift generation; custom/retired hulls and unrelated Frontier visitors are preserved. See [SYSTEM_AUTHORING.md](SYSTEM_AUTHORING.md).
