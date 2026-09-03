export const TUTORIAL_LEVELS = [
  {
    title: 'THE FIRST STEP',
    instruction: 'Welcome! Tell me where to go.',
    objective: 'Walk Larry to the right edge.',
    hint: 'Try: “walk right”',
    layout: 1,
    isComplete: ({ scene }) => scene.spider.position.x >= 640,
  },
  {
    title: 'UP THE TRUNK',
    instruction: 'That tree is climbable. Tell me to climb up.',
    objective: 'Find the tree and climb to its top.',
    hint: 'Try: “climb the center tree to the top”',
    layout: 2,
    isComplete: ({ scene, state }) => state === 'tree' && scene.spider.position.y < 150,
  },
  {
    title: 'THE SNEAKY CEILING',
    instruction: 'Branches can become ceilings. Look for a way across.',
    objective: 'Climb up, then move onto the branch above you.',
    hint: 'Try: “climb the right tree, then move left”',
    layout: 3,
    isComplete: ({ scene, state }) => state === 'under_platform' && scene.spider.position.y < 245,
  },
  {
    title: 'BACK DOWN',
    instruction: 'Up is not always the answer. Remember the ground below.',
    objective: 'Reach the high branch, then get back to the ground.',
    hint: 'Try: “climb the tree, then get back to the ground”',
    layout: 4,
    isComplete: ({ scene, state, tutorial }) => {
      if (state === 'tree' || state === 'under_platform') tutorial.visitedHeight = true;
      return tutorial.visitedHeight && state.startsWith('ground');
    },
  },
  {
    title: 'TINY HUNTER',
    instruction: 'I can hunt nearby creatures. Ask me to find a fly.',
    objective: 'Hunt one fly in the little habitat.',
    hint: 'Try: “hunt the nearest fly”',
    layout: 5,
    isComplete: ({ scene }) => scene.bugManager.huntedCount >= 1,
  },
  {
    title: 'MIND THE SPIKES',
    instruction: 'Those spikes look pointy. Tell me when to jump!',
    objective: 'Jump over the spikes, then reach the far side.',
    hint: 'Try: “walk right, then jump”',
    layout: 6,
    isComplete: ({ scene, tutorial }) => scene.spider.position.x >= 640 && tutorial.clearedSpikes,
  },
];

export function getTutorialLevel(index) {
  return TUTORIAL_LEVELS[Math.max(0, Math.min(TUTORIAL_LEVELS.length - 1, index))];
}
