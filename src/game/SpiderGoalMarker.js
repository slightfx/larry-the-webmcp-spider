export class SpiderGoalMarker {
  constructor(scene, controller) {
    this.scene = scene;
    this.controller = controller;
    this.graphics = scene.add.graphics().setDepth(1250);
    this.label = scene.add.text(0, 0, '', {
      fontFamily: 'monospace',
      fontSize: '7px',
      color: '#fff1a8',
      backgroundColor: '#24312add',
      padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(1251);
    this.planRoute = [];
    this.planLabels = [];
  }

  update() {
    const target = this.controller.getGoalTarget();
    this.graphics.clear();
    if (!target && this.planRoute.length) {
      this.drawPlanRoute();
      this.label.setVisible(false);
      return;
    }
    this.setPlanLabelsVisible(false);
    this.label.setVisible(Boolean(target));
    if (!target) return;

    const spider = this.scene.spider.position;
    const pulse = (Math.sin(this.scene.time.now * 0.008) + 1) / 2;
    const radius = 7 + pulse * 2;
    this.drawDottedPath(spider.x, spider.y - 8, target.x, target.y);

    this.graphics.lineStyle(1, 0xfff1a8, 0.95);
    this.graphics.strokeCircle(target.x, target.y, radius);
    this.graphics.lineBetween(target.x - radius - 4, target.y, target.x - radius + 1, target.y);
    this.graphics.lineBetween(target.x + radius - 1, target.y, target.x + radius + 4, target.y);
    this.graphics.lineBetween(target.x, target.y - radius - 4, target.x, target.y - radius + 1);
    this.graphics.lineBetween(target.x, target.y + radius - 1, target.x, target.y + radius + 4);
    this.graphics.fillStyle(0xfff1a8, 0.9);
    this.graphics.fillTriangle(
      target.x, target.y - radius - 8,
      target.x - 3, target.y - radius - 13,
      target.x + 3, target.y - radius - 13,
    );

    this.label.setText(`GOAL: ${target.label}`);
    this.label.setPosition(target.x, Math.max(18, target.y - radius - 15));
  }

  setPlanRoute(route) {
    this.planRoute = Array.isArray(route) ? route.map((step) => ({ ...step })) : [];
    for (const label of this.planLabels) label.destroy();
    this.planLabels = this.planRoute.map((step, index) => {
      const description = String(step.description || '')
        .replace(/[<>\n\r]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 30);
      const toolName = String(step.tool).replaceAll('_', ' ').toUpperCase();
      return this.scene.add.text(0, 0, '', {
        fontFamily: 'monospace',
        fontSize: '7px',
        color: '#fff1a8',
        backgroundColor: '#24312add',
        padding: { x: 3, y: 2 },
        align: 'center',
      }).setOrigin(0.5, 1).setDepth(1251).setText(
        description ? `${index + 1}. ${toolName}\n${description}` : `${index + 1}. ${toolName}`,
      );
    });
  }

  setPlanLabelsVisible(visible) {
    for (const label of this.planLabels) label.setVisible(visible);
  }

  drawPlanRoute() {
    let from = { x: this.scene.spider.position.x, y: this.scene.spider.position.y - 8 };
    const placed = [];
    this.setPlanLabelsVisible(true);
    this.planRoute.forEach((step, index) => {
      this.drawDashedSegment(from.x, from.y, step.x, step.y);
      this.drawRouteArrow(from.x, from.y, step.x, step.y);
      this.graphics.fillStyle(0xfff1a8, 0.95);
      this.graphics.fillCircle(step.x, step.y, 2.5);
      const labelX = step.x + (index % 2 === 0 ? -8 : 8);
      const label = this.planLabels[index];
      const x = Math.max(45, Math.min(723, labelX));
      const height = label.height || 18;
      const width = label.width || 80;
      let y = Math.max(height + 8, Math.min(420, step.y - 10 - (index % 3) * 22));
      const overlaps = (candidateY, other) => {
        const horizontal = Math.abs(x - other.x) < (width + other.width) / 2 + 4;
        const vertical = Math.abs(candidateY - other.y) < (height + other.height) + 4;
        return horizontal && vertical;
      };
      // Move labels upward until they no longer cover an earlier step.
      for (let attempts = 0; attempts < 12 && placed.some((other) => overlaps(y, other)); attempts += 1) {
        y -= height + 6;
      }
      if (y < height + 8) {
        y = Math.max(height + 8, Math.min(420, step.y + height + 16));
      }
      label.setPosition(x, y);
      placed.push({ x, y, width, height });
      from = step;
    });
  }

  drawDashedSegment(fromX, fromY, toX, toY) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const distance = Math.hypot(dx, dy);
    if (distance < 2) return;
    this.graphics.lineStyle(1.5, 0xfff1a8, 0.72);
    for (let offset = 0; offset < distance; offset += 10) {
      const start = offset / distance;
      const end = Math.min(offset + 5, distance) / distance;
      this.graphics.lineBetween(
        fromX + dx * start,
        fromY + dy * start,
        fromX + dx * end,
        fromY + dy * end,
      );
    }
  }

  drawRouteArrow(fromX, fromY, toX, toY) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    if (!Number.isFinite(angle) || Math.hypot(toX - fromX, toY - fromY) < 8) return;
    const tipX = toX - Math.cos(angle) * 4;
    const tipY = toY - Math.sin(angle) * 4;
    this.graphics.fillStyle(0xfff1a8, 0.9);
    this.graphics.fillTriangle(
      tipX, tipY,
      tipX - Math.cos(angle - 0.55) * 6, tipY - Math.sin(angle - 0.55) * 6,
      tipX - Math.cos(angle + 0.55) * 6, tipY - Math.sin(angle + 0.55) * 6,
    );
  }

  drawDottedPath(fromX, fromY, toX, toY) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const distance = Math.hypot(dx, dy);
    if (distance < 20) return;
    this.graphics.fillStyle(0xfff1a8, 0.45);
    for (let offset = 12; offset < distance - 10; offset += 10) {
      const ratio = offset / distance;
      this.graphics.fillCircle(fromX + dx * ratio, fromY + dy * ratio, 1);
    }
  }

  destroy() {
    this.graphics.destroy();
    this.label.destroy();
    for (const label of this.planLabels) label.destroy();
    this.planLabels = [];
  }
}
