const STRIDE_DISTANCE = 6;
const MIN_MOVEMENT = 0.04;

// A tiny procedural sound keeps the project asset-free and lets the rhythm
// follow the spider's actual movement speed rather than an animation timer.
export class SpiderMovementSound {
  constructor(soundManager, spider) {
    this.context = soundManager?.context ?? null;
    this.destination = soundManager?.destination ?? this.context?.destination ?? null;
    this.spider = spider;
    this.previousX = spider.position.x;
    this.previousY = spider.position.y;
    this.distanceSinceStep = 0;
    this.wasMoving = false;
    this.wasPouncing = Boolean(spider.isPouncing);
    this.stepIndex = 0;
  }

  update(dt) {
    const dx = this.spider.position.x - this.previousX;
    const dy = this.spider.position.y - this.previousY;
    this.previousX = this.spider.position.x;
    this.previousY = this.spider.position.y;

    const distance = Math.hypot(dx, dy);
    if (this.spider.isPouncing && !this.wasPouncing) this.playAttack();
    this.wasPouncing = Boolean(this.spider.isPouncing);
    const supported = this.spider.grounded
      || Boolean(this.spider.cornerTransition)
      || ['wall', 'ceiling', 'silk'].includes(this.spider.surfaceType);
    const moving = !this.spider.isDead && supported && distance > MIN_MOVEMENT;

    if (!moving) {
      this.wasMoving = false;
      this.distanceSinceStep = 0;
      return;
    }

    this.distanceSinceStep += distance;
    if (!this.wasMoving || this.distanceSinceStep >= STRIDE_DISTANCE) {
      const speed = distance / Math.max(dt, 1 / 240);
      this.playScuttle(speed);
      this.distanceSinceStep %= STRIDE_DISTANCE;
    }
    this.wasMoving = true;
  }

  playScuttle(speed) {
    const context = this.context;
    if (!context || context.state !== 'running') return;

    const now = context.currentTime;
    const speedAmount = Math.max(0, Math.min(1, speed / 70));
    const alternatingPitch = this.stepIndex % 2 === 0 ? 1 : 0.86;
    this.stepIndex += 1;

    // Two close, quiet taps suggest several small feet without turning the
    // movement into a loud conventional footstep.
    this.playTap(now, (620 + speedAmount * 260) * alternatingPitch, 0.018);
    this.playTap(now + 0.022, (480 + speedAmount * 210) * alternatingPitch, 0.012);
  }

  playAttack() {
    const context = this.context;
    if (!context || context.state !== 'running' || !this.destination) return;
    const startAt = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(240, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(72, startAt + 0.13);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.035, startAt + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.15);
    oscillator.connect(gain);
    gain.connect(this.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.16);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      gain.disconnect();
    }, { once: true });
  }

  playHappy() {
    const context = this.context;
    if (!context || context.state !== 'running' || !this.destination) return;

    const now = context.currentTime;
    const notes = [520, 680, 880];
    notes.forEach((frequency, index) => {
      const startAt = now + index * 0.09;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(frequency, startAt);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.08, startAt + 0.12);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.035, startAt + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.15);
      oscillator.connect(gain);
      gain.connect(this.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + 0.16);
      oscillator.addEventListener('ended', () => {
        oscillator.disconnect();
        gain.disconnect();
      }, { once: true });
    });
  }

  playTap(startAt, frequency, volume) {
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(frequency, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.48, startAt + 0.026);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.032);
    oscillator.connect(gain);
    gain.connect(this.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.034);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      gain.disconnect();
    }, { once: true });
  }
}
