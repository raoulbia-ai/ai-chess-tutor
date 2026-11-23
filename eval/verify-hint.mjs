// Re-checks the claims in levelled hints with a deeper search than the tutor uses (depth 18).
//
//   node eval/verify-hint.mjs <run name>      # a run made by eval/run.mjs --modes hint
//
// For each hint it reports claims the deeper search does not support:
//   move         the recommended move must be within half a pawn of the deep best move (or keep a forced mate)
//   alternatives moves called "about as good" must be within half a pawn of the recommended move
//   win          the recommended move's deep line must still win at least 1 pawn (1.5 when 2 or more was claimed)
//   threat       Black's named threat, searched as Black's free move, must win material and cost White 0.8 pawns
//   own threat   after the recommended move, the named White threat must win material
//   undefended   a piece called undefended must have no legal recapture
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { analyse, scoreValue, stopEngine } from '../lib/engine.mjs';
import { captureGain, lineMotifs, withTurn } from '../lib/analysis.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = process.argv[2];
const suite = new Map(['eval/suite.json', 'eval/suite.local.json'].filter(file => existsSync(root + file))
  .flatMap(file => JSON.parse(readFileSync(root + file, 'utf8'))).map(item => [item.id, item]));
const records = readFileSync(`${root}eval/runs/${run}.jsonl`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  .filter(record => record.mode === 'hint' && record.levels);
const deep = (fen, rootMove) => analyse(fen, { depth: 18, plies: 8, rootMove });
const cp = result => scoreValue(result.variations[0].score);
const uci = (fen, san) => { const move = new Chess(fen).move(san); return move.from + move.to + (move.promotion ?? ''); };
const isMate = result => result.variations[0].score.type === 'mate' && result.variations[0].score.value > 0;

let flagged = 0;
const kinds = {};
for (const record of records) {
  const item = suite.get(record.id);
  if (!item) continue;
  const fen = item.fen;
  const [insight] = record.insights ?? [];
  const kind = insight?.kind ?? 'none';
  kinds[kind] = (kinds[kind] ?? 0) + 1;
  const problems = [];
  const best = await deep(fen);
  const move = insight?.evidence?.best;
  let moveLine = null;
  if (move) {
    moveLine = await deep(fen, uci(fen, move));
    // Compare like with like: the deep best move searched the same way as the recommended one.
    const bestSan = best.variations[0].steps[0].san;
    if (bestSan !== move) {
      const bestLine = await deep(fen, uci(fen, bestSan));
      if (isMate(bestLine) ? !isMate(moveLine) : cp(bestLine) - cp(moveLine) > 50) problems.push(`${move} is ${cp(bestLine) - cp(moveLine)} worse than ${bestSan}`);
    }
    const alternatives = record.levels[2].match(/ ([A-Za-z0-9+#=-]+(?:, [A-Za-z0-9+#=-]+)*(?: and [A-Za-z0-9+#=-]+)?) (?:is|are) about as good\./)?.[1].split(/, | and /) ?? [];
    for (const san of alternatives) {
      const line = await deep(fen, uci(fen, san));
      if (cp(moveLine) - cp(line) > 50) problems.push(`"about as good" ${san} is ${cp(moveLine) - cp(line)} worse`);
    }
  }
  if (kind === 'win' && moveLine) {
    const gain = lineMotifs(fen, moveLine.variations[0].steps.map(step => step.san), { window: 6 }).settledGain;
    const claimed = insight.evidence.gain;
    if (gain < (claimed >= 2 ? 1.5 : 1)) problems.push(`win not confirmed: ${move} nets ${gain} at depth 18 (claimed ${claimed})`);
  }
  if (kind === 'mate' && moveLine && !isMate(moveLine)) problems.push(`mate not confirmed after ${move}`);
  const threatMove = kind === 'threat' || kind === 'win' ? insight.evidence.threat : null;
  if (threatMove && /Black threatens /.test(record.levels[0]) && !/Black threatens mate/.test(record.levels[0])) {
    const passed = withTurn(fen, 'b');
    const line = await deep(passed, uci(passed, threatMove));
    const gain = lineMotifs(passed, line.variations[0].steps.map(step => step.san)).settledGain;
    if (gain < 1 || cp(best) + cp(line) < 80) problems.push(`threat ${threatMove} not confirmed (gain ${gain}, costs ${cp(best) + cp(line)})`);
  }
  if (kind === 'own threat' && move) {
    const after = new Chess(fen); after.move(move);
    const passed = withTurn(after.fen(), 'w');
    const named = insight.evidence.threat;
    try {
      const line = await deep(passed, uci(passed, named));
      const gain = isMate(line) ? Infinity : lineMotifs(passed, line.variations[0].steps.map(step => step.san)).settledGain;
      if (gain < 1) problems.push(`own threat ${named} after ${move} not confirmed (gain ${gain})`);
    } catch { problems.push(`own threat ${named} is not legal after ${move}`); }
  }
  const text = record.levels.join(' ');
  for (const [, piece, square] of text.matchAll(/Black’s (\w+) on ([a-h][1-8]) is undefended|undefended (\w+) on ([a-h][1-8])/g).map(m => [m[0], m[1] ?? m[3], m[2] ?? m[4]])) {
    if (captureGain(fen, square, 'w') < { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 }[piece]) problems.push(`${piece} on ${square} is defended`);
  }
  if (problems.length) { flagged++; console.log(`${record.id} [${kind}]: ${problems.join('; ')}\n    ${record.levels.join('\n    ')}`); }
}
stopEngine();
console.log(`\n${records.length} hints (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')}); ${flagged} with an unsupported claim.`);
