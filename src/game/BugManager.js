import Phaser from 'phaser';

const BUG_STATS = {
  fly: { health: 1 },
  springtail: { health: 2 },
  isopod: { health: 3 },
};

export class BugManager {
  constructor(scene, platforms, spider) {
    this.scene = scene;
    this.platforms = platforms;
    this.spider = spider;
    this.bugs = [];
    this.particles = [];
    this.huntedCount = 0;
    this.nextSpawnTime = 0;
    this.maxBugs = 6;

    this.graphics = scene.add.graphics().setDepth(15);
    this.particleGraphics = scene.add.graphics().setDepth(20);

    // Seed the population from generated surfaces instead of fixed coordinates.
    const ground = platforms.find((platform) => platform.h > 10) || platforms[0];
    const branches = platforms.filter((platform) => platform.h <= 10);
    const branchAt = (index) => branches[index % Math.max(1, branches.length)] || ground;
    this.spawnBug('isopod', {
      x: ground.x + ground.w * 0.28,
      y: ground.y,
      platform: ground,
    });
    this.spawnBug('isopod', {
      x: ground.x + ground.w * 0.68,
      y: ground.y,
      platform: ground,
    });
    this.spawnBug('fly', {
      x: branchAt(1).x + branchAt(1).w * 0.65,
      y: Math.max(72, branchAt(1).y - 36),
      platform: branchAt(1),
    });
    this.spawnBug('fly', {
      x: branchAt(3).x + branchAt(3).w * 0.4,
      y: Math.max(72, branchAt(3).y - 48),
      platform: branchAt(3),
    });
    this.spawnBug('springtail', {
      x: branchAt(0).x + branchAt(0).w * 0.5,
      y: branchAt(0).y,
      platform: branchAt(0),
    });
    this.spawnBug('springtail', {
      x: branchAt(2).x + branchAt(2).w * 0.55,
      y: branchAt(2).y,
      platform: branchAt(2),
    });
  }

  spawnBug(type, initialPos = null) {
    const validPlatforms = this.platforms.filter((p) => p.h <= 74);
    const chosenPlatform = initialPos?.platform
      || Phaser.Math.RND.pick(validPlatforms)
      || this.platforms[0];

    const spawnX = initialPos
      ? initialPos.x
      : Phaser.Math.Between(chosenPlatform.x + 10, chosenPlatform.x + chosenPlatform.w - 10);
    const spawnY = initialPos
      ? initialPos.y
      : (type === 'fly' ? Phaser.Math.Between(80, 280) : chosenPlatform.y);

    const bug = {
      type,
      x: spawnX,
      y: spawnY,
      vx: 0,
      vy: 0,
      facing: Phaser.Math.RND.pick([-1, 1]),
      platform: chosenPlatform,
      state: 'idle', // idle, walk, hop, fly, rest
      timer: Phaser.Math.FloatBetween(1, 3),
      animTime: Math.random() * 10,
      alive: true,
      scale: 1,
      maxHealth: BUG_STATS[type]?.health ?? 1,
      health: BUG_STATS[type]?.health ?? 1,
      hitCooldown: 0,
      hurtTimer: 0,
      // Type-specific properties
      flightTarget: new Phaser.Math.Vector2(spawnX, spawnY),
      wingPhase: Math.random() * Math.PI * 2,
    };

    this.bugs.push(bug);
  }

  update(dt) {
    const now = this.scene.time.now / 1000;

    // Respawn bugs if needed
    if (this.bugs.length < this.maxBugs && now > this.nextSpawnTime) {
      const types = ['isopod', 'fly', 'springtail'];
      this.spawnBug(Phaser.Math.RND.pick(types));
      this.nextSpawnTime = now + Phaser.Math.FloatBetween(3, 6);
    }

    // Update each bug
    for (const bug of this.bugs) {
      if (!bug.alive) continue;
      bug.animTime += dt;
      bug.hitCooldown = Math.max(0, bug.hitCooldown - dt);
      bug.hurtTimer = Math.max(0, bug.hurtTimer - dt);

      if (bug.type === 'isopod') {
        this.updateIsopod(bug, dt);
      } else if (bug.type === 'fly') {
        this.updateFly(bug, dt);
      } else if (bug.type === 'springtail') {
        this.updateSpringtail(bug, dt);
      }

      this.checkSpiderHunt(bug);
    }

    // Remove dead bugs
    this.bugs = this.bugs.filter((b) => b.alive);

    // Update hunt particles
    this.updateParticles(dt);

    // Draw bugs & particles
    this.draw();
  }

  updateIsopod(bug, dt) {
    const p = bug.platform;
    const spiderDist = Phaser.Math.Distance.Between(bug.x, bug.y, this.spider.position.x, this.spider.position.y);

    // Flee if spider walks very close
    if (spiderDist < 45) {
      bug.facing = bug.x < this.spider.position.x ? -1 : 1;
      bug.state = 'walk';
      bug.timer = 1.5;
      bug.speedMultiplier = 1.8;
    } else {
      bug.speedMultiplier = 1.0;
    }

    bug.timer -= dt;
    if (bug.timer <= 0) {
      bug.state = Math.random() < 0.65 ? 'walk' : 'idle';
      bug.timer = Phaser.Math.FloatBetween(1.2, 3.5);
      if (Math.random() < 0.4) bug.facing = -bug.facing;
    }

    if (bug.state === 'walk') {
      const walkSpeed = 16 * bug.speedMultiplier;
      bug.x += bug.facing * walkSpeed * dt;

      // Platform edges
      const minX = p.x + 6;
      const maxX = p.x + p.w - 6;
      if (bug.x <= minX) {
        bug.x = minX;
        bug.facing = 1;
      } else if (bug.x >= maxX) {
        bug.x = maxX;
        bug.facing = -1;
      }
    }
    bug.y = p.y;
  }

  updateFly(bug, dt) {
    bug.wingPhase += dt * 38;
    const spiderDist = Phaser.Math.Distance.Between(bug.x, bug.y, this.spider.position.x, this.spider.position.y);

    // Panic take-off or dart away if spider is close
    if (spiderDist < 55 && (bug.state === 'rest' || Math.random() < 0.1)) {
      bug.state = 'fly';
      const escapeAngle = Phaser.Math.Angle.Between(this.spider.position.x, this.spider.position.y, bug.x, bug.y);
      bug.flightTarget.set(
        Phaser.Math.Clamp(bug.x + Math.cos(escapeAngle) * 90, 40, 728),
        Phaser.Math.Clamp(bug.y + Math.sin(escapeAngle) * 70, 50, 320)
      );
      bug.timer = Phaser.Math.FloatBetween(2, 4);
    }

    bug.timer -= dt;
    if (bug.timer <= 0) {
      if (bug.state === 'fly') {
        // Chance to land on a platform or choose new air target
        if (Math.random() < 0.35) {
          const validPlatforms = this.platforms.filter((p) => p.h <= 10 && p.y > 100);
          const p = Phaser.Math.RND.pick(validPlatforms);
          if (p) {
            bug.platform = p;
            bug.flightTarget.set(Phaser.Math.Between(p.x + 8, p.x + p.w - 8), p.y);
          }
        } else {
          bug.flightTarget.set(
            Phaser.Math.Between(50, 718),
            Phaser.Math.Between(60, 310)
          );
        }
        bug.timer = Phaser.Math.FloatBetween(2.5, 5);
      } else {
        // Take off from resting
        bug.state = 'fly';
        bug.flightTarget.set(
          Phaser.Math.Between(50, 718),
          Phaser.Math.Between(60, 310)
        );
        bug.timer = Phaser.Math.FloatBetween(3, 6);
      }
    }

    if (bug.state === 'fly') {
      const dx = bug.flightTarget.x - bug.x;
      const dy = bug.flightTarget.y - bug.y;
      const dist = Math.hypot(dx, dy);

      if (dist < 4) {
        if (bug.platform && Math.abs(bug.flightTarget.y - bug.platform.y) < 2) {
          bug.state = 'rest';
          bug.y = bug.platform.y;
          bug.timer = Phaser.Math.FloatBetween(2, 5);
        } else {
          bug.flightTarget.set(
            Phaser.Math.Between(50, 718),
            Phaser.Math.Between(60, 310)
          );
        }
      } else {
        const speed = 42;
        bug.vx = (dx / dist) * speed;
        bug.vy = (dy / dist) * speed;

        // Gentle sine-wave hover flutter
        const hoverY = Math.sin(bug.animTime * 6) * 12;
        bug.x += bug.vx * dt;
        bug.y += (bug.vy + hoverY) * dt;

        if (Math.abs(bug.vx) > 2) {
          bug.facing = Math.sign(bug.vx);
        }
      }
    }
  }

  updateSpringtail(bug, dt) {
    const p = bug.platform;
    const spiderDist = Phaser.Math.Distance.Between(bug.x, bug.y, this.spider.position.x, this.spider.position.y);

    // Emergency hop if spider approaches
    if (spiderDist < 40 && bug.state !== 'hop') {
      bug.facing = bug.x < this.spider.position.x ? -1 : 1;
      bug.state = 'hop';
      bug.vx = bug.facing * Phaser.Math.Between(45, 75);
      bug.vy = -Phaser.Math.Between(65, 110);
      bug.timer = 1.0;
    }

    if (bug.state === 'hop') {
      bug.vy += 320 * dt; // gravity
      bug.x += bug.vx * dt;
      bug.y += bug.vy * dt;

      // Check landing on platforms
      for (const plat of this.platforms) {
        if (
          bug.vy >= 0 &&
          bug.x >= plat.x &&
          bug.x <= plat.x + plat.w &&
          bug.y >= plat.y - 2 &&
          bug.y <= plat.y + 8
        ) {
          bug.y = plat.y;
          bug.platform = plat;
          bug.state = 'idle';
          bug.timer = Phaser.Math.FloatBetween(1, 2.5);
          break;
        }
      }

      // Keep inside world
      bug.x = Phaser.Math.Clamp(bug.x, 30, 738);
      if (bug.y > 358) {
        bug.y = 358;
        bug.platform = this.platforms[0];
        bug.state = 'idle';
        bug.timer = Phaser.Math.FloatBetween(1, 2.5);
      }
    } else {
      bug.timer -= dt;
      if (bug.timer <= 0) {
        const roll = Math.random();
        if (roll < 0.3) {
          // Hop!
          bug.state = 'hop';
          bug.facing = Math.random() < 0.5 ? -1 : 1;
          bug.vx = bug.facing * Phaser.Math.Between(35, 60);
          bug.vy = -Phaser.Math.Between(50, 85);
        } else if (roll < 0.75) {
          bug.state = 'walk';
          bug.facing = Math.random() < 0.5 ? -1 : 1;
          bug.timer = Phaser.Math.FloatBetween(0.8, 2.2);
        } else {
          bug.state = 'idle';
          bug.timer = Phaser.Math.FloatBetween(1, 3);
        }
      }

      if (bug.state === 'walk') {
        bug.x += bug.facing * 18 * dt;
        const minX = p.x + 5;
        const maxX = p.x + p.w - 5;
        if (bug.x <= minX) {
          bug.x = minX;
          bug.facing = 1;
        } else if (bug.x >= maxX) {
          bug.x = maxX;
          bug.facing = -1;
        }
      }
      bug.y = p.y;
    }
  }

  checkSpiderHunt(bug) {
    if (this.spider.isDead) return;

    const head = this.spider.headPosition;
    const body = this.spider.position;

    const headDist = Phaser.Math.Distance.Between(bug.x, bug.y, head.x, head.y);
    const bodyDist = Phaser.Math.Distance.Between(bug.x, bug.y, body.x, body.y);

    // Spider hunts if jaws hit bug, or if pouncing and body passes near bug
    const isPouncing = this.spider.isPouncing;
    const huntRadius = (isPouncing ? 22 : 12) * this.spider.growthScale;
    const bodyRadius = 20 * this.spider.growthScale;

    if (
      bug.hitCooldown <= 0 &&
      (headDist <= huntRadius || (isPouncing && bodyDist <= bodyRadius))
    ) {
      this.damageBug(bug, isPouncing ? 3 : 1);
    }
  }

  damageBug(bug, damage) {
    bug.health = Math.max(0, bug.health - damage);
    bug.hitCooldown = 0.35;
    bug.hurtTimer = 0.18;

    if (bug.health <= 0) {
      this.catchBug(bug);
      return;
    }

    bug.facing = bug.x < this.spider.position.x ? -1 : 1;
    if (bug.type === 'fly') {
      bug.state = 'fly';
    } else if (bug.type === 'springtail') {
      bug.state = 'hop';
      bug.vx = bug.facing * 70;
      bug.vy = -90;
    } else {
      bug.state = 'walk';
      bug.timer = 1.5;
      bug.speedMultiplier = 2.2;
    }
  }

  catchBug(bug) {
    bug.alive = false;
    this.huntedCount += 1;
    this.spider.consumePrey(bug);

    // Spawn crunchy nutrient particles
    const particleColors = {
      isopod: [0x8c8c9e, 0xa5a5b8, 0x6e6e80],
      fly: [0xf6e886, 0xfffbb5, 0xd2c050],
      springtail: [0x97e35b, 0x6fbd35, 0xc2f788],
    }[bug.type] || [0xa5a5b8];

    for (let i = 0; i < 14; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Phaser.Math.FloatBetween(20, 80);
      this.particles.push({
        x: bug.x,
        y: bug.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 20,
        color: Phaser.Math.RND.pick(particleColors),
        size: Phaser.Math.Between(1, 3),
        alpha: 1,
        life: Phaser.Math.FloatBetween(0.35, 0.75),
        maxLife: 0.75,
      });
    }

    // Tiny floating capture ring / pulse
    this.particles.push({
      x: bug.x,
      y: bug.y,
      isRing: true,
      radius: 3,
      alpha: 1,
      life: 0.35,
      maxLife: 0.35,
      color: particleColors[0],
    });

    // Notify scene / trigger chelicerae satisfaction
    if (this.onBugHunted) {
      this.onBugHunted(this.huntedCount, bug);
    }
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      p.life -= dt;
      p.alpha = Math.max(0, p.life / p.maxLife);
      if (p.isRing) {
        p.radius += dt * 45;
      } else {
        p.vy += 120 * dt; // gravity
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  draw() {
    this.graphics.clear();
    this.particleGraphics.clear();

    // Draw bugs
    for (const bug of this.bugs) {
      if (!bug.alive) continue;
      const bx = Math.round(bug.x);
      const by = Math.round(bug.y);

      if (bug.type === 'isopod') {
        this.drawIsopod(bx, by, bug);
      } else if (bug.type === 'fly') {
        this.drawFly(bx, by, bug);
      } else if (bug.type === 'springtail') {
        this.drawSpringtail(bx, by, bug);
      }

      this.drawHealthBar(bx, by, bug);
    }

    // Draw particles
    for (const p of this.particles) {
      if (p.isRing) {
        this.particleGraphics.lineStyle(1, p.color, p.alpha);
        this.particleGraphics.strokeCircle(p.x, p.y, p.radius);
      } else {
        this.particleGraphics.fillStyle(p.color, p.alpha);
        this.particleGraphics.fillRect(
          Math.round(p.x),
          Math.round(p.y),
          p.size,
          p.size
        );
      }
    }
  }

  drawHealthBar(x, y, bug) {
    if (bug.health >= bug.maxHealth && bug.hurtTimer <= 0) return;

    const width = 8;
    const ratio = bug.health / bug.maxHealth;
    this.graphics.fillStyle(0x332b38, 0.9);
    this.graphics.fillRect(x - width / 2, y - 10, width, 2);
    this.graphics.fillStyle(bug.hurtTimer > 0 ? 0xffffff : 0xa8df78, 1);
    this.graphics.fillRect(x - width / 2, y - 10, width * ratio, 1);
  }

  drawIsopod(x, y, bug) {
    const g = this.graphics;
    const f = bug.facing;
    const walkBob = bug.state === 'walk' ? Math.sin(bug.animTime * 18) * 0.5 : 0;

    // Segmented slate-grey shell (6px x 4px)
    g.fillStyle(0x4c4c59, 1);
    g.fillRect(x - 3, y - 4 + walkBob, 6, 4);

    // Shell segment highlights
    g.fillStyle(0x78788a, 1);
    g.fillRect(x - 2, y - 4 + walkBob, 4, 1);
    g.fillRect(x - 3 * f, y - 3 + walkBob, 2, 2);

    // Tiny legs
    const legPhase = Math.sin(bug.animTime * 22);
    g.fillStyle(0x353540, 1);
    g.fillRect(x - 2, y + (legPhase > 0 ? -1 : 0), 1, 1);
    g.fillRect(x, y + (legPhase <= 0 ? -1 : 0), 1, 1);
    g.fillRect(x + 2, y + (legPhase > 0 ? -1 : 0), 1, 1);

    // Antennae
    g.lineStyle(1, 0x6e6e80, 1);
    const antWave = Math.sin(bug.animTime * 10) * 1.5;
    g.lineBetween(x + 3 * f, y - 2, x + 5 * f, y - 4 + antWave);
  }

  drawFly(x, y, bug) {
    const g = this.graphics;
    const wingUp = Math.sin(bug.wingPhase) > 0;

    // Soft warm glow halo
    g.fillStyle(0xf6e886, 0.35);
    g.fillCircle(x, y - 2, 4);

    // Tiny fly body (2px x 3px)
    g.fillStyle(0x443a28, 1);
    g.fillRect(x - 1, y - 3, 2, 3);
    g.fillStyle(0xf6e886, 1);
    g.fillRect(x - 1, y - 2, 2, 1);

    // Fluttering translucent wings
    g.fillStyle(0xffffff, 0.85);
    if (bug.state === 'fly') {
      if (wingUp) {
        g.fillRect(x - 2, y - 6, 2, 3);
        g.fillRect(x, y - 6, 2, 3);
      } else {
        g.fillRect(x - 3, y - 2, 2, 2);
        g.fillRect(x + 1, y - 2, 2, 2);
      }
    } else {
      // Folded resting wings
      g.fillRect(x - 2, y - 3, 4, 1);
    }
  }

  drawSpringtail(x, y, bug) {
    const g = this.graphics;
    const f = bug.facing;

    // Vibrant green teardrop body (4px x 3px)
    g.fillStyle(0x5a9e2d, 1);
    g.fillRect(x - 2, y - 3, 4, 3);
    g.fillStyle(0x8deb46, 1);
    g.fillRect(x - 1, y - 3, 2, 1);

    // Eye
    g.fillStyle(0x1a2e10, 1);
    g.fillRect(x + 1 * f, y - 3, 1, 1);

    // Tiny legs
    g.fillStyle(0x3e6e1e, 1);
    g.fillRect(x - 1, y, 1, 1);
    g.fillRect(x + 1, y, 1, 1);

    // Springtail furcula (tail)
    if (bug.state === 'hop') {
      g.lineStyle(1, 0x487d24, 1);
      g.lineBetween(x - 2 * f, y - 1, x - 4 * f, y + 2);
    }
  }
}
