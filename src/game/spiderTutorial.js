export const TUTORIAL_LEVELS = [
  {
    title: 'THE FIRST STEP',
    instruction: 'Welcome! Tell me where to go.',
    objective: 'Walk Larry to the right edge.',
    hint: 'Try: “walk right”',
    layout: 1,
    isComplete: ({ scene }) => scene.spider.position.x >= scene.tutorialTarget.x,
  },
  {
    title: 'UP THE TRUNK',
    instruction: 'That tree is climbable. Tell me to climb up.',
    objective: 'Find the tree and climb to the cave on its branch.',
    hint: 'Try: “climb the center tree, then move to the cave”',
    layout: 2,
    isComplete: ({ scene }) => nearTarget(scene),
  },
  {
    title: 'THE SNEAKY CEILING',
    instruction: 'Branches can become ceilings. Look for a way across.',
    objective: 'Climb up, then move onto the branch above you.',
    hint: 'Try: “climb the right tree, then move left”',
    layout: 3,
    isComplete: ({ scene, state }) => state === 'under_platform' && nearTarget(scene),
  },
  {
    title: 'BACK DOWN',
    instruction: 'Up is not always the answer. Remember the ground below.',
    objective: 'Reach the high branch, then get back to the ground.',
    hint: 'Try: “climb the tree, then get back to the ground”',
    layout: 4,
    isComplete: ({ scene, state, tutorial }) => {
      if (state === 'tree' || state === 'under_platform') tutorial.visitedHeight = true;
      return tutorial.visitedHeight && state.startsWith('ground') && nearTarget(scene);
    },
  },
  {
    title: 'TINY HUNTER',
    instruction: 'I can hunt nearby creatures. Ask me to find a fly.',
    objective: 'Hunt one fly in the little habitat.',
    hint: 'Try: “hunt the nearest fly”',
    layout: 5,
    isComplete: ({ scene }) => scene.bugManager.huntedCount >= 1 && nearTarget(scene),
  },
  {
    title: 'MIND THE SPIKES',
    instruction: 'Those spikes look pointy. Tell me when to jump!',
    objective: 'Jump over the spikes, then reach the far side.',
    hint: 'Try: “walk right, then jump”',
    layout: 6,
    isComplete: ({ scene, tutorial }) => scene.spider.position.x >= scene.tutorialTarget.x && tutorial.clearedSpikes,
  },
];

function nearTarget(scene) {
  const target = scene.tutorialTarget;
  return Boolean(target)
    && Math.abs(scene.spider.position.x - target.x) < 30
    && Math.abs(scene.spider.position.y - target.y) < 32;
}

export function getTutorialLevel(index) {
  return TUTORIAL_LEVELS[Math.max(0, Math.min(TUTORIAL_LEVELS.length - 1, index))];
}
