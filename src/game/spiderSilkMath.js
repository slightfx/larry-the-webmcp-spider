const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function buildSilkPath(start, end, seed = 1) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const count = clamp(Math.round(distance / 16), 4, 20);
  const normalX = distance > 0 ? -dy / distance : 0;
  const normalY = distance > 0 ? dx / distance : 0;
  const amplitude = Math.min(4.5, distance * 0.025);
  const points = [];

  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    const taper = Math.sin(Math.PI * t);
    const wave = (
      Math.sin(seed * 1.73 + t * Math.PI * 5.2)
      + Math.sin(seed * 0.61 + t * Math.PI * 11.4) * 0.35
    ) * amplitude * taper;
    points.push({
      x: start.x + dx * t + normalX * wave,
      y: start.y + dy * t + normalY * wave,
    });
  }

  points[0] = { ...start };
  points[points.length - 1] = { ...end };
  return points;
}

export function swaySilkPath(points, timeMs, seed = 1) {
  if (points.length < 3) return points.map((point) => ({ ...point }));

  const start = points[0];
  const end = points[points.length - 1];
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const strength = Math.min(11, 1.25 + length * 0.032);
  const phase = timeMs * 0.00115 + seed * 1.91;

  return points.map((point, index) => {
    const t = index / (points.length - 1);
    const taper = Math.sin(Math.PI * t);
    const gust = Math.sin(phase + t * 2.4) * 0.72
      + Math.sin(phase * 0.43 - t * 4.7) * 0.28;
    const sway = gust * strength * taper;
    return {
      x: point.x + sway,
      y: point.y + sway * 0.12,
    };
  });
}

export function getSwayedWebPoint(web, progress, timeMs = 0) {
  if (!web?.start || !web?.end) return { x: 0, y: 0, angle: 0 };
  const rawPath = buildSilkPath(web.start, web.end, web.seed ?? 1);
  const path = swaySilkPath(rawPath, timeMs, web.seed ?? 1);
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const indexFloat = clampedProgress * (path.length - 1);
  const i0 = Math.floor(indexFloat);
  const i1 = Math.min(path.length - 1, i0 + 1);
  const frac = indexFloat - i0;
  const p0 = path[i0];
  const p1 = path[i1];
  const x = p0.x + (p1.x - p0.x) * frac;
  const y = p0.y + (p1.y - p0.y) * frac;
  const dx = i0 !== i1 ? p1.x - p0.x : web.end.x - web.start.x;
  const dy = i0 !== i1 ? p1.y - p0.y : web.end.y - web.start.y;
  const angle = Math.atan2(dy, dx);
  return { x, y, angle };
}
