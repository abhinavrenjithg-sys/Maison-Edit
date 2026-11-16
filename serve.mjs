// Maison Edit server: serves the web app and the AI try-on endpoint.
//   node serve.mjs   →   http://localhost:5173
// The Gemini key is read from the environment or from a .env file next to this script.
// It never goes to the browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryOnFree, friendlyFreeError } from './ai-free.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, 'web');

// minimal .env loader (KEY=value lines)
const envFile = join(HERE, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const PORT = +process.env.PORT || 5173;
const KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
// "free" = OOTDiffusion on Hugging Face (top + skirt, optional free HF_TOKEN); "gemini" = paid, whole outfit
const PROVIDER = (process.env.AI_PROVIDER || 'free').toLowerCase();
const MAX_BODY = 20 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const CORS = {
  // the Android app runs the page from its own origin and calls this server
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Photos are too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function splitDataUrl(u) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(u || '');
  return m ? { mime_type: m[1], data: m[2] } : null;
}

const CAT = { t: 'top', k: 'skirt', s: 'shoes', g: 'bag' };
function prompt(items, extra) {
  const list = items.map((it, i) => `Image ${i + 2}: the ${CAT[it.c] || 'item'} — ${it.name}.`).join('\n');
  return `You are a virtual fitting room for a fashion store.
Image 1 is a photo of the customer.
${list}

Create one realistic, high quality full-body photo of the SAME person from image 1 wearing exactly these ${items.length} products, replacing the matching clothes they have on.
Keep the person's face, identity, skin tone, hair, body shape and pose unchanged.
Copy each product faithfully: same colour, material, pattern, length and details as its product photo. Clothes must fit naturally with realistic folds, shadows and lighting.
Show the whole body from head to feet, in a clean, softly lit studio with a light warm grey background.
${extra ? 'Extra request: ' + String(extra).slice(0, 300) : ''}
Return only the image.`;
}

async function tryOnWithFree(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: e.message || 'Bad request' }); }
  if (!splitDataUrl(body.person)) return sendJSON(res, 400, { error: 'Add a photo of yourself first.' });
  const items = (Array.isArray(body.items) ? body.items : []).filter(it => splitDataUrl(it.image));
  try {
    const r = await tryOnFree({ person: body.person, items });
    sendJSON(res, 200, { ...r, provider: 'free' });
  } catch (e) {
    console.error('Free try-on failed:', e.message);
    sendJSON(res, 502, { error: friendlyFreeError(e) });
  }
}

async function tryOn(req, res) {
  if (PROVIDER !== 'gemini') return tryOnWithFree(req, res);
  if (!KEY) return sendJSON(res, 503, { error: 'The AI try-on is not set up: add GEMINI_API_KEY to the .env file and restart the server.' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJSON(res, 400, { error: e.message || 'Bad request' }); }
  const person = splitDataUrl(body.person);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 4)
    .map(it => ({ ...it, img: splitDataUrl(it.image) })).filter(it => it.img);
  if (!person) return sendJSON(res, 400, { error: 'Add a photo of yourself first.' });
  if (!items.length) return sendJSON(res, 400, { error: 'No products were sent.' });

  const parts = [{ text: prompt(items, body.extra) }, { inline_data: person }, ...items.map(it => ({ inline_data: it.img }))];
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
      signal: AbortSignal.timeout(120000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Gemini error', r.status, j.error && j.error.message);
      const text = (j.error && j.error.message) || '';
      const msg = r.status === 429 && /limit: 0\b/.test(text) ? 'Image generation is not included in the free Gemini plan. Turn on billing for this API key in Google AI Studio, then try again.'
        : r.status === 429 ? 'The AI is busy or the usage limit was reached. Try again in a minute.'
        : r.status === 400 ? 'The AI could not use these photos. Try a clearer full-body photo.'
        : r.status === 401 || r.status === 403 ? 'The Gemini API key was refused. Check the key in .env.'
        : 'The AI service had a problem. Try again.';
      return sendJSON(res, 502, { error: msg });
    }
    const out = (j.candidates || []).flatMap(c => (c.content && c.content.parts) || []);
    const img = out.find(p => p.inlineData || p.inline_data);
    if (!img) {
      const why = (j.candidates && j.candidates[0] && j.candidates[0].finishReason) || (j.promptFeedback && j.promptFeedback.blockReason);
      return sendJSON(res, 422, { error: why && /SAFETY|BLOCK|PROHIBITED/i.test(why) ? 'The AI declined this photo. Try a different photo.' : 'The AI did not return an image. Try again.' });
    }
    const d = img.inlineData || img.inline_data;
    sendJSON(res, 200, { image: `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data}`, model: MODEL, provider: 'gemini', applied: items.map(i => i.c), skipped: [] });
  } catch (e) {
    console.error('Try-on failed', e.message);
    sendJSON(res, 504, { error: e.name === 'TimeoutError' ? 'The AI took too long. Try again.' : 'Could not reach the AI service.' });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (url.pathname === '/api/status') return sendJSON(res, 200, { provider: PROVIDER, ai: PROVIDER === 'gemini' ? !!KEY : true, hfToken: !!process.env.HF_TOKEN, model: PROVIDER === 'gemini' ? MODEL : 'OOTDiffusion' });
    if (url.pathname === '/api/tryon' && req.method === 'POST') return tryOn(req, res);
    return sendJSON(res, 404, { error: 'Not found' });
  }
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`Maison Edit running at http://localhost:${PORT}  (AI try-on: ${PROVIDER === 'gemini'
  ? (KEY ? 'Gemini, ' + MODEL : 'Gemini, but no GEMINI_API_KEY')
  : 'free OOTDiffusion' + (process.env.HF_TOKEN ? ' with HF_TOKEN' : ' without HF_TOKEN (small daily limit)')})`));
