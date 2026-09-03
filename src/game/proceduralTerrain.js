const DEFAULT_WIDTH = 768;
const DEFAULT_HEIGHT = 432;
const DEFAULT_GROUND_Y = 358;

export function hashTerrainSeed(value) {
  const text = String(value ?? 'moss-house');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getTerrainSway(timeMs, seed, index = 0, amplitude = 2) {
  const motionSeed = hashTerrainSeed(`${seed}:${index}`);
  const phase = ((motionSeed & 0xffff) / 0xffff) * Math.PI * 2;
  const speed = 0.55 + (((motionSeed >>> 16) & 0xff) / 255) * 0.55;
  const time = timeMs / 1000;
  const localSway = Math.sin(time * speed + phase) * 0.72;
  const wanderingWind = Math.sin(time * 0.19 + phase * 0.43) * 0.28;
  const gust = 0.5 + ((Math.sin(time * 0.11 + phase * 1.7) + 1) * 0.25);
  return Math.round((localSway + wanderingWind) * gust * amplitude);
}

function makeRandom(seed) {
  let state = hashTerrainSeed(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function between(random, min, max) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

function makeTree(random, lane, groundY, heightRange, branchCount) {
  const center = between(random, lane[0], lane[1]);
  const width = between(random, 25, 34);
  const height = between(random, heightRange[0], heightRange[1]);
  const tree = {
    x: Math.round(center - width / 2),
    y: groundY - height,
    w: width,
    h: height,
    climbable: true,
    seed: between(random, 1, 0x7fffffff),
  };

  const branches = [];
  const usableHeight = height - 54;
  for (let index = 0; index < branchCount; index += 1) {
    const fraction = branchCount === 1 ? 0.48 : 0.35 + index * 0.33;
    const y = Math.round(tree.y + 24 + usableHeight * fraction);
    const leftReach = between(random, 42, 78);
    const rightReach = between(random, 48, 92);
    branches.push({
      x: Math.round(center - leftReach),
      y,
      w: leftReach + rightReach,
      h: between(random, 8, 10),
      seed: between(random, 1, 0x7fffffff),
      treeSeed: tree.seed,
    });
  }

  return { tree, branches };
}

export function generateProceduralTerrain(seed, options = {}) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const groundY = options.groundY || DEFAULT_GROUND_Y;
  const normalizedSeed = hashTerrainSeed(seed);
  const random = makeRandom(normalizedSeed);

  const treeSpecs = [
    [[126, 166], [202, 242], 2],
    [[438, 500], [270, 306], 2],
    [[620, 666], [150, 190], 2],
  ];
  const generatedTrees = treeSpecs.map(([lane, heightRange, branches]) => (
    makeTree(random, lane, groundY, heightRange, branches)
  ));
  const climbables = generatedTrees.map(({ tree }) => tree);
  const platforms = [
    { x: -64, y: groundY, w: width + 128, h: height - groundY, seed: normalizedSeed },
    ...generatedTrees.flatMap(({ branches }) => branches),
  ];

  const clearGroundRanges = [];
  let cursor = 34;
  for (const tree of climbables) {
    if (tree.x - cursor > 58) clearGroundRanges.push([cursor, tree.x - 14]);
    cursor = tree.x + tree.w + 14;
  }
  if (width - 34 - cursor > 58) clearGroundRanges.push([cursor, width - 34]);
  const spawnRange = clearGroundRanges.reduce((best, range) => (
    range[1] - range[0] > best[1] - best[0] ? range : best
  ), clearGroundRanges[0]);

  const ferns = Array.from({ length: 7 }, (_, index) => ({
    x: Math.round(42 + index * ((width - 84) / 6) + between(random, -18, 18)),
    height: between(random, 22, 42),
    color: pick(random, [0x466f43, 0x4f7848, 0x527e4c, 0x587d48]),
    lean: between(random, -3, 3),
    seed: between(random, 1, 0x7fffffff),
  }));
  const stones = Array.from({ length: 7 }, () => ({
    x: between(random, 42, width - 42),
    w: between(random, 9, 24),
    h: between(random, 5, 11),
    color: pick(random, [0x887d72, 0x9b917f, 0x746d65, 0xa39a89]),
  }));
  const mushrooms = Array.from({ length: 3 }, () => ({
    x: between(random, 46, width - 46),
    height: between(random, 8, 16),
    capWidth: between(random, 8, 16),
    color: pick(random, [0xd78965, 0xc97962, 0xd6a45d, 0xb96f72]),
  }));
  const canopy = Array.from({ length: 5 }, (_, index) => ({
    x: Math.round(70 + index * ((width - 140) / 4) + between(random, -28, 28)),
    y: between(random, 92, 190),
    radius: between(random, 38, 82),
    color: pick(random, [0x91ad88, 0x85a47e, 0x9ab58e]),
  }));
  const stems = Array.from({ length: 15 }, (_, index) => ({
    x: 30 + index * Math.round((width - 60) / 14) + between(random, -8, 8),
    height: between(random, 38, 112),
    lean: between(random, -8, 8),
    leafSide: random() < 0.5 ? -1 : 1,
  }));

  return {
    seed: normalizedSeed,
    width,
    height,
    groundY,
    platforms,
    climbables,
    spawnX: Math.round((spawnRange[0] + spawnRange[1]) / 2),
    decorations: { ferns, stones, mushrooms, canopy, stems },
  };
}

export function generateIntroTerrain(seed, options = {}) {
  const terrain = generateProceduralTerrain(seed, options);
  const ground = terrain.platforms.find((platform) => platform.h > 10);
  terrain.platforms = [ground];
  terrain.climbables = [];
  terrain.spawnX = 92;
  terrain.decorations = {
    ferns: [],
    stones: [],
    mushrooms: [],
    canopy: [],
    stems: [],
  };
  return terrain;
}
