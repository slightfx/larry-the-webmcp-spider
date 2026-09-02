const TOOL_NAMES = new Set([
  'stop_spider', 'move_spider', 'jump_spider', 'climb_tree', 'hunt_prey', 'get_to_ground',
]);

export function toToolDefinitions(toolCatalog) {
  return toolCatalog.filter((tool) => TOOL_NAMES.has(tool.name)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema || tool.inputSchema || {
      type: 'object', properties: {}, required: [], additionalProperties: false,
    },
  }));
}

export function parseToolCall(rawOutput) {
  const parsed = typeof rawOutput === 'string' ? JSON.parse(rawOutput) : rawOutput;
  const calls = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.function_calls) ? parsed.function_calls
      : Array.isArray(parsed?.answers) ? parsed.answers : null;
  if (calls && calls.length > 1) throw new Error('Model returned multiple tool calls; exactly one is required.');
  const call = calls ? calls[0] : parsed?.name ? parsed : null;
  if (!call?.name) return null;
  let args = call.arguments || call.args || {};
  if (typeof args === 'string') {
    try { args = args.trim() ? JSON.parse(args) : {}; } catch { args = {}; }
  }
  return { tool: call.name, arguments: args, reasoning: call.reasoning || null,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    raw_output: typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput) };
}

function validateValue(path, value, schema = {}) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object.`);
    const properties = schema.properties || {};
    for (const required of schema.required || []) if (!(required in value)) throw new Error(`${path} requires ${required}.`);
    for (const [key, child] of Object.entries(value)) {
      if (!properties[key]) { if (schema.additionalProperties === false) throw new Error(`${path} does not accept ${key}.`); continue; }
      validateValue(`${path}.${key}`, child, properties[key]);
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) throw new Error(`${path} needs at least ${schema.minItems} item(s).`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) throw new Error(`${path} accepts at most ${schema.maxItems} item(s).`);
    value.forEach((child, index) => validateValue(`${path}[${index}]`, child, schema.items));
  }
  if (schema.type === 'string' && typeof value !== 'string') throw new Error(`${path} must be a string.`);
  if (schema.type === 'integer' && !Number.isInteger(value)) throw new Error(`${path} must be an integer.`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} has an invalid value.`);
  if (typeof schema.minimum === 'number' && value < schema.minimum) throw new Error(`${path} is too small.`);
  if (typeof schema.maximum === 'number' && value > schema.maximum) throw new Error(`${path} is too large.`);
}

export function validateToolCall(action, toolCatalog) {
  if (!action?.tool) throw new Error('Model returned no tool call.');
  const tool = toolCatalog.find((candidate) => candidate.name === action.tool);
  if (!tool) throw new Error(`Model returned unknown tool ${action.tool}.`);
  const args = action.arguments || {};
  validateValue(action.tool, args, tool.input_schema || tool.inputSchema || {});
  return { tool: action.tool, arguments: args };
}
