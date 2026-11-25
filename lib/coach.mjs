// Turn commentary built from the analysis layer: after Black replies, say what matters most, in up to three
// sentences, without a model call. Selection follows a coach's checklist: check or a mate threat first, then a
// mistake by Black that can be punished, then Black's threat, then a mistake in your own move, then a piece of
// yours that can be taken, then a good idea in your move, and only when nothing else applies, a plan.
import { Chess } from 'chess.js';
import { analyse, scoreValue } from './engine.mjs';
import { captureGain, keyMotif, lineMotifs, moveEffects, moveMotifs, pieceNames, pinnedBy, piecesEnPrise, planFeatures, threatsBy, withTurn } from './analysis.mjs';
import { positionalPoint } from './positional.mjs';

export const list = items => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '';
export const named = (board, square, owner) => { const piece = board.get(square); return piece ? `${owner}${pieceNames[piece.type]} on ${square}` : square; };
const article = type => (type === 'p' ? 'a pawn' : `a ${pieceNames[type]}`);
// Piece values in points, the scale the tutor teaches: pawn 1, knight 3, bishop 3, rook 5, queen 9.
export const points = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const worthOf = type => `worth ${points[type]}`;
const pointWord = n => `${n} ${n === 1 ? 'point' : 'points'}`;
// When the winner of a piece gives a pawn back, say who gets it, so "your knight for a pawn" cannot be misread.
const pawnBack = (loserOwner, worth, gain) => Math.round(worth - gain) === 1 && worth < 9 ? (loserOwner === 'your ' ? ' (you get a pawn back)' : ' (Black gets a pawn back)') : '';

// What a line nets for the side that starts it, named by the pieces that change hands in its first four plies:
// "a knight", "the exchange", "a bishop for a pawn". Falls back to a count of pawns when nothing clearer fits.
export function materialPhrase(line, plies = 4) {
  if (line.settledGain === Infinity) return 'a forced mate';
  const window = line.plies.slice(0, plies);
  const won = window.filter(ply => ply.color === line.side && ply.captured).map(ply => ply.captured);
  const lost = window.filter(ply => ply.color !== line.side && ply.captured).map(ply => ply.captured);
  for (const type of [...won]) { const i = lost.indexOf(type); if (i >= 0) { lost.splice(i, 1); won.splice(won.indexOf(type), 1); } }
  // Only name pieces when they account for the whole gain; otherwise the line's later moves change the picture.
  const worth = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const net = won.reduce((sum, type) => sum + worth[type], 0) - lost.reduce((sum, type) => sum + worth[type], 0);
  if (Math.abs(net - line.settledGain) > 0.5) return line.settledGain >= 2 ? `material worth about ${Math.round(line.settledGain)} pawns` : 'a pawn';
  if (won.length === 1 && won[0] === 'r' && lost.length === 1 && ['n', 'b'].includes(lost[0])) return 'the exchange (a rook, worth 5, for a minor piece, worth 3)';
  if (won.length === 1 && !lost.length && won[0] !== 'p') return article(won[0]);
  if (won.length === 1 && lost.length === 1) return `${article(won[0])} (${worthOf(won[0])}) for ${article(lost[0])} (${worthOf(lost[0])})`;
  const gain = line.settledGain;
  return gain >= 2 ? `material worth about ${Math.round(gain)} pawns` : 'a pawn';
}

// What a line wins for the side that starts it, as a short phrase about the loser's pieces.
export function consequence(line, loserOwner, start) {
  if (line.settledGain === Infinity) return 'with a forced mate';
  const key = keyMotif(line);
  const opening = line.plies[0];
  // A first-move capture of a piece standing there now is the point, even if the rest of the line gives some back.
  // But only when the piece is really lost: a capture that is answered by a recapture is a trade, not a win.
  const lostWorth = { n: 3, b: 3, r: 5, q: 9 }[opening?.captured];
  // A defended piece is never described as simply taken: readers assume it is free.
  const recapturable = opening?.captured && line.plies[1]?.to === opening.to && line.plies[1]?.captured;
  const defended = opening?.captured && new Chess(lineBoard(line, 1)).moves({ verbose: true }).some(move => move.to === opening.to && move.captured);
  if (opening?.captured && !defended && !recapturable && opening.color === line.side && new Chess(start).get(opening.to)?.type === opening.captured && lostWorth && line.settledGain >= lostWorth - 1) {
    return `taking ${loserOwner}${pieceNames[opening.captured]} on ${opening.to}${pawnBack(loserOwner, lostWorth, line.settledGain)}`;
  }
  // A defended piece that is still lost: name the capture, not a fork it happens to make, and say why the defence
  // fails: the piece is pinned to its king, or it has more attackers than defenders.
  if (opening?.captured && (defended || recapturable) && opening.color === line.side && new Chess(start).get(opening.to)?.type === opening.captured && lostWorth && line.settledGain >= lostWorth - 1) {
    return `taking ${loserOwner}${pieceNames[opening.captured]} on ${opening.to}${whyLost(start, opening.to, loserOwner)}`;
  }
  if (key?.motif === 'fork' && key.ply === 0 && line.settledGain >= 1) {
    const after = new Chess(lineBoard(line, 1));
    return `forking ${list(key.targets.map(square => named(after, square, loserOwner)))}`;
  }
  if (line.settledGain < 1) return '';
  // Name the captured piece only if it stands there now and the line really nets it, not a piece traded off
  // or one that only arrives on that square later in the line.
  const capture = line.plies.find(ply => ply.color === line.side && ply.captured);
  const standing = capture && new Chess(start).get(capture.to);
  const worth = { p: 1, n: 3, b: 3, r: 5, q: 9 }[capture?.captured];
  // The line may give something back for it: a pawn, or for a rook a minor piece (the exchange).
  const captureDefended = capture && new Chess(lineBoard(line, line.plies.indexOf(capture) + 1)).moves({ verbose: true }).some(move => move.to === capture.to && move.captured);
  if (capture && !captureDefended && standing?.type === capture.captured && line.settledGain >= worth - (capture.captured === 'r' ? 2 : 1)) {
    const back = worth - Math.round(line.settledGain);
    if (back === 2 && capture.captured === 'r') return `winning the exchange: ${loserOwner}rook on ${capture.to} (worth 5) for a minor piece (worth 3)`;
    return `winning ${loserOwner}${pieceNames[capture.captured]} on ${capture.to}${pawnBack(loserOwner, worth, line.settledGain)}`;
  }
  // Pieces captured later in the line may only get there during it, so keep the description general.
  return line.settledGain >= 2 ? 'winning material' : 'winning a pawn';
}
const times = n => n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
// Why a defended piece can still be won: ": it is pinned to your king by Black’s rook on e8, and it is attacked twice
// and defended once". Empty when neither a pin nor the count explains it.
export function whyLost(fen, square, owner) {
  const board = new Chess(fen);
  const piece = board.get(square);
  if (!piece) return '';
  const enemy = piece.color === 'w' ? 'b' : 'w', enemyOwner = owner === 'your ' ? 'Black’s ' : 'your ';
  const pin = pinnedBy(fen, square);
  const [attackers, defenders] = [board.attackers(square, enemy).length, board.attackers(square, piece.color).length];
  const count = attackers > defenders ? `it is attacked ${times(attackers)} and defended ${defenders ? times(defenders) : 'not at all'}` : '';
  if (pin) return `: it is pinned to ${owner}king by ${enemyOwner}${pieceNames[board.get(pin).type]} on ${pin}${count ? `, and ${count}` : ', so it cannot move away'}`;
  return count ? `: ${count}` : '';
}
// "is undefended" when nothing of its side guards the square; "can be taken for free" when a guard exists but
// cannot legally recapture (it is pinned, or it is the king and the square is covered).
export function looseWord(board, square) {
  const piece = board.get(square);
  return piece && board.attackers(square, piece.color).length ? 'can be taken for free' : 'is undefended';
}
export function lineBoard(line, plies) { return line.boards?.[plies - 1]; }

// Like lineMotifs, but also keeps the position after each ply so phrases can name the pieces there.
export function lineWithBoards(fen, sans, window = 4) {
  const line = lineMotifs(fen, sans, { window });
  const board = new Chess(fen);
  line.boards = [];
  for (const ply of line.plies) { board.move(ply.san); line.boards.push(board.fen()); }
  return line;
}

// The nudge for a chance to punish Black's mistake. It says what can be won and, where it helps, the idea or the
// piece to look at, but not the move itself.
function opportunity(fen, line) {
  if (line.settledGain === Infinity) return line.plies.length === 1 ? 'There is a mate in one.' : 'You have a forced mate.';
  const board = new Chess(fen);
  const first = line.plies[0];
  const key = keyMotif(line);
  // The most valuable black piece the line captures that stands on its square now: what the idea wins.
  // Only an immediate capture that the line's net gain covers counts: deeper searches often change later moves.
  const worth = { n: 3, b: 3, r: 5, q: 9 };
  const won = line.plies.slice(0, 1).filter(ply => ply.color === line.side && ply.captured && ply.captured !== 'p' && board.get(ply.to)?.type === ply.captured && board.get(ply.to)?.color === 'b'
    && line.settledGain >= worth[ply.captured] - 1)
    .sort((x, y) => ({ n: 3, b: 3, r: 5, q: 9 }[y.captured] - { n: 3, b: 3, r: 5, q: 9 }[x.captured]))[0];
  const target = won && `Black’s ${pieceNames[won.captured]} on ${won.to}`;
  if (first?.captured && key?.motif === 'hanging piece' && key.ply === 0) return `Black’s ${pieceNames[key.captured]} on ${key.square} ${looseWord(board, key.square)}.`;
  // A combination: the line gives material away first and wins more later. Saying only what is won at the end
  // ("you can win the bishop") hides the sacrifice that makes it work.
  const combo = combination(board, line);
  if (combo) return combo;
  const idea = key?.ply === 0 ? { fork: 'a fork', skewer: 'a skewer', pin: 'a pin', 'discovered attack': 'a discovered attack', 'discovered check': 'a discovered check', 'removes defender': 'removing a defender' }[key.motif] : null;
  // A tactic on the first move that wins something later: name the idea and the piece it wins, from the
  // line's net gain rather than a particular later capture.
  if (idea && target) return `Look for ${idea} that wins ${target}.`;
  if (idea && line.settledGain >= 2) return `Look for ${idea}: it wins ${materialPhrase(line)}.`;
  if (target && line.settledGain >= 2) return `You can win ${target}.`;
  if (key?.ply === 0 && (key.motif === 'promotion' || key.motif === 'advanced pawn')) return 'Your pawn can run for promotion.';
  if (key?.ply === 0 && key.motif === 'mate threat') return 'You can threaten mate.';
  // Otherwise point at the piece that makes the strong move, and whether it checks.
  const mover = board.get(first.from);
  // When the strong move also rescues a piece of yours that is in danger, say so: that is often its point.
  const rescued = piecesEnPrise(fen, 'w').find(entry => entry.square !== first.from && captureGain(first.after, entry.square, 'b') <= 0);
  const rescue = rescued ? `: it also ends the attack on your ${pinnedBy(fen, rescued.square) ? 'pinned ' : ''}${pieceNames[rescued.type]} on ${rescued.square}` : '';
  return `Your ${pieceNames[mover.type]} on ${first.from} has a strong move${first.san.includes('+') ? ', with check' : ''}${rescue}.`;
}

// A line that first gives away at least two points of material and still comes out ahead. Returns the most
// valuable piece it then wins that stands on its square now (or null), or false when the line is no sacrifice.
// The balance is read only after the side's own moves: halfway through an exchange (Black has taken, you are
// about to take back) nothing has been given up yet.
export function sacrifice(board, line) {
  if (!(line.settledGain >= 2) || line.settledGain === Infinity) return false;
  let balance = 0, low = 0, lowAt = -1;
  line.plies.forEach((ply, i) => {
    if (ply.captured) balance += (ply.color === line.side ? 1 : -1) * points[ply.captured];
    if (ply.color === line.side && i < line.plies.length - 1 && balance < low) { low = balance; lowAt = i; }
  });
  if (low > -2) return false;
  return line.plies.slice(lowAt + 1).filter(ply => ply.color === line.side && ply.captured && ply.captured !== 'p'
    && board.get(ply.to)?.type === ply.captured && board.get(ply.to)?.color !== line.side).sort((x, y) => points[y.captured] - points[x.captured])[0] ?? null;
}
// The tactic that finishes a line, as words: "a discovered check".
export const motifNames = { fork: 'a fork', skewer: 'a skewer', pin: 'a pin', 'discovered attack': 'a discovered attack', 'discovered check': 'a discovered check', 'removes defender': 'removing a defender', 'trapped piece': 'a trapped piece' };
export function combinationText(board, line) {
  const won = sacrifice(board, line);
  if (won === false) return null;
  const key = keyMotif(line), motif = key && motifNames[key.motif];
  const wins = won ? `wins Black’s ${pieceNames[won.captured]} on ${won.to}` : 'wins more back';
  return `There is a combination: it starts by giving up material, then ${motif ? `${motif} ` : ''}${wins}.`;
}
function combination(board, line) {
  const text = combinationText(board, line);
  return text && `${text.replace(/\.$/, '')}: you come out about ${pointWord(Math.round(line.settledGain))} ahead.`;
}

// One sentence on what to do in a quiet position, from slower-changing features.
export function plan(fen) {
  const board = new Chess(fen);
  const features = planFeatures(fen, 'w');
  const moveNumber = Number(fen.split(' ')[5]);
  if (moveNumber <= 14 && features.undeveloped.length >= 2) {
    return `Your ${list(features.undeveloped.map(square => `${pieceNames[board.get(square).type]} on ${square}`))} ${features.undeveloped.length > 1 ? 'are' : 'is'} still at home: give ${features.undeveloped.length > 1 ? 'one of them' : 'it'} a job.`;
  }
  // In an endgame the king and passed pawns matter more than castling or open files.
  const pieces = board.board().flat().filter(piece => piece && !['p', 'k'].includes(piece.type));
  const endgame = !pieces.some(piece => piece.type === 'q') && pieces.length <= 6 || pieces.length <= 4;
  if (endgame) {
    if (features.passed.length) return `Your passed pawn on ${features.passed.sort((a, b) => b[1] - a[1])[0]} is your trump: support its advance.`;
    return 'In the endgame your king is a fighting piece: bring it toward the centre.';
  }
  if (!features.castled && (features.canCastle.k || features.canCastle.q) && moveNumber <= 25) {
    // Only suggest castling now when it is legal now; otherwise the pieces in the way come first.
    const canNow = board.turn() === 'w' && board.moves().some(move => move.startsWith('O-O'));
    return canNow ? 'Your king is still in the centre: castling would make it safer and bring a rook into play.'
      : 'Your king is still in the centre: clear the pieces between it and a rook so you can castle.';
  }
  const rooks = board.board().flat().filter(piece => piece?.type === 'r' && piece.color === 'w').map(piece => piece.square[0]);
  const file = features.openFiles.find(f => !rooks.includes(f)) ?? features.halfOpenFiles.find(f => !rooks.includes(f));
  if (file) return `The ${file}-file is ${features.openFiles.includes(file) ? 'open' : 'half-open'}: a rook there would have more scope.`;
  return null;
}

// Plan advice for the turn comment, tied to the engine's own best move so it never points at a worse one.
// First the positional point of that move; then a general plan only when one of the engine's top moves (within
// half a pawn) carries it out; otherwise a neutral nudge.
export async function planNow(fen, now) {
  const best = now.variations[0];
  const first = new Chess(fen).move(best.steps[0].san);
  if (!first.san.endsWith('+')) {
    const point = await positionalPoint(fen, first, best.steps.map(step => step.san));
    if (point) return point.idea;
  }
  const text = plan(fen);
  if (text) {
    const top = scoreValue(best.score);
    const good = now.variations.filter(v => scoreValue(v.score) >= top - 50).map(v => new Chess(fen).move(v.steps[0].san));
    const fits = /castl/.test(text) ? good.some(m => m.flags.includes('k') || m.flags.includes('q') || (m.from[1] === '1' && ['n', 'b'].includes(m.piece)))
      : /-file is/.test(text) ? good.some(m => m.piece === 'r' && m.to[0] === text.match(/The (\w)-file/)[1])
      : /still at home/.test(text) ? good.some(m => ['n', 'b'].includes(m.piece) && m.from[1] === '1')
      : /passed pawn/.test(text) ? good.some(m => m.piece === 'p' && planFeatures(fen, 'w').passed.includes(m.from))
      : /endgame your king/.test(text) ? good.some(m => m.piece === 'k') : false;
    if (fits) return text;
  }
  return quietScan(fen, now);
}

// What one good move would do for its piece, without naming the move: "which could attack Black’s knight on e5".
function purpose(fen, move) {
  const board = new Chess(fen), after = new Chess(move.after);
  if (move.flags.includes('k') || move.flags.includes('q')) return 'castling would tuck your king away and bring a rook toward the centre';
  const effects = moveEffects(fen, move);
  const piece = move.piece === 'p' ? `your ${move.from[0]}-pawn` : `your ${pieceNames[move.piece]} on ${move.from}`;
  if (move.captured) return `${piece}, which could take Black’s ${pieceNames[move.captured]} on ${move.to}`;
  if (effects.attacks.length) return `${piece}, which could attack ${named(after, effects.attacks[0].square, 'Black’s ')}`;
  if (effects.defends.length) return `${piece}, which could defend your ${pieceNames[effects.defends[0].type]} on ${effects.defends[0].square}`;
  if (move.piece === 'k') return `${piece}, which could step toward the ${board.board().flat().some(p => p?.type === 'q') ? 'safety of the corner' : 'centre'}`;
  if (move.piece === 'p') {
    if (planFeatures(fen, 'w').passed.includes(move.from)) return `your passed ${move.from[0]}-pawn, which could run toward promotion`;
    // A pawn move often takes a square away from a Black piece that wants it: say which.
    const covered = ['-1', '1'].map(step => String.fromCharCode(move.to.charCodeAt(0) + Number(step)) + (Number(move.to[1]) + 1)).filter(sq => /^[a-h][1-8]$/.test(sq));
    let blackMoves = [];
    try { blackMoves = new Chess(withTurn(fen, 'b')).moves({ verbose: true }); } catch {}
    const denied = blackMoves.find(m => covered.includes(m.to) && m.piece !== 'p' && m.piece !== 'k');
    if (denied) return `${piece}, which could keep Black’s ${pieceNames[denied.piece]} on ${denied.from} out of ${denied.to}`;
    const pieces = board.board().flat().filter(p => p && !['p', 'k'].includes(p.type));
    if (pieces.length <= 6 && !pieces.some(p => p.type === 'q')) return `${piece}, which could start its advance toward promotion`;
    return `${piece}, which could take more space`;
  }
  if (effects.to >= effects.from + 2) return `${piece}, which has ${effects.from} ${effects.from === 1 ? 'move' : 'moves'} now and could have ${effects.to}`;
  return `${piece}, which could find a better square`;
}

// A quiet position with no named idea: a short scan of the board instead of a general reminder. It says whether
// anything of yours is in danger, names the pieces behind the engine's good moves (within half a pawn) and what
// each could do, without giving the move away, and ends with the question to ask about each candidate.
function quietScan(fen, now) {
  const top = scoreValue(now.variations[0].score);
  const good = now.variations.filter(v => v.steps[0] && scoreValue(v.score) >= top - 50).map(v => new Chess(fen).move(v.steps[0].san));
  // One candidate for each piece, so the list compares different ideas.
  const seen = new Set();
  const candidates = good.filter(move => !seen.has(move.from) && seen.add(move.from)).slice(0, 3).map(move => purpose(fen, move));
  const safe = !piecesEnPrise(fen, 'w').length;
  const second = now.variations[1];
  const clearlyBest = now.variations[0].score.type !== 'mate' && (!second || top - scoreValue(second.score) >= 100);
  return [
    `• A quiet position: ${safe ? 'none of your pieces can be won right now, so you have time to improve one' : 'first check which of your pieces are attacked'}.`,
    candidates.length > 1 ? `• Candidates worth comparing: ${candidates.slice(0, -1).join('; ')}; or ${candidates.at(-1)}.`
      : `• ${clearlyBest ? 'One move is clearly better than the rest. ' : ''}Start with ${candidates[0]}.`,
    `• ${candidates.length > 1 ? 'For each candidate, ask' : 'Before you move, ask'}: what does it attack or defend from its new square, and what does it stop guarding?`,
  ].join('\n');
}

// A good idea in your own move worth naming: a fork, pin, skewer, discovered attack, mate threat or trapped piece.
function goodIdea(white) {
  const board = new Chess(white.before);
  const motifs = moveMotifs(board, white);
  const after = new Chess(white.after);
  const pick = ['fork', 'skewer', 'pin', 'discovered check', 'discovered attack', 'mate threat'].map(name => motifs.find(m => m.motif === name)).find(Boolean);
  if (!pick || (pick.motif === 'pin' && pick.exploited)) return null;
  // An uncovered attack on a defended piece threatens nothing: taking it would cost more than it wins.
  if (pick.motif === 'discovered attack' && captureGain(withTurn(white.after, 'w'), pick.target, 'w') <= 0) return null;
  // A double attack on pawns is not worth a sentence; a fork needs two pieces of value, or the king.
  if (pick.motif === 'fork' && pick.targets.filter(square => ['k', 'n', 'b', 'r', 'q'].includes(after.get(square)?.type)).length < 2) return null;
  switch (pick.motif) {
    case 'fork': return `Your ${white.san} attacks ${list(pick.targets.map(square => named(after, square, 'Black’s ')))} at once.`;
    case 'skewer': return `Your ${white.san} skewers ${named(after, pick.front, 'Black’s ')} against the ${pieceNames[after.get(pick.behind)?.type]} on ${pick.behind}.`;
    case 'pin': return `Your ${white.san} pins ${named(after, pick.pinned, 'Black’s ')}${pick.absolute ? ' to the king' : ` to the ${pieceNames[after.get(pick.behind)?.type]} on ${pick.behind}`}.`;
    case 'discovered check': return `Your ${white.san} uncovers a check.`;
    case 'discovered attack': return `Your ${white.san} uncovers an attack on ${named(after, pick.target, 'Black’s ')}.`;
    case 'mate threat': return `Your ${white.san} threatens mate.`;
    default: return null;
  }
}

// Builds the turn comment. `white` and `black` are chess.js verbose moves; `analysis(fen)` returns engine
// analysis (the server passes its cached version).
export async function turnComment({ white, black }, analysis) {
  const fen = black.after;
  const board = new Chess(fen);
  const [beforeWhite, beforeBlack, now] = [await analysis(white.before), await analysis(black.before), await analysis(fen)];
  const bestWhite = scoreValue(beforeWhite.variations[0].score);
  const bestBlack = scoreValue(beforeBlack.variations[0].score);
  const nowCp = scoreValue(now.variations[0].score);
  const whiteLoss = Math.max(0, bestWhite + bestBlack);
  const blackLoss = Math.max(0, bestBlack + nowCp);
  const insights = [];

  // A forced mate for you outweighs everything else, whoever's mistake allowed it.
  const best = now.variations[0];
  const bestLine = lineWithBoards(fen, best.steps.map(step => step.san));
  if (best.score.type === 'mate' && best.score.value > 0 && (best.score.value === 1 || await mateConfirmed(fen, best.steps[0]))) {
    // Say whether the mate starts with a check, since a quiet first move is the hard part to find.
    const first = new Chess(fen).move(best.steps[0].san);
    // When several checks are possible, say which piece gives the right one: the wrong check can throw the mate away.
    const checks = new Chess(fen).moves({ verbose: true }).filter(move => move.san.endsWith('+') || move.san.endsWith('#'));
    const checkText = checks.length > 1 ? `a check by your ${pieceNames[first.piece]}` : 'a check';
    const text = best.score.value === 1 ? 'There is a mate in one.'
      : `You have a forced mate in ${best.score.value}, starting with ${first.san.endsWith('+') ? checkText : first.captured ? 'a capture' : 'a quiet move'}.`;
    insights.push({ kind: 'opportunity', priority: 0, text: blackLoss >= 150 ? `Black’s ${black.san} was a mistake. ${text}` : text, evidence: { mate: best.score.value } });
    return finish(insights);
  }

  // Check, or Black's threat (a mate, or material Black wins if you ignore it).
  const threat = await threatsBy(fen, 'b', { currentCp: nowCp });
  const threatLine = threat && lineWithBoards(withTurn(fen, 'b'), threat.line);
  if (board.isCheck()) {
    const checker = board.attackers(board.board().flat().find(p => p?.type === 'k' && p.color === 'w').square, 'b')[0];
    insights.push({ kind: 'check', priority: 0, text: `You are in check from ${named(board, checker, 'Black’s ')}.` });
  } else if (threat?.mate) {
    insights.push({ kind: 'threat', priority: 0, text: `Black threatens mate, starting with ${threat.move}.`, evidence: threat });
  } else if (threat && !(nowCp >= 300 && (threat.materialGain ?? 0) < 2)) {
    // When you are clearly winning, a pawn is not worth a warning; a piece or more still is.
    const what = consequence(threatLine, 'your ', fen);
    const second = threat.others?.[0];
    const secondWhat = second && consequence(lineWithBoards(withTurn(fen, 'b'), second.line), 'your ', fen);
    // A second threat gets its own sentence, so a reason after the first one stays readable.
    const also = second ? ` Black also threatens ${second.move}${secondWhat ? `, ${secondWhat}` : ''}.` : '';
    insights.push({ kind: 'threat', priority: 2, text: `Black threatens ${threat.move}${what ? `, ${what}` : ''}.${also}`, evidence: threat });
  }

  // Black's mistake: the best line now wins at least two pawns' worth, or the evaluation jumped to a clear edge.
  // A capture of something you left loose is rarely Black's mistake, so it needs a larger loss to be called one.
  const threshold = black.captured ? 250 : 150;
  // Taking what your own move left en prise is not Black's mistake, whatever a shallow search says.
  const tookYourPiece = black.captured && black.to === white.to;
  if (!tookYourPiece && blackLoss >= threshold && (bestLine.settledGain >= 2 || (blackLoss >= Math.max(200, threshold) && nowCp >= 120))) {
    const longer = lineWithBoards(fen, best.steps.map(step => step.san), 6);
    const text = opportunity(fen, longer);
    insights.push({ kind: 'opportunity', priority: 1, text: `Black’s ${black.san} was a mistake. ${text}`, evidence: { blackLoss, line: longer.plies.map(p => p.san), rescue: /ends the attack on your/.test(text) } });
  }

  // Material you can win now, even when Black's last move was not the mistake (you may have missed it last turn,
  // or Black is already lost). Plan advice must never hide it. A small or late win is confirmed by a deeper search.
  // Taking back what Black just took is not a win: the recapture note below covers it.
  const retakes = black.captured && best.steps[0].to === black.to;
  if (!insights.some(i => i.kind === 'opportunity') && !board.isCheck() && best.score.type !== 'mate' && !retakes) {
    let longer = lineWithBoards(fen, best.steps.map(step => step.san), 6);
    let gain = longer.settledGain;
    if (gain >= 1.5 && gain !== Infinity && gain < 3) {
      const deeper = (await analyse(fen, { depth: 18, plies: 8, rootMove: best.steps[0].uci })).variations[0];
      if (deeper) { longer = lineWithBoards(fen, deeper.steps.map(step => step.san), 6); gain = Math.min(gain, longer.settledGain); }
    }
    if (gain >= 2 && gain !== Infinity) {
      insights.push({ kind: 'opportunity', priority: 1, text: opportunity(fen, longer), evidence: { gain, line: longer.plies.map(p => p.san) }, available: true });
    }
  }

  // When Black's mistake hands you more than Black's threat would win, the threat is not the point.
  const chance = insights.find(i => i.kind === 'opportunity');
  const lesser = insights.findIndex(i => i.kind === 'threat' && !i.evidence?.mate && chance && (i.evidence?.materialGain ?? 0) < Math.min(bestLine.settledGain, 9));
  if (lesser >= 0) insights.splice(lesser, 1);

  // Your own move: a mistake, said either as how Black can punish it or as what you missed.
  // In a position that stays clearly won, a slightly slower win is not a mistake worth interrupting for.
  const stillWinning = -bestBlack >= 300;
  if (whiteLoss >= (stillWinning ? 300 : 150)) {
    const refutation = beforeBlack.variations[0].steps.map(step => step.san);
    const what = consequence(lineWithBoards(black.before, refutation), 'your ', black.after);
    // What your move led to in the engine's line, so the better move is only credited with what it adds.
    const played = lineWithBoards(white.before, [white.san, ...beforeBlack.variations[0].steps.map(step => step.san)], 6);
    const first = beforeWhite.variations[0];
    const mateHolds = first.score.type !== 'mate' || first.score.value === 1 || await mateConfirmed(white.before, first.steps[0]);
    const stronger = missed(white.before, mateHolds ? first : { ...first, score: { type: 'cp', value: 0 } }, played.settledGain, whiteLoss);
    const text = what
      ? `Your ${white.san} was a ${whiteLoss >= 300 ? 'blunder' : 'mistake'}: Black ${refutation[0] === black.san ? 'answered' : 'could answer'} ${refutation[0]}, ${what}. ${stronger}`
      : stronger.includes(' was stronger') ? `Your ${white.san} was a ${whiteLoss >= 300 ? 'blunder' : 'mistake'}: ${stronger}`
      : `Your ${white.san} missed a stronger move: ${stronger}`;
    insights.push({ kind: 'your mistake', priority: 3, text, evidence: { whiteLoss, refutation } });
  }

  // Black just captured and you can win the material back: the obvious move still needs saying.
  if (black.captured && !board.isCheck()) {
    // The engine's first choice, or another of its top moves within half a pawn of it; a recapture that is much
    // worse is not suggested. When something stronger wins material, the opportunity above says so.
    const top = nowCp;
    const good = now.variations.filter(v => scoreValue(v.score) >= top - 50).map(v => v.steps[0].san);
    const regain = new Chess(fen).moves({ verbose: true }).find(move => move.to === black.to && move.captured && good.includes(move.san));
    const stronger = insights.find(i => i.kind === 'opportunity' && i.available);
    if (regain && !stronger) {
      // What the recapture nets in points, so trades are counted every time they happen.
      const lost = black.captured, got = regain.captured;
      const tally = points[got] === points[lost] ? `${lost === got ? `${article(got)} for ${article(lost)}` : `${article(got)} for ${article(lost)}, both worth ${points[got]}`}: an even trade`
        : points[got] > points[lost] ? `you come out ${pointWord(points[got] - points[lost])} ahead (${article(got)}, ${worthOf(got)}, for ${article(lost)}, ${worthOf(lost)})`
        : `that gets back ${points[got]} of the ${pointWord(points[lost])} your ${pieceNames[lost]} was worth`;
      insights.push({ kind: 'recapture', priority: 1, text: `Black took your ${pieceNames[lost]} on ${black.to}: you can recapture with ${regain.san}, ${tally}.`, evidence: { square: black.to } });
    }
    else if (stronger && new Chess(fen).moves({ verbose: true }).some(move => move.to === black.to && move.captured)) {
      stronger.text = `Black took on ${black.to}. You can take back, but look for something stronger first. ${stronger.text}`;
    }
  }

  // A trade you started and Black completed: count it in points, so piece values become second nature.
  if (white.captured && black.captured && black.to === white.to && black.captured !== 'k') {
    const got = white.captured, gave = black.captured;
    const losing = points[got] < points[gave];
    const pair = `your ${pieceNames[gave]} for Black’s ${pieceNames[got]}`, valued = `your ${pieceNames[gave]} (${worthOf(gave)}) for Black’s ${pieceNames[got]} (${worthOf(got)})`;
    const diff = Math.abs(points[got] - points[gave]);
    const text = points[got] === points[gave] ? `You traded ${pair}${got === gave ? '' : `, both worth ${points[got]}`}: an even trade.`
      : !losing ? `You traded ${valued}: you come out ${pointWord(diff)} ahead.`
      : whiteLoss < 80 ? `You gave ${valued}: ${pointWord(diff)} less in material, but the position makes up for it.`
      : `You gave ${valued}: that trade cost you ${pointWord(diff)}.`;
    insights.push({ kind: 'trade', priority: losing && whiteLoss >= 80 ? 3.5 : 4.8, text, evidence: { got, gave } });
  }

  // A tactic in Black's move aimed at your pieces: a pin, fork, skewer or uncovered attack.
  // An uncovered attack on a piece that is defended well enough is no threat, and naming it only alarms.
  const blackIdea = moveMotifs(new Chess(black.before), black).find(motif => ['pin', 'fork', 'skewer', 'discovered attack'].includes(motif.motif) && !motif.exploited
    && (motif.motif !== 'discovered attack' || captureGain(withTurn(fen, 'b'), motif.target, 'b') > 0));
  if (blackIdea) {
    const after = new Chess(fen);
    const text = blackIdea.motif === 'pin' ? `Black’s ${black.san} pins ${named(after, blackIdea.pinned, 'your ')}${blackIdea.absolute ? ' to your king' : ` to your ${pieceNames[after.get(blackIdea.behind)?.type]}`}.`
      : blackIdea.motif === 'fork' ? `Black’s ${black.san} attacks ${list(blackIdea.targets.map(square => named(after, square, 'your ')))} at once.`
      : blackIdea.motif === 'skewer' ? `Black’s ${black.san} skewers ${named(after, blackIdea.front, 'your ')}.`
      : `Black’s ${black.san} uncovers an attack on ${named(after, blackIdea.target, 'your ')}.`;
    insights.push({ kind: 'black idea', priority: 4.5, text, evidence: blackIdea });
  }

  // A piece of yours that can be taken, unless the threat above already covers it.
  // The pass search is the better judge of what can really be lost, so a loose piece is only mentioned when it
  // confirms a threat; a pawn that a tactic would win back is not called loose.
  const covered = new Set([threat?.to, ...(threat?.others ?? []).map(other => other.to), ...(threatLine?.plies.filter(ply => ply.color === 'b' && ply.captured).map(ply => ply.to) ?? [])]);
  const exposed = threat && !board.isCheck() && piecesEnPrise(fen, 'w').find(entry => !covered.has(entry.square) && entry.type !== 'p');
  if (exposed) {
    insights.push({ kind: 'en prise', priority: 4, text: `Your ${pieceNames[exposed.type]} on ${exposed.square} can be taken: it has ${exposed.defenders.length ? 'too few defenders' : 'no defender'}.`, evidence: exposed });
  }
  if (whiteLoss < 80) {
    const idea = goodIdea(white);
    if (idea) insights.push({ kind: 'good idea', priority: 5, text: idea });
  }
  if (!insights.length) insights.push({ kind: 'plan', priority: 6, text: await planNow(fen, now) });
  return finish(insights);
}

// What the engine's best move would have achieved, for a move that missed it.
// A long mate found at the usual depth sometimes disappears two plies deeper, so a mate is only announced once a
// deeper search starting with the same move still finds it. A mate in one is checked by the rules already.
export async function mateConfirmed(fen, step) {
  const deeper = (await analyse(fen, { depth: 18, rootMove: step.uci ?? step.from + step.to + (step.promotion ?? '') })).variations[0];
  return deeper?.score.type === 'mate' && deeper.score.value > 0;
}

function missed(fen, variation, playedGain = 0, lossCp = Infinity) {
  // Six plies, so a capture that is answered by a recapture two moves later is not reported as a clean win.
  const line = lineWithBoards(fen, variation.steps.map(step => step.san), 6);
  const best = line.plies[0]?.san;
  if (variation.score.type === 'mate' && variation.score.value > 0) return variation.score.value === 1 ? `${best} was checkmate.` : `${best} started a forced mate.`;
  const key = keyMotif(line);
  const before = new Chess(fen);
  if (key?.ply === 0 && key.motif === 'hanging piece') return `${best} would have won Black’s ${pieceNames[key.captured]} on ${key.square}.`;
  if (key?.ply === 0 && key.motif === 'fork') {
    const after = new Chess(lineBoard(line, 1));
    return `${best} would have forked ${list(key.targets.map(square => named(after, square, 'Black’s ')))}.`;
  }
  // The line is the engine's guess at best play, so say so rather than promising the material.
  // Credit material only when the evaluation gap is about as large: otherwise your move wins much of it too.
  if (line.settledGain >= 1 && line.settledGain - playedGain >= 2 && lossCp >= (line.settledGain - 1) * 100) return `${best} was stronger; in the engine’s line it wins ${materialPhrase(line)}.`;
  return `${best} was stronger.`;
}

function finish(insights) {
  // Two points at most, so the comment can be read at a glance.
  const chosen = insights.sort((a, b) => a.priority - b.priority).slice(0, 2);
  // Tell the story in move order: your move, Black's reply, then what to watch now.
  const order = { 'your mistake': 0, 'good idea': 0, trade: 0.5, recapture: 1, opportunity: 1, 'black idea': 1, check: 2, threat: 2, 'en prise': 3, plan: 4 };
  // A strong move that rescues a threatened piece reads best after the threat it answers.
  const place = insight => order[insight.kind] + (insight.evidence?.rescue ? 1.5 : 0);
  chosen.sort((a, b) => place(a) - place(b));
  const titles = { check: 'You are in check', threat: 'Watch Black’s threat', opportunity: lead => lead.available ? 'Material to win' : 'Black slipped', recapture: 'Take back', 'black idea': 'Black’s idea', 'your mistake': 'Your move had a flaw', 'en prise': 'A piece is loose', 'good idea': 'Good idea', trade: 'Count the trade', plan: 'Your next step' };
  const lead = insights.sort((a, b) => a.priority - b.priority)[0];
  const title = typeof titles[lead.kind] === 'function' ? titles[lead.kind](lead) : titles[lead.kind];
  return { title: lead.evidence?.mate ? 'Mate is available' : title, explanation: chosen.map(i => i.text).join(' '), question: '', steps: [], insights: chosen.map(({ kind, evidence }) => ({ kind, evidence })) };
}

