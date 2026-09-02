import Phaser from 'phaser';
import {
  getLandingAnimationPose,
  getSpiderBodySurfaceY,
  getWalkableSurfaceY,
} from './spiderAnimationMath.js';
import {
  growScaleFromPrey,
  MAX_GROWTH_SCALE,
  shrinkScaleForHunger,
  STARTING_SCALE,
} from './spiderGrowthMath.js';

// Body collision box. The drawn spider is wider, but a compact collision box
// keeps platforming predictable and prevents decorative legs from snagging.
const BODY_HALF_W = 7;
const BODY_HALF_H = 5;

const RUN_SPEED = 50;
const GROUND_ACCEL = 430;
const AIR_ACCEL = 230;
const GROUND_DRAG = 540;
const GRAVITY = 430;
const POUNCE_FORWARD_SPEED = 150;
const POUNCE_LIFT_SPEED = 92;
const POUNCE_BUFFER_TIME = 0.12;
const MAX_FALL_SPEED = 210;
const SAFE_FALL_SPEED = 130;
const FALL_DAMAGE_MULTIPLIER = 0.35;
const MAX_HEALTH = 100;
const CORNER_DURATION = 0.18;
const CORNER_INSET = 18;
const CLIMB_CORNER_DURATION = 0.28;

// Move a scalar toward a target without overshooting it.
const moveToward = (value, target, maxStep) =>
  Math.abs(target - value) <= maxStep
    ? target
    : value + Math.sign(target - value) * maxStep;

const STEP_TRIGGER = 4.5;
const STEP_DURATION = 0.09;
const STEP_HEIGHT = 4;
const LANDING_DURATION = 0.34;

import {
  IDLE_SPIDER_QUIPS,
  getNextIdleQuip,
  HURRY_START_QUIPS,
  HURRY_REALIZE_QUIPS,
} from './spiderIdleQuips.js';
export { IDLE_SPIDER_QUIPS, getNextIdleQuip, HURRY_START_QUIPS, HURRY_REALIZE_QUIPS };

// Four anatomical leg pairs, each represented twice: once on the far side
// and once on the near side. The far legs are drawn first in a darker shade.
// x values are expressed for a spider facing RIGHT and mirrored when facing left.
const LEG_LAYOUT = [
  // far side
  { hipX: -5, hipY: 1, restX: -18, upper: 11, lower: 12, group: 0, bend: 1, layer: 'far' },
  { hipX: -2, hipY: 2, restX: -10, upper: 9, lower: 10, group: 1, bend: 1, layer: 'far' },
  { hipX: 2, hipY: 2, restX: 10, upper: 9, lower: 10, group: 0, bend: -1, layer: 'far' },
  { hipX: 5, hipY: 1, restX: 18, upper: 11, lower: 12, group: 1, bend: -1, layer: 'far' },

  // near side
  { hipX: -5, hipY: 0, restX: -21, upper: 12, lower: 13, group: 1, bend: 1, layer: 'near' },
  { hipX: -3, hipY: 2, restX: -13, upper: 10, lower: 11, group: 0, bend: 1, layer: 'near' },
  { hipX: 2, hipY: 2, restX: 13, upper: 10, lower: 11, group: 1, bend: -1, layer: 'near' },
  { hipX: 5, hipY: 0, restX: 21, upper: 12, lower: 13, group: 0, bend: -1, layer: 'near' },
];

const POUNCE_ATTACKS = [
  {
    name: 'FANG LUNGE',
    feetX: [-7, -2, 13, 18],
    feetY: [6, 5, 2, 1],
    forward: 1.08,
    lift: 0.92,
    bodyStretch: 1.2,
  },
  {
    name: 'SILK SWEEP',
    feetX: [-13, -7, 10, 16],
    feetY: [5, 2, 1, 5],
    forward: 1,
    lift: 1.05,
    bodyStretch: 0.75,
  },
  {
    name: 'VENOM SNAP',
    feetX: [-5, 0, 15, 12],
    feetY: [8, 7, 0, 3],
    forward: 1.12,
    lift: 0.84,
    bodyStretch: 1.4,
  },
  {
    name: 'WEB CRASH',
    feetX: [-15, -9, 9, 15],
    feetY: [2, 1, 1, 2],
    forward: 0.92,
    lift: 1.18,
    bodyStretch: 0.45,
  },
  {
    name: 'SHADOW DIVE',
    feetX: [-9, -3, 11, 17],
    feetY: [3, 8, 7, 8],
    forward: 1.16,
    lift: 0.76,
    bodyStretch: 1,
  },
];

export class ProceduralSpider {
  constructor(scene, x, y, platforms, climbables = [], terrainSurfaces = {}) {
    this.scene = scene;
    this.platforms = platforms;
    this.climbables = climbables;
    this.floorStones = terrainSurfaces.stones || [];
    this.terrainGroundY = terrainSurfaces.groundY ?? null;

    this.position = new Phaser.Math.Vector2(x, y);
    this.velocity = new Phaser.Math.Vector2(0, 0);
    this.health = MAX_HEALTH;
    this.maxHealth = MAX_HEALTH;
    this.preyEaten = 0;
    this.growthScale = STARTING_SCALE;
    this.damageInvulnerability = 0;
    this.isDead = false;
    this.facing = 1;
    this.grounded = false;
    this.pounceBufferTimer = 0;
    this.pounceTime = 0;
    this.landingAnimationTimer = 0;
    this.landingAnimationDuration = LANDING_DURATION;
    this.landingStrength = 0;
    this.lastLandingImpactSpeed = 0;
    this.landingPose = getLandingAnimationPose(-1, LANDING_DURATION, 0);
    this.pounceAngle = 0;
    this.isPouncing = false;
    this.pounceAttackIndex = -1;
    this.attackBubbleTimer = 0;
    this.commandBubbleTimer = 0;
    this.climbProbeLegIndex = -1;
    this.climbProbeSurfaceX = null;
    this.currentGaitGroup = 0;
    this.justLanded = false;
    this.surfaceType = 'floor';
    this.surfacePlatform = null;
    this.surfaceSide = 0;
    this.surfaceAngle = 0;
    this.surfaceVelocity = 0;
    this.cornerTransition = null;
    this.animationTime = 0;
    this.scuttleAmount = 0;
    this.bodyBob = 0;
    this.idleTime = 0;
    this.idleMode = -1;
    this.idleModeTime = 0;
    this.idleBodyOffset = new Phaser.Math.Vector2();
    this.idleAbdomenPulse = 0;
    this.idleHeadOffset = 0;
    this.idleLegIndex = -1;
    this.idleLegLift = 0;
    this.idleSpeechTimer = 0;
    this.nextIdleSpeechDelay = 4.0;
    this.lastIdleQuipIndex = -1;
    this.idleModeCycles = 0;
    this.nextHurryCycle = 3;
    this.idleHurryState = null;
    this.idleHurryOrigin = 0;
    this.idleHurryTarget = 0;
    this.idleHurryDir = 1;
    this.idleHurryTimeout = 0;
    this.idleHurryPauseTimer = 0;

    // The head is a small spring-followed mass rather than a fixed drawing
    // offset. Keeping it in world space lets acceleration, landings, and
    // surface rotations naturally produce a little secondary motion.
    this.headPosition = new Phaser.Math.Vector2();
    this.headVelocity = new Phaser.Math.Vector2();
    this.headTargetPrevious = new Phaser.Math.Vector2();
    this.headFacing = this.facing;

    this.graphicsShadow = scene.add.graphics().setDepth(8);
    this.graphicsFar = scene.add.graphics().setDepth(9);
    this.graphicsBody = scene.add.graphics().setDepth(10);
    this.graphicsNear = scene.add.graphics().setDepth(11);
    this.graphicsAttackBubble = scene.add.graphics().setDepth(30);
    this.attackBubbleText = scene.add.text(0, 0, '', {
      fontFamily: 'monospace',
      fontSize: '7px',
      color: '#f8f3df',
    }).setOrigin(0.5).setDepth(31).setVisible(false);
    this.graphicsCommandBubble = scene.add.graphics().setDepth(32);
    this.commandBubbleText = scene.add.text(0, 0, '', {
      fontFamily: 'monospace',
      fontSize: '7px',
      color: '#27342a',
    }).setOrigin(0.5).setDepth(33).setVisible(false);

    this.legs = LEG_LAYOUT.map((cfg) => ({
      ...cfg,
      foot: new Phaser.Math.Vector2(
        x + cfg.restX * this.growthScale,
        y + (BODY_HALF_H + 6) * this.growthScale,
      ),
      stepStart: new Phaser.Math.Vector2(),
      stepTarget: new Phaser.Math.Vector2(),
      stepT: 1,
      stepHeight: STEP_HEIGHT,
      stepDuration: STEP_DURATION,
      isStepping: false,
    }));

    this.createIdleMatterRig(x, y);

    // Settle onto the spawn floor immediately.
    this.resolveVertical(0);
    this.plantAllFeet();
    this.resetHeadSpring();
  }

  update(dt, input) {
    if (this.isDead) {
      this.draw();
      return;
    }

    const isPlayerInput = Boolean(input.moveX || input.moveY || input.attackPressed);
    if (isPlayerInput) {
      this.cancelIdleHurry();
    }

    const effectiveMoveX = isPlayerInput ? input.moveX : (this.updateIdleHurry(dt) || 0);
    const effectiveMoveY = input.moveY;

    this.updateHunger(dt);
    this.justLanded = false;
    this.updateTimers(dt, input.attackPressed);
    this.tryAttachToClimbable(effectiveMoveY);

    if (this.silkTraversal?.updateSpiderClimb(dt, { moveX: effectiveMoveX, moveY: effectiveMoveY, attackPressed: input.attackPressed })) {
      this.updateFacing(effectiveMoveX);
      this.updateAnimation(dt);
      this.updateLegs(dt, effectiveMoveY);
      this.updateIdleAnimation(dt, effectiveMoveY);
      this.updateHeadSpring(dt);
      this.draw();
      return;
    }

    if (this.cornerTransition) {
      this.updateCornerTransition(dt);
      this.updateAnimation(dt);
      this.updateIdleAnimation(dt, 1);
      this.updateHeadSpring(dt);
      this.draw();
      return;
    }

    this.updateHorizontal(dt, effectiveMoveX, effectiveMoveY);
    if (this.cornerTransition) {
      this.updateAnimation(dt);
      this.updateIdleAnimation(dt, 1);
      this.updateHeadSpring(dt);
      this.draw();
      return;
    }
    this.tryPounce();
    this.updateVertical(dt);
    this.updateFacing(effectiveMoveX);
    this.updateAnimation(dt);
    this.updateLegs(dt, effectiveMoveX || effectiveMoveY);
    this.updateClimbableProbe(dt);
    this.updateIdleAnimation(dt, isPlayerInput ? (input.moveX || input.moveY) : (this.idleHurryState ? 1 : 0));
    this.updateHeadSpring(dt);
    this.draw();
  }

  getHeadTarget() {
    const attackReach = this.isPouncing
      ? Phaser.Math.Clamp(this.pounceTime * 10, 0, 1.5)
      : 0;
    const localX = (
      this.idleBodyOffset.x +
      (4 + this.idleHeadOffset + attackReach) * this.facing
    ) * this.growthScale;
    const localY = (this.bodyBob + this.idleBodyOffset.y) * this.growthScale;
    const angle = this.isPouncing ? this.pounceAngle : this.surfaceAngle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Phaser.Math.Vector2(
      this.position.x + localX * cos - localY * sin,
      this.position.y + localX * sin + localY * cos,
    );
  }

  resetHeadSpring() {
    const target = this.getHeadTarget();
    this.headPosition.copy(target);
    this.headTargetPrevious.copy(target);
    this.headVelocity.copy(this.velocity);
    this.headFacing = this.facing;
  }

  updateHeadSpring(dt) {
    const target = this.getHeadTarget();

    // A direction change moves the anatomical front to the other side. Reset
    // there instead of letting the head swing through the abdomen.
    if (this.headFacing !== this.facing || dt <= 0) {
      this.resetHeadSpring();
      return;
    }

    const targetVelocityX = (target.x - this.headTargetPrevious.x) / dt;
    const targetVelocityY = (target.y - this.headTargetPrevious.y) / dt;
    const stiffness = 120;
    const damping = 16;

    this.headVelocity.x += (
      (target.x - this.headPosition.x) * stiffness +
      (targetVelocityX - this.headVelocity.x) * damping
    ) * dt;
    this.headVelocity.y += (
      (target.y - this.headPosition.y) * stiffness +
      (targetVelocityY - this.headVelocity.y) * damping
    ) * dt;
    this.headPosition.x += this.headVelocity.x * dt;
    this.headPosition.y += this.headVelocity.y * dt;

    // The connector stretches, but never enough to look broken during an
    // abrupt collision correction or a corner transition.
    const offsetX = this.headPosition.x - target.x;
    const offsetY = this.headPosition.y - target.y;
    const distance = Math.hypot(offsetX, offsetY);
    const maxStretch = 2.4;
    if (distance > maxStretch) {
      const scale = maxStretch / distance;
      this.headPosition.set(
        target.x + offsetX * scale,
        target.y + offsetY * scale,
      );
    }

    this.headTargetPrevious.copy(target);
  }

  createIdleMatterRig(x, y) {
    const bodyOptions = {
      isSensor: true,
      ignoreGravity: true,
      collisionFilter: { category: 0, mask: 0 },
    };
    this.idleAnchor = this.scene.matter.add.circle(x, y, 1, {
      ...bodyOptions,
      isStatic: true,
    });
    this.idleDriver = this.scene.matter.add.circle(x, y, 2, {
      ...bodyOptions,
      frictionAir: 0.16,
      density: 0.004,
    });
    this.idleSpring = this.scene.matter.add.constraint(
      this.idleAnchor,
      this.idleDriver,
      0,
      0.075,
      { damping: 0.12 },
    );
  }

  updateAnimation(dt) {
    const travelSpeed = this.surfaceType === 'wall' || this.surfaceType === 'ceiling' || this.surfaceType === 'silk'
      ? this.surfaceVelocity
      : this.velocity.x;
    this.scuttleAmount = Phaser.Math.Clamp(
      Math.abs(travelSpeed) / this.moveSpeed,
      0,
      1,
    );

    // Keep the body level while adding a restrained, speed-driven rise and
    // fall. The collision position remains unchanged on the platform.
    this.animationTime += dt * (4 + this.scuttleAmount * 15);
    const strideBob = Math.sin(this.animationTime * 2) * 0.7;
    const landingElapsed = this.landingAnimationDuration - this.landingAnimationTimer;
    this.landingPose = getLandingAnimationPose(
      landingElapsed,
      this.landingAnimationDuration,
      this.landingStrength,
    );
    this.bodyBob = this.grounded
      ? strideBob * this.scuttleAmount + this.landingPose.bodyOffset
      : 0;
  }

  updateIdleAnimation(dt, moveX) {
    const travelSpeed = this.surfaceType === 'wall' || this.surfaceType === 'ceiling' || this.surfaceType === 'silk'
      ? this.surfaceVelocity
      : this.velocity.x;
    const isIdle =
      this.grounded &&
      !this.cornerTransition &&
      moveX === 0 &&
      Math.abs(travelSpeed) < 1 &&
      !this.legs.some((leg) => leg.isStepping);

    if (!isIdle) {
      this.idleTime = 0;
      this.idleMode = -1;
      this.idleSpeechTimer = 0;
      this.clearIdlePose();
      this.resetIdleMatterRig();
      return;
    }

    const MatterBody = this.scene.matter.body;
    MatterBody.setPosition(this.idleAnchor, this.position);
    const distance = Phaser.Math.Distance.Between(
      this.idleAnchor.position.x,
      this.idleAnchor.position.y,
      this.idleDriver.position.x,
      this.idleDriver.position.y,
    );
    if (distance > 8) this.resetIdleMatterRig();

    this.idleTime += dt;
    this.updateIdleSpeech(dt);
    if (this.idleTime < 0.65) {
      this.clearIdlePose();
      return;
    }

    const durations = [2.6, 1.9, 2.3];
    if (this.idleMode < 0 || this.idleModeTime >= durations[this.idleMode]) {
      const previousMode = this.idleMode;
      this.idleMode = previousMode < 0
        ? Phaser.Math.Between(0, 2)
        : (previousMode + Phaser.Math.Between(1, 2)) % 3;
      this.idleModeTime = 0;
      this.idleLegIndex = Phaser.Math.RND.pick([4, 7]);
      this.resetIdleMatterRig();

      if (previousMode >= 0) {
        this.idleModeCycles = (this.idleModeCycles || 0) + 1;
        const targetCycle = this.nextHurryCycle || 3;
        if (this.idleModeCycles >= targetCycle) {
          this.idleModeCycles = 0;
          this.nextHurryCycle = Phaser.Math.Between(2, 4);
          if (!this.idleHurryState) {
            this.startIdleHurry();
          }
        }
      }
    }

    this.idleModeTime += dt;
    const phase = this.idleModeTime * Math.PI * 2;
    let localForceX = 0;
    let localForceY = 0;

    if (this.idleMode === 0) {
      // Slow breathing: the spring gives the abdomen a tiny organic lag.
      localForceY = Math.sin(phase * 0.72) * 0.00012;
    } else if (this.idleMode === 1) {
      // Grooming tap: one near outer leg lifts in short paired pulses.
      const tap = Math.max(0, Math.sin(phase * 1.35));
      localForceX = Math.sin(phase * 0.55) * 0.000045;
      localForceY = -tap * 0.0001;
    } else {
      // Alert pose: the body shifts weight and the head peers forward.
      localForceX = Math.sin(phase * 0.48) * 0.00014;
      localForceY = Math.cos(phase * 0.96) * 0.000035;
    }

    const force = this.localToWorld(localForceX, localForceY);
    MatterBody.applyForce(this.idleDriver, this.idleDriver.position, force);

    const dx = this.idleDriver.position.x - this.idleAnchor.position.x;
    const dy = this.idleDriver.position.y - this.idleAnchor.position.y;
    const cos = Math.cos(this.surfaceAngle);
    const sin = Math.sin(this.surfaceAngle);
    const localX = dx * cos + dy * sin;
    const localY = -dx * sin + dy * cos;

    this.clearIdlePose();
    if (this.idleMode === 0) {
      this.idleBodyOffset.y = Phaser.Math.Clamp(localY * 0.35, -0.7, 0.7);
      this.idleAbdomenPulse =
        Math.sin(phase * 0.72) * 0.8 +
        Phaser.Math.Clamp(localY * 0.2, -0.35, 0.35);
    } else if (this.idleMode === 1) {
      const tap = Math.max(0, Math.sin(phase * 1.35));
      this.idleLegLift = Phaser.Math.Clamp(tap * 3.5 - localY * 0.25, 0, 5);
      this.idleHeadOffset = Math.sin(phase * 0.55) * 0.45;
    } else {
      this.idleBodyOffset.x = Phaser.Math.Clamp(localX * 0.5, -1.4, 1.4);
      this.idleBodyOffset.y = Phaser.Math.Clamp(localY * 0.25, -0.4, 0.4);
      this.idleHeadOffset =
        Phaser.Math.Clamp(localX * 0.45, -1, 1) + Math.sin(phase * 0.48) * 0.35;
    }
  }

  clearIdlePose() {
    this.idleBodyOffset.set(0, 0);
    this.idleAbdomenPulse = 0;
    this.idleHeadOffset = 0;
    this.idleLegLift = 0;
  }

  updateIdleSpeech(dt) {
    this.idleSpeechTimer = (this.idleSpeechTimer || 0) + dt;
    const triggerDelay = this.nextIdleSpeechDelay || 4.5;
    if (this.idleSpeechTimer >= triggerDelay) {
      this.idleSpeechTimer = 0;
      this.nextIdleSpeechDelay = Phaser.Math.FloatBetween(7.0, 13.0);
      if (this.commandBubbleTimer <= 0 && !this.isDead) {
        const { index, quip } = getNextIdleQuip(this.lastIdleQuipIndex);
        this.lastIdleQuipIndex = index;
        this.sayCommand(quip);
        noop('[Spider idle] spider says', quip);
      }
    }
  }

  startIdleHurry() {
    if (!this.grounded || this.surfaceType !== 'floor' || this.cornerTransition) return;
    const platform = this.surfacePlatform;
    if (!platform) return;

    const minX = platform.x + 24;
    const maxX = platform.x + platform.w - 24;
    if (maxX <= minX) return;

    let dir = this.facing || 1;
    const currentX = this.position.x;
    const hurryDist = Phaser.Math.FloatBetween(28, 48);

    if (dir > 0 && currentX + hurryDist > maxX) {
      dir = -1;
    } else if (dir < 0 && currentX - hurryDist < minX) {
      dir = 1;
    }

    const targetX = Phaser.Math.Clamp(currentX + dir * hurryDist, minX, maxX);
    if (Math.abs(targetX - currentX) < 14) return;

    this.idleHurryOrigin = currentX;
    this.idleHurryTarget = targetX;
    this.idleHurryDir = dir;
    this.idleHurryState = 'hurrying';
    this.idleHurryTimeout = 1.3;

    const quip = HURRY_START_QUIPS[Phaser.Math.Between(0, HURRY_START_QUIPS.length - 1)];
    this.sayCommand(quip);
    noop('[Spider idle] hurry start:', quip);
  }

  updateIdleHurry(dt) {
    if (!this.idleHurryState) return 0;
    this.idleHurryTimeout -= dt;

    if (this.idleHurryState === 'hurrying') {
      const remaining = this.idleHurryTarget - this.position.x;
      if (Math.sign(remaining) !== this.idleHurryDir || Math.abs(remaining) < 3.5 || this.idleHurryTimeout <= 0) {
        this.position.x = this.idleHurryTarget;
        this.velocity.x = 0;
        this.idleHurryState = 'paused';
        this.idleHurryPauseTimer = 0.9;
        const quip = HURRY_REALIZE_QUIPS[Phaser.Math.Between(0, HURRY_REALIZE_QUIPS.length - 1)];
        this.sayCommand(quip);
        noop('[Spider idle] realize nothing needed:', quip);
        return 0;
      }
      return this.idleHurryDir;
    }

    if (this.idleHurryState === 'paused') {
      this.idleHurryPauseTimer -= dt;
      if (this.idleHurryPauseTimer <= 0) {
        this.idleHurryState = 'returning';
        this.idleHurryTimeout = 1.5;
      }
      return 0;
    }

    if (this.idleHurryState === 'returning') {
      const remaining = this.idleHurryOrigin - this.position.x;
      const returnDir = Math.sign(remaining);
      if (Math.abs(remaining) < 3.5 || this.idleHurryTimeout <= 0) {
        this.position.x = this.idleHurryOrigin;
        this.velocity.x = 0;
        this.idleHurryState = null;
        this.idleModeTime = 0;
        this.clearIdlePose();
        this.resetIdleMatterRig();
        return 0;
      }
      return returnDir;
    }

    return 0;
  }

  cancelIdleHurry() {
    this.idleHurryState = null;
    this.idleHurryOrigin = 0;
    this.idleHurryTarget = 0;
  }

  resetIdleMatterRig() {
    const MatterBody = this.scene.matter.body;
    MatterBody.setPosition(this.idleAnchor, this.position);
    MatterBody.setPosition(this.idleDriver, this.position);
    MatterBody.setVelocity(this.idleDriver, { x: 0, y: 0 });
    MatterBody.setAngularVelocity(this.idleDriver, 0);
  }

  updateTimers(dt, attackPressed) {
    const canQueuePounce = this.grounded && this.surfaceType === 'floor';
    this.pounceBufferTimer = attackPressed && canQueuePounce
      ? POUNCE_BUFFER_TIME
      : Math.max(0, this.pounceBufferTimer - dt);

    if (this.isPouncing) this.pounceTime += dt;
    this.landingAnimationTimer = Math.max(0, this.landingAnimationTimer - dt);
    this.attachCooldown = Math.max(0, (this.attachCooldown || 0) - dt);
    this.damageInvulnerability = Math.max(0, this.damageInvulnerability - dt);
    this.attackBubbleTimer = Math.max(0, this.attackBubbleTimer - dt);
    this.commandBubbleTimer = Math.max(0, this.commandBubbleTimer - dt);
  }

  sayCommand(text) {
    this.commandBubbleText.setText(String(text).toUpperCase());
    this.commandBubbleTimer = 2.8;
  }

  get bodyHalfWidth() {
    return BODY_HALF_W * this.growthScale;
  }

  get bodyHalfHeight() {
    return BODY_HALF_H * this.growthScale;
  }

  get growthProgress() {
    return Phaser.Math.Clamp(
      (this.growthScale - STARTING_SCALE) /
        (MAX_GROWTH_SCALE - STARTING_SCALE),
      0,
      1,
    );
  }

  get moveSpeed() {
    return RUN_SPEED * (0.78 + this.growthProgress * 0.72);
  }

  setGrowthScale(scale) {
    if (scale === this.growthScale) return false;
    this.growthScale = scale;

    if (this.grounded && this.surfacePlatform && !this.cornerTransition) {
      if (this.surfaceType === 'floor') {
        this.position.y = this.getFloorBodyY(this.surfacePlatform);
      } else if (this.surfaceType === 'wall') {
        this.position.x = this.surfaceSide === 1
          ? this.surfacePlatform.x - this.bodyHalfWidth
          : this.surfacePlatform.x + this.surfacePlatform.w + this.bodyHalfWidth;
      } else if (this.surfaceType === 'ceiling') {
        this.position.y = this.surfacePlatform.y + this.surfacePlatform.h + this.bodyHalfHeight;
      }
    }
    return true;
  }

  updateHunger(dt) {
    this.setGrowthScale(shrinkScaleForHunger(this.growthScale, dt));
  }

  consumePrey() {
    this.preyEaten += 1;
    this.setGrowthScale(growScaleFromPrey(this.growthScale));
    this.health = Math.min(this.maxHealth, this.health + 8);
    if (this.grounded && this.surfacePlatform) {
      if (this.surfaceType === 'floor') {
        this.position.y = this.getFloorBodyY(this.surfacePlatform);
      } else if (this.surfaceType === 'wall') {
        this.position.x = this.surfaceSide === 1
          ? this.surfacePlatform.x - this.bodyHalfWidth
          : this.surfacePlatform.x + this.surfacePlatform.w + this.bodyHalfWidth;
      } else if (this.surfaceType === 'ceiling') {
        this.position.y =
          this.surfacePlatform.y + this.surfacePlatform.h + this.bodyHalfHeight;
      }
      this.plantAllFeet();
    }
    this.resetHeadSpring();
  }

  takeDamage(amount) {
    if (amount <= 0 || this.damageInvulnerability > 0 || this.isDead) return 0;

    const appliedDamage = Math.min(this.health, Math.round(amount));
    this.health -= appliedDamage;
    this.damageInvulnerability = 0.45;
    if (this.health <= 0) this.isDead = true;
    if (this.onDamaged) this.onDamaged(appliedDamage, this.health);
    return appliedDamage;
  }

  applyFallDamage(impactSpeed) {
    const damage = (impactSpeed - SAFE_FALL_SPEED) * FALL_DAMAGE_MULTIPLIER;
    if (damage > 0) this.takeDamage(damage);
  }

  updateHorizontal(dt, moveX, moveY) {
    if (this.surfaceType === 'wall' || this.surfaceType === 'ceiling') {
      const tangent = this.localToWorld(1, 0);
      const isClimbingTrunk = Boolean(this.surfacePlatform?.climbable);
      let movementAxis = isClimbingTrunk ? moveY * tangent.y : moveX;

      // The ceiling tangent points left, so invert horizontal input to keep
      // the controls aligned with world-space left and right.
      if (this.surfaceType === 'ceiling') {
        movementAxis = -moveX;
      }

      const target = movementAxis * this.moveSpeed;
      const maxStep = (movementAxis === 0 ? GROUND_DRAG : GROUND_ACCEL) * dt;
      this.surfaceVelocity = moveToward(this.surfaceVelocity, target, maxStep);
      this.velocity.set(
        tangent.x * this.surfaceVelocity,
        tangent.y * this.surfaceVelocity,
      );
      this.position.x += this.velocity.x * dt;
      this.position.y += this.velocity.y * dt;
      if (isClimbingTrunk) {
        this.facing = this.surfaceVelocity === 0
          ? this.facing
          : Math.sign(this.surfaceVelocity);
        this.constrainClimbableMovement(moveX, moveY);
        return;
      }
      if (this.surfaceType === 'ceiling') {
        this.tryWrapCeilingCorner();
        return;
      }
      if (this.tryWrapWallBottomCorner()) return;
      if (this.tryWrapWallCorner()) return;
      if (!this.wallHasSupport()) {
        if (this.pounceBufferTimer > 0) return;
        this.detachFromSurface();
      }
      return;
    }

    // A pounce is a committed attack. Preserving its launch momentum makes it
    // feel deliberate instead of collapsing back to ordinary run speed when
    // the player keeps holding a direction in mid-air.
    if (this.isPouncing && !this.grounded) {
      const previousX = this.position.x;
      this.position.x += this.velocity.x * dt;
      this.resolveHorizontal(previousX);
      return;
    }

    const target = moveX * this.moveSpeed;
    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;

    if (moveX !== 0) {
      this.velocity.x = moveToward(this.velocity.x, target, accel * dt);
    } else if (this.grounded) {
      this.velocity.x = moveToward(this.velocity.x, 0, GROUND_DRAG * dt);
    }

    const previousX = this.position.x;
    this.position.x += this.velocity.x * dt;
    if (this.tryWrapFloorCorner()) return;
    this.resolveHorizontal(previousX);
  }

  tryWrapFloorCorner() {
    const p = this.surfacePlatform;
    if (
      !this.grounded ||
      this.surfaceType !== 'floor' ||
      !p ||
      this.pounceBufferTimer > 0
    ) return false;

    const minimumX = p.x + Math.min(this.bodyHalfWidth, p.w / 2);
    const maximumX = p.x + p.w - Math.min(this.bodyHalfWidth, p.w / 2);
    const leavingLeft = this.velocity.x < 0 && this.position.x <= minimumX;
    const leavingRight = this.velocity.x > 0 && this.position.x >= maximumX;
    if (!leavingLeft && !leavingRight) return false;

    const side = leavingLeft ? 1 : -1;
    this.position.x = leavingLeft ? minimumX : maximumX;
    this.facing = Math.sign(this.velocity.x);
    this.beginFloorToWallCorner(p, side, this.velocity.x);
    return true;
  }

  beginFloorToWallCorner(platform, side, speed) {
    const endAngle = side === 1 ? -Math.PI / 2 : Math.PI / 2;
    const verticalInset = Math.min(CORNER_INSET, platform.h / 2);
    const endPosition = new Phaser.Math.Vector2(
      side === 1
        ? platform.x - this.bodyHalfWidth
        : platform.x + platform.w + this.bodyHalfWidth,
      platform.y + verticalInset,
    );
    const cos = Math.cos(endAngle);
    const sin = Math.sin(endAngle);
    const wallX = side === 1 ? platform.x : platform.x + platform.w;
    const footTargets = this.legs.map((leg) => {
      const localX = leg.restX * this.growthScale * this.facing;
      const localY = this.bodyHalfWidth;
      return new Phaser.Math.Vector2(
        wallX,
        Phaser.Math.Clamp(
          endPosition.y + localX * sin + localY * cos,
          platform.y + 1,
          platform.y + platform.h - 1,
        ),
      );
    });

    this.cornerTransition = {
      elapsed: 0,
      startPosition: this.position.clone(),
      endPosition,
      startAngle: this.surfaceAngle,
      endAngle,
      endSurfaceType: 'wall',
      endSide: side,
      speed,
      platform,
      footStarts: this.legs.map((leg) => leg.foot.clone()),
      footTargets,
    };
    this.surfaceType = 'corner';
    this.velocity.set(0, 0);
    this.grounded = true;
  }

  tryWrapWallBottomCorner() {
    const p = this.surfacePlatform;
    if (
      this.surfaceType !== 'wall' ||
      !p ||
      this.velocity.y <= 0 ||
      this.pounceBufferTimer > 0
    ) return false;

    const maximumY =
      p.y + p.h - Math.min(this.bodyHalfWidth, p.h / 2);
    if (this.position.y <= maximumY) return false;

    this.position.y = maximumY;
    this.beginWallToCeilingCorner(p);
    return true;
  }

  beginWallToCeilingCorner(platform) {
    const side = this.surfaceSide;
    const horizontalInset = Math.min(CORNER_INSET, platform.w / 2);
    const endAngle = side === 1 ? -Math.PI : Math.PI;
    const endPosition = new Phaser.Math.Vector2(
      side === 1
        ? platform.x + horizontalInset
        : platform.x + platform.w - horizontalInset,
      platform.y + platform.h + this.bodyHalfHeight,
    );
    const footTargets = this.legs.map((leg) => {
      const localX = leg.restX * this.growthScale * this.facing;
      return new Phaser.Math.Vector2(
        Phaser.Math.Clamp(
          endPosition.x + localX * Math.cos(endAngle),
          platform.x + 1,
          platform.x + platform.w - 1,
        ),
        platform.y + platform.h,
      );
    });

    this.cornerTransition = {
      elapsed: 0,
      startPosition: this.position.clone(),
      endPosition,
      startAngle: this.surfaceAngle,
      endAngle,
      finalAngle: endAngle,
      endSurfaceType: 'ceiling',
      endSide: 0,
      speed: this.surfaceVelocity,
      platform,
      footStarts: this.legs.map((leg) => leg.foot.clone()),
      footTargets,
    };
    this.surfaceType = 'corner';
    this.velocity.set(0, 0);
    this.grounded = true;
  }

  tryWrapCeilingCorner() {
    const p = this.surfacePlatform;
    if (!p || this.pounceBufferTimer > 0) return false;

    const minimumX = p.x + Math.min(this.bodyHalfWidth, p.w / 2);
    const maximumX = p.x + p.w - Math.min(this.bodyHalfWidth, p.w / 2);
    const leavingLeft = this.velocity.x < 0 && this.position.x <= minimumX;
    const leavingRight = this.velocity.x > 0 && this.position.x >= maximumX;
    if (!leavingLeft && !leavingRight) return false;

    const side = leavingLeft ? 1 : -1;
    this.position.x = leavingLeft ? minimumX : maximumX;
    this.beginCeilingToWallCorner(p, side);
    return true;
  }

  beginCeilingToWallCorner(platform, side) {
    const canonicalAngle = side === 1 ? -Math.PI / 2 : Math.PI / 2;
    let endAngle = canonicalAngle;
    while (endAngle - this.surfaceAngle > Math.PI) endAngle -= Math.PI * 2;
    while (endAngle - this.surfaceAngle < -Math.PI) endAngle += Math.PI * 2;

    const verticalInset = Math.min(CORNER_INSET, platform.h / 2);
    const endPosition = new Phaser.Math.Vector2(
      side === 1
        ? platform.x - this.bodyHalfWidth
        : platform.x + platform.w + this.bodyHalfWidth,
      platform.y + platform.h - verticalInset,
    );
    const wallX = side === 1 ? platform.x : platform.x + platform.w;
    const footTargets = this.legs.map((leg) => {
      const localX = leg.restX * this.growthScale * this.facing;
      return new Phaser.Math.Vector2(
        wallX,
        Phaser.Math.Clamp(
          endPosition.y + localX * Math.sin(endAngle),
          platform.y + 1,
          platform.y + platform.h - 1,
        ),
      );
    });

    this.cornerTransition = {
      elapsed: 0,
      startPosition: this.position.clone(),
      endPosition,
      startAngle: this.surfaceAngle,
      endAngle,
      finalAngle: canonicalAngle,
      endSurfaceType: 'wall',
      endSide: side,
      speed: this.surfaceVelocity,
      platform,
      footStarts: this.legs.map((leg) => leg.foot.clone()),
      footTargets,
    };
    this.surfaceType = 'corner';
    this.velocity.set(0, 0);
    this.grounded = true;
  }

  tryPounce() {
    if (
      this.pounceBufferTimer <= 0 ||
      this.cornerTransition ||
      !this.grounded ||
      this.surfaceType !== 'floor'
    ) return false;

    // Pounces only begin from a planted floor stance. The smaller upward
    // impulse produces a low, aggressive arc in the facing direction.
    let nextAttack = Phaser.Math.Between(0, POUNCE_ATTACKS.length - 1);
    if (nextAttack === this.pounceAttackIndex) {
      nextAttack = (nextAttack + 1) % POUNCE_ATTACKS.length;
    }
    this.pounceAttackIndex = nextAttack;
    const attack = POUNCE_ATTACKS[nextAttack];
    this.attackBubbleTimer = 0.65;
    this.attackBubbleText.setText(attack.name);

    this.pounceAngle = this.surfaceAngle;
    const forward = this.localToWorld(this.facing, 0);
    const away = this.localToWorld(0, -1);
    const speedScale = this.moveSpeed / RUN_SPEED;
    this.velocity.set(
      forward.x * POUNCE_FORWARD_SPEED * attack.forward * speedScale +
        away.x * POUNCE_LIFT_SPEED * attack.lift,
      forward.y * POUNCE_FORWARD_SPEED * attack.forward * speedScale +
        away.y * POUNCE_LIFT_SPEED * attack.lift,
    );
    this.isPouncing = true;
    this.pounceTime = 0;
    this.grounded = false;
    this.detachFromSurface();
    this.pounceBufferTimer = 0;
    return true;
  }

  finishPounce() {
    if (!this.isPouncing) return;
    this.isPouncing = false;
  }

  beginLandingAnimation(impactSpeed) {
    this.landingStrength = Phaser.Math.Clamp(
      (impactSpeed - 24) / (MAX_FALL_SPEED - 24),
      0.28,
      1,
    );
    this.landingAnimationDuration = LANDING_DURATION + this.landingStrength * 0.08;
    this.landingAnimationTimer = this.landingAnimationDuration;
  }

  updateVertical(dt) {
    if (this.surfaceType === 'wall' || this.surfaceType === 'ceiling') {
      this.grounded = this.surfaceType === 'ceiling' || this.wallHasSupport();
      if (!this.grounded) this.detachFromSurface();
      return;
    }


    if (this.updateFloorTerrainPose(dt)) return;

    const wasGrounded = this.grounded;
    this.velocity.y = Math.min(MAX_FALL_SPEED, this.velocity.y + GRAVITY * dt);

    const previousY = this.position.y;
    this.position.y += this.velocity.y * dt;
    this.grounded = false;
    this.resolveVertical(previousY);

    if (!wasGrounded && this.grounded) {
      this.justLanded = true;
      this.finishPounce();
      this.beginLandingAnimation(this.lastLandingImpactSpeed);
      this.beginLandingStep(this.lastLandingImpactSpeed);
    }
  }

  updateFacing(moveX) {
    if (this.isPouncing || this.surfacePlatform?.climbable) return;
    if (moveX === 0) return;

    // Facing is expressed along the surface's local tangent. The ceiling's
    // tangent points toward world-left, so world input is inverted there.
    this.facing = this.surfaceType === 'ceiling'
      ? -Math.sign(moveX)
      : Math.sign(moveX);
  }

  getNearbyClimbable(maxDistance = 24) {
    let nearest = null;
    let nearestDistance = maxDistance + 1;

    for (const climbable of this.climbables) {
      if (
        this.position.y < climbable.y - this.bodyHalfHeight ||
        this.position.y > climbable.y + climbable.h + this.bodyHalfHeight
      ) continue;

      const distance = this.position.x < climbable.x
        ? climbable.x - this.position.x
        : this.position.x > climbable.x + climbable.w
          ? this.position.x - (climbable.x + climbable.w)
          : 0;
      if (distance >= nearestDistance) continue;
      nearest = climbable;
      nearestDistance = distance;
    }

    return nearest;
  }

  getConnectedPlatforms(climbable, side) {
    return this.platforms.filter((p) => {
      if (side === 1) {
        return (
          p.x < climbable.x &&
          p.x + p.w >= climbable.x - this.bodyHalfWidth
        );
      } else {
        return (
          p.x <= climbable.x + climbable.w + this.bodyHalfWidth &&
          p.x + p.w > climbable.x + climbable.w
        );
      }
    });
  }

  tryAttachToClimbable(moveY) {
    if (
      this.attachCooldown > 0 ||
      moveY === 0 ||
      !this.grounded ||
      this.surfaceType !== 'floor' ||
      this.cornerTransition ||
      this.isPouncing
    ) return false;

    // The feeler leg appears first; attachment waits until the body is close
    // enough that snapping onto the trunk is visually small.
    const climbable = this.getNearbyClimbable(16);
    if (!climbable) return false;

    if (moveY < 0 && this.position.y <= climbable.y + this.bodyHalfWidth) {
      return false;
    }
    if (
      moveY > 0 &&
      this.position.y >= climbable.y + climbable.h - this.bodyHalfHeight - 2
    ) {
      return false;
    }

    const centerX = climbable.x + climbable.w / 2;
    const side = this.position.x <= centerX ? 1 : -1;
    this.beginFloorToClimbable(climbable, side, moveY);
    return true;
  }

  beginFloorToClimbable(climbable, side, moveY = -1) {
    const endAngle = side === 1 ? -Math.PI / 2 : Math.PI / 2;
    const climbingUp = moveY < 0;
    const targetY = Phaser.Math.Clamp(
      this.position.y + (climbingUp ? -8 : 8),
      climbable.y + this.bodyHalfWidth,
      climbable.y + climbable.h - this.bodyHalfHeight,
    );
    const endPosition = new Phaser.Math.Vector2(
      side === 1
        ? climbable.x - this.bodyHalfWidth
        : climbable.x + climbable.w + this.bodyHalfWidth,
      targetY,
    );
    const wallX = side === 1 ? climbable.x : climbable.x + climbable.w;

    // Facing along the upward tangent makes the head lead the rotation and
    // puts the outer front legs onto the bark first.
    this.facing = climbingUp ? side : -side;
    const footTargets = this.legs.map((leg) => {
      const localX = leg.restX * this.growthScale * this.facing;
      const worldY = endPosition.y + localX * Math.sin(endAngle);
      return new Phaser.Math.Vector2(
        wallX,
        Phaser.Math.Clamp(
          worldY,
          climbable.y + 1,
          climbable.y + climbable.h - 1,
        ),
      );
    });

    this.cornerTransition = {
      elapsed: 0,
      duration: CLIMB_CORNER_DURATION,
      startPosition: this.position.clone(),
      endPosition,
      startAngle: 0,
      endAngle,
      finalAngle: endAngle,
      endSurfaceType: 'wall',
      endSide: side,
      speed: climbingUp
        ? side * this.moveSpeed * 0.5
        : -side * this.moveSpeed * 0.5,
      platform: climbable,
      arcX: -side * 4,
      arcY: climbingUp ? -5 : 5,
      footStarts: this.legs.map((leg) => leg.foot.clone()),
      footTargets,
    };
    this.surfaceType = 'corner';
    this.velocity.set(0, 0);
    this.grounded = true;
    this.climbProbeLegIndex = -1;
    this.climbProbeSurfaceX = null;
  }

  constrainClimbableMovement(moveX, moveY) {
    const climbable = this.surfacePlatform;
    if (!climbable?.climbable) return;

    const side = this.surfaceSide;
    const top = climbable.y + this.bodyHalfWidth;
    const bottom = climbable.y + climbable.h - this.bodyHalfHeight;

    const connectedPlatforms = this.getConnectedPlatforms(climbable, side);

    // 1. Horizontal input at a branch junction means world-space movement.
    // When the requested direction is across the trunk, carry the spider
    // around the bark and onto the branch on that side instead of accepting a
    // movement command that can only press its body into the tree.
    if (moveX !== 0) {
      const exitSide = moveX < 0 ? 1 : -1;
      const exitPlatforms = exitSide === side
        ? connectedPlatforms
        : this.getConnectedPlatforms(climbable, exitSide);
      const nearbyPlatform = exitPlatforms.find((p) => {
        const floorBodyY = p.y - this.bodyHalfHeight;
        return Math.abs(this.position.y - floorBodyY) <= 36;
      });
      if (nearbyPlatform) {
        this.beginClimbableToFloor(
          climbable,
          nearbyPlatform,
          moveX * this.moveSpeed,
          exitSide,
        );
        return;
      }
    }

    // 2. If climbing UP onto an elevated platform blocking the trunk from below
    if (this.velocity.y < 0 || moveY < 0) {
      for (const p of connectedPlatforms) {
        const isElevatedPlatform = p.y < climbable.y + climbable.h - 12;
        if (!isElevatedPlatform) continue;

        const ceilingBodyY = p.y + p.h + this.bodyHalfHeight;
        if (
          this.position.y <= ceilingBodyY + 16 &&
          this.position.y >= ceilingBodyY - 8
        ) {
          this.position.y = Math.max(this.position.y, ceilingBodyY);
          this.beginClimbableToCeiling(
            climbable,
            p,
            this.moveSpeed,
          );
          return;
        }
      }
    }

    // 3. If climbing DOWN onto a platform or bottom floor
    if (this.velocity.y > 0 || moveY > 0) {
      for (const p of connectedPlatforms) {
        const floorBodyY = p.y - this.bodyHalfHeight;
        const exitStart = floorBodyY - CORNER_INSET;
        if (this.position.y >= exitStart && this.position.y <= floorBodyY + 4) {
          this.position.y = Math.min(this.position.y, floorBodyY);
          this.beginClimbableToFloor(
            climbable,
            p,
            side === 1 ? -this.moveSpeed : this.moveSpeed,
          );
          return;
        }
      }
    }

    // 4. Top boundary. Continue around the cork edge and plant on the cap
    // instead of stopping on the final vertical pixel of the trunk.
    if (this.position.y < top) {
      this.position.y = top;
      if (this.velocity.y < 0 || moveY < 0) {
        this.beginClimbableToFloor(
          climbable,
          climbable,
          this.surfaceVelocity,
          side,
        );
      } else {
        this.surfaceVelocity = 0;
        this.velocity.set(0, 0);
      }
      return;
    }

    // 5. Bottom boundary
    if (this.position.y > bottom) {
      this.position.y = bottom;
      this.surfaceVelocity = 0;
      this.velocity.set(0, 0);
      return;
    }
  }

  beginClimbableToCeiling(_climbable, ceilingPlatform, initialSpeed = 0) {
    const side = this.surfaceSide;
    const awayDirection = side;
    const endX = Phaser.Math.Clamp(
      this.position.x + (side === 1 ? -12 : 12),
      ceilingPlatform.x + this.bodyHalfWidth,
      ceilingPlatform.x + ceilingPlatform.w - this.bodyHalfWidth,
    );
    const endPosition = new Phaser.Math.Vector2(
      endX,
      ceilingPlatform.y + ceilingPlatform.h + this.bodyHalfHeight,
    );
    const endAngle = side === 1 ? -Math.PI : Math.PI;
    this.facing = awayDirection;

    const footTargets = this.legs.map((leg) => {
      const localX = leg.restX * this.growthScale * this.facing;
      return new Phaser.Math.Vector2(
        Phaser.Math.Clamp(
          endX + localX * Math.cos(endAngle),
          ceilingPlatform.x + 1,
          ceilingPlatform.x + ceilingPlatform.w - 1,
        ),
        ceilingPlatform.y + ceilingPlatform.h,
      );
    });

    this.attachCooldown = 0.45;
    this.cornerTransition = {
      elapsed: 0,
      duration: CLIMB_CORNER_DURATION,
      startPosition: this.position.clone(),
      endPosition,
      startAngle: this.surfaceAngle,
      endAngle,
      finalAngle: endAngle,
      endSurfaceType: 'ceiling',
      endSide: 0,
      speed: awayDirection * Math.abs(initialSpeed || this.moveSpeed),
      platform: ceilingPlatform,
      arcX: side === 1 ? -6 : 6,
      arcY: 6,
      footStarts: this.legs.map((leg) => leg.foot.clone()),
      footTargets,
    };
    this.surfaceType = 'corner';
    this.velocity.set(0, 0);
    this.grounded = true;
  }

  beginClimbableToFloor(climbable, floor, initialSpeed = 0, exitSide = this.surfaceSide) {
    const side = exitSide;
    const crossingTrunk = side !== this.surfaceSide;
    const requestedX = crossingTrunk
      ? side === 1
        ? climbable.x - this.bodyHalfWidth - 4
        : climbable.x + climbable.w + this.bodyHalfWidth + 4
      : this.position.x + (side === 1 ? -12 : 12);
    const endX = Phaser.Math.Clamp(
      requestedX,
      floor.x + this.bodyHalfWidth,
      floor.x + floor.w - this.bodyHalfWidth,
    );
    const endPosition = new Phaser.Math.Vector2(
      endX,
      floor.y - this.bodyHalfHeight,
    );
    this.facing = side === 1 ? -1 : 1;
    const footTargets = this.legs.map((leg) => new Phaser.Math.Vector2(
      Phaser.Math.Clamp(
        endX + leg.restX * this.growthScale * this.facing,
        floor.x + 1,
        floor.x + floor.w - 1,
      ),
      floor.y,
    ));

    this.attachCooldown = 0.45;
    this.cornerTransition = {
      elapsed: 0,
      duration: CLIMB_CORNER_DURATION,
      startPosition: this.position.clone(),
      endPosition,
      startAngle: this.surfaceAngle,
      endAngle: 0,
      finalAngle: 0,
      endSurfaceType: 'floor',
      endSide: 0,
      speed: initialSpeed ||
        (side === 1 ? -this.moveSpeed : this.moveSpeed),
      platform: floor,
      arcX: side === 1 ? -6 : 6,
      arcY: -6,
      footStarts: this.legs.map((leg) => leg.foot.clone()),
      footTargets,
    };
    this.surfaceType = 'corner';
    this.velocity.set(0, 0);
    this.grounded = true;
  }

  updateClimbableProbe(dt) {
    if (
      !this.grounded ||
      this.surfaceType !== 'floor' ||
      this.cornerTransition ||
      this.isPouncing
    ) {
      this.climbProbeLegIndex = -1;
      this.climbProbeSurfaceX = null;
      return;
    }

    const climbable = this.getNearbyClimbable(25);
    if (!climbable) {
      this.releaseClimbableProbe();
      return;
    }

    const centerX = climbable.x + climbable.w / 2;
    const trunkDirection = Math.sign(centerX - this.position.x || this.facing);
    const trunkIsBehind = trunkDirection * this.facing < 0;
    if (trunkIsBehind) {
      this.releaseClimbableProbe();
      return;
    }

    if (this.climbProbeLegIndex < 0) {
      const towardRight = centerX >= this.position.x;
      const pointsTowardFront = (towardRight ? 1 : -1) * this.facing > 0;
      this.climbProbeLegIndex = pointsTowardFront ? 7 : 4;
      const leftDistance = Math.abs(this.position.x - climbable.x);
      const rightDistance = Math.abs(
        this.position.x - (climbable.x + climbable.w),
      );
      this.climbProbeSurfaceX = leftDistance <= rightDistance
        ? climbable.x
        : climbable.x + climbable.w;
    }

    const leg = this.legs[this.climbProbeLegIndex];
    const targetY = Phaser.Math.Clamp(
      this.position.y - 6,
      climbable.y + 2,
      climbable.y + climbable.h - 2,
    );
    const smoothing = 1 - Math.pow(0.0002, dt);

    leg.isStepping = false;
    leg.stepT = 1;
    leg.foot.x = Phaser.Math.Linear(
      leg.foot.x,
      this.climbProbeSurfaceX,
      smoothing,
    );
    leg.foot.y = Phaser.Math.Linear(leg.foot.y, targetY, smoothing);
  }

  releaseClimbableProbe() {
    if (this.climbProbeLegIndex < 0) return;

    const leg = this.legs[this.climbProbeLegIndex];
    const speedLead = Phaser.Math.Clamp(this.velocity.x * 0.11, -6, 6);
    const target = this.getGroundTarget(leg, speedLead);
    if (target) {
      leg.stepStart.copy(leg.foot);
      leg.stepTarget.copy(target);
      leg.stepT = 0;
      // The foot is already elevated on the bark. A shallow return arc avoids
      // pulling the rear leg even higher before it comes back to the ground.
      leg.stepHeight = 1.5;
      leg.isStepping = true;
    }
    this.climbProbeLegIndex = -1;
    this.climbProbeSurfaceX = null;
  }

  resolveHorizontal(previousX) {
    for (const p of this.platforms) {
      if (!this.overlapsPlatform(p)) continue;

      if (this.position.x > previousX) {
        this.attachToWall(p, 1);
      } else if (this.position.x < previousX) {
        this.attachToWall(p, -1);
      }
      return;
    }
  }

  attachToWall(platform, side) {
    this.surfaceType = 'wall';
    this.surfacePlatform = platform;
    this.surfaceSide = side;
    this.surfaceAngle = side === 1 ? -Math.PI / 2 : Math.PI / 2;
    this.position.x = side === 1
      ? platform.x - this.bodyHalfWidth
      : platform.x + platform.w + this.bodyHalfWidth;
    this.surfaceVelocity = 0;
    this.velocity.set(0, 0);
    this.grounded = true;
    this.finishPounce();
    this.plantAllFeet();
  }

  detachFromSurface() {
    this.surfaceType = null;
    this.surfacePlatform = null;
    this.surfaceSide = 0;
    this.surfaceAngle = 0;
    this.surfaceVelocity = 0;
    this.grounded = false;
  }

  respawnAt(x, y) {
    const ground = this.platforms.find((platform) => platform.h > 10) || this.platforms[0];
    this.position.set(x, y);
    this.velocity.set(0, 0);
    this.health = this.maxHealth;
    this.isDead = false;
    this.isPouncing = false;
    this.pounceBufferTimer = 0;
    this.pounceTime = 0;
    this.pounceAttackIndex = -1;
    this.attackBubbleTimer = 0;
    this.surfaceType = 'floor';
    this.surfacePlatform = ground || null;
    this.surfaceSide = 0;
    this.surfaceAngle = 0;
    this.surfaceVelocity = 0;
    this.grounded = true;
    this.cornerTransition = null;
    this.cancelIdleHurry();
    this.clearIdlePose();
    this.resetIdleMatterRig();
    this.plantAllFeet();
    this.resetHeadSpring();
  }

  wallHasSupport() {
    const p = this.surfacePlatform;
    return Boolean(
      p &&
      this.position.y >= p.y - this.bodyHalfWidth &&
      this.position.y <= p.y + p.h + this.bodyHalfWidth,
    );
  }

  tryWrapWallCorner() {
    const p = this.surfacePlatform;
    const movingOverTop = this.surfaceVelocity * this.surfaceSide > 0;
    if (
      !p ||
      !movingOverTop ||
      this.position.y > p.y + this.bodyHalfWidth
    ) return false;

    const side = this.surfaceSide;
    const inset = Math.min(CORNER_INSET, p.w / 2);
    const endX = side === 1 ? p.x + inset : p.x + p.w - inset;
    const endY = p.y - this.bodyHalfHeight;
    const footTargets = this.legs.map((leg) => new Phaser.Math.Vector2(
      Phaser.Math.Clamp(
        endX + leg.restX * this.growthScale * this.facing,
        p.x + 1,
        p.x + p.w - 1,
      ),
      p.y,
    ));

    this.cornerTransition = {
      elapsed: 0,
      startPosition: this.position.clone(),
      endPosition: new Phaser.Math.Vector2(endX, endY),
      startAngle: this.surfaceAngle,
      endAngle: 0,
      endSurfaceType: 'floor',
      endSide: 0,
      speed: this.surfaceVelocity,
      platform: p,
      footStarts: this.legs.map((leg) => leg.foot.clone()),
      footTargets,
    };
    this.surfaceType = 'corner';
    this.velocity.set(0, 0);
    this.grounded = true;
    return true;
  }

  updateCornerTransition(dt) {
    const corner = this.cornerTransition;
    if (!corner) return;

    const duration = corner.duration ?? CORNER_DURATION;
    corner.elapsed = Math.min(duration, corner.elapsed + dt);
    const progress = corner.elapsed / duration;
    const bodyT = Phaser.Math.Easing.Sine.InOut(progress);
    const arc = Math.sin(Math.PI * bodyT);

    this.position.set(
      Phaser.Math.Linear(corner.startPosition.x, corner.endPosition.x, bodyT) +
        (corner.arcX ?? 0) * arc,
      Phaser.Math.Linear(corner.startPosition.y, corner.endPosition.y, bodyT) +
        (corner.arcY ?? 0) * arc,
    );
    this.surfaceAngle = Phaser.Math.Linear(
      corner.startAngle,
      corner.endAngle,
      bodyT,
    );
    this.bodyBob = 0;

    for (let i = 0; i < this.legs.length; i += 1) {
      const leg = this.legs[i];
      const delay = leg.group * 0.22;
      const legProgress = Phaser.Math.Clamp(
        (progress - delay) / (1 - delay),
        0,
        1,
      );
      const legT = Phaser.Math.Easing.Sine.InOut(legProgress);
      const lift = Math.sin(Math.PI * legT) * (STEP_HEIGHT + 1);
      const legAngle = Phaser.Math.Linear(
        corner.startAngle,
        corner.endAngle,
        legT,
      );
      const awayX = Math.sin(legAngle);
      const awayY = -Math.cos(legAngle);
      leg.foot.set(
        Phaser.Math.Linear(corner.footStarts[i].x, corner.footTargets[i].x, legT) +
          awayX * lift,
        Phaser.Math.Linear(corner.footStarts[i].y, corner.footTargets[i].y, legT) +
          awayY * lift,
      );
      leg.isStepping = legProgress < 1;
      leg.stepT = legT;
    }

    if (progress < 1) return;

    this.surfaceType = corner.endSurfaceType;
    this.surfacePlatform = corner.platform;
    this.surfaceSide = corner.endSide;
    this.surfaceAngle = corner.finalAngle ?? corner.endAngle;
    const tangent = this.localToWorld(1, 0);
    this.velocity.set(tangent.x * corner.speed, tangent.y * corner.speed);
    this.surfaceVelocity = corner.speed;
    this.grounded = true;
    for (let i = 0; i < this.legs.length; i += 1) {
      this.legs[i].foot.copy(corner.footTargets[i]);
      this.legs[i].isStepping = false;
      this.legs[i].stepT = 1;
      this.legs[i].stepHeight = STEP_HEIGHT;
    }
    this.cornerTransition = null;
  }

  localToWorld(x, y) {
    const cos = Math.cos(this.surfaceAngle);
    const sin = Math.sin(this.surfaceAngle);
    return new Phaser.Math.Vector2(
      x * cos - y * sin,
      x * sin + y * cos,
    );
  }

  localPointToWorld(x, y) {
    const offset = this.localToWorld(x, y);
    offset.x += this.position.x;
    offset.y += this.position.y;
    return offset;
  }

  worldToLocal(x, y) {
    const dx = x - this.position.x;
    const dy = y - this.position.y;
    const cos = Math.cos(this.surfaceAngle);
    const sin = Math.sin(this.surfaceAngle);
    return new Phaser.Math.Vector2(
      dx * cos + dy * sin,
      -dx * sin + dy * cos,
    );
  }

  worldToRenderLocal(x, y) {
    const dx = x - this.position.x;
    const dy = y - this.position.y;
    const angle = this.isPouncing ? this.pounceAngle : this.surfaceAngle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Phaser.Math.Vector2(
      (dx * cos + dy * sin) / this.growthScale,
      (-dx * sin + dy * cos) / this.growthScale,
    );
  }

  resolveVertical(previousY) {
    for (const p of this.platforms) {
      const overlapsX =
        this.position.x + this.bodyHalfWidth > p.x &&
        this.position.x - this.bodyHalfWidth < p.x + p.w;
      if (!overlapsX) continue;

      if (this.position.y > previousY && this.velocity.y >= 0) {
        const landingY = this.getFloorBodyY(p);
        if (previousY > landingY || this.position.y < landingY) continue;
        const impactSpeed = this.velocity.y;
        this.lastLandingImpactSpeed = impactSpeed;
        this.position.y = landingY;
        this.velocity.y = 0;
        this.grounded = true;
        this.surfaceType = 'floor';
        this.surfacePlatform = p;
        this.surfaceSide = 0;
        this.surfaceAngle = 0;
        this.applyFallDamage(impactSpeed);
      } else if (
        this.position.y < previousY &&
        this.velocity.y < 0 &&
        this.overlapsPlatform(p)
      ) {
        this.position.y = p.y + p.h + this.bodyHalfHeight;
        this.velocity.y = 0;
      }
    }
  }

  isGroundTerrainPlatform(platform) {
    return this.terrainGroundY !== null &&
      Math.abs(platform.y - this.terrainGroundY) < 0.01;
  }

  getFloorSurfaceY(x, platform = this.surfacePlatform) {
    if (!platform) return null;
    if (!this.isGroundTerrainPlatform(platform)) return platform.y;
    return getWalkableSurfaceY(this.floorStones, x, this.terrainGroundY);
  }

  getFloorBodyY(platform = this.surfacePlatform, x = this.position.x) {
    if (!platform) return this.position.y;
    if (!this.isGroundTerrainPlatform(platform)) {
      return platform.y - this.bodyHalfHeight;
    }
    return getSpiderBodySurfaceY(
      this.floorStones,
      x,
      this.terrainGroundY,
      this.bodyHalfWidth,
      this.bodyHalfHeight,
    );
  }

  updateFloorTerrainPose(dt) {
    if (!this.grounded || this.surfaceType !== 'floor' || !this.surfacePlatform) {
      return false;
    }

    this.position.y = this.getFloorBodyY();
    this.velocity.y = 0;

    // A restrained slope makes the abdomen roll over the rock while the feet
    // remain independently planted on its visible outline.
    const sampleDistance = Math.max(1, this.bodyHalfWidth * 0.4);
    const before = this.getFloorBodyY(this.surfacePlatform, this.position.x - sampleDistance);
    const after = this.getFloorBodyY(this.surfacePlatform, this.position.x + sampleDistance);
    const targetAngle = Phaser.Math.Clamp(
      Math.atan2(after - before, sampleDistance * 2),
      -0.24,
      0.24,
    );
    const smoothing = 1 - Math.pow(0.002, dt);
    this.surfaceAngle = Phaser.Math.Linear(this.surfaceAngle, targetAngle, smoothing);
    return true;
  }

  overlapsPlatform(p) {
    return (
      this.position.x + this.bodyHalfWidth > p.x &&
      this.position.x - this.bodyHalfWidth < p.x + p.w &&
      this.position.y + this.bodyHalfHeight > p.y &&
      this.position.y - this.bodyHalfHeight < p.y + p.h
    );
  }

  updateLegs(dt, moveX) {
    if (!this.grounded) {
      this.updateAirLegs(dt);
      return;
    }

    // Finish in-progress steps first.
    for (const leg of this.legs) {
      if (!leg.isStepping) continue;

      leg.stepT = Math.min(1, leg.stepT + dt / (leg.stepDuration || STEP_DURATION));
      const t = Phaser.Math.Easing.Sine.InOut(leg.stepT);
      const stepLift = Math.sin(Math.PI * t) * leg.stepHeight;
      const away = this.localToWorld(0, -1);
      leg.foot.x =
        Phaser.Math.Linear(leg.stepStart.x, leg.stepTarget.x, t) +
        away.x * stepLift;
      leg.foot.y =
        Phaser.Math.Linear(leg.stepStart.y, leg.stepTarget.y, t) +
        away.y * stepLift;

      if (leg.stepT >= 1) {
        leg.isStepping = false;
        leg.stepHeight = STEP_HEIGHT;
        leg.stepDuration = STEP_DURATION;
        leg.foot.copy(leg.stepTarget);
      }
    }

    const anyStepping = this.legs.some((leg) => leg.isStepping);
    if (anyStepping) return;

    // Plant feet farther out and ahead of the body during a run, creating a
    // quick lateral sweep instead of a tight shuffle beneath the torso.
    const travelSpeed = this.surfaceType === 'wall' || this.surfaceType === 'ceiling' || this.surfaceType === 'silk'
      ? this.surfaceVelocity
      : this.velocity.x;
    const speedLead = Phaser.Math.Clamp(travelSpeed * 0.11, -6, 6);
    const candidates = this.legs.filter((leg) => leg.group === this.currentGaitGroup);

    const shouldStep = candidates.some((leg) => {
      const target = this.getGroundTarget(leg, speedLead);
      return (
        target &&
        Phaser.Math.Distance.Between(leg.foot.x, leg.foot.y, target.x, target.y) >
          STEP_TRIGGER
      );
    });

    if (!shouldStep) return;

    let started = false;
    for (const leg of candidates) {
      const target = this.getGroundTarget(leg, speedLead);
      if (!target) continue;

      const distance = Phaser.Math.Distance.Between(
        leg.foot.x,
        leg.foot.y,
        target.x,
        target.y,
      );

      if (distance < STEP_TRIGGER * 0.55 && moveX === 0) continue;

      leg.stepStart.copy(leg.foot);
      leg.stepTarget.copy(target);
      leg.stepT = 0;
      const obstacleRise = Math.max(0, leg.stepStart.y - leg.stepTarget.y);
      leg.stepHeight = STEP_HEIGHT + Math.min(4, obstacleRise * 0.45);
      leg.isStepping = true;
      started = true;
    }

    if (started) this.currentGaitGroup = 1 - this.currentGaitGroup;
  }

  updateAirLegs(dt) {
    // Airborne feet seek procedural poses based on body velocity. Pounces use
    // the dedicated forward-reaching attack pose below.
    const descent = Phaser.Math.Clamp((this.velocity.y - 15) / (MAX_FALL_SPEED - 15), 0, 1);
    const ascentTuck = Phaser.Math.Clamp(-this.velocity.y / POUNCE_LIFT_SPEED, 0, 1);
    const smoothing = 1 - Math.pow(0.0001, dt);

    for (let i = 0; i < this.legs.length; i += 1) {
      const leg = this.legs[i];
      leg.isStepping = false;

      const pairIndex = i % 4;
      if (this.isPouncing) {
        // Rear pairs fold beneath the abdomen while the front pairs open into
        // a forward-reaching attack shape over the first few frames.
        const extension = Phaser.Math.Easing.Sine.Out(
          Phaser.Math.Clamp((this.pounceTime - 0.025) / 0.16, 0, 1),
        );
        const attack = POUNCE_ATTACKS[this.pounceAttackIndex] ||
          POUNCE_ATTACKS[0];
        const restingX = [-7, -2, 7, 10][pairIndex];
        const restingY = [6, 5, 6, 5][pairIndex];
        const attackX = Phaser.Math.Linear(
          restingX,
          attack.feetX[pairIndex],
          extension,
        );
        const attackY = Phaser.Math.Linear(
          restingY,
          attack.feetY[pairIndex],
          extension,
        );
        const layerOffset = leg.layer === 'near' ? 1 : -1;
        const localX =
          (attackX + layerOffset) * this.facing * this.growthScale;
        const localY =
          (attackY + Math.abs(layerOffset)) * this.growthScale;
        const cos = Math.cos(this.pounceAngle);
        const sin = Math.sin(this.pounceAngle);
        const targetX = this.position.x + localX * cos - localY * sin;
        const targetY = this.position.y + localX * sin + localY * cos;

        leg.foot.x = Phaser.Math.Linear(leg.foot.x, targetX, smoothing);
        leg.foot.y = Phaser.Math.Linear(leg.foot.y, targetY, smoothing);
        continue;
      }

      // Tuck immediately after leaving a surface, then spread all four pairs
      // into a wide, downward-reaching brace as the ground approaches.
      const baseSpread = [-10, -5, 5, 10][pairIndex];
      const spread = baseSpread * (1 - ascentTuck * 0.24 + descent * 0.62) * this.facing;
      const layerOffset = leg.layer === 'near' ? 1 : -1;
      const reach = [3, 5, 5, 3][pairIndex] * descent;
      const tuckedY = [5, 6, 6, 5][pairIndex] - ascentTuck * 2;

      const targetX = this.position.x +
        (spread + layerOffset * this.facing) * this.growthScale;
      const targetY = this.position.y +
        (tuckedY + reach + Math.abs(layerOffset)) * this.growthScale;

      leg.foot.x = Phaser.Math.Linear(leg.foot.x, targetX, smoothing);
      leg.foot.y = Phaser.Math.Linear(leg.foot.y, targetY, smoothing);
    }
  }

  getFloorStanceShift(speedLead = 0) {
    const p = this.surfacePlatform;
    if (this.surfaceType !== 'floor' || !p) return 0;

    const offsets = this.legs.map(
      (leg) => leg.restX * this.growthScale * this.facing,
    );
    const minOffset = Math.min(...offsets);
    const maxOffset = Math.max(...offsets);
    const left = p.x + 1;
    const right = p.x + p.w - 1;
    const minimumShift = left - (this.position.x + minOffset + speedLead);
    const maximumShift = right - (this.position.x + maxOffset + speedLead);

    // Keep the complete stance together when landing near an edge. Platforms
    // narrower than the stance are handled by the final per-foot clamp.
    return minimumShift <= maximumShift
      ? Phaser.Math.Clamp(0, minimumShift, maximumShift)
      : 0;
  }

  getGroundTarget(leg, speedLead = 0) {
    if (this.surfaceType === 'silk') {
      const localX = leg.restX * this.growthScale * this.facing + speedLead;
      const layerOffset = leg.layer === 'near' ? 2 : -2;
      const target = this.localPointToWorld(localX, layerOffset);
      return new Phaser.Math.Vector2(Math.round(target.x), Math.round(target.y));
    }
    if (this.surfaceType === 'wall') {
      const localX = leg.restX * this.growthScale * this.facing + speedLead;
      const p = this.surfacePlatform;
      if (!p) return null;

      const target = this.localPointToWorld(localX, this.bodyHalfWidth);
      target.x = this.surfaceSide === 1 ? p.x : p.x + p.w;
      target.y = Phaser.Math.Clamp(target.y, p.y + 1, p.y + p.h - 1);
      return new Phaser.Math.Vector2(Math.round(target.x), Math.round(target.y));
    }

    if (this.surfaceType === 'ceiling') {
      const p = this.surfacePlatform;
      if (!p) return null;

      const localX = leg.restX * this.growthScale * this.facing + speedLead;
      const target = this.localPointToWorld(localX, this.bodyHalfHeight);
      target.x = Phaser.Math.Clamp(target.x, p.x + 1, p.x + p.w - 1);
      target.y = p.y + p.h;
      return new Phaser.Math.Vector2(Math.round(target.x), Math.round(target.y));
    }

    if (this.surfaceType === 'floor' && this.surfacePlatform) {
      const p = this.surfacePlatform;
      const stanceShift = this.getFloorStanceShift(speedLead);
      const targetX = Phaser.Math.Clamp(
        this.position.x +
          leg.restX * this.growthScale * this.facing +
          speedLead +
          stanceShift,
        p.x + 1,
        p.x + p.w - 1,
      );
      const roundedTargetX = Math.round(targetX);
      return new Phaser.Math.Vector2(
        roundedTargetX,
        this.getFloorSurfaceY(roundedTargetX, p),
      );
    }

    const targetX =
      this.position.x + leg.restX * this.growthScale * this.facing + speedLead;

    const surfaceY = this.findPlatformTop(targetX, this.position.y - 2, 30);
    if (surfaceY === null) return null;

    return new Phaser.Math.Vector2(Math.round(targetX), surfaceY);
  }

  findPlatformTop(x, fromY, maxDistance) {
    let nearest = null;

    for (const p of this.platforms) {
      // Keep toes one pixel away from platform corners so they don't visually
      // hang into empty space.
      if (x < p.x + 1 || x > p.x + p.w - 1) continue;
      if (p.y < fromY) continue;
      if (p.y - fromY > maxDistance) continue;

      if (nearest === null || p.y < nearest) nearest = p.y;
    }

    return nearest;
  }

  plantAllFeet() {
    for (const leg of this.legs) {
      const target = this.getGroundTarget(leg, 0);
      if (target) {
        leg.foot.copy(target);
      } else {
        leg.foot.set(
          this.position.x + leg.restX * this.growthScale * this.facing,
          this.position.y + (BODY_HALF_H + 5) * this.growthScale,
        );
      }
      leg.isStepping = false;
      leg.stepT = 1;
      leg.stepHeight = STEP_HEIGHT;
      leg.stepDuration = STEP_DURATION;
    }
  }

  beginLandingStep(impactSpeed = 0) {
    const brace = Phaser.Math.Clamp((impactSpeed - 24) / (MAX_FALL_SPEED - 24), 0.28, 1);
    for (let index = 0; index < this.legs.length; index += 1) {
      const leg = this.legs[index];
      const target = this.getGroundTarget(leg, 0);
      if (!target) continue;

      const outward = Math.sign(leg.restX * this.facing);
      const platform = this.surfacePlatform;
      target.x += outward * (2 + brace * 4);
      if (platform) {
        target.x = Phaser.Math.Clamp(target.x, platform.x + 1, platform.x + platform.w - 1);
        if (this.surfaceType === 'floor') {
          target.y = this.getFloorSurfaceY(target.x, platform);
        }
      }

      leg.stepStart.copy(leg.foot);
      leg.stepTarget.copy(target);
      leg.stepT = 0;
      leg.stepHeight = 0.8 + (index % 2) * 0.45;
      leg.stepDuration = 0.13 + (index % 4) * 0.012;
      leg.isStepping = true;
    }
  }

  solveKnee(hip, foot, upperLength, lowerLength, bendSign) {
    const dx = foot.x - hip.x;
    const dy = foot.y - hip.y;
    const rawDistance = Math.max(0.001, Math.hypot(dx, dy));
    const distance = Phaser.Math.Clamp(
      rawDistance,
      Math.abs(upperLength - lowerLength) + 0.001,
      upperLength + lowerLength - 0.001,
    );

    const dirX = dx / rawDistance;
    const dirY = dy / rawDistance;
    const a =
      (upperLength * upperLength - lowerLength * lowerLength + distance * distance) /
      (2 * distance);
    const h = Math.sqrt(Math.max(0, upperLength * upperLength - a * a));

    const midX = hip.x + dirX * a;
    const midY = hip.y + dirY * a;
    // An effectiveBend of -1 when dx >= 0 and +1 when dx < 0 ensures perpY <= 0 (upward arch away from ground)
    const effectiveBend = bendSign !== undefined ? bendSign : (dx >= 0 ? -1 : 1);
    const perpX = -dirY * effectiveBend;
    const perpY = dirX * effectiveBend;

    const kneeY = Math.min(midY + perpY * h, foot.y);
    return new Phaser.Math.Vector2(midX + perpX * h, kneeY);
  }

  draw() {
    this.graphicsShadow.clear();
    this.graphicsFar.clear();
    this.graphicsBody.clear();
    this.graphicsNear.clear();

    const renderAngle = this.isPouncing ? this.pounceAngle : this.surfaceAngle;
    for (const graphics of [
      this.graphicsFar,
      this.graphicsBody,
      this.graphicsNear,
    ]) {
      graphics.setPosition(this.position.x, this.position.y);
      graphics.setRotation(renderAngle);
      graphics.setScale(this.growthScale);
    }

    if (this.grounded) {
      const shadowWidth = (17 + this.scuttleAmount * 4) * this.landingPose.shadowScale;
      if (this.surfaceType === 'floor') {
        const surfaceY = this.getFloorSurfaceY(this.position.x) ??
          this.position.y + this.bodyHalfHeight;
        this.graphicsShadow
          .setPosition(this.position.x, surfaceY)
          .setRotation(0)
          .setScale(this.growthScale);
      } else {
        this.graphicsShadow
          .setPosition(this.position.x, this.position.y)
          .setRotation(renderAngle)
          .setScale(this.growthScale);
      }
      this.graphicsShadow.fillStyle(0x31402f, 0.25);
      this.graphicsShadow.fillEllipse(
        0,
        this.surfaceType === 'floor' ? 0 : BODY_HALF_H,
        shadowWidth,
        2,
      );
    }

    this.drawLegLayer(this.graphicsFar, 'far', 0x857d91, 0x948ca0);
    this.drawBody(this.graphicsBody);
    this.drawLegLayer(this.graphicsNear, 'near', 0x5e576e, 0x777085);
    this.drawAttackBubble();
    this.drawCommandBubble();
  }

  drawCommandBubble() {
    this.graphicsCommandBubble.clear();
    if (this.commandBubbleTimer <= 0 || this.isDead) {
      this.commandBubbleText.setVisible(false);
      return;
    }

    const screenWidth = this.scene.scale?.width || 768;
    const textWidth = this.commandBubbleText.width;
    const width = Math.min(340, textWidth + 20);
    const halfW = width / 2;

    const boxX = Phaser.Math.Clamp(Math.round(this.position.x), halfW + 10, screenWidth - halfW - 10);
    const tailX = Phaser.Math.Clamp(Math.round(this.position.x), boxX - halfW + 14, boxX + halfW - 14);

    const attackOffset = this.attackBubbleTimer > 0 ? 18 : 0;
    const spiderTopOffset = (BODY_HALF_H + 7) * this.growthScale;
    const isBelow = this.surfaceType === 'ceiling' || (this.position.y - spiderTopOffset - 28 < 10);

    let bubbleY;
    let boxTop;
    let boxBottom;
    let tailTipY;

    if (isBelow) {
      tailTipY = Math.round(this.position.y + spiderTopOffset + 2);
      boxTop = tailTipY + 4;
      bubbleY = boxTop + 10;
      boxBottom = boxTop + 20;

      this.graphicsCommandBubble.fillStyle(0xe7eccd, 0.96);
      this.graphicsCommandBubble.lineStyle(1, 0x65775e, 1);
      this.graphicsCommandBubble.fillRoundedRect(boxX - halfW, boxTop, width, 20, 4);
      this.graphicsCommandBubble.strokeRoundedRect(boxX - halfW, boxTop, width, 20, 4);
      this.graphicsCommandBubble.fillTriangle(
        tailX - 3, boxTop,
        tailX + 3, boxTop,
        tailX, tailTipY,
      );
    } else {
      tailTipY = Math.round(this.position.y - spiderTopOffset - attackOffset - 2);
      boxBottom = tailTipY - 4;
      boxTop = boxBottom - 20;
      bubbleY = boxBottom - 10;

      this.graphicsCommandBubble.fillStyle(0xe7eccd, 0.96);
      this.graphicsCommandBubble.lineStyle(1, 0x65775e, 1);
      this.graphicsCommandBubble.fillRoundedRect(boxX - halfW, boxTop, width, 20, 4);
      this.graphicsCommandBubble.strokeRoundedRect(boxX - halfW, boxTop, width, 20, 4);
      this.graphicsCommandBubble.fillTriangle(
        tailX - 3, boxBottom,
        tailX + 3, boxBottom,
        tailX, tailTipY,
      );
    }

    this.commandBubbleText.setPosition(boxX, bubbleY).setVisible(true);
  }

  drawAttackBubble() {
    this.graphicsAttackBubble.clear();
    // Keep one readable speech bubble at a time; command announcements take
    // precedence over the short attack cue.
    if (this.attackBubbleTimer <= 0 || this.isDead || this.commandBubbleTimer > 0) {
      this.attackBubbleText.setVisible(false);
      return;
    }

    const bubbleX = Math.round(this.position.x);
    const bubbleY = Math.round(
      this.position.y - 25 * this.growthScale -
        Math.sin(this.attackBubbleTimer * 14) * 2,
    );
    const width = this.attackBubbleText.width + 8;
    this.graphicsAttackBubble.fillStyle(0x3c3548, 0.92);
    this.graphicsAttackBubble.lineStyle(1, 0xaaa0b4, 1);
    this.graphicsAttackBubble.fillRoundedRect(
      bubbleX - width / 2,
      bubbleY - 7,
      width,
      14,
      4,
    );
    this.graphicsAttackBubble.strokeRoundedRect(
      bubbleX - width / 2,
      bubbleY - 7,
      width,
      14,
      4,
    );
    this.graphicsAttackBubble.fillTriangle(
      bubbleX - 3,
      bubbleY + 7,
      bubbleX + 3,
      bubbleY + 7,
      bubbleX,
      bubbleY + 11,
    );
    this.attackBubbleText
      .setPosition(bubbleX, bubbleY)
      .setVisible(true);
  }

  drawLegLayer(g, layer, legColor, jointColor) {
    for (let i = 0; i < this.legs.length; i += 1) {
      const leg = this.legs[i];
      if (leg.layer !== layer) continue;

      const hip = new Phaser.Math.Vector2(
        Math.round(leg.hipX * this.facing + this.idleBodyOffset.x),
        Math.round(leg.hipY + this.bodyBob + this.idleBodyOffset.y),
      );
      const foot = this.worldToRenderLocal(leg.foot.x, leg.foot.y);
      if (i === this.idleLegIndex && this.idleLegLift > 0) {
        foot.y -= this.idleLegLift;
        foot.x += this.facing * this.idleLegLift * 0.35;
      }

      // Arch knee upward away from ground based on actual relative foot-to-hip position
      const bendSign = foot.x >= hip.x ? -1 : 1;
      const knee = this.solveKnee(
        hip,
        foot,
        leg.upper,
        leg.lower,
        bendSign,
      );

      const kx = Math.round(knee.x);
      const ky = Math.round(knee.y);
      const fx = Math.round(foot.x);
      const fy = Math.round(foot.y);

      g.lineStyle(layer === 'far' ? 1 : 2, legColor, 1);
      g.lineBetween(hip.x, hip.y, kx, ky);
      g.lineBetween(kx, ky, fx, fy);

      // Keep joints subordinate to the leg silhouette; the previous 2 x 2
      // blocks made all eight knees merge into a noisy cluster.
      g.fillStyle(jointColor, 1);
      g.fillRect(kx, ky, 1, 1);

      // A short outward-facing toe makes contact points feel planted without
      // turning each endpoint into another square joint.
      const toeDirection = Math.sign(leg.restX) * this.facing;
      g.lineStyle(1, jointColor, 1);
      g.lineBetween(fx, fy, fx + toeDirection * 2, fy);
    }
  }

  drawBody(g) {
    const x = this.idleBodyOffset.x;
    const y = this.bodyBob + this.idleBodyOffset.y;

    // True left/right side profile:
    //   abdomen (rear) -> cephalothorax/head (front) -> tiny forward eyes.
    const rearX = Math.round(x - 3 * this.facing);
    const headLocal = this.worldToRenderLocal(
      this.headPosition.x,
      this.headPosition.y,
    );
    // Whole-pixel snapping keeps the spring animation crisp at this very low
    // rendering resolution instead of shimmering between pixel columns.
    const frontX = Math.round(headLocal.x);
    const frontY = Math.round(headLocal.y);
    const bodyY = Math.round(y);
    const attack = POUNCE_ATTACKS[this.pounceAttackIndex] || POUNCE_ATTACKS[0];
    const attackStretch = this.isPouncing
      ? Phaser.Math.Clamp(this.pounceTime * 10, 0, 1) * attack.bodyStretch
      : 0;
    const fallStretch = !this.grounded && !this.isPouncing
      ? Phaser.Math.Clamp(this.velocity.y / MAX_FALL_SPEED, 0, 1)
      : 0;
    const abdomenWidth =
      (15 + this.idleAbdomenPulse + attackStretch - fallStretch * 0.8) *
      this.landingPose.widthScale;
    const abdomenHeight =
      (11 - this.idleAbdomenPulse * 0.3 - attackStretch * 0.6 + fallStretch * 0.7) *
      this.landingPose.heightScale;

    // Round lavender forms and warm highlights make the tiny resident feel
    // softer than the earlier long, armored forest silhouette.
    g.fillStyle(0x746b84, 1);
    g.lineStyle(1, 0x4b4557, 1);
    g.fillEllipse(rearX, bodyY, abdomenWidth, abdomenHeight);
    g.strokeEllipse(rearX, bodyY, abdomenWidth, abdomenHeight);
    g.fillStyle(0xaaa0b4, 1);
    g.fillRect(rearX - 3, bodyY - 4, 5, 1);
    g.fillStyle(0x554e63, 1);
    g.fillRect(rearX - 2, bodyY + 4, 4, 1);

    // A short flexible neck keeps the two spring-driven shapes visually
    // connected even at maximum extension.
    g.lineStyle(2, 0x5b5369, 1);
    g.lineBetween(Math.round(x + this.facing), bodyY, frontX, frontY);

    g.fillStyle(0x665d76, 1);
    g.lineStyle(1, 0x494253, 1);
    g.fillEllipse(frontX, frontY, 10, 9);
    g.strokeEllipse(frontX, frontY, 10, 9);
    g.fillStyle(0xb2a7bb, 1);
    g.fillRect(frontX - 2, frontY - 3, 4, 1);

    // One bright eye and one dimmer eye are enough to communicate which side
    // of the animal is facing the camera without turning it into a front view.
    const eyeX = frontX + 3 * this.facing;
    const isBlinking = this.scene.time.now % 3600 > 3450;
    g.fillStyle(0x252331, 1);
    g.fillRect(eyeX, isBlinking ? frontY : frontY - 2, 2, isBlinking ? 1 : 3);
    if (!isBlinking) {
      g.fillStyle(0xf7f5e8, 1);
      g.fillRect(eyeX + (this.facing < 0 ? 1 : 0), frontY - 2, 1, 1);
    }
    g.fillStyle(0x3b3547, 1);
    g.fillRect(eyeX - this.facing * 2, frontY + 1, 1, 1);
    g.fillStyle(0xd9989e, 1);
    g.fillRect(frontX + 2 * this.facing, frontY + 2, 1, 1);

    // Two fine chelicerae make the facing direction clear without adding a
    // large bright block at the end of the head.
    g.lineStyle(1, 0x5e576e, 1);
    g.lineBetween(
      frontX + 4 * this.facing,
      frontY + 1,
      frontX + 6 * this.facing,
      frontY + 2,
    );
    g.lineBetween(
      frontX + 4 * this.facing,
      frontY + 3,
      frontX + 6 * this.facing,
      frontY + 3,
    );
  }
}
const noop = () => {};
