/** Shared simulated journey time in seconds; rendering and network latency never change it. */
export const jumpTravelSeconds = 4;
/** Begin the final return to normal stars only after destination preparation succeeds. */
export const hyperspaceExitFraction = 0.72;
/** A stalled load waits in the full wormhole phase before the exit sequence begins. */
export const hyperspaceHoldFraction = 0.66;
/** A pending player journey retains departure ownership until a prepared destination can be committed. */
export type PlayerTransit = {
  connectionId: string;
  fromSystemId: string;
  systemId: string;
  arrivalGateId: string;
  duration: number;
  elapsed: number;
};
