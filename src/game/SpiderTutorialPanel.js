import { makeDialogDraggable } from './draggableDialog.js';
import { getTutorialLevel, TUTORIAL_LEVELS } from './spiderTutorial.js';

export class SpiderTutorialPanel {
  constructor(scene, levelIndex = 0) {
    this.scene = scene;
    this.levelIndex = levelIndex;
    this.level = getTutorialLevel(levelIndex);
    this.clearedSpikes = false;
    this.visitedHeight = false;
    this.panel = document.createElement('section');
    this.panel.id = 'spider-tutorial-panel';
    this.panel.setAttribute('aria-label', 'Larry tutorial');
    this.panel.innerHTML = `
      <div class="spider-dialog-grip spider-dialog-header">
        <span>TUTORIAL ${levelIndex + 1}/${TUTORIAL_LEVELS.length}</span>
        <button type="button" class="spider-dialog-toggle" aria-label="Minimize dialog" title="Minimize dialog">▾</button>
      </div>
      <strong class="spider-tutorial-title"></strong>
      <span class="spider-tutorial-objective"></span>
      <span class="spider-tutorial-hint"></span>
      <output class="spider-tutorial-status" aria-live="polite">IN PROGRESS</output>
    `;
    this.title = this.panel.querySelector('.spider-tutorial-title');
    this.objective = this.panel.querySelector('.spider-tutorial-objective');
    this.hint = this.panel.querySelector('.spider-tutorial-hint');
    this.status = this.panel.querySelector('.spider-tutorial-status');
    this.title.textContent = this.level.title;
    this.objective.textContent = this.level.objective;
    this.hint.textContent = this.level.hint;
    this.instruction = this.level.instruction;
    this.dialogToggle = this.panel.querySelector('.spider-dialog-toggle');
    this.dialogToggle.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.dialogToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const minimized = this.panel.classList.toggle('is-minimized');
      this.dialogToggle.textContent = minimized ? '▴' : '▾';
      this.dialogToggle.setAttribute('aria-label', minimized ? 'Maximize dialog' : 'Minimize dialog');
      this.dialogToggle.title = minimized ? 'Maximize dialog' : 'Minimize dialog';
    });
    document.getElementById('app')?.append(this.panel);
    this.removeDrag = makeDialogDraggable(this.panel, this.panel.querySelector('.spider-dialog-grip'));
    this.completed = false;
  }

  announce() {
    this.scene.spider.sayCommand?.(this.instruction);
  }

  complain() {
    const complaints = [
      'OW! THAT HURT!',
      'HEY! WATCH THE LANDING!',
      'OUCH! I NEED A SAFER ROUTE!',
    ];
    const complaint = complaints[Math.floor(this.scene.time.now / 1000) % complaints.length];
    this.scene.spider.sayCommand?.(complaint);
    this.status.textContent = 'LARRY GOT HURT — TRY A DIFFERENT ROUTE.';
  }

  update(state) {
    if (this.completed) return;
    if (!this.level.isComplete({ scene: this.scene, state, tutorial: this })) return;
    this.completed = true;
    const finalLevel = this.levelIndex >= TUTORIAL_LEVELS.length - 1;
    this.status.textContent = finalLevel ? 'TUTORIAL COMPLETE — LARRY IS READY!' : 'LEVEL CLEAR — NEXT LEVEL LOADING…';
    this.panel.classList.add('is-complete');
    if (finalLevel) {
      this.scene.time.delayedCall(1400, () => this.scene.enterBigTerrarium());
      return;
    }
    this.scene.time.delayedCall(1100, () => {
      this.scene.scene.restart({ tutorialLevel: this.levelIndex + 1 });
    });
  }

  destroy() {
    this.removeDrag?.();
    this.panel.remove();
  }
}
