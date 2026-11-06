import { HyperspaceEffect } from './hyperspace-effect';
import { hyperspaceVisualState } from './hyperspace-motion';
import type { PlayerTransit } from '../game/jump-travel';
/** Own the accessible transit overlay and three-phase visual sequence independently of destination loading. */
export class HyperspaceScreen {
  private root = document.createElement('section');
  private destination: HTMLElement;
  private route: HTMLElement;
  private status: HTMLElement;
  private progress: HTMLProgressElement;
  private retry: HTMLButtonElement;
  private effect: HyperspaceEffect;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  /** Keep retry/cancel actions outside the inert game UI and release keyboard focus on arrival. */
  constructor(onRetry: () => void, onCancel: () => void) {
    this.root.className = 'hyperspace';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'jump-destination');
    this.root.tabIndex = -1;
    this.root.innerHTML = `<canvas class="jump-visual" aria-hidden="true"></canvas><div class="jump-heading"><span>BLACKWAKE / HYPERSPACE</span><p id="jump-route"></p></div><div class="jump-arrival"><span class="jump-caption">BOUND FOR</span><h1 id="jump-destination"></h1><p id="jump-status" role="status" aria-live="polite"></p><progress id="jump-progress" max="1" value="0" aria-label="Journey progress"></progress><div class="jump-actions"><button id="jump-retry" hidden>Retry arrival</button><button id="jump-cancel">Return to departure</button></div></div>`;
    document.body.append(this.root);
    this.effect = new HyperspaceEffect(this.root.querySelector('canvas')!);
    this.destination = this.root.querySelector('#jump-destination')!;
    this.route = this.root.querySelector('#jump-route')!;
    this.status = this.root.querySelector('#jump-status')!;
    this.progress = this.root.querySelector('#jump-progress')!;
    this.retry = this.root.querySelector('#jump-retry')!;
    this.retry.onclick = onRetry;
    (this.root.querySelector('#jump-cancel') as HTMLButtonElement).onclick = onCancel;
    this.root.addEventListener(
      'keydown',
      /** Keep tab navigation within the transit actions while the underlying application is inert. */
      (event) => {
        if (event.key !== 'Tab') return;
        const cancel = this.root.querySelector('#jump-cancel') as HTMLButtonElement;
        const first = this.retry.hidden ? cancel : this.retry;
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === this.root)
        ) {
          event.preventDefault();
          cancel.focus();
        } else if (!event.shiftKey && document.activeElement === cancel) {
          event.preventDefault();
          first.focus();
        }
      }
    );
  }
  /** Display journey progress, never a fabricated byte-loading percentage; announce only changed status text. */
  render(
    transit: PlayerTransit,
    state: 'loading' | 'ready' | 'failed',
    from: string,
    destination: string,
    dt = 1 / 60
  ) {
    if (this.root.hidden) {
      this.effect.reset();
      this.root.hidden = false;
      document.getElementById('app')!.inert = true;
      document.getElementById('app')!.setAttribute('aria-hidden', 'true');
      this.root.focus();
    }
    this.destination.textContent = destination;
    this.route.textContent = `${from} → ${destination}`;
    const progress = transit.elapsed / transit.duration;
    const phase = hyperspaceVisualState(progress).phase;
    this.root.dataset.phase = phase;
    this.effect.render(
      progress,
      dt,
      innerWidth,
      innerHeight,
      devicePixelRatio,
      this.reducedMotion.matches,
      state === 'failed'
    );
    this.progress.value = progress;
    this.retry.hidden = state !== 'failed';
    this.root.classList.toggle('jump-failed', state === 'failed');
    const status =
      state === 'failed'
        ? 'Arrival unavailable. Retry or return to your departure gateway.'
        : phase === 'departure'
          ? 'Accelerating · gateway lock confirmed'
          : phase === 'wormhole' || state === 'loading'
            ? 'Traversing hyperspace'
            : 'Leaving hyperspace · decelerating';
    if (this.status.textContent !== status) this.status.textContent = status;
  }
  /** Restore game interaction and focus after arrival or cancellation. */
  hide() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    document.getElementById('app')!.inert = false;
    document.getElementById('app')!.removeAttribute('aria-hidden');
    document.getElementById('pause')?.focus({ preventScroll: true });
  }
}
