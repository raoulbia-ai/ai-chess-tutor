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

// Candidate ideas in the best move, each tied to the classical term it should move.
function detect(fen, move, after) {
  const board = new Chess(fen), next = new Chess(after);
  const ideas = [];
  const piece = move.piece, to = move.to;
  const name = pieceNames[piece];
  // A knight or bishop landing on an outpost.
  if (['n', 'b'].includes(piece) && isOutpost(next, to) && !isOutpost(board, move.from)) {
    ideas.push({ term: piece === 'n' ? 'knights' : 'bishops', kind: 'outpost', square: to,
      idea: 'Look for an outpost: a square in Black’s half, protected by your pawn, that no Black pawn can attack.',
      pointer: `The square is ${to}.`, reason: `puts your ${name} on ${to}, an outpost that no Black pawn can attack` });
  }
  // Pressure on a weak Black pawn: the moved piece attacks it, and it was not attacked by that piece before.
  for (const weak of weakPawns(next, 'b')) {
    if (next.attackers(weak.square, 'w').includes(to) && !board.attackers(weak.square, 'w').includes(move.from)) {
      ideas.push({ term: 'pawns', kind: 'weak pawn', square: weak.square,
        idea: `Black’s ${weak.kind} pawn on ${weak.square} is a weakness: aim at it.`,
        pointer: '', reason: `attacks the ${weak.kind} pawn on ${weak.square}` });
      break;
    }
  }
  // A pawn move or exchange that leaves Black with a new weak pawn.
  const before = new Set(weakPawns(board, 'b').map(w => w.square + w.kind));
  const created = weakPawns(next, 'b').find(w => !before.has(w.square + w.kind));
  if (created && (piece === 'p' || move.captured)) {
    ideas.push({ term: 'pawns', kind: 'damage', square: created.square,
      idea: 'You can damage Black’s pawn structure.',
      pointer: '', reason: `leaves Black with ${created.kind === 'doubled' ? 'doubled pawns' : `${created.kind === 'isolated' ? 'an isolated' : 'a backward'} pawn`} on ${created.square}` });
  }
  // A rook to an open or half-open file, or to the seventh rank.
  if (piece === 'r') {
    const file = to[0];
    const open = !next.board().flat().some(p => p?.type === 'p' && p.square[0] === file);
    const halfOpen = !open && !pawnsOf(next, 'w').some(p => p.square[0] === file);
    if (move.from[0] !== file && (open || halfOpen)) {
      ideas.push({ term: 'rooks', kind: 'file', square: to,
        idea: `The ${file}-file is ${open ? 'open' : 'half-open'}: a rook there would have more scope.`,
        pointer: '', reason: `puts your rook on the ${open ? 'open' : 'half-open'} ${file}-file` });
    }
    if (to[1] === '7' && move.from[1] !== '7') {
      ideas.push({ term: 'rooks', kind: 'seventh', square: to,
        idea: 'A rook on the seventh rank attacks Black’s pawns from behind.', pointer: '', reason: 'puts your rook on the seventh rank' });
    }
  }
  // A passed pawn created or pushed.
  const passed = (b, sq) => b.get(sq)?.type === 'p' && !pawnsOf(b, 'b').some(p => Math.abs(fileOf(p.square) - fileOf(sq)) <= 1 && rankOf(p.square) > rankOf(sq));
  if (piece === 'p' && passed(next, to)) {
    ideas.push({ term: 'passed', kind: 'passed', square: to,
      idea: passed(board, move.from) ? `Your passed pawn on ${move.from} is your trump: push it.` : 'You can create a passed pawn.',
      pointer: '', reason: passed(board, move.from) ? 'advances your passed pawn' : `creates a passed pawn on ${to}` });
  }
  // More pieces aimed at Black's king.
  const zone = kingZone(next, 'b');
  const hits = (b, sq) => zone.filter(z => b.attackers(z, 'w').includes(sq)).length;
  if (piece !== 'k' && hits(next, to) > hits(board, move.from) && hits(next, to) >= 2) {
    ideas.push({ term: 'king safety', kind: 'king attack', square: to,
      idea: 'Bring another piece into the attack on Black’s king.', pointer: '', reason: 'aims another piece at Black’s king' });
  }
  // Your own king: castling or a move that shelters it.
  if (piece === 'k' && Math.abs(fileOf(move.from) - fileOf(to)) === 2) {
    ideas.push({ term: 'king safety', kind: 'castle', square: to,
      idea: 'Your king is still in the centre: castling would make it safer and connect your rooks.', pointer: '', reason: 'tucks your king away and brings a rook toward the centre' });
  }
  // A piece that gets much more active (not a capture: that piece is usually taken back).
  const central = sq => ['c', 'd', 'e', 'f'].includes(sq[0]) && rankOf(sq) >= 3 && rankOf(sq) <= 6;
  if (!['p', 'k'].includes(piece) && !move.captured && !central(to)) {
    const [was, now] = [mobility(fen, move.from), mobility(after, to)];
    if (now >= was + 3) {
      ideas.push({ term: 'mobility', kind: 'activate', square: move.from,
        idea: `Your ${name} on ${move.from} is not doing much: find it a better square.`,
        pointer: '', reason: `activates your ${name}: it goes from ${was} to ${now} available moves` });
    }
  }
  // A Black piece that loses most of its squares.
  for (const p of board.board().flat().filter(p => p?.color === 'b' && ['n', 'b', 'r', 'q'].includes(p.type) && next.get(p.square)?.color === 'b')) {
    const [was, now] = [mobility(fen, p.square), mobility(after, p.square)];
    if (was >= 3 && now <= was - 3 && now <= 2) {
      ideas.push({ term: 'mobility', kind: 'restrict', square: p.square,
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
      ideas.push({ term: 'mobility', kind: 'break', square: to,
        idea: `Challenge Black’s pawn on ${target} with a pawn: if Black takes or lets you take, lines open for your pieces.`,
        pointer: '', reason: `challenges Black’s pawn on ${target}; an exchange there opens lines for your pieces` });
    } else if (offered) {
      ideas.push({ term: 'mobility', kind: 'break', square: to,
        idea: 'Offer a pawn exchange: trading pawns opens lines for your pieces.',
        pointer: '', reason: `offers Black’s pawn on ${offered} an exchange that opens lines for your pieces` });
    }
  }
  // Trading off a strong Black piece: an even exchange that removes a centralised or outposted Black piece.
  if (move.captured && ['n', 'b'].includes(move.captured) && values[move.captured] >= values[piece] && next.attackers(to, 'b').length) {
    if (central(to)) {
      ideas.push({ term: 'knights', kind: 'trade', square: to,
        idea: `Black’s ${pieceNames[move.captured]} on ${to} is well placed: trade it off.`,
        pointer: '', reason: `trades off Black’s strong ${pieceNames[move.captured]} on ${to}${values[move.captured] === values[piece] ? `: ${piece === move.captured ? `a ${name} for a ${name}` : `your ${name} for a ${pieceNames[move.captured]}, both worth 3`}, an even trade` : ''}` });
    }
  }
  // Keeping a bishop that a Black knight wants to trade for, while White has both bishops.
  const bishops = sq => sq.board().flat().filter(p => p?.type === 'b' && p.color === 'w').length;
  if (piece === 'b' && bishops(board) === 2 && !move.captured) {
    const hunter = board.attackers(move.from, 'b').find(sq => board.get(sq)?.type === 'n');
    if (hunter && !next.attackers(to, 'b').some(sq => next.get(sq)?.type === 'n')) {
      ideas.push({ term: 'bishops', kind: 'keep bishop', square: move.from,
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
      ideas.push({ term: 'mobility', kind: 'develop', square: to,
        idea: `Bring your ${name} on ${move.from} into play, toward the centre.`,
        pointer: '', reason: `develops your ${name}${covers.length ? `, and from ${to} it ${covers.every(sq => next.get(sq)?.color === 'w') ? 'supports' : 'covers'} ${list(coverText)} in the centre` : now > was ? ` toward the centre: it reaches ${now} squares there instead of ${was}` : ' toward the centre'}` });
    } else if (now >= was + 2) {
      ideas.push({ term: 'mobility', kind: 'centralise', square: to,
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
      ideas.push({ term: 'space', kind: 'centre', square: to,
        idea: 'Occupy the centre with a pawn on the fourth rank: it controls squares Black wants to use.',
        pointer: '', reason: `takes the centre and controls ${list(taken)}${pieces}${pawns}` });
    } else {
      ideas.push({ term: 'space', kind: 'space', square: to,
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
      ideas.push({ term: 'mobility', kind: 'prevent', square: denied.to,
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
  return { kind: 'threat', term: 'threats', square: target.square, delta: null, pointer: '',
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

