import { prepareEnvironment, disposeEnvironment, type BuiltEnvironment } from './environment-model';
import { defaultEnvironmentProfile } from '../content/environments';
import * as THREE from 'three';
import type { Ship } from '../core/model';
import type { ShipDesignDefinition } from '../content/schema';
import { createShipModel, disposeShipModel } from '../ship-model';
import { prepareSystemModels, disposeSystemModels, type SceneContent } from './system-model';
export type PreparedScene = {
  content: SceneContent;
  environment: BuiltEnvironment;
  locations: THREE.Group;
  ships: Map<string, THREE.Group>;
};
/** Build destination-only graphics in batches, including visiting foreign hulls selected by actor identity. */
export async function prepareScene(
  content: SceneContent,
  ships: Ship[],
  designs: Record<string, ShipDesignDefinition>,
  yieldFrame: () => Promise<void>
): Promise<PreparedScene> {
  await yieldFrame();
  const environment = await prepareEnvironment(
    content.definition,
    content.environment ?? defaultEnvironmentProfile,
    yieldFrame
  );
  let locations: THREE.Group;
  try {
    locations = await prepareSystemModels(content, yieldFrame);
  } catch (error) {
    disposeEnvironment(environment);
    throw error;
  }
  const prepared: PreparedScene = { content, environment, locations, ships: new Map() };
  try {
    for (const ship of ships) {
      if (prepared.ships.has(ship.id)) continue;
      prepared.ships.set(ship.id, createShipModel(ship, designs));
      await yieldFrame();
    }
    return prepared;
  } catch (error) {
    disposePreparedScene(prepared);
    throw error;
  }
}
/** Release work which never reached the renderer; accepted resources are owned by View instead. */
export function disposePreparedScene(prepared: PreparedScene) {
  disposeEnvironment(prepared.environment);
  disposeSystemModels(prepared.locations);
  for (const group of prepared.ships.values()) disposeShipModel(group);
  prepared.ships.clear();
}
