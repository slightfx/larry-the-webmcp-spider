import Phaser from 'phaser';
import { hashTerrainSeed } from './proceduralTerrain.js';

const WORM_COUNT = 1;
const TUNNEL_LENGTH = 180;
const DIRT_TOP_OFFSET = 20;
const DIRT_BOTTOM_OFFSET = 48;

const moveToward = (value, target, step) =>
  Math.abs(target - value) <= step
    ? target
    : value + Math.sign(target - value) * step;

function makeRandom(seed) {
  let state = hashTerrainSeed(`worms:${seed}`);
  return () => {
    state = Math.imul(state ^ (state >>> 16), 2246822519);
    state = Math.imul(state ^ (state >>> 13), 3266489917);
    return ((state ^ (state >>> 16)) >>> 0) / 4294967296;
  };
}

export class WormManager {
  constructor(scene, { groundY, width, seed }) {
    this.scene = scene;
    this.groundY = groundY;
    this.width = width;
    this.graphics = scene.add.graphics().setDepth(3);
    const random = makeRandom(seed);

    this.worms = Array.from({ length: WORM_COUNT }, (_, index) => {
      const x = Math.round(48 + random() * (width - 96));
      const y = Math.round(groundY + DIRT_TOP_OFFSET + random() * (DIRT_BOTTOM_OFFSET - DIRT_TOP_OFFSET));
      const direction = random() < 0.5 ? -1 : 1;
      const tunnel = Array.from({ length: 72 }, (_, tunnelIndex) => {
        const distance = (72 - tunnelIndex) * 0.42;
        return {
          x: x - direction * distance,
          y: y + Math.sin(tunnelIndex * 0.22 + index) * 1.5,
        };
      });
      return {
        x,
        y,
        direction,
        speed: 7 + random() * 7,
        phase: random() * Math.PI * 2,
        turnTimer: 1.5 + random() * 3,
        targetY: y,
        behavior: 'wander',
        decisionTimer: 1 + random() * 2,
        trail: tunnel,
        index,
      };
    });
    this.draw();
  }

  update(dt) {
    const spider = this.scene.spider;
    for (const worm of this.worms) {
      worm.phase += dt * 5;
      const spiderDistance = spider
        ? Phaser.Math.Distance.Between(worm.x, worm.y, spider.position.x, spider.position.y)
        : Infinity;

      // The worms make their own decisions, but a nearby spider is a threat:
      // turn away and dive toward the darker, deeper soil.
      if (spiderDistance < 82) {
        worm.behavior = 'flee';
        worm.direction = worm.x < spider.position.x ? -1 : 1;
        worm.targetY = this.groundY + DIRT_BOTTOM_OFFSET;
        worm.speed = 22;
      } else {
        worm.decisionTimer -= dt;
        if (worm.decisionTimer <= 0) {
          const decision = Math.sin(worm.phase * 0.37 + worm.index * 4.1);
          worm.behavior = decision > 0.58 ? 'rest' : 'wander';
          worm.direction = decision < -0.1 ? -1 : 1;
          worm.targetY = this.groundY + DIRT_TOP_OFFSET +
            ((Math.sin(worm.phase * 0.61 + worm.index) + 1) * 0.5) *
            (DIRT_BOTTOM_OFFSET - DIRT_TOP_OFFSET);
          worm.speed = 7 + ((Math.sin(worm.phase + worm.index) + 1) * 0.5) * 7;
          worm.decisionTimer = worm.behavior === 'rest' ? 0.7 : 1.5 +
            ((Math.sin(worm.phase * 0.23) + 1) * 0.5) * 2.5;
        }
      }

      if (worm.behavior !== 'rest') {
        worm.x += worm.direction * worm.speed * dt;
      }
      worm.y = moveToward(worm.y, worm.targetY, dt * (worm.behavior === 'flee' ? 18 : 8));
      worm.y += Math.sin(worm.phase) * dt * (worm.behavior === 'flee' ? 1 : 2.2);
      if (worm.x < 34) {
        worm.x = 34;
        worm.direction = 1;
      } else if (worm.x > this.width - 34) {
        worm.x = this.width - 34;
        worm.direction = -1;
      }
      worm.y = Phaser.Math.Clamp(
        worm.y,
        this.groundY + DIRT_TOP_OFFSET,
        this.groundY + DIRT_BOTTOM_OFFSET,
      );
      worm.trail.push({ x: worm.x, y: worm.y });
      if (worm.trail.length > TUNNEL_LENGTH) worm.trail.shift();
    }
    this.draw();
  }

  draw() {
    const g = this.graphics;
    g.clear();

    // A tunnel is a broken, pixel-thick line so the soil still reads as a
    // solid layer. The warm edge catches just enough light to sell depth.
    for (const worm of this.worms) {
      for (let i = 1; i < worm.trail.length; i += 1) {
        const from = worm.trail[i - 1];
        const to = worm.trail[i];
        g.lineStyle(2, 0x211b19, 0.82);
        g.lineBetween(Math.round(from.x), Math.round(from.y), Math.round(to.x), Math.round(to.y));
        g.lineStyle(1, 0xa06d4c, 0.72);
        g.lineBetween(Math.round(from.x), Math.round(from.y - 2), Math.round(to.x), Math.round(to.y - 2));
      }
    }

  }

  destroy() {
    this.graphics.destroy();
  }
}
