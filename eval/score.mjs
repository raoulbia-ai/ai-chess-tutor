// Scores one or more runs from eval/run.mjs against the suite labels.
//
//   node eval/score.mjs baseline               # eval/runs/baseline.jsonl
//   node eval/score.mjs baseline candidate     # side by side
//   node eval/score.mjs baseline --show        # also list each lesson that misses a key point or breaks a check
//
// Key points (does the lesson say what a coach would say first?):
//   hint: names the puzzle solution, names a move within 0.5 pawns of the best, names the square Black threatens,
//         names the move that punishes Black's blunder, names the puzzle's theme (fork, pin, mate, ...).
//   turn: notices Black's blunder (names the winning move or its square), notices your mistake, names Black's threat.
// Checks (is everything it says true?):
//   a piece named on a square must be there now, or after a move the lesson or the engine lines mention;
//   a move written in notation must be legal in one of those positions.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const show = args.includes('--show');
const runs = args.filter(arg => !arg.startsWith('--'));
const suite = new Map(['eval/suite.json', 'eval/suite.local.json'].filter(file => existsSync(root + file))
  .flatMap(file => JSON.parse(readFileSync(root + file, 'utf8'))).map(item => [item.id, item]));

// Dollars per million tokens: input, cached input, output.
const prices = { 'gpt-6.1-terra': [1, 0.05, 5], 'gpt-6-luna': [0.1, 0.01, 0.5], 'gpt-6.2-sol': [2, 0.1, 10], 'gpt-4.1-mini': [0.4, 0.1, 1.6],
  'gpt-4.1': [2, 0.5, 8], 'gpt-5.4-nano': [0.2, 0.02, 1.25], 'gpt-5.4-mini': [0.75, 0.075, 4.5] };
const cost = calls => calls.reduce((sum, call) => {
  const [input, cached, output] = prices[call.model] ?? [0, 0, 0];
  return sum + ((call.input - (call.cached ?? 0)) * input + (call.cached ?? 0) * cached + call.output * output) / 1e6;
}, 0);

const names = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
const strip = san => san.replace(/[+#]$/, '');
const sanPattern = /(?<![A-Za-z0-9])(O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?)[+#]?(?![A-Za-z0-9])/g;
const mentionsMove = (text, san) => [...text.matchAll(sanPattern)].some(match => strip(match[0]) === strip(san))
  || (/^[a-h][1-8]$/.test(strip(san)) && new RegExp(`(?<![A-Za-z0-9])${strip(san)}(?![A-Za-z0-9])`).test(text) && /\b(?:play|push|advance|move|consider)\b/i.test(text))
  || new RegExp(`(?:^|\\n)${strip(san).replace(/[+]/g, '\\+')}[+#]?:`).test(text);
const mentionsSquare = (text, square) => new RegExp(`(?<![A-Za-z0-9])${square}(?![A-Za-z0-9])`).test(text);
const play = (fen, moves) => { const game = new Chess(fen); const boards = [];
  for (const san of moves) { try { game.move(san); boards.push(game.fen()); } catch { break; } } return boards; };

// Positions the lesson may legitimately talk about: now, the positions before the last moves, the engine lines,
// Black's threat line, every position after one move, and after a move and reply that the lesson itself names.
function reachable(item, text) {
  const fens = new Set([item.fen]);
  if (item.moves) { const game = new Chess(); const history = [];
    for (const san of item.moves) { game.move(san); history.push(game.fen()); }
    history.slice(-3).forEach(fen => fens.add(fen));
    const before = new Chess(); for (const san of item.moves.slice(0, -2)) before.move(san); fens.add(before.fen()); }
  for (const line of item.lines ?? []) play(item.fen, line.moves).forEach(fen => fens.add(fen));
  if (item.threat) { const parts = item.fen.split(' '); parts[1] = 'b'; parts[3] = '-'; const passed = parts.join(' ');
    fens.add(passed); play(passed, item.threat.line ?? item.threat.moves).forEach(fen => fens.add(fen)); }
  const mentioned = new Set([...text.matchAll(sanPattern)].map(match => strip(match[0])));
  const rootGame = new Chess(item.fen);
  for (const move of rootGame.moves({ verbose: true })) {
    fens.add(move.after);
    const child = new Chess(move.after);
    for (const reply of child.moves({ verbose: true })) {
      if (mentioned.has(strip(reply.san)) || mentioned.has(strip(move.san))) {
        fens.add(reply.after);
        if (mentioned.has(strip(reply.san))) {
          for (const next of new Chess(reply.after).moves({ verbose: true })) if (mentioned.has(strip(next.san))) fens.add(next.after);
        }
      }
    }
  }
  return [...fens];
}

function checks(item, text) {
  const fens = reachable(item, text);
  const boards = fens.map(fen => new Chess(fen));
  const problems = [];
  const pieceRef = /(?:(White|Black)[’']s|(your)|the)\s+(pawn|knight|bishop|rook|queen|king)\s+on\s+([a-h][1-8])/gi;
  for (const [, side, your, piece, square] of text.matchAll(pieceRef)) {
    const color = your ? 'w' : side ? side[0].toLowerCase() : null;
    const ok = boards.some(board => { const found = board.get(square); return found && found.type === names[piece.toLowerCase()] && (!color || found.color === color); });
    if (!ok) problems.push(`no ${side ?? your ?? ''} ${piece} on ${square}`.replace(/\s+/g, ' '));
  }
  const legal = new Set(boards.flatMap(board => board.moves().map(strip)));
  for (const match of text.matchAll(sanPattern)) if (!legal.has(strip(match[0]))) problems.push(`move ${match[0]} not legal in any position discussed`);
  return problems;
}

const motifWords = { fork: /\bfork/i, pin: /\bpin/i, skewer: /\bskewer/i, discoveredAttack: /\bdiscover/i, mateIn1: /\bmate\b|checkmate/i,
  mateIn2: /\bmate\b|checkmate/i, backRankMate: /\bmate\b|checkmate|back rank/i, hangingPiece: /undefended|hanging|unprotected|nothing defends|not defended|free/i,
  trappedPiece: /\btrap/i, advancedPawn: /promot/i, capturingDefender: /defender/i };

function keyPoints(item, record) {
  const text = `${record.title ?? ''}\n${record.text ?? ''}`;
  const best = item.lines?.[0]?.moves[0];
  const near = (item.lines ?? []).filter(line => item.lines[0].cp - line.cp <= 50).map(line => line.moves[0]);
  const threat = item.threat && (item.threat.materialGain >= 1 || item.threat.mate) ? item.threat : null;
  const keys = {};
  if (record.mode === 'hint') {
    if (item.solution) keys.solution = mentionsMove(text, item.solution[0]);
    if (best) keys.goodMove = near.some(san => mentionsMove(text, san));
    if (threat) keys.threat = threat.mate ? /\bmate\b|checkmate/i.test(text) || mentionsSquare(text, threat.to) : mentionsSquare(text, threat.to);
    if (item.lastMoves?.black?.loss >= 200 && best) keys.punish = mentionsMove(text, best);
    // When the best line wins material, a good hint says where: the square of White's first capture in it.
    const win = materialWin(item);
    if (win) keys.whereMaterialIsWon = mentionsSquare(text, win.square);
    const themes = (item.themes ?? []).filter(theme => motifWords[theme]);
    if (themes.length) keys.theme = themes.some(theme => motifWords[theme].test(text));
  }
  if (record.mode === 'turn') {
    if (item.lastMoves?.black?.loss >= 200 && best) {
      const to = (() => { try { return new Chess(item.fen).move(best).to; } catch { return null; } })();
      const mating = item.lines[0].score?.type === 'mate' && item.lines[0].score.value > 0;
      keys.blackBlunder = mentionsMove(text, best) || (to && mentionsSquare(text, to) && /\b(?:win|wins|undefended|hanging|free|take|capture|fork|pin|skewer|trap)/i.test(text))
        || (mating && /\bmate\b/i.test(text));
    }
    if (item.lastMoves?.white?.loss >= 150) keys.yourMistake = /\b(?:mistake|blunder|inaccura|loses|lost|better was|instead|stronger)/i.test(text);
    // With a forced mate of your own, Black's threat no longer matters.
    const mating = item.lines?.[0]?.score?.type === 'mate' && item.lines[0].score.value > 0;
    if (threat && !mating) keys.threat = threat.mate ? /\bmate\b|checkmate/i.test(text) || mentionsSquare(text, threat.to) : mentionsSquare(text, threat.to);
  }
  return keys;
}

// White's settled material gain along the best line (after each of White's moves, the worst of the first two),
// and the square of White's first capture. Returns null when the line wins less than two points.
function materialWin(item) {
  const line = item.lines?.[0]; if (!line) return null;
  const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const game = new Chess(item.fen); const balance = () => game.board().flat().reduce((sum, piece) => sum + (piece ? values[piece.type] * (piece.color === 'w' ? 1 : -1) : 0), 0);
  const start = balance(); const afterBlack = []; let capture = null;
  for (const san of line.moves.slice(0, 4)) { let move; try { move = game.move(san); } catch { break; }
    if (move.color === 'w' && move.captured && !capture) capture = move.to;
    if (move.color === 'b') afterBlack.push(balance() - start); }
  const gain = afterBlack.length ? Math.min(...afterBlack) : 0;
  return gain >= 2 && capture ? { gain, square: capture } : null;
}

const fallback = record => record.error || !record.text?.trim() || record.title === 'This position' || /I couldn’t verify/.test(record.text) || /^Consider [^.]*\. /.test(record.text);
const pct = (hit, total) => total ? `${Math.round(100 * hit / total)}% (${hit}/${total})` : '–';
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };
const p90 = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0; };

const tables = {};
for (const run of runs) {
  const records = readFileSync(`${root}eval/runs/${run}.jsonl`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const mode of [...new Set(records.map(record => record.mode))]) {
    const list = records.filter(record => record.mode === mode && suite.has(record.id));
    const rows = {}; const add = (label, value) => { (tables[`${mode}`] ??= {})[label] ??= {}; tables[mode][label][run] = value; };
    const keyTotals = {}; const failures = [];
    let broken = 0;
    for (const record of list) {
      const item = suite.get(record.id);
      const keys = keyPoints(item, record);
      for (const [key, hit] of Object.entries(keys)) { keyTotals[key] ??= [0, 0]; keyTotals[key][1]++; if (hit) keyTotals[key][0]++; }
      const problems = record.text ? checks(item, `${record.title ?? ''}\n${record.text}`) : [];
      if (problems.length) broken++;
      if (show && (problems.length || Object.values(keys).some(hit => !hit))) failures.push({ id: record.id, missed: Object.keys(keys).filter(key => !keys[key]), problems, text: record.text });
    }
    add('lessons', String(list.length));
    add('errors', pct(list.filter(record => record.error).length, list.length));
    add('fallback text', pct(list.filter(fallback).length, list.length));
    add('lessons with a false reference', pct(broken, list.length));
    for (const [key, [hit, total]] of Object.entries(keyTotals)) add(`key: ${key}`, pct(hit, total));
    add('words (median)', String(median(list.map(record => (record.text ?? '').split(/\s+/).filter(Boolean).length))));
    add('seconds (median / p90)', `${(median(list.map(record => record.ms)) / 1000).toFixed(1)} / ${(p90(list.map(record => record.ms)) / 1000).toFixed(1)}`);
    add('model calls per lesson', (list.reduce((sum, record) => sum + record.calls.length, 0) / (list.length || 1)).toFixed(2));
    add('$ per 1,000 lessons', (1000 * list.reduce((sum, record) => sum + cost(record.calls), 0) / (list.length || 1)).toFixed(2));
    if (show) for (const failure of failures) console.log(`[${run} ${mode}] ${failure.id} missed: ${failure.missed.join(', ') || '–'}${failure.problems.length ? ` | false: ${failure.problems.join('; ')}` : ''}\n    ${(failure.text ?? '').replace(/\n/g, '\n    ')}`);
  }
}
for (const [mode, rows] of Object.entries(tables)) {
  console.log(`\n## ${mode}\n`);
  console.log(`| | ${runs.join(' | ')} |\n|---|${runs.map(() => '---').join('|')}|`);
  for (const [label, values] of Object.entries(rows)) console.log(`| ${label} | ${runs.map(run => values[run] ?? '–').join(' | ')} |`);
}
