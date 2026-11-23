// Replays a game through the tutor: the turn comment and all three hint levels at each White move.
// Usage: node eval/replay-game.mjs "<moves in SAN>" [fromPly] [toPly]
import { lessonFor } from '../lib/lesson.mjs';
import { stopEngine } from '../lib/engine.mjs';
import { stopClassical } from '../lib/positional.mjs';
const moves = process.argv[2].split(' ');
const from = Number(process.argv[3] ?? 2), to = Number(process.argv[4] ?? moves.length);
for (let ply = from; ply <= to; ply += 2) {
  const prefix = moves.slice(0, ply);
  const number = ply / 2 + 1;
  const turn = await lessonFor({ mode: 'turn', moves: prefix });
  const hint = await lessonFor({ mode: 'hint', moves: prefix, level: 3 }, undefined, { allLevels: true });
  console.log(`\n${number}. (after ${prefix.at(-1)}) next: ${moves[ply] ?? '-'}`);
  console.log(`  TURN [${turn.lesson.title}] ${turn.lesson.explanation}`);
  console.log(`  HINT [${hint.lesson.title}] ${hint.levels.join(' | ')}`);
}
stopEngine(); stopClassical();
