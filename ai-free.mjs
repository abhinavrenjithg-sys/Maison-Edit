// Free AI try-on through OOTDiffusion on Hugging Face (https://huggingface.co/spaces/levihsu/OOTDiffusion).
// It dresses the person in the top, then the skirt. Shoes and bags are not supported by the model.
// Works without an account; an optional free HF_TOKEN gives a bigger daily GPU allowance.

const SPACE = process.env.HF_TRYON_SPACE_URL || 'https://levihsu-ootdiffusion.hf.space';
const API = SPACE + '/gradio_api';

function headers(token) { return token ? { Authorization: `Bearer ${token}` } : {}; }

function dataUrlToBlob(u) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(u || '');
  if (!m) throw new Error('Bad image');
  return new Blob([Buffer.from(m[2], 'base64')], { type: m[1] });
}

async function upload(blob, name, token) {
  const fd = new FormData();
  fd.append('files', blob, name);
  const r = await fetch(API + '/upload', { method: 'POST', body: fd, headers: headers(token), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('upload ' + r.status);
  const [path] = await r.json();
  return { path, orig_name: name, meta: { _type: 'gradio.FileData' } };
}

/** Runs one Gradio call and waits for its result over the event stream. */
async function call(endpoint, data, token) {
  const r = await fetch(`${API}/call/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(token) },
    body: JSON.stringify({ data }), signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error('call ' + r.status);
  const { event_id } = await r.json();
  const s = await fetch(`${API}/call/${endpoint}/${event_id}`, { headers: headers(token), signal: AbortSignal.timeout(240000) });
  const text = await s.text();
  // the stream ends with "event: complete" (data = outputs) or "event: error" (data = message)
  const blocks = text.split(/\n\n/).map(b => ({
    event: (/^event: (.*)$/m.exec(b) || [])[1],
    data: (/^data: (.*)$/m.exec(b) || [])[1]
  })).filter(b => b.event);
  const last = blocks[blocks.length - 1] || {};
  if (last.event === 'complete') return JSON.parse(last.data);
  let msg = '';
  try { const d = JSON.parse(last.data); msg = (d && (d.error || d.message || d.title)) || (typeof d === 'string' ? d : ''); } catch { msg = last.data || ''; }
  const e = new Error(typeof msg === 'string' && msg ? msg : 'The free AI service failed');
  e.gradio = true;
  throw e;
}

async function fetchResultImage(out, token) {
  const first = Array.isArray(out) && out[0];
  const item = Array.isArray(first) ? first[0] : first;
  const file = item && (item.image || item);
  const url = file && (file.url || (file.path && `${API}/file=${file.path}`));
  if (!url) throw new Error('No image came back');
  const r = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('download ' + r.status);
  const type = r.headers.get('content-type') || 'image/png';
  return { blob: new Blob([await r.arrayBuffer()], { type }), url };
}

/**
 * person: data URL of a full-body photo; items: [{ c: 't'|'k'|'s'|'g', image: data URL }]
 * Returns { image: data URL, applied: ['t','k'], skipped: ['s','g'] }.
 */
export async function tryOnFree({ person, items }, { token = process.env.HF_TOKEN, onStep } = {}) {
  const CAT = { t: 'Upper-body', k: 'Lower-body' };
  const usable = items.filter(it => CAT[it.c]).sort((a, b) => (a.c === 't' ? -1 : 1) - (b.c === 't' ? -1 : 1));
  if (!usable.length) throw new Error('The free AI can change tops and skirts only.');
  let current = dataUrlToBlob(person), name = 'person.jpg';
  const applied = [];
  for (const it of usable) {
    onStep && onStep(it.c);
    const [vton, garm] = await Promise.all([upload(current, name, token), upload(dataUrlToBlob(it.image), `garment-${it.c}.jpg`, token)]);
    const out = await call('process_dc', [vton, garm, CAT[it.c], 1, 20, 2, -1], token);
    current = (await fetchResultImage(out, token)).blob; name = `step-${it.c}.png`;
    applied.push(it.c);
  }
  const buf = Buffer.from(await current.arrayBuffer());
  return {
    image: `data:${current.type || 'image/png'};base64,${buf.toString('base64')}`,
    applied,
    skipped: items.map(i => i.c).filter(c => !applied.includes(c))
  };
}

/** Turns service errors into plain messages for shoppers. */
export function friendlyFreeError(e) {
  const m = String(e && e.message || '');
  if (/quota|exceeded|ZeroGPU|GPU duration|limit/i.test(m)) return 'The free AI has used up its GPU time for now. Try again later, or add a free Hugging Face token (HF_TOKEN) to the server for more.';
  if (/queue|too many|429/i.test(m)) return 'The free AI is busy right now. Try again in a minute.';
  if (/timeout|aborted/i.test(m)) return 'The free AI took too long. Try again.';
  if (/sleep|503|502|504|call 5|upload 5/i.test(m)) return 'The free AI service is waking up or unavailable. Try again in a minute.';
  return 'The free AI could not make the image' + (m && e.gradio ? ': ' + m : '. Try again.');
}
