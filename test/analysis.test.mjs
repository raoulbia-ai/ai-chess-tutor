import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { captureGain, piecesEnPrise, moveMotifs, mateThreat, lineMotifs, keyMotif, threatsBy, moveVerdict, planFeatures } from '../lib/analysis.mjs';
import { stopEngine } from '../lib/engine.mjs';

after(stopEngine);
const fenAfter = moves => { const game = new Chess(); for (const move of moves.split(' ')) game.move(move); return game.fen(); };
const motifsOf = (fen, san) => { const board = new Chess(fen); const move = board.move(san); board.undo(); return moveMotifs(board, move).map(m => m.motif); };

test('an undefended attacked queen is en prise for its full value', () => {
  const fen = fenAfter('e4 e5 Nf3 Qg5');
  assert.deepEqual(piecesEnPrise(fen, 'b').map(p => [p.square, p.gain]), [['g5', 9]]);
});

test('a pawn defended by a pawn is not en prise to a knight', () => {
  const fen = fenAfter('e4 Nf6 d3');
  assert.equal(captureGain(fen, 'e4', 'b'), 0);
});

test('a pinned knight does not count as a defender', () => {
  // The knight on c3 is pinned to the king by the bishop on b4, so Nxe4 wins the pawn.
  const fen = fenAfter('e4 Nf6 d4 e6 Nc3 Bb4 a3');
  const board = new Chess(fen);
  assert.equal(board.turn(), 'b');
  assert.equal(captureGain(fen, 'e4', 'b'), 1);
});

test('a knight check that also attacks a rook is a fork', () => {
  assert.ok(motifsOf('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'Nc7+').includes('fork'));
});

test('a bishop in front of the king pins the knight', () => {
  assert.ok(motifsOf('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1', 'Bb5').includes('pin'));
});

test('a rook check with the queen behind the king is a skewer', () => {
  assert.ok(motifsOf('q3k3/8/8/8/8/8/8/4K2R w - - 0 1', 'Rh8+').includes('skewer'));
});

test('moving a knight off the rook’s file uncovers an attack on the queen', () => {
  assert.ok(motifsOf('4k3/8/8/8/4q3/8/4N3/4R1K1 w - - 0 1', 'Ng3').includes('discovered attack'));
});

test('a back-rank mate threat and its delivery are recognised', () => {
  assert.equal(mateThreat('6k1/5ppp/8/8/8/8/8/R5K1 b - - 0 1', 'w'), 'Ra8#');
  assert.ok(motifsOf('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'Ra8#').includes('back-rank mate'));
});

test('a line that wins the queen settles at a gain, and its key motif is the capture', () => {
  const fen = fenAfter('e4 e5 Nf3 Qg5');
  const line = lineMotifs(fen, ['Nxg5', 'Nf6', 'Nc3']);
  assert.ok(line.settledGain >= 8);
  assert.equal(keyMotif(line).motif, 'hanging piece');
});

test('a recaptured capture does not count as a material win', () => {
  // Nxe5 Nxe5 gives a knight for a pawn; Nxc6 bxc6 is an even trade.
  assert.equal(lineMotifs(fenAfter('e4 e5 Nf3 Nc6 Bc4 Nf6'), ['Nxe5', 'Nxe5']).settledGain, -2);
  assert.equal(lineMotifs(fenAfter('e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nc3 Bb4'), ['Nxc6', 'bxc6']).settledGain, 0);
  // Capturing a pawn the opponent can take back still counts the recapture when the window ends on the capture.
  assert.equal(lineMotifs(fenAfter('e4 d5'), ['exd5']).settledGain, 0);
});

test('a pass search finds Black’s threat against the knight or g2', async () => {
  const threat = await threatsBy(fenAfter('e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5'), 'b');
  assert.ok(threat);
  assert.ok(['e5', 'g2'].includes(threat.to));
  assert.ok(threat.materialGain >= 1 || threat.mate);
});

test('a quiet opening position has no threat', async () => {
  assert.equal(await threatsBy(fenAfter('e4 e5 Nf3 Nc6 Bc4 Bc5'), 'b'), null);
});

test('2…Qg5 is a blunder refuted by Nxg5', async () => {
  const verdict = await moveVerdict(fenAfter('e4 e5 Nf3'), 'Qg5');
  assert.equal(verdict.verdict, 'blunder');
  assert.equal(verdict.refutation.line[0], 'Nxg5');
  assert.ok(verdict.refutation.settledGain >= 8);
});

test('plan features of the starting position', () => {
  const features = planFeatures(new Chess().fen(), 'w');
  assert.deepEqual(features.undeveloped.sort(), ['b1', 'c1', 'f1', 'g1']);
  assert.equal(features.castled, false);
  assert.deepEqual(features.openFiles, []);
});
