import { parseToolCall, toToolDefinitions } from './SpiderToolCallUtils.js';
import { apiUrl } from './apiClient.js';
import { requestToolPlan } from './SpiderPlanRequest.js';

const API_URL = apiUrl('/api/lightning/chat');

function normalizeDecision(action, goal) {
  const stopRequested = /\b(stop|cancel|halt|freeze)\b/i.test(goal);
  if (action?.tool !== 'stop_spider' || stopRequested) return action;
  const direction = /\bright\b|east/i.test(goal) ? 'right'
    : /\bup\b|north/i.test(goal) ? 'up'
      : /\bdown\b|south/i.test(goal) ? 'down' : 'left';
  return { ...action, tool: 'move_spider', arguments: { target: 'direction', direction } };
}

function toolForClause(clause) {
  if (/\b(?:groun\w*|gournd\w*|descend|down)\b/i.test(clause)) return 'get_to_ground';
  if (/\bclim\w*|\bclib\w*|platform|tree\b/i.test(clause)) return 'climb_tree';
  if (/\bhunt|catch|eat|prey|isopod|fly|springtail\b/i.test(clause)) return 'hunt_prey';
  if (/\bjump|pounce\b/i.test(clause)) return 'jump_spider';
  if (/\bstop|cancel|halt\b/i.test(clause)) return 'stop_spider';
  if (/\bwalk|move|go\b/i.test(clause)) return 'move_spider';
  return null;
}

export class LightningSpiderAgent {
  providerName = 'lightning';

  constructor({ apiUrl: endpoint = API_URL } = {}) {
    this.apiUrl = endpoint;
  }

  isReady() {
    return true;
  }

  plan(userMessage, toolCatalog, gameWorld) {
    return requestToolPlan(this.apiUrl, userMessage, toolCatalog, gameWorld);
  }

  async decide(goal, toolCatalog, state = null, history = []) {
    const stopRequested = /\b(stop|cancel|halt|freeze)\b/i.test(goal);
    const clauses = String(goal).split(/\b(?:then|after that|and then)\b/i)
      .map((part) => part.trim()).filter(Boolean);
    const completedTools = history.flatMap((entry) => entry.actions || [])
      .map((action) => action.tool);
    const pendingClause = clauses.length > 1
      ? clauses.find((clause, index) => completedTools[index] !== toolForClause(clause))
      : null;
    const pendingTool = pendingClause ? toolForClause(pendingClause) : null;
    // Do not offer cancellation as a choice for ordinary movement/behavior
    // requests. Some models over-select the first/shortest tool name even when
    // the prompt clearly asks them to move, which leaves the spider stopped.
    let availableCatalog = stopRequested
      ? toolCatalog.filter((tool) => tool.name === 'stop_spider')
      : toolCatalog.filter((tool) => tool.name !== 'stop_spider');
    if (pendingTool && !stopRequested) {
      const forced = availableCatalog.filter((tool) => tool.name === pendingTool);
      if (forced.length) availableCatalog = forced;
    }
    const tools = toToolDefinitions(availableCatalog);
    const prompt = [
      'Control the terrarium spider using exactly one tool call.',
      'For movement requests, use move_spider. Use stop_spider only when the user explicitly asks to stop.',
      'Never select stop_spider for a movement request such as walk, move, go, or climb.',
      'Use climb_tree for climbing, hunt_prey for hunting, jump_spider for jumping, and get_to_ground to descend.',
      `Goal: ${goal}`,
      state ? `Current state: ${JSON.stringify(state)}` : '',
      history.length ? `Previous attempts: ${JSON.stringify(history.slice(-2))}` : '',
    ].filter(Boolean).join('\n');
    const requestBody = {
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: tools.map((tool) => ({ type: 'function', function: tool })),
      tool_choice: 'required',
    };
    let response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    // A few Lightning-hosted deployments expose chat completions but reject
    // the optional tool-calling fields. Retry those responses with an explicit
    // JSON contract so the returned call can still be dispatched through WebMCP.
    if (response.status >= 500) {
      response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: [{ type: 'text', text: `${prompt}\nReturn only JSON: {"name":"tool_name","arguments":{}}` }] }],
          response_format: { type: 'json_object' },
        }),
      });
    }
    if (!response.ok) {
      let detail = '';
      try {
        const errorPayload = await response.json();
        detail = errorPayload?.error?.message || errorPayload?.message || JSON.stringify(errorPayload);
      } catch {
        detail = (await response.text()).slice(0, 240);
      }
      throw new Error(`Lightning AI request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
    }
    const payload = await response.json();
    const message = payload.choices?.[0]?.message;
    const call = message?.tool_calls?.[0]?.function;
    if (call) {
      const parsed = parseToolCall({ name: call.name, arguments: call.arguments });
      return normalizeDecision(parsed, goal);
    }
    const content = message?.content;
    if (typeof content === 'string') {
      const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || content;
      try {
        const parsed = parseToolCall(fenced.trim());
        return normalizeDecision(parsed, goal);
      } catch {
        const object = fenced.match(/\{[\s\S]*\}/)?.[0];
        if (object) return normalizeDecision(parseToolCall(object), goal);
      }
    }
    return normalizeDecision(parseToolCall(payload), goal);
  }
}
