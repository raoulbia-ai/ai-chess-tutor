// Builds the evaluation suite: positions where White (the learner) is to move, each labelled from deep
// Stockfish analysis, a "what if White passed" search for Black's threat, and, for puzzles, Lichess themes.
//
//   node eval/build-suite.mjs --puzzles ~/data/lichess/lichess_db_puzzle.csv.zst
//
// Writes eval/suite.json (puzzles and hand-picked positions, safe to commit) and, when game-history.txt
// exists, eval/suite.local.json (positions from your own games, kept out of git).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { analyse, scoreValue, stopEngine } from '../lib/engine.mjs';
import { threatsBy } from '../lib/analysis.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const puzzleFile = args[args.indexOf('--puzzles') + 1];
const perTheme = Number(args.includes('--per-theme') ? args[args.indexOf('--per-theme') + 1] : 12);

// Themes a coach should be able to name, with the number of puzzles wanted for each.
const themes = ['hangingPiece', 'fork', 'pin', 'skewer', 'discoveredAttack', 'mateIn1', 'mateIn2', 'trappedPiece',
  'capturingDefender', 'advancedPawn', 'backRankMate', 'defensiveMove', 'attraction', 'deflection', 'intermezzo'];

// Hand-picked positions with a known lesson. Moves start from the initial position.
const handPicked = [
  { id: 'hand-queen-hangs', moves: 'e4 e5 Nf3 Qg5', note: 'Black’s queen is undefended and attacked: Nxg5 wins it.' },
  { id: 'hand-threat-g2', moves: 'e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5', note: 'Black threatens Qxg2 and attacks the knight on e5.' },
  { id: 'hand-scholar', moves: 'e4 e5 Qh5 Nc6 Bc4 Nf6', note: 'Qxf7 is checkmate.' },
  { id: 'hand-quiet-italian', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5', note: 'No threat; development and the centre matter.' },
  { id: 'hand-morphy-opera', moves: 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7', note: 'O-O-O brings the rook to the pinned knight on d7.' },
  { id: 'hand-qgd', moves: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6', note: 'Quiet Queen’s Gambit Declined.' },
  { id: 'hand-ruy', moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7', note: 'Quiet Ruy Lopez.' },
  { id: 'hand-najdorf', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', note: 'Open Sicilian.' },
  { id: 'hand-pawn-hits-knight', moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5', note: 'The knight on g5 is attacked by the queen on d8 and undefended.' },
  { id: 'hand-bishop-pin', moves: 'd4 Nf6 c4 e6 Nc3 Bb4', note: 'Black pins the knight on c3.' },
];

// A deterministic pseudo-random order, so rebuilding the suite picks the same puzzles.
const hash = text => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

async function samplePuzzles(file) {
  const picked = Object.fromEntries(themes.map(theme => [theme, []]));
  const seen = new Set();
  const child = spawn('zstdcat', [file], { stdio: ['ignore', 'pipe', 'inherit'] });
  const reader = createInterface({ input: child.stdout });
  for await (const line of reader) {
    const [id, fen, moves, rating, , popularity, plays, themeText] = line.split(',');
    // White solves when Black makes the puzzle's first move. Keep learner-level, well-tested puzzles.
    if (id === 'PuzzleId' || fen.split(' ')[1] !== 'b' || +rating < 700 || +rating > 1700 || +popularity < 85 || +plays < 2000) continue;
    if (hash(id) % 23 !== 0) continue;
    const tags = themeText.split(' ');
    const theme = themes.find(name => tags.includes(name) && picked[name].length < perTheme);
    if (!theme || seen.has(id)) continue;
    seen.add(id);
    picked[theme].push({ id, fen, moves: moves.split(' '), rating: +rating, themes: tags });
    if (themes.every(name => picked[name].length >= perTheme)) break;
  }
  child.kill();
  return Object.values(picked).flat();
}

const fromUci = (game, uci) => game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });

// White-to-move positions from the logged games, each with the moves that led there.
function gamePositions() {
  const file = `${root}game-history.txt`;
  if (!existsSync(file)) return [];
  const positions = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\[[^\]]+\] Game (\S+) #\d+ move \| ([^|]+?)(?: \||$)/);
    if (!match) continue;
    const moves = match[2].trim().split(/\s+/);
    if (moves.length % 2 || moves.length < 2) continue;
    const key = moves.join(' ');
    // A retried move gives a different position at the same move number, so the id includes a hash of the moves.
    if (!positions.has(key)) positions.set(key, { id: `game-${match[1].slice(0, 8)}-${moves.length}-${(hash(key) % 46656).toString(36)}`, moves });
  }
  return [...positions.values()];
}

// Engine labels: best lines from deep analysis, and Black's threat from a search where White passes.
async function label(fen) {
  const deep = await analyse(fen, { depth: 18, multipv: 3, plies: 10 });
  const lines = deep.variations.map(v => ({ score: v.score, cp: scoreValue(v.score), moves: v.steps.map(s => s.san) }));
  // Black's threat: what Black wins if White could pass, from the same search the tutor uses, two plies deeper.
  // `threat` counts any material won; `strictThreat` keeps only a direct threat (a capture, check or tactic on the
  // first move) that also costs White at least 0.8 pawns of evaluation, searched four plies deeper than the tutor.
  const threat = await threatsBy(fen, 'b', { depth: 14 });
  const strictThreat = await threatsBy(fen, 'b', { depth: 16, currentCp: lines[0].cp, minCost: 80 });
  return { evalCp: lines[0].cp, lines, threat, strictThreat };
}

// How much each of the last moves lost, in centipawns for the side that played it: the best evaluation
// before the move minus the evaluation after it. Turn commentary should notice a large loss.
async function moveLoss(fenBefore, fenAfter, afterCpForMover) {
  const best = await analyse(fenBefore, { depth: 16, multipv: 1 });
  return scoreValue(best.variations[0].score) - afterCpForMover;
}
async function lastMoves(game, labels) {
  const history = game.history({ verbose: true });
  const black = history.at(-1), white = history.at(-2);
  const result = {};
  if (black?.color === 'b') {
    // After Black's move it is White's turn, so Black's evaluation is minus White's.
    result.black = { san: black.san, loss: await moveLoss(black.before, black.after, -labels.evalCp) };
  }
  if (white?.color === 'w') {
    const reply = await analyse(white.after, { depth: 16, multipv: 1 });
    const afterCp = -scoreValue(reply.variations[0].score);
    result.white = { san: white.san, loss: await moveLoss(white.before, white.after, afterCp), afterCp };
  }
  return result;
}

const suite = [], local = [];
if (puzzleFile) {
  for (const puzzle of await samplePuzzles(puzzleFile.replace(/^~/, process.env.HOME))) {
    const game = new Chess(puzzle.fen);
    const blackMove = fromUci(game, puzzle.moves[0]);
    const fen = game.fen();
    const solution = [];
    for (const uci of puzzle.moves.slice(1)) solution.push(fromUci(game, uci).san);
    const labels = await label(fen);
    const blackLoss = await moveLoss(puzzle.fen, fen, -labels.evalCp);
    suite.push({ id: `puzzle-${puzzle.id}`, source: 'lichess', fen, lastMove: blackMove.san, rating: puzzle.rating, themes: puzzle.themes, solution, ...labels,
      lastMoves: { black: { san: blackMove.san, loss: blackLoss } } });
  }
}
for (const item of handPicked) {
  const game = new Chess(); for (const move of item.moves.split(' ')) game.move(move);
  const labels = await label(game.fen());
  suite.push({ id: item.id, source: 'hand', fen: game.fen(), moves: item.moves.split(' '), note: item.note, ...labels, lastMoves: await lastMoves(game, labels) });
}
for (const item of gamePositions()) {
  const game = new Chess(); for (const move of item.moves) game.move(move);
  if (game.isGameOver()) continue;
  const labels = await label(game.fen());
  local.push({ id: item.id, source: 'game', fen: game.fen(), moves: item.moves, ...labels, lastMoves: await lastMoves(game, labels) });
}
stopEngine();
writeFileSync(`${root}eval/suite.json`, JSON.stringify(suite, null, 1));
if (local.length) writeFileSync(`${root}eval/suite.local.json`, JSON.stringify(local, null, 1));
console.log(`suite.json: ${suite.length} positions; suite.local.json: ${local.length} positions`);
