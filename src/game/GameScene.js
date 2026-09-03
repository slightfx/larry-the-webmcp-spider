import Phaser from 'phaser';
import { ProceduralSpider } from '../spider/ProceduralSpider.js';
import { BugManager } from './BugManager.js';
import { SpiderVisionRenderer } from './SpiderVisionRenderer.js';
import { SpiderWebMcpController } from './SpiderWebMcpController.js';
import { SpiderManualToolPanel } from './SpiderManualToolPanel.js';
import { SpiderCommandPanel } from './SpiderCommandPanel.js';
import { SpiderHelpPanel } from './SpiderHelpPanel.js';
import { SpiderGoalMarker } from './SpiderGoalMarker.js';
import { SpiderSilkRenderer } from './SpiderSilkRenderer.js';
import { SpiderMovementSound } from './SpiderMovementSound.js';
import { WormManager } from './WormManager.js';
import {
  generateProceduralTerrain,
  getTerrainSway,
} from './proceduralTerrain.js';

const WORLD_WIDTH = 768;
const WORLD_HEIGHT = 432;
const HABITAT_LEFT = 24;
const HABITAT_RIGHT = 744;
const GROUND_Y = 358;

export class GameScene extends Phaser.Scene {
  constructor() {
    super('game');
  }

  create() {
    this.deathRestartAt = 0;
    this.cameras.main.setBackgroundColor('#bfd3b5');
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    const requestedSeed = new URLSearchParams(globalThis.location?.search || '').get('seed');
    const terrainSeed = requestedSeed || Phaser.Math.RND.integerInRange(1, 0x7fffffff);
    const terrainOptions = {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      groundY: GROUND_Y,
    };
    this.terrain = generateProceduralTerrain(terrainSeed, terrainOptions);
    this.platforms = this.terrain.platforms;
    this.climbables = this.terrain.climbables;

    this.drawTerrariumBackground();
    this.drawHabitat();
    this.wormManager = new WormManager(this, {
      groundY: GROUND_Y,
      width: WORLD_WIDTH,
      seed: this.terrain.seed,
    });
    this.terrainMotionGraphics = this.add.graphics().setDepth(4);
    this.updateTerrainMotion(0);
    this.createFloatingMotes();
    this.drawGlassFrame();

    this.spider = new ProceduralSpider(
      this,
      this.terrain.spawnX,
      GROUND_Y - 11,
      this.platforms,
      this.climbables,
      { stones: this.terrain.decorations.stones, groundY: GROUND_Y },
    );
    this.spiderMovementSound = new SpiderMovementSound(this.sound, this.spider);
    this.spiderSilkRenderer = new SpiderSilkRenderer(this, this.spider);

    this.bugManager = new BugManager(this, this.platforms, this.spider);
    this.spiderVision = new SpiderVisionRenderer(this, {
      spider: this.spider,
      platforms: this.platforms,
      climbables: this.climbables,
      getBugs: () => this.bugManager.bugs,
      bounds: {
        left: HABITAT_LEFT,
        right: HABITAT_RIGHT,
        top: 14,
        bottom: 418,
      },
    });
    this.bugManager.onBugHunted = (count, bug) => {
      this.huntText.setText(`PREY HUNTED: ${count}`);
      this.spiderVision.playKillAnimation(bug);
      this.cameras.main.shake(80, 0.002);
      this.tweens.add({
        targets: this.huntText,
        scale: 1.25,
        duration: 100,
        yoyo: true,
        ease: 'Quad.Out',
      });
    };
    this.spider.onDamaged = (damage) => {
      this.cameras.main.shake(120, Math.min(0.009, 0.002 + damage * 0.0002));
      this.cameras.main.flash(90, 126, 44, 55, false);
      this.spiderVision.flashDamage();
    };

    this.webMcpController = new SpiderWebMcpController(this);
    this.spiderGoalMarker = new SpiderGoalMarker(this, this.webMcpController);
    this.spiderHelpPanel = new SpiderHelpPanel();
    this.spiderManualToolPanel = new SpiderManualToolPanel(this.webMcpController);
    this.spiderCommandPanel = new SpiderCommandPanel(this.webMcpController, {
      onPlanUpdate: (route) => this.spiderGoalMarker.setPlanRoute(route),
    });
    this.layoutControlDialogs = () => {
      const manual = this.spiderManualToolPanel.form;
      const command = this.spiderCommandPanel.form;
      const appRect = document.getElementById('app')?.getBoundingClientRect();
      if (!appRect?.height) return;
      const left = '7%';
      const width = '42%';
      const manualTop = appRect.height * 0.11;
      manual.style.left = left;
      manual.style.width = width;
      manual.style.top = `${manualTop}px`;
      command.style.left = left;
      command.style.width = width;
      command.style.top = `${manualTop + manual.getBoundingClientRect().height + 1}px`;
    };
    this.onDialogLayoutChange = () => requestAnimationFrame(this.layoutControlDialogs);
    this.spiderManualToolPanel.form.addEventListener('dialog-layout-change', this.onDialogLayoutChange);
    this.spiderCommandPanel.form.addEventListener('dialog-layout-change', this.onDialogLayoutChange);
    window.addEventListener('spider-access-mode-change', this.onDialogLayoutChange);
    this.layoutControlDialogs();
    requestAnimationFrame(this.layoutControlDialogs);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.webMcpController.destroy();
      this.spiderGoalMarker.destroy();
      this.spiderHelpPanel.destroy();
      this.spiderManualToolPanel.destroy();
      this.spiderCommandPanel.destroy();
      this.spiderManualToolPanel.form.removeEventListener('dialog-layout-change', this.onDialogLayoutChange);
      this.spiderCommandPanel.form.removeEventListener('dialog-layout-change', this.onDialogLayoutChange);
      window.removeEventListener('spider-access-mode-change', this.onDialogLayoutChange);
      this.spiderSilkRenderer.destroy();
      this.wormManager.destroy();
    });

    this.add
      .text(28, 22, 'MOSS HOUSE  02', {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#425744',
      })
      .setDepth(1100);

    this.add
      .text(28, 34, `HABITAT ${this.terrain.seed.toString(16).toUpperCase().padStart(8, '0')}`, {
        fontFamily: 'monospace',
        fontSize: '7px',
        color: '#6d816a',
      })
      .setDepth(1100);

    this.huntText = this.add
      .text(140, 22, 'PREY HUNTED: 0', {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#557252',
      })
      .setDepth(1100);

    this.statusText = this.add
      .text(270, 22, '', {
        fontFamily: 'monospace',
        fontSize: '9px',
        color: '#557252',
      })
      .setDepth(1100);

  }

  update(_time, delta) {
    const dt = Math.min(delta / 1000, 1 / 30);
    this.webMcpController.processAutomation();
    this.webMcpController.processActionQueue(this.time.now);
    const webInput = this.webMcpController.consumeInput(this.time.now);
    const { moveX, moveY, attackPressed } = webInput;

    if (this.webMcpController.consumeRestart()) {
      this.scene.restart();
      return;
    }

    this.spider.update(dt, { moveX, moveY, attackPressed });
    this.spiderMovementSound.update(dt);
    this.updateTerrainMotion(_time);
    this.wormManager.update(dt);
    this.spiderSilkRenderer.update(_time);
    this.webMcpController.syncState();
    this.spiderGoalMarker.update();
    this.spiderManualToolPanel.update();
    this.bugManager.update(dt);
    this.keepSpiderInsideGlass();
    this.updateStatusText();
    this.spiderVision.update(dt);

    if (this.spider.isDead) {
      if (!this.deathRestartAt) this.deathRestartAt = this.time.now + 900;
      if (this.time.now >= this.deathRestartAt) this.scene.restart();
      return;
    }

    if (this.spider.position.y > WORLD_HEIGHT + 48) this.scene.restart();
  }

  updateStatusText() {
    const size = Math.round(this.spider.growthScale * 100);
    const speed = Math.round(this.spider.moveSpeed);
    const prefix = this.spider.isDead ? 'KNOCKED OUT  ' : '';
    this.statusText.setText(
      `${prefix}HP ${this.spider.health}/${this.spider.maxHealth}  ` +
      `SIZE ${size}%  SPEED ${speed}`,
    );
  }

  explodeAndRespawnSpider() {
    if (this.spiderRespawning) return;
    this.spiderRespawning = true;
    const spider = this.spider;
    const origin = { x: spider.position.x, y: spider.position.y };
    const cubes = [];
    const colors = [0xb52f3d, 0xd9414e, 0x8f2032, 0xe85b63];
    for (let index = 0; index < 18; index += 1) {
      const cube = this.add.rectangle(origin.x, origin.y, 3, 3, colors[index % colors.length])
        .setDepth(40);
      cubes.push(cube);
      const angle = (Math.PI * 2 * index) / 18;
      const distance = 18 + (index % 5) * 5;
      this.tweens.add({
        targets: cube,
        x: origin.x + Math.cos(angle) * distance,
        y: origin.y + Math.sin(angle) * distance - 8,
        angle: 180 + index * 20,
        alpha: 0,
        duration: 520 + (index % 4) * 45,
        ease: 'Cubic.Out',
        onComplete: () => cube.destroy(),
      });
    }
    [spider.graphicsShadow, spider.graphicsFar, spider.graphicsBody, spider.graphicsNear,
      spider.graphicsAttackBubble, spider.attackBubbleText, spider.graphicsCommandBubble,
      spider.commandBubbleText].forEach((displayObject) => displayObject?.setVisible(false));
    // Do not carry the loop warning bubble through the respawn animation.
    spider.commandBubbleTimer = 0;
    spider.attackBubbleTimer = 0;
    this.time.delayedCall(720, () => {
      const ground = this.platforms.find((platform) => platform.h > 10) || this.platforms[0];
      const x = Math.max(30, Math.min(738, origin.x));
      spider.respawnAt(x, (ground?.y || 358) - spider.bodyHalfHeight);
      [spider.graphicsShadow, spider.graphicsFar, spider.graphicsBody, spider.graphicsNear]
        .forEach((displayObject) => displayObject?.setVisible(true));
      [spider.graphicsAttackBubble, spider.attackBubbleText, spider.graphicsCommandBubble,
        spider.commandBubbleText].forEach((displayObject) => displayObject?.setVisible(true));
      this.spiderRespawning = false;
      this.webMcpController.loopTransitionCounts.clear();
      this.webMcpController.loopRecoveryActive = false;
      this.webMcpController.syncState();
    });
  }

  keepSpiderInsideGlass() {
    const now = this.time.now;
    const edgeCooldown = this.edgeRecoveryAt || 0;
    if (this.spider.position.x < HABITAT_LEFT) {
      this.spider.position.x = HABITAT_LEFT;
      this.spider.velocity.x = Math.max(0, this.spider.velocity.x);
      if (now >= edgeCooldown && !this.spider.isDead) {
        this.recoverFromEdge('right');
      }
    } else if (this.spider.position.x > HABITAT_RIGHT) {
      this.spider.position.x = HABITAT_RIGHT;
      this.spider.velocity.x = Math.min(0, this.spider.velocity.x);
      if (now >= edgeCooldown && !this.spider.isDead) {
        this.recoverFromEdge('left');
      }
    }
  }

  recoverFromEdge(direction) {
    this.edgeRecoveryAt = this.time.now + 1400;
    const duration = Phaser.Math.Between(500, 1200);
    [this.spider.graphicsShadow, this.spider.graphicsFar, this.spider.graphicsBody,
      this.spider.graphicsNear].forEach((displayObject) => displayObject?.setVisible(true));
    const available = this.webMcpController.getState?.().available_directions || [];
    if (!available.includes(direction)) {
      const inward = direction === 'left' ? 18 : -18;
      const x = Phaser.Math.Clamp(this.spider.position.x + inward, HABITAT_LEFT + 8, HABITAT_RIGHT - 8);
      this.spider.position.x = x;
      this.spider.facing = inward < 0 ? -1 : 1;
      const body = this.spider.body;
      if (body && this.matter?.body?.setPosition) {
        this.matter.body.setPosition(body, { x, y: this.spider.position.y });
      }
      this.spider.sayCommand?.('I DO NOT LIKE EDGES!');
      return;
    }
    this.spider.facing = direction === 'left' ? -1 : 1;
    this.webMcpController.stopAllActions();
    this.webMcpController.setMove(direction, duration);
    this.spider.sayCommand?.('I DO NOT LIKE EDGES!');
  }

  drawTerrariumBackground() {
    const g = this.add.graphics();
    const { canopy, stems } = this.terrain.decorations;

    const bands = [0xd8e5ce, 0xcbdcc1, 0xbcd1b2, 0xafc7a5];
    bands.forEach((color, index) => {
      g.fillStyle(color, 1);
      g.fillRect(0, index * 90, WORLD_WIDTH, 92);
    });

    // Seeded canopy shadows make each terrarium feel grown rather than tiled.
    for (const crown of canopy) {
      g.fillStyle(crown.color, 0.22);
      g.fillCircle(crown.x, crown.y, crown.radius);
      g.fillCircle(crown.x - crown.radius * 0.55, crown.y + 8, crown.radius * 0.58);
      g.fillCircle(crown.x + crown.radius * 0.5, crown.y + 4, crown.radius * 0.64);
    }


    // Background bamboo & support silhouettes
    g.fillStyle(0x799975, 0.18);
    g.fillRect(38, 76, 12, 282);
    g.fillRect(712, 48, 14, 310);
    g.fillRect(290, 60, 8, 298);

    // Distant background stems, with the same sparse pixel construction as prey legs.
    g.fillStyle(0x6f916d, 0.38);
    for (const stem of stems) {
      g.lineStyle(3, 0x6f916d, 0.34);
      g.lineBetween(stem.x, GROUND_Y, stem.x + stem.lean, GROUND_Y - stem.height);
      const tipX = stem.x + stem.lean;
      g.fillEllipse(tipX + stem.leafSide * 8, GROUND_Y - stem.height + 13, 18, 7);
      g.fillEllipse(tipX - stem.leafSide * 7, GROUND_Y - stem.height + 27, 15, 6);
    }

    // Condensation beads on glass
    g.fillStyle(0xf2f8e9, 0.45);
    for (let i = 0; i < 30; i += 1) {
      const x = 36 + ((i * 127) % 696);
      const y = 42 + ((i * 83) % 270);
      g.fillCircle(x, y, i % 3 === 0 ? 3 : 2);
    }
  }

  drawHabitat() {
    const g = this.add.graphics().setDepth(2);
    const { ferns, stones, mushrooms } = this.terrain.decorations;

    this.drawCork(g);

    // Drainage, charcoal, and soil layers visible through glass
    g.fillStyle(0x839078, 1);
    g.fillRect(0, GROUND_Y, WORLD_WIDTH, 4);
    g.fillStyle(0x536248, 1);
    g.fillRect(0, GROUND_Y + 4, WORLD_WIDTH, 10);
    g.fillStyle(0x49372a, 1);
    g.fillRect(0, GROUND_Y + 14, WORLD_WIDTH, 38);
    g.fillStyle(0x2f2b27, 1);
    g.fillRect(0, GROUND_Y + 52, WORLD_WIDTH, 10);
    g.fillStyle(0x8f7f68, 1);
    g.fillRect(0, GROUND_Y + 62, WORLD_WIDTH, 12);

    // Seeded moss clumps retain a crisp collision line while breaking its silhouette.
    for (let x = 12; x < WORLD_WIDTH; x += 11) {
      const variation = this.terrainNoise(x, this.terrain.seed);
      const width = 5 + Math.floor(variation * 9);
      const height = 2 + Math.floor(this.terrainNoise(x + 31, this.terrain.seed) * 5);
      g.fillStyle(variation > 0.52 ? 0x71934f : 0x5d8148, 1);
      g.fillRect(x, GROUND_Y - height, width, height + 1);
      if (variation > 0.78) {
        g.fillStyle(0xa1b879, 1);
        g.fillRect(x + 2, GROUND_Y - height - 1, Math.max(2, width - 4), 1);
      }
    }

    for (const fern of ferns) {
      this.drawFern(g, fern.x, GROUND_Y, fern.height, fern.color, fern.lean, fern.seed);
    }

    for (const stone of stones) {
      g.fillStyle(0x514c48, 0.45);
      g.fillEllipse(stone.x + 1, GROUND_Y, stone.w + 2, Math.max(3, stone.h - 1));
      g.fillStyle(stone.color, 1);
      g.lineStyle(1, 0x5d554f, 1);
      g.fillEllipse(stone.x, GROUND_Y - stone.h / 2, stone.w, stone.h);
      g.strokeEllipse(stone.x, GROUND_Y - stone.h / 2, stone.w, stone.h);
      g.fillStyle(0xb5aa96, 0.7);
      g.fillRect(stone.x - Math.floor(stone.w / 4), GROUND_Y - stone.h + 2, 3, 1);
    }

    for (const mushroom of mushrooms) {
      g.fillStyle(0xf1dfb5, 1);
      g.fillRect(mushroom.x - 1, GROUND_Y - mushroom.height, 3, mushroom.height);
      g.fillStyle(0x8f5d4e, 1);
      g.fillEllipse(mushroom.x, GROUND_Y - mushroom.height, mushroom.capWidth + 2, 7);
      g.fillStyle(mushroom.color, 1);
      g.fillEllipse(mushroom.x, GROUND_Y - mushroom.height - 1, mushroom.capWidth, 6);
      g.fillStyle(0xf3d7a2, 1);
      g.fillRect(mushroom.x - 2, GROUND_Y - mushroom.height - 3, 2, 1);
    }

    // Floating / branch platforms
    for (const platform of this.platforms.filter((item) => item.h <= 10)) {
      this.drawBranch(g, platform);
    }
  }

  drawCork(g) {
    for (const trunk of this.climbables) {
      const centerX = trunk.x + trunk.w / 2;

      // Roots echo the spider's articulated legs and visually anchor collision trunks.
      g.lineStyle(5, 0x4b3526, 1);
      g.lineBetween(centerX, GROUND_Y - 8, trunk.x - 18, GROUND_Y + 2);
      g.lineBetween(centerX, GROUND_Y - 5, trunk.x + trunk.w + 20, GROUND_Y + 3);
      g.lineStyle(2, 0x806044, 1);
      g.lineBetween(centerX - 2, GROUND_Y - 7, trunk.x - 16, GROUND_Y);

      // Collision core plus a pixel-stepped outline.
      g.fillStyle(0x4b3526, 1);
      g.fillRect(trunk.x, trunk.y, trunk.w, trunk.h);
      for (let y = trunk.y + 4; y < trunk.y + trunk.h; y += 12) {
        const left = 2 + Math.floor(this.terrainNoise(y, trunk.seed) * 5);
        const right = 2 + Math.floor(this.terrainNoise(y + 71, trunk.seed) * 5);
        g.fillRect(trunk.x - left, y, left + 1, Math.min(13, trunk.y + trunk.h - y));
        g.fillRect(trunk.x + trunk.w - 1, y, right + 1, Math.min(13, trunk.y + trunk.h - y));
      }

      // Rich brown wood inner grain
      g.fillStyle(0x73543a, 1);
      g.fillRect(trunk.x + 4, trunk.y + 2, 5, trunk.h - 2);
      g.fillStyle(0x5e432f, 1);
      g.fillRect(trunk.x + trunk.w - 8, trunk.y + 7, 4, trunk.h - 12);

      // Bark fissures / highlights
      g.fillStyle(0x967253, 1);
      for (let y = trunk.y + 12; y < trunk.y + trunk.h; y += 25) {
        const grainX = trunk.x + 8 + Math.floor(this.terrainNoise(y, trunk.seed) * Math.max(4, trunk.w - 18));
        const grainW = 4 + Math.floor(this.terrainNoise(y + 13, trunk.seed) * 8);
        g.fillRect(grainX, y, grainW, 2);
      }

      // Small outlined knots give the bark the same readable faces as the animals.
      for (let y = trunk.y + 38; y < trunk.y + trunk.h - 20; y += 72) {
        const side = this.terrainNoise(y + 5, trunk.seed) > 0.5 ? 0.68 : 0.35;
        const knotX = Math.round(trunk.x + trunk.w * side);
        g.fillStyle(0x3f2d23, 1);
        g.fillEllipse(knotX, y, 8, 6);
        g.fillStyle(0xa37b55, 1);
        g.fillRect(knotX - 2, y - 2, 3, 1);
      }

      // Clinging bark moss
      g.fillStyle(0x74954e, 1);
      for (let y = trunk.y + 18; y < trunk.y + trunk.h - 12; y += 34) {
        const onLeft = this.terrainNoise(y + 91, trunk.seed) > 0.42;
        const mossX = onLeft ? trunk.x - 4 : trunk.x + trunk.w - 2;
        g.fillRect(mossX, y, 6, 10);
        g.fillStyle(0x9ab56d, 1);
        g.fillRect(mossX + (onLeft ? 1 : 0), y, 3, 2);
        g.fillStyle(0x74954e, 1);
      }
    }
  }

  drawBranch(g, platform) {
    const endRadius = Math.max(5, platform.h);
    g.fillStyle(0x453226, 1);
    g.fillEllipse(platform.x, platform.y + platform.h / 2, endRadius, platform.h + 2);
    g.fillEllipse(platform.x + platform.w, platform.y + platform.h / 2, endRadius, platform.h + 2);
    g.fillRect(platform.x, platform.y, platform.w, platform.h);
    g.fillStyle(0x674a33, 1);
    g.fillRect(platform.x + 3, platform.y + 2, platform.w - 6, Math.max(2, platform.h - 4));
    g.fillStyle(0x987153, 1);
    for (let x = platform.x + 8; x < platform.x + platform.w - 5; x += 17) {
      const offset = Math.floor(this.terrainNoise(x, platform.seed) * 3);
      g.fillRect(x, platform.y + 4 + offset, 7, 1);
    }

    // Patchy top moss keeps the precise platform top readable to player and spider.
    for (let x = platform.x; x < platform.x + platform.w; x += 8) {
      const amount = this.terrainNoise(x + 17, platform.seed);
      if (amount < 0.22) continue;
      const patchW = 5 + Math.floor(amount * 5);
      const patchH = amount > 0.72 ? 4 : 3;
      g.fillStyle(amount > 0.68 ? 0x7f9e57 : 0x688b4b, 1);
      g.fillRect(x, platform.y - patchH + 2, patchW, patchH);
      if (amount > 0.84) {
        g.fillStyle(0xa9bf78, 1);
        g.fillRect(x + 2, platform.y - patchH, 3, 1);
      }
    }
  }

  drawFern(g, x, groundY, height, color, lean = 0, seed = 1) {
    g.lineStyle(2, color, 1);
    g.lineBetween(x, groundY, x + lean, groundY - height);
    for (let y = 6; y < height; y += 6) {
      const spread = Math.max(5, Math.round((height - y) * 0.4));
      const stemX = x + Math.round(lean * (y / height));
      const flutter = Math.floor(this.terrainNoise(y, seed) * 3);
      g.fillStyle(color, 1);
      g.fillEllipse(stemX - spread / 2, groundY - y + flutter, spread, 3);
      g.fillEllipse(stemX + spread / 2, groundY - y - 2 - flutter, spread, 3);
      g.fillStyle(0x8da66c, 0.65);
      g.fillRect(stemX - spread + 2, groundY - y + flutter - 1, 2, 1);
    }
  }

  terrainNoise(value, seed) {
    let mixed = Math.imul((value | 0) ^ (seed | 0), 0x45d9f3b);
    mixed ^= mixed >>> 16;
    mixed = Math.imul(mixed, 0x45d9f3b);
    mixed ^= mixed >>> 16;
    return (mixed >>> 0) / 4294967295;
  }

  updateTerrainMotion(time) {
    const g = this.terrainMotionGraphics;
    if (!g) return;
    g.clear();

    // Fern crowns sway independently, but stay snapped to whole pixels.
    this.terrain.decorations.ferns.forEach((fern, index) => {
      const tipX = fern.x + fern.lean;
      const tipY = GROUND_Y - fern.height;
      const sway = getTerrainSway(time, fern.seed, index, 3);
      g.lineStyle(1, 0x77965b, 1);
      g.lineBetween(tipX, tipY + 7, tipX + sway, tipY);
      g.fillStyle(0x8da66c, 0.9);
      g.fillEllipse(tipX + sway - 3, tipY + 2, 7, 2);
      g.fillEllipse(tipX + sway + 3, tipY + 5, 7, 2);
    });

    // Sparse ground blades make the wind readable without moving collision edges.
    for (let x = 26; x < WORLD_WIDTH - 20; x += 23) {
      const strength = this.terrainNoise(x + 8, this.terrain.seed);
      if (strength < 0.38) continue;
      const height = 3 + Math.floor(strength * 5);
      const sway = getTerrainSway(time, this.terrain.seed, x, 2);
      g.lineStyle(1, strength > 0.72 ? 0x91aa68 : 0x66884c, 0.9);
      g.lineBetween(x, GROUND_Y - 1, x + sway, GROUND_Y - height);
    }

    // Only the tallest moss tips move; branch bodies remain exact and readable.
    this.platforms.filter((platform) => platform.h <= 10).forEach((platform, pIndex) => {
      for (let x = platform.x + 6; x < platform.x + platform.w - 5; x += 16) {
        const amount = this.terrainNoise(x + 17, platform.seed);
        if (amount < 0.68) continue;
        const sway = getTerrainSway(time, platform.seed, x + pIndex, 2);
        const stemHeight = amount > 0.86 ? 5 : 3;
        g.lineStyle(1, 0x779b55, 1);
        g.lineBetween(x, platform.y, x + sway, platform.y - stemHeight);
        g.fillStyle(0xa9bf78, 1);
        g.fillRect(x + sway + (sway < 0 ? -1 : 0), platform.y - stemHeight, 2, 1);
      }
    });

    // Bark moss has a tiny breathing motion, like the prey's antennae and legs.
    this.climbables.forEach((trunk, tIndex) => {
      for (let y = trunk.y + 18; y < trunk.y + trunk.h - 12; y += 34) {
        const onLeft = this.terrainNoise(y + 91, trunk.seed) > 0.42;
        const anchorX = onLeft ? trunk.x - 3 : trunk.x + trunk.w + 2;
        const sway = getTerrainSway(time, trunk.seed, y + tIndex, 1);
        g.fillStyle(0x9ab56d, 0.95);
        g.fillRect(anchorX + sway, y + 1, 2, 2);
      }
    });

    // Cap highlights wobble by a pixel while their stems and silhouettes stay put.
    this.terrain.decorations.mushrooms.forEach((mushroom, index) => {
      const sway = getTerrainSway(time, this.terrain.seed, 900 + index, 1);
      g.fillStyle(0xffe7ba, 0.85);
      g.fillRect(
        mushroom.x - 2 + sway,
        GROUND_Y - mushroom.height - 4,
        2,
        1,
      );
    });
  }

  createFloatingMotes() {
    for (let i = 0; i < 20; i += 1) {
      const x = 40 + ((i * 113) % 688);
      const y = 60 + ((i * 47) % 240);
      const mote = this.add
        .rectangle(x, y, 2, 2, 0xf4f3bd)
        .setAlpha(0.35)
        .setDepth(5);
      this.tweens.add({
        targets: mote,
        x: x + 6 + (i % 4),
        y: y - 8,
        alpha: 0.85,
        duration: 1800 + i * 120,
        delay: i * 90,
        ease: 'Sine.InOut',
        yoyo: true,
        repeat: -1,
      });
    }
  }

  drawGlassFrame() {
    const g = this.add.graphics().setDepth(1000);

    // Terrarium outer glass frame
    g.lineStyle(6, 0x5b4534, 1);
    g.strokeRect(3, 3, 762, 426);
    g.lineStyle(3, 0xa47d57, 1);
    g.strokeRect(8, 8, 752, 416);

    // Top & bottom brass/wood enclosure rims
    g.fillStyle(0x4b382b, 1);
    g.fillRect(0, 0, WORLD_WIDTH, 14);
    g.fillRect(0, 418, WORLD_WIDTH, 14);

    // Air vents at top
    g.fillStyle(0x1f2923, 1);
    for (let x = 32; x < 736; x += 20) g.fillRect(x, 5, 8, 4);

    // Glass reflection highlights
    g.lineStyle(3, 0xffffff, 0.22);
    g.lineBetween(18, 24, 18, 280);
    g.lineBetween(24, 20, 180, 20);
    g.lineStyle(1.5, 0xffffff, 0.12);
    g.lineBetween(680, 26, 750, 110);
    g.lineBetween(692, 26, 754, 100);
  }
}
