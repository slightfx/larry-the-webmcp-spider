const PLAN_TOOL_NAME = 'return_tool_plan';

function parseArguments(rawArguments) {
  if (typeof rawArguments !== 'string') return rawArguments || {};
  try {
    return JSON.parse(rawArguments);
  } catch {
    throw new Error('The model returned an invalid plan.');
  }
}

function extractPlan(payload) {
  const message = payload?.choices?.[0]?.message;
  const call = message?.tool_calls?.find((candidate) => (
    candidate?.function?.name === PLAN_TOOL_NAME
  ))?.function;
  if (call) return parseArguments(call.arguments);

  const content = message?.content;
  if (typeof content === 'string') {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || content;
    try {
      const parsed = JSON.parse(fenced.trim());
      return Array.isArray(parsed) ? { tools: parsed } : parsed;
    } catch {
      const array = fenced.match(/\[[\s\S]*\]/)?.[0];
      if (array) return { tools: JSON.parse(array) };
    }
  }
  return payload;
}

function validatePlan(plan, toolCatalog) {
  const tools = plan?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('The model returned no ordered tool plan.');
  }
  if (tools.length > 12 || tools.some((name) => typeof name !== 'string')) {
    throw new Error('The model returned an invalid ordered tool plan.');
  }
  const knownTools = new Set(toolCatalog.map((tool) => tool.name));
  const unknown = tools.find((name) => !knownTools.has(name));
  if (unknown) throw new Error(`The model planned unknown tool ${unknown}.`);
  if (!Array.isArray(plan.route) || plan.route.length !== tools.length) {
    throw new Error('The model returned no route for the ordered tool plan.');
  }
  const route = plan.route.map((step, index) => {
    if (!step || step.tool !== tools[index]) {
      throw new Error('The model route does not match the ordered tool plan.');
    }
    const x = Number(step.x);
    const y = Number(step.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 768 || y < 0 || y > 432) {
      throw new Error(`The model returned an invalid route point for ${step.tool}.`);
    }
    return {
      tool: step.tool,
      x,
      y,
      description: String(step.description || '').slice(0, 80),
    };
  });
  return { tools, route };
}

export async function requestToolPlan(apiUrl, userMessage, toolCatalog, gameWorld) {
  const availableTools = toolCatalog.map(({ name, description }) => ({ name, description }));
  const prompt = [
    'Plan how to satisfy the user message in the game world.',
    'Return the tool names in the exact order they should be called.',
    'Also return one route endpoint for every tool. Use the game-world x/y coordinates.',
    'Each route endpoint must name the matching tool and briefly describe that part of the journey.',
    'Do not call or invent tools. Repeated tool names are allowed when necessary.',
    `User message: ${userMessage}`,
    `Available tools (names and descriptions): ${JSON.stringify(availableTools)}`,
    `Game world (from inspect_game_world): ${JSON.stringify(gameWorld)}`,
  ].join('\n');
  const planFunction = {
    type: 'function',
    function: {
      name: PLAN_TOOL_NAME,
      description: 'Return the ordered tool names needed to satisfy the user message.',
      parameters: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: { type: 'string', enum: toolCatalog.map((tool) => tool.name) },
            description: 'Tool names in execution order.',
          },
          route: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            description: 'One labeled journey endpoint for each ordered tool.',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', enum: toolCatalog.map((tool) => tool.name) },
                x: { type: 'number', minimum: 0, maximum: 768 },
                y: { type: 'number', minimum: 0, maximum: 432 },
                description: { type: 'string' },
              },
              required: ['tool', 'x', 'y', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['tools', 'route'],
        additionalProperties: false,
      },
    },
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      tools: [planFunction],
      tool_choice: 'required',
    }),
  });
  if (!response.ok) {
    let detail = '';
    try {
      const errorPayload = await response.json();
      detail = errorPayload?.error?.message || errorPayload?.message || JSON.stringify(errorPayload);
    } catch {
      detail = (await response.text()).slice(0, 240);
    }
    throw new Error(`Plan request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
  }

  return validatePlan(extractPlan(await response.json()), toolCatalog);
}
