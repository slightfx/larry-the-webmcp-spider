import { findReachablePreyRoute, planRouteToPlatform } from './spiderNavigation.js';

const noop = () => {};

const CARDINAL_VECTORS = {
  left: { moveX: -1, moveY: 0 },
  right: { moveX: 1, moveY: 0 },
  up: { moveX: 0, moveY: -1 },
  down: { moveX: 0, moveY: 1 },
};

const STATE_CONFIG = {
  ground: { label: 'ON GROUND', directions: ['left', 'right'], canPounce: true },
  ground_near_web: {
    label: 'GROUND · WEB REACH',
    directions: ['left', 'right', 'up'],
    canPounce: true,
  },
  ground_near_tree: {
    label: 'GROUND · TREE REACH',
    directions: ['left', 'right', 'up', 'down'],
    canPounce: true,
  },
  platform_side: { label: 'PLATFORM SIDE', directions: ['up', 'down'], canPounce: false },
  under_platform: { label: 'UNDER PLATFORM', directions: ['left', 'right'], canPounce: false },
  tree: {
    label: 'ON CORK TREE',
    directions: ['left', 'right', 'up', 'down'],
    canPounce: false,
  },
  web: { label: 'ON SPIDERWEB', directions: ['left', 'right'], canPounce: false },
  airborne: { label: 'AIRBORNE', directions: ['left', 'right'], canPounce: false },
  transition: { label: 'CHANGING SURFACE', directions: [], canPounce: false },
  dead: { label: 'KNOCKED OUT', directions: [], canPounce: false },
};

const ARROWS = { left: '←', right: '→', up: '↑', down: '↓' };
const TREE_SELECTORS = ['left', 'center', 'right'];
const round = (value) => Math.round(value * 10) / 10;
const STATE_LOOP_THRESHOLD = 5;
const AGENT_TOOL_NAMES = new Set([
  'stop_spider',
  'move_spider',
  'jump_spider',
  'climb_tree',
  'hunt_prey',
  'get_to_ground',
]);
const INSPECT_TOOL_NAME = 'inspect_game_world';
// Internal navigation primitives used by autonomous plans, not exposed as tools.
const PRIVATE_ACTIONS = new Set([
  'drop_spider',
  'approach_prey',
  'crawl_to_surface',
  'circle_platform',
  'attach_spider',
  'move_to_edge',
  'move_to_tree',
]);
const PERSISTENT_HUNT_TYPES = new Set(['isopod', 'springtail']);

export function getWebMcpModelContext() {
  return globalThis.document?.modelContext ?? null;
}

export function getSpiderControlState(spider) {
  if (spider.isDead) return 'dead';
  if (spider.cornerTransition || spider.surfaceType === 'corner') return 'transition';
  if (spider.surfaceType === 'wall' && spider.surfacePlatform?.climbable) return 'tree';
  if (spider.surfaceType === 'wall') return 'platform_side';
  if (spider.surfaceType === 'ceiling') return 'under_platform';
  if (spider.surfaceType === 'silk') return 'web';
  if (spider.grounded && spider.surfaceType === 'floor') {
    if (spider.getNearbyClimbable?.(16)) return 'ground_near_tree';
    if (spider.silkTraversal?.hasNearbyWeb()) return 'ground_near_web';
    return 'ground';
  }
  return 'airborne';
}

export class SpiderWebMcpController {
  constructor(scene, modelContext = getWebMcpModelContext()) {
    this.scene = scene;
    this.modelContext = modelContext;
    this.baseRegistrationController = new AbortController();
    this.moveCommand = { direction: null, vector: { moveX: 0, moveY: 0 }, expiresAt: 0 };
    this.attackPending = false;
    this.restartPending = false;
    this.actionQueue = [];
    this.activeGoal = null;
    this.huntInProgress = false;
    this.huntTarget = null;
    this.huntPounceAttempts = 0;
    this.agentExecutionState = 'idle';
    this.activeUserGoal = null;
    this.lastQueueError = null;
    this.activeToolName = null;
    this.activeToolUntil = 0;
    this.actionPlanCompletion = null;
    this.legacyStringExecutionArguments = false;
    this.controlState = getSpiderControlState(scene.spider);
    this.loopTransitionCounts = new Map();
    this.lastLoopTransitionAt = 0;
    this.loopRecoveryActive = false;

    noop('[WebMCP] model context', {
      available: Boolean(this.modelContext?.registerTool),
      surfaceState: this.controlState,
      api: globalThis.document?.modelContext ? 'document.modelContext' : 'unavailable',
    });

    this.ready = this.registerTools(
      [...this.getBaseTools(), ...this.getStateTools()],
      this.baseRegistrationController,
      'all',
    );
  }

  get stateConfig() {
    return STATE_CONFIG[this.reportedControlState];
  }

  get physicalStateConfig() {
    return STATE_CONFIG[this.controlState];
  }

  get reportedControlState() {
    return this.controlState;
  }

  setAgentStatus(executionState, goal = this.activeUserGoal) {
    this.agentExecutionState = executionState;
    this.activeUserGoal = goal;
  }

  async registerTools(tools, controller, group) {
    if (!this.modelContext?.registerTool) return false;
    noop(`[WebMCP] registering ${group} tools`, tools.map((tool) => tool.name));
    try {
      await Promise.all(
        tools.map((tool) => {
          const instrumentedTool = {
            ...tool,
            execute: (args = {}, options = {}) => this.invokeRegisteredTool(tool, args, options),
          };
          return this.modelContext.registerTool(instrumentedTool, { signal: controller.signal });
        }),
      );
      noop(`[WebMCP] registered ${group} tools`, tools.map((tool) => tool.name));
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      controller.abort();
      noop(`[WebMCP] Spider ${group} tools could not be registered.`, error);
      return false;
    }
  }

  async invokeRegisteredTool(tool, args = {}, { signal } = {}) {
    signal?.throwIfAborted?.();
    const stopOnAbort = () => this.stopAllActions();
    signal?.addEventListener('abort', stopOnAbort, { once: true });
    try {
      return await this.invokeTool(tool, args, {
        announce: !tool.annotations?.readOnlyHint,
        source: 'browser',
      });
    } finally {
      signal?.removeEventListener('abort', stopOnAbort);
    }
  }

  canConsumeWebMcpTools() {
    return Boolean(
      this.modelContext?.registerTool
      && this.modelContext?.getTools
      && this.modelContext?.executeTool,
    );
  }

  async getRegisteredWebMcpTools() {
    await this.ready;
    if (!this.canConsumeWebMcpTools()) {
      throw new Error(
        'This browser does not expose the WebMCP getTools() and executeTool() APIs required by the command box.',
      );
    }

    const ownedNames = new Set(this.getAllTools().map((tool) => tool.name));
    const tools = await this.modelContext.getTools();
    const ownTools = tools.filter((tool) => {
      if (!ownedNames.has(tool.name)) return false;
      if (tool.window && globalThis.window && tool.window !== globalThis.window) return false;
      if (tool.origin && globalThis.location?.origin && tool.origin !== globalThis.location.origin) return false;
      return true;
    });
    if (!ownTools.length) throw new Error('The spider WebMCP tools were not discoverable after registration.');
    return ownTools;
  }

  async getWebMcpToolCatalog() {
    const metadata = new Map(this.getToolCatalog().map((tool) => [tool.name, tool]));
    const tools = await this.getRegisteredWebMcpTools();
    return tools.filter((tool) => AGENT_TOOL_NAMES.has(tool.name)).map((tool) => ({
      name: tool.name,
      short_label: metadata.get(tool.name)?.short_label || tool.title || tool.name,
      description: tool.description,
      input_schema: this.normalizeDiscoveredInputSchema(tool.inputSchema, tool.name),
      allowed_states: metadata.get(tool.name)?.allowed_states || [],
    }));
  }

  normalizeDiscoveredInputSchema(inputSchema, toolName) {
    if (!inputSchema) return { type: 'object', properties: {} };
    if (typeof inputSchema !== 'string') return inputSchema;
    this.legacyStringExecutionArguments = true;
    try {
      return JSON.parse(inputSchema);
    } catch {
      throw new Error(`WebMCP returned an invalid input schema for ${toolName}.`);
    }
  }

  async executeWebMcpAction(action, { signal } = {}) {
    const tools = await this.getRegisteredWebMcpTools();
    const tool = tools.find((candidate) => candidate.name === action.tool);
    if (!tool) throw new Error(`WebMCP tool ${action.tool} is not registered.`);
    noop(`[WebMCP] executeTool() → ${action.tool}`, { arguments: action.arguments || {} });
    const args = action.arguments || {};
    const options = signal ? { signal } : {};
    let result;
    try {
      // Current WebMCP API: executeTool(RegisteredTool, object, options).
      result = await this.modelContext.executeTool(
        tool,
        this.legacyStringExecutionArguments ? JSON.stringify(args) : args,
        options,
      );
    } catch (error) {
      // Older experimental Chromium builds exposed a DOMString argument here.
      // Retry only when Blink confirms that its JSON parser rejected the object.
      if (!/failed to parse input argument/i.test(String(error?.message || error))) throw error;
      noop('[WebMCP] Chromium expects legacy stringified tool arguments; retrying once.');
      this.legacyStringExecutionArguments = true;
      result = await this.modelContext.executeTool(tool, JSON.stringify(args), options);
    }
    noop(`[WebMCP] executeTool() result ← ${action.tool}`, result);
    return result;
  }

  async inspectGameWorld({ signal } = {}) {
    return this.executeWebMcpAction({ tool: INSPECT_TOOL_NAME, arguments: {} }, { signal });
  }

  invokeTool(tool, args = {}, { announce = false, source = 'internal' } = {}) {
    noop(`[WebMCP] call → ${tool.name}`, { arguments: args, source });
    try {
      this.validateToolArguments(tool, args);
      if (source === 'browser') {
        this.lastQueueError = null;
        const requested = { tool: tool.name, arguments: args };
        const prerequisites = this.planActionPrerequisites(requested);
        if (prerequisites.length) {
          this.stopAllActions();
          this.actionQueue = [...prerequisites, { ...requested, _prerequisiteAttempts: 1 }];
          noop('[WebMCP] A* prerequisites scheduled', {
            requested: tool.name,
            prerequisites: prerequisites.map((action) => action.tool),
          });
          if (announce) this.announceToolCall(tool.name, args);
          this.processActionQueue(this.scene.time.now);
          return {
            accepted: true,
            scheduled: true,
            requested_tool: tool.name,
            prerequisite_tools: prerequisites.map((action) => action.tool),
          };
        }
      }
      const result = tool.execute(args);
      if (!tool.annotations?.readOnlyHint) this.markToolActive(tool.name);
      noop(`[WebMCP] result ← ${tool.name}`, result);
      if (announce) this.announceToolCall(tool.name, args);
      return result;
    } catch (error) {
      noop(`[WebMCP] error ← ${tool.name}`, error);
      const message = error instanceof Error ? error.message : String(error);
      const quip = this.getInvalidToolQuip(message);
      this.announceCommand(quip);
      return {
        accepted: false,
        error: message,
        spider_says: quip,
      };
    }
  }

  getInvalidToolQuip(message) {
    if (/jump/i.test(message)) return 'NOPE! THESE LEGS NEED SOLID GROUND TO GO BOING!';
    if (/climb/i.test(message)) return 'CAN’T CLIMB AIR, SILLY! FIND A TREE FIRST!';
    if (/ground|surface|platform/i.test(message)) return 'EIGHT LEGS, ZERO GRIP! TRY A BETTER SURFACE!';
    if (/direction|move/i.test(message)) return 'MY LEGS ARE CONFUSED! PICK A DIRECTION THAT EXISTS!';
    return 'WHOOPSIE! THIS SPIDER CAN’T DO THAT JUST YET!';
  }

  getBaseTools() {
    return [
      {
        name: INSPECT_TOOL_NAME,
        title: 'Inspect game world',
        shortLabel: 'INSPECT',
        allowedStates: Object.keys(STATE_CONFIG),
        description:
          'Inspect the current game world, including the spider, surfaces, trees, platforms, and prey.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: () => this.getState(),
      },
      {
        name: 'stop_spider',
        title: 'Stop spider',
        shortLabel: 'STOP',
        allowedStates: [
          'ground',
          'ground_near_tree',
          'ground_near_web',
          'platform_side',
          'under_platform',
          'tree',
          'web',
          'airborne',
        ],
        description: 'Stop the active spider movement command.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false },
        execute: () => {
          if (this.executingPlanAction) {
            this.stopMove();
            this.activeGoal = null;
            this.attackPending = false;
          } else {
            this.stopAllActions();
          }
          return { stopped: true, spider: this.getState() };
        },
      },
    ];
  }

  getStateTools() {
    const tools = [];
    tools.push({
      name: 'move_spider',
      title: 'Move spider',
      shortLabel: 'MOVE',
      allowedStates: [
        'ground',
        'ground_near_tree',
        'ground_near_web',
        'platform_side',
        'under_platform',
        'tree',
        'web',
        'airborne',
      ],
      description:
        'Move the spider in a world direction for a bounded duration. The call validates the ' +
        'direction against the spider’s current physical state.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['direction', 'edge', 'tree'],
            default: 'direction',
            description: 'Choose whether to move freely, reach an edge, or reach a tree.',
          },
          direction: {
            type: 'string',
            enum: ['left', 'right', 'up', 'down'],
            description: 'World direction. On a tree, left or right can step onto a nearby branch.',
          },
          duration_ms: {
            type: 'integer', minimum: 100, maximum: 5000, default: 750,
            description: 'How long to hold the movement input.',
          },
          side: {
            type: 'string',
            enum: ['forward', 'nearest', 'left', 'right'],
            description: 'Move autonomously to this platform edge.',
          },
          tree: {
            type: 'string',
            enum: [...TREE_SELECTORS, 'nearest'],
            description: 'Move autonomously to this tree, or choose the nearest tree.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: ({ target = 'direction', direction, duration_ms = 750, side, tree }) => {
        if (target === 'tree') return this.startMoveToTree(tree);
        if (target === 'edge') return this.startMoveToEdge(side);
        const resolvedDirection = direction ?? this.getMoveDirectionFallback();
        this.setMove(resolvedDirection, duration_ms);
        return {
          accepted: true,
          command: resolvedDirection,
          duration_ms: this.getRemainingMoveTime(),
          spider: this.getState(),
        };
      },
    });
    tools.push({
      name: 'jump_spider',
      title: 'Jump spider',
      shortLabel: 'JUMP',
      allowedStates: ['ground', 'ground_near_tree'],
      description: 'Jump or leap forward into the air in the direction the spider is facing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: () => {
        const x = this.scene.spider.position.x;
        const width = this.scene.scale?.width || 768;
        if (x <= 30 || x >= width - 30) {
          this.scene.recoverFromEdge?.(x <= 30 ? 'right' : 'left');
          return { accepted: false, summary: 'Jump blocked at the edge; turning inward.' };
        }
        if (this.scene.spider.isPouncing || !this.scene.spider.grounded) {
          return { accepted: false, summary: 'Finish the current jump before jumping again.' };
        }
        const current = STATE_CONFIG[getSpiderControlState(this.scene.spider)];
        if (!current.canPounce) {
          const state = getSpiderControlState(this.scene.spider);
          if (state === 'airborne' || state === 'transition') {
            return { accepted: false, summary: 'Already airborne; jump ignored.' };
          }
          return { accepted: false, summary: 'Jump needs solid ground.' };
        }
        this.attackPending = true;
        return { accepted: true, facing: this.scene.spider.facing === 1 ? 'right' : 'left' };
      },
    });
    tools.push({
      name: 'climb_tree',
      title: 'Climb tree',
      shortLabel: 'CLIMB TREE',
      allowedStates: ['ground', 'ground_near_tree', 'tree', 'under_platform', 'platform_side'],
      description:
        'Climb to a selected platform on a selected tree.',
      inputSchema: {
        type: 'object',
        properties: {
          tree: { type: 'string', enum: [...TREE_SELECTORS, 'nearest'], default: 'nearest' },
          platform_number: {
            type: 'string', enum: ['bottom', 'top'], default: 'bottom',
            description: 'Choose the bottom or top platform on the tree.',
          },
        },
        required: ['tree', 'platform_number'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: ({ tree, platform_number, _tree = null, _platform = null }) =>
        this.startClimbToPlatform(
          'up', platform_number === 'top' ? 2 : 1,
          _tree || this.resolveTree(tree), _platform,
        ),
    });
    tools.push({
      name: 'hunt_prey',
      title: 'Hunt prey',
      shortLabel: 'HUNT',
      allowedStates: ['ground', 'ground_near_tree', 'tree', 'under_platform', 'platform_side'],
      description:
        'Select prey and autonomously hunt it using A* pathfinding across platforms and cork trees, ' +
        'then pounce when in range.',
      inputSchema: {
        type: 'object',
        properties: {
          prey_type: {
            type: 'string',
            enum: ['nearest', 'fly', 'springtail', 'isopod'],
            default: 'nearest',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: ({ prey_type = 'nearest' }) => this.startHuntPrey(prey_type),
    });
    tools.push({
      name: 'get_to_ground',
      title: 'Get to ground',
      shortLabel: 'GROUND',
      allowedStates: ['ground', 'ground_near_tree', 'tree', 'under_platform', 'platform_side'],
      description:
        'Get down to the soil by crawling to the underside of each elevated platform and dropping. ' +
        'If another elevated platform catches the spider, repeat until the main ground is reached.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: () => this.startGetToGround(),
    });
    return tools;
  }

  syncState() {
    const nextState = getSpiderControlState(this.scene.spider);
    if (nextState === this.controlState) return false;
    const previousState = this.controlState;
    this.controlState = nextState;
    const now = Number(this.scene.time?.now) || performance.now();
    if (now - this.lastLoopTransitionAt > 4000) this.loopTransitionCounts.clear();
    this.lastLoopTransitionAt = now;
    const isSurfaceTransition = previousState === 'transition' || nextState === 'transition';
    const transition = `${previousState}>${nextState}`;
    const count = isSurfaceTransition
      ? (this.loopTransitionCounts.get(transition) || 0) + 1
      : 0;
    if (isSurfaceTransition) this.loopTransitionCounts.set(transition, count);
    noop('[WebMCP] spider state changed', {
      from: previousState,
      to: nextState,
      availableDirections: [...this.physicalStateConfig.directions],
    });
    // A spider can legitimately cross several corners during one route. Give
    // those transitions time to settle before treating repeated edges as a
    // navigation loop and triggering the expensive respawn animation.
    if (count >= STATE_LOOP_THRESHOLD) this.handleStateLoop();
    if (this.getRemainingMoveTime() > 0) {
      try {
        this.moveCommand.vector = this.getMoveVector(this.moveCommand.direction);
      } catch {
        this.stopMove();
      }
    }
    return true;
  }

  handleStateLoop() {
    if (this.loopRecoveryActive) return;
    this.loopRecoveryActive = true;
    this.stopAllActions();
    this.setAgentStatus('failed', this.activeUserGoal);
    this.announceCommand('STATE LOOP! RESETTING SPIDER!');
    this.scene.explodeAndRespawnSpider?.();
  }

  getMoveVector(direction) {
    const state = getSpiderControlState(this.scene.spider);
    const config = STATE_CONFIG[state];
    // Some WebMCP clients omit optional fields when invoking the shared
    // move/edge/tree schema. For a plain directional move, continue in the
    // spider's current facing direction; explicit invalid directions still
    // go through the normal state-aware validation below.
    if (direction === undefined || direction === null) {
      const facingDirection = this.scene.spider.facing < 0 ? 'left' : 'right';
      direction = config.directions.includes(facingDirection)
        ? facingDirection
        : config.directions[0];
    }
    if (!config.directions.includes(direction)) {
      throw new Error(
        `Direction ${direction} is unavailable while ${config.label.toLowerCase()}. ` +
        `Available directions: ${config.directions.join(', ') || 'none'}.`,
      );
    }
    if (state === 'platform_side') {
      const upX = this.scene.spider.surfaceSide;
      return { moveX: direction === 'up' ? upX : -upX, moveY: 0 };
    }
    return CARDINAL_VECTORS[direction];
  }

  setMove(direction, durationMs = 750) {
    const resolvedDirection = direction === undefined || direction === null
      ? this.getMoveDirectionFallback()
      : direction;
    const vector = this.getMoveVector(resolvedDirection);
    const duration = Math.min(5000, Math.max(100, Math.round(durationMs)));
    this.moveCommand = {
      direction: resolvedDirection,
      vector,
      expiresAt: this.scene.time.now + duration,
    };
  }

  getMoveDirectionFallback() {
    const config = STATE_CONFIG[getSpiderControlState(this.scene.spider)];
    const facingDirection = this.scene.spider.facing < 0 ? 'left' : 'right';
    return config.directions.includes(facingDirection)
      ? facingDirection
      : config.directions[0];
  }

  stopMove() {
    this.moveCommand = { direction: null, vector: { moveX: 0, moveY: 0 }, expiresAt: 0 };
  }

  stopAllActions() {
    this.stopMove();
    this.activeGoal = null;
    this.actionQueue = [];
    this.finishHunt();
    this.lastQueueError = null;
    this.activeToolName = null;
    this.activeToolUntil = 0;
    this.actionPlanCompletion = null;
    noop('[Spider navigation] all movement and autonomous goals stopped');
  }

  finishHunt() {
    this.huntInProgress = false;
    this.huntTarget = null;
    this.huntPounceAttempts = 0;
  }

  getRemainingMoveTime() {
    return Math.max(0, Math.round(this.moveCommand.expiresAt - this.scene.time.now));
  }

  markToolActive(toolName) {
    const displayNames = {
      move_to_tree: 'move_spider',
      move_to_edge: 'move_spider',
      approach_prey: 'move_spider',
      attach_to_tree: 'climb_tree',
      mount_current_platform: 'climb_tree',
      climb_to_platform: 'climb_tree',
      crawl_to_surface: 'move_spider',
    };
    const canonicalName = this.getCanonicalToolName(toolName);
    this.activeToolName = displayNames[canonicalName] || canonicalName;
    this.activeToolUntil = this.scene.time.now + 450;
  }

  clearActiveTool() {
    this.activeToolName = null;
    this.activeToolUntil = 0;
  }

  getActiveToolNames() {
    const active = new Set();
    const goalTools = new Set([
      'move_to_edge',
      'move_to_tree',
      'attach_spider',
      'climb_tree',
      'get_to_ground',
    ]);
    const attackTools = new Set(['jump_spider']);
    const toolIsRunning =
      (this.activeToolName === 'move_spider' &&
        (this.getRemainingMoveTime() > 0 || Boolean(this.activeGoal))) ||
      (this.activeToolName === 'climb_tree' && Boolean(this.activeGoal)) ||
      (this.activeToolName === 'hunt_prey' && this.huntInProgress) ||
      (goalTools.has(this.activeToolName) && Boolean(this.activeGoal)) ||
      (attackTools.has(this.activeToolName) &&
        (this.attackPending || this.scene.spider.isPouncing)) ||
      (this.activeToolName === 'drop_spider' && this.controlState === 'airborne');
    if (this.activeToolName && (toolIsRunning || this.scene.time.now < this.activeToolUntil)) {
      active.add(this.activeToolName);
    }
    // When no command is actively running, keep the bar useful as a compact
    // state indicator instead of leaving every tile unhighlighted after a
    // goal completes.
    if (!active.size) {
      const stateTool = {
        ground: 'move_spider',
        ground_near_tree: 'move_spider',
        ground_near_web: 'move_spider',
        tree: 'climb_tree',
        platform_side: 'climb_tree',
        under_platform: 'climb_tree',
        web: 'move_spider',
        airborne: 'jump_spider',
        transition: 'climb_tree',
        dead: 'stop_spider',
      }[this.controlState];
      if (stateTool) active.add(stateTool);
    }
    return active;
  }

  getGoalTarget() {
    if (this.huntInProgress && this.huntTarget?.alive !== false) {
      return {
        x: this.huntTarget.x,
        y: this.huntTarget.y,
        label: `HUNT ${this.huntTarget.type}`.toUpperCase(),
      };
    }

    const rootGoal = this.activeGoal;
    const goal = Array.isArray(rootGoal?.steps) ? rootGoal.steps.at(-1) : rootGoal;
    if (goal) {
      if (goal.type === 'move_to_edge') {
        const inset = Math.max(this.scene.spider.bodyHalfWidth + 3, 10);
        return {
          x: goal.side === 'left'
            ? goal.platform.x + inset
            : goal.platform.x + goal.platform.w - inset,
          y: goal.platform.y - 7,
          label: 'EDGE',
        };
      }
      if (['move_to_tree', 'attach_to_tree'].includes(goal.type)) {
        return {
          x: goal.tree.x + goal.tree.w / 2,
          y: goal.tree.y + goal.tree.h - 10,
          label: 'TREE',
        };
      }
      if (['climb_to_platform', 'mount_current_platform'].includes(goal.type)) {
        return {
          x: goal.platform.x + goal.platform.w / 2,
          y: goal.platform.y - 8,
          label: 'PLATFORM',
        };
      }
      if (goal.type === 'approach_prey' && goal.bug?.alive !== false) {
        return { x: goal.bug.x, y: goal.bug.y, label: `PREY ${goal.bug.type}`.toUpperCase() };
      }
      if (goal.type === 'descend_to_ground') {
        return {
          x: this.scene.spider.position.x,
          y: goal.ground.y - 8,
          label: 'GROUND',
        };
      }
      if (['crawl_to_surface', 'circle_platform'].includes(goal.type)) {
        return {
          x: goal.platform.x + goal.platform.w / 2,
          y: goal.platform.y - 8,
          label: goal.type === 'circle_platform' ? 'CIRCLE' : String(goal.surface).toUpperCase(),
        };
      }
    }

    if (this.getRemainingMoveTime() > 0) {
      const facing = this.moveCommand.direction === 'left' ? -1
        : this.moveCommand.direction === 'right' ? 1
          : this.scene.spider.facing === -1 ? -1 : 1;
      return {
        x: Math.max(30, Math.min(738, this.scene.spider.position.x + facing * 55)),
        y: this.scene.spider.position.y,
        label: 'MOVE',
      };
    }
    return null;
  }

  consumeInput(now) {
    if (this.moveCommand.expiresAt && now >= this.moveCommand.expiresAt) this.stopMove();
    // A standalone jump is still a valid locomotion command. Prey damage is
    // resolved by the hunt route/target, not by suppressing the jump input.
    const attackPressed = this.attackPending;
    this.attackPending = false;
    this.maybeCompleteActionPlan();
    return { ...this.moveCommand.vector, attackPressed };
  }

  maybeCompleteActionPlan() {
    if (!this.actionPlanCompletion || this.lastQueueError) return;
    if (this.actionQueue.length || this.activeGoal || this.getRemainingMoveTime()
      || this.attackPending || this.scene.spider.isPouncing) return;
    const completion = this.actionPlanCompletion;
    this.actionPlanCompletion = null;
    completion({ status: 'complete' });
  }

  failActionPlan(error) {
    if (!this.actionPlanCompletion) return;
    const completion = this.actionPlanCompletion;
    this.actionPlanCompletion = null;
    completion({ status: 'failed', error });
  }

  resolveTree(selector = 'forward') {
    const trees = [...this.scene.climbables].sort((a, b) => a.x - b.x);
    if (!trees.length) throw new Error('There are no climbable trees in the terrarium.');
    const normalized = String(selector).toLowerCase().trim();
    if (normalized === 'left' || normalized === 'first' || normalized === '1' || normalized === 'tree_1') return trees[0];
    if (normalized === 'right' || normalized === 'last' || normalized === '3' || normalized === 'tree_3') return trees[trees.length - 1];
    if (normalized === 'middle' || normalized === 'center' || normalized === 'second' || normalized === '2' || normalized === 'tree_2') {
      return trees[Math.floor(trees.length / 2)];
    }
    if (!isNaN(normalized) && normalized !== '') {
      const idx = Math.max(0, Math.min(trees.length - 1, parseInt(normalized, 10) - 1));
      return trees[idx];
    }
    if (selector === 'forward') {
      const facing = this.scene.spider.facing;
      const spiderX = this.scene.spider.position.x;
      const ahead = trees
        .filter((tree) => (tree.x + tree.w / 2 - spiderX) * facing > 0)
        .sort((a, b) =>
          Math.abs(a.x + a.w / 2 - spiderX) - Math.abs(b.x + b.w / 2 - spiderX));
      if (ahead.length) return ahead[0];
    }
    return trees.reduce((nearest, tree) => {
      const x = tree.x + tree.w / 2;
      const nearestX = nearest.x + nearest.w / 2;
      return Math.abs(x - this.scene.spider.position.x)
        < Math.abs(nearestX - this.scene.spider.position.x) ? tree : nearest;
    });
  }

  resolveConnectedPlatform(tree, direction = 'up', platformNumber = null) {
    const spider = this.scene.spider;
    const side = spider.surfaceType === 'wall'
      ? spider.surfaceSide
      : spider.position.x <= tree.x + tree.w / 2 ? 1 : -1;
    const connected = spider.getConnectedPlatforms(tree, side)
      .filter((platform) => platform.h <= 10)
      .map((platform) => ({
        platform,
        bodyY: platform.y - spider.bodyHalfHeight,
      }));
    if (platformNumber !== null && platformNumber !== undefined) {
      const numbered = [...connected].sort((a, b) => b.platform.y - a.platform.y);
      const target = numbered[Math.round(platformNumber) - 1];
      if (!target) {
        throw new Error(
          `Platform ${platformNumber} does not exist on this tree; it has ${numbered.length}.`,
        );
      }
      return target.platform;
    }
    const candidates = connected
      .filter((item) => item.platform !== spider.surfacePlatform)
      .filter((item) => direction === 'up'
        ? item.bodyY < spider.position.y - 8
        : item.bodyY > spider.position.y + 8)
      .sort((a, b) => Math.abs(a.bodyY - spider.position.y) - Math.abs(b.bodyY - spider.position.y));
    if (!candidates.length) {
      const allTreeCandidates = this.scene.platforms
        .filter((p) => p.h <= 10 && p !== spider.surfacePlatform)
        .filter((p) =>
          p.x <= tree.x + tree.w + 12 &&
          p.x + p.w >= tree.x - 12 &&
          p.y >= tree.y - 12 &&
          p.y <= tree.y + tree.h + 12
        )
        .map((p) => ({ platform: p, bodyY: p.y - spider.bodyHalfHeight }))
        .filter((item) => direction === 'up'
          ? item.bodyY < spider.position.y - 8
          : item.bodyY > spider.position.y + 8)
        .sort((a, b) => Math.abs(a.bodyY - spider.position.y) - Math.abs(b.bodyY - spider.position.y));
      if (allTreeCandidates.length) return allTreeCandidates[0].platform;
      throw new Error(`No connected platform is available ${direction}.`);
    }
    return candidates[0].platform;
  }

  startMoveToEdge(side = 'forward') {
    if (this.controlState !== 'ground' && this.controlState !== 'ground_near_tree') {
      throw new Error('move_to_edge is only available while on top of a platform or the ground.');
    }
    const spider = this.scene.spider;
    const platform = spider.surfacePlatform
      || this.scene.platforms.find((p) => p.h > 10)
      || this.scene.platforms[0];
    let resolvedSide = side;
    if (side === 'forward') {
      resolvedSide = spider.facing === 1 ? 'right' : 'left';
    } else if (side === 'nearest') {
      const leftDist = Math.abs(spider.position.x - platform.x);
      const rightDist = Math.abs(platform.x + platform.w - spider.position.x);
      resolvedSide = leftDist <= rightDist ? 'left' : 'right';
    }
    this.stopMove();
    this.activeGoal = { type: 'move_to_edge', platform, side: resolvedSide };
    noop('[Spider navigation] move_to_edge started', { side: resolvedSide, platform });
    return { accepted: true, side: resolvedSide };
  }

  startMoveToTree(selector) {
    if (this.controlState === 'tree') {
      const tree = this.resolveTree(selector);
      const ground = this.scene.platforms.find((platform) => platform.h > 10)
        || this.scene.platforms[0];
      this.stopMove();
      this.activeGoal = {
        type: 'navigation_sequence',
        steps: [
          { type: 'descend_to_ground', ground, drops: 0 },
          { type: 'move_to_tree', tree, selector },
        ],
      };
      return { accepted: true, tree: selector, status: 'descending_to_ground' };
    }
    if (this.controlState !== 'ground' && this.controlState !== 'ground_near_tree') {
      throw new Error('move_to_tree is only available while on the ground.');
    }
    const tree = this.resolveTree(selector);
    this.stopMove();
    this.activeGoal = { type: 'move_to_tree', tree, selector };
    noop('[Spider navigation] move_to_tree started', { selector, tree });
    return { accepted: true, tree: selector, target_x: round(tree.x + tree.w / 2) };
  }

  startMoveToTreeTarget(tree, selector = 'nearest') {
    if (this.controlState !== 'ground' && this.controlState !== 'ground_near_tree') {
      throw new Error('move_to_tree is only available while on a platform top or the ground.');
    }
    this.stopMove();
    this.activeGoal = { type: 'move_to_tree', tree, selector };
    noop('[Spider navigation] routed move_to_tree started', { selector, tree });
    return { accepted: true, tree: selector, target_x: round(tree.x + tree.w / 2) };
  }

  startAttach(target = 'tree') {
    const spider = this.scene.spider;
    if (this.controlState === 'tree') {
      return { accepted: true, attached: true, summary: 'Already attached to tree.' };
    }
    const tree = spider.getNearbyClimbable(25) || this.resolveTree('nearest');
    if (this.controlState === 'ground_near_tree') {
      spider.attachCooldown = 0;
      const side = spider.position.x <= tree.x + tree.w / 2 ? 1 : -1;
      spider.beginFloorToClimbable(tree, side, -1);
      return { accepted: true, attached: true, target: 'tree' };
    }
    this.stopMove();
    const steps = [
      { type: 'move_to_tree', tree, selector: 'nearest' },
      { type: 'attach_to_tree', tree },
    ];
    this.activeGoal = { type: 'navigation_sequence', steps };
    noop('[Spider navigation] attach_spider started', { tree });
    return { accepted: true, status: 'moving_to_tree' };
  }

  startClimbToPlatform(
    direction = 'up',
    platformNumber = null,
    targetTree = null,
    targetPlatform = null,
  ) {
    const supportedStates = [
      'ground', 'ground_near_tree', 'ground_near_web', 'tree', 'under_platform', 'platform_side',
    ];
    if (!supportedStates.includes(this.controlState)) {
      if (this.controlState === 'airborne' || this.controlState === 'transition' || this.controlState === 'web') {
        this.activeGoal = {
          type: 'wait_then_climb', direction, platformNumber, targetTree, targetPlatform,
        };
        return { accepted: true, status: 'waiting_for_surface' };
      }
      throw new Error('climb_to_platform requires contact with the ground, a platform, or a tree.');
    }
    const tree = targetTree || (this.controlState === 'tree'
      ? this.scene.spider.surfacePlatform
      : this.scene.spider.getNearbyClimbable(20) || this.resolveTree('nearest'));
    const platform = targetPlatform
      || this.resolveConnectedPlatform(tree, direction, platformNumber);
    const targetBodyY = platform.y - this.scene.spider.bodyHalfHeight;
    const resolvedDirection = targetBodyY < this.scene.spider.position.y ? 'up' : 'down';
    this.stopMove();
    const climbGoal = {
      type: 'climb_to_platform',
      tree,
      platform,
      direction: resolvedDirection,
      platformNumber,
      stage: 'climb',
    };
    const steps = [];
    if (this.controlState === 'under_platform' || this.controlState === 'platform_side') {
      steps.push({
        type: 'mount_current_platform',
        platform: this.scene.spider.surfacePlatform,
      });
    }
    // Being near any tree is not enough: the selected tree may be elsewhere
    // in the habitat. Only skip the approach leg when the spider is actually
    // touching the requested tree.
    const isNearTargetTree = this.controlState === 'ground_near_tree' &&
      this.scene.spider.getNearbyClimbable(20) === tree;
    if (this.controlState !== 'tree' && !isNearTargetTree) {
      steps.push({ type: 'move_to_tree', tree, selector: 'nearest' });
    }
    steps.push(climbGoal);
    this.activeGoal = steps.length === 1
      ? climbGoal
      : { type: 'navigation_sequence', steps };
    noop('[Spider navigation] climb_to_platform started', {
      direction: resolvedDirection,
      platformNumber,
      tree,
      platform,
    });
    return {
      accepted: true,
      direction: resolvedDirection,
      platform_number: platformNumber,
      target: { x: platform.x, y: platform.y },
    };
  }

  startHuntPrey(preyType = 'nearest') {
    const selection = this.findHuntRoute(preyType);
    if (selection.unreachable.length) {
      noop('[Spider navigation] A* skipped unreachable prey', selection.unreachable);
    }
    const prey = selection.bug;
    const route = selection.route;
    if (!prey) {
      const label = preyType === 'nearest' ? 'prey' : preyType;
      throw new Error(`No reachable living ${label} is available.`);
    }
    const toolPlan = this.buildHuntToolPlan(prey, route);
    this.stopMove();
    const huntPlan = toolPlan.map((action) => ({ ...action, _hunt: true }));
    this.huntInProgress = true;
    this.huntTarget = prey;
    this.huntPounceAttempts = 0;
    this.actionQueue.unshift(...huntPlan);
    noop('[Spider navigation] A* hunt route', {
      prey: { type: prey.type, x: round(prey.x), y: round(prey.y) },
      nodePath: route.nodePath,
      steps: route.steps.map((step) => step.type),
      toolPlan: toolPlan.map((action) => ({
        tool: action.tool,
        arguments: Object.fromEntries(
          Object.entries(action.arguments).filter(([key]) => !key.startsWith('_')),
        ),
      })),
    });
    return {
      accepted: true,
      prey_type: prey.type,
      route: route.nodePath,
      tools: toolPlan.map((action) => action.tool),
    };
  }

  findHuntRoute(preyType = 'nearest', goal = '', scene = this.scene) {
    let bugs = scene.bugManager.bugs;
    const fullText = String(goal).toLowerCase();
    const huntIndex = fullText.lastIndexOf('hunt');
    const text = huntIndex >= 0 ? fullText.slice(huntIndex) : fullText;
    if (/\bleft(?:most)?\b/.test(text)) {
      const left = bugs.filter((bug) => bug.x < scene.spider.position.x);
      if (left.length) bugs = left;
    } else if (/\bright(?:most)?\b/.test(text)) {
      const right = bugs.filter((bug) => bug.x > scene.spider.position.x);
      if (right.length) bugs = right;
    }
    return findReachablePreyRoute(scene, bugs, preyType);
  }

  buildHuntToolPlan(prey, route, controlState = this.controlState) {
    const toolPlan = [];
    if (controlState === 'under_platform' || controlState === 'platform_side') {
      toolPlan.push({
        tool: 'crawl_to_surface',
        arguments: { surface: 'top' },
      });
    }
    toolPlan.push(...route.steps.flatMap((step) => {
      if (step.type === 'move_to_tree') {
        return [{
          tool: 'move_to_tree',
          arguments: { tree: this.getTreeSelector(step.tree), _tree: step.tree },
        }];
      }
      if (step.type === 'climb_to_platform') {
        const tree = step.tree || this.getTreeForPlatform(step.platform);
        return [{
          tool: 'climb_tree',
          arguments: {
            target: 'platform',
            platform_number: this.getPlatformNumber(tree, step.platform),
            _tree: tree,
            _platform: step.platform,
          },
        }];
      }
      if (step.type === 'approach_prey') {
        return [
          { tool: 'approach_prey', arguments: { prey_type: prey.type, _bug: prey } },
          { tool: 'jump_spider', arguments: {} },
        ];
      }
      return [];
    }));
    return toolPlan;
  }

  expandPlanPreview(goal, plan) {
    if (!Array.isArray(plan?.tools)) return plan;
    const tools = [];
    const route = [];
    let previewScene = this.scene;
    for (const tool of plan.tools) {
      if (tool === 'move_spider' && /\btree\b/.test(String(goal).toLowerCase())) {
        const targetTree = this.resolvePlanTreeTarget(goal, plan.route);
        if (targetTree) {
          const isOnGround = previewScene.spider.surfaceType === 'floor'
            && previewScene.spider.surfacePlatform?.h > 10;
          tools.push(tool);
          if (!isOnGround) {
            const ground = previewScene.platforms.find((platform) => platform.h > 10)
              || previewScene.platforms[0];
            tools.push('get_to_ground');
            route.push({
              tool: 'get_to_ground',
              x: round(previewScene.spider.position.x),
              y: round(ground?.y - 8 || previewScene.spider.position.y),
              description: 'Descend to the ground',
            });
            previewScene = this.makePreviewSceneAtGround(previewScene);
          }
          tools.push('move_to_tree');
          route.push({
            tool: 'move_to_tree',
            x: round(targetTree.tree.x + targetTree.tree.w / 2),
            y: round(targetTree.tree.y + targetTree.tree.h - 10),
            description: `Move to the ${targetTree.selector} tree`,
          });
          previewScene = this.makePreviewSceneAtTree(previewScene, targetTree.tree);
          continue;
        }
      }
      if (tool === 'climb_tree') {
        const target = this.resolvePlanClimbTarget(goal, plan.route);
        if (target) {
          if (previewScene.spider.surfacePlatform !== target.tree) {
            tools.push('move_to_tree');
            route.push({
              tool: 'move_to_tree',
              x: round(target.tree.x + target.tree.w / 2),
              y: round(target.tree.y + target.tree.h - 10),
              description: `Move to the ${target.selector} tree`,
            });
          }
          tools.push('climb_tree');
          route.push({
            tool: 'climb_tree',
            x: round(target.platform.x + target.platform.w / 2),
            y: round(target.platform.y - 8),
            description: `Climb to platform ${target.platformNumber}`,
          });
          previewScene = this.makePreviewSceneAtPlatform(target.platform);
          continue;
        }
      }
      tools.push(tool);
      if (tool === 'hunt_prey') {
        const expanded = this.expandHuntPlanPreview(goal, previewScene);
        tools.push(...expanded.tools);
        route.push(...expanded.route);
        continue;
      }
      const modelStep = plan.route?.find((step) => step.tool === tool);
      if (modelStep) route.push(modelStep);
    }
    const actions = route.map((step, index) => {
      const description = String(step.description || '').toLowerCase();
      if (step.tool === 'move_to_tree') {
        const tree = /left/.test(description) ? 'left' : /right/.test(description) ? 'right' : 'nearest';
        return { tool: step.tool, arguments: { tree } };
      }
      if (step.tool === 'climb_tree') {
        const tree = /left/.test(description) ? 'left' : /right/.test(description) ? 'right' : 'nearest';
        const platform_number = /platform\s+2|top/.test(description) ? 'top' : 'bottom';
        return { tool: step.tool, arguments: { tree, platform_number } };
      }
      if (step.tool === 'approach_prey' || step.tool === 'hunt_prey') {
        const prey_type = ['fly', 'isopod', 'springtail'].find((type) => description.includes(type)) || 'nearest';
        return { tool: step.tool, arguments: { prey_type } };
      }
      if (step.tool === 'move_spider') {
        const direction = index > 0 && route[index - 1].x > step.x ? 'left' : 'right';
        return { tool: step.tool, arguments: { direction, duration_ms: 750 } };
      }
      return { tool: step.tool, arguments: {} };
    });
    return { ...plan, tools, route, actions };
  }

  resolvePlanClimbTarget(goal, modelRoute = []) {
    const text = String(goal).toLowerCase().split(/\b(?:then|hunt)\b/)[0];
    const trees = [...(this.scene.climbables || [])].sort((a, b) => a.x - b.x);
    if (!trees.length) return null;
    let selector = /\bleft\b/.test(text) ? 'left'
      : /\bright\b/.test(text) ? 'right'
        : /\b(?:center|middle)\b/.test(text) ? 'center' : 'nearest';
    let tree;
    if (selector === 'left') tree = trees[0];
    else if (selector === 'right') tree = trees.at(-1);
    else if (selector === 'center') tree = trees[Math.floor(trees.length / 2)];
    else {
      const hint = modelRoute.find((step) => step.tool === 'climb_tree');
      const targetX = Number.isFinite(hint?.x) ? hint.x : this.scene.spider.position.x;
      tree = trees.reduce((nearest, candidate) => (
        Math.abs(candidate.x + candidate.w / 2 - targetX)
          < Math.abs(nearest.x + nearest.w / 2 - targetX) ? candidate : nearest
      ));
      selector = this.getTreeSelector(tree);
    }
    const platforms = this.scene.platforms
      .filter((platform) => platform.h <= 10)
      .filter((platform) => (
        platform.x <= tree.x + tree.w + 8
        && platform.x + platform.w >= tree.x - 8
        && platform.y >= tree.y - 8
        && platform.y <= tree.y + tree.h + 8
      ))
      .sort((a, b) => b.y - a.y);
    if (!platforms.length) return null;
    const wantsSecond = /\b(?:second|secound|2nd|top)\b/.test(text);
    const platformIndex = wantsSecond ? Math.min(1, platforms.length - 1) : 0;
    return {
      tree,
      selector,
      platform: platforms[platformIndex],
      platformNumber: platformIndex + 1,
    };
  }

  resolvePlanTreeTarget(goal, modelRoute = []) {
    const trees = [...(this.scene.climbables || [])].sort((a, b) => a.x - b.x);
    if (!trees.length) return null;
    const text = String(goal).toLowerCase();
    const hint = modelRoute.find((step) => step.tool === 'move_spider');
    const targetX = Number.isFinite(hint?.x) ? hint.x : this.scene.spider.position.x;
    let tree;
    let selector;
    if (/\bleft\b/.test(text)) {
      tree = trees[0]; selector = 'left';
    } else if (/\bright\b/.test(text)) {
      tree = trees.at(-1); selector = 'right';
    } else if (/\b(?:center|middle)\b/.test(text)) {
      tree = trees[Math.floor(trees.length / 2)]; selector = 'center';
    } else {
      tree = trees.reduce((nearest, candidate) => (
        Math.abs(candidate.x + candidate.w / 2 - targetX)
          < Math.abs(nearest.x + nearest.w / 2 - targetX) ? candidate : nearest
      ));
      selector = this.getTreeSelector(tree);
    }
    return { tree, selector };
  }

  makePreviewSceneAtPlatform(platform) {
    return {
      ...this.scene,
      spider: {
        ...this.scene.spider,
        position: { x: platform.x + platform.w / 2, y: platform.y - 8 },
        surfacePlatform: platform,
        surfaceType: 'floor',
        grounded: true,
      },
    };
  }

  makePreviewSceneAtGround(scene) {
    const ground = scene.platforms.find((platform) => platform.h > 10) || scene.platforms[0];
    return {
      ...scene,
      spider: {
        ...scene.spider,
        position: { x: scene.spider.position.x, y: ground?.y - 8 || scene.spider.position.y },
        surfacePlatform: ground,
        surfaceType: 'floor',
        grounded: true,
      },
    };
  }

  makePreviewSceneAtTree(scene, tree) {
    return {
      ...scene,
      spider: {
        ...scene.spider,
        position: { x: tree.x + tree.w / 2, y: tree.y + tree.h - 10 },
        surfacePlatform: tree,
        surfaceType: 'wall',
        grounded: true,
      },
    };
  }

  expandHuntPlanPreview(goal, previewScene = this.scene) {
    const preyType = /\bspringtail\b/i.test(goal) ? 'springtail'
      : /\bisopod\b/i.test(goal) ? 'isopod'
        : /\bfly\b/i.test(goal) ? 'fly' : 'nearest';
    const selection = this.findHuntRoute(preyType, goal, previewScene);
    if (!selection.bug || !selection.route) return { tools: [], route: [] };
    const actions = this.buildHuntToolPlan(selection.bug, selection.route, 'ground');
    const route = actions.map((action) => this.getHuntPreviewPoint(action, selection.bug));
    return {
      tools: actions.map((action) => action.tool),
      route,
    };
  }

  getHuntPreviewPoint(action, prey) {
    if (action.tool === 'move_to_tree') {
      const tree = action.arguments._tree;
      return {
        tool: action.tool,
        x: round(tree.x + tree.w / 2),
        y: round(tree.y + tree.h - 10),
        description: `Move to the ${action.arguments.tree} tree`,
      };
    }
    if (action.tool === 'climb_tree') {
      const platform = action.arguments._platform;
      return {
        tool: action.tool,
        x: round(platform.x + platform.w / 2),
        y: round(platform.y - 8),
        description: `Climb to platform ${action.arguments.platform_number}`,
      };
    }
    if (action.tool === 'crawl_to_surface') {
      const platform = this.scene.spider.surfacePlatform;
      return {
        tool: action.tool,
        x: round(platform?.x + platform?.w / 2 || this.scene.spider.position.x),
        y: round(platform?.y - 8 || this.scene.spider.position.y),
        description: 'Crawl onto the platform top',
      };
    }
    return {
      tool: action.tool,
      x: round(prey.x),
      y: round(prey.y),
      description: action.tool === 'jump_spider'
        ? `Pounce on the ${prey.type}`
        : `Approach the ${prey.type}`,
    };
  }

  startApproachPrey(preyType = 'nearest', targetBug = null) {
    const spider = this.scene.spider;
    const bug = targetBug || this.scene.bugManager.bugs
      .filter((candidate) =>
        candidate.alive && (preyType === 'nearest' || candidate.type === preyType))
      .sort((a, b) =>
        Math.hypot(a.x - spider.position.x, a.y - spider.position.y)
        - Math.hypot(b.x - spider.position.x, b.y - spider.position.y))[0];
    if (!bug) throw new Error('No matching prey is available to approach.');
    this.stopMove();
    this.activeGoal = { type: 'approach_prey', bug, attackWhenReady: false };
    noop('[Spider navigation] approach_prey started', {
      type: bug.type,
      x: round(bug.x),
      y: round(bug.y),
    });
    return { accepted: true, prey_type: bug.type };
  }

  getTreeSelector(tree) {
    const trees = [...this.scene.climbables].sort((a, b) => a.x - b.x);
    const index = trees.indexOf(tree);
    if (index === 0) return 'left';
    if (index === trees.length - 1) return 'right';
    return 'center';
  }

  getTreeForPlatform(platform) {
    return this.scene.climbables.find((tree) =>
      platform.x <= tree.x + tree.w + 8
      && platform.x + platform.w >= tree.x - 8
      && platform.y >= tree.y - 8
      && platform.y <= tree.y + tree.h + 8)
      || this.resolveTree('nearest');
  }

  getPlatformNumber(tree, platform) {
    return this.scene.platforms
      .filter((candidate) =>
        candidate.h <= 10
        && candidate.x <= tree.x + tree.w + 8
        && candidate.x + candidate.w >= tree.x - 8
        && candidate.y >= tree.y - 8
        && candidate.y <= tree.y + tree.h + 8)
      .sort((a, b) => b.y - a.y)
      .indexOf(platform) + 1;
  }

  dropSpider() {
    const supportedStates = ['under_platform', 'platform_side', 'tree'];
    if (!supportedStates.includes(this.controlState)) {
      throw new Error('Drop is only available when clinging to a tree or platform.');
    }
    this.stopMove();
    this.activeGoal = null;
    if (!this.executingPlanAction) this.actionQueue = [];
    this.scene.spider.detachFromSurface();
    this.scene.spider.attachCooldown = 0.35;
    this.scene.spider.velocity.y = Math.max(this.scene.spider.velocity.y, 20);
    this.syncState();
    return { accepted: true, dropped: true };
  }

  startGetToGround() {
    const ground = this.scene.platforms.find((platform) => platform.h > 10)
      || this.scene.platforms[0];
    if (this.controlState === 'ground' && this.scene.spider.surfacePlatform === ground) {
      return { accepted: true, already_on_ground: true };
    }
    this.stopMove();
    this.activeGoal = {
      type: 'descend_to_ground',
      ground,
      drops: 0,
    };
    noop('[Spider navigation] drop route to ground started', {
      state: this.controlState,
      platform: this.scene.spider.surfacePlatform,
    });
    return {
      accepted: true,
      method: 'crawl_to_underside_then_drop',
    };
  }

  getPlatformSurfaceKey(platform) {
    const spider = this.scene.spider;
    if (spider.surfacePlatform !== platform) return null;
    if (this.controlState === 'ground'
      || this.controlState === 'ground_near_tree'
      || this.controlState === 'ground_near_web') return 'top';
    if (this.controlState === 'under_platform') return 'underside';
    if (this.controlState === 'platform_side') {
      return spider.surfaceSide === 1 ? 'left_side' : 'right_side';
    }
    return null;
  }

  getCurrentElevatedPlatform() {
    const platform = this.scene.spider.surfacePlatform;
    if (!platform || platform.climbable || platform.h > 10) {
      throw new Error('Surface crawling requires contact with an elevated platform.');
    }
    return platform;
  }

  startCrawlToSurface(surface) {
    const platform = this.getCurrentElevatedPlatform();
    this.stopMove();
    this.activeGoal = { type: 'crawl_to_surface', platform, surface };
    noop('[Spider navigation] crawl_to_surface started', { surface, platform });
    return { accepted: true, surface };
  }

  startCirclePlatform(direction = 'clockwise') {
    const platform = this.getCurrentElevatedPlatform();
    const startSurface = this.getPlatformSurfaceKey(platform);
    if (!startSurface) throw new Error('Wait until the spider finishes changing surfaces.');
    this.stopMove();
    this.activeGoal = {
      type: 'circle_platform',
      platform,
      direction,
      startSurface,
      lastSurface: startSurface,
      surfacesVisited: 0,
    };
    noop('[Spider navigation] circle_platform started', { direction, startSurface, platform });
    return { accepted: true, direction, start_surface: startSurface };
  }

  driveGoal(direction) {
    this.setMove(direction, 180);
  }

  processMoveToEdge(goal) {
    const spider = this.scene.spider;
    if (!['ground', 'ground_near_tree', 'ground_near_web'].includes(this.controlState)) return 'failed';
    const inset = Math.max(spider.bodyHalfWidth + 3, 10);
    const targetX = goal.side === 'left'
      ? goal.platform.x + inset
      : goal.platform.x + goal.platform.w - inset;
    const dx = targetX - spider.position.x;
    if (Math.abs(dx) <= 3) {
      spider.facing = goal.side === 'left' ? -1 : 1;
      this.stopMove();
      return 'done';
    }
    this.driveGoal(dx < 0 ? 'left' : 'right');
    return 'running';
  }

  processMoveToTree(goal) {
    const spider = this.scene.spider;
    if (this.controlState === 'tree' && spider.surfacePlatform === goal.tree) return 'done';
    if (this.controlState === 'transition' || this.controlState === 'airborne') return 'running';
    if (this.controlState === 'under_platform' || this.controlState === 'platform_side') {
      // Tree-to-tree travel should leave the current elevated platform and
      // continue from soil; crawling around the platform can oscillate at
      // corners while the target tree is elsewhere.
      spider.detachFromSurface();
      spider.velocity.y = Math.max(spider.velocity.y, 20);
      this.syncState();
      return 'running';
    }
    if (!['ground', 'ground_near_tree', 'ground_near_web'].includes(this.controlState)) return 'failed';
    const treeCenter = goal.tree.x + goal.tree.w / 2;
    const approachX = spider.position.x <= treeCenter
      ? goal.tree.x - 10
      : goal.tree.x + goal.tree.w + 10;
    const dx = approachX - spider.position.x;
    if (Math.abs(dx) <= 3 && spider.getNearbyClimbable(16) === goal.tree) return 'done';
    this.driveGoal(dx < 0 ? 'left' : 'right');
    return 'running';
  }

  processClimbToPlatform(goal) {
    const spider = this.scene.spider;
    if (this.controlState === 'transition') return 'running';

    if (goal.stage === 'mount_target') {
      return this.driveAroundPlatform(goal.platform, 'top');
    }

    if (goal.stage === 'bypass_platform') {
      const bypassStatus = this.driveAroundPlatform(goal.intermediatePlatform, 'top');
      if (bypassStatus !== 'done') return bypassStatus;
      goal.stage = 'return_to_tree';
      noop('[Spider navigation] intermediate platform bypassed', {
        platform: goal.intermediatePlatform,
      });
    }

    if (goal.stage === 'return_to_tree') {
      const returnStatus = this.processMoveToTree({ tree: goal.tree });
      if (returnStatus !== 'done') return returnStatus;
      goal.stage = 'climb';
      goal.intermediatePlatform = null;
      noop('[Spider navigation] resumed climb after intermediate platform');
      return 'running';
    }
    if (this.controlState === 'web') {
      this.stopMove();
      spider.detachFromSurface();
      spider.attachCooldown = 0.35;
      spider.velocity.y = Math.max(spider.velocity.y, 20);
      goal.drops += 1;
      this.syncState();
      return 'running';
    }

    if (this.controlState === 'under_platform' || this.controlState === 'platform_side') {
      if (spider.surfacePlatform === goal.platform) {
        goal.stage = 'mount_target';
        noop('[Spider navigation] target platform reached from below; mounting top');
        return this.driveAroundPlatform(goal.platform, 'top');
      }
      goal.stage = 'bypass_platform';
      goal.intermediatePlatform = spider.surfacePlatform;
      noop('[Spider navigation] bypassing intermediate platform', {
        platform: goal.intermediatePlatform,
        targetPlatform: goal.platform,
      });
      return this.driveAroundPlatform(goal.intermediatePlatform, 'top');
    }

    if (
      (this.controlState === 'ground'
        || this.controlState === 'ground_near_tree'
        || this.controlState === 'ground_near_web')
      && spider.surfacePlatform === goal.platform
    ) return 'done';
    if (this.controlState === 'ground_near_tree') {
      if (spider.getNearbyClimbable(20) !== goal.tree) {
        return this.processMoveToTree({ tree: goal.tree });
      }
      if (spider.surfaceType === 'floor') {
        const side = spider.position.x <= goal.tree.x + goal.tree.w / 2 ? 1 : -1;
        spider.attachCooldown = 0;
        spider.beginFloorToClimbable(goal.tree, side, -1);
        return 'running';
      }
      this.driveGoal(goal.direction);
      return 'running';
    }
    if (this.controlState !== 'tree' || spider.surfacePlatform !== goal.tree) return 'failed';
    const targetY = goal.platform.y - spider.bodyHalfHeight;
    if (Math.abs(spider.position.y - targetY) <= 36) {
      goal.stage = 'mount_target';
      // Explicitly transition onto the requested branch. Relying on a
      // horizontal input here can select the wrong connected platform at a
      // junction and bounce the spider back to the ground.
      spider.beginClimbableToFloor(
        goal.tree,
        goal.platform,
        spider.surfaceVelocity,
        spider.surfaceSide,
      );
      return 'running';
    }
    this.driveGoal(targetY < spider.position.y ? 'up' : 'down');
    return 'running';
  }

  processApproachPrey(goal) {
    const { spider } = this.scene;
    const bug = goal.bug;
    if (!bug.alive) return 'done';
    if (this.controlState === 'transition' || spider.isPouncing) return 'running';
    if (!['ground', 'ground_near_tree', 'ground_near_web'].includes(this.controlState)) return 'failed';

    const dx = bug.x - spider.position.x;
    const dy = bug.y - spider.position.y;
    const distance = Math.hypot(dx, dy);

    const isPlatformLeap = dy > 15 && dy <= 190 && Math.abs(dx) <= 150;
    const isLevelPounce = Math.abs(dy) <= 35 && distance <= 85;

    // If within direct platform leap range onto lower prey or in level pounce range:
    if (isPlatformLeap || isLevelPounce) {
      spider.facing = dx < 0 ? -1 : 1;
      this.stopMove();
      if (goal.attackWhenReady !== false) this.attackPending = true;
      return 'done';
    }

    // Drive horizontally towards prey
    this.driveGoal(dx < 0 ? 'left' : 'right');
    return 'running';
  }

  processMountCurrentPlatform(goal) {
    const spider = this.scene.spider;
    if (this.controlState === 'transition') return 'running';
    if (!goal.platform && this.controlState === 'under_platform') {
      goal.platform = spider.surfacePlatform
        || (this.scene.platforms || []).find((platform) => (
          platform.h <= 10 && Math.abs(platform.y - spider.position.y) < 30
        ));
      if (!goal.platform) return 'running';
    }
    if (this.controlState === 'ground'
      || this.controlState === 'ground_near_tree'
      || this.controlState === 'ground_near_web') {
      return spider.surfacePlatform === goal.platform ? 'done' : 'failed';
    }
    if (spider.surfacePlatform !== goal.platform) return 'failed';
    if (this.controlState === 'under_platform') {
      const leftDistance = spider.position.x - goal.platform.x;
      const rightDistance = goal.platform.x + goal.platform.w - spider.position.x;
      this.driveGoal(leftDistance <= rightDistance ? 'left' : 'right');
      return 'running';
    }
    if (this.controlState === 'platform_side') {
      this.driveGoal('up');
      return 'running';
    }
    return 'failed';
  }

  driveAroundPlatform(platform, targetSurface) {
    const current = this.getPlatformSurfaceKey(platform);
    if (!current) return this.controlState === 'transition' ? 'running' : 'failed';
    if (current === targetSurface) return 'done';
    const spider = this.scene.spider;
    if (current === 'top') {
      if (targetSurface === 'left_side') this.driveGoal('left');
      else if (targetSurface === 'right_side') this.driveGoal('right');
      else {
        const left = spider.position.x - platform.x;
        const right = platform.x + platform.w - spider.position.x;
        this.driveGoal(left <= right ? 'left' : 'right');
      }
    } else if (current === 'underside') {
      if (targetSurface === 'left_side') this.driveGoal('left');
      else if (targetSurface === 'right_side') this.driveGoal('right');
      else {
        const left = spider.position.x - platform.x;
        const right = platform.x + platform.w - spider.position.x;
        this.driveGoal(left <= right ? 'left' : 'right');
      }
    } else if (current === 'left_side') {
      this.driveGoal(targetSurface === 'top' ? 'up' : 'down');
    } else if (current === 'right_side') {
      this.driveGoal(targetSurface === 'top' ? 'up' : 'down');
    }
    return 'running';
  }

  processCrawlToSurface(goal) {
    return this.driveAroundPlatform(goal.platform, goal.surface);
  }

  processDescendToGround(goal) {
    const spider = this.scene.spider;
    if (this.controlState === 'airborne' || this.controlState === 'transition') return 'running';

    if (
      (this.controlState === 'ground'
        || this.controlState === 'ground_near_tree'
        || this.controlState === 'ground_near_web')
      && spider.position.y >= goal.ground.y - 24
    ) {
      this.stopMove();
      spider.velocity.x = 0;
      noop('[Spider navigation] soil reached after drops', { drops: goal.drops });
      return 'done';
    }

    if (this.controlState === 'tree') {
      this.stopMove();
      spider.detachFromSurface();
      spider.attachCooldown = 0.35;
      // Leave the trunk vertically; an old undefined targetX here could
      // produce invalid velocity and a dramatic horizontal launch.
      spider.velocity.x = 0;
      spider.velocity.y = Math.max(spider.velocity.y, 20);
      goal.drops += 1;
      this.syncState();
      return 'running';
    }

    let platform = spider.surfacePlatform;
    // Collision state can briefly retain the ground platform after landing on
    // an elevated branch; recover the actual branch from the spider's height.
    if (spider.position.y < goal.ground.y - 24 && (!platform || platform.h > 10)) {
      platform = (this.scene.platforms || []).find((candidate) => (
        candidate.h <= 10 && Math.abs((candidate.y || 0) - spider.position.y) < 24
      )) || platform;
      if (platform && platform.h <= 10) spider.surfacePlatform = platform;
    }
    if (!platform && spider.position.y < goal.ground.y - 24) {
      platform = (this.scene.platforms || []).find((candidate) => (
        candidate.h <= 10
        && spider.position.x + spider.bodyHalfWidth > candidate.x
        && spider.position.x - spider.bodyHalfWidth < candidate.x + candidate.w
        && Math.abs(spider.position.y - candidate.y) < 28
      ));
      if (platform) spider.surfacePlatform = platform;
    }
    if (platform?.h > 10 && spider.position.y < goal.ground.y - 24) {
      spider.detachFromSurface();
      spider.velocity.y = Math.max(spider.velocity.y, 20);
      goal.drops += 1;
      this.syncState();
      return 'running';
    }
    if (!platform) {
      // A landing callback may clear surfacePlatform for one frame. Keep the
      // descent goal alive and let physics settle onto the next platform.
      if (spider.position.y < goal.ground.y - 24) {
        spider.detachFromSurface();
        spider.velocity.y = Math.max(spider.velocity.y, 20);
        goal.drops += 1;
        this.syncState();
        return 'running';
      }
      return 'failed';
    }
    if (platform.h > 10) return 'failed';
    if (this.controlState === 'ground' || this.controlState === 'ground_near_tree') {
      const inset = Math.max(spider.bodyHalfWidth + 4, 10);
      const left = Math.abs(spider.position.x - (platform.x + inset));
      const right = Math.abs(spider.position.x - (platform.x + platform.w - inset));
      const targetX = left <= right ? platform.x + inset : platform.x + platform.w - inset;
      if (Math.abs(spider.position.x - targetX) > 4) {
        this.driveGoal(spider.position.x < targetX ? 'right' : 'left');
        return 'running';
      }
      this.stopMove();
      spider.detachFromSurface();
      spider.attachCooldown = 0.35;
      spider.velocity.y = Math.max(spider.velocity.y, 20);
      goal.drops += 1;
      this.syncState();
      return 'running';
    }
    if (this.controlState !== 'under_platform') {
      return this.driveAroundPlatform(platform, 'underside');
    }

    this.stopMove();
    spider.detachFromSurface();
    spider.attachCooldown = 0.35;
    spider.velocity.y = Math.max(spider.velocity.y, 20);
    goal.drops += 1;
    noop('[Spider navigation] dropped from platform underside', {
      drops: goal.drops,
      platform,
    });
    this.syncState();
    return 'running';
  }

  processCirclePlatform(goal) {
    if (this.controlState === 'transition') return 'running';
    const current = this.getPlatformSurfaceKey(goal.platform);
    if (!current) return 'failed';
    if (current !== goal.lastSurface) {
      goal.lastSurface = current;
      goal.surfacesVisited += 1;
      noop('[Spider navigation] circle_platform surface', {
        surface: current,
        surfacesVisited: goal.surfacesVisited,
      });
    }
    if (goal.surfacesVisited >= 4 && current === goal.startSurface) return 'done';
    const clockwiseNext = {
      top: 'right_side',
      right_side: 'underside',
      underside: 'left_side',
      left_side: 'top',
    };
    const counterclockwiseNext = {
      top: 'left_side',
      left_side: 'underside',
      underside: 'right_side',
      right_side: 'top',
    };
    const next = goal.direction === 'counterclockwise'
      ? counterclockwiseNext[current]
      : clockwiseNext[current];
    return this.driveAroundPlatform(goal.platform, next);
  }

  processAttachToTree(goal) {
    const spider = this.scene.spider;
    if (this.controlState === 'transition') return 'running';
    if (this.controlState === 'tree') return 'done';
    if (this.controlState === 'ground_near_tree') {
      const tree = goal.tree || spider.getNearbyClimbable(25) || this.resolveTree('nearest');
      spider.attachCooldown = 0;
      const side = spider.position.x <= tree.x + tree.w / 2 ? 1 : -1;
      spider.beginFloorToClimbable(tree, side, -1);
      return 'done';
    }
    const moveStatus = this.processMoveToTree({ tree: goal.tree });
    if (moveStatus !== 'done') return moveStatus;
    const tree = goal.tree || spider.getNearbyClimbable(25) || this.resolveTree('nearest');
    spider.attachCooldown = 0;
    const side = spider.position.x <= tree.x + tree.w / 2 ? 1 : -1;
    spider.beginFloorToClimbable(tree, side, -1);
    return 'done';
  }

  processGoalStep(goal) {
    if (goal.type === 'wait_then_climb') {
      if (['airborne', 'transition', 'web'].includes(this.controlState)) return 'running';
      this.activeGoal = null;
      this.startClimbToPlatform(goal.direction, goal.platformNumber, goal.targetTree, goal.targetPlatform);
      return 'running';
    }
    if (goal.type === 'move_to_edge') return this.processMoveToEdge(goal);
    if (goal.type === 'move_to_tree') return this.processMoveToTree(goal);
    if (goal.type === 'attach_to_tree') return this.processAttachToTree(goal);
    if (goal.type === 'climb_to_platform') return this.processClimbToPlatform(goal);
    if (goal.type === 'approach_prey') return this.processApproachPrey(goal);
    if (goal.type === 'mount_current_platform') return this.processMountCurrentPlatform(goal);
    if (goal.type === 'crawl_to_surface') return this.processCrawlToSurface(goal);
    if (goal.type === 'descend_to_ground') return this.processDescendToGround(goal);
    if (goal.type === 'circle_platform') return this.processCirclePlatform(goal);
    return 'failed';
  }

  processAutomation() {
    if (!this.activeGoal) return false;
    const rootGoal = this.activeGoal;
    const isSequence = Array.isArray(rootGoal.steps);
    const step = isSequence ? rootGoal.steps[0] : rootGoal;
    const status = this.processGoalStep(step);
    if (status === 'running') return true;
    this.stopMove();
    if (status === 'failed') {
      noop('[Spider navigation] goal failed', { goal: rootGoal.type, step });
      this.lastQueueError = new Error(`Navigation step ${step.type} failed.`);
      this.activeGoal = null;
      if (this.huntInProgress) {
        this.actionQueue = this.actionQueue.filter((action) => !action._hunt);
        this.finishHunt();
      }
      return false;
    }
    if (isSequence) {
      rootGoal.steps.shift();
      if (rootGoal.steps.length) {
        noop('[Spider navigation] A* step complete', {
          completed: step.type,
          next: rootGoal.steps[0].type,
        });
        return true;
      }
    }
    noop('[Spider navigation] goal complete', { goal: rootGoal.type });
    this.activeGoal = null;
    if (this.huntInProgress && this.huntTarget?.alive !== true) {
      this.finishHunt();
    }
    if (!this.actionQueue.length) this.clearActiveTool();
    return true;
  }

  processActionQueue(now) {
    // Plans can be executed from a DOM event between game updates. Refresh the
    // cached state before deciding whether a queued action is safe to dispatch;
    // otherwise a plan accepted on the ground can run a ground-only action
    // after physics has already moved the spider into the air.
    this.syncState();
    if (this.lastQueueError || !this.actionQueue.length || this.getRemainingMoveTime() > 0 || this.activeGoal) return false;
    if (this.controlState === 'transition' || this.controlState === 'airborne') return false;
    const action = this.actionQueue.shift();
    try {
      const prerequisites = this.planActionPrerequisites(action);
      if (prerequisites.length) {
        const attempts = (action._prerequisiteAttempts || 0) + 1;
        if (attempts > 3) throw new Error(`Could not satisfy prerequisites for ${action.tool}.`);
        const retry = { ...action, _prerequisiteAttempts: attempts };
        const scheduledPrerequisites = prerequisites.map((item) => ({
          ...item,
          ...(action._hunt ? { _hunt: true } : {}),
        }));
        this.actionQueue.unshift(...scheduledPrerequisites, retry);
        noop('[Spider tools] A* prerequisite plan', {
          requested: action.tool,
          prerequisites: prerequisites.map((item) => item.tool),
          state: this.controlState,
        });
        return true;
      }
      noop('[Spider tools] dequeued action', {
        action,
        remainingActions: this.actionQueue.length,
        at: now,
      });
      this.executingPlanAction = true;
      try {
        this.markToolActive(action.tool);
        this.executeAction(action);
      } finally {
        this.executingPlanAction = false;
      }
      if (action._hunt && !this.activeGoal && !this.actionQueue.some((item) => item._hunt)) {
        if (action.tool === 'jump_spider' && this.shouldContinueHunt()) {
          this.huntPounceAttempts += 1;
          // Isopods and springtails can dodge the first pounce. Keep the
          // selected object as a live target and reacquire it after the leap
          // settles instead of ending the hunt at the attack command.
          this.activeGoal = {
            type: 'approach_prey',
            bug: this.huntTarget,
            attackWhenReady: true,
          };
          noop('[Spider navigation] continuing hunt after missed pounce', {
            prey: this.huntTarget.type,
          });
        } else if (!this.shouldContinueHunt()) {
          this.finishHunt();
        }
      }
      this.maybeCompleteActionPlan();
      return true;
    } catch (error) {
      this.actionQueue = [];
      this.finishHunt();
      this.lastQueueError = error;
      this.failActionPlan(error);
      noop('[Spider command] Remaining plan cancelled.', error);
      return false;
    }
  }

  shouldContinueHunt() {
    return this.huntInProgress &&
      PERSISTENT_HUNT_TYPES.has(this.huntTarget?.type) &&
      this.huntTarget?.alive === true &&
      this.huntPounceAttempts < 3;
  }

  consumeRestart() {
    const restart = this.restartPending;
    this.restartPending = false;
    return restart;
  }

  getAllTools() {
    return [...this.getBaseTools(), ...this.getStateTools()];
  }

  getCanonicalToolName(name) {
    const aliases = {
      jump: 'jump_spider',
      jump_spider: 'jump_spider',
      leap: 'jump_spider',
      pounce: 'jump_spider',
      pounce_spider: 'jump_spider',
      drop: 'drop_spider',
      attach: 'attach_spider',
      mount: 'attach_spider',
      go_to_edge: 'move_to_edge',
      walk_to_edge: 'move_to_edge',
    };
    return aliases[name] || name;
  }

  routeStepsToToolActions(steps) {
    return steps.flatMap((step) => {
      if (step.type === 'move_to_tree') {
        return [{
          tool: 'move_to_tree',
          arguments: { tree: this.getTreeSelector(step.tree), _tree: step.tree },
        }];
      }
      if (step.type === 'climb_to_platform') {
        const tree = step.tree || this.getTreeForPlatform(step.platform);
        return [{
          tool: 'climb_tree',
          arguments: {
            target: 'platform',
            platform_number: this.getPlatformNumber(tree, step.platform),
            _tree: tree,
            _platform: step.platform,
          },
        }];
      }
      return [];
    });
  }

  planAStarRouteToPlatformTop() {
    const candidates = (this.scene.platforms || [])
      .filter((platform) => platform.h <= 10)
      .map((platform) => ({
        platform,
        route: planRouteToPlatform(this.scene, platform),
        distance: Math.hypot(
          platform.x + platform.w / 2 - this.scene.spider.position.x,
          platform.y - this.scene.spider.position.y,
        ),
      }))
      .filter(({ route }) => route.steps.length)
      .sort((a, b) => a.route.steps.length - b.route.steps.length || a.distance - b.distance);
    return candidates.length ? this.routeStepsToToolActions(candidates[0].route.steps) : [];
  }

  planActionPrerequisites(action) {
    const toolName = this.getCanonicalToolName(action.tool);
    const available = new Set(
      this.getAvailableTools(action._hunt ? this.controlState : undefined)
        .map((tool) => tool.name),
    );
    if (toolName === 'approach_prey'
      && ['ground', 'ground_near_tree', 'ground_near_web'].includes(this.controlState)) {
      return [];
    }
    if (available.has(toolName)) return [];

    const platform = this.scene.spider.surfacePlatform;
    const onElevatedPlatform = platform && !platform.climbable && platform.h <= 10;

    if (toolName === 'drop_spider' && onElevatedPlatform) {
      return [{ tool: 'crawl_to_surface', arguments: { surface: 'underside' } }];
    }

    const needsPlatformTop = ['move_to_edge', 'approach_prey'].includes(toolName);
    if (needsPlatformTop && onElevatedPlatform) {
      return [{ tool: 'crawl_to_surface', arguments: { surface: 'top' } }];
    }
    if (needsPlatformTop && this.controlState === 'tree') {
      return this.planAStarRouteToPlatformTop();
    }

    if (toolName === 'attach_spider' && this.controlState === 'ground') {
      return [{ tool: 'move_to_tree', arguments: { tree: 'nearest' } }];
    }

    const needsSoil = ['move_to_tree', 'attach_spider'].includes(toolName);
    if (needsSoil && ['tree', 'platform_side', 'under_platform', 'ground'].includes(this.controlState)) {
      if (platform && platform.h <= 10) {
        return [{ tool: 'get_to_ground', arguments: {} }];
      }
    }
    return [];
  }

  validateToolArguments(tool, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error(`${tool.name} arguments must be an object.`);
    }
    const schema = tool.inputSchema || {};
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!(required in args)) throw new Error(`${tool.name} requires ${required}.`);
    }
    for (const [key, value] of Object.entries(args)) {
      // Underscore-prefixed references are created internally by A* routes and never accepted from models.
      if (key.startsWith('_')) continue;
      const property = properties[key];
      if (!property) {
        if (schema.additionalProperties === false) {
          throw new Error(`${tool.name} does not accept ${key}.`);
        }
        continue;
      }
      if (property.type === 'string' && typeof value !== 'string') {
        throw new Error(`${tool.name}.${key} must be a string.`);
      }
      if (property.type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`${tool.name}.${key} must be a boolean.`);
      }
      if (property.type === 'integer' && !Number.isInteger(value)) {
        throw new Error(`${tool.name}.${key} must be an integer.`);
      }
      if (property.enum && !property.enum.includes(value)) {
        throw new Error(`${tool.name}.${key} must be one of: ${property.enum.join(', ')}.`);
      }
      if (typeof property.minimum === 'number' && value < property.minimum) {
        throw new Error(`${tool.name}.${key} must be at least ${property.minimum}.`);
      }
      if (typeof property.maximum === 'number' && value > property.maximum) {
        throw new Error(`${tool.name}.${key} must be at most ${property.maximum}.`);
      }
    }
  }

  executeAction(action) {
    if (!action || typeof action.tool !== 'string') throw new Error('The model returned no action.');
    const aliases = {
      drop: 'drop_spider',
      jump: 'jump_spider',
      jump_spider: 'jump_spider',
      leap: 'jump_spider',
      pounce: 'jump_spider',
      pounce_spider: 'jump_spider',
      climt: 'climb_tree',
      climt_to_platform: 'climb_tree',
      climb_to_platform: 'climb_tree',
      climb_tree: 'climb_tree',
      climb_to_top: 'climb_tree',
      climb_to_top_of_tree: 'climb_tree',
      climb_trunk: 'climb_tree',
      attach: 'attach_spider',
      attach_spider: 'attach_spider',
      mount: 'attach_spider',
      mount_tree: 'attach_spider',
      attach_to_tree: 'attach_spider',
      grab: 'attach_spider',
      grab_tree: 'attach_spider',
      go_to_edge: 'move_to_edge',
      walk_to_edge: 'move_to_edge',
    };
    const rawTool = action.tool;
    const toolName = aliases[rawTool] || this.getCanonicalToolName(rawTool);
    const args = action.arguments || {};
    const available = this.getAvailableTools(action._hunt ? this.controlState : undefined)
      .map((tool) => tool.name);
    noop(`[Spider tools] execute → ${toolName}`, {
      arguments: args,
      state: this.controlState,
      availableTools: available,
    });
    if (toolName === 'none') return { accepted: false, summary: action.summary || 'No action available.' };
    const attackTools = new Set(['jump_spider']);
    const isAvailable = PRIVATE_ACTIONS.has(toolName) || available.includes(toolName) ||
      (attackTools.has(toolName) && available.some((t) => attackTools.has(t)));
    if (!isAvailable) {
      throw new Error(`${toolName} is unavailable in the current state (${this.controlState}).`);
    }
    let toolResult = null;
    if (toolName === 'move_spider') {
      if (args.target === 'tree') toolResult = this.startMoveToTree(args.tree);
      else if (args.target === 'edge') toolResult = this.startMoveToEdge(args.side);
      else this.setMove(args.direction, args.duration_ms);
    }
    else if (toolName === 'jump_spider') {
      const x = this.scene.spider.position.x;
      const width = this.scene.scale?.width || 768;
      if (x <= 30 || x >= width - 30) {
        this.scene.recoverFromEdge?.(x <= 30 ? 'right' : 'left');
        toolResult = { accepted: false, summary: 'Jump blocked at the edge; turning inward.' };
      }
      else if (this.scene.spider.isPouncing || !this.scene.spider.grounded) {
        toolResult = { accepted: false, summary: 'Finish the current jump before jumping again.' };
      }
      else if (!this.physicalStateConfig.canPounce) {
        if (this.controlState === 'airborne' || this.controlState === 'transition') {
          toolResult = { accepted: false, summary: 'Already airborne; jump ignored.' };
        } else {
          toolResult = { accepted: false, summary: 'Jump needs solid ground.' };
        }
      }
      else this.attackPending = true;
    }
    else if (toolName === 'drop_spider') toolResult = this.dropSpider();
    else if (toolName === 'move_to_edge') {
      toolResult = this.startMoveToEdge(args.side);
    }
    else if (toolName === 'move_to_tree') {
      if (args._tree) this.startMoveToTreeTarget(args._tree, args.tree);
      else this.startMoveToTree(args.tree);
    }
    else if (toolName === 'attach_spider') {
      toolResult = this.startAttach(args.target || 'tree');
    }
    else if (toolName === 'climb_tree') {
      const platformNumber = args.platform_number === 'top' || args.platform_number === 2 ? 2 : 1;
      toolResult = this.startClimbToPlatform(
        args.direction || 'up',
        platformNumber,
        args._tree || (args.tree ? this.resolveTree(args.tree) : null),
        args._platform,
      );
    }
    else if (toolName === 'hunt_prey') this.startHuntPrey(args.prey_type);
    else if (toolName === 'approach_prey') {
      this.startApproachPrey(args.prey_type, args._bug);
    }
    else if (toolName === 'get_to_ground') this.startGetToGround();
    else if (toolName === 'crawl_to_surface') this.startCrawlToSurface(args.surface);
    else if (toolName === 'circle_platform') this.startCirclePlatform(args.direction);
    else if (toolName === 'stop_spider') {
      // Keep later actions in a composed plan while cancelling current locomotion.
      this.stopMove();
      this.activeGoal = null;
      this.attackPending = false;
      toolResult = { stopped: true };
    }

    const displayedTool = this.getAllTools().some((tool) => tool.name === rawTool)
      ? rawTool
      : toolName;
    this.markToolActive(displayedTool);
    const result = {
      accepted: true,
      ...toolResult,
      summary: action.summary || toolName.replaceAll('_', ' '),
    };
    noop(`[Spider tools] result ← ${toolName}`, result);
    return result;
  }

  executeActionPlan(plan, { onComplete = null } = {}) {
    if (!plan || !Array.isArray(plan.actions) || !plan.actions.length) {
      throw new Error('The model returned no action plan.');
    }
    if (plan.actions.length > 16) throw new Error('The action plan is too long.');
    const supported = new Set([
      'none',
      'move_spider',
      'move_to_edge',
      'go_to_edge',
      'walk_to_edge',
      'move_to_tree',
      'attach_spider',
      'attach',
      'mount',
      'mount_tree',
      'attach_to_tree',
      'grab',
      'grab_tree',
      'climb_to_platform',
      'climb_tree',
      'climb_to_top',
      'climb_to_top_of_tree',
      'climb_trunk',
      'climt',
      'climt_to_platform',
      'hunt_prey',
      'approach_prey',
      'get_to_ground',
      'crawl_to_surface',
      'circle_platform',
      'jump_spider',
      'jump',
      'leap',
      'pounce',
      'drop_spider',
      'drop',
      'stop_spider',
    ]);
    for (const action of plan.actions) {
      if (!action || !supported.has(action.tool)) throw new Error('The plan contains an unknown tool.');
    }
    this.stopAllActions();
    this.lastQueueError = null;
    this.actionPlanCompletion = typeof onComplete === 'function' ? onComplete : null;
    this.actionQueue = [...plan.actions];
    this.announceCommand(plan.spider_says || this.getPlanQuip(plan.actions));
    noop('[Spider tools] accepted action plan', {
      summary: plan.summary,
      actions: plan.actions,
    });
    this.processActionQueue(this.scene.time.now);
    this.maybeCompleteActionPlan();
    return {
      accepted: true,
      queued_actions: plan.actions.length,
      summary: plan.summary || `${plan.actions.length} actions scheduled`,
    };
  }

  getPlanQuip(actions) {
    if (actions.length > 1) return 'EIGHT LEGS, ONE PLAN!';
    const action = actions[0] || {};
    const direction = action.arguments?.direction?.toUpperCase();
    const quips = {
      move_spider: direction ? `SCUTTLE ${direction}!` : 'LEGS, ENGAGE!',
      move_to_edge: 'TO THE BRINK!',
      go_to_edge: 'TO THE BRINK!',
      walk_to_edge: 'TO THE BRINK!',
      jump_spider: 'LEAP OF FAITH!',
      jump: 'LEAP OF FAITH!',
      leap: 'LEAP OF FAITH!',
      drop_spider: 'BOMBS AWAY!',
      drop: 'BOMBS AWAY!',
      move_to_tree: 'TREE, HERE I COME!',
      attach_spider: 'LOCKED ON!',
      attach: 'LOCKED ON!',
      mount: 'LOCKED ON!',
      climb_tree: 'TO THE CANOPY!',
      climb_to_top: 'TO THE CANOPY!',
      climb_to_top_of_tree: 'TO THE CANOPY!',
      climb_trunk: 'TO THE CANOPY!',
      climb_to_platform: action.arguments?.platform_number
        ? `PLATFORM ${action.arguments.platform_number}, WHEE!`
        : 'UPSY-DAISY!',
      climt_to_platform: 'UPSY-DAISY!',
      climt: 'UPSY-DAISY!',
      hunt_prey: 'SNACK RADAR: ON!',
      approach_prey: 'SNEAKY LEGS, GO!',
      get_to_ground: 'DIRT, SWEET DIRT!',
      crawl_to_surface: 'WALL MODE: WIGGLY!',
      circle_platform: 'AROUND WE GO!',
      stop_spider: 'LEGS ON BREAK!',
    };
    return quips[action.tool] || 'TINY MISSION ACCEPTED!';
  }

  announceCommand(text) {
    const cleaned = String(text || '')
      .replace(/[<>\n\r]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 36);
    if (!cleaned) return;
    noop('[Spider command] spider says', cleaned);
    this.scene.spider.sayCommand?.(cleaned);
  }

  announceToolCall(tool, args) {
    this.announceCommand(this.getPlanQuip([{ tool, arguments: args }]));
  }

  getAvailableTools(state = this.reportedControlState) {
    const currentState = state;
    return this.getAllTools()
      .map((tool) => ({
        name: tool.name,
        shortLabel: tool.name === 'move_spider'
          ? `MOVE ${Object.values(ARROWS).join(' ')}`
          : tool.shortLabel,
        allowedStates: tool.allowedStates,
      }));
  }

  getToolCatalog() {
    return this.getAllTools().map((tool) => ({
      name: tool.name,
      short_label: tool.shortLabel,
      description: tool.description,
      input_schema: tool.inputSchema,
      allowed_states: tool.allowedStates,
    }));
  }

  getState() {
    const { spider, spiderVision, bugManager } = this.scene;
    const nearbyPrey = (bugManager?.bugs || [])
      .filter((bug) => bug.alive)
      .map((bug) => {
        const dx = bug.x - spider.position.x;
        const dy = bug.y - spider.position.y;
        return {
          type: bug.type,
          x: round(bug.x), y: round(bug.y),
          relative_x: round(dx), relative_y: round(dy),
          distance: round(Math.hypot(dx, dy)), health: bug.health,
        };
      })
      .sort((a, b) => a.distance - b.distance);

    const trees = [...(this.scene.climbables || [])]
      .sort((a, b) => a.x - b.x)
      .map((tree, idx, arr) => {
        const label = idx === 0 ? 'left' : idx === arr.length - 1 ? 'right' : 'center';
        const treeCenterX = tree.x + tree.w / 2;
        return {
          index: idx + 1,
          label,
          name: `${label} tree`,
          x: round(tree.x),
          y: round(tree.y),
          width: round(tree.w),
          height: round(tree.h),
          distance: round(Math.abs(treeCenterX - spider.position.x)),
          relative_x: round(treeCenterX - spider.position.x),
        };
      });

    const platforms = (this.scene.platforms || []).map((p, index) => {
      const isGround = p.h > 10;
      const label = isGround ? 'ground' : `platform_${index}`;
      return {
        index,
        label,
        is_ground: isGround,
        x: round(p.x),
        y: round(p.y),
        width: round(p.w),
        height: round(p.h),
        relative_x: round(p.x + p.w / 2 - spider.position.x),
        relative_y: round(p.y - spider.position.y),
      };
    });

    const objects = {
      trees,
      platforms,
      prey: nearbyPrey,
    };

    return {
      control_state: this.reportedControlState,
      physical_state: this.controlState,
      execution_state: this.agentExecutionState,
      user_goal: this.activeUserGoal,
      state_label: this.stateConfig.label,
      available_tools: this.getAvailableTools()
        .filter((tool) => AGENT_TOOL_NAMES.has(tool.name))
        .map((tool) => tool.name),
      available_debug_tools: this.getAvailableTools().map((tool) => tool.name),
      available_directions: [...this.stateConfig.directions],
      position: { x: round(spider.position.x), y: round(spider.position.y) },
      velocity: { x: round(spider.velocity.x), y: round(spider.velocity.y) },
      facing: spider.facing === 1 ? 'right' : 'left',
      surface: spider.surfaceType,
      grounded: spider.grounded,
      pouncing: spider.isPouncing,
      health: spider.health,
      max_health: spider.maxHealth,
      dead: spider.isDead,
      size_percent: Number.isFinite(spider.growthScale)
        ? Math.round(spider.growthScale * 1000) / 10
        : null,
      minimum_size_percent: 50,
      prey_hunted: bugManager?.huntedCount || 0,
      vision_enabled: spiderVision?.visible || false,
      active_move: this.getRemainingMoveTime()
        ? { direction: this.moveCommand.direction, remaining_ms: this.getRemainingMoveTime() }
        : null,
      active_goal: this.activeGoal?.type || null,
      autonomous_activity: this.huntInProgress ? 'hunt_prey' : null,
      hunt_target: this.huntTarget
        ? { type: this.huntTarget.type, x: round(this.huntTarget.x), y: round(this.huntTarget.y) }
        : null,
      objects,
      trees,
      platforms,
      nearby_prey: nearbyPrey,
    };
  }

  destroy() {
    noop('[WebMCP] destroying spider tool registrations');
    this.baseRegistrationController.abort();
    this.stopMove();
    this.actionQueue = [];
    this.activeGoal = null;
    this.finishHunt();
    this.agentExecutionState = 'idle';
    this.activeUserGoal = null;
    this.lastQueueError = null;
    this.activeToolName = null;
    this.activeToolUntil = 0;
    this.attackPending = false;
    this.restartPending = false;
    this.loopTransitionCounts.clear();
    this.loopRecoveryActive = false;
  }
}
