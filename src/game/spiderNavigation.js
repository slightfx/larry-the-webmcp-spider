function distanceToPlatform(x, y, platform) {
  const nearestX = Math.max(platform.x, Math.min(x, platform.x + platform.w));
  return Math.hypot(x - nearestX, y - platform.y);
}

function platformTouchesTree(platform, tree, margin = 8) {
  const platformRight = platform.x + platform.w;
  const treeRight = tree.x + tree.w;
  const touchesHorizontally = platform.x <= treeRight + margin && platformRight >= tree.x - margin;
  const touchesVertically = platform.y >= tree.y - margin && platform.y <= tree.y + tree.h + margin;
  return touchesHorizontally && touchesVertically;
}

export function buildNavigationGraph(platforms, climbables) {
  const nodes = new Map();
  const addNode = (node) => nodes.set(node.id, { ...node, edges: [] });
  platforms.forEach((platform, index) => addNode({
    id: `platform:${index}`,
    type: 'platform',
    index,
    source: platform,
    x: platform.x + platform.w / 2,
    y: platform.y,
  }));
  climbables.forEach((tree, index) => addNode({
    id: `tree:${index}`,
    type: 'tree',
    index,
    source: tree,
    x: tree.x + tree.w / 2,
    y: tree.y + tree.h / 2,
  }));

  const connect = (a, b, cost) => {
    nodes.get(a).edges.push({ to: b, cost });
    nodes.get(b).edges.push({ to: a, cost });
  };
  platforms.forEach((platform, platformIndex) => {
    climbables.forEach((tree, treeIndex) => {
      if (!platformTouchesTree(platform, tree)) return;
      const verticalCost = Math.abs(platform.y - (tree.y + tree.h / 2));
      const horizontalCost = Math.abs(
        platform.x + platform.w / 2 - (tree.x + tree.w / 2),
      );
      connect(`platform:${platformIndex}`, `tree:${treeIndex}`, verticalCost + horizontalCost * 0.2 + 1);
    });
  });
  return nodes;
}

export function aStar(graph, startId, goalId) {
  if (!graph.has(startId) || !graph.has(goalId)) return [];
  const open = new Set([startId]);
  const cameFrom = new Map();
  const gScore = new Map([[startId, 0]]);
  const fScore = new Map([[startId, 0]]);

  while (open.size) {
    let current = null;
    for (const id of open) {
      if (current === null || (fScore.get(id) ?? Infinity) < (fScore.get(current) ?? Infinity)) {
        current = id;
      }
    }
    if (current === goalId) {
      const path = [current];
      while (cameFrom.has(current)) {
        current = cameFrom.get(current);
        path.unshift(current);
      }
      return path;
    }
    open.delete(current);
    for (const edge of graph.get(current).edges) {
      const tentative = (gScore.get(current) ?? Infinity) + edge.cost;
      if (tentative >= (gScore.get(edge.to) ?? Infinity)) continue;
      cameFrom.set(edge.to, current);
      gScore.set(edge.to, tentative);
      const next = graph.get(edge.to);
      const goal = graph.get(goalId);
      fScore.set(edge.to, tentative + Math.hypot(next.x - goal.x, next.y - goal.y));
      open.add(edge.to);
    }
  }
  return [];
}

export function planRouteToPlatform(scene, targetPlatform) {
  const graph = buildNavigationGraph(scene.platforms, scene.climbables);
  const spider = scene.spider;
  let startId;
  if (spider.surfacePlatform?.climbable) {
    startId = `tree:${scene.climbables.indexOf(spider.surfacePlatform)}`;
  } else if (scene.platforms.includes(spider.surfacePlatform)) {
    startId = `platform:${scene.platforms.indexOf(spider.surfacePlatform)}`;
  } else {
    const nearest = scene.platforms
      .map((platform, index) => ({ index, distance: distanceToPlatform(spider.position.x, spider.position.y, platform) }))
      .sort((a, b) => a.distance - b.distance)[0];
    startId = `platform:${nearest.index}`;
  }

  const goalIndex = scene.platforms.indexOf(targetPlatform);
  if (goalIndex < 0) return { nodePath: [], steps: [] };
  const goalId = `platform:${goalIndex}`;
  const nodePath = aStar(graph, startId, goalId);
  if (!nodePath.length) return { nodePath: [], steps: [] };

  const steps = [];
  for (let index = 1; index < nodePath.length; index += 1) {
    const node = graph.get(nodePath[index]);
    if (node.type === 'tree') steps.push({ type: 'move_to_tree', tree: node.source });
    else {
      const previousNode = graph.get(nodePath[index - 1]);
      steps.push({
        type: 'climb_to_platform',
        platform: node.source,
        tree: previousNode?.type === 'tree' ? previousNode.source : null,
      });
    }
  }
  return { nodePath, steps };
}

export function canPounceFromPlatformToPrey(spider, bug) {
  if (!spider.grounded || spider.surfaceType !== 'floor') return false;
  const dx = bug.x - spider.position.x;
  const dy = bug.y - spider.position.y;
  // Bug is below or at level within leap trajectory range
  if (dy < -20 || dy > 190) return false;
  if (Math.abs(dx) > 150) return false;
  return true;
}

export function planRouteToPrey(scene, bug) {
  const spider = scene.spider;
  // If spider is on top of a platform and can directly leap/pounce onto prey:
  if (canPounceFromPlatformToPrey(spider, bug)) {
    return {
      nodePath: ['direct_pounce'],
      steps: [{ type: 'approach_prey', bug, pounceFromPlatform: true }],
    };
  }

  const goal = scene.platforms
    .map((platform, index) => ({ index, distance: distanceToPlatform(bug.x, bug.y, platform) }))
    .sort((a, b) => a.distance - b.distance)[0];
  const route = planRouteToPlatform(scene, scene.platforms[goal.index]);
  if (!route.nodePath.length) return route;
  route.steps.push({ type: 'approach_prey', bug });
  return route;
}

export function findReachablePreyRoute(scene, bugs, preyType = 'nearest') {
  const { spider } = scene;
  const candidates = bugs
    .filter((bug) => bug.alive && (preyType === 'nearest' || bug.type === preyType))
    .map((bug) => ({
      bug,
      distance: Math.hypot(bug.x - spider.position.x, bug.y - spider.position.y),
    }))
    .sort((a, b) => a.distance - b.distance);

  const unreachable = [];
  for (const candidate of candidates) {
    const route = planRouteToPrey(scene, candidate.bug);
    if (route.steps.length) return { ...candidate, route, unreachable };
    unreachable.push({
      type: candidate.bug.type,
      x: candidate.bug.x,
      y: candidate.bug.y,
      distance: candidate.distance,
    });
  }
  return { bug: null, route: null, unreachable };
}
