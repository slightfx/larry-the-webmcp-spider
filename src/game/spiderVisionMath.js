const EPSILON = 1e-7;

export function getKillAnimationFrame(elapsed, frameDuration = 0.27, frameCount = 3) {
  if (elapsed < 0 || frameDuration <= 0 || frameCount <= 0) return null;
  const frame = Math.floor(elapsed / frameDuration);
  return frame < frameCount ? frame : null;
}

export function rayRectIntersection(
  originX,
  originY,
  directionX,
  directionY,
  rect,
  nearDistance = 0.5,
  farDistance = Infinity,
) {
  let near = -Infinity;
  let far = Infinity;

  for (const [origin, direction, minimum, maximum] of [
    [originX, directionX, rect.x, rect.x + rect.w],
    [originY, directionY, rect.y, rect.y + rect.h],
  ]) {
    if (Math.abs(direction) < EPSILON) {
      if (origin < minimum || origin > maximum) return null;
      continue;
    }

    let entry = (minimum - origin) / direction;
    let exit = (maximum - origin) / direction;
    if (entry > exit) [entry, exit] = [exit, entry];
    near = Math.max(near, entry);
    far = Math.min(far, exit);
    if (near > far) return null;
  }

  const distance = near >= nearDistance ? near : far;
  if (distance < nearDistance || distance > farDistance) return null;
  return distance;
}

export function castNearestRay(
  originX,
  originY,
  directionX,
  directionY,
  obstacles,
  nearDistance,
  farDistance,
) {
  let nearest = null;
  for (const obstacle of obstacles) {
    const distance = rayRectIntersection(
      originX,
      originY,
      directionX,
      directionY,
      obstacle,
      nearDistance,
      farDistance,
    );
    if (distance === null || (nearest && distance >= nearest.distance)) continue;
    const hitX = originX + directionX * distance;
    const hitY = originY + directionY * distance;
    const onVerticalFace =
      Math.abs(hitX - obstacle.x) < 0.001 ||
      Math.abs(hitX - (obstacle.x + obstacle.w)) < 0.001;
    nearest = {
      obstacle,
      distance,
      hitX,
      hitY,
      face: onVerticalFace ? 'vertical' : 'horizontal',
      wallCoordinate: onVerticalFace ? hitY : hitX,
    };
  }
  return nearest;
}

export function getSpiderViewAngle(spider) {
  const bodyAngle = spider.isPouncing ? spider.pounceAngle : spider.surfaceAngle;
  return bodyAngle + (spider.facing < 0 ? Math.PI : 0);
}

export function isDepthVisible(forwardDistance, screenColumn, depthBuffer) {
  return (
    screenColumn >= 0 &&
    screenColumn < depthBuffer.length &&
    forwardDistance < depthBuffer[screenColumn]
  );
}

export function projectPointToView(
  pointX,
  pointY,
  cameraX,
  cameraY,
  viewAngle,
  fieldOfView,
  viewportWidth,
  nearDistance = 0.5,
  farDistance = Infinity,
) {
  const dx = pointX - cameraX;
  const dy = pointY - cameraY;
  const cos = Math.cos(viewAngle);
  const sin = Math.sin(viewAngle);
  const forward = dx * cos + dy * sin;
  const lateral = -dx * sin + dy * cos;
  if (forward < nearDistance || forward > farDistance) return null;

  const halfFovTangent = Math.tan(fieldOfView / 2);
  const normalizedX = lateral / (forward * halfFovTangent);
  if (Math.abs(normalizedX) > 1.08) return null;

  return {
    forward,
    lateral,
    normalizedX,
    screenX: (normalizedX * 0.5 + 0.5) * viewportWidth,
  };
}
