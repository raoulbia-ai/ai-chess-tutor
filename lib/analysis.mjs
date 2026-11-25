// Chess understanding for the tutor: what each side threatens, which pieces really lose material, how good each
// move was, and which tactical motif makes an engine line work. Everything here is deterministic (chess.js and
// Stockfish) and returns data, never prose, so lessons can be chosen and checked without parsing English.
import { Chess } from 'chess.js';
import { analyse, scoreValue } from './engine.mjs';

export const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const pieceNames = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const other = color => (color === 'w' ? 'b' : 'w');

// The same position with `color` to move. En passant is cleared because it belonged to the real side to move.
export function withTurn(fen, color) {
  const parts = fen.split(' ');
  parts[1] = color; parts[3] = '-';
  return parts.join(' ');
}

export function material(board, color) {
  return board.board().flat().reduce((sum, piece) => sum + (piece && piece.type !== 'k' ? values[piece.type] * (piece.color === color ? 1 : -1) : 0), 0);
}

// Static exchange evaluation. With the capturing side to move, returns what it nets by capturing on `square`
// and letting both sides keep recapturing with their cheapest legal piece, each free to stop when behind.
// Legal moves are used throughout, so pinned pieces cannot recapture and pieces behind a capturer join in.
function exchange(board, square, depth = 0) {
  if (depth > 12) return 0;
  const captures = board.moves({ verbose: true }).filter(move => move.to === square && move.captured && !move.flags.includes('e'));
  if (!captures.length) return 0;
  captures.sort((a, b) => values[a.piece] - values[b.piece]);
  const move = captures[0];
  board.move(move);
  const reply = exchange(board, square, depth + 1);
  board.undo();
  return Math.max(0, values[move.captured] - reply);
}

// What `byColor` wins by capturing the piece on `square` now (0 when it cannot win anything).
export function captureGain(fen, square, byColor) {
  let board;
  try { board = new Chess(withTurn(fen, byColor)); } catch { return 0; }
  // With the turn handed over, the other side's king may already be attacked; that is a check, not a capture.
  if (board.get(square)?.type === 'k') return 0;
  let best = 0;
  for (const move of board.moves({ verbose: true })) {
    if (move.to !== square || !move.captured || move.flags.includes('e')) continue;
    board.move(move);
    best = Math.max(best, values[move.captured] - exchange(board, square));
    board.undo();
  }
  return best;
}

// Pieces of `color` that the opponent could win material from right now, most valuable loss first.
export function piecesEnPrise(fen, color) {
  const board = new Chess(fen);
  return board.board().flat()
    .filter(piece => piece && piece.color === color && piece.type !== 'k')
    .map(piece => ({ square: piece.square, type: piece.type, gain: captureGain(fen, piece.square, other(color)),
      attackers: board.attackers(piece.square, other(color)), defenders: board.attackers(piece.square, color) }))
    .filter(entry => entry.gain > 0)
    .sort((a, b) => b.gain - a.gain);
}

const directions = { b: [[1, 1], [1, -1], [-1, 1], [-1, -1]], r: [[1, 0], [-1, 0], [0, 1], [0, -1]] };
directions.q = [...directions.b, ...directions.r];
const toSquare = (file, rank) => (file >= 0 && file < 8 && rank >= 0 && rank < 8 ? 'abcdefgh'[file] + (rank + 1) : null);

// Pins and skewers created by the slider on `square`: along each of its lines, the first two pieces met.
// A pin: the front piece belongs to the opponent and shields its king or a more valuable piece.
// A skewer: the front piece is the more valuable one (or the king) and the piece behind is also the opponent's.
export function lineTactics(board, square) {
  const slider = board.get(square);
  if (!slider || !directions[slider.type]) return [];
  const found = [];
  for (const [df, dr] of directions[slider.type]) {
    const met = [];
    let file = 'abcdefgh'.indexOf(square[0]) + df, rank = Number(square[1]) - 1 + dr;
    for (let sq = toSquare(file, rank); sq && met.length < 2; file += df, rank += dr, sq = toSquare(file, rank)) {
      const piece = board.get(sq);
      if (piece) met.push({ ...piece, square: sq });
    }
    const [front, behind] = met;
    if (!front || !behind || front.color === slider.color || behind.color === slider.color) continue;
    // A pawn shielding a minor piece is not worth calling a pin, and a skewer onto a pawn wins little.
    if (front.type !== 'k' && (behind.type === 'k' || (values[behind.type] > values[front.type] && front.type !== 'p'))) {
      found.push({ motif: 'pin', absolute: behind.type === 'k', by: square, pinned: front.square, behind: behind.square });
    } else if ((front.type === 'k' || values[front.type] > values[behind.type]) && behind.type !== 'p' && skewerWins(board, front, behind, slider.color)) {
      found.push({ motif: 'skewer', by: square, front: front.square, behind: behind.square });
    }
  }
  return found;
}

// A skewer only works if, wherever the front piece goes, the piece behind it can then be won: a king that steps
// aside and still guards it (Ke8 next to a bishop on e7) leaves nothing to take.
function skewerWins(board, front, behind, color) {
  let escapes;
  try { escapes = new Chess(withTurn(board.fen(), front.color)).moves({ verbose: true }).filter(move => move.from === front.square); } catch { return true; }
  return escapes.every(move => captureGain(move.after, behind.square, color) > 0);
}

// Does `color`, if it could move again, have a mate in one?
export function mateThreat(fen, color) {
  let board;
  try { board = new Chess(withTurn(fen, color)); } catch { return null; }
  for (const move of board.moves({ verbose: true })) {
    if (move.captured === 'k') continue;
    board.move(move);
    const mate = board.isCheckmate();
    board.undo();
    if (mate) return move.san;
  }
  return null;
}

// Motifs shown by one move: what it captures, whom it forks, pins or skewers, what it uncovers, whether it threatens
// mate, traps a piece, removes a defender or promotes. `board` is the position before the move.
export function moveMotifs(board, move) {
  const side = move.color, enemy = other(side);
  const before = new Chess(board.fen());
  const after = new Chess(move.after);
  const motifs = [];
  if (after.isCheckmate()) {
    const king = after.board().flat().find(piece => piece?.type === 'k' && piece.color === enemy);
    const backRank = king && king.square[1] === (enemy === 'w' ? '1' : '8') && ['r', 'q'].includes(move.promotion ?? move.piece);
    motifs.push({ motif: backRank ? 'back-rank mate' : 'checkmate', square: move.to });
  }
  if (move.captured) {
    const gain = values[move.captured] - exchange(new Chess(move.after), move.to);
    const undefended = !after.moves({ verbose: true }).some(reply => reply.to === move.to && reply.captured);
    if (gain > 0) motifs.push({ motif: undefended ? 'hanging piece' : 'wins material', square: move.to, captured: move.captured, gain });
    // Removing a defender: another enemy piece the captured one protected can now be won.
    for (const piece of before.board().flat().filter(p => p && p.color === enemy && p.type !== 'k' && p.square !== move.to)) {
      if (!before.attackers(piece.square, enemy).includes(move.to)) continue;
      if (captureGain(move.before, piece.square, side) <= 0 && captureGain(withTurn(move.after, side), piece.square, side) > 0) {
        motifs.push({ motif: 'removes defender', square: move.to, exposed: piece.square });
      }
    }
  }
  // Targets the moved piece now attacks: the king (check) or a piece it can win or that is worth more than it.
  const mover = move.promotion ?? move.piece;
  const targets = after.board().flat().filter(piece => piece && piece.color === enemy && after.attackers(piece.square, side).includes(move.to))
    .filter(piece => piece.type === 'k' || values[piece.type] > values[mover] || captureGain(withTurn(move.after, side), piece.square, side) > 0);
  // A forking piece that can simply be taken for at least its own value forks nothing.
  const forkerLost = captureGain(move.after, move.to, enemy) >= values[mover] - 1;
  if (targets.length >= 2 && !forkerLost) motifs.push({ motif: 'fork', square: move.to, targets: targets.map(piece => piece.square) });
  for (const tactic of lineTactics(after, move.to)) motifs.push({ ...tactic, square: move.to });
  // Pins already on the board that this move exploits by attacking the pinned piece.
  for (const piece of after.board().flat().filter(p => p && p.color === side && directions[p.type] && p.square !== move.to)) {
    for (const tactic of lineTactics(after, piece.square)) {
      if (tactic.motif === 'pin' && after.attackers(tactic.pinned, side).includes(move.to)) motifs.push({ ...tactic, square: move.to, exploited: true });
    }
  }
  // Discovered attack: a different piece of the mover's side now attacks something through the vacated square.
  for (const piece of after.board().flat().filter(p => p && p.color === enemy)) {
    const uncovered = after.attackers(piece.square, side).filter(from => from !== move.to && !before.attackers(piece.square, side).includes(from));
    if (uncovered.length && (piece.type === 'k' || captureGain(withTurn(move.after, side), piece.square, side) > 0 || values[piece.type] >= 3)) {
      motifs.push({ motif: piece.type === 'k' ? 'discovered check' : 'discovered attack', square: move.to, by: uncovered[0], target: piece.square });
    }
  }
  if (!after.isCheck()) {
    const mate = mateThreat(move.after, side);
    if (mate) motifs.push({ motif: 'mate threat', square: move.to, mate });
  }
  // A trapped piece: attacked, worth winning, and every move it has still loses it.
  for (const piece of after.board().flat().filter(p => p && p.color === enemy && !['p', 'k'].includes(p.type))) {
    // Only a piece this move newly attacks counts; one that was already losable is simply en prise.
    if (captureGain(withTurn(move.after, side), piece.square, side) <= 0 || captureGain(withTurn(move.before, side), piece.square, side) > 0) continue;
    const escapes = after.moves({ verbose: true }).filter(reply => reply.from === piece.square);
    const safe = escapes.some(reply => captureGain(withTurn(reply.after, side), reply.to, side) < values[piece.type] - (reply.captured ? values[reply.captured] : 0));
    if (!safe) motifs.push({ motif: 'trapped piece', square: move.to, target: piece.square });
  }
  if (move.promotion) motifs.push({ motif: 'promotion', square: move.to });
  else if (move.piece === 'p' && move.to[1] === (side === 'w' ? '7' : '2')) motifs.push({ motif: 'advanced pawn', square: move.to });
  return motifs;
}

// Replays a line of SAN moves from `fen` and lists each move's motifs and the material balance for the side that
// moves first. `settledGain` is that side's material change over the first four plies once the last exchange is
// resolved: if the window ends on a capture, the static exchange on that square is added for the side to move.
export function lineMotifs(fen, sans, { window = 4 } = {}) {
  const board = new Chess(fen);
  const side = board.turn();
  const start = material(board, side);
  const plies = [];
  let settledGain = null;
  for (const san of sans) {
    let move;
    try { move = board.move(san); } catch { break; }
    board.undo();
    const motifs = moveMotifs(board, move);
    board.move(san);
    plies.push({ san: move.san, color: move.color, from: move.from, to: move.to, captured: move.captured ?? null, motifs, material: material(board, side) - start,
      mate: board.isCheckmate() });
    if (plies.length === Math.min(window, sans.length) && settledGain === null) {
      const pending = move.captured ? exchange(new Chess(board.fen()), move.to) : 0;
      settledGain = plies.at(-1).material + (board.turn() === side ? pending : -pending);
    }
  }
  if (plies.some(ply => ply.mate && ply.color === side)) settledGain = Infinity;
  return { side, plies, settledGain: settledGain ?? 0 };
}

// The motif that explains a line for the side that moves first: a mate if the line mates; otherwise the most
// telling motif of that side's earliest move that shows one. Within a move, uncovered attacks and double attacks
// come before simple captures, and a capture of an undefended piece before the subtler pin or defender removal.
const motifOrder = ['discovered check', 'discovered attack', 'fork', 'skewer', 'hanging piece', 'trapped piece', 'pin', 'removes defender',
  'wins material', 'mate threat', 'promotion', 'advanced pawn'];
export function keyMotif({ side, plies }) {
  const own = plies.filter(ply => ply.color === side);
  const isMate = motif => motif.motif === 'checkmate' || motif.motif === 'back-rank mate';
  const mate = own.find(ply => ply.motifs.some(isMate));
  if (mate) return { ...mate.motifs.find(isMate), san: mate.san, ply: plies.indexOf(mate) };
  for (const ply of own) {
    const motif = motifOrder.map(name => ply.motifs.find(found => found.motif === name)).find(Boolean);
    if (motif) return { ...motif, san: ply.san, ply: plies.indexOf(ply) };
  }
  return null;
}

const band = cp => cp >= 300 ? 'winning' : cp >= 120 ? 'clearly better' : cp >= 40 ? 'slightly better' : cp > -40 ? 'equal'
  : cp > -120 ? 'slightly worse' : cp > -300 ? 'clearly worse' : 'losing';

// What `color` threatens if it could move again: a mate, or material won once the exchange settles.
// Uses a "pass" search: the position with `color` to move. Skipped when the side to move is in check.
// With `currentCp` (the evaluation now, for the side to move), a threat must also cost that side at least `minCost` centipawns (default 1.2 pawns, which a deeper search still confirms)
// of evaluation, so a pawn that can be won back with a tactic is not reported as threatened.
export async function threatsBy(fen, color, { depth = 12, currentCp, minCost = 120 } = {}) {
  const board = new Chess(fen);
  if (board.turn() === color || board.isCheck()) return null;
  const passed = withTurn(fen, color);
  // Three engine lines, because the engine's favourite free move is sometimes a quiet improvement while another
  // wins material outright. Captures of pieces that are en prise are searched too, in case none of the lines has them.
  const result = await analyse(passed, { depth, multipv: 3, plies: 6 });
  const lines = [...result.variations];
  const firstMoves = new Set(lines.map(line => line.steps[0]?.san));
  const mover = new Chess(passed);
  for (const victim of piecesEnPrise(fen, other(color)).slice(0, 3)) {
    const capture = mover.moves({ verbose: true }).filter(move => move.to === victim.square && move.captured)
      .sort((x, y) => values[x.piece] - values[y.piece])[0];
    if (!capture || firstMoves.has(capture.san)) continue;
    const probe = await analyse(passed, { depth, rootMove: capture.from + capture.to + (capture.promotion ?? ''), plies: 6 });
    if (probe.variations[0]) { lines.push(probe.variations[0]); firstMoves.add(capture.san); }
  }
  const found = lines.map(line => {
    const sans = line.steps.map(step => step.san);
    const { plies, settledGain } = lineMotifs(passed, sans);
    const mate = line.score.type === 'mate' && line.score.value > 0 ? line.score.value : null;
    return { line, sans, plies, settledGain, mate };
  }).filter(({ line, plies, settledGain, mate }) => {
    if (mate) return true;
    // A threat is something the next move does: a capture, a check, or a tactic. A quiet move whose gain only
    // comes later is a plan, and calling it a threat would point at the wrong move.
    const first = plies[0];
    // A capture only threatens something if the exchange it starts wins material on that square; a trade whose
    // gain comes from a later capture is the later capture's threat.
    const direct = first && (first.captured || first.san.includes('+') || first.motifs.some(m => ['fork', 'pin', 'skewer', 'discovered attack', 'discovered check', 'mate threat', 'promotion'].includes(m.motif)));
    return direct && settledGain >= 1 && (currentCp === undefined || currentCp + scoreValue(line.score) >= minCost);
  });
  // A threat whose first move is not a capture or check rests on a longer line, so confirm it two plies deeper.
  for (const entry of [...found]) {
    const first = entry.plies[0];
    if (entry.mate || first.captured || first.san.includes('+')) continue;
    const step = entry.line.steps[0];
    const deeper = (await analyse(passed, { depth: depth + 2, rootMove: step.from + step.to + (step.promotion ?? ''), plies: 6 })).variations[0];
    const gain = deeper ? lineMotifs(passed, deeper.steps.map(s => s.san)).settledGain : 0;
    if (gain < 1 || (currentCp !== undefined && currentCp + scoreValue(deeper.score) < minCost)) found.splice(found.indexOf(entry), 1);
  }
  if (!found.length) return null;
  // A capture that wins material on its own square explains itself. When there is one, a capture that only
  // starts a trade (its gain comes from a later capture) is dropped, so the comment names the real target.
  const winsOnSquare = entry => entry.plies[0]?.captured && values[entry.plies[0].captured] - exchange(new Chess(entry.line.steps[0].fen), entry.plies[0].to) >= 1;
  if (found.some(winsOnSquare)) {
    for (const entry of [...found]) if (entry.plies[0]?.captured && !winsOnSquare(entry) && !entry.mate) found.splice(found.indexOf(entry), 1);
  }
  found.sort((x, y) => (y.mate ? 1 : 0) - (x.mate ? 1 : 0) || y.settledGain - x.settledGain);
  const describe = entry => {
    const first = entry.line.steps[0];
    return { side: color, move: first.san, from: first.from, to: first.to, captured: first.captured, line: entry.sans, mate: entry.mate,
      materialGain: entry.mate ? null : entry.settledGain, motifs: entry.plies[0]?.motifs ?? [] };
  };
  // Further threats against other squares, so two loose pieces are both reported.
  const others = found.slice(1).filter(entry => entry.line.steps[0].to !== found[0].line.steps[0].to).slice(0, 2).map(describe);
  return { ...describe(found[0]), others };
}

// How good a move was for the side that played it: centipawns lost against the engine's best, a verdict,
// and, when it was a mistake, the opponent's best reply line and what that line wins.
export async function moveVerdict(fenBefore, san, { depth = 16 } = {}) {
  const board = new Chess(fenBefore);
  const move = board.move(san);
  const best = await analyse(fenBefore, { depth, multipv: 1, plies: 8 });
  const reply = await analyse(move.after, { depth, multipv: 1, plies: 8 });
  const bestCp = scoreValue(best.variations[0].score);
  const afterCp = -scoreValue(reply.variations[0].score);
  const loss = Math.max(0, bestCp - afterCp);
  const verdict = loss <= 30 ? 'best' : loss <= 80 ? 'good' : loss <= 150 ? 'inaccuracy' : loss <= 300 ? 'mistake' : 'blunder';
  const refutation = reply.variations[0].steps.map(step => step.san);
  const punished = loss > 150 ? lineMotifs(move.after, refutation) : null;
  return { san: move.san, color: move.color, loss, verdict, bestMove: best.variations[0].steps[0]?.san, bestCp, afterCp, band: band(afterCp),
    refutation: punished && { line: refutation, settledGain: punished.settledGain, motifs: punished.plies[0]?.motifs ?? [] } };
}

// Slower-changing features a plan can be built on, for one side.
export function planFeatures(fen, color) {
  const board = new Chess(fen);
  const pieces = board.board().flat().filter(Boolean);
  const own = pieces.filter(piece => piece.color === color);
  const home = color === 'w' ? '1' : '8';
  const undeveloped = own.filter(piece => ['n', 'b'].includes(piece.type) && piece.square[1] === home).map(piece => piece.square);
  const king = own.find(piece => piece.type === 'k');
  const castled = ['g', 'c', 'h', 'b'].includes(king.square[0]) && king.square[1] === home;
  const rights = board.getCastlingRights(color);
  const pawns = color => pieces.filter(piece => piece.type === 'p' && piece.color === color);
  const files = 'abcdefgh'.split('');
  const openFiles = files.filter(file => !pieces.some(piece => piece.type === 'p' && piece.square[0] === file));
  const halfOpen = files.filter(file => !pawns(color).some(p => p.square[0] === file) && pawns(other(color)).some(p => p.square[0] === file));
  const ownPawnFiles = pawns(color).map(p => p.square[0]);
  const isolated = pawns(color).filter(p => !ownPawnFiles.includes(files[files.indexOf(p.square[0]) - 1]) && !ownPawnFiles.includes(files[files.indexOf(p.square[0]) + 1])).map(p => p.square);
  const doubled = [...new Set(ownPawnFiles.filter((file, i) => ownPawnFiles.indexOf(file) !== i))];
  const ahead = (pawn, square) => color === 'w' ? Number(square[1]) > Number(pawn.square[1]) : Number(square[1]) < Number(pawn.square[1]);
  const passed = pawns(color).filter(pawn => !pawns(other(color)).some(enemy => Math.abs(files.indexOf(enemy.square[0]) - files.indexOf(pawn.square[0])) <= 1 && ahead(pawn, enemy.square))).map(p => p.square);
  // Mobility of each minor and major piece with this side to move, to find the least active one.
  let mobilityBoard;
  try { mobilityBoard = new Chess(withTurn(fen, color)); } catch { mobilityBoard = null; }
  const mobility = mobilityBoard ? own.filter(piece => ['n', 'b', 'r', 'q'].includes(piece.type))
    .map(piece => ({ square: piece.square, type: piece.type, moves: mobilityBoard.moves({ square: piece.square }).length })) : [];
  const leastActive = mobility.filter(entry => entry.type !== 'q').sort((a, b) => a.moves - b.moves)[0] ?? null;
  return { color, undeveloped, castled, canCastle: rights, kingSquare: king.square, openFiles, halfOpenFiles: halfOpen, isolated, doubled, passed, leastActive };
}

// Everything the tutor needs about one position, with `color` the learner's side (White) and that side to move.
export async function analysePosition(fen, { depth = 16, lines = 3 } = {}) {
  const board = new Chess(fen);
  const side = board.turn(), enemy = other(side);
  const result = await analyse(fen, { depth, multipv: lines, plies: 10 });
  const variations = result.variations.map(variation => {
    const sans = variation.steps.map(step => step.san);
    const motifs = lineMotifs(fen, sans);
    const cp = scoreValue(variation.score);
    return { move: sans[0], cp, score: variation.score, band: band(cp), line: sans, settledGain: motifs.settledGain,
      firstMotifs: motifs.plies[0]?.motifs ?? [], keyMotif: motifs.plies.filter(ply => ply.color === side).flatMap(ply => ply.motifs)[0] ?? null };
  });
  return {
    fen, side, inCheck: board.isCheck(), evalCp: variations[0]?.cp ?? 0, band: band(variations[0]?.cp ?? 0), variations,
    threat: await threatsBy(fen, enemy),
    enPrise: piecesEnPrise(fen, side),
    targets: piecesEnPrise(fen, enemy),
    features: { [side]: planFeatures(fen, side), [enemy]: planFeatures(fen, enemy) },
  };
}

// What a quiet move changes on the board, said plainly: the Black pieces it newly attacks, the pieces of yours it
// newly defends while they are under attack, and how much more the moved piece can do.
export function moveEffects(fen, move) {
  const before = new Chess(fen), after = new Chess(move.after);
  const reach = piece => piece && after.attackers(piece.square, 'w').includes(move.to) && !before.attackers(piece.square, 'w').includes(move.from);
  const attacks = after.board().flat().filter(p => p?.color === 'b' && p.type !== 'k' && reach(p) && values[p.type] >= (move.piece === 'p' ? 1 : 3))
    .sort((x, y) => values[y.type] - values[x.type]);
  const defends = after.board().flat().filter(p => p?.color === 'w' && p.square !== move.to && p.type !== 'k' && before.attackers(p.square, 'b').length && reach(p));
  const mobility = (position, square) => { try { return new Chess(withTurn(position, 'w')).moves({ square }).length; } catch { return 0; } };
  return { attacks, defends, from: mobility(fen, move.from), to: mobility(move.after, move.to) };
}

// The square of the enemy piece that pins the piece on `square` to its own king, or null. A pinned piece cannot
// move off the line without exposing its king, so it cannot run from an attack.
export function pinnedBy(fen, square) {
  const board = new Chess(fen);
  const piece = board.get(square);
  if (!piece || piece.type === 'k') return null;
  const king = board.board().flat().find(p => p?.type === 'k' && p.color === piece.color)?.square;
  if (!king) return null;
  const enemy = other(piece.color);
  const before = board.attackers(king, enemy);
  board.remove(square);
  return board.attackers(king, enemy).find(from => !before.includes(from) && ['b', 'r', 'q'].includes(board.get(from)?.type)) ?? null;
}
