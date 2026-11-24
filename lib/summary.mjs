// End-of-game review: a quick engine pass over every White move, the costliest ones with what was missed, the
// moves you took back and whether taking them back was right, and the habit that would have prevented the
// mistakes. No model call.
import { Chess } from 'chess.js';
import { analyse, scoreValue } from './engine.mjs';
import { consequence, lineWithBoards, materialPhrase, sacrifice } from './coach.mjs';
import { pieceNames } from './analysis.mjs';
import { positionalPoint } from './positional.mjs';

// Scores beyond about six pawns all mean "winning": a slower win is not a mistake worth reviewing, unless the
// move missed a large, concrete material win (checked separately below).
const capped = cp => Math.max(-600, Math.min(600, cp));
const wide = cp => Math.max(-2000, Math.min(2000, cp));
const at = move => `${move.before.split(' ')[5]}.${move.san}`;

// How one White move compares with the engine's best: both evaluations, and the engine lines behind them.
async function judge(move) {
  const before = (await analyse(move.before, { depth: 12, multipv: 1, plies: 8 })).variations[0];
  if (!before) return null;
  const after = new Chess(move.after);
  // After a mate or a draw by the rules there is nothing to search: the move kept what it had.
  const reply = after.isGameOver() ? null : (await analyse(move.after, { depth: 12, multipv: 1, plies: 8 })).variations[0];
  const bestCp = scoreValue(before.score);
  const playedCp = after.isCheckmate() ? 100000 : reply ? -scoreValue(reply.score) : 0;
  const mateMissed = before.score.type === 'mate' && before.score.value > 0 && before.score.value <= 3 && !(reply?.score.type === 'mate' && reply.score.value < 0) && !after.isCheckmate();
  const row = { move, before, reply, bestCp, playedCp, loss: capped(bestCp) - capped(playedCp), mateMissed, bigMiss: false };
  // Already winning, but the best move won a lot more material by force (a combination, a loose queen): the cap
  // hides it, yet it is exactly the kind of chance worth learning to see.
  // A longer forced mate that the move let slip, while already winning: worth knowing, but not a costly error.
  const keptMate = reply?.score.type === 'mate' && reply.score.value < 0;
  if (!mateMissed && before.score.type === 'mate' && before.score.value > 0 && before.score.value <= 5 && !keptMate && !after.isCheckmate()) row.slowMate = before.score.value;
  else if (!mateMissed && row.loss < 150 && wide(bestCp) - wide(playedCp) >= 100 && before.steps[0].san !== move.san) {
    const bestLine = lineWithBoards(move.before, before.steps.map(step => step.san), 6);
    const playedLine = lineWithBoards(move.before, [move.san, ...(reply?.steps.map(step => step.san) ?? [])], 6);
    if (bestLine.settledGain >= 3 && bestLine.settledGain !== Infinity && bestLine.settledGain - playedLine.settledGain >= 2) row.bigMiss = bestLine;
  }
  return row;
}

export async function gameSummary(moves, { startFen, takebacks = [] } = {}) {
  const game = new Chess(startFen);
  for (const san of moves) game.move(san);
  const played = game.history({ verbose: true }).filter(move => move.color === 'w');
  const rows = [];
  for (const move of played) { const row = await judge(move); if (row) rows.push(row); }
  const accurate = rows.filter(row => row.loss < 50 && !row.mateMissed && !row.bigMiss && !row.slowMate).length;
  const weight = row => row.mateMissed ? 1000 : row.bigMiss || row.slowMate ? 150 : row.loss;
  const mistakes = rows.filter(row => row.mateMissed || row.bigMiss || row.slowMate || row.loss >= 150).sort((a, b) => weight(b) - weight(a)).slice(0, 3);
  const kinds = [];
  const lines = [];
  for (const row of mistakes) {
    const { move, before, reply } = row;
    const best = before.steps[0].san;
    const pawns = ` (cost about ${(row.loss / 100).toFixed(1)} pawns)`;
    if (row.mateMissed) {
      kinds.push('mate');
      lines.push(`${at(move)}: ${best} started a forced mate in ${before.score.value}.`);
      continue;
    }
    if (row.slowMate) {
      kinds.push('mate');
      lines.push(`${at(move)}: you were already winning, but ${best} started a forced mate in ${row.slowMate}.`);
      continue;
    }
    if (row.bigMiss) {
      kinds.push('missed');
      const won = sacrifice(new Chess(move.before), row.bigMiss);
      const what = won ? `a combination: it gives up material first, then wins Black’s ${pieceNames[won.captured]} on ${won.to}` : `it wins ${materialPhrase(row.bigMiss, 6)}`;
      lines.push(`${at(move)}: you were already winning, but ${best} was much stronger: ${what}.`);
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
      const won = sacrifice(new Chess(move.before), bestLine);
      lines.push(`${at(move)}${pawns}: you missed ${best}, ${won ? `a combination that gives up material first, then wins Black’s ${pieceNames[won.captured]} on ${won.to}` : 'which wins material'}.`);
    } else {
      kinds.push('quiet');
      const first = new Chess(move.before).move(best);
      const point = await positionalPoint(move.before, first, before.steps.map(step => step.san));
      lines.push(`${at(move)}${pawns}: ${best} was better${point ? `: it ${point.reason}` : ''}.`);
    }
  }

  // Moves you took back: was the move really bad, or did a warning scare you off a good one?
  const retried = [];
  for (const entry of takebacks.slice(0, 12)) {
    let move;
    try { const board = new Chess(startFen); for (const san of entry.moves) board.move(san); if (board.turn() !== 'w') continue; move = board.move(entry.san); } catch { continue; }
    const row = await judge(move);
    if (!row) continue;
    const best = row.before.steps[0].san;
    if (row.mateMissed || row.loss >= 150) {
      const replyLine = row.reply && lineWithBoards(move.after, row.reply.steps.map(step => step.san), 6);
      const what = replyLine && replyLine.settledGain >= 2 ? consequence(replyLine, 'your ', move.after) : '';
      retried.push({ good: false, text: `${at(move)} would have cost about ${(row.loss / 100).toFixed(1)} pawns${what ? `: Black had ${row.reply.steps[0].san}, ${what}` : ''}. Taking it back was right; next time, look for that reply before you move.` });
    } else if (row.loss < 50) {
      retried.push({ good: true, text: `${at(move)} was a good move${best === move.san ? ' (the engine’s own choice)' : ''}: you did not need to take it back.` });
    }
  }

  const habits = [];
  if (kinds.includes('missed') || kinds.includes('mate')) habits.push('Before each move, look at every check and capture you have, including ones that give up material first: a winning one was there and went unplayed.');
  if (kinds.includes('allowed') || retried.some(entry => !entry.good)) habits.push('Before you let go of a piece, ask what Black’s checks and captures would be after your move.');
  if (retried.some(entry => entry.good)) habits.push('When a piece of yours is attacked, count its defenders before you retreat: a defended piece is often safe.');
  if (kinds.includes('quiet')) habits.push('In quiet positions, look for the engine’s kind of idea: trade off Black’s best piece, find a pawn break, or put a piece on a square Black cannot attack.');
  if (kinds.includes('mate')) habits.push('Near a mate, check each candidate check against every escape square of the king.');
  const share = rows.length ? Math.round((accurate / rows.length) * 100) : 0;
  const parts = [`You played ${accurate} of your ${rows.length} moves at or near the engine’s level (${share}%)${takebacks.length ? `, with ${takebacks.length} ${takebacks.length === 1 ? 'move' : 'moves'} taken back` : ''}.`];
  if (lines.length) parts.push(`Your costliest moves:\n${lines.map(line => `• ${line}`).join('\n')}`);
  else parts.push('No move cost you a clear amount: well played.');
  // The most instructive takebacks: the bad ones first, then good moves you abandoned.
  const bad = retried.filter(entry => !entry.good), good = retried.filter(entry => entry.good);
  const shown = [...bad.slice(0, good.length ? 2 : 4), ...good.slice(0, 2)];
  if (shown.length) parts.push(`Moves you took back:\n${shown.map(entry => `• ${entry.text}`).join('\n')}`);
  if (habits.length) parts.push(`What to practise:\n${habits.map(line => `• ${line}`).join('\n')}`);
  return { explanation: parts.join('\n\n'), mistakes: rows.filter(row => mistakes.includes(row)).map(row => ({ move: at(row.move), loss: row.loss, best: row.before.steps[0].san })), accuracy: share };
}
