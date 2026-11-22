// Runs the tutor over the evaluation suite and records every lesson, with timing, model calls and tokens.
//
//   node eval/run.mjs --name baseline --modes hint,turn            # offline: the model is stubbed, no API cost
//   node eval/run.mjs --name baseline-live --modes hint,turn --live  # real model calls, using .env
//
// Options: --suite a.json,b.json (default eval/suite.json plus eval/suite.local.json when present),
// --limit N, --only id1,id2. Output: eval/runs/<name>.jsonl, one lesson per line.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lessonFor } from '../lib/lesson.mjs';
import { analyse, stopEngine } from '../lib/engine.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const live = args.includes('--live');
const name = option('name', live ? 'live' : 'offline');
const modes = option('modes', 'hint,turn').split(',');
const suiteFiles = option('suite', ['eval/suite.json', 'eval/suite.local.json'].filter(file => existsSync(root + file)).join(',')).split(',');
const only = option('only', '')?.split(',').filter(Boolean);
const limit = Number(option('limit', Infinity));

if (live) {
  try { process.loadEnvFile(root + '.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
} else {
  process.env.OPENAI_API_KEY_CHESS_TUTOR = 'offline';
}

// Every model call goes through fetch, so wrapping it records calls and tokens; offline it also answers them.
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const started = Date.now();
  if (!live) {
    calls.push({ model: body.model, ms: 0, input: 0, output: 0 });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: stubReply(body) } }] }) };
  }
  const response = await realFetch(url, init);
  const copy = response.clone();
  try {
    const usage = (await copy.json()).usage ?? {};
    calls.push({ model: body.model, ms: Date.now() - started, input: usage.prompt_tokens ?? 0, cached: usage.prompt_tokens_details?.cached_tokens ?? 0, output: usage.completion_tokens ?? 0 });
  } catch { calls.push({ model: body.model, ms: Date.now() - started, input: 0, output: 0 }); }
  return response;
};

// Offline, the writer picks the first allowed fact and writes no free text, and the fact-check approves nothing new.
// This measures what the deterministic code produces on its own.
function stubReply(body) {
  if (body.response_format?.type === 'json_schema') {
    const properties = body.response_format.json_schema.schema.properties.steps.properties;
    const steps = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value.enum ? value.enum[0] : '']));
    return JSON.stringify({ title: 'Lesson', explanation: '', question: '', steps });
  }
  const input = JSON.parse(body.messages[1].content);
  return JSON.stringify(input.prose ? { approved: [], claims: [] } : {});
}

// Engine results are cached per run, as the server caches them.
const cache = new Map();
const cachedAnalysis = (fen, rootMove) => {
  const key = `${fen}:${rootMove ?? ''}`;
  if (!cache.has(key)) cache.set(key, analyse(fen, { rootMove }));
  return cache.get(key);
};

const items = suiteFiles.flatMap(file => JSON.parse(readFileSync(root + file, 'utf8')))
  .filter(item => !only.length || only.includes(item.id)).slice(0, limit);
mkdirSync(root + 'eval/runs', { recursive: true });
const out = `${root}eval/runs/${name}.jsonl`;
writeFileSync(out, '');
let done = 0;
for (const item of items) {
  for (const mode of modes) {
    // Turn commentary needs the White move and Black reply that led here, which puzzles do not have.
    if (mode === 'turn' && !item.moves) continue;
    const data = { mode, moves: item.moves ?? [], automatic: mode === 'turn', focus: 'Notice threats & protect pieces' };
    calls = [];
    const started = Date.now();
    let record;
    try {
      const { lesson, insights } = await lessonFor(data, cachedAnalysis, item.moves ? {} : { startFen: item.fen });
      record = { id: item.id, mode, title: lesson.title, text: lesson.explanation, steps: lesson.steps, ...(insights && { insights }) };
    } catch (error) {
      record = { id: item.id, mode, error: error.message };
    }
    record.ms = Date.now() - started;
    record.calls = calls;
    appendFileSync(out, JSON.stringify(record) + '\n');
  }
  if (++done % 20 === 0) console.log(`${done}/${items.length}`);
}
stopEngine();
console.log(`Wrote ${out}`);
