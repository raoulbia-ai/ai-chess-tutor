// Positional reasons for a quiet move: what the engine's best move improves when it wins no material.
// Stockfish 15.1, the last release with the classical evaluation, splits a position's score into named terms
// (pawns, piece placement, mobility, king safety, threats, passed pawns, space). The terms that change most over
// the best move and Black's reply say what the move is about; the detectors below name the concrete feature
// (an outpost, a weak pawn, an open file). Without that engine (scripts/install-classical-eval.sh), the detectors
// are tried in a fixed order instead.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { captureGain, pieceNames, values, withTurn } from './analysis.mjs';
import { onStopEngine } from './engine.mjs';

const binary = process.env.CLASSICAL_EVAL_ENGINE || fileURLToPath(new URL('../.engines/stockfish-15.1', import.meta.url));
let engine = null, queue = Promise.resolve();

function start() {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const state = { child, buffer: '', job: null, alive: true };
  const fail = () => { state.alive = false; if (engine === state) engine = null; state.job?.(null); };
  child.on('error', fail); child.on('exit', fail); child.stdin.on('error', () => {});
  child.stdout.on('data', data => {
    state.buffer += data.toString();
    // The eval command ends with the "Final evaluation" line (or "none (in check)").
    const end = state.buffer.indexOf('Final evaluation');
    if (end >= 0 && state.buffer.indexOf('\n', end) >= 0) {
      const text = state.buffer; state.buffer = '';
      const job = state.job; state.job = null; job?.(text);
    }
  });
  child.stdin.write('uci\n');
  return state;
}

// Classical terms of a position, from White's side, in pawns, blended between middlegame and endgame by phase.
// Null when the engine is not installed or the position is in check (no static evaluation then).
export function classicalTerms(fen) {
  if (!existsSync(binary)) return Promise.resolve(null);
  const run = queue.then(() => new Promise(resolve => {
    if (!engine?.alive) engine = start();
    const timer = setTimeout(() => { engine.job = null; resolve(null); }, 3000);
    engine.job = text => { clearTimeout(timer); resolve(text ? parse(text, fen) : null); };
    engine.child.stdin.write(`position fen ${fen}\neval\n`);
  }));
  queue = run.catch(() => {});
  return run;
}

export function stopClassical() { if (engine) { engine.alive = false; engine.child.kill(); engine = null; } }
onStopEngine(stopClassical);

function parse(text, fen) {
  const board = new Chess(fen);
  // Stockfish's game phase: non-pawn material between the endgame and middlegame limits, scaled to 0..128.
  const npm = board.board().flat().filter(p => p && !['p', 'k'].includes(p.type)).reduce((sum, p) => sum + { n: 781, b: 825, r: 1276, q: 2538 }[p.type], 0);
  const phase = Math.max(0, Math.min(128, Math.round(((npm - 3915) * 128) / (15258 - 3915))));
  const terms = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*([A-Za-z ]+?)\s*\|.*\|\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\|$/);
    if (!m || m[1] === 'Term') continue;
    const [mg, eg] = [Number(m[2]), Number(m[3])];
    terms[m[1].toLowerCase()] = (mg * phase + eg * (128 - phase)) / 128;
  }
  return Object.keys(terms).length ? terms : null;
}

// ---- Concrete features --------------------------------------------------------------------------------------

const files = 'abcdefgh';
const list = items => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '';
const fileOf = square => files.indexOf(square[0]);
const rankOf = square => Number(square[1]);
const pawnsOf = (board, color) => board.board().flat().filter(p => p?.type === 'p' && p.color === color);

// Squares a pawn of `color` could ever attack from its file, ahead of it: used for outposts.
function pawnCanAttack(board, color, square) {
  const forward = color === 'w' ? 1 : -1;
  return pawnsOf(board, color).some(p => Math.abs(fileOf(p.square) - fileOf(square)) === 1
    && (forward > 0 ? rankOf(p.square) < rankOf(square) : rankOf(p.square) > rankOf(square)));
}

// An outpost for White: in Black's half (ranks 4–6), defended by a White pawn, and no Black pawn can attack it.
export function isOutpost(board, square) {
  const r = rankOf(square);
  if (r < 4 || r > 6) return false;
  const defended = board.attackers(square, 'w').some(s => board.get(s)?.type === 'p');
  return defended && !pawnCanAttack(board, 'b', square);
}

// Weak pawns of a colour: isolated (no friendly pawn on a neighbouring file), doubled, or backward (its neighbours
// have advanced past it and the square in front is covered by an enemy pawn).
export function weakPawns(board, color) {
  const own = pawnsOf(board, color), enemy = color === 'w' ? 'b' : 'w';
  const forward = color === 'w' ? 1 : -1;
  const result = [];
  for (const p of own) {
    const f = fileOf(p.square), r = rankOf(p.square);
    const neighbours = own.filter(q => Math.abs(fileOf(q.square) - f) === 1);
    const sameFile = own.filter(q => q.square !== p.square && fileOf(q.square) === f);
    const stop = files[f] + (r + forward);
    if (!neighbours.length) result.push({ square: p.square, kind: 'isolated' });
    else if (!neighbours.some(q => forward > 0 ? rankOf(q.square) <= r : rankOf(q.square) >= r)
      && board.attackers(stop, enemy).some(s => board.get(s)?.type === 'p')) result.push({ square: p.square, kind: 'backward' });
    else if (sameFile.length) result.push({ square: p.square, kind: 'doubled' });
  }
  return result;
}

const mobility = (fen, square) => {
  const piece = new Chess(fen).get(square);
  try { return new Chess(withTurn(fen, piece.color)).moves({ square }).length; } catch { return 0; }
};

const kingZone = (board, color) => {
  const king = board.board().flat().find(p => p?.type === 'k' && p.color === color).square;
  const zone = [];
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    const f = fileOf(king) + df, r = rankOf(king) + dr;
    if (f >= 0 && f < 8 && r >= 1 && r <= 8) zone.push(files[f] + r);
  }
  return zone;
};

// Why keeping a Black piece out of a square matters: what it would attack from there.
function deniedWhy(fen, denied) {
  const there = new Chess(denied.after);
  const targets = there.board().flat().filter(p => p?.color === 'w' && ['n', 'b', 'r', 'q'].includes(p.type)
    && there.attackers(p.square, 'b').includes(denied.to)).map(p => `your ${pieceNames[p.type]} on ${p.square}`);
  return `${targets.length ? `From ${denied.to} it would attack ${list(targets)}. ` : ''}Keeping it out now is easier than reacting once it arrives.`;
}

// Candidate ideas in the best move, each tied to the classical term it should move.
function detect(fen, move, after) {
  const board = new Chess(fen), next = new Chess(after);
  const ideas = [];
  const piece = move.piece, to = move.to;
  const name = pieceNames[piece];
  // Challenging an active Black piece: the move attacks a Black piece that presses on one of yours. It wins nothing
  // by force (that would be a threat, see threatPoint), but Black has to decide what to do with that piece.
  if (!move.captured && piece !== 'k') {
    for (const p of next.board().flat().filter(p => p?.color === 'b' && ['n', 'b', 'r', 'q'].includes(p.type))) {
      if (!next.attackers(p.square, 'w').includes(to) || board.attackers(p.square, 'w').includes(move.from) || values[p.type] < values[piece]) continue;
      // The pressure is judged before the move: the pressed piece may be the one that now attacks back (Nf3-e5 against ...Bg4).
      const victim = board.board().flat().find(q => q?.color === 'w' && ['n', 'b', 'r', 'q'].includes(q.type)
        && board.attackers(q.square, 'b').includes(p.square));
      if (!victim) continue;
      const [its, yours] = [`Black’s ${pieceNames[p.type]} on ${p.square}`, `your ${pieceNames[victim.type]} on ${victim.square}`];
      ideas.push({ term: 'threats', kind: 'challenge', square: p.square,
        idea: `${its} is pressing on ${yours}: challenge it.`,
        why: `${values[piece] < values[p.type] ? `Attacked by your ${name}, it cannot stay: Black has to move it away or exchange it.`
          : `Attacking it makes Black decide now: move it away, defend it again, or ${p.type === piece ? `let you trade ${pieceNames[piece]}s` : `let you trade your ${name} for it`}.`} Black spends time on that piece instead of building up pressure${piece === 'p' ? '' : `, and your ${name} gets a more active square`}.`,
        pointer: '', reason: `attacks ${its}, which was pressing on ${yours}` });
      break;
    }
  }
  // A knight or bishop landing on an outpost.
  if (['n', 'b'].includes(piece) && isOutpost(next, to) && !isOutpost(board, move.from)) {
    ideas.push({ why: `No Black pawn can ever attack ${to}, so your ${name} can stay there for good: Black would have to give up a piece to remove it.`, term: piece === 'n' ? 'knights' : 'bishops', kind: 'outpost', square: to,
      idea: 'Look for an outpost: a square in Black’s half, protected by your pawn, that no Black pawn can attack.',
      pointer: `The square is ${to}.`, reason: `puts your ${name} on ${to}, an outpost that no Black pawn can attack` });
  }
  // Pressure on a weak Black pawn: the moved piece attacks it, and it was not attacked by that piece before.
  for (const weak of weakPawns(next, 'b')) {
    if (next.attackers(weak.square, 'w').includes(to) && !board.attackers(weak.square, 'w').includes(move.from)) {
      ideas.push({ why: weak.kind === 'doubled' ? `Doubled pawns cannot defend each other, so the pawn on ${weak.square} needs a piece to guard it, and that piece is then tied down.` : `No Black pawn can defend the pawn on ${weak.square}, so Black has to keep pieces guarding it, and those pieces are then tied down.`, term: 'pawns', kind: 'weak pawn', square: weak.square,
        idea: `Black’s ${weak.kind} pawn on ${weak.square} is a weakness: aim at it.`,
        pointer: '', reason: `attacks the ${weak.kind} pawn on ${weak.square}` });
      break;
    }
  }
  // A pawn move or exchange that leaves Black with a new weak pawn.
  const before = new Set(weakPawns(board, 'b').map(w => w.square + w.kind));
  const created = weakPawns(next, 'b').find(w => !before.has(w.square + w.kind));
  if (created && (piece === 'p' || move.captured)) {
    ideas.push({ why: 'A weak pawn cannot be defended by another pawn: it stays a target for the rest of the game, and Black’s pieces get tied to guarding it.', term: 'pawns', kind: 'damage', square: created.square,
      idea: 'You can damage Black’s pawn structure.',
      pointer: '', reason: `leaves Black with ${created.kind === 'doubled' ? 'doubled pawns' : `${created.kind === 'isolated' ? 'an isolated' : 'a backward'} pawn`} on ${created.square}` });
  }
  // A rook to an open or half-open file, or to the seventh rank.
  if (piece === 'r') {
    const file = to[0];
    const open = !next.board().flat().some(p => p?.type === 'p' && p.square[0] === file);
    const halfOpen = !open && !pawnsOf(next, 'w').some(p => p.square[0] === file);
    if (move.from[0] !== file && (open || halfOpen)) {
      ideas.push({ why: `${open ? 'No pawn stands' : 'None of your pawns stands'} on the ${file}-file, so a rook there reaches into Black’s half. Behind its own pawns a rook does nothing.`, term: 'rooks', kind: 'file', square: to,
        idea: `The ${file}-file is ${open ? 'open' : 'half-open'}: a rook there would have more scope.`,
        pointer: '', reason: `puts your rook on the ${open ? 'open' : 'half-open'} ${file}-file` });
    }
    if (to[1] === '7' && move.from[1] !== '7') {
      ideas.push({ why: 'Pawns that have not moved can only be guarded by pieces, so a rook on the seventh ties Black’s pieces down.', term: 'rooks', kind: 'seventh', square: to,
        idea: 'A rook on the seventh rank attacks Black’s pawns from behind.', pointer: '', reason: 'puts your rook on the seventh rank' });
    }
  }
  // A passed pawn created or pushed.
  const passed = (b, sq) => b.get(sq)?.type === 'p' && !pawnsOf(b, 'b').some(p => Math.abs(fileOf(p.square) - fileOf(sq)) <= 1 && rankOf(p.square) > rankOf(sq));
  if (piece === 'p' && passed(next, to)) {
    ideas.push({ why: 'No Black pawn can stop it, so Black has to block it with a piece, and every step forward makes that harder.', term: 'passed', kind: 'passed', square: to,
      idea: passed(board, move.from) ? `Your passed pawn on ${move.from} is your trump: push it.` : 'You can create a passed pawn.',
      pointer: '', reason: passed(board, move.from) ? 'advances your passed pawn' : `creates a passed pawn on ${to}` });
  }
  // More pieces aimed at Black's king: only when there is an attack to join. A king still on e8 that can castle is
  // not a target yet, and one piece touching two squares next to it is not an attack.
  const zone = kingZone(next, 'b');
  const hits = (b, sq) => zone.filter(z => b.attackers(z, 'w').includes(sq)).length;
  const kingSquare = next.board().flat().find(p => p?.type === 'k' && p.color === 'b').square;
  const atHome = kingSquare === 'e8' && /[kq]/.test(after.split(' ')[2]);
  const aimed = color => new Set(zone.flatMap(z => next.attackers(z, color)).filter(sq => !['p', 'k'].includes(next.get(sq).type)));
  const [attackers, defenders] = [aimed('w').size, aimed('b').size];
  if (piece !== 'k' && !atHome && attackers >= 3 && hits(next, to) > hits(board, move.from) && hits(next, to) >= 2) {
    ideas.push({ term: 'king safety', kind: 'king attack', square: to,
      why: `${attackers} of your pieces now aim at the squares around Black’s king on ${kingSquare}, against ${defenders} Black ${defenders === 1 ? 'piece' : 'pieces'} guarding them. An attack on the king works when the attackers outnumber the defenders.`,
      idea: 'Bring another piece into the attack on Black’s king.', pointer: '', reason: 'aims another piece at Black’s king' });
  }
  // Your own king: castling or a move that shelters it.
  if (piece === 'k' && Math.abs(fileOf(move.from) - fileOf(to)) === 2) {
    ideas.push({ why: 'In the centre your king is hit first when lines open. Castling hides it behind pawns and brings a rook toward the middle.', term: 'king safety', kind: 'castle', square: to,
      idea: 'Your king is still in the centre: castling would make it safer and connect your rooks.', pointer: '', reason: 'tucks your king away and brings a rook toward the centre' });
  }
  // A piece that gets much more active (not a capture: that piece is usually taken back).
  const central = sq => ['c', 'd', 'e', 'f'].includes(sq[0]) && rankOf(sq) >= 3 && rankOf(sq) <= 6;
  if (!['p', 'k'].includes(piece) && !move.captured && !central(to)) {
    const [was, now] = [mobility(fen, move.from), mobility(after, to)];
    if (now >= was + 3) {
      ideas.push({ why: `A piece with few moves hardly takes part in the game. Giving it ${now} moves instead of ${was} is almost like adding a piece.`, term: 'mobility', kind: 'activate', square: move.from,
        idea: `Your ${name} on ${move.from} is not doing much: find it a better square.`,
        pointer: '', reason: `activates your ${name}: it goes from ${was} to ${now} available moves` });
    }
  }
  // A Black piece that loses most of its squares.
  for (const p of board.board().flat().filter(p => p?.color === 'b' && ['n', 'b', 'r', 'q'].includes(p.type) && next.get(p.square)?.color === 'b')) {
    const [was, now] = [mobility(fen, p.square), mobility(after, p.square)];
    if (was >= 3 && now <= was - 3 && now <= 2) {
      ideas.push({ why: 'A piece with no good squares does little for Black, and it may even get trapped.', term: 'mobility', kind: 'restrict', square: p.square,
        idea: `Black’s ${pieceNames[p.type]} on ${p.square} has few squares: take away the rest.`,
        pointer: '', reason: `takes squares from Black’s ${pieceNames[p.type]} on ${p.square} (from ${was} moves to ${now})` });
      break;
    }
  }
  // A pawn break: the pawn now attacks a Black pawn, or offers an exchange to one, opening lines.
  if (piece === 'p' && !move.captured) {
    const target = [-1, 1].map(df => files[fileOf(to) + df] && files[fileOf(to) + df] + (rankOf(to) + 1))
      .find(sq => sq && next.get(sq)?.type === 'p' && next.get(sq)?.color === 'b');
    const offered = next.attackers(to, 'b').find(sq => next.get(sq)?.type === 'p');
    if (target) {
      ideas.push({ why: 'Exchanging pawns opens files and diagonals. That pays when your pieces are ready to use them.', term: 'mobility', kind: 'break', square: to,
        idea: `Challenge Black’s pawn on ${target} with a pawn: if Black takes or lets you take, lines open for your pieces.`,
        pointer: '', reason: `challenges Black’s pawn on ${target}; an exchange there opens lines for your pieces` });
    } else if (offered) {
      ideas.push({ why: 'Exchanging pawns opens files and diagonals. That pays when your pieces are ready to use them.', term: 'mobility', kind: 'break', square: to,
        idea: 'Offer a pawn exchange: trading pawns opens lines for your pieces.',
        pointer: '', reason: `offers Black’s pawn on ${offered} an exchange that opens lines for your pieces` });
    }
  }
  // Trading off a strong Black piece: an even exchange that removes a centralised or outposted Black piece.
  if (move.captured && ['n', 'b'].includes(move.captured) && values[move.captured] >= values[piece] && next.attackers(to, 'b').length) {
    if (central(to)) {
      ideas.push({ why: 'A well-placed enemy piece does damage for as long as it stays. Trading it removes that, and an even trade costs you nothing.', term: 'knights', kind: 'trade', square: to,
        idea: `Black’s ${pieceNames[move.captured]} on ${to} is well placed: trade it off.`,
        pointer: '', reason: `trades off Black’s strong ${pieceNames[move.captured]} on ${to}${values[move.captured] === values[piece] ? `: ${piece === move.captured ? `a ${name} for a ${name}` : `your ${name} for a ${pieceNames[move.captured]}, both worth 3`}, an even trade` : ''}` });
    }
  }
  // Keeping a bishop that a Black knight wants to trade for, while White has both bishops.
  const bishops = sq => sq.board().flat().filter(p => p?.type === 'b' && p.color === 'w').length;
  if (piece === 'b' && bishops(board) === 2 && !move.captured) {
    const hunter = board.attackers(move.from, 'b').find(sq => board.get(sq)?.type === 'n');
    if (hunter && !next.attackers(to, 'b').some(sq => next.get(sq)?.type === 'n')) {
      ideas.push({ why: 'Two bishops together cover squares of both colours. In an open position they are often worth more than a bishop and a knight.', term: 'bishops', kind: 'keep bishop', square: move.from,
        idea: `Black’s knight on ${hunter} wants to trade itself for your bishop on ${move.from}: keep your bishop pair.`,
        pointer: '', reason: `keeps your bishop out of reach of the knight on ${hunter}` });
    }
  }
  // A piece brought toward the centre: in the opening that is development, later centralisation.
  if (!['p', 'k'].includes(piece) && !move.captured && central(to)) {
    const [was, now] = [mobility(fen, move.from), mobility(after, to)];
    // Central squares the piece now bears on, including ones your own pawns stand on (it supports them there).
    const covers = ['d4', 'e4', 'd5', 'e5'].filter(sq => sq !== to && next.attackers(sq, 'w').includes(to));
    const coverText = covers.map(sq => next.get(sq)?.color === 'w' ? `your ${pieceNames[next.get(sq).type]} on ${sq}` : sq);
    if (move.from[1] === '1' && ['n', 'b'].includes(piece)) {
      ideas.push({ why: 'A piece at home takes no part in the fight. In the opening each move should bring out a new piece: the side that develops first can act first.', term: 'mobility', kind: 'develop', square: to,
        idea: `Bring your ${name} on ${move.from} into play, toward the centre.`,
        pointer: '', reason: `develops your ${name}${covers.length ? `, and from ${to} it ${covers.every(sq => next.get(sq)?.color === 'w') ? 'supports' : 'covers'} ${list(coverText)} in the centre` : now > was ? ` toward the centre: it reaches ${now} squares there instead of ${was}` : ' toward the centre'}` });
    } else if (now >= was + 2) {
      ideas.push({ why: `From the centre a piece reaches both sides of the board: here ${now} squares instead of ${was}.`, term: 'mobility', kind: 'centralise', square: to,
        idea: `Your ${name} on ${move.from} would do more from a central square.`,
        pointer: '', reason: `centralises your ${name}: it reaches ${now} squares there instead of ${was}${covers.length ? `, including ${list(covers)}` : ''}` });
    }
  }
  // A pawn that gains space in Black's half without becoming weak: name the squares it takes and the Black pieces
  // that lose them. A pawn that challenges a Black pawn is a break instead (above).
  if (piece === 'p' && rankOf(to) >= 4 && ['c', 'd', 'e', 'f'].includes(to[0]) && !move.captured
    && !weakPawns(next, 'w').some(w => w.square === to) && !ideas.some(i => i.kind === 'break')) {
    const taken = [-1, 1].map(df => files[fileOf(to) + df] && files[fileOf(to) + df] + (rankOf(to) + 1)).filter(Boolean);
    let blackMoves = [];
    try { blackMoves = new Chess(withTurn(fen, 'b')).moves({ verbose: true }); } catch {}
    const losers = new Map();
    for (const m of blackMoves.filter(m => taken.includes(m.to) && m.piece !== 'p' && m.piece !== 'k')) {
      losers.set(m.from, [...(losers.get(m.from) ?? []), m.to]);
    }
    const victims = [...losers.entries()].map(([sq, squares]) => ({ sq, squares, type: board.get(sq).type }));
    const who = victims.map(v => `${pieceNames[v.type]} on ${v.sq}`);
    // Black pawn advances the new pawn now meets: e4 makes ...d5 and ...f5 harder.
    const stopped = blackMoves.filter(m => m.piece === 'p' && taken.includes(m.to)).map(m => `…${m.to}`);
    const pieces = victims.length ? `: Black’s ${list(victims.map(v => `${pieceNames[v.type]} on ${v.sq} can no longer go to ${list(v.squares)}`))}` : '';
    const pawns = stopped.length ? `${pieces ? ', and' : ':'} Black’s ${list([...new Set(stopped)])} ${stopped.length > 1 ? 'become' : 'becomes'} harder to play` : '';
    if (rankOf(to) === 4) {
      ideas.push({ why: 'Centre pawns take squares away from Black’s pieces and give yours room behind them.', term: 'space', kind: 'centre', square: to,
        idea: 'Occupy the centre with a pawn on the fourth rank: it controls squares Black wants to use.',
        pointer: '', reason: `takes the centre and controls ${list(taken)}${pieces}${pawns}` });
    } else {
      ideas.push({ why: 'The more squares your pawns take in Black’s half, the fewer good squares Black’s pieces have.', term: 'space', kind: 'space', square: to,
        idea: victims.length ? `Push a centre pawn further: it would take squares away from Black’s ${list(who)}.`
          : 'Push a centre pawn further and claim more of the board: Black’s pieces would have fewer good squares.',
        pointer: '', reason: `takes ${list(taken)} away from Black${pieces}${pawns}` });
    }
  }
  // A quiet pawn move that takes a square from a Black piece (prophylaxis): h3 against a bishop coming to g4.
  if (piece === 'p' && !move.captured && !ideas.some(i => ['break', 'space', 'passed'].includes(i.kind))) {
    const taken = [-1, 1].map(df => files[fileOf(to) + df] && files[fileOf(to) + df] + (rankOf(to) + 1)).filter(Boolean);
    let blackMoves = [];
    try { blackMoves = new Chess(withTurn(fen, 'b')).moves({ verbose: true }); } catch {}
    const denied = blackMoves.find(m => taken.includes(m.to) && ['n', 'b', 'r', 'q'].includes(m.piece));
    if (denied) {
      ideas.push({ why: deniedWhy(fen, denied), term: 'mobility', kind: 'prevent', square: denied.to,
        idea: `Take the ${denied.to} square away from Black’s ${pieceNames[denied.piece]} on ${denied.from} before it gets there.`,
        pointer: '', reason: `stops Black’s ${pieceNames[denied.piece]} on ${denied.from} from coming to ${denied.to}` });
    }
  }
  // A capture is explained only as a trade or as damage to Black's structure: anything else (a sacrifice, a
  // capture that opens the king) is tactical, and the hint's tactical cases describe it better.
  return move.captured ? ideas.filter(idea => ['trade', 'damage'].includes(idea.kind)) : ideas;
}

// A quiet move whose point is a threat: the moved piece newly attacks a Black piece or pawn that could then be won.
// That forces Black to spend a move on it, which matters more than how many squares the piece now reaches.
function threatPoint(fen, move) {
  if (move.captured || /[+#]/.test(move.san)) return null;
  const after = new Chess(move.after);
  let again, now;
  try { again = withTurn(move.after, 'w'); now = withTurn(fen, 'w'); } catch { return null; }
  const target = after.board().flat()
    .filter(p => p && p.color === 'b' && p.type !== 'k' && after.attackers(p.square, 'w').includes(move.to))
    .map(p => ({ ...p, gain: captureGain(again, p.square, 'w') }))
    // A target that can simply take the attacker (a pawn meeting a pawn break) is offered an exchange, not threatened.
    .filter(p => p.gain > 0 && captureGain(now, p.square, 'w') <= 0 && !after.attackers(move.to, 'b').includes(p.square))
    .sort((a, b) => b.gain - a.gain)[0];
  if (!target) return null;
  const name = pieceNames[target.type], guarded = after.attackers(target.square, 'b').length > 0;
  return { kind: 'threat', why: 'A threat makes Black answer it, so Black cannot follow its own plans and you decide what happens next.', term: 'threats', square: target.square, delta: null, pointer: '',
    idea: `Make a threat: Black’s ${name} on ${target.square} ${guarded ? 'is not defended well enough' : 'has no defender'}.`,
    reason: `attacks Black’s ${name} on ${target.square}, which ${guarded ? 'is not defended well enough' : 'nothing defends'}: Black has to spend a move on it` };
}

// The positional point of `move` (a chess.js verbose move from `fen`), judged over the engine's line `sans`
// (best move first). Returns { kind, idea, pointer, reason, term, delta } or null.
export async function positionalPoint(fen, move, sans = []) {
  const threat = threatPoint(fen, move);
  if (threat) return threat;
  const ideas = detect(fen, move, move.after);
  if (!ideas.length) return null;
  // After Black's reply, so a one-move attack that is simply parried does not count as an improvement.
  const game = new Chess(fen);
  let settled = fen;
  try { game.move(sans[0] ?? move.san); settled = game.fen(); if (sans[1]) { game.move(sans[1]); settled = game.fen(); } } catch {}
  const [before, afterTerms] = [await classicalTerms(fen), await classicalTerms(settled)];
  if (!before || !afterTerms) return { ...ideas[0], delta: null };
  const delta = term => (afterTerms[term] ?? 0) - (before[term] ?? 0);
  // Weak-pawn and damage ideas show up in Black's pawn score, which the "pawns" total includes.
  // The term changes are small and noisy, so they only break ties: an idea whose term clearly gets worse is a side
  // effect, not the point; among the rest the one whose term improves most wins.
  // A single idea is the move's purpose by itself; the terms only arbitrate between several.
  if (ideas.length === 1) return { ...ideas[0], delta: delta(ideas[0].term) };
  const ranked = ideas.map((idea, order) => ({ ...idea, delta: delta(idea.term), order }))
    .filter(idea => idea.delta > -0.15)
    .sort((a, b) => (b.delta > 0.05) - (a.delta > 0.05) || a.order - b.order);
  return ranked[0] ?? null;
}

// The terms that change most between two positions, for diagnostics.
export async function termChanges(fenBefore, fenAfter) {
  const [a, b] = [await classicalTerms(fenBefore), await classicalTerms(fenAfter)];
  if (!a || !b) return null;
  return Object.keys(b).filter(term => !['total', 'material', 'imbalance', 'winnable'].includes(term))
    .map(term => ({ term, delta: Math.round(((b[term] ?? 0) - (a[term] ?? 0)) * 100) / 100 }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

