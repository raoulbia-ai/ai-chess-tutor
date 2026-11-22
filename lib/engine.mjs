import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Chess } from 'chess.js';

const directory = fileURLToPath(new URL('../node_modules/stockfish/bin/', import.meta.url));
let queue = Promise.resolve();
let worker = null;

// Searches run one at a time on a single Stockfish process that stays running between searches.
// Defaults match the tutor's original settings: depth 16, three lines, six plies per line.
export function analyse(fen, { rootMove, strength, depth, multipv, plies } = {}) {
  const run = queue.then(() => search(fen, { rootMove, strength, depth, multipv, plies }));
  queue = run.catch(() => {});
  return run;
}

function startWorker() {
  const file = readdirSync(directory).find(name => /lite-single.*\.js$/.test(name));
  if (!file) throw new Error('Stockfish lite engine is missing. Run npm install.');
  const child = spawn(process.execPath, [join(directory, file)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, buffer: '', ready: null, job: null, alive: true };
  state.ready = new Promise((resolve, reject) => { state.onUciOk = resolve; state.onStartError = reject; });
  const fail = message => {
    if (!state.alive) return;
    state.alive = false;
    if (worker === state) worker = null;
    state.onStartError(new Error(message));
    state.job?.finish(new Error(message));
  };
  child.on('error', () => fail('Could not start Stockfish.'));
  child.on('exit', () => fail('Stockfish stopped unexpectedly.'));
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {});
  child.stdout.on('data', data => {
    state.buffer += data.toString();
    let end;
    while ((end = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, end).trim(); state.buffer = state.buffer.slice(end + 1);
      if (line === 'uciok') state.onUciOk();
      else state.job?.onLine(line);
    }
  });
  state.send = command => { if (state.alive && child.stdin.writable) child.stdin.write(command + '\n'); };
  state.send('uci');
  return state;
}

async function search(fen, { rootMove, strength, depth, multipv, plies }) {
  if (!worker) {
    worker = startWorker();
    await worker.ready;
    worker.send('setoption name Threads value 1'); worker.send('setoption name Hash value 16');
  }
  const engine = worker;
  const lineCount = multipv ?? (rootMove || strength !== undefined ? 1 : 3);
  const searchDepth = depth ?? (strength !== undefined ? 7 : 16);
  const pvLength = plies ?? 6;
  return new Promise((resolve, reject) => {
    const lines = new Map();
    let done = false;
    const timer = setTimeout(() => {
      // A stuck search leaves the process in an unknown state, so replace it.
      engine.alive = false; if (worker === engine) worker = null; engine.child.kill();
      job.finish(new Error('Engine analysis timed out. Please retry.'));
    }, 20000);
    const job = {
      finish(error, result) {
        if (done) return;
        done = true; clearTimeout(timer); engine.job = null;
        error ? reject(error) : resolve(result);
      },
      onLine(line) {
        if (line === 'readyok') {
          engine.send(`position fen ${fen}`);
          engine.send(`go depth ${searchDepth}${rootMove ? ' searchmoves ' + rootMove : ''}`);
        } else if (line.startsWith('info ') && line.includes(' pv ') && !/bound/.test(line)) {
          const score = line.match(/score (cp|mate) (-?\d+)/), pv = line.split(' pv ')[1]?.split(' ');
          if (score && pv) lines.set(Number(line.match(/multipv (\d+)/)?.[1] || 1), { score: { type: score[1], value: Number(score[2]) }, moves: pv.slice(0, pvLength) });
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
          job.finish(null, { bestmove: line.split(' ')[1], variations });
        }
      },
    };
    engine.job = job;
    // A fresh game clears the hash, so each search gives the same result as a newly started engine.
    engine.send('ucinewgame');
    engine.send(`setoption name MultiPV value ${lineCount}`);
    engine.send(`setoption name Skill Level value ${strength ?? 20}`);
    engine.send('isready');
  });
}

export function scoreValue(score) {
  return score.type === 'mate' ? (score.value > 0 ? 100000 - score.value : -100000 - score.value) : score.value;
}

// Lets scripts such as the evaluation suite exit without waiting for the engine process.
export function stopEngine() {
  if (worker) { worker.alive = false; worker.child.kill(); worker = null; }
}
