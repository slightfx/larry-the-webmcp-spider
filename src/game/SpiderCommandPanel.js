import { SpiderGoalRunner } from './SpiderGoalRunner.js';
import { LightningSpiderAgent } from './LightningSpiderAgent.js';
import { OllamaSpiderAgent } from './OllamaSpiderAgent.js';
import { makeDialogDraggable } from './draggableDialog.js';
import { formatPlanArguments } from './spiderPlanFormatting.js';
import { DeepgramVoice } from './DeepgramVoice.js';

export class SpiderCommandPanel {
  constructor(controller, { onGoalUpdate = () => {}, onPlanUpdate = () => {} } = {}) {
    this.controller = controller;
    this.onGoalUpdate = onGoalUpdate;
    this.onPlanUpdate = onPlanUpdate;
    this.form = document.createElement('form');
    this.form.id = 'spider-command-panel';
    this.form.innerHTML = `
      <div class="spider-dialog-header"><span>COMMAND THE SPIDER</span><button type="button" class="spider-dialog-toggle" aria-label="Minimize dialog" title="Minimize dialog">▾</button></div>
      <div class="spider-command-row">
        <input id="spider-command-input" name="command" maxlength="240"
          autocomplete="off" placeholder="walk left, pounce…" aria-describedby="spider-command-status">
        <button type="button" id="spider-command-plan-button" aria-label="Plan spider command">PLAN</button>
        <button type="submit" aria-label="Send spider command">GO</button>
      </div>
      <div class="spider-command-model-picker">
        <label for="spider-command-model-select">MODEL</label>
        <select id="spider-command-model-select" name="model" aria-label="Command model">
          <option value="ollama">Ollama Cloud (Gemma 4 31B Cloud)</option>
          <option value="lightning">Lightning AI</option>
        </select>
        <button type="button" id="spider-voice-button" aria-pressed="false">VOICE</button>
      </div>
      <output id="spider-command-message">MESSAGE: —</output>
      <output id="spider-command-plan">TOOLS: —</output>
      <output id="spider-command-model">MODEL: OLLAMA CLOUD (GEMMA 4 31B CLOUD)</output>
      <output id="spider-command-status" aria-live="polite">STATUS: READY</output>
      <a class="spider-dialog-link" href="https://webmachinelearning.github.io/webmcp/" target="_blank" rel="noreferrer">WEBMCP DOCUMENTATION ↗</a>
    `;
    this.input = this.form.querySelector('input');
    this.button = this.form.querySelector('button[type="submit"]');
    this.planButton = this.form.querySelector('#spider-command-plan-button');
    this.voiceButton = this.form.querySelector('#spider-voice-button');
    this.modelSelect = this.form.querySelector('select[name="model"]');
    this.message = this.form.querySelector('#spider-command-message');
    this.plan = this.form.querySelector('#spider-command-plan');
    this.model = this.form.querySelector('#spider-command-model');
    this.status = this.form.querySelector('#spider-command-status');
    this.dialogToggle = this.form.querySelector('.spider-dialog-toggle');
    this.dialogToggle.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.dialogToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const minimized = this.form.classList.toggle('is-minimized');
      this.dialogToggle.textContent = minimized ? '▴' : '▾';
      this.dialogToggle.setAttribute('aria-label', minimized ? 'Maximize dialog' : 'Minimize dialog');
    });
    this.webMcpConnected = false;
    this.voice = new DeepgramVoice({
      onTranscript: (transcript) => this.submitVoiceCommand(transcript),
      onStatus: (status) => this.renderVoiceStatus(status),
    });
    this.lightningAgent = globalThis.lightningSpiderAgent || new LightningSpiderAgent();
    this.ollamaAgent = globalThis.ollamaSpiderAgent || new OllamaSpiderAgent();
    this.modelSelect.addEventListener('change', () => {
      const labels = {
        lightning: 'MODEL: LIGHTNING AI',
        ollama: 'MODEL: OLLAMA CLOUD (GEMMA 4 31B CLOUD)',
      };
      this.setReadout(this.model, labels[this.modelSelect.value] || 'MODEL: LIGHTNING AI');
      this.updateAvailability();
    });
    this.voiceButton.addEventListener('click', () => this.toggleVoice());
    this.planButton.addEventListener('click', () => this.planCommand());
    this.planRequestId = 0;
    this.pendingPlan = null;
    this.updateVoiceAvailability();
    this.goalRunner = new SpiderGoalRunner(controller, {
      agent: this.getSelectedAgent(),
      onUpdate: (goalState) => this.renderGoalState(goalState),
    });
    this.controller.ready
      .then((registered) => {
        this.renderWebMcpAvailability(registered);
      })
      .catch(() => this.renderWebMcpAvailability(false));
    this.onSubmit = (event) => this.submit(event);
    this.onPlanKeyDown = (event) => this.handlePlanKeyDown(event);
    this.focusInput = () => {
      if (document.contains(this.input)) this.input.focus({ preventScroll: true });
    };
    this.onDocumentFocus = (event) => {
      if (!event.target?.closest?.('input, select, button, textarea')) queueMicrotask(this.focusInput);
    };
    this.onWindowFocus = () => {
      if (document.activeElement === document.body) queueMicrotask(this.focusInput);
    };
    this.form.addEventListener('submit', this.onSubmit);
    this.form.addEventListener('keydown', this.onPlanKeyDown);
    window.addEventListener('keydown', this.onPlanKeyDown, true);
    this.onAccessModeChange = () => this.updateAvailability();
    window.addEventListener('spider-access-mode-change', this.onAccessModeChange);
    this.removeDrag = makeDialogDraggable(this.form, this.form.querySelector('.spider-dialog-header'));
    for (const eventName of ['keydown', 'keyup']) {
      this.form.addEventListener(eventName, (event) => event.stopPropagation());
    }
    document.getElementById('app').append(this.form);
    document.addEventListener('focusin', this.onDocumentFocus);
    window.addEventListener('focus', this.onWindowFocus);
    requestAnimationFrame(this.focusInput);
  }

  renderWebMcpAvailability(registered) {
    this.webMcpConnected = Boolean(registered && this.controller.canConsumeWebMcpTools());
    this.updateAvailability();
  }

  getSelectedAgent() {
    return this.modelSelect.value === 'ollama' ? this.ollamaAgent : this.lightningAgent;
  }

  updateAvailability() {
    const selectedAgent = this.getSelectedAgent();
    const aiAccessAllowed = !document.getElementById('app')?.classList.contains('spider-guest');
    const ready = aiAccessAllowed && this.webMcpConnected && Boolean(selectedAgent?.isReady?.());
    this.input.disabled = !ready || Boolean(this.pendingPlan);
    this.button.disabled = !ready;
    this.planButton.disabled = !ready;
    this.updateVoiceAvailability();
    if (!aiAccessAllowed) {
      this.input.placeholder = 'Password required for AI tools';
      this.setReadout(this.status, 'STATUS: AI TOOLS REQUIRE PASSWORD');
    } else if (!this.webMcpConnected) {
      this.input.placeholder = 'WebMCP browser support required';
      this.setReadout(this.status, 'STATUS: WEBMCP UNAVAILABLE');
    } else if (this.modelSelect.value === 'lightning' && !this.lightningAgent?.isReady?.()) {
      this.input.placeholder = 'Lightning AI adapter unavailable';
      this.setReadout(this.status, 'STATUS: LIGHTNING AI UNAVAILABLE');
    } else if (this.modelSelect.value === 'ollama' && !this.ollamaAgent?.isReady?.()) {
      this.input.placeholder = 'Ollama adapter unavailable';
      this.setReadout(this.status, 'STATUS: OLLAMA UNAVAILABLE');
    } else if (!ready) {
      this.input.placeholder = 'Loading AI adapter…';
      this.setReadout(this.status, 'STATUS: LOADING AI ADAPTER…');
    } else {
      this.input.placeholder = 'walk left, pounce…';
      const label = this.modelSelect.value === 'ollama'
          ? 'OLLAMA CLOUD'
          : this.modelSelect.value === 'lightning'
            ? 'LIGHTNING AI'
            : 'LIGHTNING AI';
      this.setReadout(this.status, `STATUS: ${label} + WEBMCP READY`);
    }
    if (!this.input.disabled && !this.pendingPlan && this.focusInput) {
      queueMicrotask(this.focusInput);
    }
  }

  updateVoiceAvailability() {
    if (!this.voiceButton) return;
    const canCapture = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
    const aiAccessAllowed = !document.getElementById('app')?.classList.contains('spider-guest');
    this.voiceButton.disabled = !canCapture || !aiAccessAllowed;
    this.voiceButton.title = canCapture
      ? aiAccessAllowed
        ? 'Use your microphone to speak a spider command.'
        : 'Password required for AI tools.'
      : 'Microphone capture is unavailable in this browser.';
  }

  async toggleVoice() {
    try {
      const listening = await this.voice.toggle();
      this.input.disabled = listening;
      this.button.disabled = listening;
      this.planButton.disabled = listening;
      this.voiceButton.classList.toggle('is-listening', listening);
      this.voiceButton.setAttribute('aria-pressed', String(listening));
      this.voiceButton.textContent = listening ? 'STOP VOICE' : 'VOICE';
    } catch (error) {
      this.renderVoiceStatus({ state: 'error', message: error.message });
    }
  }

  renderVoiceStatus(status) {
    if (status.state === 'listening') {
      this.setReadout(this.status, `STATUS: VOICE ${status.message}`);
    } else if (status.state === 'error') {
      this.setReadout(this.status, `STATUS: VOICE ERROR · ${status.message}`);
    } else if (status.state === 'transcribing') {
      this.setReadout(this.status, `STATUS: VOICE ${status.message}`);
    } else if (status.state === 'idle') {
      this.voiceButton?.classList.remove('is-listening');
      if (this.voiceButton) {
        this.voiceButton.setAttribute('aria-pressed', 'false');
        this.voiceButton.textContent = 'VOICE';
      }
      this.updateAvailability();
    }
  }

  submitVoiceCommand(transcript) {
    const command = transcript.trim();
    if (!command) return;
    // Keep the recognized words visible in the command field, then submit
    // them through the same goal path as typed commands.
    this.input.value = command;
    this.pendingPlan = null;
    this.onPlanUpdate(null);
    this.setReadout(this.message, `MESSAGE: ${command}`, command);
    this.setReadout(this.plan, 'TOOLS: PLANNING…');
    this.setReadout(this.status, 'STATUS: THINKING…');
    this.input.disabled = false;
    this.goalRunner.agent = this.getSelectedAgent();
    this.goalRunner.start(command);
  }

  submit(event) {
    event.preventDefault();
    const command = this.input.value.trim();
    if (!command) {
      if (this.pendingPlan) this.executePendingPlan();
      return;
    }
    this.pendingPlan = null;
    this.onPlanUpdate(null);
    this.focusInput();
    this.setReadout(this.message, `MESSAGE: ${command}`, command);
    this.setReadout(this.plan, 'TOOLS: PLANNING…');
    this.setReadout(this.status, 'STATUS: THINKING…');
    this.input.value = '';
    const selectedAgent = this.getSelectedAgent();
    if (!selectedAgent) return;
    this.goalRunner.agent = selectedAgent;
    this.goalRunner.start(command);
  }

  async planCommand() {
    const command = this.input.value.trim();
    if (!command) return;
    const selectedAgent = this.getSelectedAgent();
    if (!selectedAgent?.plan) return;
    const requestId = ++this.planRequestId;
    this.pendingPlan = null;
    this.focusInput();
    this.setReadout(this.message, `MESSAGE: ${command}`, command);
    this.setReadout(this.plan, 'TOOLS: PLANNING…');
    this.setReadout(this.status, 'STATUS: INSPECTING GAME WORLD…');
    this.onPlanUpdate(null);
    this.input.value = '';
    this.input.disabled = true;
    this.button.disabled = true;
    this.planButton.disabled = true;
    let finalStatus = '';
    try {
      const [toolCatalog, gameWorld] = await Promise.all([
        this.controller.getWebMcpToolCatalog(),
        this.controller.inspectGameWorld(),
      ]);
      if (requestId !== this.planRequestId) return;
      this.setReadout(this.status, 'STATUS: PLANNING TOOL ORDER…');
      const modelPlan = await selectedAgent.plan(command, toolCatalog, gameWorld);
      if (requestId !== this.planRequestId) return;
      const planned = this.controller.expandPlanPreview(command, modelPlan);
      const toolNames = planned.tools;
      const formatted = toolNames
        .map((name) => String(name).replaceAll('_', ' ').toUpperCase())
        .join(' → ');
      this.setReadout(this.plan, `TOOLS: ${formatted}`, JSON.stringify(toolNames));
      this.onPlanUpdate(planned.route);
      this.pendingPlan = { command, agent: selectedAgent, plan: planned };
      finalStatus = 'STATUS: PLAN READY · ENTER RUN · ESC CANCEL';
    } catch (error) {
      if (requestId !== this.planRequestId) return;
      this.setReadout(this.plan, 'TOOLS: —');
      finalStatus = `STATUS: PLAN ERROR · ${error.message}`;
    } finally {
      if (requestId === this.planRequestId) {
        this.updateAvailability();
        if (finalStatus) this.setReadout(this.status, finalStatus);
      }
    }
  }

  handlePlanKeyDown(event) {
    // Shift+Enter plans the current command without submitting it directly.
    if (event.key === 'Enter' && event.shiftKey && !this.pendingPlan) {
      if (!this.input.value.trim()) return;
      event.preventDefault();
      this.planCommand();
      return;
    }
    if (!this.pendingPlan) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelPendingPlan();
      return;
    }
    if (event.key === 'Enter' && !this.input.value.trim()) {
      event.preventDefault();
      this.executePendingPlan();
    }
  }

  executePendingPlan() {
    const pending = this.pendingPlan;
    if (!pending) return;
    this.pendingPlan = null;
    this.updateAvailability();
    this.onPlanUpdate(null);
    this.setReadout(this.message, `MESSAGE: ${pending.command}`, pending.command);
    this.setReadout(this.status, 'STATUS: EXECUTING PLANNED COMMAND…');
    if (Array.isArray(pending.plan?.actions) && pending.plan.actions.length) {
      try {
        this.controller.executeActionPlan({
          actions: pending.plan.actions,
          summary: pending.plan.summary || pending.command,
          spider_says: pending.plan.spider_says,
        }, {
          onComplete: ({ status, error }) => {
            if (status === 'complete') {
              this.setReadout(this.status, 'STATUS: PLAN COMPLETE');
            } else if (status === 'failed') {
              this.setReadout(this.status, `STATUS: PLAN ERROR · ${error?.message || error}`);
            }
          },
        });
      } catch (error) {
        this.setReadout(this.status, `STATUS: PLAN ERROR · ${error.message}`);
      }
    } else {
      this.goalRunner.agent = pending.agent;
      this.goalRunner.start(pending.command);
    }
  }

  cancelPendingPlan() {
    if (!this.pendingPlan) return;
    this.pendingPlan = null;
    this.updateAvailability();
    this.onPlanUpdate(null);
    this.setReadout(this.plan, 'TOOLS: —');
    this.setReadout(this.status, 'STATUS: PLAN CANCELLED');
    this.focusInput();
  }

  renderGoalState(goalState) {
    this.onGoalUpdate(goalState);
    const tools = this.formatToolPlan(goalState.tools);
    this.setReadout(this.plan, `TOOLS: ${tools || 'PLANNING…'}`, tools || 'Planning');
    const prefix = goalState.execution_state.toUpperCase();
    const counters = goalState.execution_state === 'complete'
      ? ''
      : ` · ${String(goalState.provider || 'MODEL').toUpperCase()} CALLS ${goalState.decision_index}`;
    const status = `${prefix}${counters}: ${goalState.summary || ''}`;
    this.setReadout(this.status, `STATUS: ${status.toUpperCase()}`, status);
  }

  formatToolPlan(actions = []) {
    return actions.map(({ tool, arguments: args = {} }) => {
      const argumentsText = formatPlanArguments(args);
      const name = String(tool).replaceAll('_', ' ').toUpperCase();
      return argumentsText ? `${name} (${argumentsText})` : name;
    }).join(' → ');
  }

  setReadout(element, text, title = text) {
    element.value = text;
    element.title = title;
  }

  destroy() {
    this.planRequestId += 1;
    this.pendingPlan = null;
    this.onPlanUpdate(null);
    this.goalRunner.destroy();
    this.form.removeEventListener('submit', this.onSubmit);
    this.form.removeEventListener('keydown', this.onPlanKeyDown);
    window.removeEventListener('keydown', this.onPlanKeyDown, true);
    window.removeEventListener('spider-access-mode-change', this.onAccessModeChange);
    this.removeDrag();
    this.voice.destroy();
    document.removeEventListener('focusin', this.onDocumentFocus);
    window.removeEventListener('focus', this.onWindowFocus);
    this.form.remove();
  }
}
