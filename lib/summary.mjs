// End-of-game review: a quick engine pass over every White move, the costliest ones with what was missed, and the
// habit that would have prevented them. No model call.
import { Chess } from 'chess.js';
import { analyse, scoreValue } from './engine.mjs';
import { consequence, lineWithBoards } from './coach.mjs';
import { positionalPoint } from './positional.mjs';

// Scores beyond about six pawns all mean "winning": a slower win is not a mistake worth reviewing.
const capped = cp => Math.max(-600, Math.min(600, cp));
const at = move => `${move.before.split(' ')[5]}.${move.san}`;

export async function gameSummary(moves, { startFen } = {}) {
  const game = new Chess(startFen);
  for (const san of moves) game.move(san);
  const played = game.history({ verbose: true }).filter(move => move.color === 'w');
  const rows = [];
  for (const move of played) {
    const before = (await analyse(move.before, { depth: 12, multipv: 1, plies: 8 })).variations[0];
    const after = new Chess(move.after);
    if (!before) continue;
    // After a mate or a draw by the rules there is nothing to search: the move kept what it had.
    const reply = after.isGameOver() ? null : (await analyse(move.after, { depth: 12, multipv: 1, plies: 8 })).variations[0];
    const bestCp = scoreValue(before.score);
    const playedCp = after.isCheckmate() ? 100000 : reply ? -scoreValue(reply.score) : 0;
    const mateMissed = before.score.type === 'mate' && before.score.value > 0 && before.score.value <= 3 && !(reply?.score.type === 'mate' && reply.score.value < 0) && !after.isCheckmate();
    const loss = capped(bestCp) - capped(playedCp);
    rows.push({ move, before, reply, bestCp, playedCp, loss, mateMissed });
  }
  const accurate = rows.filter(row => row.loss < 50 && !row.mateMissed).length;
  const mistakes = rows.filter(row => row.mateMissed || row.loss >= 150).sort((a, b) => (b.mateMissed ? 1000 : b.loss) - (a.mateMissed ? 1000 : a.loss)).slice(0, 3);
  const kinds = [];
  const lines = [];
  for (const row of mistakes) {
    const { move, before, reply } = row;
    const best = before.steps[0].san;
    const pawns = row.mateMissed ? '' : ` (cost about ${(row.loss / 100).toFixed(1)} pawns)`;
    if (row.mateMissed) {
      kinds.push('mate');
      lines.push(`${at(move)}: ${best} started a forced mate in ${before.score.value}.`);
      continue;
    }
    const bestLine = lineWithBoards(move.before, before.steps.map(step => step.san), 6);
    const replyLine = reply && lineWithBoards(move.after, reply.steps.map(step => step.san), 6);
    if (replyLine && replyLine.settledGain >= 2) {
      kinds.push('allowed');
      const what = consequence(replyLine, 'your ', move.after);
      lines.push(`${at(move)}${pawns}: it let Black play ${reply.steps[0].san}${what ? `, ${what}` : ''}. ${best} was better.`);
    } else if (bestLine.settledGain >= 2) {
      kinds.push('missed');
      lines.push(`${at(move)}${pawns}: you missed ${best}, which wins material.`);
    } else {
      kinds.push('quiet');
      const first = new Chess(move.before).move(best);
      const point = await positionalPoint(move.before, first, before.steps.map(step => step.san));
      lines.push(`${at(move)}${pawns}: ${best} was better${point ? `: it ${point.reason}` : ''}.`);
    }
  }
  const habits = [];
  if (kinds.includes('missed') || kinds.includes('mate')) habits.push('Before each move, look at every check and capture you have: a winning one was there and went unplayed.');
  if (kinds.includes('allowed')) habits.push('Before you let go of a piece, ask what Black’s checks and captures would be after your move.');
  if (kinds.includes('quiet')) habits.push('In quiet positions, look for the engine’s kind of idea: trade off Black’s best piece, find a pawn break, or put a piece on a square Black cannot attack.');
  if (kinds.includes('mate')) habits.push('Near a mate, check each candidate check against every escape square of the king.');
  const share = rows.length ? Math.round((accurate / rows.length) * 100) : 0;
  const parts = [`You played ${accurate} of your ${rows.length} moves at or near the engine’s level (${share}%).`];
  if (lines.length) parts.push(`Your costliest moves:\n${lines.map(line => `• ${line}`).join('\n')}`);
  else parts.push('No move cost you a clear amount: well played.');
  if (habits.length) parts.push(`What to practise:\n${habits.map(line => `• ${line}`).join('\n')}`);
  return { explanation: parts.join('\n\n'), mistakes: rows.filter(row => mistakes.includes(row)).map(row => ({ move: at(row.move), loss: row.loss, best: row.before.steps[0].san })), accuracy: share };
}
