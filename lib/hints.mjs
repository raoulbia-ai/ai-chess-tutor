// Levelled hints built from the analysis layer, without a model call. A hint says what to look for before it
// says which move to play:
//   level 1  the situation and the idea (a mate, Black's threat, material to win, a plan), never the move
//   level 2  the piece to use, the target, or the kind of answer (move away, defend, capture the attacker)
//   level 3  the move, why it works, and the engine's line when that line wins something
// Each level repeats the earlier ones, so the panel always holds the whole hint so far.
import { Chess } from 'chess.js';
import { analyse, scoreValue } from './engine.mjs';
import { captureGain, keyMotif, lineMotifs, moveMotifs, pieceNames, planFeatures, threatsBy, values, withTurn } from './analysis.mjs';
import { consequence, lineWithBoards, list, looseWord, materialPhrase, mateConfirmed, named, plan } from './coach.mjs';
import { positionalPoint } from './positional.mjs';

export const hintLevels = 3;
const cp = variation => scoreValue(variation.score);
const ideas = { fork: 'a fork', skewer: 'a skewer', pin: 'a pin', 'discovered attack': 'a discovered attack', 'discovered check': 'a discovered check', 'removes defender': 'a way to remove a defender' };
const centre = ['d4', 'e4', 'd5', 'e5'];

// "16.Nxb6 Rxc1+ 17.Bxc1": moves with numbers, so a line can be followed on a board.
function numbered(fen, sans) {
  let number = Number(fen.split(' ')[5]), turn = fen.split(' ')[1];
  return sans.map((san, i) => {
    const text = turn === 'w' ? `${number}.${san}` : i === 0 ? `${number}…${san}` : san;
    if (turn === 'b') number++;
    turn = turn === 'w' ? 'b' : 'w';
    return text;
  }).join(' ');
}

// How many plies of a line show the point: up to the first White ply where the line's gain (within a pawn) is
// banked, plus Black's immediate recapture if there is one, so the line ends where the material settles.
function pointLength(line, gain) {
  const plies = line.plies.slice(0, 6);
  for (let i = 0; i < plies.length; i++) {
    // The gain must still be there for the rest of the window, so a capture Black answers by taking more is not the end.
    if (plies[i].color !== line.side || plies.slice(i).some(ply => ply.material < gain - 1)) continue;
    return i + 1;
  }
  return 1;
}

// The pieces a fork really hits: pawns only count when fewer than two pieces (or the king) are attacked.
function forkTargets(after, fork) {
  const pieces = fork.targets.filter(square => after.get(square)?.type !== 'p');
  return pieces.length >= 2 ? pieces : fork.targets;
}

function realFork(after, fork) { return fork.targets.filter(square => after.get(square)?.type !== 'p').length >= 2; }

// What one move does by itself, as a clause after the move: "forks Black’s queen on d8 and rook on a8".
function moveReason(fen, move, { recaptured = true } = {}) {
  const after = new Chess(move.after);
  const motifs = moveMotifs(new Chess(fen), move);
  const find = name => motifs.find(m => m.motif === name && !m.exploited);
  const fork = find('fork');
  if (find('checkmate') || find('back-rank mate')) return 'is checkmate';
  if (fork && realFork(after, fork)) return `forks ${list(forkTargets(after, fork).map(square => named(after, square, 'Black’s ')))}`;
  const hanging = find('hanging piece');
  if (hanging) return looseWord(new Chess(fen), hanging.square) === 'is undefended' ? `takes the undefended ${pieceNames[hanging.captured]} on ${hanging.square}` : `wins the ${pieceNames[hanging.captured]} on ${hanging.square}${move.san.endsWith('+') ? ' with check' : ''}`;
  // A capture that is answered by a recapture is a trade; its point is what the trade removes, not a pin.
  const removes = find('removes defender');
  if (move.captured && removes) return `removes the defender of ${named(new Chess(fen), removes.exposed, 'Black’s ')}`;
  if (move.flags.includes('k') || move.flags.includes('q')) {
    const rook = move.flags.includes('k') ? 'f1' : 'd1';
    const hit = after.board().flat().filter(p => p?.color === 'b' && p.type !== 'p' && after.attackers(p.square, 'w').includes(rook));
    return hit.length ? `brings your rook to ${rook}, where it attacks ${list(hit.map(p => named(after, p.square, 'Black’s ')))}` : '';
  }
  // Taking a piece worth as much as the mover is a trade: say so rather than naming a pin the trade happens to make.
  if (move.captured && values[move.captured] >= values[move.piece] && recaptured) {
    return move.captured === move.piece ? `trades ${pieceNames[move.piece]}s on ${move.to}` : `takes Black’s ${pieceNames[move.captured]} on ${move.to}`;
  }
  const skewer = find('skewer');
  if (skewer) return `skewers ${named(after, skewer.front, 'Black’s ')} against the ${pieceNames[after.get(skewer.behind)?.type]} on ${skewer.behind}`;
  const pin = find('pin');
  if (pin) return `pins ${named(after, pin.pinned, 'Black’s ')}${pin.absolute ? ' to the king' : ` to the ${pieceNames[after.get(pin.behind)?.type]} on ${pin.behind}`}`;
  const discovered = find('discovered check') ?? find('discovered attack');
  if (discovered) return discovered.motif === 'discovered check' ? 'uncovers a check' : `uncovers an attack on ${named(after, discovered.target, 'Black’s ')}`;
  const trapped = find('trapped piece');
  if (trapped) return `traps ${named(after, trapped.target, 'Black’s ')}`;
  if (find('mate threat')) return 'threatens mate';
  const wins = find('wins material');
  if (wins) return `wins material on ${wins.square}`;
  if (move.promotion) return `promotes to a ${pieceNames[move.promotion]}`;
  return '';
}

// The most valuable black piece standing on its square now that the line wins outright: the target to name.
function wonTarget(fen, line) {
  const board = new Chess(fen);
  return line.plies.slice(0, 5).filter(ply => ply.color === line.side && ply.captured && ply.captured !== 'p'
    && board.get(ply.to)?.type === ply.captured && board.get(ply.to)?.color === 'b' && line.settledGain >= values[ply.captured] - 1)
    .sort((x, y) => values[y.captured] - values[x.captured])[0] ?? null;
}

// Builds every level of the hint for White to move in `fen`. `analysis(fen)` returns engine analysis (the server
// passes its cached version); `lastMove` is Black's last move as a chess.js verbose move, when there is one.
export async function hintLesson(fen, analysis, { lastMove } = {}) {
  const board = new Chess(fen);
  const now = await analysis(fen);
  const best = now.variations[0];
  const nowCp = cp(best);
  const sans = best.steps.map(step => step.san);
  const first = new Chess(fen).move(sans[0]);
  const piece = first.piece === 'p' ? `your ${first.from[0]}-pawn` : `your ${pieceNames[first.piece]} on ${first.from}`;
  const line = lineWithBoards(fen, sans, 4);
  let longer = lineWithBoards(fen, sans, 6);
  // Other moves are only offered as "about as good" when they are very close and the position is not already decided:
  // a deeper search often separates moves the usual depth rates alike.
  const alternatives = best.score.type === 'mate' || Math.abs(nowCp) >= 300 ? [] : now.variations.slice(1).filter(v => v.steps[0] && nowCp - cp(v) <= 20).map(v => v.steps[0].san);
  const also = alternatives.length ? ` ${list(alternatives)} ${alternatives.length > 1 ? 'are' : 'is'} about as good.` : '';
  // Whether the engine's line takes back on the square of the first move: only then is a capture a trade.
  const recaptured = () => Boolean(longer.plies[1]?.captured && longer.plies[1].to === first.to);
  const withReason = (move, fallback = '') => { const reason = moveReason(fen, move, { recaptured: recaptured() }); return `${move.san}${reason ? ` ${reason}` : fallback}.`; };
  const result = (title, kind, levels, evidence = {}) => ({ title, levels, insights: [{ kind, evidence: { best: first.san, ...evidence } }] });

  // A forced mate, announced only once a deeper search confirms it.
  if (best.score.type === 'mate' && best.score.value > 0 && (best.score.value === 1 || await mateConfirmed(fen, best.steps[0]))) {
    const n = best.score.value;
    const mating = sans.slice(0, 2 * n - 1);
    return result('Mate is available', 'mate', [
      n === 1 ? 'You have a checkmate in one move. Look at every check.' : `You have a forced mate in ${n}. It starts with ${/[+#]$/.test(first.san) ? 'a check' : 'a quiet move'}.`,
      `Start with ${piece}.`,
      n === 1 ? `${first.san} is checkmate.` : `${first.san} starts it: ${numbered(fen, mating)}${mating.length === 2 * n - 1 ? '' : ' …'}.`,
    ], { mate: n });
  }

  if (board.isCheck()) {
    const king = board.board().flat().find(p => p?.type === 'k' && p.color === 'w').square;
    const checker = board.attackers(king, 'b')[0];
    const how = first.piece === 'k' ? 'a king move: find the square where your king is safest'
      : first.captured && first.to === checker ? 'to capture the checking piece' : 'to block the check';
    return result('You are in check', 'check', [
      `You are in check from ${named(board, checker, 'Black’s ')}. You can move your king, block the check, or capture the checking piece.`,
      `The best answer is ${how}.`,
      withReason(first) + also,
    ]);
  }

  // Black's threat, unless White is so far ahead that only a piece or more is worth a warning.
  const threat = await threatsBy(fen, 'b', { currentCp: nowCp });
  // Whether the best move deals with the threat: it moves the target, takes the attacker, or leaves the capture
  // losing for Black. A threat the best move ignores is still named, with the advice that something matters more.
  const parried = threat && (threat.mate || !threat.captured || first.from === threat.to || (first.captured && first.to === threat.from)
    || captureGain(first.after, threat.to, 'b') <= 0);
  const threatText = () => {
    if (threat.mate) return `Black threatens mate, starting with ${threat.move}`;
    const what = consequence(lineWithBoards(withTurn(fen, 'b'), threat.line), 'your ', fen);
    const second = threat.others?.[0];
    const secondWhat = second && consequence(lineWithBoards(withTurn(fen, 'b'), second.line), 'your ', fen);
    return `Black threatens ${threat.move}${what ? `, ${what}` : ''}${second ? `, and also ${second.move}${secondWhat ? `, ${secondWhat}` : ''}` : ''}`;
  };

  // Black just captured and the best move takes back on that square.
  if (lastMove?.captured && first.captured && first.to === lastMove.to) {
    const recaptures = board.moves({ verbose: true }).filter(move => move.to === lastMove.to && move.captured);
    const pieces = [...new Set(recaptures.map(move => `${pieceNames[move.piece]} on ${move.from}`))];
    return result('Take back', 'recapture', [
      `Black just took your ${pieceNames[lastMove.captured]} on ${lastMove.to}. Look at how to take back.`,
      pieces.length > 1 ? `You can take back with your ${list(pieces)}: pick the one that leaves your pieces best placed.` : `Your ${pieces[0]} can take back.`,
      `${first.san}.${pieces.length > 1 && !alternatives.some(san => recaptures.some(move => move.san === san)) ? ' The other recaptures are clearly worse.' : ''}${also}`,
    ], { square: lastMove.to });
  }

  // Material to win: the best line nets two pawns or more, or takes an undefended piece at once.
  // Six plies, so a capture that is won back two moves later is not a win, and a win that needs a check first is.
  let gain = longer.settledGain;
  // A win that only appears in the last plies, or a small one, is confirmed by a deeper search of the same move,
  // as long mates are: shallow lines sometimes miss Black's best defence.
  if (gain >= 1 && gain !== Infinity && (line.settledGain < 2 || gain < 3)) {
    const deeper = (await analyse(fen, { depth: 18, plies: 8, rootMove: best.steps[0].uci ?? first.from + first.to + (first.promotion ?? '') })).variations[0];
    // The deeper line is the better guide to what the move wins, so it is the one shown.
    if (deeper) { longer = lineWithBoards(fen, deeper.steps.map(step => step.san), 6); gain = Math.min(gain, longer.settledGain); }
  }
  const key = keyMotif(longer);
  if (gain >= 2 || (gain >= 1 && key?.ply === 0 && key.motif === 'hanging piece')) {
    const target = wonTarget(fen, longer);
    // A small threat is not worth a sentence when you can win more; a piece or a mate still is.
    const opening = threat?.mate ? `${threatText()}, but you have a forcing answer that also wins material. `
      : threat && (threat.materialGain ?? 0) >= 3 ? `${threatText()}, but you can win more first. ` : '';
    const firstMotifs = longer.plies[0]?.motifs ?? [];
    const castles = first.flags.includes('k') || first.flags.includes('q');
    let idea;
    if (key?.ply === 0 && key.motif === 'hanging piece') idea = `Black’s ${pieceNames[key.captured]} on ${key.square} ${looseWord(board, key.square)}.`;
    else if (castles && key?.ply === 0) idea = 'A move that brings a rook into play wins material.';
    else if (key?.ply === 0 && key.motif === 'pin' && first.captured && firstMotifs.some(m => m.motif === 'removes defender')) idea = 'Removing a defender wins material.';
    else if (key?.ply === 0 && key.motif === 'trapped piece') idea = `Black’s ${pieceNames[board.get(key.target)?.type] ?? 'piece'} on ${key.target} can be trapped.`;
    else if (key?.ply === 0 && key.motif === 'fork' && !realFork(new Chess(first.after), key)) idea = 'You can win material. Look at every check, capture and threat.';
    else if (key?.ply === 0 && ['pin', 'skewer'].includes(key.motif) && first.captured && values[first.captured] >= values[first.piece]) idea = 'You can win material. Look at every check, capture and threat.';
    else if (key?.ply === 0 && ideas[key.motif]) idea = `There is ${ideas[key.motif]} that wins material.`;
    else if (key?.ply === 0 && ['promotion', 'advanced pawn'].includes(key.motif)) idea = 'Your pawn can run for promotion.';
    else if (key && ideas[key.motif] && key.ply <= 4) idea = `A forcing sequence wins material: it leads to ${ideas[key.motif]}. Start with checks and captures.`;
    else idea = 'You can win material. Look at every check, capture and threat.';
    const fork = key?.ply === 0 && key.motif === 'fork' && realFork(new Chess(first.after), key) ? key : null;
    const pointer = fork ? ` From the right square it attacks ${list(forkTargets(new Chess(first.after), fork).map(square => named(new Chess(first.after), square, 'Black’s ')))} at once.`
      : target && !idea.includes(`on ${target.to}`) ? ` The target is Black’s ${pieceNames[target.captured]} on ${target.to}.` : '';
    // Describe only the plies shown, so the material named is what the shown moves win.
    const length = pointLength(longer, gain);
    const shown = longer.plies.slice(0, length).map(ply => ply.san);
    const banked = { ...longer, settledGain: longer.plies[length - 1].material };
    const won = Math.abs(banked.settledGain - gain) <= 1 ? materialPhrase(banked, length) : materialPhrase(longer, 6);
    const lineText = shown.length > 1 ? ` In the engine’s line, ${numbered(fen, shown)}, you win ${won}.` : ` It wins ${won}.`;
    return result('Material to win', 'win', [
      opening + idea,
      `Use ${piece}.${pointer}`,
      withReason(first) + lineText,
    ], { gain, motif: key?.motif ?? null, line: shown, threat: threat?.move ?? null });
  }

  if (threat && parried) {
    const after = new Chess(first.after);
    const victim = board.get(threat.to);
    const victimName = victim ? `your ${pieceNames[victim.type]} on ${threat.to}` : `${threat.to}`;
    const between = (from, to, square) => {
      const [f1, r1, f2, r2, fs, rs] = [from, to, square].flatMap(s => [s.charCodeAt(0), Number(s[1])]);
      const df = Math.sign(f2 - f1), dr = Math.sign(r2 - r1);
      if (!(f1 === f2 || r1 === r2 || Math.abs(f2 - f1) === Math.abs(r2 - r1))) return false;
      for (let f = f1 + df, r = r1 + dr; f !== f2 || r !== r2; f += df, r += dr) if (f === fs && r === rs) return true;
      return false;
    };
    const stillWins = !threat.mate && threat.captured && captureGain(first.after, threat.to, 'b') > 0;
    let how, why;
    if (threat.mate) { how = `Find the move that stops the mate. ${piece[0].toUpperCase()}${piece.slice(1)} can do it.`; why = `${first.san} stops the mate.`; }
    else if (first.from === threat.to) { how = `Move ${victimName} to a safe square.`; why = `${first.san} moves it to safety.`; }
    else if (first.captured && first.to === threat.from) { how = 'You can capture the attacking piece.'; why = `${first.san} removes the attacker.`; }
    else if (first.san.endsWith('+')) { how = `Answer with a check first, with ${piece}.`; why = withReason(first, ' comes with check'); }
    else if (!stillWins && threat.captured && ['b', 'r', 'q'].includes(board.get(threat.from)?.type) && between(threat.from, threat.to, first.to)) {
      how = `Block the attack on ${victimName}.`; why = `${first.san} blocks the line from Black’s ${pieceNames[board.get(threat.from).type]} on ${threat.from}.`;
    } else if (!stillWins && threat.captured && victim && after.attackers(threat.to, 'w').includes(first.to)) {
      // Name the defender: several pieces can usually defend, and the wrong one can cost as much as the threat.
      how = `Add a defender to ${victimName}: the best one is ${piece}.`; why = `${first.san} defends ${victimName}.`;
    } else { how = `The best answer uses ${piece}.`; why = withReason(first); }
    // When the best move leaves the capture possible, it is a counter-attack, not a defence: say so.
    const counter = stillWins && !threat.mate && !first.san.endsWith('+');
    return result('Watch Black’s threat', 'threat', [
      counter ? `${threatText()}. You do not have to defend directly: there is a stronger answer that hits back.` : `${threatText()}. Deal with it first.`,
      how,
      why + also,
    ], { threat: threat.move, square: threat.to });
  }

  // A quiet position. The best move's purpose decides what to point at.
  const features = planFeatures(fen, 'w');
  const ignore = threat ? `${threatText()}, but you have something more important than defending against it. ` : '';
  // A tactic in the best move that does not win material at once (Black can answer it) is still the point.
  const tactic = moveMotifs(new Chess(fen), first).find(m => ['fork', 'skewer', 'pin', 'discovered attack', 'discovered check', 'mate threat'].includes(m.motif) && !m.exploited
    && (m.motif !== 'fork' || m.targets.filter(square => board.get(square)?.type !== 'p' || square === undefined).length >= 2));
  const tacticReason = tactic && moveReason(fen, first);
  if (tacticReason) {
    return result('Look for a tactic', 'tactic', [
      `${ignore}There is ${ideas[tactic.motif] ?? 'a mate threat'} available: Black will have to answer it.`,
      `Use ${piece}.`,
      `${first.san} ${tacticReason}.${also}`,
    ], { motif: tactic.motif });
  }
  // Pressure on your pieces: Black attacks one of them, even if it is defended for now. When the best move
  // answers that pressure, it is the point of the hint; otherwise it is mentioned so the learner keeps it in mind.
  const afterBoard = new Chess(first.after);
  // Real pressure: more attackers than defenders, or an attacker worth less than the piece (or as much, when
  // the defence only just holds). A pawn attacked by a queen and defended once is not under pressure.
  const underPressure = p => {
    const attackers = board.attackers(p.square, 'b'), defenders = board.attackers(p.square, 'w');
    const cheapest = Math.min(...attackers.map(square => values[board.get(square).type]));
    return attackers.length && (attackers.length > defenders.length || cheapest < values[p.type] || (cheapest === values[p.type] && attackers.length >= defenders.length));
  };
  const pressured = board.board().flat().filter(p => p?.color === 'w' && p.type !== 'k' && underPressure(p))
    .map(p => {
      const attackers = board.attackers(p.square, 'b'), defenders = board.attackers(p.square, 'w');
      // A capture by the attacked piece itself is not an answer to the pressure: its point lies elsewhere.
      const answer = first.from === p.square ? (first.captured ? null : 'moves')
        : attackers.includes(first.to) && first.captured ? 'takes'
        : afterBoard.attackers(p.square, 'w').length > defenders.length && afterBoard.attackers(p.square, 'w').includes(first.to) ? 'defends'
        : attackers.some(square => afterBoard.attackers(square, 'w').includes(first.to) && afterBoard.get(square)?.color === 'b') ? 'challenges' : null;
      return { ...p, attackers, defenders, answer };
    })
    .sort((x, y) => (y.answer ? 1 : 0) - (x.answer ? 1 : 0) || values[y.type] - values[x.type]);
  const pressure = pressured[0];
  const pressureText = p => {
    const by = list(p.attackers.map(square => named(board, square, 'Black’s ')));
    const guards = p.defenders.length ? `defended by your ${list(p.defenders.map(square => `${pieceNames[board.get(square).type]} on ${square}`))}` : 'not defended';
    return `${by[0].toUpperCase()}${by.slice(1)} ${p.attackers.length > 1 ? 'are' : 'is'} attacking your ${pieceNames[p.type]} on ${p.square}, which is ${guards}.`;
  };
  if (pressure?.answer && !ignore) {
    const attacker = pressure.attackers.find(square => afterBoard.attackers(square, 'w').includes(first.to)) ?? pressure.attackers[0];
    const how = { moves: `Move your ${pieceNames[pressure.type]} to a better square.`, takes: 'You can capture the attacker.',
      defends: `Add a defender to your ${pieceNames[pressure.type]}.`, challenges: `Put the question to ${named(board, attacker, 'Black’s ')}.` }[pressure.answer];
    const why = { moves: `${first.san} moves your ${pieceNames[pressure.type]} away from the attack`,
      takes: `${first.san} takes the attacker`,
      defends: `${first.san} defends your ${pieceNames[pressure.type]} on ${pressure.square}${pressure.defenders.length ? ' a second time' : ''}`,
      challenges: `${first.san} attacks ${named(board, attacker, 'Black’s ')}` }[pressure.answer];
    const reason = moveReason(fen, first);
    return result('Mind the pressure', 'pressure', [
      pressureText(pressure),
      `${how} The engine’s choice uses ${piece}.`,
      `${why}${reason && !reason.startsWith('attacks') ? `, and ${reason}` : ''}.${also}`,
    ], { square: pressure.square, answer: pressure.answer });
  }
  const context = pressure && !ignore && pressure.type !== 'p' ? `${pressureText(pressure)} ` : '';
  // A threat worth building the hint on: a mate, a piece or more, or an attack on a piece by a cheaper one.
  // A capture is not a threat-making move: Black's natural answer is to recapture, which a pass search ignores.
  const ownFound = first.captured ? null : await threatsBy(first.after, 'w', { currentCp: -nowCp });
  const ownThreat = ownFound && (ownFound.mate || ownFound.materialGain >= 2
    || (ownFound.captured && values[ownFound.captured] > values[new Chess(first.after).get(ownFound.from)?.type ?? 'q'])) ? ownFound : null;
  if (ownThreat) {
    const what = ownThreat.mate ? '' : consequence(lineWithBoards(withTurn(first.after, 'w'), ownThreat.line), 'Black’s ', first.after);
    const target = ownThreat.mate ? 'Black’s king is the target.' : `${named(board, ownThreat.to, 'Black’s ').replace(/^./, c => c.toUpperCase())} is a target.`;
    return result('Make a threat', 'own threat', [
      `${ignore}Look for a move that creates a threat Black must answer.`,
      `${target} Use ${piece}.`,
      ownThreat.mate ? `${first.san} threatens mate.${also}`
        : what && !/^winning (?:material|a pawn)$/.test(what) ? `${first.san} threatens ${ownThreat.move}, ${what}.${also}`
        : board.get(ownThreat.to) && ownThreat.captured ? `${first.san} attacks ${named(board, ownThreat.to, 'Black’s ')}: Black must deal with ${ownThreat.move}.${also}`
        : `${first.san} threatens ${ownThreat.move}${what ? `, ${what}` : ''}.${also}`,
    ], { threat: ownThreat.move });
  }
  // The positional point of the engine's move: an outpost, a weak pawn, a pawn break, a trade, development, space.
  // It comes before the general plans below, so the hint and the turn comment (which uses the same idea) agree.
  const point = !first.san.endsWith('+') ? await positionalPoint(fen, first, sans) : null;
  // When one move is much better than the rest, say so and show the engine's line: the point may lie deeper.
  const second = now.variations[1];
  const critical = best.score.type !== 'mate' && (!second || nowCp - cp(second) >= 100);
  const forcing = first.captured || first.san.endsWith('+');
  const lineNote = critical ? ` It is clearly the best move; the engine’s line is ${numbered(fen, sans.slice(0, 5))}.`
    : forcing ? ` The engine’s line is ${numbered(fen, sans.slice(0, 5))}.` : '';
  if (point) {
    return result('Your next step', 'plan', [
      `${ignore}${context}${point.idea}${critical ? ' One move is clearly best here.' : ''}`,
      `The engine’s choice uses ${piece}.${point.pointer ? ` ${point.pointer}` : ''}`,
      `${first.san} ${point.reason}.${lineNote || also}`,
    ], { idea: point.kind, term: point.term });
  }
  if (first.flags.includes('k') || first.flags.includes('q')) {
    return result('Your next step', 'plan', [
      `${ignore}Your king is still in the centre: castling would make it safer and connect your rooks.`,
      `Castle ${first.flags.includes('k') ? 'kingside' : 'queenside'}.`,
      `${first.san}.${also}`,
    ]);
  }
  // A pawn controls the squares it attacks, not the square in front of it.
  const controls = square => first.piece === 'p'
    ? Math.abs(square.charCodeAt(0) - first.to.charCodeAt(0)) === 1 && Number(square[1]) === Number(first.to[1]) + 1
    : new Chess(withTurn(first.after, 'w')).moves({ square: first.to, verbose: true }).some(move => move.to === square);
  const central = centre.filter(square => square !== first.to && controls(square));
  if (['n', 'b'].includes(first.piece) && first.from[1] === '1') {
    return result('Your next step', 'plan', [
      ignore + (features.undeveloped.length > 1 ? `Your ${list(features.undeveloped.map(square => `${pieceNames[board.get(square).type]} on ${square}`))} are still at home: give one of them a job.` : 'Bring your last minor piece into play.'),
      `Start with ${piece}.`,
      `${first.san} develops your ${pieceNames[first.piece]}${central.length ? ` and controls ${list(central)}` : ''}.${also}`,
    ]);
  }
  const file = first.to[0];
  if (first.piece === 'r' && first.from[0] !== file && (features.openFiles.includes(file) || features.halfOpenFiles.includes(file))) {
    const kind = features.openFiles.includes(file) ? 'open' : 'half-open';
    return result('Your next step', 'plan', [
      `${ignore}The ${file}-file is ${kind}: a rook there would have more scope.`,
      `Use ${piece}.`,
      `${first.san} puts your rook on the ${kind} ${file}-file.${also}`,
    ]);
  }
  if (first.piece === 'p' && features.passed.includes(first.from)) {
    return result('Your next step', 'plan', [
      `${ignore}Your passed pawn on ${first.from} is your trump.`,
      'Think about pushing it now.',
      `${first.san} advances your passed pawn.${also}`,
    ]);
  }
  if (first.piece === 'p' && ['c', 'd', 'e', 'f'].includes(first.from[0]) && Number(fen.split(' ')[5]) <= 20 && (centre.includes(first.to) || central.length)) {
    return result('Your next step', 'plan', [
      `${ignore}Fight for the centre with a pawn.`,
      `Use your ${first.from[0]}-pawn.`,
      `${first.san} ${centre.includes(first.to) ? 'takes space in the centre' : `controls ${list(central)}`}.${also}`,
    ]);
  }
  // Otherwise: an improving move. Say how much more the piece does from its new square.
  const mobility = (position, square) => new Chess(withTurn(position, 'w')).moves({ square }).length;
  const [before, afterMoves] = [mobility(fen, first.from), mobility(first.after, first.to)];
  const reason = moveReason(fen, first, { recaptured: recaptured() }) || (first.captured ? `takes Black’s ${pieceNames[first.captured]} on ${first.to}` : '');
  // The general plan is only worth saying when the engine's move carries it out; otherwise it points elsewhere.
  const planText = plan(fen) ?? '';
  // A piece standing between the king and a rook on the first rank: moving it helps castling.
  const fromFile = first.from[0];
  const kingSide = first.from[1] === '1' && ((fromFile > 'e' && fromFile < 'h') || (fromFile < 'e' && fromFile > 'a'));
  const planFits = planText.includes(first.from) || (/castle/.test(planText) && kingSide)
    || (/-file is/.test(planText) && first.piece === 'r') || (/endgame your king/.test(planText) && first.piece === 'k');
  // No named idea: never claim that nothing is there, since the engine's move may still be clearly best.
  return result('Your next step', 'plan', [
    forcing ? `${ignore}${context}Look at the checks and captures first.${critical ? ' One move is clearly best here.' : ''}`
      : `${ignore}${context}${critical ? 'One move is clearly better than the rest: compare your candidate moves carefully.' : 'There is no tactic here: improve a piece or restrict one of Black’s.'}${planFits ? ` ${planText}` : ''}`,
    `The engine’s choice uses ${piece}.`,
    `${first.san}${reason ? ` ${reason}` : first.san.endsWith('+') ? ' gains time with check' : afterMoves >= before + 3 && first.piece !== 'p' ? `: your ${pieceNames[first.piece]} goes from ${before} to ${afterMoves} available moves` : ''}.${lineNote || also}`,
  ]);
}
