// Regressions from a real game (23 Nov): advice that hid a winning capture, generic quiet hints, filler summary.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { lessonFor } from '../lib/lesson.mjs';
import { stopEngine } from '../lib/engine.mjs';

after(stopEngine);
const game = 'd4 Nc6 Nf3 e6 Nc3 b6 e4 Nf6 Bd3 Nb4 O-O Be7 e5 Nfd5 Bd2 Nxd3 cxd3 O-O Rc1 d6 Re1 Nb4 Qe2 a5 a4 Ba6 Nb5 Qd7 Rxc7 Qe8 Bxb4 Bxb5 b3 Bxa4 Bxd6 Bd7 Rec1 Qd8 Qc2 Bxd6 exd6 Bb5 Ra1 Rc8 Ne5 h6 d5 f6 Ng6 Rxc7 dxc7 Qd6'.split(' ');
const upTo = plies => game.slice(0, plies);

test('a winning capture is named even when Black’s last move was not the mistake', async () => {
  const { lesson } = await lessonFor({ mode: 'turn', moves: upTo(52) });
  assert.equal(lesson.title, 'Material to win');
  assert.match(lesson.explanation, /rook on f8/);
  assert.doesNotMatch(lesson.explanation, /file is/);
});

test('after Black takes, a stronger move than the recapture is pointed out', async () => {
  const { lesson } = await lessonFor({ mode: 'turn', moves: upTo(32) });
  assert.match(lesson.explanation, /You can take back, but look for something stronger first/);
});

test('plan advice no longer counts a piece’s moves', async () => {
  for (const plies of [14, 24, 26]) {
    const { lesson } = await lessonFor({ mode: 'turn', moves: upTo(plies) });
    assert.doesNotMatch(lesson.explanation, /fewest moves/);
  }
});

test('a quiet hint names the positional idea behind the engine’s move', async () => {
  const { levels } = await lessonFor({ mode: 'hint', moves: upTo(10), level: 3 }, undefined, { allLevels: true });
  assert.match(levels[0], /keep your bishop pair/);
  assert.doesNotMatch(levels.slice(0, 2).join(' '), /Be2/);
  assert.match(levels[2], /^Be2 /);
});

test('a threat hint names the right defender', async () => {
  const { levels } = await lessonFor({ mode: 'hint', moves: upTo(22), level: 3 }, undefined, { allLevels: true });
  assert.match(levels[1], /the best one is your rook on e1/);
});

test('the game review lists real mistakes', async () => {
  const { lesson } = await lessonFor({ mode: 'summary', moves: 'e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#'.split(' ') });
  assert.equal(lesson.title, 'Game review');
  assert.match(lesson.explanation, /moves at or near the engine’s level/);
  await assert.rejects(lessonFor({ mode: 'summary', moves: ['e4', 'e5'] }), /ready when the game is over/);
});
