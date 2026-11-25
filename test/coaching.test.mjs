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
  assert.match(levels[0], /\?/);
  assert.match(levels[1], /keep your bishop pair/);
  assert.doesNotMatch(levels.slice(0, 2).join(' '), /Be2/);
  assert.match(levels[2], /^• Be2 /);
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

// From the second game on 23 Nov.
const second = 'd4 e6 Nc3 d6 e4 Be7 Bd3 Nf6 e5 dxe5 dxe5 Nd5 Qg4 g6 Bd2 O-O Rd1 f5 Qh3 f4 Nf3 Nc6 a4 Ncb4 Be4 Nxc2+ Bxc2 Nb4 Be4 Nd3+ Bxd3 Qxd3 Ne2 Kf7 Qxh7+ Ke8 Bxf4 Qf5 O-O Bd7 b3 Qf7 Qh3 g5 Nxg5 Bxg5 Bxg5 Rg8 Bf6 c6 Rd6 c5 Nf4 Rc8 Rfd1 Rc6 R6d3 c4 Rxd7 Qxd7 Qh5+ Qf7 Rd8#'.split(' ');

test('a combination is described by what it finally wins, not by the move just played', async () => {
  const { lesson } = await lessonFor({ mode: 'turn', moves: second.slice(0, 36) });
  assert.match(lesson.explanation, /combination: it starts by giving up material, then .*wins Black’s queen on d3/);
  assert.doesNotMatch(lesson.explanation, /skewers/);
});

test('a mate that starts with a capture is not called quiet', async () => {
  const { lesson } = await lessonFor({ mode: 'turn', moves: second.slice(0, 58) });
  assert.match(lesson.explanation, /starting with a capture/);
});

test('an uncovered attack on a defended piece is not announced', async () => {
  const { lesson } = await lessonFor({ mode: 'turn', moves: [...second.slice(0, 14), 'Nf3', 'Nxc3'] });
  assert.doesNotMatch(lesson.explanation, /uncovers/);
  assert.match(lesson.explanation, /an even trade/);
});

test('a queen that can simply be taken is not described as taken for a pawn', async () => {
  const { lesson } = await lessonFor({ mode: 'turn', moves: second.slice(0, 42) });
  assert.match(lesson.explanation, /taking your queen on h7/);
  assert.doesNotMatch(lesson.explanation, /for a pawn/);
});

test('a quiet move that attacks a loose pawn is explained as a threat', async () => {
  const { levels } = await lessonFor({ mode: 'hint', moves: second.slice(0, 12), level: 3 }, undefined, { allLevels: true });
  assert.match(levels[2], /^• Qg4 attacks Black’s pawn on g7/);
  assert.doesNotMatch(levels[2], /available moves/);
});

test('a quiet position gets a board scan with named candidates, not a general reminder', async () => {
  const { lesson } = await lessonFor({ mode: 'turn', moves: 'd4 d5 Nc3 Nf6 Nf3 Bf5 Be3 e6'.split(' ') });
  const lines = lesson.explanation.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /none of your pieces can be won/);
  assert.match(lines[1], /(Candidates worth comparing|Start with): your /);
  assert.match(lines[2], /what does it attack or defend/);
});

test('a threat on a pinned piece names the pin and the count, not a fork', async () => {
  const moves = 'd4 d5 Nc3 Nf6 e3 Bf5 Nf3 e6 Bd3 Bxd3 cxd3 Bb4 a3 Bd6 b4 O-O e4 dxe4 dxe4 Nfd7 e5 Be7 b5 c5 d5 exd5 Nxd5 Nxe5 Nxe5 Bf6 Bb2 Re8'.split(' ');
  const { lesson } = await lessonFor({ mode: 'turn', moves });
  assert.match(lesson.explanation, /Black threatens Bxe5, taking your knight on e5: it is pinned to your king by Black’s rook on e8, and it is attacked twice and defended once\./);
  assert.match(lesson.explanation, /ends the attack on your pinned knight on e5/);
  const { levels } = await lessonFor({ mode: 'hint', moves, level: 3 }, undefined, { allLevels: true });
  assert.match(levels[0], /cannot move away/);
  assert.doesNotMatch(levels[0], /move the piece/);
});
