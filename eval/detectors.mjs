// Measures the analysis layer against independent labels, with no model calls:
//   motifs found along each puzzle's solution against the Lichess themes, and
//   Black's threat found by lib/analysis.mjs against the suite's deeper engine label.
//
//   node eval/detectors.mjs [--threats]
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keyMotif, lineMotifs, threatsBy } from '../lib/analysis.mjs';
import { stopEngine } from '../lib/engine.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const suite = ['eval/suite.json', 'eval/suite.local.json'].filter(file => existsSync(root + file)).flatMap(file => JSON.parse(readFileSync(root + file, 'utf8')));
const puzzles = suite.filter(item => item.source === 'lichess');

// Lichess theme -> motif names lib/analysis.mjs reports.
const mapping = { fork: ['fork'], pin: ['pin'], skewer: ['skewer'], discoveredAttack: ['discovered attack', 'discovered check'],
  mate: ['checkmate', 'back-rank mate'], backRankMate: ['back-rank mate'], hangingPiece: ['hanging piece'], trappedPiece: ['trapped piece'],
  advancedPawn: ['promotion', 'advanced pawn'], capturingDefender: ['removes defender'] };
const counts = Object.fromEntries(Object.keys(mapping).map(theme => [theme, { tp: 0, fn: 0, fp: 0 }]));
let keyRight = 0, keyTotal = 0; const keyMisses = [];
for (const puzzle of puzzles) {
  const result = lineMotifs(puzzle.fen, puzzle.solution);
  const { plies, side } = result;
  // The single motif the tutor would teach, scored against the puzzle's themes it can name.
  const named = Object.keys(mapping).filter(theme => theme === 'mate' ? puzzle.themes.some(t => /^mateIn|Mate$/.test(t)) : puzzle.themes.includes(theme));
  if (named.length) {
    keyTotal++;
    const key = keyMotif(result);
    if (key && named.some(theme => mapping[theme].includes(key.motif))) keyRight++;
    else keyMisses.push(`${puzzle.id} themes ${named.join('/')} key ${key?.motif ?? 'none'} (${key?.san ?? ''})`);
  }
  const found = new Set(plies.filter(ply => ply.color === side).flatMap(ply => ply.motifs.map(motif => motif.motif)));
  for (const [theme, motifs] of Object.entries(mapping)) {
    const labelled = theme === 'mate' ? puzzle.themes.some(t => /^mateIn|Mate$/.test(t) || t === 'mate') : puzzle.themes.includes(theme);
    const detected = motifs.some(motif => found.has(motif));
    if (labelled && detected) counts[theme].tp++; else if (labelled) counts[theme].fn++; else if (detected) counts[theme].fp++;
  }
}
console.log('Motifs along puzzle solutions (Lichess themes as labels)\n');
console.log('| theme | recall | precision |\n|---|---|---|');
for (const [theme, { tp, fn, fp }] of Object.entries(counts)) {
  const recall = tp + fn ? `${Math.round(100 * tp / (tp + fn))}% (${tp}/${tp + fn})` : '–';
  const precision = tp + fp ? `${Math.round(100 * tp / (tp + fp))}% (${tp}/${tp + fp})` : '–';
  console.log(`| ${theme} | ${recall} | ${precision} |`);
}
console.log(`\nKey motif (one per puzzle) matches a theme: ${Math.round(100 * keyRight / keyTotal)}% (${keyRight}/${keyTotal})`);
if (process.argv.includes('--misses')) console.log(keyMisses.join('\n'));
if (process.argv.includes('--threats')) {
  let tp = 0, fn = 0, fp = 0, sameSquare = 0;
  for (const item of suite) {
    if (item.fen.split(' ')[1] !== 'w') continue;
    // The label is the same pass search two plies deeper, so this measures how stable the quick search is.
    const labelled = await threatsBy(item.fen, 'b', { depth: 16 });
    const found = await threatsBy(item.fen, 'b');
    if (labelled && found) { tp++; if (found.to === labelled.to) sameSquare++; } else if (labelled) fn++; else if (found) fp++;
  }
  console.log(`\nBlack's threat, depth 12 against depth 16: recall ${Math.round(100 * tp / (tp + fn))}% (${tp}/${tp + fn}), precision ${Math.round(100 * tp / (tp + fp))}% (${tp}/${tp + fp}), same target square ${sameSquare}/${tp}`);
}
stopEngine();
