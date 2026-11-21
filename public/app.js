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
let selected = null, busy = false, demo = null, autoplay = false, playbackToken = 0, lastText = '';
let pendingSupport = 'none', lastLesson = null;
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
}
function undoMove() {
  const played = game.undo();
  if (played) logHistory('undo', `${played.color === 'w' ? 'White' : 'Black'} ${played.san}`);
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
    showLesson({ title, explanation: lessons.map((lesson, i) => `${i + 1}. ${lesson}`).join('\n\n'), question: '', steps: [] }, 'tutor', { mode: 'game-summary' });
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
      const ns = 'http://www.w3.org/2000/svg', glyph = document.createElementNS(ns, 'svg'), text = document.createElementNS(ns, 'text');
      glyph.setAttribute('class', 'piece'); glyph.setAttribute('data-color', piece.color); glyph.setAttribute('viewBox', '0 0 80 80'); glyph.setAttribute('aria-hidden', 'true');
      text.setAttribute('x', '40'); text.setAttribute('y', '64'); text.setAttribute('text-anchor', 'middle'); text.setAttribute('font-size', '66');
      text.setAttribute('fill', piece.color === 'w' ? '#fff9e5' : '#17241d');
      text.setAttribute('stroke', piece.color === 'w' ? '#17241d' : '#fff9e5'); text.setAttribute('stroke-width', '1.3'); text.setAttribute('paint-order', 'stroke');
      text.textContent = symbols[piece.type]; glyph.append(text); button.append(glyph);
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
  setBusy(true, 'Stockfish is checking the position…'); error();
  try {
    const result = await api('play', { moves: game.history() });
    if (session !== gameId) return;
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
function showLesson(lesson, event = 'tutor', context = {}) {
  if (started && (lesson.explanation || lesson.question) && lesson !== lastLesson) {
    const { title, explanation, question } = lesson;
    logHistory(event, { ...context, title, explanation, question });
  }
  lastLesson = lesson; $('lesson-title').textContent = lesson.title; $('explanation').textContent = lesson.explanation;
  $('question').textContent = lesson.question; $('question').hidden = !lesson.question;
  lastText = lesson.explanation;
  if ($('voice').checked && lastText) speak(lastText);
}
async function tutor(mode, extra = {}, automatic = false) {
  if (!started || busy || demo || $('independent').checked) return;
  const session = gameId;
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
    if (!automatic) support = 'requested';
    else if (support === 'none') support = 'commentary';
    save();
    if (data.demonstration.length) {
      logHistory('variation', { ...context, root: data.root, title: data.lesson.title, explanation: data.lesson.explanation,
        steps: data.demonstration.map(({ san, before, label }, i) => ({ san, before, label, narration: data.lesson.steps[i] })),
      });
      demo = { root: data.root, steps: data.demonstration, narration: data.lesson.steps, index: 0, intro: data.lesson };
      selected = null; renderDemo();
    } else showLesson(data.lesson, mode === 'question' ? 'answer' : 'tutor', context);
  } catch (e) {
    if (session === gameId) logHistory('tutor-error', { ...context, message: e.message });
    if (session === gameId && (!automatic || analysisTimedOut(e))) {
      error(e.name === 'TimeoutError' ? 'The request took too long.' : e.message, () => tutor(mode, extra, automatic));
    }
  }
  finally { if (session === gameId) { setBusy(false); render(); } }
  if (session === gameId && demo) playSequence();
}
function speak(text) {
  if (!('speechSynthesis' in window)) return Promise.resolve();
  cancelSpeech();
  return new Promise(resolve => {
    const speech = new SpeechSynthesisUtterance(text); speech.lang = 'en-GB'; speech.rate = Number($('speed').value);
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
$('hint').onclick = () => tutor('hint');
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
render(); leadLesson();
window.addEventListener('pagehide', stopPlayback);
fetch('/api/status').then(r => r.json()).then(s => { $('connection').textContent = s.configured ? '● Tutor configured' : 'Key needed'; if (!s.configured) error('Add the API key to .env and restart the server.'); }).catch(() => { $('connection').textContent = 'Server unavailable'; });
