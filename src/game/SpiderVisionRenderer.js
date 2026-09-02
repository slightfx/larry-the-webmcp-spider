import Phaser from 'phaser';
import {
  castNearestRay,
  getKillAnimationFrame,
  getSpiderViewAngle,
  isDepthVisible,
  projectPointToView,
} from './spiderVisionMath.js';

const VIEWPORT = { x: 568, y: 50, width: 176, height: 104 };
const INNER = { x: 572, y: 62, width: 168, height: 86 };
const FIELD_OF_VIEW = Phaser.Math.DegToRad(70);
const RAY_WIDTH = 2;
const RAY_COUNT = INNER.width / RAY_WIDTH;
const NEAR_DISTANCE = 1.5;
const FAR_DISTANCE = 280;
const KILL_FRAME_DURATION = 0.27;

const EYE_LAYOUT = [
  { id: 'PLE-L', x: 573, y: 75, width: 13, height: 58, angle: -155, fov: 110, rayWidth: 2, kind: 'secondary' },
  { id: 'ALE-L', x: 588, y: 67, width: 24, height: 70, angle: -62, fov: 100, rayWidth: 2, kind: 'secondary' },
  { id: 'AME-L', x: 615, y: 64, width: 41, height: 80, angle: -5, fov: 32, rayWidth: 1, kind: 'principal', parallax: -0.8 },
  { id: 'AME-R', x: 658, y: 64, width: 41, height: 80, angle: 5, fov: 32, rayWidth: 1, kind: 'principal', parallax: 0.8 },
  { id: 'ALE-R', x: 702, y: 67, width: 24, height: 70, angle: 62, fov: 100, rayWidth: 2, kind: 'secondary' },
  { id: 'PLE-R', x: 728, y: 75, width: 11, height: 58, angle: 155, fov: 110, rayWidth: 2, kind: 'secondary' },
  { id: 'PME-L', x: 603, y: 63, width: 9, height: 12, angle: -105, fov: 75, rayWidth: 2, kind: 'vestigial' },
  { id: 'PME-R', x: 702, y: 63, width: 9, height: 12, angle: 105, fov: 75, rayWidth: 2, kind: 'vestigial' },
].map((eye) => ({
  ...eye,
  angle: Phaser.Math.DegToRad(eye.angle),
  fov: Phaser.Math.DegToRad(eye.fov),
}));

const MATERIAL_COLORS = {
  soil: 0x4d392a,
  branch: 0x6f5638,
  bark: 0x73513a,
  glass: 0x536b59,
};

const MATERIAL_ACCENTS = {
  soil: { dark: 0x2d2722, light: 0x79634c, cap: 0x617a43 },
  branch: { dark: 0x3f2d22, light: 0x9a7750, cap: 0x789552 },
  bark: { dark: 0x402d24, light: 0xa27957, cap: 0x6c8b4b },
  glass: { dark: 0x283b35, light: 0x91ad91, cap: 0x728d73 },
};

const BUG_COLORS = {
  isopod: { main: 0xaaa6b4, accent: 0x696774 },
  fly: { main: 0xf0e47b, accent: 0x493f30 },
  springtail: { main: 0x99dc61, accent: 0x426830 },
};

function shadeColor(color, amount) {
  const red = Math.round(((color >> 16) & 0xff) * amount);
  const green = Math.round(((color >> 8) & 0xff) * amount);
  const blue = Math.round((color & 0xff) * amount);
  return (red << 16) | (green << 8) | blue;
}

function textureHash(x, y, salt = 0) {
  let value = (x * 374761393 + y * 668265263 + salt * 69069) | 0;
  value = (value ^ (value >> 13)) * 1274126177;
  return ((value ^ (value >> 16)) >>> 0) / 0xffffffff;
}

function cardinalDirection(angle) {
  const normalized = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return ['E', 'S', 'W', 'N'][Math.round(normalized / (Math.PI / 2)) % 4];
}

function secondaryEyeColor(color, strength = 1) {
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  const luminance = (red * 0.2 + green * 0.68 + blue * 0.12) * strength;
  return (
    (Math.round(luminance * 0.5) << 16) |
    (Math.round(luminance * 0.82) << 8) |
    Math.round(luminance * 0.46)
  );
}

function gFill(graphics, color, x, y, width, height) {
  if (width <= 0 || height <= 0) return;
  graphics.fillStyle(color, 1);
  graphics.fillRect(x, y, width, height);
}

export class SpiderVisionRenderer {
  constructor(scene, { spider, platforms, climbables, getBugs, bounds }) {
    this.scene = scene;
    this.spider = spider;
    this.getBugs = getBugs;
    this.visible = true;
    this.damageFlash = 0;
    this.killAnimation = null;
    this.elapsed = 0;
    this.lastSurfacePlatform = spider.surfacePlatform;

    this.obstacles = [
      ...platforms.map((platform, index) => ({
        ...platform,
        source: platform,
        material: index === 0 || platform.h > 10 ? 'soil' : 'branch',
      })),
      ...climbables.map((climbable) => ({
        ...climbable,
        source: climbable,
        material: 'bark',
      })),
      { x: bounds.left - 4, y: bounds.top, w: 4, h: bounds.bottom - bounds.top, material: 'glass' },
      { x: bounds.right, y: bounds.top, w: 4, h: bounds.bottom - bounds.top, material: 'glass' },
      { x: bounds.left, y: bounds.top - 4, w: bounds.right - bounds.left, h: 4, material: 'glass' },
      { x: bounds.left, y: bounds.bottom, w: bounds.right - bounds.left, h: 4, material: 'glass' },
    ];

    this.graphics = scene.add.graphics().setDepth(1300);
    this.label = scene.add
      .text(VIEWPORT.x + 7, VIEWPORT.y + 2, '8-EYE VISION [V]  E  FLOOR', {
        fontFamily: 'monospace',
        fontSize: '7px',
        color: '#d8c893',
      })
      .setDepth(1301);
  }

  setVisible(visible) {
    this.visible = visible;
    const shouldRender = visible || this.killAnimation !== null;
    this.graphics.setVisible(shouldRender);
    this.label.setVisible(shouldRender);
  }

  toggle() {
    this.setVisible(!this.visible);
  }

  flashDamage() {
    this.damageFlash = 0.2;
  }

  playKillAnimation(bug) {
    this.killAnimation = {
      elapsed: 0,
      prey: {
        type: bug?.type ?? 'isopod',
        facing: bug?.facing ?? 1,
      },
    };
    this.graphics.setVisible(true);
    this.label.setVisible(true);
  }

  update(dt) {
    this.elapsed += dt;
    this.damageFlash = Math.max(0, this.damageFlash - dt);
    if (this.killAnimation) {
      this.killAnimation.elapsed += dt;
      const frame = getKillAnimationFrame(
        this.killAnimation.elapsed,
        KILL_FRAME_DURATION,
      );
      if (frame === null) {
        this.killAnimation = null;
        this.graphics.setVisible(this.visible);
        this.label.setVisible(this.visible);
      } else {
        this.graphics.clear();
        this.drawFrame();
        this.drawKillAnimation(this.killAnimation.prey, frame);
        this.drawVignette();
        this.drawInnerBezel();
        return;
      }
    }
    if (this.spider.surfacePlatform) {
      this.lastSurfacePlatform = this.spider.surfacePlatform;
    }
    if (!this.visible) return;

    const viewAngle = getSpiderViewAngle(this.spider);
    const cameraX = this.spider.headPosition.x;
    const cameraY = this.spider.headPosition.y;
    const movementBob = Math.sin(this.spider.animationTime * 2) * this.spider.scuttleAmount;
    const pounceBob = this.spider.isPouncing ? Math.sin(this.spider.pounceTime * 18) * 2 : 0;
    const horizon = INNER.y + Math.floor(INNER.height / 2 + movementBob + pounceBob);
    const degrees = Math.round(Phaser.Math.RadToDeg(viewAngle) + 360) % 360;
    const surface = (this.spider.surfaceType ?? 'AIR').slice(0, 5).toUpperCase();
    this.label.setText(
      `8-EYE [V] ${cardinalDirection(viewAngle)} ${String(degrees).padStart(3, '0')}° ${surface}`,
    );

    this.graphics.clear();
    this.drawFrame();
    this.drawMultiEyeVision(cameraX, cameraY, viewAngle, horizon);

    if (this.spider.isDead) this.drawDeathStatic();
    if (this.damageFlash > 0) {
      this.graphics.fillStyle(0x9e2738, this.damageFlash * 2.8);
      this.graphics.fillRect(INNER.x, INNER.y, INNER.width, INNER.height);
    }
    this.drawVignette();
    this.drawInnerBezel();
  }

  drawKillAnimation(prey, frame) {
    const g = this.graphics;
    const titles = ['PREY LOCK', 'STRIKE', 'KILL CONFIRMED'];
    this.label.setText(`8-EYE [V] - ${titles[frame]}  ${frame + 1}/3`);

    // A dedicated principal-eye capture screen, modelled after the terrarium's
    // chunky diagnostic UI. The side strips imply the six peripheral eyes.
    g.fillStyle(0x18251f, 1);
    g.fillRect(INNER.x, INNER.y, INNER.width, INNER.height);
    g.fillStyle(0x31483a, 1);
    g.fillRect(INNER.x + 2, INNER.y + 3, 31, INNER.height - 6);
    g.fillRect(INNER.x + INNER.width - 33, INNER.y + 3, 31, INNER.height - 6);
    g.fillStyle(0x58705a, 0.55);
    for (let y = INNER.y + 9; y < INNER.y + INNER.height - 5; y += 12) {
      g.fillRect(INNER.x + 4, y, 27, 1);
      g.fillRect(INNER.x + INNER.width - 31, y, 27, 1);
    }

    const screen = {
      x: INNER.x + 36,
      y: INNER.y + 2,
      width: INNER.width - 72,
      height: INNER.height - 4,
    };
    g.fillStyle(frame === 1 ? 0xb5a07e : 0x94aa84, 1);
    g.fillRect(screen.x, screen.y, screen.width, screen.height);
    g.lineStyle(2, 0x101814, 1);
    g.strokeRect(screen.x, screen.y, screen.width, screen.height);

    const impact = frame === 1 ? 4 : 0;
    const centerX = screen.x + Math.floor(screen.width / 2) + impact * prey.facing;
    const centerY = screen.y + Math.floor(screen.height / 2) + (frame === 2 ? 5 : 0);
    this.drawKillPrey(prey.type, centerX, centerY, frame, prey.facing);
    this.drawKillReticle(screen, frame);

    if (frame > 0) this.drawKillSpatter(centerX, centerY, frame);
  }

  drawKillReticle(screen, frame) {
    const g = this.graphics;
    const color = frame === 2 ? 0x721d22 : 0xd8d0a2;
    const inset = frame === 0 ? 9 : 13;
    g.lineStyle(1, color, frame === 1 ? 0.45 : 0.8);
    g.lineBetween(screen.x + inset, screen.y + 10, screen.x + inset, screen.y + 20);
    g.lineBetween(screen.x + 9, screen.y + inset, screen.x + 19, screen.y + inset);
    g.lineBetween(screen.x + screen.width - inset, screen.y + 10,
      screen.x + screen.width - inset, screen.y + 20);
    g.lineBetween(screen.x + screen.width - 19, screen.y + inset,
      screen.x + screen.width - 9, screen.y + inset);
    g.lineBetween(screen.x + inset, screen.y + screen.height - 10,
      screen.x + inset, screen.y + screen.height - 20);
    g.lineBetween(screen.x + 9, screen.y + screen.height - inset,
      screen.x + 19, screen.y + screen.height - inset);
    g.lineBetween(screen.x + screen.width - inset, screen.y + screen.height - 10,
      screen.x + screen.width - inset, screen.y + screen.height - 20);
    g.lineBetween(screen.x + screen.width - 19, screen.y + screen.height - inset,
      screen.x + screen.width - 9, screen.y + screen.height - inset);
  }

  drawKillPrey(type, x, y, frame, facing) {
    const g = this.graphics;
    const colors = BUG_COLORS[type] ?? BUG_COLORS.isopod;
    const crushed = frame === 2;
    const bodyY = y + (crushed ? 3 : 0);
    const bodyWidth = type === 'fly' ? 18 : type === 'springtail' ? 22 : 24;
    const bodyHeight = crushed ? 6 : type === 'springtail' ? 7 : 10;

    if (type === 'fly') {
      g.fillStyle(0xe4e5c7, crushed ? 0.58 : 0.86);
      g.fillTriangle(x - 3, bodyY - 2, x - 24, bodyY - 17, x - 10, bodyY + 1);
      g.fillTriangle(x + 3, bodyY - 2, x + 24, bodyY - 17, x + 10, bodyY + 1);
    }

    g.fillStyle(colors.main, 1);
    if (type === 'isopod') {
      g.fillEllipse(x, bodyY, bodyWidth, bodyHeight);
      g.fillStyle(colors.accent, 1);
      for (let offset = -8; offset <= 8; offset += 4) {
        g.fillRect(x + offset, bodyY - Math.floor(bodyHeight / 2), 1, bodyHeight);
      }
    } else {
      g.fillEllipse(x, bodyY, bodyWidth, bodyHeight);
      g.fillStyle(colors.accent, 1);
      g.fillRect(x - 3 * facing, bodyY - Math.floor(bodyHeight / 2), 5, bodyHeight);
      g.fillCircle(x + facing * (bodyWidth / 2), bodyY - 1, type === 'fly' ? 4 : 3);
    }

    g.lineStyle(2, colors.accent, 1);
    const legDrop = crushed ? 5 : 10;
    for (let offset = -7; offset <= 7; offset += 7) {
      g.lineBetween(x + offset, bodyY + 2, x + offset - 5, bodyY + legDrop);
      g.lineBetween(x + offset + 2, bodyY + 2, x + offset + 7, bodyY + legDrop - 1);
    }
    if (type === 'springtail') {
      g.lineBetween(x - facing * 8, bodyY + 2, x - facing * 17, bodyY + 11);
      g.lineBetween(x + facing * 10, bodyY - 2, x + facing * 18, bodyY - 9);
    }
  }

  drawKillSpatter(x, y, frame) {
    const g = this.graphics;
    g.fillStyle(0x8e1f26, 1);
    if (frame === 1) {
      g.fillTriangle(x - 16, y - 17, x - 12, y - 3, x - 8, y - 20);
      g.fillRect(x + 14, y - 12, 3, 5);
      g.fillRect(x - 22, y + 8, 2, 3);
    } else {
      g.fillRect(x - 13, y + 12, 4, 5);
      g.fillRect(x + 2, y + 15, 3, 6);
      g.fillRect(x + 16, y + 11, 3, 4);
      g.fillRect(x - 2, y - 4, 5, 3);
    }
  }

  drawFrame() {
    const g = this.graphics;
    g.fillStyle(0x281e19, 0.96);
    g.fillRect(VIEWPORT.x, VIEWPORT.y, VIEWPORT.width, VIEWPORT.height);
    g.fillStyle(0x715237, 1);
    g.fillRect(VIEWPORT.x + 2, VIEWPORT.y + 2, VIEWPORT.width - 4, 2);
    g.fillRect(VIEWPORT.x + 2, VIEWPORT.y + VIEWPORT.height - 4, VIEWPORT.width - 4, 2);
    g.fillStyle(0xb28a52, 1);
    g.fillRect(VIEWPORT.x + 4, VIEWPORT.y + 11, VIEWPORT.width - 8, 1);
  }

  drawMultiEyeVision(cameraX, cameraY, viewAngle, sharedHorizon) {
    const g = this.graphics;
    g.fillStyle(0x0d1210, 1);
    g.fillRect(INNER.x, INNER.y, INNER.width, INNER.height);

    const horizonBob = sharedHorizon - (INNER.y + INNER.height / 2);
    // Jumping-spider principal retinae scan a narrow scene even while the
    // head stays still. The secondary eyes remain fixed and watch for motion.
    const retinalScan = Phaser.Math.DegToRad(Math.sin(this.elapsed * Math.PI * 2) * 3);

    for (const eye of EYE_LAYOUT) {
      const isPrincipal = eye.kind === 'principal';
      const eyeAngle = viewAngle + eye.angle + (isPrincipal ? retinalScan : 0);
      const parallax = eye.parallax ?? 0;
      const eyeCameraX = cameraX - Math.sin(viewAngle) * parallax;
      const eyeCameraY = cameraY + Math.cos(viewAngle) * parallax;
      const horizon = Math.round(eye.y + eye.height / 2 + horizonBob);

      this.drawEyeBackdrop(eye, horizon, eyeCameraX, eyeCameraY);
      const depthBuffer = this.drawEyeWalls(
        eye,
        eyeCameraX,
        eyeCameraY,
        eyeAngle,
        horizon,
      );
      this.drawEyeBugs(
        eye,
        eyeCameraX,
        eyeCameraY,
        eyeAngle,
        horizon,
        depthBuffer,
      );
      this.drawEyeBezel(eye);
    }
  }

  drawEyeBackdrop(eye, horizon, cameraX, cameraY) {
    const g = this.graphics;
    const bottom = eye.y + eye.height;
    const principal = eye.kind === 'principal';
    const sky = principal ? 0x8fa783 : 0x324b39;
    const earth = principal ? 0x493c31 : 0x26372c;

    g.fillStyle(sky, 1);
    g.fillRect(eye.x, eye.y, eye.width, Math.max(0, horizon - eye.y));
    g.fillStyle(earth, 1);
    g.fillRect(eye.x, horizon, eye.width, Math.max(0, bottom - horizon));

    const rowHeight = principal ? 3 : 6;
    for (let y = horizon + rowHeight; y < bottom; y += rowHeight) {
      const ratio = (y - horizon) / Math.max(1, bottom - horizon);
      g.fillStyle(principal ? 0x6b5842 : 0x456047, 0.32 + ratio * 0.2);
      g.fillRect(eye.x, y, eye.width, 1);
    }

    if (principal) {
      const seed = Math.floor(cameraX / 10) + Math.floor(cameraY / 10);
      g.fillStyle(0xb3a077, 0.55);
      for (let i = 0; i < 5; i += 1) {
        const x = eye.x + Math.floor(textureHash(seed, i, eye.id.length) * eye.width);
        const y = horizon + Math.floor(textureHash(seed, i, 9) ** 2 * Math.max(1, bottom - horizon));
        g.fillRect(x, y, 1, 1);
      }
    }
  }

  drawEyeWalls(eye, cameraX, cameraY, viewAngle, horizon) {
    const rayCount = Math.ceil(eye.width / eye.rayWidth);
    const depthBuffer = new Array(rayCount).fill(FAR_DISTANCE);
    const projectionScale = eye.height * 14.5;
    const supportingSurface = this.spider.surfacePlatform ??
      (this.spider.isPouncing ? this.lastSurfacePlatform : null);
    const visibleObstacles = this.obstacles.filter(
      (obstacle) => obstacle.source !== supportingSurface,
    );

    for (let rayIndex = 0; rayIndex < rayCount; rayIndex += 1) {
      const rayRatio = (rayIndex + 0.5) / rayCount;
      const offset = (rayRatio - 0.5) * eye.fov;
      const rayAngle = viewAngle + offset;
      const hit = castNearestRay(
        cameraX,
        cameraY,
        Math.cos(rayAngle),
        Math.sin(rayAngle),
        visibleObstacles,
        NEAR_DISTANCE,
        FAR_DISTANCE,
      );
      if (!hit) continue;

      const distance = Math.max(NEAR_DISTANCE, hit.distance * Math.cos(offset));
      depthBuffer[rayIndex] = distance;
      const wallHeight = Phaser.Math.Clamp(
        Math.round(projectionScale / distance),
        3,
        eye.height + 8,
      );
      const wallTop = Math.round(horizon - wallHeight / 2);
      const top = Phaser.Math.Clamp(wallTop, eye.y, eye.y + eye.height);
      const bottom = Phaser.Math.Clamp(
        Math.round(horizon + wallHeight / 2),
        eye.y,
        eye.y + eye.height,
      );
      const material = hit.obstacle.material ?? 'branch';
      const accents = MATERIAL_ACCENTS[material];
      const textureX = Math.floor(hit.wallCoordinate / (eye.kind === 'principal' ? 5 : 11));
      const texelHeight = eye.kind === 'principal' ? 3 : 7;
      const distanceShade = Phaser.Math.Clamp(1.08 - distance / 360, 0.3, 1);

      for (let y = top; y < bottom; y += texelHeight) {
        const textureY = Math.floor((y - wallTop) / texelHeight);
        const normalizedY = (y - wallTop) / Math.max(1, wallHeight);
        const noise = textureHash(textureX, textureY, material.length);
        let color = MATERIAL_COLORS[material];
        if ((material === 'branch' || material === 'bark') && normalizedY < 0.1) {
          color = accents.cap;
        } else if (noise > 0.82) {
          color = accents.light;
        } else if (noise < 0.2 || textureY % 7 === 5) {
          color = accents.dark;
        }
        if (eye.kind !== 'principal') color = secondaryEyeColor(color, 0.9);

        gFill(this.graphics, shadeColor(color, distanceShade), eye.x + rayIndex * eye.rayWidth, y,
          Math.min(eye.rayWidth, eye.x + eye.width - (eye.x + rayIndex * eye.rayWidth)),
          Math.min(texelHeight, bottom - y));
      }
    }
    return depthBuffer;
  }

  drawEyeBugs(eye, cameraX, cameraY, viewAngle, horizon, depthBuffer) {
    const rayCount = depthBuffer.length;
    for (const bug of this.getBugs()) {
      if (!bug.alive) continue;
      const moving = bug.state === 'walk' || bug.state === 'hop' || bug.state === 'fly';
      if (eye.kind !== 'principal' && !moving) continue;

      const projection = projectPointToView(
        bug.x,
        bug.y,
        cameraX,
        cameraY,
        viewAngle,
        eye.fov,
        eye.width,
        NEAR_DISTANCE,
        FAR_DISTANCE,
      );
      if (!projection) continue;

      const centerX = Math.round(eye.x + projection.screenX);
      const rayIndex = Phaser.Math.Clamp(
        Math.floor((centerX - eye.x) / eye.rayWidth),
        0,
        rayCount - 1,
      );
      if (!isDepthVisible(projection.forward, rayIndex, depthBuffer)) continue;

      if (eye.kind === 'principal') {
        this.drawPrincipalEyeBug(eye, bug, projection, horizon);
      } else {
        const pulse = Math.floor(this.elapsed * 14) % 2;
        const size = Phaser.Math.Clamp(Math.round(85 / projection.forward), 1, 5);
        const y = Phaser.Math.Clamp(horizon - size / 2, eye.y + 1, eye.y + eye.height - size - 1);
        this.graphics.fillStyle(pulse ? 0xc6ec83 : 0x769c5e, 0.95);
        this.graphics.fillRect(centerX - size, y, size * 2 + 1, size);
        this.graphics.fillStyle(0xdfff9a, 0.38);
        this.graphics.fillRect(centerX - size - 2, y - 1, 1, size + 2);
        this.graphics.fillRect(centerX + size + 2, y - 1, 1, size + 2);
      }
    }
  }

  drawPrincipalEyeBug(eye, bug, projection, horizon) {
    const colors = BUG_COLORS[bug.type] ?? BUG_COLORS.isopod;
    const size = Phaser.Math.Clamp(Math.round(110 / projection.forward), 2, 10);
    const x = Math.round(eye.x + projection.screenX);
    const y = Phaser.Math.Clamp(
      Math.round(horizon - size * 0.55),
      eye.y + 2,
      eye.y + eye.height - size - 2,
    );
    const width = bug.type === 'fly' ? size * 2 + 3 : size + 3;
    this.graphics.fillStyle(colors.main, 1);
    this.graphics.fillRect(x - Math.floor(width / 2), y, width, size);
    this.graphics.fillStyle(colors.accent, 1);
    this.graphics.fillRect(x - 1, y, 2, size);
    if (bug.type === 'fly') {
      this.graphics.fillStyle(0xe0edca, 0.75);
      this.graphics.fillRect(x - size - 1, y - 1, size, 2);
      this.graphics.fillRect(x + 2, y - 1, size, 2);
    } else if (bug.type === 'springtail') {
      this.graphics.fillRect(x + 2, y - 2, 1, 3);
    }
  }

  drawEyeBezel(eye) {
    const g = this.graphics;
    const principal = eye.kind === 'principal';
    g.lineStyle(1, principal ? 0xa98b58 : 0x557059, 1);
    g.strokeRect(eye.x, eye.y, eye.width, eye.height);
    g.fillStyle(0x0b0e0d, 1);
    g.fillRect(eye.x, eye.y, 2, 2);
    g.fillRect(eye.x + eye.width - 2, eye.y, 2, 2);
    g.fillRect(eye.x, eye.y + eye.height - 2, 2, 2);
    g.fillRect(eye.x + eye.width - 2, eye.y + eye.height - 2, 2, 2);
  }

  drawBackdrop(horizon, cameraX, cameraY, viewAngle) {
    const g = this.graphics;
    const topHeight = Math.max(0, horizon - INNER.y);
    g.fillStyle(0x9caf8c, 1);
    g.fillRect(INNER.x, INNER.y, INNER.width, topHeight);
    g.fillStyle(0x7e9573, 1);
    g.fillRect(INNER.x, INNER.y + Math.floor(topHeight * 0.42), INNER.width, topHeight);

    // Distant canopy silhouettes give the empty half of the view some depth.
    const canopyShift = Math.floor((cameraX * 0.08 + cameraY * 0.05 + viewAngle * 21) % 28);
    g.fillStyle(0x60785f, 0.7);
    for (let x = INNER.x - 20 + canopyShift; x < INNER.x + INNER.width; x += 28) {
      const stemHeight = 10 + ((x * 7) % 13);
      g.fillRect(x, horizon - stemHeight, 3, stemHeight);
      g.fillRect(x - 5, horizon - stemHeight, 13, 3);
      g.fillRect(x - 2, horizon - stemHeight - 4, 8, 3);
    }

    // Perspective soil rows and seams converge toward the center like a
    // hand-painted floor texture in an early raycasting game.
    const bottom = INNER.y + INNER.height;
    for (let y = horizon; y < bottom; y += 2) {
      const ratio = (y - horizon) / Math.max(1, bottom - horizon);
      const shade = 0.58 + ratio * 0.38;
      const base = Math.floor((y - horizon) / Math.max(2, 8 - ratio * 5)) % 2 === 0
        ? 0x554739
        : 0x44382f;
      g.fillStyle(shadeColor(base, shade), 1);
      g.fillRect(INNER.x, y, INNER.width, 2);
    }

    const vanishingX = INNER.x + INNER.width / 2;
    g.lineStyle(1, 0x76604a, 0.42);
    for (let offset = -150; offset <= 150; offset += 30) {
      g.lineBetween(vanishingX, horizon, vanishingX + offset, bottom);
    }
    g.fillStyle(0x9b876b, 0.55);
    for (let i = 0; i < 18; i += 1) {
      const seedX = Math.floor(cameraX / 8) + i * 17;
      const seedY = Math.floor(cameraY / 8) + i * 31;
      const x = INNER.x + Math.floor(textureHash(seedX, seedY, 2) * INNER.width);
      const depth = textureHash(seedX, seedY, 3);
      const y = horizon + Math.floor(depth * depth * Math.max(0, bottom - horizon));
      const size = depth > 0.7 ? 2 : 1;
      g.fillRect(x, y, size, 1);
    }
  }

  drawWalls(cameraX, cameraY, viewAngle, horizon) {
    const depthBuffer = new Array(RAY_COUNT).fill(FAR_DISTANCE);
    const projectionScale = 1250;
    const supportingSurface = this.spider.surfacePlatform ??
      (this.spider.isPouncing ? this.lastSurfacePlatform : null);
    const visibleObstacles = this.obstacles.filter(
      (obstacle) => obstacle.source !== supportingSurface,
    );

    for (let rayIndex = 0; rayIndex < RAY_COUNT; rayIndex += 1) {
      const rayRatio = (rayIndex + 0.5) / RAY_COUNT;
      const offset = (rayRatio - 0.5) * FIELD_OF_VIEW;
      const rayAngle = viewAngle + offset;
      const directionX = Math.cos(rayAngle);
      const directionY = Math.sin(rayAngle);
      const hit = castNearestRay(
        cameraX,
        cameraY,
        directionX,
        directionY,
        visibleObstacles,
        NEAR_DISTANCE,
        FAR_DISTANCE,
      );
      if (!hit) continue;

      const correctedDistance = Math.max(NEAR_DISTANCE, hit.distance * Math.cos(offset));
      depthBuffer[rayIndex] = correctedDistance;
      const wallHeight = Phaser.Math.Clamp(
        Math.round(projectionScale / correctedDistance),
        4,
        INNER.height + 12,
      );
      const wallTop = Math.round(horizon - wallHeight / 2);
      const top = Phaser.Math.Clamp(
        wallTop,
        INNER.y,
        INNER.y + INNER.height,
      );
      const bottom = Phaser.Math.Clamp(
        Math.round(horizon + wallHeight / 2),
        INNER.y,
        INNER.y + INNER.height,
      );
      const distanceShade = Phaser.Math.Clamp(1.08 - correctedDistance / 360, 0.28, 1);
      const material = hit.obstacle.material ?? 'branch';
      const baseColor = MATERIAL_COLORS[material];
      const accents = MATERIAL_ACCENTS[material];
      const textureX = Math.floor(hit.wallCoordinate / 5);

      for (let y = top; y < bottom; y += 3) {
        const textureY = Math.floor((y - wallTop) / 3);
        const normalizedY = (y - wallTop) / Math.max(1, wallHeight);
        const noise = textureHash(textureX, textureY, material.length);
        let texelColor = baseColor;
        let texelShade = distanceShade * (rayIndex % 3 === 0 ? 0.91 : 1);

        if ((material === 'branch' || material === 'bark') && normalizedY < 0.1) {
          texelColor = accents.cap;
          texelShade *= noise > 0.72 ? 1.15 : 0.92;
        } else if (material === 'bark') {
          if (textureX % 5 === 0) texelColor = accents.dark;
          if (noise > 0.83) texelColor = accents.light;
          if (textureY % 9 === 6 && noise > 0.45) texelColor = accents.dark;
        } else if (material === 'branch') {
          if (textureY % 7 === 4) texelColor = accents.dark;
          if (noise > 0.86) texelColor = accents.light;
        } else if (material === 'soil') {
          if (noise > 0.82) texelColor = accents.light;
          if (noise < 0.16 || textureY % 8 === 7) texelColor = accents.dark;
        } else if (material === 'glass') {
          if (textureX % 7 === 0) texelColor = accents.light;
          if (textureY % 6 === 5) texelColor = accents.dark;
        }

        this.graphics.fillStyle(shadeColor(texelColor, texelShade), 1);
        this.graphics.fillRect(
          INNER.x + rayIndex * RAY_WIDTH,
          y,
          RAY_WIDTH,
          Math.min(3, bottom - y),
        );
      }
      if (wallHeight > 9) {
        this.graphics.fillStyle(shadeColor(accents.light, distanceShade), 0.7);
        this.graphics.fillRect(INNER.x + rayIndex * RAY_WIDTH, top, RAY_WIDTH, 1);
      }
    }

    return depthBuffer;
  }

  drawBugs(cameraX, cameraY, viewAngle, horizon, depthBuffer) {
    const projected = [];
    for (const bug of this.getBugs()) {
      if (!bug.alive) continue;
      const projection = projectPointToView(
        bug.x,
        bug.y,
        cameraX,
        cameraY,
        viewAngle,
        FIELD_OF_VIEW,
        INNER.width,
        NEAR_DISTANCE,
        FAR_DISTANCE,
      );
      if (projection) projected.push({ bug, ...projection });
    }

    projected.sort((a, b) => b.forward - a.forward);
    for (const item of projected) this.drawBugBillboard(item, horizon, depthBuffer);
  }

  drawBugBillboard(item, horizon, depthBuffer) {
    const { bug, forward, screenX } = item;
    const colors = BUG_COLORS[bug.type] ?? BUG_COLORS.isopod;
    const size = Phaser.Math.Clamp(Math.round(150 / forward), 3, 15);
    const centerX = Math.round(INNER.x + screenX);
    const halfWidth = bug.type === 'fly' ? size : Math.max(2, Math.round(size * 0.62));
    const height = bug.type === 'springtail' ? size + 2 : size;
    const bottom = Math.min(INNER.y + INNER.height - 5, horizon + Math.round(size * 0.45));

    for (let x = centerX - halfWidth; x <= centerX + halfWidth; x += 1) {
      if (x < INNER.x || x >= INNER.x + INNER.width) continue;
      const rayIndex = Phaser.Math.Clamp(
        Math.floor((x - INNER.x) / RAY_WIDTH),
        0,
        RAY_COUNT - 1,
      );
      if (!isDepthVisible(forward, rayIndex, depthBuffer)) continue;

      const normalized = Math.abs((x - centerX) / Math.max(1, halfWidth));
      let columnHeight = Math.max(1, Math.round(height * (1 - normalized * 0.55)));
      if (bug.type === 'fly' && normalized > 0.35) columnHeight = Math.round(height * 0.55);
      const hurtBlink = bug.hurtTimer > 0 && Math.floor(this.elapsed * 24) % 2 === 0;
      const isCenter = Math.abs(x - centerX) <= Math.max(0, Math.floor(size * 0.15));
      this.graphics.fillStyle(hurtBlink ? 0xf7eee1 : isCenter ? colors.accent : colors.main, 1);
      this.graphics.fillRect(x, bottom - columnHeight, 1, columnHeight);
    }

    const centerRay = Phaser.Math.Clamp(
      Math.floor((centerX - INNER.x) / RAY_WIDTH),
      0,
      RAY_COUNT - 1,
    );
    if (!isDepthVisible(forward, centerRay, depthBuffer)) return;

    // A handful of high-contrast pixels keep each prey type recognizable at
    // the inset's intentionally tiny resolution.
    const top = bottom - height;
    if (bug.type === 'fly') {
      this.graphics.fillStyle(0xdce6c3, 0.8);
      this.graphics.fillRect(centerX - halfWidth, top + 2, Math.max(2, halfWidth - 1), 2);
      this.graphics.fillRect(centerX + 2, top + 2, Math.max(2, halfWidth - 1), 2);
      this.graphics.fillStyle(colors.accent, 1);
      this.graphics.fillRect(centerX - 1, top, 3, height);
      this.graphics.fillStyle(0xf7e68c, 1);
      this.graphics.fillRect(centerX, top, 1, 1);
    } else if (bug.type === 'isopod') {
      this.graphics.fillStyle(colors.accent, 1);
      for (let segment = -halfWidth + 2; segment < halfWidth; segment += 3) {
        this.graphics.fillRect(centerX + segment, top + 2, 1, Math.max(2, height - 3));
      }
      this.graphics.fillRect(centerX + halfWidth - 1, top + 1, 1, 1);
    } else {
      this.graphics.fillStyle(colors.accent, 1);
      this.graphics.fillRect(centerX - 1, top + 1, 2, height - 1);
      this.graphics.fillRect(centerX + 1, top - 2, 1, 3);
      this.graphics.fillRect(centerX + 3, top - 3, 1, 3);
      this.graphics.fillRect(centerX - 3, bottom, 6, 1);
    }
  }

  drawSpiderForeground() {
    const g = this.graphics;
    const bottom = INNER.y + INNER.height;
    const lunge = this.spider.isPouncing
      ? Phaser.Math.Clamp(this.spider.pounceTime * 28, 0, 7)
      : 0;
    const center = INNER.x + INNER.width / 2;

    // Jointed forelegs frame the view and bounce forward during a pounce.
    g.lineStyle(3, 0x1b1716, 0.92);
    g.lineBetween(INNER.x + 18, bottom, INNER.x + 38, bottom - 12 - lunge * 0.3);
    g.lineBetween(INNER.x + 38, bottom - 12 - lunge * 0.3, INNER.x + 53, bottom - 8 - lunge);
    g.lineBetween(INNER.x + INNER.width - 18, bottom, INNER.x + INNER.width - 38, bottom - 12 - lunge * 0.3);
    g.lineBetween(
      INNER.x + INNER.width - 38,
      bottom - 12 - lunge * 0.3,
      INNER.x + INNER.width - 53,
      bottom - 8 - lunge,
    );
    g.fillStyle(0x382622, 1);
    g.fillRect(INNER.x + 36, bottom - 14 - lunge * 0.3, 4, 4);
    g.fillRect(INNER.x + INNER.width - 40, bottom - 14 - lunge * 0.3, 4, 4);

    g.fillStyle(0x181414, 0.96);
    g.fillTriangle(center - 28, bottom, center - 9, bottom, center - 12, bottom - 11 - lunge);
    g.fillTriangle(center + 9, bottom, center + 28, bottom, center + 12, bottom - 11 - lunge);
    g.fillStyle(0x6b3e31, 1);
    g.fillRect(center - 13, bottom - 5 - lunge, 3, 6);
    g.fillRect(center + 10, bottom - 5 - lunge, 3, 6);
    g.fillStyle(0xc88c55, 0.75);
    g.fillRect(center - 12, bottom - 5 - lunge, 1, 2);
    g.fillRect(center + 11, bottom - 5 - lunge, 1, 2);
  }

  drawDeathStatic() {
    const g = this.graphics;
    g.fillStyle(0x181515, 0.62);
    g.fillRect(INNER.x, INNER.y, INNER.width, INNER.height);
    const phase = Math.floor(this.elapsed * 30);
    g.fillStyle(0xa27868, 0.45);
    for (let y = INNER.y + (phase % 4); y < INNER.y + INNER.height; y += 6) {
      const width = 20 + ((y * 17 + phase * 13) % 90);
      const x = INNER.x + ((y * 11 + phase * 7) % Math.max(1, INNER.width - width));
      g.fillRect(x, y, width, 1);
    }
  }

  drawInnerBezel() {
    const g = this.graphics;
    g.lineStyle(2, 0x171310, 1);
    g.strokeRect(INNER.x - 1, INNER.y - 1, INNER.width + 2, INNER.height + 2);
    g.lineStyle(1, 0xc9a36a, 0.45);
    g.strokeRect(INNER.x, INNER.y, INNER.width, INNER.height);
  }

  drawVignette() {
    const g = this.graphics;
    g.fillStyle(0x111514, 0.22);
    g.fillRect(INNER.x, INNER.y, 5, INNER.height);
    g.fillRect(INNER.x + INNER.width - 5, INNER.y, 5, INNER.height);
    g.fillRect(INNER.x, INNER.y, INNER.width, 3);
    g.fillRect(INNER.x, INNER.y + INNER.height - 3, INNER.width, 3);
    g.fillStyle(0xdce8c4, 0.1);
    g.fillRect(INNER.x + 8, INNER.y + 5, 1, 30);
    g.fillRect(INNER.x + 11, INNER.y + 5, 18, 1);
  }
}
