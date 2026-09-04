import { validateToolCall } from './SpiderToolCallUtils.js';

const MAX_DECISIONS = 10;
const MAX_RECOVERIES = 4;
const ACTION_TIMEOUT_MS = 20_000;
const SETTLE_MS = 180;
const MAX_HUNT_MISSES = 10;

function stateFingerprint(state) {
  return JSON.stringify({
    physical_state: state.physical_state,
    position: state.position,
    surface: state.surface,
    grounded: state.grounded,
    pouncing: state.pouncing,
    prey_hunted: state.prey_hunted,
    health: state.health,
  });
}

function compactState(state) {
  return {
    physical_state: state.physical_state,
    position: state.position,
    facing: state.facing,
    surface: state.surface,
    grounded: state.grounded,
    pouncing: state.pouncing,
    health: state.health,
    prey_hunted: state.prey_hunted,
    active_goal: state.active_goal,
    autonomous_activity: state.autonomous_activity,
  };
}

function isBoundedMovePlan(actions) {
  return actions.length > 0 && actions.every((action) => (
    action.tool === 'move_spider'
    && (!action.arguments?.target || action.arguments.target === 'direction')
  ));
}

function actionCompletesGoal(action, goal) {
  const text = String(goal || '').toLowerCase();
  const clauses = text.split(/\b(?:then|after that|and then)\b/).map((part) => part.trim()).filter(Boolean);
  if (clauses.length < 2) return true;
  const finalClause = clauses[clauses.length - 1];
  const tool = action?.tool || '';
  if (/\bclimb|platform|tree\b/.test(finalClause)) return tool === 'climb_tree';
  if (/\bhunt|catch|eat|prey|isopod|fly|springtail\b/.test(finalClause)) return tool === 'hunt_prey';
  if (/\bjump|pounce\b/.test(finalClause)) return tool === 'jump_spider';
  if (/\bground|descend|down\b/.test(finalClause)) return tool === 'get_to_ground';
  if (/\bstop|cancel|halt\b/.test(finalClause)) return tool === 'stop_spider';
  return true;
}

export class SpiderGoalRunner {
  constructor(controller, {
    agent = null,
    onUpdate = () => {},
  } = {}) {
    this.controller = controller;
    this.agent = agent;
    this.onUpdate = onUpdate;
    this.runId = 0;
    this.abortController = null;
    this.current = null;
  }

  emit(executionState, detail = {}) {
    if (!this.current) return;
    this.current.execution_state = executionState;
    Object.assign(this.current, detail);
    this.controller.setAgentStatus(executionState, this.current.goal);
    this.onUpdate({ ...this.current });
  }

  cancel(reason = 'cancelled') {
    this.runId += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.controller.stopAllActions();
    if (this.current && !['complete', 'failed', 'cancelled'].includes(this.current.execution_state)) {
      this.emit('cancelled', { summary: reason });
    }
    this.controller.setAgentStatus('idle', null);
  }

  start(goal) {
    this.cancel('replaced by a new goal');
    const runId = this.runId;
    this.current = {
      goal,
      execution_state: 'thinking',
      decision_index: 0,
      recoveries: 0,
      history: [],
      tools: [],
      summary: `${this.agent?.providerName || 'Selected model'} is planning…`,
      spider_says: '',
      hunt_misses: 0,
      hunt_in_progress: false,
      decision_source: this.agent?.providerName || 'selected-model',
      provider: this.agent?.providerName || 'selected-model',
    };
    this.emit('thinking');
    this.run(runId).catch((error) => {
      if (runId !== this.runId || error.name === 'AbortError') return;
      this.emit('failed', { summary: error.message });
    });
  }

  async run(runId) {
    while (runId === this.runId && this.current.decision_index < MAX_DECISIONS) {
      const before = this.controller.getState();
      this.emit('thinking', { summary: `${this.agent?.providerName || 'Selected model'} is selecting a WebMCP tool…` });
      const result = await this.requestDecision(runId, before);
      if (runId !== this.runId) return;
      this.current.decision_index += 1;

      const actions = result.decision.actions;
      const huntAttempted = actions.some((action) => action.tool === 'hunt_prey');
      if (huntAttempted) this.current.hunt_in_progress = true;
      this.current.tools.push(...actions);
      this.current.execution_transport = 'webmcp';
      this.emit('executing', {
        summary: result.decision.summary || 'Executing selected tool through WebMCP…',
      });

      let error = null;
      try {
        for (const action of actions) {
          if (runId !== this.runId) throw new DOMException('Cancelled', 'AbortError');
          this.abortController = new AbortController();
          this.emit('executing', { summary: `WebMCP: ${action.tool}…` });
          await this.controller.executeWebMcpAction(action, {
            signal: this.abortController.signal,
          });
          this.emit('waiting', { summary: `Waiting for ${action.tool} to settle…` });
          await this.waitForSettled(runId);
        }
      } catch (caught) {
        error = caught;
      }
      if (runId !== this.runId) return;

      const after = this.controller.getState();
      const huntFailed = this.current.hunt_in_progress
        && (Boolean(error) || (after.prey_hunted || 0) <= (before.prey_hunted || 0));
      if (huntFailed && !error) {
        error = new Error('The hunt missed. Retarget the prey and calculate a new route.');
      }
      const noProgress = !error
        && actions.some((action) => action.tool !== 'stop_spider')
        && stateFingerprint(before) === stateFingerprint(after);
      const deterministicBlockedMove = noProgress && isBoundedMovePlan(actions);
      if (noProgress) {
        const direction = actions[0]?.arguments?.direction;
        error = new Error(deterministicBlockedMove
          ? `The spider could not move ${direction || 'that way'}; its path is blocked from this surface.`
          : 'The last actions made no observable progress.');
      }

      this.current.history.push({
        actions,
        outcome: error ? 'failed' : 'completed',
        error: error?.message || null,
        retarget_required: huntFailed && this.current.hunt_misses + 1 < MAX_HUNT_MISSES,
        state: compactState(after),
      });
      if (!error) {
        const finalAction = actions[actions.length - 1];
        if (!actionCompletesGoal(finalAction, this.current.goal)) {
          this.emit('thinking', { summary: 'First step complete. Choosing the next WebMCP tool…' });
          continue;
        }
        this.controller.clearActiveTool?.();
        this.emit('complete', { summary: result.decision.summary || 'Goal completed.' });
        return;
      }

      // Repeating a non-progressing action cannot recover (for example,
      // repeatedly jumping while not on a surface). Stop the plan immediately
      // and let the user/model issue a corrected command.
      if (noProgress && !huntFailed) {
        this.emit('failed', { summary: error.message });
        return;
      }

      this.current.recoveries += 1;
      this.controller.stopAllActions();
      if (deterministicBlockedMove) {
        this.emit('failed', { summary: error.message });
        return;
      }
      if (huntFailed) {
        this.current.hunt_misses += 1;
        if (this.current.hunt_misses >= MAX_HUNT_MISSES) {
          this.controller.announceCommand('OH NO… SAD SPIDER.');
          this.emit('failed', {
            summary: 'The spider missed again and feels sad.',
            spider_says: 'OH NO… SAD SPIDER.',
          });
          return;
        }
        this.emit('thinking', { summary: 'Hunt missed. Choosing a fresh route…' });
        continue;
      }
      if (this.current.recoveries > MAX_RECOVERIES) {
        this.emit('failed', { summary: error.message });
        return;
      }
      this.emit('thinking', { summary: `Replanning after: ${error.message}` });
    }
    if (runId === this.runId) {
      this.emit('failed', { summary: 'Goal stopped after 3 planning attempts.' });
    }
  }

  async requestDecision(runId, state) {
    if (!this.agent?.isReady()) throw new Error('Selected command model is not ready.');
    const toolCatalog = await this.controller.getWebMcpToolCatalog();
    if (runId !== this.runId) throw new DOMException('Cancelled', 'AbortError');
    const action = await this.agent.decide(
      this.current.goal,
      toolCatalog,
      state,
      this.current.history.slice(-8),
    );
    if (runId !== this.runId) throw new DOMException('Cancelled', 'AbortError');
    const validated = validateToolCall(action, toolCatalog, state);
    return {
      decision: {
        status: 'act',
        actions: [validated],
        summary: action.reasoning || `Selected ${validated.tool}.`,
        source: this.agent?.providerName || 'selected-model',
        provider: this.agent?.providerName || 'selected-model',
        confidence: action.confidence,
      },
    };
  }

  waitForSettled(runId) {
    const startedAt = performance.now();
    let stableSince = null;
    return new Promise((resolve, reject) => {
      const poll = (now) => {
        if (runId !== this.runId) return reject(new DOMException('Cancelled', 'AbortError'));
        if (this.controller.lastQueueError) return reject(this.controller.lastQueueError);
        if (now - startedAt > ACTION_TIMEOUT_MS) return reject(new Error('Action timed out.'));
        const state = this.controller.getState();
        const busy = this.controller.actionQueue.length > 0
          || this.controller.getRemainingMoveTime() > 0
          || Boolean(this.controller.activeGoal)
          || ['transition', 'airborne'].includes(state.physical_state)
          || state.pouncing;
        if (busy) stableSince = null;
        else if (stableSince === null) stableSince = now;
        else if (now - stableSince >= SETTLE_MS) return resolve();
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
  }

  destroy() {
    this.cancel('scene closed');
    this.current = null;
  }
}
