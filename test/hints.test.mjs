import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { lessonFor } from '../lib/lesson.mjs';
import { stopEngine } from '../lib/engine.mjs';

after(stopEngine);
const hint = async (moves, level = 3) => {
  const { lesson, levels, hint: info } = await lessonFor({ mode: 'hint', moves: moves.split(' '), level }, undefined, { allLevels: true });
  return { lesson, levels, info };
};

test('a hanging queen: the idea first, the move only at level 3', async () => {
  const { levels, lesson } = await hint('e4 e5 Nf3 Qg5');
  assert.equal(lesson.title, 'Material to win');
  assert.match(levels[0], /more attackers than defenders\?/);
  assert.match(levels[1], /Black’s queen on g5 is undefended/);
  assert.match(levels[1], /Rule: /);
  assert.doesNotMatch(levels.slice(0, 2).join(' '), /Nxg5/);
  assert.match(levels[2], /^• Nxg5 /);
});

test('the requested level decides how much is shown', async () => {
  const { lesson, info } = await hint('e4 e5 Nf3 Qg5', 1);
  assert.deepEqual(info, { level: 1, levels: 3 });
  assert.equal(lesson.explanation.split('\n').length, 1);
});

test('a mate in one is announced, then the piece, then the move', async () => {
  const { levels } = await hint('e4 e5 Qh5 Nc6 Bc4 Nf6');
  assert.match(levels[0], /^• There is a checkmate in one move\. Which of your checks/);
  assert.match(levels[1], /Start with your queen on h5\./);
  assert.equal(levels[2], '• Qxf7# is checkmate.');
});

test('Black’s threat is named before any move of yours', async () => {
  const { levels, lesson } = await hint('e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5');
  assert.equal(lesson.title, 'Watch Black’s threat');
  assert.match(levels[0], /^• Black threatens Q(?:xg2|xe5).*\?$/);
});

test('a quiet opening gets a plan or an idea, not an invented threat by Black', async () => {
  const { levels } = await hint('e4 e5 Nf3 Nc6');
  assert.doesNotMatch(levels[0], /Black threatens/);
});

test('each level is at most three bullets, level 1 asks questions, and a tempting move is refuted', async () => {
  // From a real endgame: the rook on c5 blocks the bishop on a7 from Black's king on d4 (a discovered check).
  const { levels } = await hint('d4 d5 e4 dxe4 Nc3 Bf5 Qe2 c5 Qb5+ Nc6 Qxc5 e6 Qc4 Qxd4 Be3 Qxc4 Bxc4 Bb4 a3 Bxc3+ bxc3 Nge7 Ne2 Nd5 Bxd5 exd5 O-O h5 Nd4 Be6 Nb5 Kd7 c4 a6 Nd4 Nxd4 Bxd4 f6 Rfb1 Rab8 Ba7 Rbc8 Rxb7+ Kc6 Rab1 dxc4 R1b6+ Kd5 Rxa6 Bg4 Rb5+ Rc5 Rxc5+ Kd4');
  for (const level of levels) assert.ok(level.split('\n').every(line => line.startsWith('• ')) && level.split('\n').length <= 3, level);
  assert.match(levels[0], /long-range pieces and Black’s king\?/);
  assert.match(levels[1], /discovered check/);
  assert.match(levels[2], /Not [A-Z]?[a-h]?x?[a-h][1-8]\+?: /);
});

test('prevention names the Black piece, the square it wants and what it would do there', async () => {
  const { levels } = await hint('e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O');
  assert.match(levels[0], /Black’s bishop on c8 would like to come to g4, where it would pin your knight on f3 to your queen on d1/);
  assert.doesNotMatch(levels[0], /What does Black want to do next/);
  assert.doesNotMatch(levels.slice(0, 2).join(' '), /\bh3\b/);
  assert.match(levels[1], /your h-pawn could cover g4/);
  assert.match(levels[2], /^• h3 stops Black’s bishop on c8 from coming to g4, where it would pin/);
});

test('prevention also covers a Black pawn advance that would hit a piece', async () => {
  const { levels } = await hint('e4 e5 Nf3 d6 d4 Nd7 Bc4 c6 O-O Be7 Nc3 Ngf6');
  assert.match(levels[0], /Black’s pawn on b7 would like to come to b5, where it would attack your bishop on c4/);
  assert.match(levels[2], /^• a4 stops Black’s pawn on b7 from coming to b5/);
});

test('a quiet rook move names the least active pieces and the file that may open', async () => {
  const { levels } = await hint('d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6');
  assert.match(levels[0], /least active pieces are .*rook on a1/);
  assert.match(levels[1], /if they trade, the c-file opens/);
  assert.match(levels[2], /^• Rc1 puts your rook on the c-file behind your pawn on c4/);
});
