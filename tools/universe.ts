import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readContent, writeContent, importIndex } from './content-files';
import { expandUniverse, systemSizeRanges } from '../src/content/generation/generate';
import { randomStream, round } from '../src/content/generation/random';
import { contentId } from '../src/content/data';
/**
 * Parse unique command-line flags and their values, rejecting repeated options and missing
 * arguments.
 */
function argumentsFor(args: string[]) {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--') || flags.has(key)) throw Error(`Invalid or repeated option: ${key}`);
    if (['--dry-run', '--check-index'].includes(key)) {
      flags.set(key, true);
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw Error(`Missing value: ${key}`);
    flags.set(key, value);
  }
  return flags;
}
/**
 * Validate CLI intent, build a generation blueprint and coordinate validated file writes
 * or read-only inspection.
 */
export function runUniverse(command: string, args: string[]) {
  const flags = argumentsFor(args),
    known = new Set([
      '--root',
      '--dry-run',
      '--check-index',
      '--id',
      '--name',
      '--names',
      '--region',
      '--seed',
      '--preset',
      '--connect',
      '--x',
      '--y',
      '--from',
      '--to',
      '--blueprint',
      '--count',
      '--prefix',
      '--anchor',
      '--environment',
      '--environments',
      '--size',
      '--radius'
    ]);
  for (const key of flags.keys()) if (!known.has(key)) throw Error(`Unknown option: ${key}`);
  const options: Record<string, string[]> = {
    create: [
      '--id',
      '--name',
      '--seed',
      '--preset',
      '--connect',
      '--x',
      '--y',
      '--region',
      '--environment',
      '--size',
      '--radius'
    ],
    connect: ['--from', '--to'],
    generate: [
      '--blueprint',
      '--count',
      '--seed',
      '--preset',
      '--prefix',
      '--anchor',
      '--names',
      '--region',
      '--environment',
      '--environments',
      '--size',
      '--radius'
    ],
    validate: ['--check-index'],
    sync: [],
    environments: []
  };
  if (!options[command])
    throw Error('Use create, connect, generate, environments, validate or sync.');
  for (const key of flags.keys())
    if (!['--root', '--dry-run', ...options[command]].includes(key))
      throw Error(`Option ${key} does not apply to ${command}.`);
  if (
    flags.has('--blueprint') &&
    [
      '--count',
      '--seed',
      '--prefix',
      '--anchor',
      '--preset',
      '--names',
      '--region',
      '--environment',
      '--environments',
      '--size',
      '--radius'
    ].some(
      /**
       * Reject batch options mixed into blueprint mode rather than ambiguously apply both
       * inputs.
       */
      (key) => flags.has(key)
    )
  )
    throw Error('Use a blueprint or batch-generation options, not both.');
  /** Read a string option or its explicit default and reject a missing required value. */
  const value = (key: string, fallback?: string) => {
    const v = flags.get(key) ?? fallback;
    if (typeof v !== 'string') throw Error(`Supply ${key}.`);
    return v;
  };
  /**
   * Convert a CLI value to a finite number; command-specific checks later enforce count,
   * seed and coordinate constraints.
   */
  const numeric = (key: string, fallback?: string) => {
    const n = Number(value(key, fallback));
    if (!Number.isFinite(n)) throw Error(`Invalid number: ${key}`);
    return n;
  };
  if (flags.has('--environment') && flags.has('--environments'))
    throw Error('Choose one environment or a profile pool, not both.');
  if (flags.has('--size') && flags.has('--radius'))
    throw Error('Choose --size or --radius, not both.');
  /** Resolve visual choices on their own seed stream without consuming layout, market or traffic randomness. */
  function environmentOptions(seed: number) {
    const pool = flags.has('--environments')
      ? value('--environments')
          .split(',')
          .map(
            /** Trim and validate each explicitly supplied appearance profile. */ (id) =>
              contentId(id.trim())
          )
      : undefined;
    if (pool && new Set(pool).size !== pool.length)
      throw Error('Duplicate environment in profile pool.');
    if (pool)
      for (const id of pool)
        if (!Object.hasOwn(source.definition.environmentProfiles, id))
          throw Error(`Unknown environment profile: ${id}`);
    const environmentId = flags.has('--environment')
      ? contentId(value('--environment'))
      : pool
        ? pool[Math.floor(randomStream(seed, 'environment-profile')() * pool.length)]
        : undefined;
    return {
      ...(environmentId ? { environmentId } : {}),
      ...(flags.has('--size') ? { size: value('--size') } : {}),
      ...(flags.has('--radius') ? { radius: numeric('--radius') } : {})
    };
  }
  const root = resolve(value('--root', fileURLToPath(new URL('../content', import.meta.url)))),
    source = readContent(root),
    dryRun = flags.has('--dry-run');
  if (command === 'environments')
    return {
      profiles: Object.values(source.definition.environmentProfiles).map(
        /** List available authoring choices without loading geometry or changing any files. */ (
          profile
        ) => ({ id: profile.id, name: profile.name, rendererId: profile.rendererId })
      ),
      sizes: systemSizeRanges
    };
  if (command === 'validate' || command === 'sync') {
    const indexPath = join(dirname(root), 'src/content/system-index.ts'),
      expected = importIndex(source.definition.systemIds);
    if (
      flags.has('--check-index') &&
      (!existsSync(indexPath) || readFileSync(indexPath, 'utf8') !== expected)
    )
      throw Error('Generated system imports are stale. Run npm run universe:sync.');
    const written = command === 'sync' ? writeContent(root, source, dryRun) : [];
    return { valid: true, systems: source.systems.length, files: written, dryRun };
  }
  let blueprint: unknown;
  if (command === 'create') {
    const id = contentId(value('--id')),
      connections = value('--connect')
        .split(',')
        .map(
          /** Turn each requested neighbor ID into a validated connection specification. */
          (to) => ({ from: id, to: contentId(to) })
        );
    const neighborRegions = new Set(
      connections.map(
        /** Collect neighboring region defaults for single-system creation. */
        (c) =>
          source.systems.find(
            /** Resolve the connected neighbor before inheriting its region. */
            (s) => s.id === c.to
          )?.regionId
      )
    );
    const regionId = flags.has('--region')
      ? contentId(value('--region'))
      : neighborRegions.size === 1
        ? [...neighborRegions][0]
        : undefined;
    blueprint = {
      schemaVersion: 1,
      systems: [
        {
          id,
          name: value('--name', id),
          ...(regionId ? { regionId } : {}),
          seed: numeric('--seed'),
          ...environmentOptions(numeric('--seed')),
          preset: value('--preset', 'frontier'),
          chart: { x: numeric('--x'), y: numeric('--y') }
        }
      ],
      connections
    };
  } else if (command === 'connect')
    blueprint = {
      schemaVersion: 1,
      systems: [],
      connections: [{ from: contentId(value('--from')), to: contentId(value('--to')) }]
    };
  else if (command === 'generate') {
    if (flags.has('--blueprint'))
      blueprint = JSON.parse(readFileSync(resolve(value('--blueprint')), 'utf8'));
    else {
      const rawNames = flags.has('--names') ? value('--names').trim() : undefined;
      const names: unknown =
        rawNames === undefined
          ? undefined
          : rawNames.startsWith('[')
            ? JSON.parse(rawNames)
            : rawNames.split(',');
      if (
        names !== undefined &&
        (!Array.isArray(names) ||
          !names.length ||
          names.some(
            /** Reject invalid or oversized entries before accepting a supplied name list. */
            (n) => typeof n !== 'string' || !n.trim() || n.trim().length > 60
          ))
      )
        throw Error('Names must be a list of nonempty system names, each at most 60 characters.');
      const cleanNames = (names as string[] | undefined)?.map(
        /** Trim surrounding whitespace from system names before generation. */
        (n) => n.trim()
      );
      if (
        cleanNames &&
        new Set(
          cleanNames.map(
            /** Normalize case only for duplicate-name detection within this batch. */
            (n) => n.toLocaleLowerCase('en')
          )
        ).size !== cleanNames.length
      )
        throw Error('System names must be unique within a batch.');
      const count = flags.has('--count') ? numeric('--count') : (cleanNames?.length ?? NaN),
        seed = numeric('--seed'),
        prefix = contentId(value('--prefix')),
        anchorId = contentId(value('--anchor')),
        anchor = source.systems.find(
          /** Resolve the batch anchor before deriving topology and inherited region defaults. */
          (s) => s.id === anchorId
        );
      if (
        !anchor ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 200 ||
        !Number.isInteger(seed) ||
        seed < 0 ||
        seed > 0xffffffff
      )
        throw Error('Supply an existing anchor, count 1–200, and a uint32 seed.');
      if (cleanNames && cleanNames.length !== count) throw Error('Names count must match --count.');
      const regionId = flags.has('--region') ? contentId(value('--region')) : anchor.regionId;
      const systems = [],
        connections = [];
      for (let i = 1; i <= count; i++) {
        const id = `${prefix}-${String(i).padStart(3, '0')}`,
          r = randomStream(seed, id),
          angle = i * 2.399963,
          orbit = 1.5 * Math.sqrt(i),
          systemSeed = Math.floor(r() * 0x100000000);
        systems.push({
          id,
          name: cleanNames?.[i - 1] ?? `${prefix[0].toUpperCase() + prefix.slice(1)} ${i}`,
          ...(regionId ? { regionId } : {}),
          seed: systemSeed,
          ...environmentOptions(systemSeed),
          preset: value('--preset', 'frontier'),
          chart: {
            x: round(anchor.chart.x + Math.cos(angle) * orbit),
            y: round(anchor.chart.y + Math.sin(angle) * orbit)
          }
        });
        const parent =
          i === 1
            ? anchorId
            : `${prefix}-${String(Math.max(1, Math.floor(i / 2))).padStart(3, '0')}`;
        connections.push({ from: parent, to: id });
      }
      blueprint = { schemaVersion: 1, systems, connections };
    }
  } else throw Error('Use create, connect, generate, environments, validate or sync.');
  const presets = JSON.parse(readFileSync(join(root, 'presets.json'), 'utf8')),
    result = expandUniverse(source, blueprint, presets, { rejectExisting: command === 'create' }),
    files = writeContent(root, result.bundle, dryRun);
  return {
    created: result.created,
    systems: result.bundle.systems
      .filter(
        /** Report only newly created systems in the authoring preview. */ (system) =>
          result.created.includes(system.id)
      )
      .map(
        /** Expose resolved appearance and actual physical radius in both dry runs and committed generation. */ (
          system
        ) => ({ id: system.id, environmentId: system.environmentId, radius: system.radius })
      ),
    retained: result.retained,
    connections: result.linked,
    files,
    dryRun
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(
      JSON.stringify(runUniverse(process.argv[2] ?? 'validate', process.argv.slice(3)), null, 2)
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
