import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';

const noop = () => {};

const PORT = Number(process.env.PORT || 3000);
const MAX_JSON = '256kb';
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const requestCounts = new Map();

export function createApp({ fetchImpl = globalThis.fetch } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',').map((origin) => origin.trim()).filter(Boolean);

  app.use(cors({ origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  }}));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use((req, res, next) => {
    const now = Date.now();
    for (const [key, value] of requestCounts) if (value.windowStarted + RATE_WINDOW_MS < now) requestCounts.delete(key);
    const key = req.ip || 'unknown';
    const entry = requestCounts.get(key) || { windowStarted: now, count: 0 };
    entry.count += 1;
    requestCounts.set(key, entry);
    if (entry.count > RATE_LIMIT) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.post('/api/auth/check', express.json({ limit: '4kb' }), (req, res) => {
    const configured = String(process.env.SPIDER_PASSWORD || '');
    const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!configured) return res.status(503).json({ ok: false, error: 'Access password is not configured.' });
    return res.json({ ok: supplied.length > 0 && supplied === configured });
  });
  app.post('/api/lightning/chat', express.json({ limit: MAX_JSON }), providerHandler({
    fetchImpl,
    url: () => process.env.LIGHTNING_API_URL || 'https://lightning.ai/api/v1/chat/completions',
    key: () => process.env.LIGHTNING_API_KEY,
    model: () => process.env.LIGHTNING_MODEL || 'lightning-ai/gemma-4-31B-it',
    label: 'Lightning AI',
  }));
  app.post('/api/ollama/chat', express.json({ limit: MAX_JSON }), providerHandler({
    fetchImpl,
    url: () => process.env.OLLAMA_API_URL || 'https://ollama.com/v1/chat/completions',
    key: () => process.env.OLLAMA_API_KEY,
    model: () => process.env.OLLAMA_MODEL || 'gemma4:31b-cloud',
    label: 'Ollama',
  }));
  // This endpoint receives a raw MediaRecorder Blob. Browsers may label WebM
  // audio as `audio/webm;codecs=opus`, `video/webm`, or even
  // `application/octet-stream`; parse the dedicated route as raw bytes rather
  // than dropping an otherwise valid recording due to its MIME label.
  app.post('/api/deepgram/transcribe', express.raw({ type: '*/*', limit: MAX_AUDIO_BYTES }), async (req, res) => {
    if (!process.env.DEEPGRAM_API_KEY) return res.status(503).json({ error: 'Voice transcription is not configured.' });
    if (!req.body?.length) return res.status(400).json({ error: 'Audio is required.' });
    try {
      const upstream = await fetchImpl('https://api.deepgram.com/v1/listen?model=nova-3&language=en-US&smart_format=true', {
        method: 'POST', headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': req.headers['content-type'] || 'audio/webm' }, body: req.body,
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Deepgram transcription failed.' });
      return res.json({ transcript: payload.results?.channels?.[0]?.alternatives?.[0]?.transcript || '' });
    } catch (error) {
      noop('Deepgram API error:', error);
      return res.status(502).json({ error: 'Transcription provider request failed.' });
    }
  });
  app.use((error, req, res, next) => {
    if (error?.message === 'Origin not allowed') return res.status(403).json({ error: error.message });
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON request.' });
    return next(error);
  });
  return app;
}

function providerHandler({ fetchImpl, url, key, model, label, extraHeaders = () => ({}) }) {
  return async (req, res) => {
    const validation = validateChatRequest(req.body);
    if (validation) return res.status(400).json({ error: validation });
    if (!key()) return res.status(503).json({ error: `${label} is not configured.` });
    const upstreamPayload = {
      model: model(),
      messages: req.body.messages,
      tools: req.body.tools,
      tool_choice: req.body.tool_choice === 'required' ? 'required' : 'auto',
      max_tokens: 500,
      temperature: 0.3,
    };
    try {
      const upstream = await fetchImpl(url(), {
        method: 'POST', headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key()}`,
          ...extraHeaders(),
        },
        body: JSON.stringify(upstreamPayload), signal: AbortSignal.timeout(30_000),
      });
      const body = await upstream.text();
      return res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(body);
    } catch (error) {
      noop(`${label} API error:`, error);
      return res.status(502).json({ error: 'AI provider request failed.' });
    }
  };
}

function validateChatRequest(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 12) return 'messages must contain 1–12 entries.';
  if (body.tools && (!Array.isArray(body.tools) || body.tools.length > 16)) return 'tools must contain at most 16 entries.';
  if (JSON.stringify(body.messages).length > 24_000 || JSON.stringify(body.tools || []).length > 32_000) return 'Request content is too large.';
  for (const message of body.messages) if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)) return 'Invalid message role.';
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createApp().listen(PORT, '0.0.0.0', () => noop(`Spider API listening on port ${PORT}`));
}
