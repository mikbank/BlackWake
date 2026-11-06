import assert from 'node:assert/strict';
import type { GameSession } from '../game/session';
/** Complete a validated journey in headless domain tests; renderer readiness is exercised by coordinator tests. */
export function finishTransit(session: GameSession) {
  assert.ok(session.transit, 'Expected a reserved departure');
  session.advanceTransit(session.transit.duration);
  const result = session.completeJump();
  assert.ok(result.ok, result.message);
}
