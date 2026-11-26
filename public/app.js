import { Chess } from '/chess.js';

const $ = id => document.getElementById(id);
const mobileLayout = window.matchMedia('(max-width: 800px)');
const boardComment = document.createElement('section');
boardComment.className = 'board-comment';
boardComment.setAttribute('aria-label', 'Current tutor comment');
const lessonHome = document.createComment('Tutor lesson');
const replayHome = document.createComment('Narration replay');
$('lesson').before(lessonHome);
$('replay').before(replayHome);
function positionTutorComment() {
  if (mobileLayout.matches) {
    document.querySelector('.board-frame').after(boardComment);
    boardComment.append($('lesson'), $('replay'));
  } else {
    lessonHome.after($('lesson'));
    replayHome.after($('replay'));
    boardComment.remove();
  }
}
positionTutorComment();
mobileLayout.addEventListener('change', positionTutorComment);
const symbols = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const storageKey = 'chess-understood-v1';
let game = new Chess(), records = [], gameId = crypto.randomUUID(), support = 'none';
// Hints come in levels for one position: questions, then the answer and a rule, then the move.
let hintState = { fen: null, level: 0 }, gameReview = null;
// For the rating and the game review: White moves you took back, the opponents that played Black, the rating result.
let takebacks = [], opponentsUsed = [], ratingResult = null;
let selected = null, busy = false, demo = null, autoplay = false, playbackToken = 0, lastText = '';
let pendingSupport = 'none', lastLesson = null, lastContext = {};
let finishSpeech = null;
let sessionController = new AbortController();
let started = false;
let checkpoint = null;
let historySequence = 0;
const historyQueuePrefix = 'chess-history-pending-v1:';
const pendingHistory = new Map();
const historyKey = entry => `${historyQueuePrefix}${entry.gameId}:${entry.sequence}`;
let savingHistory = false, historyFailure = '';
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(historyQueuePrefix)) continue;
    try {
      const entry = JSON.parse(localStorage.getItem(key));
      if (entry?.gameId && Number.isSafeInteger(entry.sequence) && Array.isArray(entry.moves) && historyKey(entry) === key) {
        pendingHistory.set(key, { entry, persisted: true });
      }
    } catch { /* Ignore a damaged entry without dropping other pending saves. */ }
  }
} catch { /* An unavailable queue must not prevent play. */ }
function historyStatus() {
  $('history-status').hidden = !historyFailure;
  $('history-error').textContent = historyFailure;
  $('retry-history').disabled = savingHistory;
}
async function flushHistory() {
  if (savingHistory || !pendingHistory.size) return;
  savingHistory = true;
  historyStatus();
  try {
    const batch = [...pendingHistory].sort(([, a], [, b]) =>
      a.entry.gameId.localeCompare(b.entry.gameId) || a.entry.sequence - b.entry.sequence);
    for (const [key, { entry }] of batch) {
      const response = await fetch('/api/history', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...entry, retry: true }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `History save failed (HTTP ${response.status}).`);
      }
      pendingHistory.delete(key);
      try { localStorage.removeItem(key); } catch { /* A later retry is safe. */ }
    }
    historyFailure = '';
  } catch (error) {
    const saved = [...pendingHistory.values()].every(item => item.persisted);
    historyFailure = `${error.message} ${saved ? 'Pending entries are saved on this device.' : 'Keep this tab open and retry.'}`;
  } finally {
    savingHistory = false;
    historyStatus();
  }
  if (!historyFailure && pendingHistory.size) flushHistory();
}
function logHistory(event, note = '') {
  const entry = { gameId, sequence: ++historySequence, event, note, moves: game.history(), occurredAt: new Date().toISOString() };
  const key = historyKey(entry);
  let persisted = false;
  try {
    localStorage.setItem(key, JSON.stringify(entry));
    persisted = true;
  } catch { /* Keep it in this tab if storage is unavailable. */ }
  pendingHistory.set(key, { entry, persisted });
  flushHistory();
  return entry.sequence;
}
$('retry-history').onclick = flushHistory;
window.addEventListener('online', flushHistory);
flushHistory();
function commitMove(move) {
  const played = game.move(move);
  logHistory('move', { side: played.color, san: played.san, from: played.from, to: played.to,
    ...(played.color === 'w' ? { support } : {}),
  });
  if (game.isGameOver()) logHistory('result', {
    result: game.isCheckmate() ? (game.turn() === 'w' ? '0-1' : '1-0') : '1/2-1/2',
    reason: game.isCheckmate() ? 'checkmate' : game.isStalemate() ? 'stalemate'
      : game.isThreefoldRepetition() ? 'threefold repetition'
      : game.isInsufficientMaterial() ? 'insufficient material' : 'fifty-move rule',
  });
  if (game.isGameOver()) reportResult();
}
// Counts a finished game toward your rating (the server decides whether it is rated) and keeps the outcome
// for the game review.
function reportResult() {
  if (!started) return;
  const session = gameId;
  api('rating', { gameId, moves: game.history(), opponents: opponentsUsed, takebacks: takebacks.length })
    .then(data => {
      if (session !== gameId || data.duplicate) return;
      const outcome = data.result === 1 ? 'Win' : data.result === 0 ? 'Loss' : 'Draw';
      ratingResult = { gameId: session, text: data.rated
        ? `${outcome} against ${data.opponent} (${data.opponentRating}): your rating ${data.before} → ${data.after}${data.provisional ? ' (provisional)' : ''}.`
        : `This game is not rated: ${data.reason}.` };
    }).catch(() => { /* The rating is optional; the game is unaffected. */ });
}
function undoMove() {
  const played = game.undo();
  if (played) logHistory('undo', `${played.color === 'w' ? 'White' : 'Black'} ${played.san}`);
  if (played?.color === 'w') takebacks.push({ moves: game.history(), san: played.san });
  return played;
}
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved) {
    records = Array.isArray(saved.records) ? saved.records.slice(-500).map(r => ({ ...r, support: r.support ?? (r.assisted === false ? 'none' : 'legacy') })) : [];
  }
} catch { /* A damaged or unavailable local save must not prevent play. */ }

function save() {
  try { localStorage.setItem(storageKey, JSON.stringify({ records: records.slice(-500) })); }
  catch { $('progress-note').textContent = 'Device storage is unavailable. Keep this tab open to retain this session.'; }
}
function error(message = '', retry) {
  $('error').textContent = message; $('error').hidden = !message;
  const button = $('retry-analysis');
  button.hidden = !retry;
  const session = gameId, position = game.fen();
  button.onclick = retry ? () => {
    if (busy || demo || session !== gameId || position !== game.fen()) return;
    retry();
  } : null;
}
function analysisTimedOut(e) { return e.name === 'TimeoutError' || /timed out|took too long/i.test(e.message); }
function setBusy(value, message = 'Thinking through the position…') {
  busy = value; $('busy').textContent = message; $('busy').hidden = !value; renderControls();
}
async function api(route, body) {
  const response = await fetch('/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([sessionController.signal, AbortSignal.timeout(120000)]) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please retry.');
  return data;
}
function phase() { return game.history().length < 20 ? 'opening' : 'middlegame'; }
function leadLesson() {
  if (started && game.isGameOver()) {
    const title = game.isCheckmate() ? `Checkmate · ${game.turn() === 'w' ? 'Black' : 'White'} wins!`
      : game.isStalemate() ? 'Draw · Stalemate' : game.isThreefoldRepetition() ? 'Draw · Threefold repetition'
      : game.isInsufficientMaterial() ? 'Draw · Insufficient material' : 'Draw · Fifty-move rule';
    const moves = game.history({ verbose: true });
    const at = move => `${move.before.split(' ')[5]}${move.color === 'w' ? '.' : '…'}${move.san}`;
    const lessons = [];
    const opening = moves.slice(0, 16).find(move => move.color === 'w' && ['n', 'b'].includes(move.piece));
    if (opening) lessons.push(`Develop with a purpose. At ${at(opening)}, you brought your ${names[opening.piece]} into play. When developing, look for a square that also helps contest the centre.`);
    const exchange = moves.find((move, i) => move.color === 'w' && move.captured && moves[i + 1]?.captured && moves[i + 1].to === move.to);
    if (exchange) lessons.push(`Count the whole exchange. After ${at(exchange)}, Black could take back on ${exchange.to} and did. Before trading, picture what remains on that square.`);
    const check = moves.find(move => move.color === 'b' && move.san.endsWith('+'));
    if (check) lessons.push(`Scan for checks before committing. At ${at(check)}, Black forced you to respond. Look for that kind of reply before choosing your move.`);
    const promotion = moves.find(move => move.promotion);
    if (promotion) lessons.push(`Plan around promotion. At ${at(promotion)}, a pawn became a ${names[promotion.promotion]}. In a pawn race, count how many moves each side needs and check for forcing replies.`);
    const last = moves.at(-1);
    if (game.isCheckmate()) lessons.push(`Use ${at(last)} as a mating exercise. Find the piece giving check and work out why the king has no escape, capture or block.`);
    else if (game.isStalemate()) lessons.push(`Check for stalemate before restricting the king. After ${at(last)}, the player to move had no legal move and was out of check.`);
    const reviewMoves = [...new Set([moves[0], ...moves.filter(move => move.color === 'w' && (move.captured || move.san.includes('+'))), last])].filter(Boolean);
    const exercises = [
      'Replay this position and compare two legal choices. Give each move a purpose before you evaluate it.',
      'Look at what the opponent could capture immediately after this move. Check what you could take back.',
      'Pause before this move and find your least active piece. Name one square where it could do more.',
      'Check how this move changes pawn structure. Look for newly opened files or diagonals.',
      'Replay the final position and explain the result by checking the legal moves and the draw rules.',
    ];
    for (let i = 0; lessons.length < 5; i++) {
      const move = reviewMoves[Math.min(i, reviewMoves.length - 1)];
      lessons.push(`${at(move)}. ${exercises[i]}`);
    }
    const fallback = { title, explanation: lessons.map((lesson, i) => `${i + 1}. ${lesson}`).join('\n\n'), question: '', steps: [] };
    // The engine review of the whole game replaces the general exercises; they remain the fallback if it fails.
    const length = moves.length;
    if (gameReview?.gameId === gameId && gameReview.length === length && gameReview.lesson) {
      const rated = ratingResult?.gameId === gameId ? `\n\n${ratingResult.text}` : '';
      showLesson({ ...gameReview.lesson, explanation: gameReview.lesson.explanation + rated }, 'tutor', { mode: 'game-summary' });
      return;
    }
    if (!(gameReview?.gameId === gameId && gameReview.length === length)) {
      const request = gameReview = { gameId, length, lesson: null };
      api('tutor', { mode: 'summary', moves: game.history(), takebacks: takebacks.slice(-40) })
        .then(data => { request.lesson = { ...data.lesson, title }; })
        .catch(() => { request.lesson = fallback; })
        .finally(() => { if (gameReview === request && game.isGameOver() && !demo) leadLesson(); });
    }
    $('lesson-title').textContent = title; $('explanation').textContent = 'Reviewing your game with the engine…'; $('question').hidden = true;
    return;
  }
  const title = !started ? 'Ready to practise.' : 'Your move.';
  showLesson({ title, explanation: '', question: '', steps: [] });
}
async function coachPosition() {
  leadLesson();
  if (!game.isGameOver() && !$('independent').checked) await tutor('turn', {}, true);
}
function learningFocus() {
  const independent = records.filter(r => r.support === 'none' && r.phase === phase());
  const recent = independent.slice(-6), earlier = independent.slice(-12, -6);
  if (recent.length < 6 || recent.filter(r => r.sound).length < 5) return 'Notice threats & protect pieces';
  if (earlier.length < 6 || earlier.filter(r => r.sound).length < 5) return phase() === 'opening' ? 'Connect development to the pawn structure' : 'Improve your least active piece';
  return phase() === 'opening' ? 'Connect your opening to a plan' : 'Build a plan & check their reply';
}
function renderProgress() {
  const independent = records.filter(r => r.support === 'none');
  $('independent-count').textContent = independent.length;
  $('assisted-count').textContent = records.filter(r => r.support === 'requested').length;
  $('commentary-count').textContent = records.filter(r => r.support === 'commentary').length;
  const legacy = records.filter(r => r.support === 'legacy').length;
  $('legacy-progress').textContent = legacy ? `Earlier records include ${legacy} assisted decisions with unspecified help.` : '';
  $('focus').textContent = learningFocus();
  const current = independent.filter(r => r.phase === phase()), recent = current.slice(-6), previous = current.slice(-12, -6);
  let note = 'We’ll start with the basics. Independent decisions give us a baseline; assisted moves are practice.';
  if (recent.length) note = `${recent.filter(r => r.sound).length} of your last ${recent.length} independent ${phase()} decisions stayed close to the engine’s preferred move. ${recent.length < 6 ? 'Still gathering a baseline.' : 'Your next focus: ' + learningFocus().toLowerCase() + '.'}`;
  if (previous.length === 6) note += ` Previous six: ${previous.filter(r => r.sound).length} sound decisions. This is a practice signal, not a mastery score.`;
  $('progress-note').textContent = note;
  $('phase-progress').textContent = ['opening', 'middlegame'].map(p => `${p === 'opening' ? 'Opening' : 'Middlegame'}: ${independent.filter(r => r.phase === p && r.sound).length} sound / ${independent.filter(r => r.phase === p).length} independent decisions`).join(' · ');
}
function renderControls() {
  const unavailable = !started || busy || Boolean(demo) || game.turn() !== 'w' || game.isGameOver();
  $('start-game').textContent = started ? 'Restart game' : 'Start game';
  for (const id of ['hint', 'ask-button', 'ask']) $(id).disabled = unavailable || $('independent').checked;
  const hintLevel = hintState.fen === game.fen() ? hintState.level : 0;
  $('hint').textContent = hintLevel === 1 ? 'More help' : hintLevel === 2 ? 'Show the move' : 'Hint';
  const canReview = checkpoint ? !busy && !demo : !unavailable && game.history().length >= 2;
  $('review').disabled = !canReview || $('independent').checked;
  $('assess').disabled = unavailable || $('independent').checked || game.history().length < 2;
  $('undo').disabled = busy || Boolean(demo) || Boolean(checkpoint) || !game.history().length;
  $('independent').disabled = !started || busy || Boolean(demo) || Boolean(checkpoint);
  $('retry-opponent').hidden = busy || Boolean(demo) || Boolean(checkpoint) || game.turn() !== 'b' || game.isGameOver();
  $('move-feedback').hidden = !checkpoint || busy || Boolean(demo);
  $('previous').disabled = !demo || demo.index === 0;
  $('next').disabled = !demo || demo.index === demo.steps.length;
  $('autoplay').textContent = autoplay ? 'Pause sequence' : 'Play sequence';
  $('demo-controls').hidden = !demo; $('demo-banner').hidden = !demo;
}
function render() {
  const display = demo ? new Chess(demo.index === 0 ? demo.root : demo.steps[demo.index - 1].fen) : game;
  const playedMoves = game.history({ verbose: true });
  const rootIndex = demo ? playedMoves.findIndex(move => move.before === demo.root) : -1;
  const steps = demo ? demo.steps.slice(0, demo.index) : [];
  const branchStart = steps.findLastIndex(step => step.before === demo.root);
  const displayedMoves = [...(rootIndex < 0 ? playedMoves : playedMoves.slice(0, rootIndex)), ...steps.slice(Math.max(0, branchStart))];
  for (const color of ['w', 'b']) {
    const captures = displayedMoves.filter(move => move.color === color && move.captured);
    const row = $('captures-' + color);
    row.hidden = !captures.length;
    row.replaceChildren(...captures.map(move => {
      const icon = document.createElement('span');
      icon.textContent = symbols[move.captured];
      return icon;
    }));
    row.setAttribute('aria-label', `Captured: ${captures.map(move => names[move.captured]).join(', ')}`);
  }
  // Who is ahead in material, in points: the running count teaches what each trade was worth.
  const worth = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const points = color => displayedMoves.filter(move => move.color === color).reduce((sum, move) => sum + (move.captured ? worth[move.captured] : 0) + (move.promotion ? worth[move.promotion] - 1 : 0), 0);
  const lead = points('w') - points('b');
  for (const color of ['w', 'b']) {
    const ahead = color === 'w' ? lead : -lead, row = $('captures-' + color);
    if (ahead <= 0) continue;
    const badge = document.createElement('span');
    badge.className = 'material-lead'; badge.textContent = `+${ahead}`;
    badge.title = 'Material ahead, in points: pawn 1, knight 3, bishop 3, rook 5, queen 9';
    row.append(badge); row.hidden = false;
    row.setAttribute('aria-label', `${row.getAttribute('aria-label')}. ${color === 'w' ? 'You are' : 'Black is'} ${ahead} ${ahead === 1 ? 'point' : 'points'} ahead in material`);
  }
  const legal = !demo && selected ? game.moves({ square: selected, verbose: true }) : [];
  const previous = demo ? demo.steps[demo.index - 1] : playedMoves.at(-1);
  $('board').replaceChildren();
  for (let rank = 8; rank >= 1; rank--) for (let file = 0; file < 8; file++) {
    const square = String.fromCharCode(97 + file) + rank, piece = display.get(square), button = document.createElement('button');
    button.type = 'button'; button.dataset.square = square;
    button.className = 'square' + ((file + rank) % 2 === 0 ? ' dark' : '') + (piece ? ' occupied' : '') + (selected === square ? ' selected' : '') + (legal.some(m => m.to === square) ? ' target' : '') + (previous && [previous.from, previous.to].includes(square) ? ' last' : '');
    button.setAttribute('aria-label', `${square}${piece ? ', ' + (piece.color === 'w' ? 'White ' : 'Black ') + names[piece.type] : ', empty'}${legal.some(m => m.to === square) ? ', legal destination' : ''}`);
    button.setAttribute('aria-pressed', String(selected === square));
    button.setAttribute('aria-disabled', String(!started || busy || Boolean(demo) || game.turn() !== 'w' || game.isGameOver()));
    if (piece) {
      const ns = 'http://www.w3.org/2000/svg', glyph = document.createElementNS(ns, 'svg');
      glyph.setAttribute('class', 'piece'); glyph.setAttribute('data-color', piece.color); glyph.setAttribute('viewBox', '0 0 80 80'); glyph.setAttribute('aria-hidden', 'true');
      // The text-presentation selector stops phones from drawing the pawn as a colour emoji.
      for (const layer of ['outline', 'body']) {
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('class', layer); text.setAttribute('x', '40'); text.setAttribute('y', '64'); text.setAttribute('text-anchor', 'middle'); text.setAttribute('font-size', '66');
        text.textContent = symbols[piece.type] + '\uFE0E'; glyph.append(text);
      }
      button.append(glyph);
    }
    button.onclick = () => selectSquare(square); $('board').append(button);
  }
  let status = game.turn() === 'w' ? 'White · your move' : 'Black is thinking…';
  if (game.isGameOver()) status = game.isCheckmate() ? (game.turn() === 'w' ? 'Checkmate · Black wins' : 'Checkmate · you win') : 'Game drawn';
  else if (game.isCheck()) status += ' · check';
  $('turn').textContent = !started ? 'White · ready to start' : demo ? 'Watching a possible continuation' : checkpoint ? 'Paused before Black replies' : status;
  $('move-number').textContent = 'MOVE ' + (Math.floor(game.history().length / 2) + 1);
  $('phase').textContent = demo ? 'Watch & understand' : phase() === 'opening' ? 'Opening practice' : 'Middlegame practice';
  $('board-help').textContent = !started ? 'Press Start game to begin your lesson.' : demo ? 'This is one possible line, not a prediction of your opponent’s moves.' : $('independent').checked ? 'Unassisted practice: tutor help is off. Your decisions still count.' : 'Tap a piece, then a highlighted square. You play White.';
  const history = game.history(); $('move-count').textContent = history.length;
  $('move-history').textContent = history.length ? history.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + m).join(' ') : 'Your game starts with you.';
  renderControls(); renderProgress();
  saveGame();
}
async function selectSquare(square) {
  if (!started || busy || demo || game.turn() !== 'w' || game.isGameOver()) return;
  const session = gameId;
  const possible = selected ? game.moves({ square: selected, verbose: true }).filter(m => m.to === square) : [];
  if (possible.length) {
    let promotion;
    if (possible.some(m => m.promotion)) {
      setBusy(true, 'Choose a promotion piece.');
      const dialog = $('promotion'); dialog.showModal();
      promotion = await new Promise(resolve => { dialog.onclose = () => resolve(dialog.returnValue || null); });
      if (session !== gameId) return;
      setBusy(false); if (!promotion) return;
    }
    stopPlayback();
    commitMove({ from: selected, to: square, promotion }); selected = null;
    pendingSupport = support; support = 'none'; save(); render(); error();
    if (!game.isGameOver()) await opponent();
    else leadLesson();
  } else { selected = game.get(square)?.color === 'w' ? square : null; render(); }
}
async function opponent() {
  const session = gameId;
  setBusy(true, $('opponent').value.startsWith('maia') ? 'Black is thinking…' : 'Stockfish is checking the position…'); error();
  try {
    const result = await api('play', { moves: game.history(), opponent: $('opponent').value });
    if (session !== gameId) return;
    if (result.opponent && !opponentsUsed.includes(result.opponent)) opponentsUsed.push(result.opponent);
    records.push({ id: crypto.randomUUID(), ...result.feedback, support: pendingSupport });
    pendingSupport = 'none'; save();
    if (result.coaching && !$('independent').checked) {
      checkpoint = result;
      showCheckpoint();
      return;
    }
    commitMove(result.reply);
    setBusy(false);
    await coachPosition();
  } catch (e) { if (session === gameId) error(e.message, analysisTimedOut(e) ? opponent : undefined); }
  finally { if (session === gameId) { setBusy(false); render(); } }
}
function showCheckpoint() { showLesson({ ...checkpoint.coaching, question: '', steps: [] }, 'tutor', { mode: 'checkpoint' }); }
function showLesson(lesson, event = 'tutor', context = {}, spoken = lesson.explanation) {
  if (started && !restoring && (lesson.explanation || lesson.question) && lesson !== lastLesson) {
    const { title, explanation, question } = lesson;
    logHistory(event, { ...context, title, explanation, question });
  }
  lastLesson = lesson; lastContext = context; $('lesson-title').textContent = lesson.title; $('explanation').textContent = lesson.explanation;
  $('question').textContent = lesson.question; $('question').hidden = !lesson.question;
  lastText = lesson.explanation; resetFeedback();
  if ($('voice').checked && spoken) speak(spoken);
}
async function tutor(mode, extra = {}, automatic = false) {
  if (!started || busy || demo || $('independent').checked) return;
  const session = gameId, shownBefore = lastText;
  setBusy(true, mode === 'demonstrate' ? 'Preparing a short, narrated continuation…' : 'Your tutor is studying the engine analysis…'); error();
  const request = { mode, automatic, focus: learningFocus(), ...extra };
  const requestSequence = logHistory('tutor-request', request);
  const context = { mode, automatic, requestSequence };
  try {
    const data = await api('tutor', { moves: game.history(), ...request });
    if (session !== gameId) return;
    if (automatic && !data.lesson.explanation.trim()) {
      logHistory('tutor-skip', context);
      return;
    }
    if (mode === 'hint' && data.hint) hintState = { fen: game.fen(), level: data.hint.level };
    if (!automatic) support = 'requested';
    else if (support === 'none') support = 'commentary';
    save();
    if (data.demonstration.length) {
      logHistory('variation', { ...context, root: data.root, title: data.lesson.title, explanation: data.lesson.explanation,
        steps: data.demonstration.map(({ san, before, label }, i) => ({ san, before, label, narration: data.lesson.steps[i] })),
      });
      demo = { root: data.root, steps: data.demonstration, narration: data.lesson.steps, index: 0, intro: data.lesson };
      selected = null; lastContext = context; renderDemo();
    } else {
      // A higher hint level repeats the earlier levels on screen; read aloud only the new part.
      const text = data.lesson.explanation;
      const spoken = mode === 'hint' && data.hint?.level > 1 && shownBefore && text.startsWith(shownBefore) ? text.slice(shownBefore.length).trim() : text;
      showLesson(data.lesson, mode === 'question' ? 'answer' : 'tutor', mode === 'hint' ? { ...context, level: data.hint?.level } : context, spoken);
    }
  } catch (e) {
    if (session === gameId) logHistory('tutor-error', { ...context, message: e.message });
    if (session === gameId && (!automatic || analysisTimedOut(e))) {
      error(e.name === 'TimeoutError' ? 'The request took too long.' : e.message, () => tutor(mode, extra, automatic));
    }
  }
  finally { if (session === gameId) { setBusy(false); render(); } }
  if (session === gameId && demo) playSequence();
}
// "Not helpful": sends the message on screen, with the moves and the request that produced it, to the server's
// feedback inbox. Each new message starts with the button closed.
function resetFeedback() {
  $('feedback').hidden = !started || !$('explanation').textContent.trim();
  document.querySelector('.feedback-buttons').hidden = false; $('feedback-form').hidden = true; $('feedback-status').hidden = true; $('feedback-comment').value = '';
}
// Two ratings: "not helpful" (the message missed), and "somewhat helpful" (understood, but it could teach more).
let feedbackRating = 'not';
const feedbackPrompts = {
  not: ['What would have helped? (optional)', 'Too vague: tell me which piece to look at'],
  somewhat: ['What would make it more educational? (optional)', 'Tell me why this works, or what to look for next time'],
};
for (const button of document.querySelectorAll('.feedback-open')) button.onclick = () => {
  feedbackRating = button.dataset.rating;
  [$('feedback-label').textContent, $('feedback-comment').placeholder] = feedbackPrompts[feedbackRating];
  document.querySelector('.feedback-buttons').hidden = true; $('feedback-form').hidden = false; $('feedback-comment').focus();
};
$('feedback-cancel').onclick = resetFeedback;
$('feedback-form').onsubmit = async event => {
  event.preventDefault();
  const status = $('feedback-status');
  $('feedback-send').disabled = true;
  try {
    await api('feedback', { gameId, moves: game.history(), rating: feedbackRating, comment: $('feedback-comment').value,
      context: { mode: lastContext.mode, level: lastContext.level, automatic: lastContext.automatic },
      lesson: { title: $('lesson-title').textContent, explanation: $('explanation').textContent, question: $('question').hidden ? '' : $('question').textContent } });
    $('feedback-form').hidden = true; status.textContent = 'Sent. Ask Claude to review the feedback, and this message will be looked at.';
  } catch (e) {
    status.textContent = `Could not send the report: ${e.message}`;
  } finally { status.hidden = false; $('feedback-send').disabled = false; }
};
function speak(text) {
  if (!('speechSynthesis' in window)) return Promise.resolve();
  cancelSpeech();
  return new Promise(resolve => {
    // Hint bullets are for the eye: read the sentences, not the bullet signs.
    const speech = new SpeechSynthesisUtterance(text.replace(/^• /gm, '')); speech.lang = 'en-GB'; speech.rate = Number($('speed').value);
    finishSpeech = resolve;
    speech.onend = () => { if (finishSpeech === resolve) finishSpeech = null; resolve(); };
    speech.onerror = () => {
      if (finishSpeech !== resolve) return;
      finishSpeech = null;
      stopPlayback();
      error('Speech could not play. Press Replay to try again, or turn off Read aloud to follow the text.');
      resolve();
    };
    speechSynthesis.resume(); $('pause-voice').textContent = 'Pause voice'; speechSynthesis.speak(speech);
  });
}
function cancelSpeech() {
  const finish = finishSpeech; finishSpeech = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  finish?.();
}
function stopPlayback() { autoplay = false; playbackToken++; cancelSpeech(); renderControls(); }
function renderDemo() {
  if (!demo) return;
  $('step-count').textContent = demo.index ? `${demo.steps[demo.index - 1].label} · ${demo.index} / ${demo.steps.length} · ${demo.steps[demo.index - 1].san}` : 'Starting position · your game has not changed';
  const text = demo.index ? demo.narration[demo.index - 1] : demo.intro.explanation;
  $('lesson-title').textContent = demo.index ? 'Watch the idea develop.' : demo.intro.title;
  $('explanation').textContent = text; $('question').hidden = true; lastText = text;
  resetFeedback();
  render();
}
async function stepDemo(delta, auto = false) {
  if (!demo) return;
  if (!auto) stopPlayback();
  const token = playbackToken;
  const next = delta > 0 ? demo.steps[demo.index] : null;
  if (next) {
    // A comparison can rewind to the root before showing the other line.
    const before = demo.index ? demo.steps[demo.index - 1].fen : demo.root;
    if (next.before !== before) {
      const savedIndex = demo.index;
      demo.index = 0; renderDemo(); demo.index = savedIndex;
      $('step-count').textContent = 'Back to the starting position · ' + next.label;
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!demo || token !== playbackToken) return;
    }
  }
  const source = next && $('board').querySelector(`[data-square="${next.from}"]`)?.getBoundingClientRect();
  demo.index = Math.min(demo.steps.length, Math.max(0, demo.index + delta)); renderDemo();
  if (source && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const target = $('board').querySelector(`[data-square="${next.to}"]`);
    const destination = target.getBoundingClientRect();
    target.animate([{ zIndex: 2 }, { zIndex: 2 }], { duration: 550 });
    target.querySelector('.piece')?.animate([
      { transform: `translate(${source.x - destination.x}px, ${source.y - destination.y}px)` },
      { transform: 'translate(0, 0)' },
    ], { duration: 550, easing: 'ease-in-out' });
  }
  if ($('voice').checked) await speak(lastText);
  else if (auto) await new Promise(resolve => setTimeout(resolve, Math.max(3500, lastText.split(/\s+/).length * 330)));
}
$('hint').onclick = () => tutor('hint', { level: hintState.fen === game.fen() ? Math.min(3, hintState.level + 1) : 1 });
$('review').onclick = () => tutor('review');
$('assess').onclick = () => tutor('assess');
$('ask-form').onsubmit = event => {
  event.preventDefault();
  const input = $('ask'), question = input.value.trim();
  if (!question || $('ask-button').disabled) return;
  input.value = '';
  tutor('question', { question });
};
$('previous').onclick = () => stepDemo(-1); $('next').onclick = () => stepDemo(1);
async function playSequence() {
  if (autoplay) return stopPlayback();
  if (!demo) return;
  if (demo.index === demo.steps.length) { demo.index = 0; renderDemo(); }
  autoplay = true; const token = ++playbackToken; renderControls();
  // Read the current explanation before advancing (also resumes a paused step).
  if ($('voice').checked) await speak(lastText);
  else await new Promise(resolve => setTimeout(resolve, Math.max(3500, lastText.split(/\s+/).length * 330)));
  while (demo && autoplay && token === playbackToken && demo.index < demo.steps.length) await stepDemo(1, true);
  if (token === playbackToken) { autoplay = false; renderControls(); }
}
$('autoplay').onclick = playSequence;
$('return-game').onclick = () => { stopPlayback(); demo = null; if (checkpoint) showCheckpoint(); else leadLesson(); render(); };
$('retry-move').onclick = () => {
  if (!checkpoint) return;
  stopPlayback(); checkpoint = null; undoMove(); support = 'requested'; error(); render();
  showLesson({ title: 'Try another move.', explanation: 'The board is back before your move. Use what you saw to choose an alternative.', question: '', steps: [] });
};
$('keep-move').onclick = () => {
  if (!checkpoint) return;
  stopPlayback(); commitMove(checkpoint.reply); checkpoint = null; error(); render(); coachPosition();
};
$('voice').onchange = () => { stopPlayback(); if (demo) playSequence(); else if ($('voice').checked) speak(lastText); };
$('replay').onclick = () => { stopPlayback(); if (demo) { demo.index = 0; renderDemo(); playSequence(); } else { $('voice').checked = true; speak(lastText); } };
$('pause-voice').onclick = () => { if (speechSynthesis.paused) { speechSynthesis.resume(); $('pause-voice').textContent = 'Pause voice'; } else { speechSynthesis.pause(); $('pause-voice').textContent = 'Resume voice'; } };
$('speed').onchange = () => { const resume = autoplay; stopPlayback(); if (demo && resume) playSequence(); else if ($('voice').checked) speak(lastText); };
$('independent').onchange = () => { stopPlayback(); save(); render(); showLesson({ title: $('independent').checked ? 'Try it on your own.' : 'Your tutor is back.', explanation: $('independent').checked ? 'Hints and reviews are off. Check your opponent’s threats, then choose a move. Any help already received on this position still counts as assistance.' : 'Ask for a hint, review your move, or assess Black’s reply.', question: '', steps: [] }); };
$('undo').onclick = () => { if (busy || demo) return; stopPlayback(); if (game.turn() === 'w') undoMove(); undoMove(); support = 'requested'; selected = null; save(); render(); showLesson({ title: 'Try that decision again.', explanation: 'Your original attempt remains in your practice history. This retry counts as assisted practice.', question: '', steps: [] }); };
function resetSession(clearProgress = false, begin = false) {
  checkpoint = null;
  gameId = crypto.randomUUID();
  historySequence = 0;
  sessionController.abort(); sessionController = new AbortController(); stopPlayback();
  if ($('promotion').open) $('promotion').close();
  game = new Chess(); started = begin;
  if (started) logHistory('start');
  if (clearProgress) records = [];
  demo = null; selected = null; support = 'none'; pendingSupport = 'none'; lastLesson = null; lastText = '';
  takebacks = []; opponentsUsed = []; ratingResult = null;
  $('ask').value = ''; $('independent').checked = false; $('pause-voice').textContent = 'Pause voice';
  setBusy(false); error(); render(); save(); leadLesson();
}
$('new-game').onclick = () => {
  if ((game.history().length || records.length || busy || demo) && !confirm('Reset the board, tutor and all saved learning progress?')) return;
  resetSession(true);
};
$('start-game').onclick = () => {
  if (started && (game.history().length || busy || demo) && !confirm('Restart this game and lesson? Your learning progress will be kept.')) return;
  resetSession(false, true);
};
$('retry-opponent').onclick = opponent;
if (!('speechSynthesis' in window)) for (const id of ['voice', 'replay', 'pause-voice', 'speed']) $(id).disabled = true;
// Keep the game in this browser so a refresh or an accidental close does not lose it.
const gameKey = 'chess-game-v1';
let savedGame = '', restoring = false;
function saveGame() {
  const moves = game.history();
  const state = started || moves.length ? JSON.stringify({ gameId, historySequence, started, moves, support, pendingSupport, checkpoint, takebacks: takebacks.slice(-40), opponentsUsed,
    independent: $('independent').checked,
    lesson: lastLesson && { title: lastLesson.title, explanation: lastLesson.explanation, question: lastLesson.question } }) : '';
  if (state === savedGame) return;
  try { if (state) localStorage.setItem(gameKey, state); else localStorage.removeItem(gameKey); savedGame = state; }
  catch { /* Without storage the game lasts only while this tab is open. */ }
}
// Returns null when nothing was restored, otherwise whether Black still owes a reply.
function restoreGame() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(gameKey)); } catch { return null; }
  if (!saved || typeof saved.gameId !== 'string' || !Array.isArray(saved.moves) || saved.moves.length > 500 || !saved.moves.every(m => typeof m === 'string')) return null;
  const restored = new Chess();
  try { for (const move of saved.moves) restored.move(move); } catch { return null; }
  game = restored; gameId = saved.gameId; started = saved.started === true || saved.moves.length > 0;
  historySequence = Number.isSafeInteger(saved.historySequence) ? saved.historySequence : saved.moves.length;
  support = ['none', 'requested', 'commentary'].includes(saved.support) ? saved.support : 'none';
  pendingSupport = ['none', 'requested', 'commentary'].includes(saved.pendingSupport) ? saved.pendingSupport : 'none';
  $('independent').checked = saved.independent === true;
  checkpoint = saved.checkpoint?.coaching && saved.checkpoint.reply ? saved.checkpoint : null;
  takebacks = Array.isArray(saved.takebacks) ? saved.takebacks.filter(t => t && typeof t.san === 'string' && Array.isArray(t.moves) && t.moves.every(m => typeof m === 'string')) : [];
  // A game saved before takebacks were tracked cannot prove it had none, so it is not rated.
  if (!Array.isArray(saved.takebacks) && saved.moves.length) takebacks.push({ moves: [], san: '' });
  opponentsUsed = Array.isArray(saved.opponentsUsed) ? saved.opponentsUsed.filter(id => typeof id === 'string').slice(0, 10) : [];
  savedGame = localStorage.getItem(gameKey);
  restoring = true;
  render(); leadLesson();
  restoring = false;
  if (checkpoint) showCheckpointQuietly();
  else if (saved.lesson?.explanation && !game.isGameOver()) {
    lastLesson = { title: String(saved.lesson.title || ''), explanation: String(saved.lesson.explanation), question: '', steps: [] };
    $('lesson-title').textContent = lastLesson.title; $('explanation').textContent = lastLesson.explanation;
    $('question').hidden = true; lastText = lastLesson.explanation; resetFeedback();
  }
  render();
  return started && !game.isGameOver() && !checkpoint && game.turn() === 'b';
}
function showCheckpointQuietly() { restoring = true; showCheckpoint(); restoring = false; }
const resumed = restoreGame();
if (resumed === null) { render(); leadLesson(); }
else if (resumed) opponent();
window.addEventListener('pagehide', stopPlayback);
// The opponent: human-like Maia at a chosen rating when the server has it, or reduced-strength Stockfish.
const opponentKey = 'chess-tutor-opponent';
$('opponent').onchange = () => { try { localStorage.setItem(opponentKey, $('opponent').value); } catch { /* Not remembered. */ } };
fetch('/api/status').then(r => r.json()).then(s => {
  const list = s.opponents ?? [];
  if (!list.length) return;
  // Each opponent with its strength, so you always know whom you are playing.
  $('opponent').replaceChildren(...list.map(o => new Option(`${o.name} · ${o.approximate ? 'about' : 'rated'} ${o.rating}`, o.id)));
  let chosen = 'maia-1500';
  try { chosen = localStorage.getItem(opponentKey) || chosen; } catch { /* Use the default. */ }
  const ids = list.map(o => o.id);
  $('opponent').value = ids.includes(chosen) ? chosen : ids.includes('maia-1500') ? 'maia-1500' : ids[0];
}).catch(() => {});
// The menu: your rating and the piece values, out of the way until opened.
async function openMenu() {
  $('menu').showModal();
  try {
    const r = await (await fetch('/api/rating')).json();
    $('rating-value').textContent = r.games ? `${r.rating}${r.provisional ? '?' : ''}` : '1500?';
    $('rating-note').textContent = r.games
      ? `${r.games} rated ${r.games === 1 ? 'game' : 'games'}: ${r.wins} won, ${r.draws} drawn, ${r.losses} lost${r.provisional ? '. Provisional until 10 games.' : '.'}`
      : 'No rated games yet. Everyone starts at 1500; finish a game without takebacks to begin.';
    $('rating-recent').replaceChildren(...r.recent.map(g => {
      const item = document.createElement('li');
      item.textContent = `${g.result === 1 ? 'Won' : g.result === 0 ? 'Lost' : 'Drew'} against ${g.opponent} (${g.opponentRating}) · ${g.change >= 0 ? '+' : ''}${g.change}`;
      return item;
    }));
  } catch { $('rating-note').textContent = 'The rating could not be loaded. Is the server running?'; }
}
$('open-menu').onclick = openMenu;
$('close-menu').onclick = () => $('menu').close();
$('menu').onclick = event => { if (event.target === $('menu')) $('menu').close(); };
fetch('/api/status').then(r => r.json()).then(s => { $('connection').textContent = s.configured ? '● Tutor configured' : 'Key needed'; if (!s.configured) error('Add the API key to .env and restart the server.'); }).catch(() => { $('connection').textContent = 'Server unavailable'; });
