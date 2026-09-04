# Larry the WebMCP Spider

Larry is an interactive pixel-art spider terrarium built to explore what happens when a person and an AI agent can control the same web experience together.

The player can guide Larry manually, type or speak natural-language commands, or ask an AI model to inspect the terrarium and choose WebMCP tools. Larry can walk across surfaces, climb trees and platforms, hunt prey, jump, stop, and return to the ground.

## Why WebMCP?

Larry exposes structured, state-aware tools through the browser's WebMCP `document.modelContext` API. The agent does not need to guess how to click the game UI: it receives tool descriptions, input schemas, current-world state, and meaningful results from each action.

The game registers these tools:

| Tool | Purpose |
| --- | --- |
| `inspect_game_world` | Read Larry's location, surface, surroundings, prey, health, and active goal. |
| `move_spider` | Move in a direction or navigate to a platform edge or tree. |
| `jump_spider` | Jump or pounce from solid ground. |
| `climb_tree` | Navigate to a tree's bottom or top platform. |
| `hunt_prey` | Autonomously locate and catch a fly, springtail, isopod, or the nearest prey. |
| `get_to_ground` | Autonomously descend from elevated surfaces to the ground. |
| `stop_spider` | Cancel movement, a hunt, or another active goal. |

Tools include JSON input schemas, descriptions, state restrictions, read-only annotations, cancellation handling, and safety validation. The command panel also has a planning mode that asks an LLM to inspect the world and propose a sequence of WebMCP calls before execution.

## Features

- Pixel-art Phaser terrarium with ground, webs, cork trees, platforms, and moving prey.
- Human controls alongside agent controls.
- WebMCP tool registration and tool execution through the browser.
- State-aware navigation and autonomous multi-step goals.
- Manual WebMCP tool console for inspecting and testing individual actions.
- Natural-language command box with Ollama Cloud or Lightning AI adapters.
- Optional voice commands using browser recording and Deepgram Nova-3 transcription.
- Guest mode for manual play and password-protected AI access in deployed environments.

## Run locally

Requirements: Node.js 20 or newer and a browser with WebMCP support enabled.

```bash
npm install
npm run dev
```

The Vite development server runs on `http://localhost:5173`. For AI commands, start the API in a second terminal:

```bash
npm run dev:api
```

The API runs on `http://localhost:3000`. When using the Vite default URL, the server's default CORS configuration allows it.

For a production-style build:

```bash
npm run build
npm run preview
```

## Configuration

Create `server/.env` for optional AI and voice features. Never commit this file or API keys.

```dotenv
FRONTEND_URL=http://localhost:5173
SPIDER_PASSWORD=

OLLAMA_API_URL=https://ollama.com/v1/chat/completions
OLLAMA_API_KEY=
OLLAMA_MODEL=gemma4:31b-cloud

LIGHTNING_API_URL=https://lightning.ai/api/v1/chat/completions
LIGHTNING_API_KEY=
LIGHTNING_MODEL=lightning-ai/gemma-4-31B-it

DEEPGRAM_API_KEY=
```

For a separately hosted API, set the frontend build variable:

```bash
VITE_API_BASE_URL=https://your-api.example.com npm run build
```

## Testing WebMCP

1. Open the app in ChatGPT's in-app browser, which supports WebMCP, or use a compatible Chrome build with WebMCP enabled.
2. Enter the app's access password if AI features are enabled, or continue as a guest for manual play.
3. Confirm the command panel reports `WEBMCP READY`.
4. Try commands such as:

   - `Inspect the terrarium.`
   - `Climb to the top platform on the nearest tree.`
   - `Find and catch the nearest prey.`
   - `Return Larry to the ground.`

5. Use **PLAN** to see the proposed tool order before pressing **GO**.

The browser's WebMCP APIs are experimental. If WebMCP is unavailable, the game remains playable manually, but agent commands and planning are disabled.

## Inspect WebMCP tools in Chrome DevTools

Open the deployed app in Chrome, open DevTools with `⌘ Option I` on macOS or `Ctrl Shift I` on Windows/Linux, and select the **Console** tab. Make sure the Console's JavaScript context is the app's page, not an iframe.

Check whether WebMCP is available:

```js
Boolean(document.modelContext?.registerTool)
```

List all tools registered on the page:

```js
await document.modelContext.getTools()
```

List only Larry's tools with their names and schemas:

```js
(await document.modelContext.getTools())
  .filter((tool) => [
    'inspect_game_world',
    'stop_spider',
    'move_spider',
    'jump_spider',
    'climb_tree',
    'hunt_prey',
    'get_to_ground',
  ].includes(tool.name))
  .map(({ name, title, description, inputSchema, annotations }) => ({
    name, title, description, inputSchema, annotations,
  }))
```

Inspect one tool in a readable form:

```js
const tools = await document.modelContext.getTools();
const inspectTool = tools.find(({ name }) => name === 'inspect_game_world');
console.dir(inspectTool);
```

If the browser exposes `executeTool`, run the read-only world inspection tool:

```js
const tools = await document.modelContext.getTools();
const inspectTool = tools.find(({ name }) => name === 'inspect_game_world');
await document.modelContext.executeTool(inspectTool, {});
```

The result should contain Larry's current state and the terrarium contents. Do not call action tools from the Console unless you intend to move the spider or change the game state. For example, `move_spider`, `climb_tree`, and `hunt_prey` execute real actions immediately.

## Deployment

`render.yaml` contains a two-service Render deployment:

- A static Vite frontend.
- A Node/Express API under `server/` for authentication, model proxying, and voice transcription.

Set the secret environment variables in the hosting provider rather than in the repository. Update `FRONTEND_URL` on the API and `VITE_API_BASE_URL` on the frontend when using different domains.

## Challenge submission demo

Submission checklist:

- [ ] Deploy and verify a public live URL in ChatGPT's in-app browser or Chrome with WebMCP enabled.
- [ ] Make the source repository public on GitHub, GitLab, or Bitbucket.
- [x] Include an open-source license (`LICENSE`, MIT).
- [x] Include all source code, assets, and setup instructions.
- [ ] Record a public YouTube demo under 3 minutes with audio.
- [ ] Show manual control, world inspection, agent planning, WebMCP execution, and human-agent collaboration in the demo.
- [ ] Complete the Devpost text description and explain the WebMCP implementation.
- [ ] Add live-app credentials to Devpost if the deployed app requires a password.

A useful demo should show the human-agent experience rather than only the game screen:

1. A player manually moves Larry.
2. The agent calls `inspect_game_world`.
3. The agent chooses a state-appropriate tool such as `climb_tree` or `hunt_prey`.
4. Larry performs the multi-step action in the terrarium.
5. The player changes the goal or says `stop`, demonstrating shared control.

The project can be extended with additional creatures, richer world-state queries, or collaborative agent annotations.

## License

This project is released under the [MIT License](LICENSE).
