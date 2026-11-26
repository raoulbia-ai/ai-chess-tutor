// Reviews the "Not helpful" and "Somewhat helpful" reports sent from the app (feedback/inbox.jsonl).
//   npm run feedback                 list each open report and replay it through the current code
//   npm run feedback -- --done <id> [note]   move a report to feedback/done.jsonl once it is dealt with
// Hints, turn comments and the game review come from the local engine, so replaying them is free. Answers written
// by the model are shown as reported, without a new model call.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lessonFor } from '../lib/lesson.mjs';
import { stopEngine } from '../lib/engine.mjs';
import { stopClassical } from '../lib/positional.mjs';

const dir = fileURLToPath(new URL('../feedback/', import.meta.url));
const inbox = dir + 'inbox.jsonl', done = dir + 'done.jsonl';
const read = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const reports = read(inbox);

const args = process.argv.slice(2);
if (args[0] === '--done') {
  const [, id, ...note] = args;
  const found = reports.filter(r => r.id === id || r.id.startsWith(id));
  if (found.length !== 1) { console.error(found.length ? `"${id}" matches ${found.length} reports.` : `No open report "${id}".`); process.exit(1); }
  appendFileSync(done, JSON.stringify({ ...found[0], resolvedAt: new Date().toISOString(), note: note.join(' ') }) + '\n');
  writeFileSync(inbox, reports.filter(r => r !== found[0]).map(r => JSON.stringify(r) + '\n').join(''));
  console.log(`Moved ${found[0].id} to done.`);
  process.exit(0);
}

if (!reports.length) { console.log('No open feedback reports.'); process.exit(0); }
const indent = text => text.split('\n').map(line => `    ${line}`).join('\n');
const numbered = moves => moves.map((m, i) => i % 2 ? m : `${i / 2 + 1}.${m}`).join(' ') || '(start)';
try {
  for (const r of reports) {
    const rating = r.rating === 'somewhat' ? 'SOMEWHAT HELPFUL (understood, could teach more)' : 'NOT HELPFUL';
    console.log(`\n=== ${r.id.slice(0, 8)}  ${rating}  ${r.at}  ${r.mode ?? 'unknown'}${r.level ? ` level ${r.level}` : ''}${r.automatic ? ' (automatic)' : ''}`);
    console.log(`  Moves: ${numbered(r.moves)}`);
    console.log(`  FEN:   ${r.fen}`);
    if (r.comment) console.log(`  Comment: ${r.comment}`);
    console.log(`  Reported (${r.title}):\n${indent([r.explanation, r.question].filter(Boolean).join('\n'))}`);
    if (!['hint', 'turn'].includes(r.mode)) { console.log('  (Written by the model or not replayable for free: not rerun.)'); continue; }
    try {
      const now = await lessonFor({ mode: r.mode, moves: r.moves, level: r.level ?? 1 }, undefined, { allLevels: true });
      const text = r.mode === 'hint' ? now.levels.slice(0, r.level ?? 1).join('\n\n') : now.lesson.explanation;
      console.log(text.trim() === r.explanation.trim() ? '  Now: unchanged.' : `  Now (${now.lesson.title}):\n${indent(text)}`);
      if (r.mode === 'hint' && now.levels.length > (r.level ?? 1)) console.log(`  Later levels now:\n${indent(now.levels.slice(r.level ?? 1).join('\n\n'))}`);
    } catch (error) { console.log(`  Replay failed: ${error.message}`); }
  }
} finally { stopEngine(); stopClassical(); }
