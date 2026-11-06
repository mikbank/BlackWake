import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog, makeShip, position } from './content/universe';
import { GameSession } from './game/session';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { createTrafficJobs } from './game/traffic/jobs';
import { loadSession } from './game/persistence';
import type { JobPolicy, Destination, JobStep } from './game/traffic/model';
import { record, integer, waypoints } from './game/traffic/validation';
import { createRadioTemplates } from './game/radio-templates';
import { RadioDirector } from './game/radio';

/**
 * Verify the scenario: a new typed NPC policy runs, saves, loads and speaks without
 * changes to the traffic executor.
 */
test('a new typed NPC policy runs, saves, loads and speaks without changes to the traffic executor', () => {
  type Config = { points: Destination[] };
  type State = { index: number };
  const survey: JobPolicy<Config, State> = {
    kind: 'test-survey',
    /**
     * Validate the test-only survey policy's authored stations and timing through the same
     * extension contract as built-in NPC jobs.
     */
    readConfig(raw, catalog) {
      return { points: waypoints(record(raw).points, catalog) };
    },
    /**
     * Validate the survey policy's saved task progress without adding decoding branches to the
     * traffic controller.
     */
    readState(raw, c) {
      return { index: integer(record(raw).index, 0, c.points.length - 1) };
    },
    /** Initialize the test-only survey actor's serializable policy state. */
    create() {
      return { index: 0 };
    },
    /**
     * Produce the next survey travel/wait task and semantic announcement through the shared
     * executor interface.
     */
    next(_ctx, c, s): JobStep<State> {
      return {
        state: { index: (s.index + 1) % c.points.length },
        action: {
          kind: 'travel',
          destination: c.points[s.index],
          activity: 'Measuring the local magnetic field'
        },
        announcement: { topic: 'test.survey', values: { sample: s.index } },
        completedJourney: true
      };
    },
    /** Expose the survey ship's purpose and manifest to the generic contact UI. */
    describe() {
      return {
        title: 'Survey vessel',
        purpose: 'Collecting field samples',
        manifest: 'Scientific instruments'
      };
    }
  };
  const jobs = createTrafficJobs();
  jobs.register(survey);
  const catalog = createCatalog();
  catalog.systems.ashen.traffic.push({
    ship: makeShip('test-surveyor', 'Survey One', 'cutter', 'research', -100, 0),
    job: {
      kind: 'test-survey',
      config: {
        points: [
          { kind: 'point', systemId: 'ashen', position: position(-90, 0), label: 'Sample A' },
          { kind: 'point', systemId: 'ashen', position: position(180, 0), label: 'Sample B' }
        ]
      }
    }
  });
  catalog.validate();
  const g = new GameSession(
    catalog,
    createServices(),
    createActivities(),
    'ashen',
    makeShip('pilot', 'Pilot', 'cutter', 'player', -100, -100),
    jobs
  );
  g.enableTraffic();
  const a = g.traffic.get('test-surveyor')!,
    templates = createRadioTemplates();
  templates.register(
    'test.survey',
    /**
     * Provide the test-only formatter or extension callback used to verify registry-based
     * behavior.
     */
    (v) => `Taking field sample ${v.sample}.`
  );
  const radio = new RadioDirector(catalog, templates);
  let heard = false;
  for (let i = 0; i < 1200; i++) {
    g.step(1 / 60, { turn: 0, thrust: 0, brake: true, fire: false });
    radio.update(
      g.clock,
      g.traffic.events,
      g.traffic,
      g.systemId,
      g.world.player.position,
      a.ship.id
    );
    heard ||= radio.active.some(
      /**
       * Check whether a fixture entry satisfies the presence or behavior condition asserted
       * here.
       */
      (b) => b.actorId === a.ship.id && /field sample/.test(b.text)
    );
  }
  assert.ok(a.journeys >= 3);
  assert.ok(heard);
  assert.equal(g.traffic.describe(a).title, 'Survey vessel');
  const restored = loadSession(g.save(), catalog, g.services, g.activities, jobs);
  assert.deepEqual(restored.traffic.get(a.ship.id)!.job, a.job);
  assert.equal(
    restored.world.ships.filter(
      /** Select the fixture identities required for this persistence or uniqueness check. */
      (s) => s.id === a.ship.id
    ).length,
    1
  );
  assert.throws(
    /**
     * Attempt save decoding and migration so the assertion can verify that invalid input is
     * rejected.
     */
    () => loadSession(g.save(), catalog, g.services, g.activities),
    /Unknown traffic policy/
  );
  assert.throws(
    /**
     * Attempt the scenario operation so the assertion can verify that invalid input is
     * rejected.
     */
    () => jobs.register(survey),
    /Duplicate/
  );
});
/**
 * Verify the scenario: job definitions are validated at registration use, before
 * simulation starts.
 */
test('job definitions are validated at registration use, before simulation starts', () => {
  const c = createCatalog();
  c.systems.kepler.traffic.find(
    /** Locate the fixture record matching the identity or state required by the assertion. */
    (t) => t.job.kind === 'patrol'
  )!.job.config.waypoints = [];
  assert.throws(
    /**
     * Attempt the scenario operation so the assertion can verify that invalid input is
     * rejected.
     */
    () => createTrafficJobs().validateCatalog(c)
  );
  const d = createCatalog();
  d.systems.ashen.traffic[0].job.kind = 'missing-policy';
  assert.throws(
    /**
     * Attempt the scenario operation so the assertion can verify that invalid input is
     * rejected.
     */
    () => createTrafficJobs().validateCatalog(d),
    /Unknown traffic policy/
  );
});
