// A human-like opponent: Maia-3 (University of Toronto) predicts the move a player of a given rating would make,
// and samples from those predictions, so Black makes the kind of mistakes real players at that level make.
// It runs as a separate UCI process from the virtual environment that scripts/install-maia.sh creates in
// .engines/. Without it the app keeps the reduced-strength Stockfish opponent.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { onStopEngine } from './engine.mjs';

const root = fileURLToPath(new URL('../.engines/', import.meta.url));
const command = process.env.MAIA_ENGINE || `${root}maia-venv/bin/maia3-uci`;
export const maiaRatings = [1100, 1300, 1500, 1700, 1900];
let engine = null, queue = Promise.resolve();

export const maiaAvailable = () => existsSync(command) && existsSync(`${root}maia-cache`);

function start() {
  const child = spawn(command, ['--model', 'maia3-5m', '--cache-dir', `${root}maia-cache`, '--device', 'cpu', '--use-uci-history', '--local-files-only'], {
    stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, HF_HOME: `${root}hf-cache`, HF_HUB_OFFLINE: '1' },
  });
  const state = { child, buffer: '', waiters: [], alive: true };
  const fail = () => { state.alive = false; if (engine === state) engine = null; for (const w of state.waiters.splice(0)) w.reject(new Error('Maia stopped.')); };
  child.on('error', fail); child.on('exit', fail); child.stdin.on('error', () => {});
  child.stdout.on('data', data => {
    state.buffer += data.toString();
    let end;
    while ((end = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, end).trim(); state.buffer = state.buffer.slice(end + 1);
      const waiter = state.waiters.find(w => line.startsWith(w.prefix));
      if (waiter) { state.waiters.splice(state.waiters.indexOf(waiter), 1); waiter.resolve(line); }
    }
  });
  state.until = (prefix, ms) => new Promise((resolve, reject) => {
    const waiter = { prefix, resolve, reject };
    state.waiters.push(waiter);
    setTimeout(() => { const i = state.waiters.indexOf(waiter); if (i >= 0) { state.waiters.splice(i, 1); reject(new Error('Maia took too long.')); } }, ms);
  });
  state.send = text => child.stdin.write(`${text}\n`);
  // Loading the model takes a few seconds the first time.
  state.ready = (async () => { state.send('uci'); await state.until('uciok', 30000); state.send('isready'); await state.until('readyok', 60000); })();
  state.ready.catch(() => {});
  return state;
}

// Black's move at `rating` (Elo) after the White moves and Black moves in `uciMoves` from the start position.
// `learnerRating` tells Maia who it is playing against. Returns a UCI move such as "e7e5".
export function maiaMove(uciMoves, { rating = 1500, learnerRating = rating, startFen } = {}) {
  const run = queue.then(async () => {
    if (!engine?.alive) engine = start();
    const state = engine;
    await state.ready;
    state.send(`setoption name SelfElo value ${rating}`);
    state.send(`setoption name OppoElo value ${learnerRating}`);
    state.send(`position ${startFen ? `fen ${startFen}` : 'startpos'}${uciMoves.length ? ` moves ${uciMoves.join(' ')}` : ''}`);
    state.send('go nodes 1');
    const line = await state.until('bestmove', 15000);
    return line.split(/\s+/)[1];
  });
  queue = run.catch(() => {});
  return run;
}

export function stopMaia() { if (engine) { engine.alive = false; engine.child.kill(); engine = null; } }
onStopEngine(stopMaia);
