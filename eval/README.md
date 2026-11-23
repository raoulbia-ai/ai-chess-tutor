# Evaluation

Measures the tutor's lessons on a fixed set of positions, so a change is judged by numbers rather than by a few examples.

## Files

| File | What it is |
|---|---|
| `suite.json` | Positions with White to move: 150 Lichess puzzles (CC0), 10 per theme, rated 700–1700, plus 10 hand-picked positions. Committed. |
| `suite.local.json` | Positions from your own games, from `game-history.txt`. Not committed. |
| `build-suite.mjs` | Builds both files and labels each position from deep Stockfish analysis. |
| `run.mjs` | Runs the tutor over the suite, offline or with the real model, and writes `runs/<name>.jsonl`. |
| `score.mjs` | Scores one or more runs, side by side. |
| `detectors.mjs` | Measures `lib/analysis.mjs` against independent labels, with no model calls. |
| `verify-turn.mjs`, `verify-hint.mjs` | Re-check every claim in a run's turn comments or hints with a depth-18 search. |

Labels on each position:

- **Best lines:** depth 18, three lines of 10 plies.
- **Black's threat:** what Black wins if White could pass. This uses the same pass search as the tutor, two plies deeper.
- **How much each of the last two moves lost.**
- **For puzzles:** the solution and the Lichess themes.

## Commands

```bash
npm run eval:suite -- --puzzles ~/data/lichess/lichess_db_puzzle.csv.zst   # about 7 minutes
npm run eval:run -- --name my-change --modes hint,turn                    # offline: model stubbed, free, about 2 minutes
npm run eval:run -- --name my-change-live --modes hint,turn --live        # real model calls, about $3 for the whole suite
npm run eval:score -- baseline my-change                                  # compare runs; add --show to list failures
npm run eval:detectors -- --threats                                       # analysis layer only
node eval/verify-hint.mjs my-change                                       # deep check of hint claims, about 15 minutes
node eval/verify-turn.mjs my-change                                       # deep check of turn comment claims
npm test                                                                  # unit tests for the analysis layer, turn comments and hints
```

The puzzle file is the Lichess puzzle database, `https://database.lichess.org/lichess_db_puzzle.csv.zst` (about 310 MB).

## What the scores mean

**Key points: does the lesson say what a coach would say first?**

Hints:

| Score | The lesson… |
|---|---|
| `solution`, `goodMove`, `punish` | names the puzzle solution, a move within 0.5 pawns of the best, or the move that punishes Black's blunder, by the last level. |
| `whereMaterialIsWon` | names the square where the best line wins material. |
| `theme` | names the puzzle's motif (fork, pin, mate, undefended…). |
| `threat` | names the square Black threatens (not counted when White has a forced mate). |
| `threatAtLevel1` | the first level already names it. |
| `themeByLevel2` | the motif is named before the move is given. |
| `moveHiddenBeforeLevel3` | the first two levels do not name the best move. |

Levelled hints are recorded with all three levels; the scores above use the full text unless they say otherwise.

Turn commentary:

| Score | The lesson… |
|---|---|
| `blackBlunder` | notices that Black's last move lost at least 2 pawns, and names the winning move or its square. |
| `yourMistake` | notices that your move lost at least 1.5 pawns. |
| `threat` | names the square Black threatens. |

**Checks: is everything it says true?**

- `lessons with a false reference` counts lessons that name a piece on a square where no such piece stands. It also counts a move in notation that isn't legal in any position the lesson discusses: now, before the last moves, along the engine lines, or after moves the lesson names.
- These checks are deliberately lenient, so they undercount false claims. Wrong reasoning, such as calling an even trade a win, still needs a judge or a person.

**Cost and speed:** model calls per lesson, $ per 1,000 lessons (from the prices in `score.mjs`), and median and p90 seconds.

**Noise:** with the real model, two runs of the same code differ. Compare a change against two baseline runs before trusting a difference of a few points.
