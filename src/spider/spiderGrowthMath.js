export const STARTING_SCALE = 0.72;
export const MIN_HUNGER_SCALE = 0.5;
export const MAX_GROWTH_SCALE = 1.35;
export const GROWTH_PER_PREY = 0.08;
export const HUNGER_SHRINK_PER_SECOND = 0.001;

export function shrinkScaleForHunger(scale, dt) {
  const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  return Math.max(MIN_HUNGER_SCALE, scale - HUNGER_SHRINK_PER_SECOND * elapsed);
}

export function growScaleFromPrey(scale) {
  return Math.min(MAX_GROWTH_SCALE, Math.max(MIN_HUNGER_SCALE, scale) + GROWTH_PER_PREY);
}
