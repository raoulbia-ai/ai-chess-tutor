import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { analyse, scoreValue } from './lib/engine.mjs';
import { narrate } from './lib/tutor.mjs';

try { process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
const files = new Map([
  ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
  ['/', ['public/index.html', 'text/html']], ['/app.js', ['public/app.js', 'text/javascript']],
  ['/style.css', ['public/style.css', 'text/css']], ['/chess.js', ['node_modules/chess.js/dist/esm/chess.js', 'text/javascript']],
]);
const cache = new Map();
async function cachedAnalysis(fen, rootMove) {
  const key = rootMove ? `${fen}:${rootMove}` : fen;
  if (!cache.has(key)) {
    if (cache.size >= 80) cache.delete(cache.keys().next().value);
    cache.set(key, analyse(fen, { rootMove }).catch(error => { cache.delete(key); throw error; }));
  }
  return cache.get(key);
}
function gameFrom(moves) {
  if (!Array.isArray(moves) || moves.length > 500 || !moves.every(m => typeof m === 'string' && m.length <= 12)) throw new Error('Invalid game history.');
  const game = new Chess();
  for (const move of moves) game.move(move);
  return game;
}
let active = 0;
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/status') return json(200, { configured: Boolean(process.env.OPENAI_API_KEY_CHESS_TUTOR || process.env.OPENAI_API_KEY || process.env.LLM_PROVIDER === 'compatible'), model: process.env.LLM_MODEL || 'gpt-4.1-mini' });
    if (req.method === 'GET' && files.has(url.pathname)) {
      const [file, mime] = files.get(url.pathname), content = await readFile(new URL(file, import.meta.url));
      res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' }); return res.end(content);
    }
    if (req.method !== 'POST' || !['/api/play', '/api/tutor', '/api/history'].includes(url.pathname)) return json(404, { error: 'Not found.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` &&
        req.headers.origin !== process.env.CHESS_PUBLIC_ORIGIN) return json(403, { error: 'Origin rejected.' });
    if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON required.' });
    if (active >= 3 && url.pathname !== '/api/history') return json(429, { error: 'The tutor is busy. Please retry in a moment.' });
    let input = '';
    for await (const chunk of req) { input += chunk; if (input.length > 24000) return json(413, { error: 'Request too large.' }); }
    let data, game;
    try { data = JSON.parse(input); game = gameFrom(data.moves); } catch { return json(400, { error: 'Invalid game history.' }); }
    if (url.pathname === '/api/history') {
      if (typeof data.gameId !== 'string' || !/^[\da-f-]{36}$/i.test(data.gameId) ||
          !['start', 'move', 'undo', 'tutor', 'variation', 'question', 'answer'].includes(data.event) || !Number.isSafeInteger(data.sequence)) return json(400, { error: 'Invalid history event.' });
      const note = typeof data.note === 'string' ? data.note.slice(0, 10000) : '';
      const line = `[${new Date().toISOString()}] Game ${data.gameId} #${data.sequence} ${data.event} | ${game.history().join(' ') || '(starting position)'}${note ? ' | ' + JSON.stringify(note) : ''}\n`;
      const file = new URL('./game-history.txt', import.meta.url);
      try {
        if (data.retry === true) {
          const previous = readFileSync(file, { encoding: 'utf8', flag: 'a+' });
          const marker = ` Game ${data.gameId} #${data.sequence} `;
          if (previous.split('\n').some(entry => entry.slice(entry.indexOf(']') + 1).startsWith(marker))) {
            return json(200, { saved: true });
          }
        }
        appendFileSync(file, line, 'utf8');
      } catch (error) {
        return json(500, { error: `Could not write the local history file (${error.code || 'write error'}).` });
      }
      return json(200, { saved: true });
    }
    if (game.isGameOver()) return json(400, { error: 'This game has ended. Start a new game to continue learning.' });
    active++;
    try {
      if (url.pathname === '/api/play') {
        if (game.turn() !== 'b') return json(400, { error: 'It is your turn.' });
        const before = gameFrom(data.moves.slice(0, -1));
        const played = game.history({ verbose: true }).at(-1);
        const uci = played.from + played.to + (played.promotion || '');
        const best = await cachedAnalysis(before.fen());
        const chosen = best.variations.find(v => v.steps[0].uci === uci) || (await cachedAnalysis(before.fen(), uci)).variations[0];
        const loss = Math.max(0, scoreValue(best.variations[0].score) - scoreValue(chosen.score));
        const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
        let balance = 0;
        const line = chosen.steps.slice(1);
        for (const move of line) if (move.captured) balance += (move.color === 'w' ? 1 : -1) * values[move.captured];
        const recap = line.map(m => (m.color === 'b' ? 'Black ' : 'White ') + m.san).join(', ');
        let coaching = null;
        if (loss > 150 && chosen.score.type === 'mate' && chosen.score.value < 0 && recap) {
          coaching = { title: 'Black has a forced mate.', explanation: `Stockfish found a mating line starting with ${recap}. Try another move or watch the line.` };
        } else if (loss > 150 && balance <= -2 && !played.captured) {
          const capture = line.find(m => m.color === 'b' && m.captured && m.captured !== 'p');
          const pieces = { n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };
          if (capture) coaching = { title: 'This line loses material.', explanation: `In Stockfish’s line, Black can take your ${pieces[capture.captured]} on ${capture.to} (${capture.san}). White comes out behind in material.` };
        }
        const reply = await analyse(game.fen(), { strength: 0 });
        const responseMove = game.move({ from: reply.bestmove.slice(0, 2), to: reply.bestmove.slice(2, 4), promotion: reply.bestmove[4] });
        return json(200, { reply: responseMove.san, coaching, feedback: { loss, sound: loss <= 80, phase: data.moves.length <= 20 ? 'opening' : 'middlegame' } });
      }
      if (!['hint', 'explain', 'review', 'demonstrate', 'question', 'turn'].includes(data.mode)) return json(400, { error: 'Unknown tutoring mode.' });
      let turnEvidence;
      if (data.mode === 'turn') {
        if (game.turn() !== 'w' || data.moves.length < 2) return json(400, { error: 'Wait for Black’s reply first.' });
        const [white, black] = game.history({ verbose: true }).slice(-2);
        const uci = white.from + white.to + (white.promotion || '');
        const prior = await cachedAnalysis(white.before);
        const chosen = prior.variations.find(v => v.steps[0].uci === uci)
          || (await cachedAnalysis(white.before, uci)).variations[0];
        turnEvidence = { white, black, whiteContinuation: chosen, alternative: prior.variations[0] };
      }
      let root = game, played = null;
      if (data.mode === 'review') {
        const count = game.turn() === 'w' ? 2 : 1;
        if (data.moves.length < count) return json(400, { error: 'Make a move first.' });
        root = gameFrom(data.moves.slice(0, -count)); played = data.moves[data.moves.length - count];
      }
      const analysis = await cachedAnalysis(root.fen());
      let selected = analysis.variations[0];
      if (data.candidate) {
        const temp = new Chess(root.fen()); let move;
        try { move = temp.move(String(data.candidate)); } catch { return json(400, { error: 'That alternative is not legal here. Use notation such as Nf3 or e2e4.' }); }
        const uci = move.from + move.to + (move.promotion || '');
        selected = analysis.variations.find(v => v.steps[0].uci === uci) || (await analyse(root.fen(), { rootMove: uci })).variations[0];
      }
      let playedLine = null;
      if (played) {
        const temp = new Chess(root.fen()), move = temp.move(played), uci = move.from + move.to + (move.promotion || '');
        playedLine = analysis.variations.find(v => v.steps[0].uci === uci) || (await analyse(root.fen(), { rootMove: uci })).variations[0];
      }
      const segment = (line, label, limit = 4) => line.steps.slice(0, limit).map((step, i) => ({
        ...step, before: i ? line.steps[i - 1].fen : root.fen(), label,
      }));
      const sameMove = playedLine?.steps[0].uci === selected.steps[0].uci;
      const demonstration = data.mode === 'review'
        ? sameMove ? segment(playedLine, 'Your move matches the engine suggestion')
          : [...segment(playedLine, 'Your move and a possible reply', 3), ...segment(selected, 'Engine suggestion from the same position', 3)]
        : ['demonstrate', 'explain'].includes(data.mode) ? segment(selected, 'Possible continuation') : [];
      const actualGameHistory = game.history({ verbose: true }).map(({ color, san, from, to }) => ({ color, san, from, to }));
      const latestLearnerMove = actualGameHistory.findLast(move => move.color === 'w') || null;
      const lesson = await narrate({ mode: data.mode, turnEvidence, automatic: data.automatic === true, position: root.fen(), board: root.board().flat().filter(Boolean), history: root.history(), actualGameHistory, latestLearnerMove, played, playedLine,
        lines: analysis.variations, selected, demonstration, question: String(data.question || '').slice(0, 700), focus: String(data.focus || 'Notice threats and protect pieces').slice(0, 150) });
      if (demonstration.length) lesson.explanation = data.mode === 'review'
        ? `Back before your move.${sameMove ? ' It matches the engine’s suggestion. Watch a possible continuation.' : ' Compare your move with an alternative. These replies are hypothetical.'}`
        : 'Watch this short line, then try the idea yourself.';
      json(200, { lesson, root: root.fen(), demonstration });
    } finally { active--; }
  } catch (error) {
    json(502, { error: error.name === 'TimeoutError' ? 'The tutor took too long. Your game is saved; please retry.' : error.message === 'fetch failed' ? 'Cannot reach the model provider. Check the server connection.' : error.message });
  }
});
server.listen(port, host, () => console.log(`Chess tutor: http://${host}:${port}`));
