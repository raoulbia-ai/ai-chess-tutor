import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { turnComment } from '../lib/coach.mjs';
import { analyse, stopEngine } from '../lib/engine.mjs';

after(stopEngine);
const comment = moves => {
  const game = new Chess();
  for (const move of moves.split(' ')) game.move(move);
  const [white, black] = game.history({ verbose: true }).slice(-2);
  return turnComment({ white, black }, fen => analyse(fen));
};

test('Black hanging the queen is pointed out without naming the move', async () => {
  const { title, explanation } = await comment('e4 e5 Nf3 Qg5');
  assert.equal(title, 'Black slipped');
  assert.match(explanation, /Black’s Qg5 was a mistake\. Black’s queen on g5 is undefended\./);
  assert.doesNotMatch(explanation, /Nxg5/);
});

test('a threat against your pieces is named with what it wins', async () => {
  const { explanation } = await comment('e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5');
  assert.match(explanation, /Black threatens Q(?:xe5|xg2)/);
  assert.match(explanation, /Your Nxe5 was a (?:mistake|blunder)/);
});

test('a mate in one outweighs everything else', async () => {
  const { explanation } = await comment('e4 e5 Qh5 Nc6 Bc4 Nf6');
  assert.equal(explanation, 'Black’s Nf6 was a mistake. There is a mate in one.');
});

test('a quiet opening gets a plan, not an invented threat', async () => {
  const { title, explanation } = await comment('e4 e5 Nf3 Nc6');
  assert.equal(title, 'Your next step');
  assert.doesNotMatch(explanation, /threat/i);
});
