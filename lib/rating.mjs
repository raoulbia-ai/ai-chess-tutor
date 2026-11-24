// Your playing rating, Elo-style, from finished games against opponents of known strength. The human-like
// opponents (Maia) play like Lichess players of their rating, so the scale is roughly Lichess's, not FIDE's.
// Reduced-strength Stockfish was measured against them: 30 games against Maia 1100, 1500 and 1900 scored
// 3, 3 and 0 out of 10, which puts it at about 1100.
// A game counts only when it was played to the end without takebacks and against one opponent; hints are fine.
// The record lives in ratings.json next to the app (private, not in git).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const file = process.env.CHESS_RATINGS_FILE || fileURLToPath(new URL('../ratings.json', import.meta.url));
const start = 1500, provisionalGames = 10;

export function opponentList(maiaRatings = []) {
  return [
    ...maiaRatings.map(rating => ({ id: `maia-${rating}`, name: 'Human-like', rating })),
    { id: 'stockfish', name: 'Stockfish, weakened', rating: 1100, approximate: true },
  ];
}

function load() {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (Number.isFinite(data.rating) && Array.isArray(data.games)) return { seen: [], ...data };
  } catch { /* No record yet, or a damaged one: start afresh. */ }
  return { rating: start, games: [], seen: [] };
}
function store(data) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 1), { mode: 0o600 });
  renameSync(temporary, file);
}

export function ratingSummary() {
  const data = load();
  const count = data.games.length;
  const tally = result => data.games.filter(game => game.result === result).length;
  return { rating: Math.round(data.rating), provisional: count < provisionalGames, games: count, wins: tally(1), draws: tally(0.5), losses: tally(0),
    recent: data.games.slice(-8).reverse().map(({ date, opponent, opponentRating, result, before, after }) => ({ date, opponent, opponentRating, result, change: Math.round(after) - Math.round(before) })) };
}

// Records a finished game once. `opponents` are the opponents that actually played Black's moves in this game.
export function recordGame({ gameId, moves, opponents = [], takebacks = 0 }, maiaRatings) {
  const game = new Chess();
  for (const move of moves) game.move(move);
  if (!game.isGameOver()) return { rated: false, reason: 'the game is not over' };
  const data = load();
  if (data.seen.includes(gameId) || data.games.some(entry => entry.gameId === gameId)) return { rated: false, reason: 'this game was already counted', duplicate: true };
  data.seen = [...data.seen, gameId].slice(-300);
  const known = opponentList(maiaRatings);
  const used = [...new Set(opponents)];
  const opponent = used.length === 1 ? known.find(entry => entry.id === used[0]) : null;
  let reason = '';
  if (takebacks > 0) reason = `you took back ${takebacks === 1 ? 'a move' : `${takebacks} moves`}, so it counts as practice`;
  else if (used.length > 1) reason = 'the opponent changed during the game';
  else if (!opponent) reason = 'the opponent’s strength is not known';
  if (reason) { store(data); return { rated: false, reason }; }
  // From your side (White): 1 for a win, 0.5 for a draw, 0 for a loss.
  const result = game.isCheckmate() ? (game.turn() === 'b' ? 1 : 0) : 0.5;
  const before = data.rating;
  const expected = 1 / (1 + 10 ** ((opponent.rating - before) / 400));
  // Larger steps while the rating is still finding its level.
  const k = data.games.length < provisionalGames ? 40 : 20;
  data.rating = before + k * (result - expected);
  data.games.push({ gameId, date: new Date().toISOString(), opponent: opponent.name, opponentRating: opponent.rating, result, before, after: data.rating });
  store(data);
  return { rated: true, opponent: opponent.name, opponentRating: opponent.rating, result, before: Math.round(before), after: Math.round(data.rating), provisional: data.games.length < provisionalGames };
}
