const TOOL_LABELS = {
  inspect_game_world: 'INSPECT',
  stop_spider: 'STOP',
  move_spider: 'MOVE',
  jump_spider: 'JUMP',
  climb_tree: 'CLIMB',
  hunt_prey: 'HUNT',
  get_to_ground: 'GROUND',
};

const TOOL_COLORS = {
  inspect_game_world: '#d8c893',
  stop_spider: '#d8a28f',
  move_spider: '#a8c98b',
  jump_spider: '#fff1a8',
  climb_tree: '#b9a477',
  hunt_prey: '#f2cf78',
  get_to_ground: '#9bb38a',
};

const TOOL_QUIPS = {
  inspect_game_world: 'WORLD SCANNED',
  move_spider: 'ROUTE IN MOTION',
  jump_spider: 'POUNCE ARMED',
  climb_tree: 'SURFACE ACQUIRED',
  hunt_prey: 'TARGET ACQUIRED',
  get_to_ground: 'DESCENT PLANNED',
  stop_spider: 'COMMAND INTERRUPTED',
};

function clean(value, max = 24) {
  return String(value ?? '').replace(/[<>\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export class SpiderSpectacle {
  constructor(scene) {
    this.scene = scene;
    this.entries = [];
    this.lastHuntCount = 0;
    this.successUntil = 0;
    this.scanUntil = 0;
    this.createPanel();
    this.effects = scene.add.graphics().setDepth(1400);
  }

  createPanel() {
    document.getElementById('spider-spectacle')?.remove();
    this.panel = document.createElement('section');
    this.panel.id = 'spider-spectacle';
    this.panel.setAttribute('aria-label', 'WebMCP mission status');
    this.panel.innerHTML = `
      <div class="spider-spectacle-kicker">WEBMCP SHOWTIME</div>
      <div class="spider-spectacle-mission">MISSION: SCAN THE HABITAT</div>
      <div class="spider-spectacle-progress"><span></span></div>
      <div class="spider-spectacle-feed" aria-live="polite"></div>`;
    document.getElementById('app')?.append(this.panel);
    this.mission = this.panel.querySelector('.spider-spectacle-mission');
    this.progress = this.panel.querySelector('.spider-spectacle-progress span');
    this.feed = this.panel.querySelector('.spider-spectacle-feed');
  }

  toolCalled(tool, args = {}, source = 'internal') {
    if (source !== 'browser') return;
    for (const entry of this.entries) {
      if (entry.status === 'LIVE') entry.status = 'DONE';
    }
    const entry = {
      tool,
      label: TOOL_LABELS[tool] || tool.replaceAll('_', ' ').toUpperCase(),
      detail: this.toolDetail(tool, args),
      status: 'RUNNING',
      createdAt: this.scene.time.now,
    };
    this.entries.unshift(entry);
    this.entries = this.entries.slice(0, 4);
    this.renderFeed();
    this.setMissionForTool(tool);
    if (tool === 'inspect_game_world') this.scanUntil = this.scene.time.now + 650;
    this.pulsePanel();
  }

  toolResult(tool, result) {
    const entry = this.entries.find((candidate) => candidate.tool === tool && candidate.status === 'RUNNING');
    if (!entry) return;
    if (result?.accepted === false || result?.error) {
      entry.status = 'BLOCKED';
      entry.detail = clean(result.error || result.summary || 'ACTION BLOCKED');
    } else if (tool === 'inspect_game_world' || tool === 'stop_spider') {
      entry.status = 'DONE';
      entry.detail = TOOL_QUIPS[tool];
    } else {
      entry.status = 'LIVE';
    }
    this.renderFeed();
  }

  toolError(tool, message) {
    const entry = this.entries.find((candidate) => candidate.tool === tool && candidate.status === 'RUNNING');
    if (entry) {
      entry.status = 'BLOCKED';
      entry.detail = clean(message || 'ACTION BLOCKED');
      this.renderFeed();
    }
    this.setMission('MISSION INTERRUPTED', 18);
    this.pulsePanel(true);
  }

  setMissionForTool(tool) {
    const missions = {
      inspect_game_world: ['MISSION: SCAN THE HABITAT', 22],
      move_spider: ['MISSION: EXECUTE THE ROUTE', 42],
      climb_tree: ['MISSION: REACH THE HIGH GROUND', 58],
      jump_spider: ['MISSION: TIME THE POUNCE', 78],
      hunt_prey: ['MISSION: HUNT THE TARGET', 82],
      get_to_ground: ['MISSION: RETURN TO SOIL', 45],
    };
    const mission = missions[tool];
    if (mission) this.setMission(...mission);
  }

  setMission(label, percent) {
    if (this.mission) this.mission.textContent = label;
    if (this.progress) this.progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }

  onStateChange(previous, next) {
    if (previous === next) return;
    const entry = this.entries.find((candidate) => candidate.status === 'LIVE');
    if (entry && ['climb_tree', 'move_spider', 'get_to_ground'].includes(entry.tool)) {
      entry.detail = `${entry.detail} · ${clean(next, 15)}`;
      this.renderFeed();
    }
    this.burst(this.scene.spider.position.x, this.scene.spider.position.y - 5, 0xa8c98b, 5);
  }

  onHuntSuccess(count, bug) {
    this.lastHuntCount = count;
    const entry = this.entries.find((candidate) => candidate.tool === 'hunt_prey' && candidate.status === 'LIVE');
    if (entry) {
      entry.status = 'DONE';
      entry.detail = `${String(bug?.type || 'PREY').toUpperCase()} CAPTURED`;
    }
    this.setMission('NAVIGATION CONFIRMED', 100);
    this.successUntil = this.scene.time.now + 1800;
    this.renderFeed();
    this.panel?.classList.add('is-success');
    this.scene.cameras.main.flash(180, 255, 241, 168, false);
    this.scene.cameras.main.shake(180, 0.004);
    this.burst(bug?.x ?? this.scene.spider.position.x, bug?.y ?? this.scene.spider.position.y, 0xfff1a8, 16);
    this.scene.spider.sayCommand?.(`HUNT ${count} CONFIRMED!`);
  }

  update() {
    this.effects.clear();
    if (this.scanUntil > this.scene.time.now) {
      const elapsed = 650 - (this.scanUntil - this.scene.time.now);
      const x = 572 + Math.min(168, Math.max(0, elapsed / 650 * 168));
      this.effects.lineStyle(1, 0xfff1a8, 0.9);
      this.effects.lineBetween(x, 62, x, 148);
      this.effects.fillStyle(0xfff1a8, 0.12);
      this.effects.fillRect(Math.max(572, x - 10), 62, 10, 86);
    }
    if (this.successUntil && this.scene.time.now >= this.successUntil) {
      this.successUntil = 0;
      this.panel?.classList.remove('is-success');
      this.setMission('MISSION: SCAN THE HABITAT', 8);
    }
  }

  toolDetail(tool, args) {
    if (tool === 'move_spider') return clean(args.direction || args.target || 'DIRECTIVE');
    if (tool === 'climb_tree') return `${clean(args.tree || 'NEAREST')} / ${clean(args.platform_number || 'BOTTOM')}`;
    if (tool === 'hunt_prey') return clean(args.prey_type || 'NEAREST');
    return TOOL_QUIPS[tool] || 'COMMAND RECEIVED';
  }

  renderFeed() {
    if (!this.feed) return;
    this.feed.innerHTML = this.entries.map((entry) => `
      <div class="spider-spectacle-entry ${entry.status.toLowerCase()}" style="--tool-color:${TOOL_COLORS[entry.tool] || '#d8c893'}">
        <span class="spider-spectacle-status">${entry.status}</span>
        <span class="spider-spectacle-tool">${entry.label}</span>
        <span class="spider-spectacle-detail">${clean(entry.detail)}</span>
      </div>`).join('');
  }

  pulsePanel(error = false) {
    this.panel?.classList.remove('is-pulse', 'is-error');
    void this.panel?.offsetWidth;
    this.panel?.classList.add(error ? 'is-error' : 'is-pulse');
  }

  burst(x, y, color, count) {
    for (let index = 0; index < count; index += 1) {
      const angle = (Math.PI * 2 * index) / count;
      const distance = 12 + (index % 4) * 5;
      const spark = this.scene.add.rectangle(x, y, 2, 2, color).setDepth(1401);
      this.scene.tweens.add({
        targets: spark,
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance,
        alpha: 0,
        angle: 180,
        duration: 300 + (index % 3) * 70,
        ease: 'Cubic.Out',
        onComplete: () => spark.destroy(),
      });
    }
  }

  destroy() {
    this.panel?.remove();
    this.effects?.destroy();
  }
}
