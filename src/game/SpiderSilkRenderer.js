import { buildSilkPath, getSwayedWebPoint, swaySilkPath } from './spiderSilkMath.js';

const MAX_WEBS = 24;
const MIN_WEB_LENGTH = 8;
const SILK_GRAB_DISTANCE = 15;

export class SpiderSilkRenderer {
  constructor(scene, spider) {
    this.scene = scene;
    this.spider = spider;
    this.webs = [];
    this.activeWeb = null;
    this.nextSeed = 1;
    this.previous = this.snapshotSpider();
    this.graphics = scene.add.graphics().setDepth(7);
    this.attachedWeb = null;
    spider.silkTraversal = this;
  }

  snapshotSpider() {
    return {
      x: this.spider.position.x,
      y: this.spider.position.y,
      grounded: this.spider.grounded,
      surfaceType: this.spider.surfaceType,
      surfacePlatform: this.spider.surfacePlatform,
      surfaceSide: this.spider.surfaceSide,
      isPouncing: this.spider.isPouncing,
    };
  }

  surfacePoint(snapshot) {
    const platform = snapshot.surfacePlatform;
    if (!platform) return { x: snapshot.x, y: snapshot.y };
    if (snapshot.surfaceType === 'ceiling') {
      return {
        x: Math.max(platform.x, Math.min(platform.x + platform.w, snapshot.x)),
        y: platform.y + platform.h,
      };
    }
    if (snapshot.surfaceType === 'wall') {
      return {
        x: snapshot.surfaceSide === 1 ? platform.x : platform.x + platform.w,
        y: Math.max(platform.y, Math.min(platform.y + platform.h, snapshot.y)),
      };
    }
    if (snapshot.surfaceType === 'floor') {
      return {
        x: Math.max(platform.x, Math.min(platform.x + platform.w, snapshot.x)),
        y: platform.y,
      };
    }
    return { x: snapshot.x, y: snapshot.y };
  }

  beginWeb(snapshot) {
    this.activeWeb = {
      start: this.surfacePoint(snapshot),
      end: { x: this.spider.position.x, y: this.spider.position.y },
      startSurface: {
        type: snapshot.surfaceType,
        platform: snapshot.surfacePlatform,
        side: snapshot.surfaceSide,
      },
      seed: this.nextSeed,
    };
    this.nextSeed += 1;
  }

  finishWeb(snapshot) {
    if (!this.activeWeb) return;
    this.activeWeb.end = this.surfacePoint(snapshot);
    this.activeWeb.endSurface = {
      type: snapshot.surfaceType,
      platform: snapshot.surfacePlatform,
      side: snapshot.surfaceSide,
    };
    const distance = Math.hypot(
      this.activeWeb.end.x - this.activeWeb.start.x,
      this.activeWeb.end.y - this.activeWeb.start.y,
    );
    if (distance >= MIN_WEB_LENGTH) {
      this.webs.push(this.activeWeb);
      if (this.webs.length > MAX_WEBS) this.webs.shift();
    }
    this.activeWeb = null;
  }

  nearestWeb() {
    let nearest = null;
    for (const web of this.webs) {
      const dx = web.end.x - web.start.x;
      const dy = web.end.y - web.start.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared === 0) continue;
      const progress = Math.max(0, Math.min(1, (
        (this.spider.position.x - web.start.x) * dx
        + (this.spider.position.y - web.start.y) * dy
      ) / lengthSquared));
      const x = web.start.x + dx * progress;
      const y = web.start.y + dy * progress;
      const distance = Math.hypot(this.spider.position.x - x, this.spider.position.y - y);
      if (!nearest || distance < nearest.distance) nearest = { web, progress, distance };
    }
    return nearest;
  }

  hasNearbyWeb(maxDistance = SILK_GRAB_DISTANCE) {
    return (this.nearestWeb()?.distance ?? Infinity) <= maxDistance;
  }

  attachToEndpoint(surface, point) {
    const spider = this.spider;
    this.attachedWeb = null;
    if (!surface?.platform) {
      spider.detachFromSurface();
      return;
    }
    spider.surfaceType = surface.type;
    spider.surfacePlatform = surface.platform;
    spider.surfaceSide = surface.side;
    spider.surfaceAngle = surface.type === 'wall'
      ? (surface.side === 1 ? -Math.PI / 2 : Math.PI / 2)
      : (surface.type === 'ceiling' ? Math.PI : 0);
    spider.position.set(point.x, point.y);
    if (surface.type === 'floor') spider.position.y -= spider.bodyHalfHeight;
    if (surface.type === 'ceiling') spider.position.y += spider.bodyHalfHeight;
    if (surface.type === 'wall') {
      spider.position.x += surface.side === 1 ? -spider.bodyHalfWidth : spider.bodyHalfWidth;
    }
    spider.velocity.set(0, 0);
    spider.surfaceVelocity = 0;
    spider.grounded = true;
    spider.plantAllFeet();
  }

  updateSpiderClimb(dt, input) {
    const spider = this.spider;
    const timeMs = this.scene?.time?.now ?? 0;
    if (!this.attachedWeb) {
      if (input.moveY >= 0 || spider.isPouncing || spider.cornerTransition) return false;
      const nearest = this.nearestWeb();
      if (!nearest || nearest.distance > SILK_GRAB_DISTANCE) return false;
      this.attachedWeb = { web: nearest.web, progress: nearest.progress };
      const swayed = getSwayedWebPoint(nearest.web, nearest.progress, timeMs);
      spider.surfaceType = 'silk';
      spider.surfacePlatform = nearest.web;
      spider.surfaceSide = 0;
      spider.surfaceAngle = swayed.angle;
      if (input.moveY !== 0) spider.facing = Math.sign(input.moveY);
      spider.plantAllFeet();
    }

    if (input.moveX !== 0) {
      this.attachedWeb = null;
      spider.detachFromSurface();
      spider.velocity.set(input.moveX * spider.moveSpeed * 0.65, 0);
      spider.attachCooldown = 0.15;
      return false;
    }

    const { web } = this.attachedWeb;
    const dx = web.end.x - web.start.x;
    const dy = web.end.y - web.start.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    this.attachedWeb.progress = Math.max(0, Math.min(
      1,
      this.attachedWeb.progress + input.moveY * spider.moveSpeed * dt / length,
    ));
    const progress = this.attachedWeb.progress;

    if (progress <= 0 && input.moveY < 0) {
      this.attachToEndpoint(web.startSurface, web.start);
      return true;
    }
    if (progress >= 1 && input.moveY > 0) {
      this.attachToEndpoint(web.endSurface, web.end);
      return true;
    }

    const swayed = getSwayedWebPoint(web, progress, timeMs);
    spider.position.set(swayed.x, swayed.y);
    spider.velocity.set(0, 0);
    spider.grounded = true;
    spider.surfaceType = 'silk';
    spider.surfacePlatform = web;
    spider.surfaceSide = 0;
    spider.surfaceAngle = swayed.angle;
    spider.surfaceVelocity = input.moveY * spider.moveSpeed;
    if (input.moveY !== 0) spider.facing = Math.sign(input.moveY);
    return true;
  }

  update(timeMs = this.scene.time?.now ?? 0) {
    const current = this.snapshotSpider();
    const leftClingingSurface = this.previous.grounded
      && ['ceiling', 'wall'].includes(this.previous.surfaceType)
      && !current.grounded
      && !current.isPouncing;

    if (!this.activeWeb && leftClingingSurface) this.beginWeb(this.previous);

    if (this.activeWeb) {
      if (current.grounded) this.finishWeb(current);
      else this.activeWeb.end = { x: current.x, y: current.y };
    }

    if (this.attachedWeb && this.spider.surfaceType === 'silk') {
      const swayed = getSwayedWebPoint(this.attachedWeb.web, this.attachedWeb.progress, timeMs);
      this.spider.position.set(swayed.x, swayed.y);
      this.spider.surfaceAngle = swayed.angle;
    }

    this.previous = current;
    this.draw(timeMs);
  }

  drawPath(points, color, alpha) {
    if (!points || points.length < 2) return;
    this.graphics.lineStyle(1, color, alpha);
    this.graphics.beginPath();
    this.graphics.moveTo(Math.round(points[0].x), Math.round(points[0].y));
    for (let index = 1; index < points.length; index += 1) {
      this.graphics.lineTo(Math.round(points[index].x), Math.round(points[index].y));
    }
    this.graphics.strokePath();
  }

  drawWeb(web, timeMs) {
    if (!web?.start || !web?.end) return;
    const path = swaySilkPath(
      buildSilkPath(web.start, web.end, web.seed),
      timeMs,
      web.seed,
    );
    this.drawPath(path, 0xf0f6f8, 0.75);
    const shadowPath = path.map((point) => ({ x: point.x + 0.5, y: point.y + 0.5 }));
    this.drawPath(shadowPath, 0xaec2c6, 0.35);
  }

  draw(timeMs = this.scene.time?.now ?? 0) {
    this.graphics.clear();
    for (const web of this.webs) this.drawWeb(web, timeMs);
    if (this.activeWeb) this.drawWeb(this.activeWeb, timeMs);
  }

  destroy() {
    this.graphics.destroy();
    if (this.spider.silkTraversal === this) this.spider.silkTraversal = null;
    this.webs = [];
    this.activeWeb = null;
    this.attachedWeb = null;
  }
}
