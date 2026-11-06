import type { CombatPosture } from '../../core/ai';
import type { ContentCatalog } from '../../content/catalog';
import type {
  JobPolicy,
  JobRecord,
  JobContext,
  JobStep,
  JobDescription,
  Aggression,
  JobReaction
} from './model';
import type { Input } from '../../core/model';
/**
 * Controller-facing operations after policy-specific generic types are hidden inside their
 * validated registration closures.
 */
interface RegisteredJob {
  combatPosture: CombatPosture;
  /** Decode authored policy config and create a complete initial job record. */
  create(raw: unknown, ctx: JobContext): JobRecord;
  /** Decode saved policy config and progress into a valid restorable job record. */
  read(config: unknown, state: unknown, catalog: ContentCatalog): JobRecord;
  /** Validate authored policy settings without constructing an actor. */
  validate(raw: unknown, catalog: ContentCatalog): void;
  /** Request the policy's next generic task and progress update. */
  next(ctx: JobContext, job: JobRecord): JobStep<unknown>;
  /** Read the policy's factual contact description. */
  describe(ctx: JobContext, job: JobRecord): JobDescription;
  /** Read an optional policy override for physical steering. */
  order(ctx: JobContext, job: JobRecord): Input | undefined;
  /** Offer a witnessed attack to the policy and return its optional response. */
  react(ctx: JobContext, job: JobRecord, event: Aggression): JobReaction<unknown> | undefined;
}
/**
 * Adapt differently typed job policies to one controller-facing contract; each policy
 * still validates its own configuration and state.
 */
export class TrafficJobs {
  private policies = new Map<string, RegisteredJob>();
  /**
   * Close over a policy's concrete config/state types, exposing uniform operations while
   * rejecting duplicate job kinds.
   */
  register<C, S>(policy: JobPolicy<C, S>) {
    if (this.policies.has(policy.kind)) throw Error(`Duplicate traffic policy: ${policy.kind}`);
    /**
     * Recover the policy-specific generic types inside its registration closure; this
     * assertion performs no runtime conversion.
     */
    const typed = (job: JobRecord) => job as JobRecord<C, S>;
    this.policies.set(policy.kind, {
      combatPosture: policy.combatPosture ?? 'broadside',
      /**
       * Validate authored configuration through the concrete policy and build its initial
       * serializable job record.
       */
      create: (raw, ctx) => {
        const config = policy.readConfig(raw, ctx.catalog);
        return { kind: policy.kind, config, state: policy.create(ctx, config) };
      },
      /**
       * Validate saved configuration and state through their policy before exposing a restored
       * job to the controller.
       */
      read: (raw, state, catalog) => {
        const config = policy.readConfig(raw, catalog);
        return { kind: policy.kind, config, state: policy.readState(state, config, catalog) };
      },
      /** Check authored configuration without constructing or advancing an NPC. */
      validate: (raw, catalog) => {
        policy.readConfig(raw, catalog);
      },
      /**
       * Dispatch the next job decision to the policy with its validated concrete config and
       * state.
       */
      next: (ctx, job) => {
        const j = typed(job);
        return policy.next(ctx, j.config, j.state);
      },
      /**
       * Dispatch the contact description to the policy, keeping job-specific UI facts out of the
       * controller.
       */
      describe: (ctx, job) => {
        const j = typed(job);
        return policy.describe(ctx, j.config, j.state);
      },
      /**
       * Ask an optional policy movement override for this actor, otherwise leave navigation to
       * the shared executor.
       */
      order: (ctx, job) => {
        const j = typed(job);
        return policy.order?.(ctx, j.config, j.state);
      },
      /**
       * Ask the policy's optional aggression handler for a state change, hostility and
       * announcement.
       */
      react: (ctx, job, event) => {
        const j = typed(job);
        return policy.onAggression?.(ctx, j.config, j.state, event);
      }
    });
  }
  /**
   * Resolve a job implementation by kind and fail explicitly when content or a save
   * references an unregistered policy.
   */
  get(kind: string) {
    const policy = this.policies.get(kind);
    if (!policy) throw Error(`Unknown traffic policy: ${kind}`);
    return policy;
  }
  /** Validate every authored spawn through its registered job policy before NPCs are created. */
  validateCatalog(catalog: ContentCatalog) {
    for (const system of Object.values(catalog.systems))
      for (const spawn of system.traffic)
        this.get(spawn.job.kind).validate(spawn.job.config, catalog);
  }
}
