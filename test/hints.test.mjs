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
  assert.match(levels[0], /Black’s queen on g5 is undefended/);
  assert.doesNotMatch(levels.slice(0, 2).join(' '), /Nxg5/);
  assert.match(levels[2], /^Nxg5 /);
});

test('the requested level decides how much is shown', async () => {
  const { lesson, info } = await hint('e4 e5 Nf3 Qg5', 1);
  assert.deepEqual(info, { level: 1, levels: 3 });
  assert.equal(lesson.explanation.split('\n').length, 1);
});

test('a mate in one is announced, then the piece, then the move', async () => {
  const { levels } = await hint('e4 e5 Qh5 Nc6 Bc4 Nf6');
  assert.equal(levels[0], 'You have a checkmate in one move. Look at every check.');
  assert.equal(levels[1], 'Start with your queen on h5.');
  assert.equal(levels[2], 'Qxf7# is checkmate.');
});

test('Black’s threat is named before any move of yours', async () => {
  const { levels, lesson } = await hint('e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5');
  assert.equal(lesson.title, 'Watch Black’s threat');
  assert.match(levels[0], /^Black threatens Q(?:xg2|xe5)/);
});

test('a quiet opening gets a plan or an idea, not an invented threat by Black', async () => {
  const { levels } = await hint('e4 e5 Nf3 Nc6');
  assert.doesNotMatch(levels[0], /Black threatens/);
});
