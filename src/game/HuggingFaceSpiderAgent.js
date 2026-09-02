import { parseToolCall, toToolDefinitions } from './SpiderToolCallUtils.js';
import { apiUrl as buildApiUrl } from './apiClient.js';
import { requestToolPlan } from './SpiderPlanRequest.js';

const PROXY_URL = buildApiUrl('/api/ollama/chat');

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

export class OllamaSpiderAgent {
  providerName = 'ollama';

  constructor({ apiUrl = PROXY_URL } = {}) {
    this.apiUrl = apiUrl;
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
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      tools: tools.map((tool) => ({ type: 'function', function: tool })),
      tool_choice: 'auto',
    };

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errorPayload = await response.json();
        detail = errorPayload?.error?.message || errorPayload?.message || JSON.stringify(errorPayload);
      } catch {
        detail = (await response.text()).slice(0, 240);
      }
      throw new Error(`Ollama request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
    }

    const payload = await response.json();
    const message = payload.choices?.[0]?.message;
    const call = message?.tool_calls?.[0]?.function;

    if (call) {
      const parsed = parseToolCall({ name: call.name, arguments: call.arguments });
      if (parsed) {
        parsed.reasoning = message.reasoning_content || parsed.reasoning || `Selected ${call.name}`;
        return normalizeDecision(parsed, goal);
      }
    }

    const content = message?.content;
    if (typeof content === 'string') {
      const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || content;
      try {
        const parsed = parseToolCall(fenced.trim());
        if (parsed) {
          parsed.reasoning = message.reasoning_content || parsed.reasoning || `Selected ${parsed.tool}`;
          return normalizeDecision(parsed, goal);
        }
      } catch {
        const object = fenced.match(/\{[\s\S]*\}/)?.[0];
        if (object) {
          const parsed = parseToolCall(object);
          if (parsed) {
            parsed.reasoning = message.reasoning_content || parsed.reasoning || `Selected ${parsed.tool}`;
            return normalizeDecision(parsed, goal);
          }
        }
      }
    }

    return normalizeDecision(parseToolCall(payload), goal);
  }
}
