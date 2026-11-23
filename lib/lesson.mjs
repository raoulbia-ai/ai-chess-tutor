import { Chess } from 'chess.js';
import { analyse } from './engine.mjs';
import { narrate } from './tutor.mjs';
import { turnComment } from './coach.mjs';
import { hintLesson, hintLevels } from './hints.mjs';

export const tutorModes = ['hint', 'explain', 'review', 'demonstrate', 'question', 'turn', 'assess'];

// A request the learner can fix (wrong mode, not their turn). The server turns it into an HTTP 400.
export class LessonRequestError extends Error {}

export function gameFrom(moves, startFen) {
  if (!Array.isArray(moves) || moves.length > 500 || !moves.every(m => typeof m === 'string' && m.length <= 12)) throw new Error('Invalid game history.');
  const game = new Chess(startFen);
  for (const move of moves) game.move(move);
  return game;
}

// Builds the context narrate() needs for one tutor request, so the server and the evaluation suite share it.
// `analysis(fen, rootMove)` returns engine analysis; the server passes a cached version.
// `startFen` lets the evaluation suite start from a puzzle position; the server never passes it.
export async function buildLessonContext(data, analysis = (fen, rootMove) => analyse(fen, { rootMove }), { startFen } = {}) {
  const game = gameFrom(data.moves, startFen);
  if (!tutorModes.includes(data.mode)) throw new LessonRequestError('Unknown tutoring mode.');
  const opponentMove = data.mode === 'assess' ? game.history({ verbose: true }).at(-1) : undefined;
  if (data.mode === 'assess' && opponentMove?.color !== 'b') throw new LessonRequestError('Wait for Black’s reply first.');
  let turnEvidence;
  if (data.mode === 'turn') {
    if (game.turn() !== 'w' || data.moves.length < 2) throw new LessonRequestError('Wait for Black’s reply first.');
    const [white, black] = game.history({ verbose: true }).slice(-2);
    const uci = white.from + white.to + (white.promotion || '');
    const prior = await analysis(white.before);
    const chosen = prior.variations.find(v => v.steps[0].uci === uci) || (await analysis(white.before, uci)).variations[0];
    turnEvidence = { white, black, whiteContinuation: chosen, alternative: prior.variations[0] };
  }
  let root = game, played = null;
  if (data.mode === 'review') {
    const count = game.turn() === 'w' ? 2 : 1;
    if (data.moves.length < count) throw new LessonRequestError('Make a move first.');
    root = gameFrom(data.moves.slice(0, -count), startFen); played = data.moves[data.moves.length - count];
  }
  const rootAnalysis = await analysis(root.fen());
  let selected = rootAnalysis.variations[0];
  if (data.candidate) {
    const temp = new Chess(root.fen()); let move;
    try { move = temp.move(String(data.candidate)); } catch { throw new LessonRequestError('That alternative is not legal here. Use notation such as Nf3 or e2e4.'); }
    const uci = move.from + move.to + (move.promotion || '');
    selected = rootAnalysis.variations.find(v => v.steps[0].uci === uci) || (await analysis(root.fen(), uci)).variations[0];
  }
  let playedLine = null;
  if (played) {
    const temp = new Chess(root.fen()), move = temp.move(played), uci = move.from + move.to + (move.promotion || '');
    playedLine = rootAnalysis.variations.find(v => v.steps[0].uci === uci) || (await analysis(root.fen(), uci)).variations[0];
  }
  const segment = (line, label, limit = 4) => line.steps.slice(0, limit).map((step, i) => ({
    ...step, before: i ? line.steps[i - 1].fen : root.fen(), label,
  }));
  const sameMove = playedLine?.steps[0].uci === selected.steps[0].uci;
  const demonstration = data.mode === 'review'
    ? sameMove ? segment(playedLine, 'Your move matches the engine suggestion')
      : [...segment(playedLine, 'Your move and a possible reply', 3), ...segment(selected, 'Engine suggestion from the same position', 3)]
    : ['demonstrate', 'explain'].includes(data.mode) ? segment(selected, 'Possible continuation') : [];
  const actualGameHistory = game.history({ verbose: true }).map(({ color, san, from, to }) => ({ color, san, from, to }));
  const latestLearnerMove = actualGameHistory.findLast(move => move.color === 'w') || null;
  const context = { mode: data.mode, turnEvidence, opponentMove, automatic: data.automatic === true, position: root.fen(), board: root.board().flat().filter(Boolean), history: root.history(), actualGameHistory, latestLearnerMove, played, playedLine,
    lines: rootAnalysis.variations, selected, demonstration, question: String(data.question || '').slice(0, 700), focus: String(data.focus || 'Notice threats and protect pieces').slice(0, 150) };
  return { context, root, demonstration, sameMove };
}

// Produces the lesson the server returns for a tutor request.
export async function lessonFor(data, analysis = (fen, rootMove) => analyse(fen, { rootMove }), options = {}) {
  // Turn commentary comes from the analysis layer, without a model call. TUTOR_TURN_COMMENTARY=model restores the
  // earlier model-written version.
  if (data.mode === 'turn' && process.env.TUTOR_TURN_COMMENTARY !== 'model') {
    const game = gameFrom(data.moves, options.startFen);
    if (game.turn() !== 'w' || data.moves.length < 2) throw new LessonRequestError('Wait for Black’s reply first.');
    const [white, black] = game.history({ verbose: true }).slice(-2);
    const { insights, ...lesson } = await turnComment({ white, black }, fen => analysis(fen));
    return { lesson, root: game.fen(), demonstration: [], insights };
  }
  // Hints come from the analysis layer too, in levels: the idea, then the piece, then the move.
  // TUTOR_HINTS=model restores the earlier model-written hints.
  if (data.mode === 'hint' && process.env.TUTOR_HINTS !== 'model') {
    const game = gameFrom(data.moves, options.startFen);
    if (game.turn() !== 'w') throw new LessonRequestError('Wait for Black’s reply first.');
    const level = Math.min(hintLevels, Math.max(1, Math.round(Number(data.level)) || 1));
    const lastMove = game.history({ verbose: true }).at(-1);
    const { title, levels, insights } = await hintLesson(game.fen(), fen => analysis(fen), { lastMove });
    const lesson = { title, explanation: levels.slice(0, level).join('\n'), question: '', steps: [] };
    return { lesson, root: game.fen(), demonstration: [], insights, hint: { level, levels: hintLevels }, ...(options.allLevels && { levels }) };
  }
  const { context, root, demonstration, sameMove } = await buildLessonContext(data, analysis, options);
  const lesson = await narrate(context);
  if (demonstration.length) lesson.explanation = data.mode === 'review'
    ? `Back before your move.${sameMove ? ' It matches the engine’s suggestion. Watch a possible continuation.' : ' Compare your move with an alternative. These replies are hypothetical.'}`
    : 'Watch this short line, then try the idea yourself.';
  return { lesson, root: root.fen(), demonstration };
}
