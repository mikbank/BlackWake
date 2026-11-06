import {
  definitions,
  pointDefenceMounts,
  mountPosition,
  freshDefence,
  subtract,
  advance,
  distance,
  angleDelta,
  contactTime,
  leadTime,
  type Ship,
  type Shot,
  type DefenceRound,
  type DefenceState,
  type Event
} from './model';
import { Relations } from './relations';
import type { CombatBody } from './ecs/components';
/** Component access keeps the legacy defence-map save adapter pointed at live ECS records. */
export type DefenceAccess = {
  /** Read a live PDC capability, if the entity has one. */
  get(id: string): DefenceState | undefined;
  /** Replace restored PDC state on current entities, without granting missing capabilities. */
  replace(states: Record<string, DefenceState>): void;
  /** Enumerate live PDC state to refresh the serialization index. */
  entries(): [string, DefenceState][];
};
/**
 * Own broadside shells, physical PDC rounds and collision resolution for the active
 * system; presentation consumes its events.
 */
export class CombatSystem {
  elapsed = 0;
  ships: CombatBody[] = [];
  shots: Shot[] = [];
  defenceRounds: DefenceRound[] = [];
  private defenceIndex: Record<string, DefenceState> = {};
  /** Expose a serialization index whose values are the same records as live PDC components. */
  get defences() {
    if (this.defenceAccess)
      for (const [id, state] of this.defenceAccess.entries()) this.defenceIndex[id] = state;
    return this.defenceIndex;
  }
  /** Restore legacy save state and update existing PDC capabilities without duplicate state copies. */
  set defences(value: Record<string, DefenceState>) {
    this.defenceIndex = value;
    this.defenceAccess?.replace(value);
  }
  events: Event[] = [];
  /**
   * Share the world's hostility rules so weapons and point defence agree about legitimate
   * threats.
   */
  constructor(
    readonly relations: Relations,
    private defenceAccess?: DefenceAccess
  ) {}
  /**
   * Return a ship's mutable PDC state, creating fresh counters and cooldowns the first time
   * it is needed.
   */
  defenceFor(ship: Pick<Ship, 'id'>) {
    return (this.defenceIndex[ship.id] =
      this.defenceAccess?.get(ship.id) ?? this.defenceIndex[ship.id] ?? freshDefence());
  }
  /**
   * Launch a three-shell broadside only when range, firing arc and that side's reload timer
   * allow it.
   */
  fire(ship: CombatBody, target: CombatBody, disable: boolean) {
    const d = distance(ship.position, target.position);
    if (d > 610 || d < 15 || ship.hull <= 0) return;
    const bearing = angleDelta(
      Math.atan2(target.position.y - ship.position.y, target.position.x - ship.position.x),
      ship.heading
    );
    const side = bearing > 0 ? 0 : 1;
    if (Math.abs(Math.abs(bearing) - Math.PI / 2) > 0.7 || ship.reload[side] > 0) return;
    ship.reload[side] = definitions[ship.kind].reload;
    for (let n = -1; n <= 1; n++) {
      const flight = d / 390,
        a =
          Math.atan2(
            target.position.y + target.velocity.y * flight - ship.position.y,
            target.position.x + target.velocity.x * flight - ship.position.x
          ) +
          n * 0.026;
      this.shots.push({
        position: { ...ship.position },
        velocity: { x: Math.cos(a) * 390, y: Math.sin(a) * 390, z: 0 },
        life: 1.8,
        owner: ship.id,
        disable
      });
    }
    this.events.push({
      type: 'fire',
      position: { ...ship.position },
      player: ship.owner === 'player'
    });
  }
  /**
   * Resolve a projectile owner's ship and test its current relationship to the potential
   * defender.
   */
  private hostile(source: string, ship: CombatBody) {
    const other = this.ships.find(
      /** Resolve the firing ship before evaluating whether its shell threatens this defender. */
      (s) => s.id === source
    );
    return !!other && this.relations.isHostile(other, ship);
  }
  /**
   * Select the incoming hostile shell predicted to threaten this hull soonest within PDC
   * range.
   */
  private threatFor(ship: CombatBody) {
    let best: Shot | undefined,
      soonest = Infinity;
    for (const shot of this.shots) {
      if (shot.life <= 0 || !this.hostile(shot.owner, ship)) continue;
      const r = subtract(shot.position, ship.position),
        v = subtract(shot.velocity, ship.velocity),
        v2 = v.x * v.x + v.y * v.y;
      if (Math.hypot(r.x, r.y) > definitions[ship.kind].pointDefence.range || v2 < 1) continue;
      const t = -(r.x * v.x + r.y * v.y) / v2;
      if (
        t < 0 ||
        t > shot.life ||
        Math.hypot(r.x + v.x * t, r.y + v.y * t) > definitions[ship.kind].length * 0.49 + 5
      )
        continue;
      if (t < soonest) {
        soonest = t;
        best = shot;
      }
    }
    return best;
  }
  /**
   * Advance PDC cooldowns and emit aimed physical rounds with deterministic dispersion;
   * interception still requires collision.
   */
  defend(dt: number, defenders: CombatBody[] = this.ships) {
    for (const ship of defenders) {
      const state = this.defenceFor(ship),
        system = definitions[ship.kind].pointDefence;
      state.cooldown = Math.max(0, state.cooldown - dt);
      state.cadence = Math.max(0, state.cadence - dt);
      if (ship.hull <= 0 || ship.owner === 'salvage') continue;
      if (!state.burstRemaining && state.cooldown <= 0 && this.threatFor(ship)) {
        state.burstRemaining = system.burstSize;
        state.cooldown = system.cooldown;
        state.cadence = 0;
      }
      if (!state.burstRemaining || state.cadence > 0) continue;
      const target = this.threatFor(ship);
      if (!target) {
        state.burstRemaining = 0;
        continue;
      }
      const mount = state.mount,
        origin = mountPosition(ship, mount),
        t = leadTime(origin, target, system.speed);
      if (t === null) {
        state.burstRemaining = 0;
        continue;
      }
      const aim = advance(target.position, target.velocity, t);
      // Deterministic dispersion: real misses, no guaranteed-hit dice roll or instant deletion.
      const spread = [-0.065, 0.015, 0.075, -0.025, 0.055, -0.012][state.roundsFired % 6];
      const angle = Math.atan2(aim.y - origin.y, aim.x - origin.x) + spread;
      this.defenceRounds.push({
        position: { ...origin },
        velocity: { x: Math.cos(angle) * system.speed, y: Math.sin(angle) * system.speed, z: 0 },
        life: 0.32,
        owner: ship.id,
        mount
      });
      state.roundsFired++;
      state.burstRemaining--;
      state.cadence = system.interval;
      state.mount = (mount + 1) % pointDefenceMounts.length;
      this.events.push({
        type: 'pdc-fire',
        position: aim,
        origin,
        mount,
        shipId: ship.id,
        player: ship.owner === 'player'
      });
    }
  }

  /**
   * Advance projectiles, sweep collisions through the frame and resolve hits in time order
   * so spent rounds cannot hit twice.
   */
  resolve(dt: number, previousShips: Map<CombatBody, { x: number; y: number; z: number }>) {
    const previousShots = new Map(
        this.shots.map(
          /** Snapshot broadside-shell positions before movement for swept collision detection. */
          (shot) => [shot, { ...shot.position }]
        )
      ),
      previousRounds = new Map(
        this.defenceRounds.map(
          /** Snapshot PDC-round positions before movement for swept interception detection. */
          (round) => [round, { ...round.position }]
        )
      );
    for (const shot of this.shots) {
      shot.life -= dt;
      shot.position = advance(shot.position, shot.velocity, dt);
    }
    for (const round of this.defenceRounds) {
      round.life -= dt;
      round.position = advance(round.position, round.velocity, dt);
    }
    const collisions: { time: number; shot: Shot; round?: DefenceRound; ship?: CombatBody }[] = [];
    for (const shot of this.shots) {
      if (shot.life <= 0) continue;
      const before = previousShots.get(shot)!;
      for (const round of this.defenceRounds) {
        const defender = this.ships.find(
          /** Resolve the PDC round's defender when applying hull-specific interception rules. */
          (s) => s.id === round.owner
        );
        if (round.life <= 0 || !defender || !this.hostile(shot.owner, defender)) continue;
        const time = contactTime(
          subtract(previousRounds.get(round)!, before),
          subtract(round.position, shot.position),
          definitions[defender.kind].pointDefence.hitRadius
        );
        if (time !== null) collisions.push({ time, shot, round });
      }
      for (const ship of this.ships) {
        if (ship.id === shot.owner || ship.hull <= 0 || ship.owner === 'salvage') continue;
        const time = contactTime(
          subtract(before, previousShips.get(ship)!),
          subtract(shot.position, ship.position),
          definitions[ship.kind].length * 0.49
        );
        if (time !== null) collisions.push({ time, shot, ship });
      }
    }
    // Resolve in time order so neither a spent PDC round nor an already-hit shell hits twice.
    collisions.sort(
      /** Resolve earlier impacts first so a spent shell or round cannot cause a second collision. */
      (a, b) => a.time - b.time
    );
    for (const { time, shot, round, ship } of collisions) {
      if (shot.life <= 0 || (round && round.life <= 0) || (ship && ship.hull <= 0)) continue;
      const before = previousShots.get(shot)!,
        position = {
          x: before.x + (shot.position.x - before.x) * time,
          y: before.y + (shot.position.y - before.y) * time,
          z: 8
        };
      shot.life = 0;
      if (round) {
        round.life = 0;
        const defender = this.ships.find(
          /** Credit an interception to the hull that fired the successful PDC round. */
          (s) => s.id === round.owner
        )!;
        this.defenceFor(defender).interceptions++;
        this.events.push({
          type: 'intercept',
          position,
          player: defender.owner === 'player',
          shipId: defender.id,
          mount: round.mount
        });
      } else if (ship) {
        ship.hull = Math.max(0, ship.hull - (shot.disable ? 1.6 : 6));
        ship.engines = Math.max(0, ship.engines - (shot.disable ? 8 : 2));
        this.events.push({ type: 'hit', position, player: ship.owner === 'player' });
      }
    }
    this.shots = this.shots.filter(
      /** Retain only broadside shells whose lifetime has not expired or been consumed by a hit. */
      (s) => s.life > 0
    );
    this.defenceRounds = this.defenceRounds.filter(
      /** Retain only PDC rounds that are still alive after collision resolution. */
      (r) => r.life > 0
    );
  }
  /**
   * Discard transient shells, defence rounds and combat events when a scenario or controlled
   * hull changes.
   */
  clear() {
    this.shots = [];
    this.defenceRounds = [];
    this.events = [];
  }
}
