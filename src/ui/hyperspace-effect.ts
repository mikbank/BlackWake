import { hyperspaceVisualState, projectHyperspaceStar } from './hyperspace-motion';
type Star = { x: number; y: number; z: number };
/** Render a lightweight forward star stream and curved tunnel without allocating another WebGL context. */
export class HyperspaceEffect {
  private ctx: CanvasRenderingContext2D | null;
  private stars: Star[] = [];
  private time = 0;
  private width = 0;
  private height = 0;
  private ratio = 0;
  private seed = 571;
  /** Retain one canvas and a fixed visual-only star pool across frames. */
  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.reset();
  }
  /** Reset only presentation state when a new journey begins. */
  reset() {
    this.time = 0;
    this.seed = 571;
    this.stars = [];
    for (let i = 0; i < 220; i++)
      this.stars.push({
        x: this.random() * 2 - 1,
        y: this.random() * 2 - 1,
        z: 0.25 + this.random() * 1.05
      });
  }
  /** Advance a deterministic visual random stream independently of traffic and universe generation. */
  private random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  /** Resize only when the viewport changes; cap fill resolution for phones. */
  private resize(width: number, height: number, pixelRatio: number) {
    const ratio = Math.max(1, Math.min(1.5, pixelRatio));
    if (width === this.width && height === this.height && ratio === this.ratio) return;
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  /** Paint the current phase, pausing failed journeys and respecting reduced-motion preferences. */
  render(
    progress: number,
    dt: number,
    width: number,
    height: number,
    pixelRatio: number,
    reducedMotion: boolean,
    paused: boolean
  ) {
    const ctx = this.ctx;
    if (!ctx || width <= 0 || height <= 0) return;
    this.resize(width, height, pixelRatio);
    const state = hyperspaceVisualState(progress),
      step = paused || reducedMotion ? 0 : Math.max(0, Math.min(0.08, dt));
    this.time += step;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#040912';
    ctx.fillRect(0, 0, width, height);
    const centreX = width * 0.5,
      centreY = height * 0.43;
    const glow = ctx.createRadialGradient(
      centreX,
      centreY,
      0,
      centreX,
      centreY,
      Math.max(width, height) * 0.7
    );
    glow.addColorStop(0, `rgba(29,80,103,${0.05 + state.tunnel * 0.6})`);
    glow.addColorStop(0.35, `rgba(28,34,77,${state.tunnel * 0.5})`);
    glow.addColorStop(1, 'rgba(3,7,15,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    for (const star of this.stars) {
      star.z -= step * state.speed * 0.95;
      const point = projectHyperspaceStar(star.x, star.y, star.z, width, height);
      if (
        star.z < 0.07 ||
        point.x < -width * 0.15 ||
        point.x > width * 1.15 ||
        point.y < -height * 0.15 ||
        point.y > height * 1.15
      ) {
        star.x = this.random() * 2 - 1;
        star.y = this.random() * 2 - 1;
        star.z = 1.3;
      }
    }
    const streak = reducedMotion ? 0 : state.streak;
    for (let bucket = 0; bucket < 3; bucket++) {
      ctx.globalAlpha = (1 - state.tunnel * 0.88) * (paused ? 0.32 : 1);
      ctx.strokeStyle = bucket === 0 ? '#e5f2f6' : bucket === 1 ? '#92b9d6' : '#607caa';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = bucket === 0 ? 1.25 : 0.75;
      ctx.beginPath();
      for (let i = bucket; i < this.stars.length; i += 3) {
        const star = this.stars[i],
          head = projectHyperspaceStar(star.x, star.y, star.z, width, height);
        const tail = projectHyperspaceStar(star.x, star.y, star.z + 0.2 * streak, width, height);
        if (streak > 0.015) {
          ctx.moveTo(tail.x, tail.y);
          ctx.lineTo(head.x, head.y);
        }
      }
      ctx.stroke();
      ctx.beginPath();
      for (let i = bucket; i < this.stars.length; i += 3) {
        const star = this.stars[i],
          head = projectHyperspaceStar(star.x, star.y, star.z, width, height);
        const radius = bucket === 0 ? 1.05 : 0.65;
        ctx.moveTo(head.x + radius, head.y);
        ctx.arc(head.x, head.y, radius, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    if (state.tunnel > 0.001) this.tunnel(state.tunnel * (paused ? 0.4 : 1));
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  /** Bend a perspective tunnel centreline while keeping its near opening aligned with the viewer. */
  private tunnelPoint(depth: number, angle: number, time: number) {
    const radius = (Math.min(this.width, this.height) * 0.28) / (0.12 + depth * 4);
    const twist = angle + depth * 2.8 + time * 0.35;
    const ripple = 1 + 0.045 * Math.sin(angle * 5 - time * 0.7 + depth * 8);
    return {
      x:
        this.width * 0.5 +
        Math.sin(time * 0.32 + depth * 3) * this.width * 0.09 * depth * depth +
        Math.cos(twist) * radius * ripple,
      y:
        this.height * 0.43 +
        Math.cos(time * 0.27 + depth * 3) * this.height * 0.07 * depth * depth +
        Math.sin(twist) * radius * ripple
    };
  }
  /** Layer expanding cross-sections and helical longitudinal filaments into a continuous wormhole. */
  private tunnel(opacity: number) {
    const ctx = this.ctx!;
    ctx.globalCompositeOperation = 'screen';
    for (let ring = 0; ring < 28; ring++) {
      const depth = 1 - ((ring / 28 + this.time * 0.32) % 1);
      ctx.globalAlpha = opacity * (0.12 + (1 - depth) * 0.5);
      ctx.strokeStyle = ring % 4 === 0 ? '#927fe0' : '#65bed0';
      ctx.lineWidth = 0.7 + (1 - depth) * 1.5;
      ctx.beginPath();
      for (let segment = 0; segment <= 48; segment++) {
        const point = this.tunnelPoint(depth, (segment / 48) * Math.PI * 2, this.time);
        if (segment === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = opacity * 0.4;
    ctx.lineWidth = 1.25;
    for (let filament = 0; filament < 10; filament++) {
      ctx.strokeStyle = filament % 3 === 0 ? '#a58ce8' : '#7bc9db';
      ctx.beginPath();
      for (let segment = 0; segment <= 40; segment++) {
        const point = this.tunnelPoint(segment / 40, (filament / 10) * Math.PI * 2, this.time);
        if (segment === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
    }
  }
}
