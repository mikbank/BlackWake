import { stationApproachDistance } from './game/station-approach';
import { stationFootprintRadius } from './content/spatial-scale';
import { systemEnvironment } from './content/environments';
import { CatalogSystemProvider } from './content/system-provider';
import { JumpTransition } from './game/jump-transition';
import { HyperspaceScreen } from './ui/hyperspace';
import { prepareScene, disposePreparedScene } from './ui/prepared-scene';
import { cruiseApproachRange } from './core/cruise';
import { universeChart } from './ui/universe-chart';
import { jumpDestinations, regionName } from './ui/navigation-menu';
import './style.css';
import { distance, definitions, type Ship } from './simulation';
import { Navigation } from './navigation';
import { View } from './view';
import { ShipPreview, validateShipModelProviders } from './ship-model';
import { approachPoint, edgeGuide } from './hud';
import { drawMinimap } from './minimap';
import { createCatalog } from './content/universe';
import { createServices, cargoUsed } from './game/services';
import { cargoTransferPlan } from './game/boarding';
import { createActivities } from './game/activities';
import {
  GameSession,
  type Selection,
  type Contact,
  type SessionCommand,
  type Result
} from './game/session';
import { startFreeRoam, startRaid } from './game/start';
import { loadSession } from './game/persistence';
import { sessionHud, suggestedContact, guideText } from './ui/guidance';
import { serviceViews } from './ui/station-services';
import { esc, element as $ } from './ui/dom';
import { openBrowserSaves, migrateBrowserSaves } from './game/save-store';
import { followTarget } from './game/follow';
import { actorSystemId } from './game/traffic/model';
/**
 * Compose browser controls, rendering, audio and storage around a game session; domain
 * rules remain in the simulation and session modules.
 */
async function main() {
  const catalog = createCatalog(),
    services = createServices(),
    activities = createActivities(),
    navigation = new Navigation();
  let game = startFreeRoam(catalog, services, activities),
    view: View,
    preview: ShipPreview | undefined,
    paused = true,
    sound = false,
    audio: AudioContext | undefined,
    sceneGeneration = 0,
    saveClock = 0,
    lowWarning = false,
    failedShown = false,
    toastTimer: ReturnType<typeof setTimeout> | undefined;
  services.validate(catalog);
  validateShipModelProviders(catalog.shipDesigns);
  const { saves, notice: storageNotice } = await openBrowserSaves();
  let startupNotice = storageNotice,
    saveStatus = 'Not yet saved';
  const blockedSlots = new Set<string>();
  try {
    const failures = await migrateBrowserSaves(
      saves,
      localStorage,
      /**
       * Validate and upgrade an older browser save through the same session decoder used for
       * normal loading.
       */
      (raw) => loadSession(raw, catalog, services, activities).save()
    );
    if (failures.length)
      startupNotice +=
        ' An older save could not be migrated; its original copy has been preserved.';
  } catch {}
  try {
    const saved = await saves.read('trading');
    if (saved) game = loadSession(saved, catalog, services, activities);
  } catch {
    blockedSlots.add('trading');
    startupNotice +=
      ' The saved voyage could not be read. It is preserved; import a save or use Restart to begin again.';
  }
  try {
    view = new View($<HTMLCanvasElement>('space'), catalog.shipDesigns);
  } catch {
    $('dialog').innerHTML =
      '<h1>Graphics unavailable.</h1><p>This game needs a browser with WebGL enabled.</p>';
    throw Error('WebGL unavailable');
  }
  /** Yield graphics preparation until the next browser frame so the tunnel remains responsive. */
  const yieldFrame = () =>
    new Promise<void>(
      /** Resume destination work after the browser has an opportunity to paint the overlay. */
      (resolve) =>
        requestAnimationFrame(
          /** Complete one preparation yield without consuming simulation time. */ () => resolve()
        )
    );
  const transition = new JumpTransition(new CatalogSystemProvider(catalog), {
    /** Prepare destination models, including foreign visitors and ships currently travelling to it. */
    async prepare(definition, session, signal) {
      /** Stop destination work at the next frame boundary after an abort. */
      const yieldBatch = async () => {
        signal.throwIfAborted();
        await yieldFrame();
        signal.throwIfAborted();
      };
      const ships = [
        session.world.player,
        ...(session.systems[definition.id]?.ships ?? []),
        ...session.traffic.actors
          .filter(
            /** Include both resident actors and incoming travellers without changing their ledger state. */
            (actor) =>
              !['captured', 'destroyed'].includes(actor.motion.kind) &&
              (actorSystemId(actor) === definition.id ||
                (actor.motion.kind === 'transit' && actor.motion.arrivalSystemId === definition.id))
          )
          .map(
            /** Read each visitor's own design and livery, independently of the destination culture. */ (
              actor
            ) => actor.ship
          )
      ];
      const prepared = await prepareScene(
        {
          key: `${sceneGeneration}:${definition.id}`,
          definition,
          theme: catalog.themes[definition.themeId],
          environment: systemEnvironment(catalog, definition),
          sizes: catalog.stationSizes,
          dockedAt: null
        },
        ships,
        catalog.shipDesigns,
        yieldBatch
      );
      try {
        await view.warmPreparedScene(prepared);
        await yieldBatch();
        return prepared;
      } catch (error) {
        disposePreparedScene(prepared);
        throw error;
      }
    },
    /** Transfer ready destination resources after the domain has committed arrival. */
    accept(prepared) {
      view.acceptPreparedScene(prepared);
    },
    dispose: disposePreparedScene
  });
  const hyperspace = new HyperspaceScreen(
    /** Retry the same reserved journey without consuming another transit interval. */
    () => transition.retry(),
    /** Return to the preserved departure world after a failure or an explicit abort. */
    () => {
      transition.cancel();
      hyperspace.hide();
      resume();
      save();
      toast('Returned to departure.');
    }
  );
  /** Start a validated hyperspace journey and persist its safe departure checkpoint. */
  function beginJump(connectionId: string) {
    const result = transition.begin(game, connectionId);
    if (!result.ok) {
      toast(result.message);
      return;
    }
    save();
    resume();
  }
  /**
   * Choose the independent raid save slot and scenario UI from the current optional
   * activity.
   */
  const isRaid = () => game.activity?.type === 'raid';
  /**
   * Serialize the session and commit through the ordered save adapter, preserving unreadable
   * slots and displaying storage failures.
   */
  async function save() {
    const slot = isRaid() ? 'raid' : 'trading';
    if (blockedSlots.has(slot)) {
      $('save-warning').textContent =
        'Previous save preserved · import a save or restart to enable saving';
      $('save-warning').hidden = false;
      return false;
    }
    const payload = game.save();
    try {
      await saves.write(slot, payload);
      saveStatus =
        saves.store.label === 'Session only'
          ? 'Session only · export to keep progress'
          : 'Saved in this browser';
      const status = document.getElementById('save-status');
      if (status) status.textContent = `${saves.store.label} · ${saveStatus}`;
      $('save-warning').hidden = true;
      return true;
    } catch {
      saveStatus = 'Save failed · export to keep progress';
      $('save-warning').textContent = saveStatus;
      $('save-warning').hidden = false;
      const status = document.getElementById('save-status');
      if (status) status.textContent = saveStatus;
      return false;
    }
  }
  /**
   * Show a temporary status message and replace its dismissal timer when a newer message
   * arrives.
   */
  function toast(message: string) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').style.opacity = '1';
    toastTimer = setTimeout(
      /** Hide the current toast after its display interval expires. */
      () => {
        $('toast').style.opacity = '0';
      },
      4000
    );
  }
  /**
   * Cancel autopilot, cruise and weapon targeting, optionally retaining a plotted route or
   * followed actor across a menu transition.
   */
  function clearOrder(cancelFollow = true) {
    if (cancelFollow) {
      game.followedActorId = null;
      game.routeDestinationId = null;
    }
    navigation.stop();
    game.world.cruise.cancel(game.world.player);
    navigation.targetId = undefined;
  }
  /**
   * Accept a player cruise toggle only during usable flight and explain when no course has
   * been set.
   */
  function toggleCruise() {
    if (paused || game.dockedAt || game.failed) return;
    if (!navigation.toggleCruise()) {
      toast('Set a course before engaging cruise.');
      return;
    }
    if (!navigation.cruiseRequested) game.world.cruise.cancel(game.world.player);
  }
  /**
   * Pause the world, release an older ship preview and replace the accessible dialog with a
   * new menu.
   */
  function modal(html: string) {
    preview?.dispose();
    preview = undefined;
    paused = true;
    clearOrder(false);
    $('modal').hidden = false;
    $('dialog').innerHTML = html;
    $('dialog').scrollTop = 0;
    const title = $('dialog').querySelector('h1');
    if (title) {
      title.id = 'modal-title';
      $('modal').setAttribute('aria-labelledby', 'modal-title');
    }
    setTimeout(
      /** Move keyboard focus into the newly opened dialog without scrolling the viewport. */
      () => $('dialog').querySelector('button')?.focus({ preventScroll: true }),
      0
    );
  }
  /**
   * Close the dialog, dispose preview graphics and return to flight while retaining
   * route/follow intent.
   */
  function resume() {
    preview?.dispose();
    preview = undefined;
    paused = false;
    $('modal').hidden = true;
    clearOrder(false);
  }
  /**
   * Replace the active scenario, reset view/navigation bookkeeping and persist the newly
   * selected session.
   */
  function setGame(next: GameSession) {
    transition.cancel();
    hyperspace.hide();
    game = next;
    sceneGeneration++;
    clearOrder(false);
    navigation.radius = game.definition.radius;
    failedShown = false;
    lowWarning = false;
    save();
  }
  /**
   * Dispatch player intent to the session, save accepted changes and optionally display the
   * returned result.
   */
  function execute(command: SessionCommand, notify = true) {
    const result = game.dispatch(command);
    if (result.ok) save();
    if (notify) toast(result.message);
    return result;
  }
  /** Choose a safe exterior station stop while preserving the existing ship/gateway interaction ranges. */
  function contactStandOff(contact: Contact, other = 85) {
    const station = contact.kind === 'station' ? game.stationById(contact.id) : undefined;
    return station
      ? stationApproachDistance(catalog.stationSizes[station.size], game.world.player.kind)
      : other;
  }
  /**
   * Select a contact and send autopilot to its approach point, optionally preserving a
   * previously plotted multi-system route.
   */
  function setCourse(selection: Selection, preserveRoute = false) {
    if (!preserveRoute) game.routeDestinationId = null;
    game.followedActorId = null;
    const result = execute({ type: 'select', target: selection }, false);
    if (!result.ok) return;
    const target = game.selected!;
    resume();
    navigation.radius = game.definition.radius;
    navigation.moveTo(
      approachPoint(
        game.world.player.position,
        target.position,
        contactStandOff(target, target.kind === 'ship' ? 220 : 85)
      )
    );
  }
  /**
   * Select the guidance system's suggested next contact without forcing the player to travel
   * there.
   */
  function selectSuggested() {
    const target = suggestedContact(game);
    if (target) game.dispatch({ type: 'select', target });
  }
  /**
   * Render services discovered on the current station and wire its undock, inspection and
   * menu actions.
   */
  function stationMenu() {
    const station = game.station;
    if (!station) {
      resume();
      return;
    }
    const available = services.available(station).filter(
      /** Include only station services for which this browser has a registered presentation. */
      (s) => serviceViews.has(s.kind)
    );
    modal(
      `<div class="eyebrow">${esc(game.definition.name)} / ${esc(catalog.stationSizes[station.size].description)}</div><h1>${esc(station.name)}</h1><div class="trade-wallet"><b>${game.captain.credits} cr</b><span>Cargo ${cargoUsed(game.world.player, catalog)} / ${definitions[game.world.player.kind].cargoCapacity}</span></div><p>${esc(guideText(game))}</p>${available
        .map(
          /** Render a station-service button using the registered capability title. */
          (s) =>
            `<button class="secondary" data-service="${esc(s.kind)}">${esc(services.handlers.get(s.kind)!.title)} →</button>`
        )
        .join(
          ''
        )}<button class="primary" id="undock">Undock</button><button class="secondary" id="station-menu">Captain’s menu</button>`
    );
    /** Open the selected station capability through its registered service view. */
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-service]')))
      button.onclick = () => serviceMenu(button.dataset.service!);
    /** Commit undocking, select the next suggested exit if appropriate and return to flight. */
    $('undock').onclick = () => {
      if (execute({ type: 'undock' }).ok) {
        if (
          !game.selection ||
          (game.selection.kind === 'station' && game.selection.id === station.id)
        )
          selectSuggested();
        resume();
      }
    };
    $('station-menu').onclick = pauseMenu;
  }
  /**
   * Render a registered station service and keep its result and scroll position visible
   * after each operation.
   */
  function serviceMenu(kind: string, message = '') {
    const service = serviceViews.get(kind),
      handler = services.handlers.get(kind);
    if (!service || !handler || !game.station) return;
    modal(
      `<div class="eyebrow">${esc(game.station.name)}</div><h1>${esc(handler.title)}</h1>${service.render(game)}<p class="service-notice" role="status">${esc(message)}</p><button class="primary" id="service-back">Back to station</button>`
    );
    service.bind(
      game,
      /**
       * Persist a service result and refresh its menu while retaining the reader's scroll
       * position.
       */
      (result) => {
        save();
        const scroll = $('dialog').scrollTop;
        serviceMenu(kind, result.message);
        $('dialog').scrollTop = scroll;
      }
    );
    $('service-back').onclick = stationMenu;
  }
  /**
   * Display the controlled hull, cargo and equipment with a disposable 3D inspection
   * preview.
   */
  function inspectShip() {
    const ship = game.world.player,
      state = game.world.defenceFor(ship);
    modal(
      `<div class="eyebrow">VESSEL / ${esc(ship.kind)}</div><h1>${esc(ship.name)}</h1><canvas id="ship-preview" aria-label="Drag to rotate your ship"></canvas><p class="preview-caption">Drag to rotate</p><div class="dossier-specs"><span>Culture<b>${esc(catalog.cultures[game.captain.cultureId].name)}</b></span><span>Hull design<b>${esc(catalog.shipDesigns[ship.designId!].name)}</b></span><span>Credits<b>${game.captain.credits} cr</b></span><span>Cargo space<b>${cargoUsed(ship, catalog)} / ${definitions[ship.kind].cargoCapacity}</b></span><span>Hull / engines<b>${Math.ceil(ship.hull)}% / ${Math.ceil(ship.engines)}%</b></span><span>Crew<b>${ship.crew}</b></span><span>PDC interceptions<b>${state.interceptions}</b></span>${Object.entries(
        ship.cargo
      )
        .filter(
          /** Omit empty cargo entries from the player-vessel dossier. */
          ([, q]) => q > 0
        )
        .map(
          /** Render each carried good and quantity as escaped inspection markup. */
          ([id, q]) => `<span>${esc(catalog.commodities[id]?.name ?? id)}<b>${q}</b></span>`
        )
        .join('')}</div><button class="primary" id="ship-close">Return</button>`
    );
    try {
      preview = new ShipPreview($<HTMLCanvasElement>('ship-preview'), ship, catalog.shipDesigns);
    } catch {
      $('ship-preview').hidden = true;
    }
    /** Return from hull inspection to station services when docked, otherwise back to flight. */
    $('ship-close').onclick = () => (game.dockedAt ? stationMenu() : resume());
  }
  /**
   * Toggle optional synthesized effects and resume the audio context from this user gesture
   * when sound is enabled.
   */
  function toggleSound() {
    sound = !sound;
    if (sound) {
      audio ??= new AudioContext();
      void audio.resume();
    }
    const button = document.getElementById('sound');
    if (button) button.textContent = sound ? 'On' : 'Off';
  }
  /**
   * Save the current scenario before loading the other independent slot, retaining
   * unreadable data rather than overwriting it.
   */
  async function switchMode(raid: boolean) {
    if (!(await save())) {
      toast('Export or restore your save before switching scenarios.');
      return;
    }
    const slot = raid ? 'raid' : 'trading';
    try {
      const raw = await saves.read(slot),
        next = raw
          ? loadSession(raw, catalog, services, activities)
          : raid
            ? startRaid(catalog, services, activities)
            : startFreeRoam(catalog, services, activities);
      setGame(next);
      game.dockedAt ? stationMenu() : pauseMenu();
    } catch {
      toast('That saved scenario could not be read. It has been preserved.');
    }
  }
  /**
   * Render the captain's menu, including scenario switching, saves, import/export and
   * restart controls.
   */
  function pauseMenu() {
    modal(
      `<div class="eyebrow">BLACKWAKE / ${esc(game.definition.name)}</div><h1>Holding position.</h1><p>${esc(guideText(game))}</p><button class="primary" id="resume">${game.dockedAt ? 'Station services' : 'Resume flight'}</button><div class="menu-grid"><button class="secondary" id="menu-ship">Ship & cargo</button><button class="secondary" id="menu-map">System map</button><button class="secondary" id="menu-universe">Universe map</button><button class="secondary" id="menu-weapons">Weapons</button><button class="secondary" id="menu-camera">Camera: ${view.cameraMode === 'chase' ? '3D chase' : 'Tactical'}</button><button class="secondary" id="menu-help">Flight manual</button><button class="secondary" id="menu-mode">${isRaid() ? 'Free roam' : 'Raid test'}</button></div><div class="menu-row"><span>Sound</span><button id="sound">${sound ? 'On' : 'Off'}</button></div><details class="save-options"><summary>Save & restart options ▾</summary><p id="save-status">${esc(saves.store.label)} · ${esc(saveStatus)}</p><p class="menu-notice">Saves belong to this browser and site address. Export a backup before clearing browser data.</p><button class="secondary" id="export">Export save</button><button class="secondary" id="import">Import save</button><button class="secondary danger" id="restart">Restart ${isRaid() ? 'raid' : 'free roam'}</button><input id="save-file" type="file" accept="application/json" hidden></details>`
    );
    save();
    /** Return to station services or live flight according to current docking state. */
    $('resume').onclick = () => (game.dockedAt ? stationMenu() : resume());
    $('menu-ship').onclick = inspectShip;
    $('menu-map').onclick = systemMap;
    /** Open route planning from the captain's menu without issuing a jump. */
    $('menu-universe').onclick = () => universeMap();
    $('menu-weapons').onclick = weaponsMenu;
    /** Compare the 3D chase presentation with the retained tactical projection. */
    $('menu-camera').onclick = () => {
      view.setCameraMode(view.cameraMode === 'chase' ? 'tactical' : 'chase');
      pauseMenu();
    };
    $('menu-help').onclick = manual;
    /** Save and switch to the opposite optional scenario's independent slot. */
    $('menu-mode').onclick = () => switchMode(!isRaid());
    $('sound').onclick = toggleSound;
    /**
     * Start the current scenario afresh and explicitly allow its slot to replace an unreadable
     * older save.
     */
    $('restart').onclick = () => {
      blockedSlots.delete(isRaid() ? 'raid' : 'trading');
      setGame(
        isRaid()
          ? startRaid(catalog, services, activities)
          : startFreeRoam(catalog, services, activities)
      );
      game.dockedAt ? stationMenu() : resume();
    };
    /**
     * Download the current serialized session as a JSON backup without sending it to an
     * external service.
     */
    $('export').onclick = () => {
      const a = document.createElement('a'),
        url = URL.createObjectURL(new Blob([game.save()], { type: 'application/json' }));
      a.href = url;
      a.download = 'blackwake-voyage.json';
      a.click();
      setTimeout(
        /** Release the temporary download URL after the browser has started exporting the save. */
        () => URL.revokeObjectURL(url),
        1000
      );
    };
    /** Open the hidden local-file picker for a player-supplied JSON save. */
    $('import').onclick = () => $('save-file').click();
    /**
     * Validate the selected save before switching sessions, preserving current progress if the
     * imported file cannot be loaded.
     */
    $<HTMLInputElement>('save-file').onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const next = loadSession(await file.text(), catalog, services, activities);
        blockedSlots.delete(next.activity?.type === 'raid' ? 'raid' : 'trading');
        setGame(next);
        pauseMenu();
        toast('Voyage restored.');
      } catch {
        const note = document.createElement('p');
        note.className = 'service-notice';
        note.textContent = 'This save could not be read. Your voyage is unchanged.';
        $('dialog').append(note);
      }
    };
  }
  /**
   * Expose engine/hull targeting and automatic broadside preferences while leaving PDC
   * defence automatic.
   */
  function weaponsMenu() {
    modal(
      `<div class="eyebrow">WEAPONS</div><h1>Battery orders.</h1><p>Automatic broadsides engage hostile contacts. Neutral traffic is left alone until you choose to attack.</p><button class="secondary" id="weapon-mode">Target: ${game.world.disable ? 'Engines' : 'Hull'}</button><button class="secondary" id="auto-fire">Automatic fire: ${navigation.autoFire ? 'On' : 'Off'}</button><p class="menu-notice">PDCs defend automatically. Hull targeting risks destroying a prize.</p><button class="primary" id="weapon-back">Return</button>`
    );
    /**
     * Switch broadside damage preference between engine disabling and hull damage and update
     * the menu label.
     */
    $('weapon-mode').onclick = () => {
      game.world.disable = !game.world.disable;
      $('weapon-mode').textContent = `Target: ${game.world.disable ? 'Engines' : 'Hull'}`;
    };
    /** Toggle automatic broadsides and update the menu label without affecting point defence. */
    $('auto-fire').onclick = () => {
      navigation.autoFire = !navigation.autoFire;
      $('auto-fire').textContent = `Automatic fire: ${navigation.autoFire ? 'On' : 'Off'}`;
    };
    /** Return from weapon orders to the station or live flight as appropriate. */
    $('weapon-back').onclick = () => (game.dockedAt ? stationMenu() : resume());
  }
  /** Explain the current flight, trade, jump and piracy controls in a paused help dialog. */
  function manual() {
    modal(
      `<div class="eyebrow">FLIGHT MANUAL</div><h1>Your next opportunity.</h1><div class="instruction"><span>01</span><div><b>Choose your own course.</b><p>Trade, explore, or raid ships from either culture. For a trading opportunity, Haven sells rations for 12 cr. Relay buys them for 22 cr. Machine parts make the profitable return cargo: 26 cr at Relay, 45 cr at Haven.</p></div></div><div class="instruction"><span>02</span><div><b>Fly and jump.</b><p>Undock, select an outer hyperspace gateway, then tap Cruise (C) for 4× travel speed. It spools briefly and slows automatically on approach. Stop cancels cruise. Nearby hostiles block it; broadsides hold while spooling or cruising, and PDCs stay active. Choose a connected destination in the jump menu when close and slow enough. A four-second hyperspace journey prepares the next system; loading delays never add extra journey time. Failed arrival can be retried or cancelled. Use the universe map to plot longer routes by region.</p></div></div><div class="instruction"><span>03</span><div><b>Make your own route.</b><p>Stations, traffic and landmarks can be selected on the map or in space. Free roam has no required mission. Passenger services and leisure liners share the lanes. Police patrol Kepler Drift and Vesper and respond to nearby aggression. Ashen Reach is unpoliced. Use Menu → Camera (V) to compare the 3D chase and tactical views. Flight remains on the navigation plane. Tap a ship in flight, then Attack to begin piracy. Disable its engines, approach and board to raid cargo or take the ship.</p></div></div><button class="primary" id="manual-back">Return</button>`
    );
    /** Leave the help dialog for station services or live flight. */
    $('manual-back').onclick = () => (game.dockedAt ? stationMenu() : resume());
  }
  /** Draw the local sector chart and wire contact selection or point-to-point course setting. */
  function systemMap() {
    const contacts = game.contacts(),
      radius = game.definition.radius;
    modal(
      `<div class="eyebrow">LOCAL SYSTEM</div><h1>${esc(game.definition.name)}</h1><p class="route-description">${esc(systemEnvironment(catalog, game.definition).name)} · Radius ${game.definition.radius.toLocaleString()} m</p><p>Tap a contact to select it, or empty space to set a course.</p><canvas id="sector-map" width="600" height="540" aria-label="System map"></canvas><div class="contact-list">${contacts
        .map(
          /** Render local chart contacts with their role or object type for selection. */
          (c) =>
            `<button class="secondary" data-contact="${esc(c.id)}"><span>${esc(c.name)}</span><small>${esc(c.kind === 'ship' && game.traffic.get(c.id) ? game.traffic.describe(game.traffic.get(c.id)!).title : c.kind)}</small></button>`
        )
        .join(
          ''
        )}</div><button class="primary" id="chart-universe">Universe map</button><button class="secondary" id="map-back">Return</button>`
    );
    const canvas = $<HTMLCanvasElement>('sector-map'),
      ctx = canvas.getContext('2d')!,
      width = canvas.width,
      height = canvas.height,
      scale = Math.min(width, height) / (radius * 2.2),
      /**
       * Convert local system coordinates to the chart canvas, accounting for its world radius
       * and inverted screen Y axis.
       */
      point = (p: { x: number; y: number }) => ({
        x: width / 2 + p.x * scale,
        y: height / 2 - p.y * scale
      });
    ctx.strokeStyle = '#37536666';
    for (const r of [radius * 0.3, radius * 0.6, radius]) {
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = '17px sans-serif';
    ctx.textAlign = 'center';
    for (const c of contacts) {
      const p = point(c.position);
      ctx.fillStyle =
        c.kind === 'gate'
          ? '#79bcd4'
          : c.kind === 'station'
            ? '#a0cbbb'
            : c.kind === 'ship'
              ? '#deb46e'
              : '#5d7b8c';
      ctx.beginPath();
      ctx.arc(p.x, p.y, c.kind === 'landmark' ? 13 : 5, 0, Math.PI * 2);
      ctx.fill();
      if (c.kind !== 'ship' || c.id === game.selection?.id) ctx.fillText(c.name, p.x, p.y - 15);
    }
    const p = point(game.world.player.position);
    ctx.fillStyle = '#d0f4e5';
    ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
    /**
     * Resolve this chart-list contact and apply the same selection flow as tapping it on the
     * map.
     */
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-contact]')))
      button.onclick = () => {
        const contact = contacts.find(
          /** Resolve a chart-list button back to its authored or live contact. */
          (c) => c.id === button.dataset.contact
        )!;
        chooseContact(contact);
      };
    /**
     * Convert a local-chart tap into contact selection or a world-space course while
     * respecting docking and primary-pointer rules.
     */
    canvas.onpointerdown = (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      const r = canvas.getBoundingClientRect(),
        x = ((e.clientX - r.left) / r.width) * width,
        y = ((e.clientY - r.top) / r.height) * height,
        contact = contacts.find(
          /** Hit-test a local-map tap against projected contact markers. */
          (c) => {
            const p = point(c.position);
            return Math.hypot(p.x - x, p.y - y) < 23;
          }
        );
      if (contact) {
        chooseContact(contact);
        return;
      }
      if (game.dockedAt) {
        toast('Undock before setting a flight course.');
        return;
      }
      game.followedActorId = null;
      game.routeDestinationId = null;
      resume();
      navigation.radius = radius;
      navigation.moveTo({ x: (x - width / 2) / scale, y: (height / 2 - y) / scale, z: 0 });
    };
    /** Open the broader route planner from the local sector map. */
    $('chart-universe').onclick = () => universeMap();
    /** Return from the sector chart to station services or live flight. */
    $('map-back').onclick = () => (game.dockedAt ? stationMenu() : resume());
  }
  /**
   * Apply a chart selection, routing stations/exits to autopilot and ships/landmarks to
   * contact inspection.
   */
  function chooseContact(contact: Contact) {
    execute({ type: 'select', target: { kind: contact.kind, id: contact.id } }, false);
    if (game.dockedAt) {
      stationMenu();
      return;
    }
    if (contact.kind === 'station' || contact.kind === 'gate')
      setCourse({ kind: contact.kind, id: contact.id });
    else contactMenu();
  }
  /**
   * Offer only physically eligible direct connections from the selected gateway,
   * separately from universe route planning.
   */
  function jumpMenu(gateId: string) {
    const choices = jumpDestinations(game, gateId);
    modal(
      `<div class="eyebrow">HYPERSPACE GATEWAY / ${esc(game.definition.name)}</div><h1>Next system.</h1><p>Only connections from this gateway are available.</p>${choices
        .map(
          /** Render one immediate jump destination with its region and system culture. */
          ({ hop, system }) =>
            `<button class="primary" data-jump="${esc(hop.connectionId)}">Jump to ${esc(system.name)}</button><p class="route-description">${esc(regionName(game, system.id))} · ${esc(catalog.cultures[system.cultureId].name)}</p>`
        )
        .join(
          ''
        )}${!choices.length ? '<p>No jump destinations are currently available. Reach the gateway and slow down.</p>' : ''}<button class="secondary" id="jump-universe">Plan a route on the universe map</button><button class="secondary" id="jump-back">Return to flight</button>`
    );
    /**
     * Execute this direct jump and continue the next plotted exit course when an itinerary
     * remains.
     */
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-jump]')))
      button.onclick = () => {
        beginJump(button.dataset.jump!);
      };
    /**
     * Open universe route planning without treating a distant itinerary as an immediate jump
     * destination.
     */
    $('jump-universe').onclick = () => universeMap();
    $('jump-back').onclick = resume;
  }
  /**
   * Group destination choices by region and preview one itinerary; its action plots a course
   * without executing a jump.
   */
  function universeMap(destinationId?: string) {
    const selectedId = destinationId ?? game.routeDestinationId ?? '';
    const selected = catalog.systems[selectedId];
    const route =
      selected && selected.id !== game.systemId
        ? game.routes.find(game.systemId, selected.id)
        : null;
    const groups = new Map<string, (typeof game.definition)[]>();
    for (const system of Object.values(catalog.systems)) {
      if (system.id === game.systemId) continue;
      const group = regionName(game, system.id);
      groups.set(group, [...(groups.get(group) ?? []), system]);
    }
    modal(
      `<div class="eyebrow">UNIVERSE MAP</div><h1>Chart a course.</h1><p>${esc(game.definition.name)} · ${esc(regionName(game))}</p><label class="route-picker" for="route-destination">Destination<select id="route-destination"><option value="">Choose a system</option>${Array.from(
        groups
      )
        .map(
          /**
           * Render region groups in the destination picker without creating a separate jump action
           * for each remote system.
           */
          ([region, systems]) =>
            `<optgroup label="${esc(region)}">${systems
              .map(
                /** Render a named system option and retain the currently previewed destination. */
                (system) =>
                  `<option value="${esc(system.id)}" ${system.id === selectedId ? 'selected' : ''}>${esc(system.name)}</option>`
              )
              .join('')}</optgroup>`
        )
        .join('')}</select></label>${
        selected
          ? `<p>${esc(regionName(game, selected.id))} · ${esc(catalog.cultures[selected.cultureId].name)}</p><p class="route-description">${esc(systemEnvironment(catalog, selected).name)} · Radius ${selected.radius.toLocaleString()} m</p>${
              route
                ? `<p class="route-description">${[
                    game.systemId,
                    ...route.hops.map(
                      /** Collect the successive destination systems along the previewed route. */
                      (h) => h.toSystemId
                    )
                  ]
                    .map(
                      /** Resolve and escape each system name for the displayed route sequence. */
                      (id) => esc(catalog.systems[id].name)
                    )
                    .join(
                      ' → '
                    )}</p><button class="primary" id="plot-route">Plot route · ${route.hops.length} jump${route.hops.length === 1 ? '' : 's'}</button>`
                : '<p>No available route to this system.</p>'
            }`
          : '<p>Select a destination to preview its route.</p>'
      }${universeChart(game, route ? selectedId : null)}<p class="dialog-footer">${game.dockedAt ? 'Plot a route, then undock.' : 'Route planning sets a course. Jump from each local exit when you arrive.'}</p><button class="secondary" id="universe-back">Return</button>`
    );
    /** Preview the newly selected destination while retaining the dialog's scroll position. */
    $<HTMLSelectElement>('route-destination').onchange = (event) => {
      const scroll = $('dialog').scrollTop;
      universeMap((event.target as HTMLSelectElement).value);
      $('dialog').scrollTop = scroll;
    };
    if (route)
      /**
       * Commit the previewed itinerary and guide to its first exit, requiring explicit local
       * jumps later.
       */
      $('plot-route').onclick = () => {
        if (!execute({ type: 'plot-route', systemId: selectedId }).ok) return;
        if (game.dockedAt) {
          stationMenu();
          toast('Route plotted. Undock when ready.');
        } else setCourse({ kind: 'gate', id: route.hops[0].gateId }, true);
      };
    /**
     * Leave the route planner for station services or live flight without committing an
     * unplotted preview.
     */
    $('universe-back').onclick = () => (game.dockedAt ? stationMenu() : resume());
  }
  /**
   * Inspect a selected vessel or landmark, exposing follow, approach and attack through
   * validated session commands.
   */
  function contactMenu() {
    const contact = game.selected;
    if (!contact) {
      resume();
      return;
    }
    const target =
        contact.kind === 'ship'
          ? game.world.ships.find(
              /** Resolve the selected ship before showing its contact dossier. */
              (s) => s.id === contact.id
            )
          : undefined,
      journey = target ? game.traffic.get(target.id) : undefined;
    modal(
      `<div class="eyebrow">${esc(contact.kind)}</div><h1>${esc(contact.name)}</h1>${
        target
          ? `<canvas id="ship-preview" aria-label="Drag to rotate this ship"></canvas><p class="preview-caption">Drag to rotate</p><p>${game.world.relations.isHostile(game.world.player, target) ? 'Hostile contact' : 'Neutral traffic'} · Hull ${Math.ceil(target.hull)}% · Engines ${Math.ceil(target.engines)}%</p><div class="dossier-specs"><span>Crew<b>${target.crew}</b></span><span>PDC interceptions<b>${game.world.defenceFor(target).interceptions}</b></span></div>${journey ? `<p>${esc(game.traffic.describe(journey).title)} · ${esc(game.traffic.activity(journey))}</p><p>${esc(catalog.cultures[journey.cultureId].name)} culture · ${esc(catalog.shipDesigns[target.designId!].name)}</p><p>${esc(game.traffic.describe(journey).purpose)}</p><p>${esc(game.traffic.describe(journey).manifest)}</p><button class="secondary" id="follow-contact">Follow this ship</button>` : ''}<button class="secondary" id="approach-contact">Approach contact</button><button class="secondary danger" id="attack-contact">Attack this ship</button>`
          : `<p>${esc(
              game.definition.landmarks.find(
                /** Resolve the selected landmark's authored description. */
                (l) => l.id === contact.id
              )?.description ??
                'A central landmark in this system. Stations and hyperspace gateways are separate contacts on your map.'
            )}</p>`
      }<button class="primary" id="contact-back">Return to flight</button>`
    );
    if (journey)
      /**
       * Track this actor by stable ID, cancel an unrelated route and explain that its system
       * jumps still require player action.
       */
      $('follow-contact').onclick = () => {
        game.routeDestinationId = null;
        game.followedActorId = journey.ship.id;
        resume();
        save();
        toast('Following this ship. Jump manually if it leaves the system.');
      };
    if (target) {
      try {
        preview = new ShipPreview(
          $<HTMLCanvasElement>('ship-preview'),
          target,
          catalog.shipDesigns
        );
      } catch {
        $('ship-preview').hidden = true;
      }
      /**
       * Set an approach course to the selected vessel rather than change its physical position
       * directly.
       */
      $('approach-contact').onclick = () => setCourse({ kind: 'ship', id: target.id });
      /** Use the same explicit attack flow available from the flight HUD. */
      $('attack-contact').onclick = () => {
        attackShip(target.id);
      };
    }
    $('contact-back').onclick = resume;
  }
  /**
   * Declare the selected attack, cancel travel orders and enable automatic broadsides
   * against that chosen hostile.
   */
  function attackShip(shipId: string) {
    if (!execute({ type: 'attack', shipId }).ok) return;
    clearOrder();
    navigation.autoFire = true;
    if (paused) resume();
    navigation.targetId = shipId;
  }
  /**
   * Preview fitting cargo and hull-capture consequences, then dispatch the player's chosen
   * boarding outcome.
   */
  function boardMenu(shipId: string) {
    const target = game.world.ships.find(
      /** Resolve a local target before offering cargo plunder or hull capture. */
      (s) => s.id === shipId
    );
    if (!target || !game.canBoard(shipId)) return;
    const player = game.world.player;
    const plan = cargoTransferPlan(target, player, catalog);
    const manifest =
      Object.entries(target.cargo)
        .filter(
          /** Include only goods actually carried by the disabled target. */
          ([, quantity]) => quantity > 0
        )
        .map(
          /** Describe the target's remaining cargo using current commodity names. */
          ([id, quantity]) => `${quantity} ${catalog.commodities[id].name.toLowerCase()}`
        )
        .join(' · ') || 'No cargo aboard';
    const canCapture = player.crew > 2;
    modal(
      `<div class="eyebrow">BOARDING / ${esc(target.name)}</div><h1>Choose your prize.</h1><p>${esc(manifest)}</p><p>Your hold: ${cargoUsed(player, catalog)} / ${definitions[player.kind].cargoCapacity}. Excess cargo stays aboard its current hull.</p><button class="choice" id="raid-cargo" ${!plan.units ? 'disabled' : ''}><b>Raid cargo</b><span>${plan.units ? `Transfer ${plan.units} cargo units and keep ${esc(player.name)}. The target remains disabled.` : manifest === 'No cargo aboard' ? 'No cargo to take.' : 'Your hold has no room for this cargo.'}</span></button><button class="choice" id="take-ship" ${!canCapture ? 'disabled' : ''}><b>Take ship</b><span>${canCapture ? `Command ${esc(target.name)} with its cargo. Two crew escort the prisoners; your previous hull is left as salvage.` : 'At least three crew are needed to take another ship.'}</span></button><button class="secondary" id="disengage">Disengage</button>`
    );
    /**
     * Commit the cargo-raid or hull-capture option represented by this boarding button and
     * resume on success.
     */
    for (const [id, outcome] of [
      ['raid-cargo', 'cargo'],
      ['take-ship', 'capture']
    ] as const)
      $(id).onclick = () => {
        if (execute({ type: 'board', shipId, outcome }).ok) resume();
      };
    $('disengage').onclick = resume;
  }
  /**
   * Execute the single action currently offered by the HUD, using the same domain
   * eligibility as the menus.
   */
  function contextAction() {
    if (paused) return;
    const hud = sessionHud(game),
      contact = hud.contact;
    if (!contact) return;
    if (hud.action === 'station') {
      stationMenu();
      return;
    }
    if (hud.action === 'dock') {
      if (execute({ type: 'dock', stationId: contact.id }).ok) stationMenu();
      return;
    }
    if (hud.action === 'jump-map') {
      jumpMenu(contact.id);
      return;
    }
    if (hud.action === 'attack') {
      attackShip(contact.id);
      return;
    }
    if (hud.action === 'board') {
      boardMenu(contact.id);
      return;
    }
    if (hud.action === 'contact') {
      contactMenu();
      return;
    }
    if (hud.action === 'brake') {
      clearOrder();
      return;
    }
    if (hud.action === 'approach') {
      navigation.radius = game.definition.radius;
      navigation.moveTo(
        approachPoint(game.world.player.position, contact.position, contactStandOff(contact))
      );
    }
  }
  /** Show restart and alternate-scenario choices after the controlled hull is destroyed. */
  function failure() {
    modal(
      `<div class="eyebrow">SHIP LOST</div><h1>Lost to the Reach.</h1><p>Start a new game, or return to your other saved scenario.</p><button class="primary" id="retry">Restart ${isRaid() ? 'raid' : 'free roam'}</button><button class="secondary" id="other-mode">${isRaid() ? 'Free roam' : 'Raid test'}</button>`
    );
    /** Create a fresh instance of the current scenario after a hull loss. */
    $('retry').onclick = () => {
      setGame(
        isRaid()
          ? startRaid(catalog, services, activities)
          : startFreeRoam(catalog, services, activities)
      );
      game.dockedAt ? stationMenu() : resume();
    };
    /** Save and load the other scenario instead of restarting the lost hull's scenario. */
    $('other-mode').onclick = () => switchMode(!isRaid());
  }
  /**
   * Open the captain's menu or resume the current scene according to the current pause
   * state.
   */
  function togglePause() {
    if (transition.active) return;
    if (game.failed) {
      failure();
      return;
    }
    if (paused) resume();
    else pauseMenu();
  }
  $('pause').onclick = togglePause;
  $('inspect').onclick = inspectShip;
  /** Open the universe route planner from the current-system badge. */
  $('system-chart').onclick = () => universeMap();
  $('minimap-button').onclick = systemMap;
  $('target-title').onclick = contactMenu;
  $('interact').onclick = contextAction;
  /** Cancel navigation and cruise so the flight controller brakes the ship. */
  $('brake').onclick = () => clearOrder();
  $('cruise').onclick = toggleCruise;
  /**
   * Toggle engine or hull targeting directly in combat and explain the destructive
   * hull-damage option.
   */
  $('mode').onclick = () => {
    game.world.disable = !game.world.disable;
    toast(
      game.world.disable ? 'Targeting engines.' : 'Targeting hull. This may destroy the prize.'
    );
  };
  /**
   * Set a course to the selected offscreen contact when the player taps its directional
   * guide.
   */
  $('edge-guide').onclick = () => {
    const target = game.selected;
    if (target && !game.dockedAt) setCourse({ kind: target.kind, id: target.id });
  };
  /**
   * Select a tapped contact without attacking it, or issue a world-space destination when
   * the tap lands in open space.
   */
  $<HTMLCanvasElement>('space').onpointerdown = (e) => {
    if (paused || e.button !== 0 || !e.isPrimary) return;
    if (game.dockedAt) {
      stationMenu();
      return;
    }
    const contact = game
      .contacts()
      .filter(
        /**
         * Leave landmark selection to the map so ordinary space taps prefer stations, exits and
         * ships.
         */
        (c) => c.kind !== 'landmark'
      )
      .find(
        /**
         * Hit-test a flight tap in client pixels against each selectable contact's projected
         * position.
         */
        (c) => {
          const p = view.project(c.position.x, c.position.y);
          const station = c.kind === 'station' ? game.stationById(c.id) : undefined;
          const hitRadius = station
            ? Math.max(
                35,
                view.screenRadius(
                  c.position,
                  stationFootprintRadius * catalog.stationSizes[station.size].scale
                )
              )
            : c.kind === 'ship'
              ? 24
              : 35;
          return p.visible && Math.hypot(p.x - e.clientX, p.y - e.clientY) < hitRadius;
        }
      );
    if (contact) {
      if (game.followedActorId !== contact.id) game.followedActorId = null;
      execute({ type: 'select', target: { kind: contact.kind, id: contact.id } }, false);
      return;
    }
    const point = view.worldPoint(e.clientX, e.clientY);
    if (!point) {
      toast('Tap below the horizon to set a course.');
      return;
    }
    game.followedActorId = null;
    game.routeDestinationId = null;
    navigation.radius = game.definition.radius;
    navigation.moveTo(point);
  };
  window.addEventListener(
    'keydown',
    /**
     * Handle keyboard navigation and flight shortcuts, including focus trapping while a dialog
     * is open.
     */
    (e) => {
      if (paused && e.code === 'Tab') {
        const items = Array.from(
          $('dialog').querySelectorAll<HTMLElement>(
            'button:not([disabled]),summary,input:not([type=file]),[tabindex="0"]'
          )
        ).filter(
          /** Include only visible focusable controls in the dialog's keyboard tab loop. */
          (el) => el.getClientRects().length
        );
        if (e.shiftKey && document.activeElement === items[0]) {
          e.preventDefault();
          items.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
          e.preventDefault();
          items[0]?.focus();
        }
        return;
      }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && !paused)
        e.preventDefault();
      if (transition.active) {
        if (e.code === 'Escape' && !e.repeat) {
          e.preventDefault();
          transition.cancel();
          hyperspace.hide();
          resume();
          save();
        }
        return;
      }
      if (e.code === 'Escape' && !e.repeat) {
        togglePause();
        return;
      }
      if (paused || e.repeat) return;
      if (e.code === 'KeyS' || e.code === 'Space') clearOrder();
      if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && !e.altKey) toggleCruise();
      if (e.code === 'KeyE') contextAction();
      if (e.code === 'KeyV') {
        view.setCameraMode(view.cameraMode === 'chase' ? 'tactical' : 'chase');
        toast(view.cameraMode === 'chase' ? '3D chase camera.' : 'Tactical camera.');
      }
    }
  );
  window.addEventListener(
    'blur',
    /** Pause when the game window loses focus so unattended flight does not continue. */
    () => {
      if (!paused && !transition.active) pauseMenu();
    }
  );
  document.addEventListener(
    'visibilitychange',
    /**
     * Save and pause when the browser hides the page, keeping background-tab time out of
     * active physics.
     */
    () => {
      if (document.hidden) {
        save();
        if (!paused && !transition.active) pauseMenu();
      }
    }
  );
  /**
   * Generate a short optional audio effect; this is synthesized sound rather than ship radio
   * speech.
   */
  function tone(freq: number, duration: number, volume: number) {
    if (!sound || !audio) return;
    const osc = audio.createOscillator(),
      gain = audio.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.3, audio.currentTime + duration);
    gain.gain.setValueAtTime(volume, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duration);
  }
  /**
   * Build the renderer's current-system view data, keeping graphics content separate from
   * live simulation ownership.
   */
  function sceneContent() {
    const hud = sessionHud(game);
    return {
      key: `${sceneGeneration}:${game.systemId}`,
      definition: game.definition,
      theme: catalog.themes[game.definition.themeId],
      environment: systemEnvironment(catalog, game.definition),
      sizes: catalog.stationSizes,
      focus: hud.contact?.position,
      combatTargetId: hud.combat ? hud.contact?.id : undefined,
      dockedAt: game.dockedAt
    };
  }
  let uiTime = 0;
  /**
   * Refresh HUD text, meters, controls and contact guidance at a throttled rate using
   * current session state.
   */
  function updateUI(dt: number) {
    uiTime += dt;
    if (uiTime < 0.08) return;
    uiTime = 0;
    const world = game.world,
      player = world.player,
      hud = sessionHud(game),
      target = hud.contact;
    drawMinimap($<HTMLCanvasElement>('minimap'), world, navigation.destination, game.contacts());
    $('system-chart').textContent = `${game.definition.name} ↗`;
    $('player-hull').style.width = `${player.hull}%`;
    $('player-hull-text').textContent = `${Math.ceil(player.hull)}%`;
    $('inspect').classList.toggle('critical', player.hull < 30);
    $('hull-warning').hidden = player.hull >= 30;
    $('objective').textContent = followTarget(game)?.message ?? hud.objective;
    const ship =
      target?.kind === 'ship'
        ? world.ships.find(
            /** Resolve the selected ship's current health for HUD meters and contact status. */
            (s) => s.id === target.id
          )
        : undefined;
    $('target-info').hidden = !ship || !!game.dockedAt;
    for (const meter of Array.from($('target-info').querySelectorAll<HTMLElement>('.target-meter')))
      meter.hidden = !hud.combat && ship?.engines !== 0;
    $('combat-controls').hidden = !hud.combat;
    $('target-title').textContent = target?.name ?? 'Contact';
    $('distance').textContent = target
      ? `${Math.round(distance(player.position, target.position))} m`
      : '';
    for (const [id, value] of [
      ['enemy-hull', ship?.hull ?? 0],
      ['enemy-engine', ship?.engines ?? 0]
    ] as const) {
      $(id).style.width = `${value}%`;
      $(id + '-text').textContent = `${Math.ceil(value)}%`;
    }
    $('mode').textContent = `Target: ${world.disable ? 'Engines' : 'Hull'} ⌄`;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 'port' : 'starboard';
      $(side + '-reload').style.width =
        `${100 * (1 - player.reload[i] / definitions[player.kind].reload)}%`;
      $(side + '-ready').textContent =
        player.reload[i] <= 0 ? 'Ready' : `${player.reload[i].toFixed(1)}s`;
    }
    $('interact').hidden = hud.action === 'none';
    $('interact').textContent = hud.label;
    $('interact').classList.toggle('danger', hud.action === 'attack');
    $('action-hint').textContent = hud.hint;
    $('brake').hidden =
      game.dockedAt !== null ||
      (!game.followedActorId &&
        !navigation.destination &&
        Math.hypot(player.velocity.x, player.velocity.y) < 5);
    const drive = world.cruise.forShip(player),
      approaching =
        !!navigation.destination &&
        distance(player.position, navigation.destination) <= cruiseApproachRange(player),
      tuning = definitions[player.kind].cruise;
    const cruiseLabel = !navigation.cruiseRequested
      ? 'Cruise'
      : approaching
        ? 'Approach'
        : drive.phase === 'active'
          ? `Cruise ${tuning.multiplier}×`
          : drive.phase === 'charging'
            ? `Spooling ${(tuning.spoolSeconds - drive.charge).toFixed(1)}s`
            : drive.reason === 'Aligning with course'
              ? 'Aligning'
              : 'Cruise locked';
    const cruiseButton = $<HTMLButtonElement>('cruise');
    cruiseButton.hidden = game.dockedAt !== null;
    cruiseButton.disabled = paused || game.failed || !navigation.destination || player.engines <= 0;
    cruiseButton.setAttribute('aria-pressed', String(navigation.cruiseRequested));
    cruiseButton.classList.toggle('active', drive.phase === 'active' && navigation.cruiseRequested);
    cruiseButton.classList.toggle(
      'locked',
      drive.phase === 'blocked' && navigation.cruiseRequested && !approaching
    );
    cruiseButton.title = navigation.cruiseRequested
      ? approaching
        ? 'Cruise slows automatically near your destination.'
        : (drive.reason ?? 'Cruise engaged. Tap or press C to disengage.')
      : 'Set a course, then engage 4× cruise. C toggles cruise.';
    $('cruise-label').textContent = cruiseLabel;
    const orderText = game.followedActorId
      ? 'Following'
      : navigation.destination
        ? `${Math.round(distance(player.position, navigation.destination))} m to go`
        : '';
    const lockReason =
      navigation.cruiseRequested &&
      drive.phase === 'blocked' &&
      !approaching &&
      drive.reason !== 'Aligning with course'
        ? drive.reason
        : null;
    $('course-status').textContent = [
      orderText,
      Math.hypot(player.velocity.x, player.velocity.y) > 5
        ? `${Math.round(Math.hypot(player.velocity.x, player.velocity.y))} m/s`
        : '',
      lockReason
    ]
      .filter(Boolean)
      .join(' · ');
    $('enemy-label').hidden = true;
    $('edge-guide').hidden = true;
    if (target && !game.dockedAt) {
      const point = view.project(target.position.x, target.position.y),
        short = innerHeight < 550 && innerWidth > 550,
        top = short ? 125 : hud.combat ? 230 : 145,
        bottom = short ? 125 : 170,
        guide = edgeGuide(point, innerWidth, innerHeight, top, bottom);
      if (guide) {
        $('edge-guide').hidden = false;
        $('edge-guide').style.left = `${guide.x}px`;
        const mini = $('minimap-button').getBoundingClientRect(),
          overlap =
            guide.x + 74 > mini.left &&
            guide.x - 74 < mini.right &&
            guide.y + 24 > mini.top &&
            guide.y - 24 < mini.bottom;
        $('edge-guide').style.top = `${overlap ? Math.max(top, mini.top - 30) : guide.y}px`;
        $('edge-arrow').style.transform = `rotate(${guide.angle}rad)`;
        $('edge-text').textContent =
          `${target.name} · ${Math.round(distance(player.position, target.position))} m`;
      } else {
        $('enemy-label').hidden = false;
        $('enemy-label').style.transform =
          `translate(${Math.max(85, Math.min(innerWidth - 85, point.x))}px,${point.y + 45}px) translateX(-50%)`;
        $('contact-name').textContent = target.name;
        $('enemy-hint').textContent = ship
          ? ship.engines === 0
            ? game.canBoard(ship.id)
              ? 'Ready to board'
              : 'Disabled'
            : world.relations.isHostile(player, ship)
              ? 'Hostile'
              : game.traffic.get(ship.id)
                ? game.traffic.describe(game.traffic.get(ship.id)!).title
                : 'Neutral'
          : target.kind === 'gate'
            ? 'Hyperspace gateway'
            : target.kind;
      }
    }
  }
  let previous = performance.now(),
    acc = 0,
    followClock = 0;
  const radioNodes = new Map<string, HTMLElement>();
  /**
   * Anchor text bubbles to their actual speakers and suppress placements overlapping HUD,
   * minimap or other bubbles.
   */
  function renderRadio() {
    const layer = $('radio-layer'),
      visible = new Set<string>(),
      rectangles: DOMRect[] = [];
    for (const b of game.radio.active) {
      const actor = game.traffic.get(b.actorId);
      if (!actor || actorSystemId(actor) !== game.systemId) continue;
      const point = view.project(actor.ship.position.x, actor.ship.position.y);
      if (
        !point.visible ||
        point.x < 55 ||
        point.x > innerWidth - 55 ||
        point.y < 190 ||
        point.y > innerHeight - 180
      )
        continue;
      let node = radioNodes.get(b.id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'radio-bubble' + (b.urgent ? ' urgent' : '');
        node.innerHTML = `<b>${esc(b.name)}</b><span>${esc(b.text)}</span>`;
        radioNodes.set(b.id, node);
        layer.append(node);
      }
      node.hidden = false;
      node.style.left = `${Math.max(112, Math.min(innerWidth - 112, point.x))}px`;
      node.style.top = `${point.y - 40}px`;
      const rect = node.getBoundingClientRect(),
        mini = $('minimap-button').getBoundingClientRect();
      if (
        rect.top < 125 ||
        rect.bottom > innerHeight - 150 ||
        rectangles.some(
          /** Detect overlapping radio rectangles before placing another bubble over the flight scene. */
          (r) =>
            rect.left < r.right + 8 &&
            rect.right > r.left - 8 &&
            rect.top < r.bottom + 8 &&
            rect.bottom > r.top - 8
        ) ||
        (rect.left < mini.right &&
          rect.right > mini.left &&
          rect.top < mini.bottom &&
          rect.bottom > mini.top)
      ) {
        node.hidden = true;
        continue;
      }
      rectangles.push(rect);
      visible.add(b.id);
      if (game.selected?.id === b.actorId) $('enemy-label').hidden = true;
    }
    for (const [id, node] of radioNodes) {
      if (
        !game.radio.active.some(
          /** Identify radio DOM nodes that still correspond to active announcements. */
          (b) => b.id === id
        )
      ) {
        node.remove();
        radioNodes.delete(id);
      } else node.hidden = !visible.has(id);
    }
  }

  /**
   * Run the animation-frame accumulator: advance physics at fixed intervals, render once,
   * update the UI and periodically autosave.
   */
  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - previous) / 1000, 0.08);
    previous = now;
    if (transition.active) {
      acc = 0;
      const result = document.hidden ? undefined : transition.update(dt);
      if (transition.active && transition.transit) {
        const journey = transition.transit;
        hyperspace.render(
          journey,
          transition.state as 'loading' | 'ready' | 'failed',
          catalog.systems[journey.fromSystemId].name,
          catalog.systems[journey.systemId].name,
          dt
        );
        return;
      }
      hyperspace.hide();
      navigation.radius = game.definition.radius;
      resume();
      if (result?.ok) {
        if (game.routeDestinationId && game.selected)
          setCourse({ kind: game.selected.kind, id: game.selected.id }, true);
        save();
        toast(result.message);
      }
    }
    if (!paused) {
      followClock += dt;
      if (game.followedActorId && followClock > 0.2) {
        followClock = 0;
        const follow = followTarget(game);
        if (follow?.contact) {
          game.selection = { kind: follow.contact.kind, id: follow.contact.id };
          navigation.moveTo(
            approachPoint(
              game.world.player.position,
              follow.contact.position,
              follow.contact.kind === 'ship' ? 135 : 65
            )
          );
        } else navigation.stop();
      }
      navigation.radius = game.definition.radius;
      const target = game.selected,
        ship =
          target?.kind === 'ship'
            ? game.world.ships.find(
                /** Resolve the currently selected ship as an automatic-fire target only when it is hostile. */
                (s) => s.id === target.id
              )
            : undefined;
      navigation.targetId =
        ship && game.world.relations.isHostile(game.world.player, ship) ? ship.id : undefined;
      acc += dt;
      const events: typeof game.world.events = [];
      while (acc >= 1 / 60) {
        game.step(1 / 60, navigation.input(game.world));
        view.destination = navigation.destination;
        for (const event of game.world.events) {
          if (event.type === 'fire') tone(120, 0.2, 0.035);
          if (event.type === 'hit') tone(60, 0.15, 0.04);
          if (event.type === 'pdc-fire') tone(event.player ? 430 : 290, 0.035, 0.008);
        }
        events.push(...game.world.events);
        acc -= 1 / 60;
      }
      game.world.combat.events = events;
      view.destination = navigation.destination;
      view.render(game.world, dt, sceneContent());
      if (game.failed && !failedShown) {
        failedShown = true;
        save();
        failure();
      }
      if (game.world.player.hull < 30 && !lowWarning) {
        lowWarning = true;
        toast('Hull critical.');
      }
      saveClock += dt;
      if (saveClock > 5) {
        saveClock = 0;
        save();
      }
    } else {
      acc = 0;
      game.world.combat.events = [];
      view.destination = navigation.destination;
      view.render(game.world, dt, sceneContent());
      preview?.render(dt);
    }
    updateUI(dt);
    renderRadio();
  }
  view.render(game.world, 1, sceneContent());
  updateUI(1);
  requestAnimationFrame(frame);
  if (game.failed) failure();
  else if (game.dockedAt) stationMenu();
  else pauseMenu();
  if (startupNotice) {
    const notice = document.createElement('p');
    notice.className = 'service-notice';
    notice.textContent = startupNotice;
    $('dialog').append(notice);
  }
}
void main().catch(
  /**
   * Report a startup failure in the existing dialog instead of leaving an unexplained blank
   * preview.
   */
  (error) => {
    console.error(error);
    const dialog = document.getElementById('dialog');
    if (dialog) dialog.textContent = 'The game could not start. Reload the preview to try again.';
  }
);
