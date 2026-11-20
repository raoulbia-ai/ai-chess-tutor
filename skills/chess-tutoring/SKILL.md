---
name: chess-tutoring
description: Explain opening and middlegame decisions to a learner who knows the rules, using verified board facts and Stockfish variations.
---

# Chess tutoring

Teach the decision the learner faces. Choose the board detail that changes what a reasonable player would do next. Skip generic reminders about development, king safety, or central control.

## Choose the lesson

- Check forcing replies first. Describe an immediate threat only when a legal reply and its consequence support it. An attacked piece may be adequately defended. A controlled square may still be a legal destination.
- Compare **restricting a piece with exchanging it**. Name the square or route that matters and what going there would achieve. If a capture is followed by a recapture, consider open lines, the resulting pawn structure, and what useful piece each side gives up.
- Compare **keeping pawn tension with releasing it**. Follow the relevant capture and recapture. Explain what opens, what stays blocked, or which piece gains a useful square. Doubled pawns alone do not establish that a trade is favourable.
- Give **development a job**. Explain what a piece would defend, contest, or help prepare. A piece with few moves can still be doing an important job.

## Match the request

- **Requested hint:** Explain the purpose of each supplied candidate. If there are two, distinguish their benefits or costs. Describe proposed moves and replies conditionally. For castling versus a move that bolsters the centre, explain whether there is a concrete reason to address the centre first. Do not simply name the king’s new square or repeat that a pawn is defended.
- **Turn feedback:** Explain the actual White move and Black reply separately. Carry forward an earlier theme only while the position supports it. Give a positive, negative, or mixed verdict when it teaches a concrete lesson. A quiet move can get a short observation.
- **Review or demonstration:** Explain the relevant effect of each replay step. When the board rewinds, keep the alternatives separate.
- **Question:** Answer directly before elaborating. If asked which piece contributes least, identify its colour, type, square, and the criterion for judging it.

## Ground each claim

Use supplied facts for piece colours, squares, captures, and support. Use the relevant engine line for tactical consequences. Distinguish actual game history, the position before a move, and a possible continuation. Explain the implication of a selected fact without repeating it or introducing an unsupported claim. Omit the rationale if the evidence does not support a useful one.

Example from the practice games: after Black plays `…Na6`, `a3` makes `…Nb4` answerable by `axb4`, keeping White’s bishop. `Bxa6` trades the bishop for the knight if Black recaptures `…bxa6`, leaving pawns on a6 and a7. The choice is whether to make the knight’s jump costly or remove the knight.
