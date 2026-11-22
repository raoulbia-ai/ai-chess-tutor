// Re-checks the claims in analysis-built turn comments with a deeper search than the tutor uses (depth 18), so
// false or overstated claims can be found without a person or a model reading every comment.
//
//   node eval/verify-turn.mjs <run name>      # a run made by eval/run.mjs --modes turn
//
// For each comment it reports claims the deeper search does not support:
//   threat       the named move, searched as Black's free move, must win material and cost White 1 pawn
//   opportunity  Black's last move must lose at least 1.2 pawns, and a named piece must be won in the best line
//   your mistake your move must lose at least 1.2 pawns, and the named better move must be at least 1 pawn better
//   recapture    the recapture must be within half a pawn of the best move
//   undefended   the named piece must have no legal recapture
// and lists quiet comments ("plan") given while a direct threat exists (an omission rather than a false claim).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { analyse, scoreValue, stopEngine } from '../lib/engine.mjs';
import { captureGain, lineMotifs, threatsBy, withTurn } from '../lib/analysis.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = process.argv[2];
const suite = new Map(['eval/suite.json', 'eval/suite.local.json'].filter(file => existsSync(root + file))
  .flatMap(file => JSON.parse(readFileSync(root + file, 'utf8'))).map(item => [item.id, item]));
const records = readFileSync(`${root}eval/runs/${run}.jsonl`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  .filter(record => record.mode === 'turn' && record.text);
const deep = (fen, rootMove) => analyse(fen, { depth: 18, multipv: rootMove ? 1 : 2, plies: 8, rootMove });
const cp = result => scoreValue(result.variations[0].score);
const uci = (fen, san) => { const move = new Chess(fen).move(san); return move.from + move.to + (move.promotion ?? ''); };

let checked = 0, flagged = 0, omissions = 0;
for (const record of records) {
  const item = suite.get(record.id);
  if (!item?.moves) continue;
  const game = new Chess(); for (const san of item.moves) game.move(san);
  const [white, black] = game.history({ verbose: true }).slice(-2);
  const fen = game.fen();
  const problems = [];
  const now = await deep(fen);
  const nowCp = cp(now);
  for (const insight of record.insights ?? []) {
    checked++;
    if (insight.kind === 'threat' && !insight.evidence?.mate) {
      const passed = withTurn(fen, 'b');
      for (const named of [insight.evidence, ...(insight.evidence.others ?? []).slice(0, 1)]) {
        const line = await deep(passed, uci(passed, named.move));
        const gain = lineMotifs(passed, line.variations[0].steps.map(step => step.san)).settledGain;
        if (gain < 1 || nowCp + cp(line) < 80) problems.push(`threat ${named.move} not confirmed (gain ${gain}, costs ${nowCp + cp(line)})`);
      }
    }
    if (insight.kind === 'opportunity' && !insight.evidence?.mate) {
      const before = await deep(black.before);
      const loss = cp(before) + nowCp;
      if (loss < 120) problems.push(`Black's ${black.san} loses only ${loss}`);
      const target = record.text.match(/win Black’s (\w+) on ([a-h][1-8])/);
      if (target) {
        const line = now.variations[0].steps.slice(0, 6);
        if (!line.some(step => step.color === 'w' && step.to === target[2] && step.captured)) problems.push(`best line does not win the ${target[1]} on ${target[2]}`);
      }
    }
    if (insight.kind === 'your mistake') {
      const before = await deep(white.before);
      const after = await deep(white.after);
      const loss = cp(before) + cp(after);
      if (loss < 120) problems.push(`your ${white.san} loses only ${loss}`);
      const better = record.text.match(/(?:: |\. )([A-Za-z0-9+#=-]+) (?:was stronger|would have|was checkmate|started a forced mate)/)?.[1];
      if (better) {
        const line = await deep(white.before, uci(white.before, better));
        if (cp(line) + cp(after) < 100) problems.push(`${better} is only ${cp(line) + cp(after)} better than ${white.san}`);
      }
    }
    if (insight.kind === 'recapture') {
      const san = record.text.match(/recapture with ([A-Za-z0-9+#=-]+)/)?.[1];
      if (san) { const line = await deep(fen, uci(fen, san)); if (nowCp - cp(line) > 50) problems.push(`recapture ${san} is ${nowCp - cp(line)} worse than the best move`); }
    }
    if (insight.kind === 'plan' && item.strictThreat) { omissions++; problems.push(`plan given while Black threatens ${item.strictThreat.move}`); }
  }
  for (const [, piece, square] of record.text.matchAll(/Black’s (\w+) on ([a-h][1-8]) is undefended/g)) {
    if (captureGain(fen, square, 'w') < { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 }[piece]) problems.push(`${piece} on ${square} is defended`);
  }
  if (problems.some(problem => !problem.startsWith('plan given'))) flagged++;
  if (problems.length) console.log(`${record.id}: ${problems.join('; ')}\n    ${record.text}`);
}
stopEngine();
console.log(`\n${records.length} comments, ${checked} claims checked; ${flagged} comments with an unsupported claim; ${omissions} quiet comments while a threat existed.`);
