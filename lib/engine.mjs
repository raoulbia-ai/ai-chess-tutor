import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Chess } from 'chess.js';

const directory = fileURLToPath(new URL('../node_modules/stockfish/bin/', import.meta.url));
let queue = Promise.resolve();
export function analyse(fen, { rootMove, strength } = {}) {
  const run = queue.then(() => search(fen, rootMove, strength));
  queue = run.catch(() => {});
  return run;
}
function search(fen, rootMove, strength) {
  return new Promise((resolve, reject) => {
    const file = readdirSync(directory).find(name => /lite-single.*\.js$/.test(name));
    if (!file) return reject(new Error('Stockfish lite engine is missing. Run npm install.'));
    const child = spawn(process.execPath, [join(directory, file)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = new Map();
    let buffer = '', done = false;
    const timer = setTimeout(() => finish(new Error('Engine analysis timed out. Please retry.')), 20000);
    const send = command => { if (!done && child.stdin.writable) child.stdin.write(command + '\n'); };
    function finish(error, result) {
      if (done) return;
      done = true; clearTimeout(timer); child.kill();
      error ? reject(error) : resolve(result);
    }
    child.on('error', () => finish(new Error('Could not start Stockfish.')));
    child.stdin.on('error', () => {});
    child.on('exit', () => { if (!done) finish(new Error('Stockfish stopped unexpectedly.')); });
    child.stderr.on('data', () => {});
    child.stdout.on('data', data => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line === 'uciok') {
          send('setoption name Threads value 1'); send('setoption name Hash value 16');
          send(`setoption name MultiPV value ${rootMove || strength !== undefined ? 1 : 3}`);
          if (strength !== undefined) send(`setoption name Skill Level value ${strength}`);
          send('isready');
        } else if (line === 'readyok') {
          send(`position fen ${fen}`);
          send(`go depth ${strength !== undefined ? 7 : 16}${rootMove ? ' searchmoves ' + rootMove : ''}`);
        } else if (line.startsWith('info ') && line.includes(' pv ') && !/bound/.test(line)) {
          const score = line.match(/score (cp|mate) (-?\d+)/), pv = line.split(' pv ')[1]?.split(' ');
          if (score && pv) lines.set(Number(line.match(/multipv (\d+)/)?.[1] || 1), { score: { type: score[1], value: Number(score[2]) }, moves: pv.slice(0, 6) });
        } else if (line.startsWith('bestmove ')) {
          const variations = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, variation]) => {
            const game = new Chess(fen), steps = [];
            for (const uci of variation.moves) {
              try {
                const move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
                steps.push({ uci, san: move.san, color: move.color, piece: move.piece, from: move.from, to: move.to, captured: move.captured || null, fen: game.fen() });
              } catch { break; }
            }
            return { score: variation.score, steps };
          }).filter(v => v.steps.length);
          finish(null, { bestmove: line.split(' ')[1], variations });
        }
      }
    });
    send('uci');
  });
}
export function scoreValue(score) {
  return score.type === 'mate' ? (score.value > 0 ? 100000 - score.value : -100000 - score.value) : score.value;
}
