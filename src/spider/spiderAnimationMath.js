function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

export function getLandingAnimationPose(elapsed, duration, strength = 1) {
  if (duration <= 0 || elapsed < 0 || elapsed >= duration) {
    return { bodyOffset: 0, widthScale: 1, heightScale: 1, shadowScale: 1 };
  }

  const impact = clamp(strength, 0, 1);
  const progress = clamp(elapsed / duration, 0, 1);
  const keyframes = [
    { at: 0, bodyOffset: 3.1, widthScale: 1.16, heightScale: 0.76, shadowScale: 1.22 },
    { at: 0.3, bodyOffset: -1.25, widthScale: 0.96, heightScale: 1.08, shadowScale: 0.96 },
    { at: 0.62, bodyOffset: 0.55, widthScale: 1.035, heightScale: 0.975, shadowScale: 1.04 },
    { at: 1, bodyOffset: 0, widthScale: 1, heightScale: 1, shadowScale: 1 },
  ];

  let from = keyframes[0];
  let to = keyframes.at(-1);
  for (let index = 1; index < keyframes.length; index += 1) {
    if (progress <= keyframes[index].at) {
      from = keyframes[index - 1];
      to = keyframes[index];
      break;
    }
  }
  const localProgress = smoothstep((progress - from.at) / (to.at - from.at));
  return {
    bodyOffset: lerp(from.bodyOffset, to.bodyOffset, localProgress) * impact,
    widthScale: 1 + (lerp(from.widthScale, to.widthScale, localProgress) - 1) * impact,
    heightScale: 1 + (lerp(from.heightScale, to.heightScale, localProgress) - 1) * impact,
    shadowScale: 1 + (lerp(from.shadowScale, to.shadowScale, localProgress) - 1) * impact,
  };
}

// Stones are drawn as ellipses whose bottom edge sits on the floor. Keeping
// this sampling math beside the other animation helpers makes the rendered
// silhouette and the procedural foot contacts use the exact same curve.
export function getStoneSurfaceY(stone, x, groundY) {
  const radiusX = stone?.w / 2;
  const radiusY = stone?.h / 2;
  if (!(radiusX > 0) || !(radiusY > 0)) return null;

  const normalizedX = (x - stone.x) / radiusX;
  if (Math.abs(normalizedX) > 1) return null;

  return groundY - radiusY - radiusY * Math.sqrt(1 - normalizedX ** 2);
}

export function getWalkableSurfaceY(stones, x, groundY) {
  let surfaceY = groundY;
  for (const stone of stones || []) {
    const stoneY = getStoneSurfaceY(stone, x, groundY);
    if (stoneY !== null) surfaceY = Math.min(surfaceY, stoneY);
  }
  return surfaceY;
}

// Inflate the stone horizontally by the body's half-width. This is the
// smooth collision contour followed by the abdomen: it starts lifting before
// the body's leading edge reaches the rock, instead of popping upward when
// the spider's centre crosses the visible ellipse.
export function getSpiderBodySurfaceY(
  stones,
  x,
  groundY,
  bodyHalfWidth,
  bodyHalfHeight,
) {
  let bodyY = groundY - bodyHalfHeight;
  for (const stone of stones || []) {
    const radiusX = stone?.w / 2 + bodyHalfWidth;
    const height = stone?.h;
    if (!(radiusX > 0) || !(height > 0)) continue;

    const normalizedX = (x - stone.x) / radiusX;
    if (Math.abs(normalizedX) > 1) continue;
    const stoneBodyY = groundY - bodyHalfHeight -
      height * Math.sqrt(1 - normalizedX ** 2);
    bodyY = Math.min(bodyY, stoneBodyY);
  }
  return bodyY;
}
