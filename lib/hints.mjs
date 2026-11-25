// Levelled hints built from the analysis layer, without a model call. A hint teaches how to read the board
// before it says which move to play. Each level is at most three short bullet points:
//   level 1  questions that point at the right place on the board (Black's threat, a loose piece, the king), never the move
//   level 2  the answer: what is there, the piece to use, and the rule of thumb behind it
//   level 3  the move and why it works, Black's best reply, and a tempting move that fails
// Every statement comes from the board or the engine's line. Plan hints always explain the engine's own move,
// so a plan is never advice the engine disagrees with. Each level repeats the earlier ones on screen.
import { Chess } from 'chess.js';
import { analyse, scoreValue } from './engine.mjs';
import { captureGain, keyMotif, lineMotifs, moveEffects, moveMotifs, pieceNames, pinnedBy, planFeatures, threatsBy, values, withTurn } from './analysis.mjs';
import { combinationText, consequence, lineWithBoards, list, looseWord, materialPhrase, mateConfirmed, named, plan, sacrifice } from './coach.mjs';
import { positionalPoint } from './positional.mjs';

export const hintLevels = 3;
const cp = variation => scoreValue(variation.score);
const ideas = { fork: 'a fork', skewer: 'a skewer', pin: 'a pin', 'discovered attack': 'a discovered attack', 'discovered check': 'a discovered check', 'removes defender': 'a way to remove a defender' };
const centre = ['d4', 'e4', 'd5', 'e5'];

// Level 1 questions for each tactic: where to look, in plain words.
const motifQuestions = {
  fork: 'Is there a square where one of your pieces attacks two Black pieces at once?',
  pin: 'Which Black piece cannot move without exposing a more valuable piece behind it?',
  skewer: 'Which valuable Black piece stands in front of another one on the same line?',
  'discovered attack': 'Which of your pieces blocks the line of another one? What happens if it moves away with a threat?',
  'discovered check': 'Which of your pieces stands between one of your long-range pieces and Black’s king? What if it moves?',
  'removes defender': 'Which Black piece relies on a single defender? Can you take or chase that defender?',
  'trapped piece': 'Which Black piece has no safe square to go to?',
  'hanging piece': 'Which Black piece has more attackers than defenders?',
  'mate threat': 'Can you threaten mate, so that Black has no time for anything else?',
  promotion: 'How many moves does your pawn need to promote, and can Black stop it in time?',
};
motifQuestions['advanced pawn'] = motifQuestions.promotion;
// The rule of thumb behind each idea, said once at level 2.
const rules = {
  fork: 'Rule: a fork works because Black can save only one of the two pieces.',
  pin: 'Rule: a pinned piece is stuck: attack it again before Black can unpin it.',
  skewer: 'Rule: a skewer hits the more valuable piece first; when it moves, the one behind it falls.',
  'discovered attack': 'Rule: when a piece moves off a line, the piece behind it attacks too: two threats in one move.',
  'discovered check': 'Rule: with a discovered check the moving piece can go anywhere, because Black must answer the check first.',
  'removes defender': 'Rule: a piece with one defender is only as safe as that defender.',
  'trapped piece': 'Rule: a piece with no safe square is lost as soon as you attack it.',
  'hanging piece': 'Rule: a piece is safe only when it has at least as many defenders as attackers, and no attacker is worth less than it.',
  'mate threat': 'Rule: a mate threat is the strongest threat there is: Black must stop it, whatever else is attacked.',
  promotion: 'Rule: passed pawns must be pushed. Count your moves to promote against Black’s moves to stop the pawn.',
  combination: 'Rule: giving up material is fine when the follow-up wins more. Count to the end of the sequence.',
  mate: 'Rule: look at checks first: they leave Black the fewest answers.',
  check: 'Rule: list all three answers before choosing: the first one you see is not always the best.',
  recapture: 'Rule: take back with the piece that stands best afterwards, and count the trade in points.',
  threat: 'Rule: before your own plans, ask what Black’s last move threatens.',
  pinned: 'Rule: a pinned piece cannot run: defend it, take the attacker, or move your king out of the pin.',
  counter: 'Rule: a bigger threat of your own can be better than defending.',
  pressure: 'Rule: count attackers and defenders. When the attackers win the count, act now.',
  'own threat': 'Rule: a move with a threat makes Black react, so you keep the initiative.',
  castle: 'Rule: castle early: your king is safer and your rooks can reach the centre.',
  develop: 'Rule: in the opening, bring out a new piece with each move.',
  file: 'Rule: rooks belong on open files, where no pawn blocks them.',
  seventh: 'Rule: a rook on the seventh rank attacks pawns that cannot easily be defended.',
  passed: 'Rule: passed pawns must be pushed: every step forward makes them harder to stop.',
  centre: 'Rule: pawns in the centre give your pieces room and take squares from Black’s.',
  activate: 'Rule: when there is no tactic, improve your least active piece.',
  endgame: 'Rule: in the endgame the king is a strong piece: bring it forward.',
  outpost: 'Rule: a piece on a square no enemy pawn can attack is hard to drive away.',
  'weak pawn': 'Rule: a pawn that no other pawn can defend is a target: attack it more times than it can be defended.',
  break: 'Rule: a pawn exchange opens lines: make it when your pieces are ready to use them.',
  trade: 'Rule: trade off the opponent’s best piece, and keep your own.',
  'king attack': 'Rule: an attack on the king needs more attackers than there are defenders.',
  restrict: 'Rule: a piece with no good squares is almost as bad as a lost piece.',
  prevent: 'Rule: ask what your opponent wants to do next, then stop it if you can.',
  quiet: 'Rule: when there is no tactic, improve a piece or take squares from Black’s pieces.',
  'keep bishop': 'Rule: two bishops together are often worth more than a bishop and a knight.',
  centralise: 'Rule: a piece in the centre reaches more squares than one on the edge.',
};
rules.damage = rules['weak pawn'];
rules.space = rules.centre;
rules['advanced pawn'] = rules.promotion;
// Level 1 questions for the positional ideas: what to look at before choosing a quiet move.
const planQuestions = {
  outpost: 'Is there a square in Black’s half that no Black pawn can attack? Which piece could stand there?',
  'weak pawn': 'Which Black pawn cannot be defended by another pawn? Can you attack it?',
  damage: 'Can a capture leave Black with doubled or isolated pawns?',
  file: 'Which file has no pawns blocking it? Is a rook of yours using it?',
  seventh: 'Can a rook of yours reach the rank where Black’s pawns stand?',
  passed: 'Which of your pawns has no Black pawn in front of it or beside it? How far is it from promoting?',
  'king attack': 'How many of your pieces aim at Black’s king? Can you add one more?',
  castle: 'Is your king safe in the centre? Can you castle now?',
  activate: 'Which of your pieces is doing the least right now? Where would it do more?',
  restrict: 'Which Black piece has the fewest squares? Can you take away the rest?',
  break: 'Which pawn move would open lines for your pieces?',
  trade: 'Which Black piece is doing the most for Black? Can you trade it off?',
  'keep bishop': 'Which Black piece wants to trade itself for one of yours? Should you allow it?',
  develop: 'Which of your pieces are still on their starting squares?',
  centralise: 'Which of your pieces could stand closer to the centre, where it reaches more squares?',
  centre: 'Can a pawn move take more space in the centre?',
  space: 'Can a pawn move take squares away from Black’s pieces?',
  prevent: 'What does Black want to do next? Can you stop it?',
  threat: 'Which Black piece has no defender, or too few? Can you attack it?',
};
const upper = text => text ? text[0].toUpperCase() + text.slice(1) : text;
const asBullets = items => items.filter(Boolean).slice(0, 3).map(text => `• ${text}`).join('\n');

// The squares Black's king could step to if it were Black's move: a fact a mating hint can point at.
function kingSquares(fen) {
  try {
    const board = new Chess(withTurn(fen, 'b'));
    return [...new Set(board.moves({ verbose: true }).filter(move => move.piece === 'k').map(move => move.to))];
  } catch { return null; }
}


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

// Why a tempting move fails, from the engine's line after it: what Black's reply takes, or what it costs.
function failure(fen, move, line, drop, best) {
  const sans = line.steps.map(step => step.san);
  let reply;
  try { reply = new Chess(move.after).move(sans[1]); } catch { return null; }
  const answer = numbered(move.after, [sans[1]]);
  if (line.score.type === 'mate' && line.score.value < 0) return `${answer} and Black has a forced mate`;
  // Taking back on the same square is only a refutation when the trade itself loses: a knight for a knight is not.
  if (reply.captured && reply.to === move.to && values[move.captured ?? 'p'] < values[move.piece]) return `${answer} takes your ${pieceNames[move.piece]}, which was not safe on ${move.to}`;
  if (reply.captured && reply.to !== move.to) return `${answer} takes your ${pieceNames[reply.captured]} on ${reply.to}`;
  const lost = -lineWithBoards(fen, sans, 6).settledGain;
  if (lost >= 1 && lost !== Infinity) return `after ${answer} you lose about ${Math.round(lost)} ${Math.round(lost) === 1 ? 'point' : 'points'} of material`;
  const pawns = Math.max(1, Math.round(drop / 100));
  return `after ${answer} you are about ${pawns} ${pawns === 1 ? 'pawn' : 'pawns'} worse off than with ${best.san}`;
}

// A capture or check that looks natural but is clearly worse than the best move, with the reason: the move a
// learner might play on instinct. One extra short search at most for each of the two likeliest candidates.
async function temptingMove(fen, now, best, alternatives) {
  const bestCp = cp(now.variations[0]);
  if (Math.abs(bestCp) >= 2000) return null;
  const near = new Set([best.san, ...alternatives, ...now.variations.filter(v => v.steps[0] && bestCp - cp(v) < 150).map(v => v.steps[0].san)]);
  const candidates = new Chess(fen).moves({ verbose: true }).filter(move => !near.has(move.san) && (move.captured || move.san.endsWith('+')))
    .sort((x, y) => (values[y.captured] ?? 0) - (values[x.captured] ?? 0) || Number(y.san.endsWith('+')) - Number(x.san.endsWith('+')));
  for (const move of candidates.slice(0, 2)) {
    const line = now.variations.find(v => v.steps[0]?.san === move.san)
      ?? (await analyse(fen, { rootMove: move.from + move.to + (move.promotion ?? ''), depth: 12, plies: 6 })).variations[0];
    if (!line?.steps?.[1]) continue;
    const drop = bestCp - cp(line);
    // Only a real mistake, and only when it spoils the position: being a little less winning is not a failure.
    if (drop < 150 || cp(line) >= 300) continue;
    const why = failure(fen, move, line, drop, best);
    if (why) return `Not ${move.san}: ${why}.`;
  }
  return null;
}

// Builds every level of the hint for White to move in `fen`. `analysis(fen)` returns engine analysis (the server
// passes its cached version); `lastMove` is Black's last move as a chess.js verbose move, when there is one.
export async function hintLesson(fen, analysis, options = {}) {
  const hint = await buildHint(fen, analysis, options);
  const { first, sans, now, alternatives } = hint.context;
  const move = [...hint.move];
  // Black's best reply, unless the line shown already includes it.
  if (hint.reply && sans[1] && !move.join(' ').includes(sans[1])) move.push(`Black’s best reply is ${numbered(first.after, [sans[1]])}.`);
  if (hint.tempting && move.length < 3) {
    const tempting = await temptingMove(fen, now, first, alternatives).catch(() => null);
    if (tempting) move.push(tempting);
  }
  const levels = [asBullets(hint.ask), asBullets([...hint.answer.filter(Boolean).slice(0, hint.rule ? 2 : 3), hint.rule]), asBullets(move)];
  return { title: hint.title, levels, insights: [{ kind: hint.kind, evidence: { best: first.san, ...hint.evidence } }] };
}

async function buildHint(fen, analysis, { lastMove } = {}) {
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
  // The parts of a hint: questions (level 1), answers and a rule (level 2), the move (level 3). `reply` adds Black's
  // best reply to level 3, `tempting` a natural move that fails.
  const facts = { first, sans, now, alternatives };
  const result = (title, kind, { ask, answer, rule, move, reply = true, tempting = true }, evidence = {}) => ({ title, kind, ask, answer, rule, move, reply, tempting, evidence, context: facts });

  // A forced mate, announced only once a deeper search confirms it.
  if (best.score.type === 'mate' && best.score.value > 0 && (best.score.value === 1 || await mateConfirmed(fen, best.steps[0]))) {
    const n = best.score.value;
    const mating = sans.slice(0, 2 * n - 1);
    const squares = kingSquares(fen);
    const start = /[+#]$/.test(first.san) ? 'a check' : first.captured ? 'a capture' : 'a quiet move';
    return result('Mate is available', 'mate', {
      ask: n === 1 ? ['There is a checkmate in one move. Which of your checks leaves Black’s king no square to go to, and no way to block?']
        : [`You can force mate in ${n} moves. Where can Black’s king go right now?`, `It starts with ${start}: which one leaves the king the fewest squares?`],
      answer: [squares && (squares.length ? `Black’s king can only go to ${list(squares)}.` : 'Black’s king has no square to go to: one check is enough.'), `Start with ${piece}.`],
      rule: rules.mate,
      move: [n === 1 ? `${first.san} is checkmate.` : `${first.san} starts it: ${numbered(fen, mating)}${mating.length === 2 * n - 1 ? '' : ' …'}.`],
      reply: false, tempting: false,
    }, { mate: n });
  }

  if (board.isCheck()) {
    const king = board.board().flat().find(p => p?.type === 'k' && p.color === 'w').square;
    const checker = board.attackers(king, 'b')[0];
    const how = first.piece === 'k' ? 'a king move: find the square where your king is safest'
      : first.captured && first.to === checker ? 'to capture the checking piece' : 'to block the check';
    return result('You are in check', 'check', {
      ask: [`You are in check from ${named(board, checker, 'Black’s ')}. Which answer is best: move your king, block the check, or capture the checking piece?`],
      answer: [`The best answer is ${how}.`],
      rule: rules.check,
      move: [withReason(first) + also],
    });
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
    // No final full stop: callers add their question. A second threat gets its own sentence.
    return `Black threatens ${threat.move}${what ? `, ${what}` : ''}${second ? `. Black also threatens ${second.move}${secondWhat ? `, ${secondWhat}` : ''}` : ''}`;
  };

  // Black just captured and the best move takes back on that square.
  if (lastMove?.captured && first.captured && first.to === lastMove.to) {
    const recaptures = board.moves({ verbose: true }).filter(move => move.to === lastMove.to && move.captured);
    const pieces = [...new Set(recaptures.map(move => `${pieceNames[move.piece]} on ${move.from}`))];
    const [lost, won] = [lastMove.captured, first.captured];
    const trade = lost === won ? `Taking back makes it a ${pieceNames[lost]} for a ${pieceNames[won]}: an even trade.`
      : values[lost] === values[won] ? `Taking back makes it your ${pieceNames[lost]} for Black’s ${pieceNames[won]}, both worth ${values[lost]}: an even trade.`
      : `Taking back makes it your ${pieceNames[lost]} (worth ${values[lost]}) for Black’s ${pieceNames[won]} (worth ${values[won]}).`;
    return result('Take back', 'recapture', {
      ask: [`Black just took your ${pieceNames[lastMove.captured]} on ${lastMove.to}. Which of your pieces can take back, and which one will stand best afterwards?`],
      answer: [pieces.length > 1 ? `You can take back with your ${list(pieces)}.` : `Your ${pieces[0]} can take back.`, trade],
      rule: rules.recapture,
      move: [`${first.san}.${pieces.length > 1 && !alternatives.some(san => recaptures.some(move => move.san === san)) ? ' The other recaptures are clearly worse.' : ''}${also}`],
    }, { square: lastMove.to });
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
    const opening = threat?.mate ? `${threatText()}. Is there a forcing answer that also wins material?`
      : threat && (threat.materialGain ?? 0) >= 3 ? `${threatText()}. Can you win more first?` : '';
    const firstMotifs = longer.plies[0]?.motifs ?? [];
    const castles = first.flags.includes('k') || first.flags.includes('q');
    let idea;
    // A combination gives material away before winning more: name what it finally wins, not what it takes first.
    const sac = sacrifice(board, longer);
    if (sac !== false) idea = combinationText(board, longer);
    else if (key?.ply === 0 && key.motif === 'hanging piece') idea = `Black’s ${pieceNames[key.captured]} on ${key.square} ${looseWord(board, key.square)}.`;
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
      : target && sac === false && !idea.includes(`on ${target.to}`) ? ` The target is Black’s ${pieceNames[target.captured]} on ${target.to}.` : '';
    // Describe only the plies shown, so the material named is what the shown moves win.
    const length = pointLength(longer, gain);
    const shown = longer.plies.slice(0, length).map(ply => ply.san);
    const banked = { ...longer, settledGain: longer.plies[length - 1].material };
    const won = Math.abs(banked.settledGain - gain) <= 1 ? materialPhrase(banked, length) : materialPhrase(longer, 6);
    const ahead = Math.round(gain);
    const lineText = sac !== false && shown.length > 1 ? ` In the engine’s line, ${numbered(fen, shown)}, you give up material first and come out about ${ahead} ${ahead === 1 ? 'point' : 'points'} ahead.`
      : shown.length > 1 ? ` In the engine’s line, ${numbered(fen, shown)}, you win ${won}.` : ` It wins ${won}.`;
    // Where to look: the question for the tactic, or for a combination, or the general checks-captures-threats scan.
    const motif = sac !== false ? 'combination' : key && key.ply <= 4 && motifQuestions[key.motif] ? key.motif : null;
    const question = motif === 'combination' ? 'Can you give up material first and win more afterwards? Count to the end of each capture sequence.'
      : castles && key?.ply === 0 ? 'Can a move that brings a rook into play also win material?'
      : motif ? motifQuestions[motif] : 'What are all your checks, captures and threats? Which one wins material?';
    return result('Material to win', 'win', {
      ask: [opening, question],
      answer: [idea, `Use ${piece}.${pointer}`],
      rule: rules[motif] ?? rules['hanging piece'],
      move: [withReason(first) + lineText],
      reply: false,
    }, { gain, motif: key?.motif ?? null, line: shown, threat: threat?.move ?? null });
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
    // A pinned piece cannot run, so moving it is not one of the answers to offer.
    const pinned = !threat.mate && victim && pinnedBy(fen, threat.to);
    return result('Watch Black’s threat', 'threat', {
      ask: [counter ? `${threatText()}. Do you have to defend, or is there a stronger answer that hits back?`
        : threat.mate ? `${threatText()}. Which move stops it?`
        : pinned ? `${threatText()}. Your ${pieceNames[victim.type]} cannot move away. How else can you meet it: defend it, take the attacker, or get out of the pin?`
        : `${threatText()}. How can you meet it: move the piece, defend it, block the attack, or take the attacker?`],
      answer: [counter ? `You do not have to defend directly: there is a stronger answer. ${how}` : how],
      rule: counter ? rules.counter : pinned ? rules.pinned : rules.threat,
      move: [why + also],
    }, { threat: threat.move, square: threat.to });
  }

  // A quiet position. The best move's purpose decides what to point at.
  const features = planFeatures(fen, 'w');
  const ignore = threat ? `${threatText()}. Is there something more important than defending against it?` : '';
  // A tactic in the best move that does not win material at once (Black can answer it) is still the point.
  const tactic = moveMotifs(new Chess(fen), first).find(m => ['fork', 'skewer', 'pin', 'discovered attack', 'discovered check', 'mate threat'].includes(m.motif) && !m.exploited
    && (m.motif !== 'fork' || m.targets.filter(square => board.get(square)?.type !== 'p' || square === undefined).length >= 2));
  const tacticReason = tactic && moveReason(fen, first);
  if (tacticReason) {
    return result('Look for a tactic', 'tactic', {
      ask: [ignore, motifQuestions[tactic.motif]],
      answer: [`There is ${ideas[tactic.motif] ?? 'a mate threat'} available: Black will have to answer it.`, `Use ${piece}.`],
      rule: rules[tactic.motif],
      move: [`${first.san} ${tacticReason}.${also}`],
    }, { motif: tactic.motif });
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
    return `${upper(by)} ${p.attackers.length > 1 ? 'are' : 'is'} attacking your ${pieceNames[p.type]} on ${p.square}, which is ${guards}`;
  };
  // Why the piece is in danger, from the count: more attackers, or an attacker worth less than it.
  const pressureCount = p => {
    const cheapest = Math.min(...p.attackers.map(square => values[board.get(square).type]));
    const count = `${p.attackers.length} ${p.attackers.length === 1 ? 'attacker' : 'attackers'}, ${p.defenders.length} ${p.defenders.length === 1 ? 'defender' : 'defenders'}`;
    return cheapest < values[p.type] ? `${count}, and a cheaper piece attacks it: defenders do not help when the attacker is worth less.`
      : p.attackers.length > p.defenders.length ? `${count}: the attackers win the count.` : `${count}: only just holding.`;
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
    return result('Mind the pressure', 'pressure', {
      ask: [`${pressureText(pressure)}. Count the attackers and defenders: is it safe?`],
      answer: [pressureCount(pressure), `${how} The engine’s choice uses ${piece}.`],
      rule: rules.pressure,
      move: [`${why}${reason && !reason.startsWith('attacks') ? `, and ${reason}` : ''}.${also}`],
    }, { square: pressure.square, answer: pressure.answer });
  }
  // Pressure the best move does not answer is still worth keeping in mind, as a question.
  const keepInMind = pressure && !ignore && pressure.type !== 'p' ? `${pressureText(pressure)}. Is it safe for now?` : '';
  // A threat worth building the hint on: a mate, a piece or more, or an attack on a piece by a cheaper one.
  // A capture is not a threat-making move: Black's natural answer is to recapture, which a pass search ignores.
  const ownFound = first.captured ? null : await threatsBy(first.after, 'w', { currentCp: -nowCp });
  const ownThreat = ownFound && (ownFound.mate || ownFound.materialGain >= 2
    || (ownFound.captured && values[ownFound.captured] > values[new Chess(first.after).get(ownFound.from)?.type ?? 'q'])) ? ownFound : null;
  if (ownThreat) {
    const what = ownThreat.mate ? '' : consequence(lineWithBoards(withTurn(first.after, 'w'), ownThreat.line), 'Black’s ', first.after);
    const target = ownThreat.mate ? 'Black’s king is the target.' : `${upper(named(board, ownThreat.to, 'Black’s '))} is a target${board.attackers(ownThreat.to, 'b').length ? '' : ': nothing defends it'}.`;
    return result('Make a threat', 'own threat', {
      ask: [ignore, ownThreat.mate ? 'Can you threaten mate, so that Black has no time for anything else?' : 'Which Black piece is loose, or attacked by something cheaper? Can you attack it with a move Black must answer?'],
      answer: [target, `Use ${piece}.`],
      rule: ownThreat.mate ? rules['mate threat'] : rules['own threat'],
      move: [ownThreat.mate ? `${first.san} threatens mate.${also}`
        : what && !/^winning (?:material|a pawn)$/.test(what) ? `${first.san} threatens ${ownThreat.move}, ${what}.${also}`
        : board.get(ownThreat.to) && ownThreat.captured ? `${first.san} attacks ${named(board, ownThreat.to, 'Black’s ')}: Black must deal with ${ownThreat.move}.${also}`
        : `${first.san} threatens ${ownThreat.move}${what ? `, ${what}` : ''}.${also}`],
    }, { threat: ownThreat.move });
  }
  // The positional point of the engine's move: an outpost, a weak pawn, a pawn break, a trade, development, space.
  // It comes before the general plans below, so the hint and the turn comment (which uses the same idea) agree.
  // Every plan below explains the engine's own move, so a plan is never one the engine disagrees with.
  const point = !first.san.endsWith('+') ? await positionalPoint(fen, first, sans) : null;
  // When one move is much better than the rest, say so and show the engine's line: the point may lie deeper.
  const second = now.variations[1];
  const critical = best.score.type !== 'mate' && (!second || nowCp - cp(second) >= 100);
  const forcing = first.captured || first.san.endsWith('+');
  const lineNote = critical ? ` It is clearly the best move; the engine’s line is ${numbered(fen, sans.slice(0, 5))}.`
    : forcing ? ` The engine’s line is ${numbered(fen, sans.slice(0, 5))}.` : '';
  const shownLine = Boolean(lineNote);
  const clearly = critical ? 'One move is clearly better than the rest: compare your candidates carefully.' : '';
  // What the move changes, for the last level of a plain improving move: what it attacks, what it defends, and its reach.
  const effects = moveEffects(fen, first);
  const effectText = [
    effects.attacks.length ? `attacks ${list(effects.attacks.slice(0, 2).map(p => named(afterBoard, p.square, 'Black’s ')))}` : '',
    effects.defends.length ? `defends your ${list(effects.defends.slice(0, 2).map(p => `${pieceNames[p.type]} on ${p.square}`))}` : '',
    first.piece !== 'p' && effects.to >= effects.from + 3 ? `reaches ${effects.to} squares instead of ${effects.from}` : '',
  ].filter(Boolean);
  const planResult = (kind, { ask, answer, rule, move }, evidence) => result('Your next step', 'plan', {
    ask: [ignore || keepInMind, ask], answer: [answer[0], [answer[1], clearly].filter(Boolean).join(' ')], rule: rule ?? rules.quiet,
    move: [`${move}${lineNote || also}`], reply: !shownLine,
  }, { idea: kind, ...evidence });
  if (point) {
    return planResult(point.kind, {
      ask: planQuestions[point.kind] ?? 'Which of your pieces could do more, and where?',
      answer: [point.idea, `The engine’s choice uses ${piece}.${point.pointer ? ` ${point.pointer}` : ''}`],
      rule: rules[point.kind],
      move: `${first.san} ${point.reason}.`,
    }, { term: point.term });
  }
  if (first.flags.includes('k') || first.flags.includes('q')) {
    return planResult('castle', {
      ask: planQuestions.castle,
      answer: ['Your king is still in the centre: castling would make it safer and connect your rooks.', `Castle ${first.flags.includes('k') ? 'kingside' : 'queenside'}.`],
      rule: rules.castle,
      move: `${first.san}.`,
    });
  }
  // A pawn controls the squares it attacks, not the square in front of it.
  const controls = square => first.piece === 'p'
    ? Math.abs(square.charCodeAt(0) - first.to.charCodeAt(0)) === 1 && Number(square[1]) === Number(first.to[1]) + 1
    : new Chess(withTurn(first.after, 'w')).moves({ square: first.to, verbose: true }).some(move => move.to === square);
  const central = centre.filter(square => square !== first.to && controls(square));
  if (['n', 'b'].includes(first.piece) && first.from[1] === '1') {
    return planResult('develop', {
      ask: planQuestions.develop,
      answer: [features.undeveloped.length > 1 ? `Your ${list(features.undeveloped.map(square => `${pieceNames[board.get(square).type]} on ${square}`))} are still at home: give one of them a job.` : 'Your last minor piece is still at home: bring it into play.', `Start with ${piece}.`],
      rule: rules.develop,
      move: `${first.san} develops your ${pieceNames[first.piece]}${central.length ? ` and controls ${list(central)}` : ''}.`,
    });
  }
  const file = first.to[0];
  if (first.piece === 'r' && first.from[0] !== file && (features.openFiles.includes(file) || features.halfOpenFiles.includes(file))) {
    const kind = features.openFiles.includes(file) ? 'open' : 'half-open';
    return planResult('file', {
      ask: planQuestions.file,
      answer: [`The ${file}-file is ${kind}: a rook there would have more scope.`, `Use ${piece}.`],
      rule: rules.file,
      move: `${first.san} puts your rook on the ${kind} ${file}-file${effects.attacks.length ? ` and attacks ${list(effects.attacks.slice(0, 2).map(p => named(afterBoard, p.square, 'Black’s ')))}` : ''}.`,
    });
  }
  if (first.piece === 'p' && features.passed.includes(first.from)) {
    return planResult('passed', {
      ask: planQuestions.passed,
      answer: [`Your passed pawn on ${first.from} is your trump: no Black pawn can stop it.`, 'Think about pushing it now.'],
      rule: rules.passed,
      move: `${first.san} advances your passed pawn.`,
    });
  }
  if (first.piece === 'p' && ['c', 'd', 'e', 'f'].includes(first.from[0]) && Number(fen.split(' ')[5]) <= 20 && (centre.includes(first.to) || central.length)) {
    return planResult('centre', {
      ask: planQuestions.centre,
      answer: ['Fight for the centre with a pawn.', `Use your ${first.from[0]}-pawn.`],
      rule: rules.centre,
      move: `${first.san} ${centre.includes(first.to) ? 'takes space in the centre' : `controls ${list(central)}`}.`,
    });
  }
  // Otherwise: an improving move. Say what it does from its new square.
  const reason = moveReason(fen, first, { recaptured: recaptured() }) || (first.captured ? `takes Black’s ${pieceNames[first.captured]} on ${first.to}` : '');
  // The general plan is only worth saying when the engine's move carries it out; otherwise it points elsewhere.
  const planText = plan(fen) ?? '';
  // A piece standing between the king and a rook on the first rank: moving it helps castling.
  const fromFile = first.from[0];
  const kingSide = first.from[1] === '1' && ((fromFile > 'e' && fromFile < 'h') || (fromFile < 'e' && fromFile > 'a'));
  const planFits = planText.includes(first.from) || (/castle/.test(planText) && kingSide)
    || (/-file is/.test(planText) && first.piece === 'r') || (/endgame your king/.test(planText) && first.piece === 'k');
  const endgameKing = /endgame your king/.test(planText) && first.piece === 'k';
  const least = features.leastActive;
  const improvesLeast = least && least.square === first.from && effects.to > effects.from;
  const ask = forcing ? 'What are your checks and captures? Which one leaves Black the fewest good answers?'
    : endgameKing ? 'Where is your king most useful: near Black’s king, or near the pawns?'
    : improvesLeast ? planQuestions.activate
    : effects.attacks.length ? 'Which Black piece can you put under pressure without giving anything away?'
    : effects.defends.length ? 'Which of your pieces needs more support?'
    : 'Which of your pieces could do more, and where?';
  const answer = planFits ? planText
    : improvesLeast ? `Your ${pieceNames[least.type]} on ${least.square} is your least active piece: it has only ${least.moves} ${least.moves === 1 ? 'move' : 'moves'}.`
    : forcing ? 'Look at the checks and captures first.' : 'There is no tactic here: improve a piece or take squares from Black’s pieces.';
  // No named idea: never claim that nothing is there, since the engine's move may still be clearly best.
  return planResult(endgameKing ? 'endgame' : improvesLeast ? 'activate' : 'quiet', {
    ask, answer: [answer, `The engine’s choice uses ${piece}.`],
    rule: forcing ? rules.mate.replace('look at checks first', 'look at checks and captures first') : endgameKing ? rules.endgame : improvesLeast ? rules.activate : undefined,
    move: `${first.san}${reason ? ` ${reason}` : first.san.endsWith('+') ? ' gains time with check' : effectText.length ? ` ${list(effectText)}` : ''}.`,
  });
}
