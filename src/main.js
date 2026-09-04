import Phaser from 'phaser';
import './style.css';
import { GameScene } from './game/GameScene.js';
import { apiUrl } from './game/apiClient.js';

const app = document.getElementById('app');
const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(globalThis.location?.hostname);
app.classList.add('spider-locked');
const startScreen = document.createElement('section');
startScreen.className = 'spider-start-screen';
startScreen.innerHTML = `
  <div class="spider-start-card">
    <h1>COMMAND LARRY THE SPIDER</h1>
    <p>Larry is a curious eight-legged explorer. Guide him through the terrarium, climb trees, reach platforms, and hunt tiny prey.</p>
    <p>Type a command and press <b>GO</b>, or use <b>PLAN</b> to let an LLM choose the WebMCP tools in order. You can also run tools directly from the Manual Tool Console.</p>
    <p><b>AI model:</b> Ollama Cloud uses <code>gemma4:31b-cloud</code>. Lightning AI is available as an alternative.</p>
    <p><b>Voice commands:</b> The <b>VOICE</b> button records your microphone input in the browser. The recording is sent to the server, where Deepgram transcribes it using Nova-3; the transcript is then submitted as a normal Larry command and can be executed or planned.</p>
    <p><b>WebMCP tools</b> are safe game actions exposed to the model: move Larry, jump, climb trees, hunt prey, stop, and return to the ground. The game’s purpose is to experiment with tool-using AI while helping Larry explore his tiny habitat.</p>
    <p><b>${isLocalhost ? 'LOCAL DEVELOPMENT MODE.' : 'AI access requires the password.'}</b> ${isLocalhost ? 'Password protection is disabled on localhost.' : 'Without it, you can play manually, but the AI command, planning, and voice tools are unavailable.'}</p>
      <form class="spider-unlock-form">
      <label for="spider-password">ACCESS PASSWORD</label>
      <div><input id="spider-password" type="password" autocomplete="current-password" required><button type="submit">ENTER</button></div>
      <output aria-live="polite"></output>
    </form>
    <button type="button" class="spider-guest-button">CONTINUE WITHOUT PASSWORD</button>
  </div>`;
app.append(startScreen);
startScreen.querySelector('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const output = form.querySelector('output');
  const password = form.querySelector('input').value;
  output.textContent = 'CHECKING…';
  try {
    const response = await fetch(apiUrl('/api/auth/check'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'Incorrect password.');
    app.classList.remove('spider-locked');
    app.classList.remove('spider-guest');
    app.classList.add('spider-authenticated');
    window.dispatchEvent(new Event('spider-access-mode-change'));
    startScreen.remove();
  } catch (error) {
    output.textContent = error.message;
  }
});
startScreen.querySelector('.spider-guest-button').addEventListener('click', () => {
  app.classList.remove('spider-locked');
  app.classList.add('spider-guest');
  window.dispatchEvent(new Event('spider-access-mode-change'));
  startScreen.remove();
});

if (isLocalhost) {
  app.classList.remove('spider-locked');
  app.classList.remove('spider-guest');
  app.classList.add('spider-authenticated');
  window.dispatchEvent(new Event('spider-access-mode-change'));
  startScreen.remove();
}

const config = {
  type: Phaser.AUTO,
  parent: 'app',

  // A deliberately small logical resolution gives the whole game a crisp,
  // pixel-art look when Phaser scales the canvas up to the browser window.
  width: 768,
  height: 432,
  backgroundColor: '#bfd3b5',
  pixelArt: true,
  antialias: false,
  roundPixels: true,
  render: {
    pixelArt: true,
    antialias: false,
    roundPixels: true,
  },
  physics: {
    default: 'matter',
    matter: {
      gravity: { x: 0, y: 0 },
      enableSleeping: false,
      debug: false,
    },
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [GameScene],
};

new Phaser.Game(config);
