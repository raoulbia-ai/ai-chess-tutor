// Prints the positional point the tutor would name for the engine's best move in each given position.
// Usage: node eval/positional-probe.mjs "<moves>" ["<moves>" ...]
import { Chess } from 'chess.js';
import { analyse, stopEngine } from '../lib/engine.mjs';
import { positionalPoint, termChanges, stopClassical } from '../lib/positional.mjs';
for (const moves of process.argv.slice(2)) {
  const game = new Chess(); for (const san of moves.split(' ')) game.move(san);
  const fen = game.fen();
  const { variations } = await analyse(fen, { depth: 16, multipv: 1, plies: 6 });
  const sans = variations[0].steps.map(s => s.san);
  const move = new Chess(fen).move(sans[0]);
  const point = await positionalPoint(fen, move, sans);
  const g2 = new Chess(fen); g2.move(sans[0]); g2.move(sans[1]);
  const changes = (await termChanges(fen, g2.fen()))?.slice(0, 3).map(c => `${c.term} ${c.delta}`).join(', ');
  console.log(`${Math.ceil(game.history().length / 2) + 1}. best ${sans.slice(0, 4).join(' ')} | ${point ? `${point.kind} (${point.term} ${point.delta?.toFixed(2)}): ${point.idea} / ${point.reason}` : 'none'} | top terms: ${changes}`);
}
stopEngine(); stopClassical();
