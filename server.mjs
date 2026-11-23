import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { analyse, scoreValue } from './lib/engine.mjs';
import { gameFrom, lessonFor, LessonRequestError } from './lib/lesson.mjs';
import { maiaAvailable, maiaMove, maiaRatings } from './lib/maia.mjs';

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
let active = 0;
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/status') return json(200, { configured: Boolean(process.env.OPENAI_API_KEY_CHESS_TUTOR || process.env.OPENAI_API_KEY || process.env.LLM_PROVIDER === 'compatible'), maia: maiaAvailable() ? maiaRatings : [], model: process.env.LLM_MODEL || 'gpt-4.1-mini', auditModel: process.env.LLM_AUDIT_MODEL || process.env.LLM_MODEL || 'gpt-4.1-mini' });
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
          !['start', 'move', 'undo', 'tutor', 'variation', 'question', 'answer', 'result', 'tutor-request', 'tutor-skip', 'tutor-error'].includes(data.event) || !Number.isSafeInteger(data.sequence)) return json(400, { error: 'Invalid history event.' });
      const occurredAt = typeof data.occurredAt === 'string' && Number.isFinite(Date.parse(data.occurredAt))
        ? new Date(data.occurredAt).toISOString() : undefined;
      const note = data.note && typeof data.note === 'object' && !Array.isArray(data.note)
        ? { ...data.note, occurredAt }
        : typeof data.note === 'string' ? data.note.slice(0, 10000) : '';
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
    // The game review is the one request that needs a finished game.
    if (game.isGameOver() && !(url.pathname === '/api/tutor' && data.mode === 'summary')) return json(400, { error: 'This game has ended. Start a new game to continue learning.' });
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
        const line = chosen.steps.slice(1);
        const recap = line.map(m => (m.color === 'b' ? 'Black ' : 'White ') + m.san).join(', ');
        let coaching = null;
        if (loss > 150 && chosen.score.type === 'mate' && chosen.score.value < 0 && recap) {
          coaching = { title: 'Black has a forced mate.', explanation: `Stockfish found a mating line starting with ${recap}. Try another move or watch the line.` };
        } else if (loss > 150 && !played.captured) {
          // End on White’s reply so a last-ply Black capture cannot inflate the loss.
          const settled = line.at(-1)?.color === 'b' ? line.slice(0, -1) : line;
          if (settled.length) {
            const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
            const material = fen => new Chess(fen).board().flat().reduce((balance, piece) =>
              balance + (piece ? values[piece.type] * (piece.color === 'w' ? 1 : -1) : 0), 0);
            const deficit = material(played.after) - material(settled.at(-1).fen);
            if (deficit >= 1) {
              const first = settled[0], recapture = settled[1], followUp = settled[2];
              const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };
              const evenExchange = first?.captured && recapture?.captured && recapture.to === first.to
                && material(recapture.fen) === material(played.after);
              const singleLoss = evenExchange && followUp?.captured && !settled.slice(3).some(move => move.captured)
                && deficit === values[followUp.captured];
              coaching = { title: 'This line loses material.', explanation: singleLoss
                ? `After Black’s ${first.san} and your ${recapture.san}, the exchange is even. Black then plays ${followUp.san}, winning your ${names[followUp.captured]} on ${followUp.to} in this line.`
                : `In Stockfish’s line, ${settled.map(move => (move.color === 'b' ? 'Black ' : 'White ') + move.san).join(', ')}. White comes out ${deficit} material ${deficit === 1 ? 'point' : 'points'} worse than before the line.` };
            }
          }
        }
        // A human-like opponent at the chosen rating when Maia is installed; otherwise, or if it fails,
        // reduced-strength Stockfish.
        const rating = Number(String(data.opponent || '').match(/^maia-(\d{4})$/)?.[1]);
        let uciMove = null, opponent = 'stockfish';
        if (maiaRatings.includes(rating) && maiaAvailable()) {
          try {
            const history = game.history({ verbose: true }).map(move => move.from + move.to + (move.promotion || ''));
            uciMove = await maiaMove(history, { rating });
            if (!game.moves({ verbose: true }).some(move => move.from + move.to + (move.promotion || '') === uciMove)) uciMove = null;
            else opponent = `maia-${rating}`;
          } catch { uciMove = null; }
        }
        if (!uciMove) uciMove = (await analyse(game.fen(), { strength: 0 })).bestmove;
        const responseMove = game.move({ from: uciMove.slice(0, 2), to: uciMove.slice(2, 4), promotion: uciMove[4] });
        return json(200, { reply: responseMove.san, opponent, coaching, feedback: { loss, sound: loss <= 80, phase: data.moves.length <= 20 ? 'opening' : 'middlegame' } });
      }
      try {
        return json(200, await lessonFor(data, cachedAnalysis));
      } catch (error) {
        if (error instanceof LessonRequestError) return json(400, { error: error.message });
        throw error;
      }
    } finally { active--; }
  } catch (error) {
    json(502, { error: error.name === 'TimeoutError' ? 'The tutor took too long. Your game is saved; please retry.' : error.message === 'fetch failed' ? 'Cannot reach the model provider. Check the server connection.' : error.message });
  }
});
server.listen(port, host, () => console.log(`Chess tutor: http://${host}:${port}`));
