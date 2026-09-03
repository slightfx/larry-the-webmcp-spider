import { makeDialogDraggable } from './draggableDialog.js';

export class SpiderHelpPanel {
  constructor() {
    document.getElementById('spider-help-panel')?.remove();
    this.panel = document.createElement('section');
    this.panel.id = 'spider-help-panel';
    this.panel.setAttribute('aria-label', 'How to control Larry');
    this.panel.innerHTML = `
      <div class="spider-dialog-grip spider-dialog-header">
        <span>HOW TO CONTROL LARRY</span>
        <button type="button" class="spider-dialog-toggle" aria-label="Maximize dialog" title="Maximize dialog">▴</button>
      </div>
      <p>Give Larry a plain-English command, or use the WebMCP tools directly.</p>
      <h2>COMMAND BOX</h2>
      <p>Type a request, then press <strong>GO</strong>. Use <strong>PLAN</strong> to preview a multi-step route before it runs.</p>
      <div class="spider-help-examples">
        <div>walk left</div>
        <div>climb the right tree</div>
        <div>hunt the nearest fly</div>
        <div>get back to the ground</div>
      </div>
      <h2>DIRECT TOOLS</h2>
      <p>Use the Manual Tool Console to call an action yourself.</p>
      <div class="spider-help-tools">
        <div><strong>MOVE</strong> left, right, up, down</div>
        <div><strong>JUMP</strong> leap forward</div>
        <div><strong>CLIMB</strong> choose a tree and platform</div>
        <div><strong>HUNT</strong> choose prey or nearest</div>
        <div><strong>GROUND</strong> descend from platforms</div>
      </div>
      <h2>MORE EXAMPLES</h2>
      <div class="spider-help-examples">
        <div>move right for 2 seconds</div>
        <div>go to the left edge, then jump</div>
        <div>climb the center tree to the top</div>
        <div>stop</div>
      </div>
    `;
    this.panel.classList.add('is-minimized');
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
  }

  destroy() {
    this.removeDrag?.();
    this.panel.remove();
  }
}
