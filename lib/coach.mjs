// Turn commentary built from the analysis layer: after Black replies, say what matters most, in up to three
// sentences, without a model call. Selection follows a coach's checklist: check or a mate threat first, then a
// mistake by Black that can be punished, then Black's threat, then a mistake in your own move, then a piece of
// yours that can be taken, then a good idea in your move, and only when nothing else applies, a plan.
import { Chess } from 'chess.js';
import { scoreValue } from './engine.mjs';
import { keyMotif, lineMotifs, moveMotifs, pieceNames, piecesEnPrise, planFeatures, threatsBy, withTurn } from './analysis.mjs';

const list = items => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '';
const named = (board, square, owner) => { const piece = board.get(square); return piece ? `${owner}${pieceNames[piece.type]} on ${square}` : square; };
const article = type => (type === 'p' ? 'a pawn' : `a ${pieceNames[type]}`);

// What a line nets for the side that starts it, named by the pieces that change hands in its first four plies:
// "a knight", "the exchange", "a bishop for a pawn". Falls back to a count of pawns when nothing clearer fits.
function materialPhrase(line) {
  if (line.settledGain === Infinity) return 'a forced mate';
  const window = line.plies.slice(0, 4);
  const won = window.filter(ply => ply.color === line.side && ply.captured).map(ply => ply.captured);
  const lost = window.filter(ply => ply.color !== line.side && ply.captured).map(ply => ply.captured);
  for (const type of [...won]) { const i = lost.indexOf(type); if (i >= 0) { lost.splice(i, 1); won.splice(won.indexOf(type), 1); } }
  // Only name pieces when they account for the whole gain; otherwise the line's later moves change the picture.
  const worth = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const net = won.reduce((sum, type) => sum + worth[type], 0) - lost.reduce((sum, type) => sum + worth[type], 0);
  if (Math.abs(net - line.settledGain) > 0.5) return line.settledGain >= 2 ? `material worth about ${Math.round(line.settledGain)} pawns` : 'a pawn';
  if (won.length === 1 && won[0] === 'r' && lost.length === 1 && ['n', 'b'].includes(lost[0])) return 'the exchange (a rook for a minor piece)';
  if (won.length === 1 && !lost.length && won[0] !== 'p') return article(won[0]);
  if (won.length === 1 && lost.length === 1) return `${article(won[0])} for ${article(lost[0])}`;
  const gain = line.settledGain;
  return gain >= 2 ? `material worth about ${Math.round(gain)} pawns` : 'a pawn';
}

// What a line wins for the side that starts it, as a short phrase about the loser's pieces.
function consequence(line, loserOwner, start) {
  if (line.settledGain === Infinity) return 'with a forced mate';
  const key = keyMotif(line);
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
  if (capture && standing?.type === capture.captured && line.settledGain >= worth - 2) {
    // The line may give something back for it: a pawn, or a minor piece for a rook.
    const back = worth - Math.round(line.settledGain);
    return `winning ${loserOwner}${pieceNames[capture.captured]} on ${capture.to}${back === 1 ? ' for a pawn' : back === 2 ? ' for a minor piece' : ''}`;
  }
  // A first-move capture of a piece standing there now is the point, even if the rest of the line gives some back.
  const opening = line.plies[0];
  if (opening?.captured && opening.color === line.side && new Chess(start).get(opening.to)?.type === opening.captured && opening.captured !== 'p' && line.settledGain >= 2) {
    return `taking ${loserOwner}${pieceNames[opening.captured]} on ${opening.to}`;
  }
  // Pieces captured later in the line may only get there during it, so keep the description general.
  return line.settledGain >= 2 ? 'winning material' : 'winning a pawn';
}
function lineBoard(line, plies) { return line.boards?.[plies - 1]; }

// Like lineMotifs, but also keeps the position after each ply so phrases can name the pieces there.
function lineWithBoards(fen, sans, window = 4) {
  const line = lineMotifs(fen, sans, { window });
  const board = new Chess(fen);
  line.boards = [];
  for (const ply of line.plies) { board.move(ply.san); line.boards.push(board.fen()); }
  return line;
}

// The nudge for a chance to punish Black's mistake. It names the target and the idea, not the move.
function opportunity(fen, line) {
  if (line.settledGain === Infinity) return line.plies.length === 1 ? 'There is a mate in one.' : 'You have a forced mate.';
  const key = keyMotif(line);
  const board = new Chess(fen);
  switch (key?.motif) {
    case 'hanging piece': return `Black’s ${pieceNames[key.captured]} on ${key.square} is undefended.`;
    case 'wins material': return `You can win material on ${key.square}.`;
    case 'fork': {
      const after = new Chess(lineBoard(line, key.ply + 1));
      const targets = key.targets.filter(square => after.get(square)?.type !== 'p');
      const king = key.targets.find(square => after.get(square)?.type === 'k');
      const others = key.targets.filter(square => square !== king);
      if (king && targets.length < 2) return `Look for a check that also attacks ${list(others.map(square => named(after, square, 'Black’s ')))}.`;
      return `Look for a fork: one of your pieces can attack ${list((targets.length >= 2 ? targets : key.targets).map(square => named(after, square, 'Black’s ')))} at once.`;
    }
    case 'pin': return `Black’s ${pieceNames[board.get(key.pinned)?.type] ?? 'piece'} on ${key.pinned} is pinned${key.absolute ? ' to the king' : ''}.`;
    case 'skewer': return `Black’s pieces on ${key.front} and ${key.behind} stand on one line: look for a skewer.`;
    case 'discovered attack': case 'discovered check': return `Moving one of your pieces can uncover an attack on Black’s ${key.motif === 'discovered check' ? 'king' : pieceNames[board.get(key.target)?.type] ?? 'piece'}.`;
    case 'removes defender': return `Capturing on ${key.square} removes a defender.`;
    case 'mate threat': return 'You can threaten mate.';
    case 'promotion': case 'advanced pawn': return 'Your pawn can run for promotion.';
    default: return `You can win ${materialPhrase(line)}.`;
  }
}

// One sentence on what to do in a quiet position, from slower-changing features.
function plan(fen) {
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
  if (!features.castled && (features.canCastle.k || features.canCastle.q) && moveNumber <= 25) return 'Your king is still in the centre: castling would make it safer and bring a rook into play.';
  const rooks = board.board().flat().filter(piece => piece?.type === 'r' && piece.color === 'w').map(piece => piece.square[0]);
  const file = features.openFiles.find(f => !rooks.includes(f)) ?? features.halfOpenFiles.find(f => !rooks.includes(f));
  if (file) return `The ${file}-file is ${features.openFiles.includes(file) ? 'open' : 'half-open'}: a rook there would have more scope.`;
  if (features.leastActive) return `Your ${pieceNames[features.leastActive.type]} on ${features.leastActive.square} has the fewest moves: look for a better square for it.`;
  return 'Improve your least active piece.';
}

// A good idea in your own move worth naming: a fork, pin, skewer, discovered attack, mate threat or trapped piece.
function goodIdea(white) {
  const board = new Chess(white.before);
  const motifs = moveMotifs(board, white);
  const after = new Chess(white.after);
  const pick = ['fork', 'skewer', 'pin', 'discovered check', 'discovered attack', 'mate threat'].map(name => motifs.find(m => m.motif === name)).find(Boolean);
  if (!pick || (pick.motif === 'pin' && pick.exploited)) return null;
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
  if (best.score.type === 'mate' && best.score.value > 0) {
    // Say whether the mate starts with a check, since a quiet first move is the hard part to find.
    const first = new Chess(fen).move(best.steps[0].san);
    const text = best.score.value === 1 ? 'There is a mate in one.'
      : `You have a forced mate in ${best.score.value}, starting with ${first.san.endsWith('+') ? 'a check' : 'a quiet move'}.`;
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
  } else if (threat) {
    const what = consequence(threatLine, 'your ', fen);
    insights.push({ kind: 'threat', priority: 2, text: `Black threatens ${threat.move}${what ? `, ${what}` : ''}.`, evidence: threat });
  }

  // Black's mistake, if the best line now wins at least two pawns' worth.
  if (blackLoss >= 150 && bestLine.settledGain >= 2) {
    insights.push({ kind: 'opportunity', priority: 1, text: `Black’s ${black.san} was a mistake. ${opportunity(fen, bestLine)}`, evidence: { blackLoss, line: bestLine.plies.map(p => p.san) } });
  } else if (blackLoss >= 200 && nowCp >= 120) {
    // The gain is positional or lies deeper than four plies: say so without inventing a reason.
    insights.push({ kind: 'opportunity', priority: 1, text: `Black’s ${black.san} was a mistake: you now have ${nowCp >= 300 ? 'a winning' : 'a clear'} advantage. Look for forcing moves: checks, captures and threats.`, evidence: { blackLoss } });
  }

  // Your own move: a mistake, said either as how Black can punish it or as what you missed.
  if (whiteLoss >= 150) {
    const refutation = beforeBlack.variations[0].steps.map(step => step.san);
    const what = consequence(lineWithBoards(black.before, refutation), 'your ', black.after);
    const stronger = missed(white.before, beforeWhite.variations[0]);
    const text = what
      ? `Your ${white.san} was a ${whiteLoss >= 300 ? 'blunder' : 'mistake'}: Black ${refutation[0] === black.san ? 'answered' : 'could answer'} ${refutation[0]}, ${what}. ${stronger}`
      : stronger.endsWith(' was stronger.') ? `Your ${white.san} was a ${whiteLoss >= 300 ? 'blunder' : 'mistake'}: ${stronger}`
      : `Your ${white.san} missed a stronger move: ${stronger}`;
    insights.push({ kind: 'your mistake', priority: 3, text, evidence: { whiteLoss, refutation } });
  }

  // Black just captured and you can win the material back: the obvious move still needs saying.
  if (black.captured && !board.isCheck()) {
    const regain = new Chess(fen).moves({ verbose: true }).filter(move => move.to === black.to && move.captured)
      .find(move => move.san === best.steps[0].san || best.steps[0].to === black.to);
    if (regain) insights.push({ kind: 'recapture', priority: 1, text: `Black took on ${black.to}: you can recapture with ${regain.san}.`, evidence: { square: black.to } });
  }

  // A tactic in Black's move aimed at your pieces: a pin, fork, skewer or uncovered attack.
  const blackIdea = moveMotifs(new Chess(black.before), black).find(motif => ['pin', 'fork', 'skewer', 'discovered attack'].includes(motif.motif) && !motif.exploited);
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
  const covered = new Set([threat?.to, ...(threatLine?.plies.filter(ply => ply.color === 'b' && ply.captured).map(ply => ply.to) ?? [])]);
  const exposed = threat && !board.isCheck() && piecesEnPrise(fen, 'w').find(entry => !covered.has(entry.square) && entry.type !== 'p');
  if (exposed) {
    insights.push({ kind: 'en prise', priority: 4, text: `Your ${pieceNames[exposed.type]} on ${exposed.square} can be taken: it has ${exposed.defenders.length ? 'too few defenders' : 'no defender'}.`, evidence: exposed });
  }
  if (whiteLoss < 80) {
    const idea = goodIdea(white);
    if (idea) insights.push({ kind: 'good idea', priority: 5, text: idea });
  }
  if (!insights.length) insights.push({ kind: 'plan', priority: 6, text: plan(fen) });
  return finish(insights);
}

// What the engine's best move would have achieved, for a move that missed it.
function missed(fen, variation) {
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
  if (line.settledGain >= 1) return `${best} would have won ${materialPhrase(line)}.`;
  return `${best} was stronger.`;
}

function finish(insights) {
  // Two points at most, so the comment can be read at a glance.
  const chosen = insights.sort((a, b) => a.priority - b.priority).slice(0, 2);
  // Tell the story in move order: your move, Black's reply, then what to watch now.
  const order = { 'your mistake': 0, 'good idea': 0, recapture: 1, opportunity: 1, 'black idea': 1, check: 2, threat: 2, 'en prise': 3, plan: 4 };
  chosen.sort((a, b) => order[a.kind] - order[b.kind]);
  const titles = { check: 'You are in check', threat: 'Watch Black’s threat', opportunity: 'Black slipped', recapture: 'Take back', 'black idea': 'Black’s idea', 'your mistake': 'Your move had a flaw', 'en prise': 'A piece is loose', 'good idea': 'Good idea', plan: 'Your next step' };
  const lead = insights.sort((a, b) => a.priority - b.priority)[0];
  return { title: lead.evidence?.mate ? 'Mate is available' : titles[lead.kind], explanation: chosen.map(i => i.text).join(' '), question: '', steps: [], insights: chosen.map(({ kind, evidence }) => ({ kind, evidence })) };
}

