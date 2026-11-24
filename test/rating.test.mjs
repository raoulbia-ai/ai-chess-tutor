import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHESS_RATINGS_FILE = join(mkdtempSync(join(tmpdir(), 'rating-')), 'ratings.json');
const { recordGame, ratingSummary } = await import('../lib/rating.mjs');
const win = 'e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#'.split(' ');
const id = n => `00000000-0000-0000-0000-00000000000${n}`;

test('a finished game without takebacks is rated once; practice games are not', () => {
  const first = recordGame({ gameId: id(1), moves: win, opponents: ['maia-1500'], takebacks: 0 }, [1500]);
  assert.equal(first.rated, true);
  assert.equal(first.after, 1520);
  assert.equal(recordGame({ gameId: id(1), moves: win, opponents: ['maia-1500'], takebacks: 0 }, [1500]).duplicate, true);
  assert.match(recordGame({ gameId: id(2), moves: win, opponents: ['maia-1500'], takebacks: 1 }, [1500]).reason, /took back/);
  assert.match(recordGame({ gameId: id(3), moves: win, opponents: ['maia-1500', 'stockfish'], takebacks: 0 }, [1500]).reason, /opponent changed/);
  assert.equal(ratingSummary().games, 1);
});
