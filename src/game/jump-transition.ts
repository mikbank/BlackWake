import { hyperspaceHoldFraction } from './jump-travel';
import type { SystemDefinition } from '../content/schema';
import type { SystemProvider } from '../content/system-provider';
import type { GameSession, Result } from './session';
/** Presentation supplies preparation and resource ownership; travel logic never imports Three.js. */
export type JumpPreparation<T> = {
  /** Prepare disposable destination resources while departure remains authoritative. */
  prepare(definition: SystemDefinition, session: GameSession, signal: AbortSignal): Promise<T>;
  /** Transfer a prepared resource to the active renderer after a successful domain arrival. */
  accept(resource: T): void;
  /** Release failed, cancelled or superseded work exactly once. */
  dispose(resource: T): void;
};
/** Coordinate asynchronous destination readiness with the independently timed player journey. */
export class JumpTransition<T> {
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  error = '';
  private owner: GameSession | undefined;
  private resource: T | undefined;
  private generation = 0;
  private abort: AbortController | undefined;
  /** Inject content and graphics boundaries so failure/timing behavior is testable without a browser. */
  constructor(
    private provider: SystemProvider,
    private preparation: JumpPreparation<T>
  ) {}
  /** Report whether a session reserves departure, including an error awaiting retry or cancellation. */
  get active() {
    return this.owner !== undefined;
  }
  /** Read the current journey without making the controller a second owner of its domain state. */
  get transit() {
    return this.owner?.transit ?? null;
  }
  /** Reserve a validated departure and start asynchronous work without blocking animation frames. */
  begin(session: GameSession, connectionId: string): Result {
    if (this.active) return { ok: false, message: 'A journey is already in progress.' };
    const result = session.dispatch({ type: 'jump', connectionId });
    if (!result.ok) return result;
    this.owner = session;
    this.state = 'loading';
    this.error = '';
    void this.load();
    return result;
  }
  /** Retry only preparation; the same departure and journey budget remain reserved. */
  retry() {
    if (!this.owner || this.state !== 'failed') return;
    this.state = 'loading';
    this.error = '';
    if (this.owner.transit)
      this.owner.transit.elapsed = Math.min(
        this.owner.transit.elapsed,
        this.owner.transit.duration * hyperspaceHoldFraction
      );
    void this.load();
  }
  /** Abort pending work and invalidate its eventual result while retaining the departure checkpoint. */
  cancel() {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    if (this.resource !== undefined) this.preparation.dispose(this.resource);
    this.resource = undefined;
    this.owner?.cancelTransit();
    this.owner = undefined;
    this.state = 'idle';
    this.error = '';
  }
  /** Advance only the journey animation, committing simulated time once both duration and destination are ready. */
  update(dt: number): Result | undefined {
    const session = this.owner;
    if (!session || this.state === 'failed') return;
    if (!Number.isFinite(dt) || dt < 0) throw Error('Invalid transit step');
    const journey = session.transit;
    const remaining = journey
      ? Math.max(0, journey.duration * hyperspaceHoldFraction - journey.elapsed)
      : 0;
    session.advanceTransit(this.state === 'ready' ? dt : Math.min(dt, remaining));
    if (
      this.state !== 'ready' ||
      !session.transit ||
      session.transit.elapsed < session.transit.duration
    )
      return;
    const result = session.completeJump();
    if (!result.ok) {
      this.state = 'failed';
      this.error = result.message;
      if (this.resource !== undefined) this.preparation.dispose(this.resource);
      this.resource = undefined;
      return result;
    }
    const resource = this.resource!;
    this.resource = undefined;
    this.owner = undefined;
    this.state = 'idle';
    this.generation++;
    this.preparation.accept(resource);
    return result;
  }
  /** Discard late completions after cancel/retry and turn loading failures into a recoverable UI state. */
  private async load() {
    const session = this.owner,
      transit = session?.transit,
      generation = ++this.generation;
    if (!session || !transit) return;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const definition = await this.provider.load(transit.systemId, abort.signal);
      if (generation !== this.generation) return;
      if (definition.id !== transit.systemId)
        throw Error('Destination provider returned the wrong system.');
      const resource = await this.preparation.prepare(definition, session, abort.signal);
      if (generation !== this.generation || this.owner !== session) {
        this.preparation.dispose(resource);
        return;
      }
      this.resource = resource;
      this.state = 'ready';
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = 'failed';
      this.error =
        error instanceof Error ? error.message : 'The destination could not be prepared.';
    }
  }
}
