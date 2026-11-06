# System environments and independent size

A system's `environmentId` references a data-only space appearance profile in `content/universe.json`. Its numeric `radius` remains the authoritative physical boundary. Its `cultureId` still supplies cultural defaults, and its existing `themeId` supplies station/gateway/primary-body material colors. None of these references implies another.

## Initial looks

| Profile ID | Look | Existing examples |
| --- | --- | --- |
| `frontier-space` | Faint blue/purple wisps and neutral starlight | Ashen Reach, Brume |
| `violet-veil` | Purple cloud banks and cool violet illumination | Vesper, Meridian |
| `amber-dust` | Warm dusty lanes, sparse stars and denser decorative rocks | Kepler Drift, Ilex |
| `ion-blue` | Bright blue/cyan filaments and cool illumination | Halcyon |
| `emerald-rift` | Green cloud banks and soft green light | Lacuna |
| `deep-void` | Clear dark space, prominent stars and little decoration | Nacre |

These six profiles use three rendering recipes: `clear-space`, `nebula`, and `dust-field`. Adding 25–30 curated looks ordinarily means adding profile records, not another class or renderer per look. A new procedural recipe is a graphics feature and needs matching recipe validation; registering a name alone cannot install executable rendering code.

## Profile contract

Profiles declare `background` (base color, two tints, procedural texture-set ID, intensity, coverage and scale), `stars` (density/color/size), `lighting` (key/fill colors and intensities), `dust`, and decorative `asteroids`. Colors are encoded sRGB hex values. Authoring validation rejects unknown recipes/texture sets, invalid colors, nonfinite values, unbounded density and missing references before generation writes or browser play.

The current texture sets are `wisps`, `billows`, `dust-lanes`, and `none`, generated locally. There are no downloaded background images. Their 3D noise is sampled on a sphere, so the equirectangular seam is continuous. Dedicated `visual-background`, `visual-stars`, `visual-dust`, and `visual-asteroids` seed streams ensure repeated visits reproduce a system's appearance. Changing profile selection never consumes layout, market or NPC randomness.

The environment owns two roots: a camera-centred sky and world-positioned decoration/lights. Cosmetic rocks are instanced, bounded in count, and kept away from landmark, station and gateway approaches. They are not collision bodies or authored hazards. The environment does not select ship models, change crew voice, repaint infrastructure materials, add gravity or change travel speed. Its light can naturally tint how existing materials appear.

## Size and authoring

Run `npm run universe:environments` to list profiles and size bands. The creator and seeded batch generator accept:

- `--environment <id>` for a fixed appearance.
- `--environments <id,id,...>` for a reproducible batch-only pool.
- `--size small|medium|large` for a radius band: 6000–9000, 10000–16000, or 20000–30000 metres.
- `--radius <integer>` for an exact physical radius from 1200 to 40000 metres.

Choose size or radius, and a fixed environment or a pool. Layout presets can declare `environmentIds`; they retain their original radius bands when no size override is supplied. A blueprint can specify `environmentId` plus either `size` or `radius` on each system specification. The resulting runtime system stores the selected `environmentId` and the resolved `radius`; no second runtime size property is persisted. Named pools resolve on a dedicated seed stream. Region/culture inheritance remains independent.

Single-system example:

```sh
npm run system:create -- --id cobalt-rest --name "Cobalt Rest" --seed 815 --connect ashen --x 4 --y 3 --environment ion-blue --size medium --dry-run
```

Batch example:

```sh
npm run universe:generate -- --names "Quiet Light,Old Ember,Far Shore" --prefix survey --seed 816 --anchor vesper --environments violet-veil,amber-dust,deep-void --radius 12500 --dry-run
```

Dry runs report actual resolved profile IDs and radii without creating systems. Omit `--dry-run` to write. Existing systems retain hand edits on blueprint/batch replay; single-system creation rejects an existing ID. Changing a profile never resizes existing layouts. Generation validates the full bundle before writing.

## Resource lifetime and quality

`ui/environment-model.ts` builds initial graphics synchronously and destination graphics in batches across animation frames. `prepareScene` includes the destination sky, decoration and lighting in its ownership bundle; shader warm-up uses the destination's lights. On accepted arrival, `View` releases the previous environment and transfers the prepared one. Failed/cancelled preparation disposes its partial buffers, textures, materials and instance attributes.

Device budgets are separate from profile data and system radius. The mobile budget caps stars at 2600, dust at 140 and rocks at 65, with a 512×256 procedural background; a low budget is available in code. Large systems do not multiply particle counts by area. No graphics cache retains all profiles. At a jump, memory temporarily includes departure plus one candidate destination. The initial system builds once before flight; destination background rows yield during hyperspace.

## Compatibility and remaining work

Legacy content without a profile table receives the Frontier haze fallback. Legacy systems without `environmentId` use the declared default. Environment changes preserve `themeId`, gate IDs, system IDs and physical radius. Coordinate revision 1 separately expands the original layouts by 5× and stations by 3×; see [SCALE.md](SCALE.md). Legacy theme `background` and `starColor` values remain readable authored fields but space rendering now uses environment profiles. Voyage saves remain schema 6; profiles are content rather than duplicated saved state.

A future asset provider can replace procedural texture sets with fetched artwork through the existing hyperspace preparation boundary. All profile metadata and system definitions remain bundled today. Browser/phone playtesting is still required for final composition, lighting and GPU frame time; CPU texture previews do not establish in-game visual performance.
