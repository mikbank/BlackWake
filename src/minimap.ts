import { distance, type Vec3, type World } from './simulation';
type MapContact = { kind: string; id: string; position: Vec3 };

/**
 * Draw a north-up, player-centered local scan, adapting range to contacts without changing
 * navigation or simulation state.
 */
export function drawMinimap(
  canvas: HTMLCanvasElement,
  world: World,
  destination: Vec3 | null,
  points: MapContact[]
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width,
    center = size / 2,
    radius = size * 0.44,
    player = world.player;
  const contacts = world.ships.filter(
    /** Include living local NPC hulls while excluding salvage and the player's own marker. */
    (s) => s.owner !== 'salvage' && s.id !== player.id && s.hull > 0
  );
  const range = Math.max(
    600,
    ...points.map(
      /** Measure point-of-interest distances when choosing a useful local scan scale. */
      (p) => distance(player.position, p.position) * 1.15
    ),
    ...contacts.map(
      /** Measure nearby contact distances for the same player-centered scan scale. */
      (s) => distance(player.position, s.position) * 1.15
    ),
    destination ? distance(player.position, destination) * 1.15 : 0
  );
  const scale = radius / range;
  /**
   * Convert a world position into minimap pixels relative to the player's current position
   * and scan scale.
   */
  const point = (p: Vec3) => ({
    x: center + (p.x - player.position.x) * scale,
    y: center - (p.y - player.position.y) * scale
  });
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#0a1723bb';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#7ba5b52b';
  ctx.lineWidth = 1.5;
  for (const r of [radius * 0.5, radius]) {
    ctx.beginPath();
    ctx.arc(center, center, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(center - radius, center);
  ctx.lineTo(center + radius, center);
  ctx.moveTo(center, center - radius);
  ctx.lineTo(center, center + radius);
  ctx.stroke();
  if (destination) {
    const target = point(destination);
    ctx.strokeStyle = '#a0cbbb80';
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#badbd3';
    ctx.beginPath();
    ctx.arc(target.x, target.y, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const item of points) {
    if (item.kind === 'ship') continue;
    const p = point(item.position);
    ctx.strokeStyle =
      item.kind === 'gate' ? '#79bcd4' : item.kind === 'landmark' ? '#6b8799' : '#a0cbbb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (item.kind === 'station') {
      ctx.moveTo(p.x - 5, p.y);
      ctx.lineTo(p.x + 5, p.y);
      ctx.moveTo(p.x, p.y - 5);
      ctx.lineTo(p.x, p.y + 5);
    } else ctx.arc(p.x, p.y, item.kind === 'gate' ? 5 : 7, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const contact of contacts) {
    const p = point(contact.position);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = world.relations.isHostile(player, contact) ? '#deb46e' : '#8b9eaa';
    ctx.fillRect(-4, -4, 8, 8);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(center, center);
  ctx.rotate(-player.heading);
  ctx.fillStyle = '#b4e3d3';
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(-5, -5);
  ctx.lineTo(-2, 0);
  ctx.lineTo(-5, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.restore();
  ctx.strokeStyle = '#a1bbc145';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.stroke();
}
