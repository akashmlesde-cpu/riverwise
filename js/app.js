/* app.js — UI controller. Wires engine + coach + stats + storage to the DOM.
 * The hero decision loop is strictly: present spot → hero commits → grade → teach → continue.
 */
(function (PT) {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  let engine = null, stats = new PT.SessionStats();
  let heroId = 0;
  let pendingSizeAction = null;   // 'bet' | 'raise' while size chooser open
  let lastVerdict = null;         // most recent verdict (tutor may discuss it)
  let handDecisions = [];         // this hand's graded decisions, for the tutor's hand review
  let heroFlags = null;           // per-hand stat flags
  let guessMode = localStorage.getItem('riverwise.guessMode') === '1';
  let guessRevealed = false, lastGuess = null;

  /* ---------------- session setup ---------------- */

  function buildSeatCfg(count) {
    const wrap = $('#seatCfg');
    wrap.innerHTML = '';
    const lineup = PT.opponents.DEFAULT_LINEUP;
    for (let i = 0; i < count - 1; i++) {
      const key = lineup[i % lineup.length];
      const label = document.createElement('label');
      label.innerHTML = `${PT.opponents.AI_NAMES[i]} — seat ${i + 2} `;
      const sel = document.createElement('select');
      sel.dataset.seat = i;
      for (const [k, a] of Object.entries(PT.opponents.ARCHETYPES)) {
        const o = document.createElement('option');
        o.value = k; o.textContent = a.label;
        if (k === key) o.selected = true;
        sel.appendChild(o);
      }
      label.appendChild(sel);
      wrap.appendChild(label);
    }
  }

  $('#playerCount').addEventListener('change', e => buildSeatCfg(+e.target.value));
  $('#newSessionBtn').addEventListener('click', () => { buildSeatCfg(+$('#playerCount').value); $('#setupDialog').showModal(); });

  $('#startBtn').addEventListener('click', e => {
    e.preventDefault();
    const count = +$('#playerCount').value;
    const stackBB = +$('#stackBB').value, sb = +$('#sbBB').value, bb = +$('#bbBB').value;
    if (!(sb > 0 && bb > sb && stackBB >= bb * 10)) { alert('Need SB > 0, BB > SB, stack ≥ 10 BB.'); return; }
    const seats = [{ name: 'You', archetype: null, isHero: true }];
    $$('#seatCfg select').forEach((sel, i) =>
      seats.push({ name: PT.opponents.AI_NAMES[i], archetype: sel.value }));
    startSession({ seats, stackBB, sb, bb });
    $('#setupDialog').close();
  });

  let sessionLabel = '';

  function startSession(cfg) {
    PT.coach.clearCache();
    engine = new PT.HoldemEngine(cfg);
    stats = new PT.SessionStats();
    heroId = cfg.seats.findIndex(s => s.isHero);
    sessionLabel = `${cfg.seats.length}-max · ${cfg.sb}/${cfg.bb} BB · ${cfg.stackBB} BB stacks`;
    engine.on('log', renderLog);
    engine.on('hand', () => { newHandFlags(); renderAll(); });
    engine.on('turn', onTurn);
    engine.on('street', s => { announceStreet(s); renderAll(); });
    engine.on('done', onDone);
    sessionLabel = sessionLabel || `${cfg.seats.length}-max`;
    $('#sessionInfo').textContent = sessionLabel;
    $('#verdicts').innerHTML = '<span class="muted placeholder">New session. Good decisions &gt; good results.</span>';
    engine.newHand();
    renderStats(); renderHands();
  }

  function newHandFlags() {
    heroFlags = { voluntaryPreflop: null, raisedPreflop: false, faced3bet: false, pfa: false, facingBet: false, cbetOpportunity: false, cbetChecked: false };
    lastVerdict = null;
    handDecisions = [];
    stats.hands++;
    stats.vpipD++; stats.pfrD++;
  }

  /* ---------------- game flow ---------------- */

  function onTurn(seat) {
    renderAll();
    if (seat === -1 || engine.over) return;
    const p = engine.players[seat];
    if (p.isHero) { promptHero(); return; }
    $('#decisionBar').hidden = true;
    $('#sessionInfo').textContent = `${p.name} thinking…`;
    setTimeout(() => {
      if (engine.over) return;
      trackHeroFacingBet(seat);
      const local = () => PT.opponents.decide(engine, seat, stats);

      // AI opponents decide every action; the built-in AI is only the timeout/failure fallback.
      let decide;
      if (PT.llm.opponentsEnabled) {
        markThinking(seat, true);
        const timeout = new Promise(res => setTimeout(() => res({ __timeout: true }), PT.llm.oppTimeoutMs));
        decide = Promise.race([
          PT.llm.decideForOpponent(engine, seat).catch(() => null),
          timeout
        ]).then(d => {
          markThinking(seat, false);
          syncLlmStatus();
          return (d && !d.__timeout) ? d : local();
        });
      } else {
        decide = Promise.resolve(local());
      }
      decide.then(d => {
        if (engine.over) return;
        if (!engine.act(seat, d.action, d.betTo).ok) {
          const L = engine.legal(seat);
          engine.act(seat, L.canCheck ? 'check' : 'fold');
        }
        if (engine.current === heroId && !engine.over) $('#sessionInfo').textContent = 'YOUR TURN';
      });
    }, 450 + Math.random() * 400);
  }

  function markThinking(seat, on) {
    const seatEls = $$('#seats .seat');
    const el = seatEls[seat];
    if (!el) return;
    const act = el.querySelector('.act');
    if (act) act.textContent = on ? 'thinking…' : act.textContent.replace('thinking…', '');
  }

  function promptHero() {
    flushNote();
    $('#sessionInfo').textContent = 'YOUR TURN — ' + sessionLabel;
    const L = engine.legal(heroId);
    const p = engine.players[heroId];
    const bar = $('#decisionBar');
    bar.hidden = false;
    $('#sizeCtl').hidden = true; pendingSizeAction = null;
    guessRevealed = false; lastGuess = null;   // new decision → guess-first resets
    const pos = engine.positionName(heroId);
    $('#decisionPrompt').textContent = L.toCall > 0
      ? `${pos} — ${L.toCall.toFixed(1)} BB to call (pot ${L.pot.toFixed(1)}).`
      : `${pos} — action on you (pot ${L.pot.toFixed(1)}).`;

    const btns = $('#actionBtns');
    btns.innerHTML = '';
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.textContent = label; b.className = cls || ''; b.onclick = fn; btns.appendChild(b); };
    if (L.canFold) mk('Fold', '', () => heroAct('fold'));
    if (L.canCheck) mk('Check', '', () => heroAct('check'));
    if (L.canCall) mk(`Call ${L.toCall.toFixed(1)}`, 'primary', () => heroAct('call'));
    if (L.canBetRaise) mk(L.toCall > 0 ? 'Raise…' : 'Bet…', '', () => openSizeCtl(L.toCall > 0 ? 'raise' : 'bet', L));
    renderMath(L);
  }

  function openSizeCtl(action, L) {
    pendingSizeAction = action;
    $('#sizeCtl').hidden = false;
    const qs = $('#quickSizes');
    qs.innerHTML = '';
    for (const f of [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25]) {
      const b = document.createElement('button');
      const to = Math.min(engine.currentBet + f * L.pot + (L.toCall || 0), L.maxBetTo);
      b.textContent = `${Math.round(f * 100)}%`;
      b.title = `${to.toFixed(1)} BB (${Math.round(f * 100)}% pot)`;
      b.onclick = () => heroAct(action, Math.max(to, L.minBetTo));
      qs.appendChild(b);
    }
    const allin = document.createElement('button');
    allin.textContent = 'All-in';
    allin.onclick = () => heroAct(action, L.maxBetTo);
    qs.appendChild(allin);
    $('#confirmSize').onclick = () => {
      const v = +$('#customSize').value;
      if (!(v > 0)) return;
      heroAct(action, Math.min(Math.max(v, L.minBetTo), L.maxBetTo));
    };
  }

  // HERO COMMITS → grade → teach → continue. Never advise before this point (unless Training-mode tutor is asked).
  function heroAct(action, betTo) {
    const viewBefore = engine.coachView();          // snapshot: info available at decision time
    trackHeroPreflop(action);
    trackHeroPostflop(action);
    const res = engine.act(heroId, action, betTo);
    if (!res.ok) { alert(res.error); return; }
    const verdict = PT.coach.grade(viewBefore, heroId, action, betTo, $('#depth').value);
    verdict._ev = verdict.ev;
    lastVerdict = verdict;
    handDecisions.push(decisionLine(verdict, viewBefore));
    const aiNote = PT.llm.enabled && $('#depth').value !== 'None';
    stats.recordDecision(verdict, engine.handNo, viewBefore.street);
    showVerdict(verdict, viewBefore, aiNote);
    renderStats();
    // AI coach note: on a shared local server it waits for the hero's next turn (or hand end) so it
    // never delays opponents; otherwise it is sent right away.
    if (aiNote) {
      const seq = ++decisionSeq;
      pendingNote = () => PT.llm.explainDecision(buildCoachCtx(viewBefore, verdict, action, betTo), () => decisionSeq - seq > 2)
        .then(txt => setCardText(verdict, txt, txt ? '' : PT.llm.lastNoteProblem || 'no answer'))
        .catch(err => setCardText(verdict, null, err.message));
      if (!PT.llm.coachSharesQueue) flushNote();
    }
  }

  let pendingNote = null, decisionSeq = 0;
  function flushNote() {
    const run = pendingNote;
    pendingNote = null;
    if (run) run();
  }

  // Everything in this object is derived from coachView + local range math —
  // zero villain hole cards. This is the ONLY object the coach LLM ever sees.
  function buildCoachCtx(view, verdict, action, betTo) {
    const hero = view.players[heroId];
    const ev = verdict._ev;
    return {
      spot: `${view.street}, board ${view.board.map(c => c.id).join(' ') || 'preflop'}, pot ${view.pot.toFixed(1)} BB, hero holds ${hero.hole.map(c => c.id).join(' ')}, position ${engine.positionName(heroId)}`,
      action: `${action}${betTo ? ' to ' + betTo + ' BB' : ''}`,
      verdict: `${verdict.label} (local engine: est. EV loss ${verdict.evLoss.toFixed(1)} BB vs best line ${verdict.best.action}${verdict.best.amount ? ' ' + verdict.best.amount.toFixed(1) : ''})`,
      numbers: verdict.lines.join(' | ') || 'none',
      handRank: hero.hole && view.board.length >= 3
        ? `${PT.eval.HAND_NAMES[PT.eval.bestHand([...hero.hole, ...view.board])[0]]} — hand class: ${PT.spot.handClass(hero.hole, view.board)}`
        : 'preflop hand',
      ranges: view.players.filter(p => !p.isHero && !p.folded).map(p => `${p.name}=${PT.opponents.ARCHETYPES[p.archetype].label}`).join(', ') || 'none live',
      evTable: ev ? ev.actions.map(a => `${a.action}${a.amount ? ' ' + a.amount.toFixed(1) : ''}=${a.ev.toFixed(1)}BB` + (a.formula ? ` [${a.formula}]` : '')).join('; ') : 'n/a',
      chosenAction: verdict.chosen.action,
      bestAction: verdict.best.action,
      chosenIsBest: verdict.best === verdict.chosen || verdict.best.ev - verdict.chosen.ev < 0.05,
      ranking: `best action ${verdict.best.action} (EV ${verdict.best.ev.toFixed(1)} BB); student's action ${verdict.chosen.action} (EV ${verdict.chosen.ev.toFixed(1)} BB)`,
      fallbackText: verdict.plain
    };
  }

  // The AI coach's text replaces the "writing…" placeholder; the engine's text is only a fallback.
  function setCardText(verdict, text, problem) {
    const card = verdict._el;
    const box = card && card.isConnected && card.querySelector('.plain.pending');
    if (!box) return;
    box.classList.remove('pending', 'muted');
    if (text) { box.textContent = text; return; }
    box.innerHTML = `${verdict.plain}<div class="muted">[engine text — AI note unavailable: ${String(problem).slice(0, 80).replace(/</g, '&lt;')}]</div>`;
  }

  function onDone(data) {
    flushNote();
    renderAll();
    $('#decisionBar').hidden = true;
    $('#sessionInfo').textContent = `Hand over · ${sessionLabel}`;
    if (data.showdown) {
      stats.showdowns++;
      if (data.winners.includes(heroId)) stats.showdownWins++;
      // calibration: were shown villain hands inside the coach's predicted ranges?
      const cv = engine.coachView();
      const trackers = PT.coach.buildVillainRanges(cv, heroId);
      for (const p of engine.players) {
        if (p.isHero || p.folded || !p.hole.length) continue;
        PT.calibration.recordShowdown(p, trackers[p.id] || null);
      }
    }
    // #6: grade decisions by EV, not the result — say so explicitly.
    const hero = engine.players[heroId];
    const net = data.showdown && data.detail
      ? data.detail.filter(d => d.winners.includes(heroId)).reduce((s, d) => s + d.amount, 0) - hero.totalBet
      : (data.winners.includes(heroId) ? data.pot - hero.totalBet : -hero.totalBet);
    if (lastVerdict) {
      const box = $('#verdicts');
      const d = document.createElement('div');
      d.className = 'verdict result-note';
      d.innerHTML = `<div class="plain muted">Result: ${net >= 0 ? '+' : ''}${net.toFixed(1)} BB this hand. Decision quality is judged by EV with the info you had — not by this result.</div>`;
      box.prepend(d);
    }
    PT.storage.saveHand({
      id: Date.now(), when: new Date().toISOString(), handNo: engine.handNo,
      seats: engine.cfg.seats.map(s => s.name), blinds: `${engine.cfg.sb}/${engine.cfg.bb}`,
      heroHole: engine.players[heroId].hole.map(c => c.id),
      board: engine.board.map(c => c.id),
      log: engine.history.map(h => `[${h.street}] ${youText(h.text)}`),
      verdict: lastVerdict ? `${lastVerdict.label} (−${lastVerdict.evLoss.toFixed(1)} BB)` : 'no hero decision'
    });
    renderHands();
    $('#nextHandBtn').hidden = false;
  }

  $('#nextHandBtn').addEventListener('click', () => {
    $('#nextHandBtn').hidden = true;
    if (engine.players[heroId].stack <= 0) { alert('You are out of chips — start a new session.'); return; }
    engine.newHand();
  });

  /* ---------------- stat tracking hooks ---------------- */

  function trackHeroPreflop(action) {
    if (engine.street !== 'preflop') return;
    if (engine.currentBet > engine.cfg.bb && engine.currentBet >= engine.cfg.bb * 3) {
      if (heroFlags.raisedPreflop && !heroFlags.faced3bet) { heroFlags.faced3bet = true; stats.foldToBetD++; if (action === 'fold') stats.foldToBetN++; }
    }
    if (action === 'call' || action === 'raise' || action === 'bet') {
      if (!heroFlags.voluntaryPreflop) { heroFlags.voluntaryPreflop = true; stats.vpipN++; }
      if (action !== 'call' && !heroFlags.raisedPreflop) { heroFlags.raisedPreflop = true; stats.pfrN++; heroFlags.pfa = true; stats.aggrActs++; }
      if (action === 'call') stats.passiveActs++;
    }
  }

  // Called whenever an AI acts: if it bets/raises into the hero postflop, hero is facing a bet.
  function trackHeroFacingBet(seat) {
    if (engine.street === 'preflop' || engine.over) return;
    const p = engine.players[seat];
    if (p.isHero || p.folded) return;
    if (p.streetBet > 0 && p.streetBet === engine.currentBet) heroFlags.facingBet = true;
  }

  function trackHeroPostflop(action) {
    if (engine.street === 'preflop') return;
    // fold-to-bet: hero responded to a faced bet
    if (heroFlags.facingBet && engine.street !== 'preflop') {
      stats.foldToBetD++;
      if (action === 'fold') stats.foldToBetN++;
      heroFlags.facingBet = false;
    }
    // c-bet: hero was preflop aggressor, flop, no one bet before hero
    if (engine.street === 'flop' && heroFlags.pfa && !heroFlags.cbetChecked) {
      heroFlags.cbetChecked = true;
      const someoneBet = engine.players.some((p, i) => !p.isHero && !p.folded && p.streetBet > 0);
      if (!someoneBet) {
        stats.cbetD++;
        if (action === 'bet') stats.cbetN++;
      }
    }
    if (action === 'bet' || action === 'raise') stats.aggrActs++;
    if (action === 'call') stats.passiveActs++;
  }

  /* ---------------- rendering ---------------- */

  function cardEl(c) {
    const d = document.createElement('span');
    d.className = 'card' + (c.suit === '♥' || c.suit === '♦' ? ' red' : '');
    d.textContent = c.id;
    return d;
  }

  function renderAll() {
    if (!engine) return;
    const v = engine.playerView();
    $('#pot').textContent = v.pot.toFixed(1);
    $('#street').textContent = v.street;
    const board = $('#board'); board.innerHTML = '';
    v.board.forEach(c => board.appendChild(cardEl(c)));

    const seats = $('#seats'); seats.innerHTML = '';
    for (const p of v.players) {
      const d = document.createElement('div');
      d.className = 'seat' + (p.isHero ? ' hero' : '') + (p.id === v.current && !v.over ? ' acting' : '') + (p.folded ? ' folded' : '');
      const pos = engine.positionName(p.id);
      const arch = p.isHero ? 'you' : PT.opponents.ARCHETYPES[p.archetype].label;
      d.innerHTML = `<div class="meta"><span><strong>${p.name}</strong><span class="badge">${pos}</span></span><span>${p.stack.toFixed(1)} BB</span></div>
        <div class="meta"><span class="muted">${arch}</span><span class="muted">${p.streetBet ? 'bet ' + p.streetBet.toFixed(1) : ''}</span></div>
        <div class="cards"></div><div class="act">${p.lastAction || ''}</div>`;
      const cards = d.querySelector('.cards');
      if (p.hole) p.hole.forEach(c => cards.appendChild(cardEl(c)));
      else if (!p.folded) { cards.innerHTML = '<span class="card back">?</span><span class="card back">?</span>'; }
      seats.appendChild(d);
    }
    renderLog();
  }

  // Engine history says "You folds" (other code parses that form); fix grammar only for display.
  const youText = t => t.replace(/^You (fold|check|call|bet|raise|post|show|win)s\b/, 'You $1').replace(/^(You .*) and is all-in/, '$1 and are all-in');

  function renderLog() {
    const el = $('#handLog'); el.innerHTML = '';
    for (const h of engine.history) {
      const d = document.createElement('div');
      d.textContent = `[${h.street}] ${youText(h.text)}`;
      el.appendChild(d);
    }
    el.scrollTop = el.scrollHeight;
    renderSummary();
  }

  /* ---------------- hand summary (copy-paste for an LLM / study notes) ---------------- */

  function renderSummary() {
    if (!engine) return;
    const v = engine.playerView();
    const hero = v.players[heroId];
    const pos = i => engine.positionName(i);
    const L = [];
    L.push(`HAND #${v.handNo} — NLHE cash, blinds ${engine.cfg.sb}/${engine.cfg.bb} BB`);
    L.push(`Street: ${v.street} | Pot: ${v.pot.toFixed(1)} BB`);
    L.push(`Board: ${v.board.map(c => c.id).join(' ') || '(preflop)'}`);
    L.push(`MY HAND: ${hero.hole ? hero.hole.map(c => c.id).join(' ') : '—'} | Position: ${pos(heroId)} | My stack: ${hero.stack.toFixed(1)} BB${hero.streetBet ? ` (${hero.streetBet.toFixed(1)} invested this street)` : ''}`);
    const toCall = Math.max(0, v.currentBet - hero.streetBet);
    L.push(toCall > 0 ? `Facing: ${toCall.toFixed(1)} BB to call` : 'Facing: no bet (can check)');
    L.push('');
    L.push('PLAYERS (position, style, stack, status):');
    for (const p of v.players) {
      if (p.isHero) continue;
      const style = PT.opponents.ARCHETYPES[p.archetype].label;
      const status = p.folded ? 'folded' : p.allIn ? 'ALL-IN' : `${p.stack.toFixed(1)} BB`;
      L.push(`  ${p.name} — ${pos(p.id)} — ${style} — ${status}${p.streetBet && !p.folded ? ` — bet ${p.streetBet.toFixed(1)} this street` : ''}`);
    }
    L.push('');
    L.push('ACTION SO FAR:');
    let cur = '';
    for (const h of v.history) {
      if (h.street !== cur) { cur = h.street; L.push(` ${cur.toUpperCase()}:`); }
      if (!/posts (small|big) blind|Hand #/.test(h.text)) L.push(`   ${youText(h.text)}`);
    }
    if (v.over) L.push('RESULT: hand complete.');
    else L.push(`ACTION ON: ${v.current === heroId ? 'ME' : (v.players[v.current] ? v.players[v.current].name : '—')}`);
    $('#summaryText').textContent = L.join('\n');
  }

  $('#copySummary').addEventListener('click', () => {
    navigator.clipboard.writeText($('#summaryText').textContent)
      .then(() => { $('#copySummary').textContent = 'Copied ✓'; setTimeout(() => $('#copySummary').textContent = 'Copy summary', 1200); })
      .catch(() => { $('#summaryText').focus(); document.execCommand('selectAll'); });
  });

  function showVerdict(v, view, aiNote) {
    const box = $('#verdicts');
    if (box.querySelector('.placeholder')) box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'verdict ' + v.grade;
    const detailHtml = v.lines.length
      ? `<details><summary>Numbers & ranges</summary>${v.lines.map(l => `<div>${l}</div>`).join('')}</details>`
      : '';
    const body = aiNote ? '<div class="plain pending muted">AI coach is writing…</div>' : `<div class="plain">${v.plain}</div>`;
    d.innerHTML = `<h4>${v.label} · ${view.street}</h4>${body}${detailHtml}`;
    box.prepend(d);
    v._el = d;
  }

  let guessScores = [];  // running accuracy for guess-first mode

  function renderMath(L) {
    if ($('#depth').value === 'None') { $('#mathPanel').innerHTML = '<span class="muted">Depth: None.</span>'; return; }
    const view = engine.coachView();
    const hero = view.players[heroId];
    const ev = PT.coach.evaluateActions(view, heroId);
    const spot = PT.spot.analyze(view, heroId, ev);
    const pct = x => (x * 100).toFixed(1) + '%';
    const beginner = $('#depth').value === 'Essential';

    // --- spot guidance first: WHICH number decides this spot ---
    let html = `<div class="spot-guide">
      <div class="spot-title">${spot.guidance.title}</div>
      <div>${spot.guidance.metric}</div>
      ${spot.guidance.verdict && !(guessMode && !guessRevealed) ? `<div>${spot.guidance.verdict}</div>` : ''}
      <div class="muted teach">${spot.guidance.teach}</div>
    </div>`;

    // --- guess-first mode (#8): hide ALL numbers until the user guesses ---
    if (guessMode && !guessRevealed) {
      html += `<div class="guess-box"><strong>Guess first:</strong> your equity vs the players you must beat.
        <input id="guessInput" type="number" min="0" max="100" step="1" style="width:4em" /> %
        <button id="guessBtn">Reveal</button>
        ${guessScores.length ? `<div class="muted">Avg error so far: ${(guessScores.reduce((a,b)=>a+b,0)/guessScores.length).toFixed(1)} pts over ${guessScores.length} guesses</div>` : ''}</div>`;
      $('#mathPanel').innerHTML = html;
      $('#guessBtn').onclick = () => {
        lastGuess = +$('#guessInput').value;
        if (isNaN(lastGuess)) return;
        guessRevealed = true;
        renderMath(L);
      };
      return;
    }

    // --- labeled equity views (P2) + confidence (P12) ---
    html += '<table><tr><th>Equity view</th><th></th></tr>';
    for (const v of spot.views) {
      const ci = v.key === 'headline' && spot.se ? ` ±${(spot.se * 100).toFixed(1)}` : '';
      html += `<tr><td>${v.label}</td><td>${v.eq != null ? pct(v.eq) + ci : '—'}</td></tr>
        <tr><td colspan="2" class="muted" style="font-size:.8em">${v.note}</td></tr>`;
    }
    html += '</table>';

    // --- realization line (#2) ---
    if (spot.realization && Math.abs(spot.realization.factor - 1) > 0.03)
      html += `<div class="muted">Raw ${pct(spot.raw)} → realized ~${pct(spot.realized)} (${spot.realization.reason}).</div>`;

    // --- explainable breakdown (P3) ---
    if (spot.raw != null && Object.keys(ev.trackers).length && !beginner) {
      const bd = PT.spot.equityBreakdown(hero.hole, view.board, ev.trackers);
      if (bd) {
        html += '<details class="eq-breakdown"><summary>Where does that number come from?</summary><table>' +
          bd.buckets.map(b => `<tr><td>${b.label}</td><td>${pct(b.share)} of range</td><td>you win ${pct(b.eq)}</td></tr>`).join('') +
          `</table><div class="muted">${bd.formula} ≈ ${pct(bd.total)}</div></details>`;
      }
      // multiway shortcut (P3)
      if (spot.inPotIds && spot.inPotIds.length >= 2) {
        const sc = PT.spot.multiwayShortcut(hero.hole, view.board, ev.trackers, spot.inPotIds);
        if (sc != null) html += `<div class="muted" style="font-size:.82em">Mental shortcut for multiway made hands: multiply your heads-up equities ≈ ${pct(sc)} (less accurate for draws).</div>`;
      }
    }

    if (guessMode && guessRevealed && lastGuess != null && spot.raw != null) {
      const diff = Math.abs(lastGuess - spot.raw * 100);
      guessScores.push(diff);
      html += `<div class="guess-result">Your guess: ${lastGuess}% · actual ~${pct(spot.raw)} → ${diff < 8 ? '✓ good estimate' : 'off by ' + diff.toFixed(0) + ' pts'}</div>`;
    }

    // --- core numbers; MDF/SPR hidden in beginner mode (#8) ---
    html += `<table>
      <tr><td>Pot</td><td>${L.pot.toFixed(1)} BB</td></tr>
      ${L.toCall > 0 ? `<tr><td>To call</td><td>${L.toCall.toFixed(1)} BB</td></tr>
      <tr><td>Required equity</td><td>${pct(PT.math.potOdds(L.toCall, L.pot))}</td></tr>` : ''}
    </table>`;
    if (beginner && L.toCall > 0) {
      html += `<details class="eq-breakdown"><summary>More info (MDF, SPR)</summary>
        <div class="muted">MDF ${pct(PT.math.mdf(L.pot, L.toCall))} — how often your whole range must continue vs this bet size so bluffs can't auto-profit.</div>
        <div class="muted">SPR ${L.pot > 0 ? (Math.min(...view.players.filter(p=>!p.folded).map(p=>p.stack+p.streetBet)) / L.pot).toFixed(1) : '—'} — stack ÷ pot; low = commit with one pair, high = need more.</div></details>`;
    } else if (!beginner) {
      html += `<table>${L.toCall > 0 ? `<tr><td>MDF</td><td>${pct(PT.math.mdf(L.pot, L.toCall))}</td></tr>` : ''}
        <tr><td>SPR</td><td>${L.pot > 0 ? (Math.min(...view.players.filter(p=>!p.folded).map(p=>p.stack+p.streetBet)) / L.pot).toFixed(1) : '—'}</td></tr></table>`;
    }
    if (!beginner) {
      html += '<table><tr><th>Action</th><th>EV (BB)</th></tr>' +
        ev.actions.map(a => `<tr><td>${a.action}${a.amount ? ' ' + a.amount.toFixed(1) : ''}</td><td>${a.ev.toFixed(1)}</td></tr>`).join('') + '</table>';
    }
    $('#mathPanel').innerHTML = html;
  }

  /* ---------------- tabs / tutor / stats / hands ---------------- */

  $$('#tabs button').forEach(b => b.addEventListener('click', () => {
    $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  }));

  const chatHistory = [];

  const actText = a => a.action + (a.amount == null ? '' : a.action === 'call' ? ` ${a.amount.toFixed(1)} BB` : ` to ${a.amount.toFixed(1)} BB`);

  function decisionLine(v, view) {
    const board = view.board.map(c => c.id).join(' ');
    const isBest = v.best === v.chosen || v.best.ev - v.chosen.ev < 0.05;
    return `${view.street}${board ? ` (board ${board})` : ''}, pot ${view.pot.toFixed(1)} BB: you chose ${actText(v.chosen)} (EV ${v.chosen.ev.toFixed(1)} BB), graded ${v.label}` +
      (isBest ? ', the best option.' : `; best was ${actText(v.best)} (EV ${v.best.ev.toFixed(1)} BB).`);
  }

  function decisionHistory() {
    if (!handDecisions.length) return '';
    const hole = engine.players[heroId].hole.map(c => c.id).join(' ');
    return `Your decisions this hand with ${hole}, graded when you made them:\n` + handDecisions.map((d, i) => `${i + 1}. ${d}`).join('\n');
  }

  // After the hand: review its decisions. During it: earlier decisions plus the live spot.
  function tutorContext(locked, history) {
    if (engine.over) {
      const result = engine.history.filter(h => / (wins|shows) /.test(h.text)).map(h => youText(h.text)).join(' ');
      return { text: `The hand is over. ${result}\nResults don't change grades; only the decisions do.\n${history || 'The student made no decisions this hand.'}`, best: null, bestAction: null };
    }
    const facts = PT.coach.tutorFacts(engine.coachView(), heroId, locked);
    if (history) facts.text = `${history}\n\nCurrent spot:\n${facts.text}`;
    return facts;
  }

  $('#chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#chatInput').value.trim();
    if (!q || !engine) return;
    $('#chatInput').value = '';
    const chat = $('#chat');
    chat.insertAdjacentHTML('beforeend', `<div class="q">You: ${q.replace(/</g, '&lt;')}</div>`);
    chat.scrollTop = chat.scrollHeight;

    const locked = $('#coachMode').value === 'test' && engine.current === heroId && !engine.over;
    const history = decisionHistory();
    const localAnswer = () => {
      if (engine.over) return history || 'You made no decisions this hand.';
      const reply = PT.coach.tutorReply(q, engine.coachView(), heroId, locked);
      return history && /my play|pre.?flop|flop|turn|earlier|this hand|so far/i.test(q) ? `${history}\n\n${reply}` : reply;
    };

    if (PT.llm.enabled) {
      const thinking = document.createElement('div');
      thinking.className = 'a muted';
      thinking.textContent = `${PT.llm.providerLabel} thinking…`;
      chat.appendChild(thinking);
      PT.llm.tutorChat(q, tutorContext(locked, history), locked, chatHistory)
        .then(txt => {
          thinking.remove();
          syncLlmStatus();
          chatHistory.push({ role: 'user', text: q }, { role: 'assistant', text: txt });
          chat.insertAdjacentHTML('beforeend', `<div class="a">${txt.replace(/</g, '&lt;')}</div>`);
        })
        .catch(err => {
          thinking.remove();
          syncLlmStatus();
          chat.insertAdjacentHTML('beforeend',
            `<div class="a"><span class="muted">[${String(err.message).slice(0, 90).replace(/</g, '&lt;')} — engine answer]</span><br>${localAnswer().replace(/</g, '&lt;')}</div>`);
        })
        .finally(() => chat.scrollTop = chat.scrollHeight);
    } else {
      chat.insertAdjacentHTML('beforeend', `<div class="a">${localAnswer().replace(/</g, '&lt;')}</div>`);
      chat.scrollTop = chat.scrollHeight;
    }
  });

  function renderStats() {
    const f = x => (x * 100).toFixed(0) + '%';
    $('#statsPanel').innerHTML = `<table>
      <tr><th>Metric</th><th>You</th></tr>
      <tr><td>Hands</td><td>${stats.hands}</td></tr>
      <tr><td>VPIP</td><td>${f(stats.vpip())}</td></tr>
      <tr><td>PFR</td><td>${f(stats.pfr())}</td></tr>
      <tr><td>Fold to bet (postflop)</td><td>${f(stats.foldToBet())}</td></tr>
      <tr><td>C-bet (flop)</td><td>${stats.cbetD ? f(stats.cbet()) : '—'}</td></tr>
      <tr><td>Aggression factor</td><td>${stats.aggFactor().toFixed(1)}</td></tr>
      <tr><td>Showdowns won</td><td>${stats.showdowns ? f(stats.showdownWins / stats.showdowns) : '—'}</td></tr>
      <tr><td>EV lost to mistakes</td><td>${stats.evLost.toFixed(1)} BB</td></tr>
    </table>`;
  }

  $('#reportBtn').addEventListener('click', () => {
    const r = stats.report();
    $('#reportOut').innerHTML = `<h4>Skill report</h4><p>${r.headline}</p>
      <p>Grades: ${Object.entries(r.gradeCounts).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none yet'}</p>
      <p><strong>Practice next:</strong></p><ul>${r.weaknesses.map(w => `<li>${w}</li>`).join('')}</ul>`;
  });

  function renderHands() {
    const list = $('#handsList');
    list.innerHTML = '';
    for (const h of PT.storage.listHands()) {
      const d = document.createElement('div');
      d.className = 'handItem';
      d.innerHTML = `<strong>#${h.handNo}</strong> ${h.heroHole.join(' ')} → board ${h.board.join(' ') || '—'}<br>
        <span class="muted">${new Date(h.when).toLocaleTimeString()} · ${h.verdict}</span>`;
      d.onclick = () => {
        $('#replayBody').innerHTML =
          `<p><strong>Hole:</strong> ${h.heroHole.join(' ')} · <strong>Board:</strong> ${h.board.join(' ') || '—'} · <strong>Blinds:</strong> ${h.blinds}</p>` +
          h.log.map(l => `<div>${l}</div>`).join('');
        $('#replayDialog').showModal();
      };
      list.appendChild(d);
    }
  }

  $('#clearHands').addEventListener('click', () => {
    if (confirm('Clear all saved hands?')) { PT.storage.clear(); renderHands(); }
  });

  $('#cancelBtn').addEventListener('click', () => $('#setupDialog').close());

  // Tutor gets a context note whenever the street changes so answers stay current.
  function announceStreet(street) {
    if (!engine) return;
    const board = engine.board.map(c => c.id).join(' ');
    const chat = $('#chat');
    chat.insertAdjacentHTML('beforeend',
      `<div class="ctx muted">— ${street.toUpperCase()}${board ? ': ' + board : ''} · pot ${engine.pot().toFixed(1)} BB —</div>`);
    chat.scrollTop = chat.scrollHeight;
  }

  function fillProviderSelect(sel, prefix) {
    sel.innerHTML = PT.llm.providers.map(p => `<option value="${p.id}">${prefix}${p.label}</option>`).join('') +
      `<option value="off">${prefix}offline</option>`;
  }
  fillProviderSelect($('#llmProvider'), 'Analysis: ');
  fillProviderSelect($('#oppProvider'), 'Opponents: ');

  function syncLlmStatus() {
    const { coach, opp } = PT.llm.errors;
    $('#llmProvider').value = PT.llm.provider;
    $('#oppProvider').value = PT.llm.oppProvider;
    const setup = PT.llm.setupProblem;
    const err = coach ? `analysis: ${coach}` : opp ? `opponents: ${opp}` : '';
    const anyAi = PT.llm.enabled || PT.llm.opponentsEnabled;
    const text = setup ? `${setup} in AI settings`
      : err ? `AI error, ${err} (using built-in)` : anyAi ? 'AI on' : 'offline';
    $('#llmStatus').textContent = text;
    $('#llmStatus').style.color = err || setup ? '#d08770' : anyAi ? '#7bc47f' : '';
  }

  // AI settings dialog: base URL, model and key for one provider at a time.
  $('#aiProvider').innerHTML = PT.llm.providers.map(p => `<option value="${p.id}">${p.label}</option>`).join('');
  function openAiSettings(id) {
    const s = PT.llm.providerSettings(id);
    $('#aiProvider').value = id;
    $('#aiUrl').value = s.url;
    $('#aiUrl').placeholder = s.defaultUrl || 'https://…/v1';
    $('#aiModel').value = s.model;
    $('#aiModel').placeholder = s.hint;
    $('#aiKey').value = s.key;
    $('#aiKey').placeholder = s.needsKey ? 'required' : 'optional for local servers';
    $('#aiTestResult').textContent = '';
    $('#aiTestResult').className = 'muted';
    if (!$('#aiDialog').open) $('#aiDialog').showModal();
    refreshModels();
  }

  // Suggest the models the provider actually offers, and flag a typed name it doesn't.
  let modelReq = 0, offeredModels = [];
  function modelHint() {
    const id = $('#aiProvider').value, current = $('#aiModel').value.trim();
    const needsKey = PT.llm.providerSettings(id).needsKey && !$('#aiKey').value.trim();
    $('#aiModelHint').textContent = !offeredModels.length ? (needsKey ? 'Add your API key to see the available models.' : '')
      : current && !offeredModels.includes(current) ? `"${current}" isn't offered by this provider. Click the Model box to pick one of ${offeredModels.length}.`
      : `${offeredModels.length} models available. Click the Model box to choose.`;
  }
  async function refreshModels() {
    const req = ++modelReq;
    offeredModels = [];
    $('#aiModelHint').textContent = 'Looking up available models…';
    const models = await PT.llm.listModels($('#aiProvider').value, { url: $('#aiUrl').value, key: $('#aiKey').value });
    if (req !== modelReq) return;
    offeredModels = models;
    $('#aiModelList').replaceChildren(...models.map(m => Object.assign(document.createElement('option'), { value: m })));
    modelHint();
  }
  $('#aiKey').addEventListener('change', refreshModels);
  $('#aiUrl').addEventListener('change', refreshModels);
  $('#aiModel').addEventListener('input', modelHint);
  function saveAiSettings() {
    PT.llm.configure($('#aiProvider').value, { url: $('#aiUrl').value, model: $('#aiModel').value, key: $('#aiKey').value });
    syncLlmStatus();
  }
  $('#aiSettingsBtn').addEventListener('click', () =>
    openAiSettings([PT.llm.provider, PT.llm.oppProvider].find(p => p !== 'off') || PT.llm.providers[0].id));
  $('#aiProvider').addEventListener('change', e => openAiSettings(e.target.value));
  $('#aiSaveBtn').addEventListener('click', () => { saveAiSettings(); $('#aiDialog').close(); });
  $('#aiCloseBtn').addEventListener('click', () => $('#aiDialog').close());
  $('#aiTestBtn').addEventListener('click', async () => {
    saveAiSettings();
    const out = $('#aiTestResult');
    out.className = 'muted';
    out.textContent = 'testing…';
    try {
      const r = await PT.llm.testProvider($('#aiProvider').value);
      out.className = 'ok';
      out.textContent = `Connected: replied in ${(r.ms / 1000).toFixed(1)} s`;
    } catch (err) {
      out.className = 'bad';
      out.textContent = err.name === 'AbortError' ? 'Timed out.'
        : err.name === 'TypeError' ? "Can't reach it: check the URL, that the server is running, and that it allows browser (CORS) requests."
        : / 404: .*model/i.test(err.message) && offeredModels.length ? `This provider has no model called "${$('#aiModel').value.trim()}". Pick one from the Model list.`
        : String(err.message).slice(0, 160);
    }
    syncLlmStatus();
  });

  function chooseProvider(set, id) {
    set(id);
    syncLlmStatus();
    if (id !== 'off' && PT.llm.setupProblem) openAiSettings(id);
  }
  $('#llmProvider').addEventListener('change', e => chooseProvider(PT.llm.setProvider, e.target.value));
  $('#oppProvider').addEventListener('change', e => chooseProvider(PT.llm.setOppProvider, e.target.value));
  syncLlmStatus();

  $('#guessMode').checked = guessMode;
  $('#guessMode').addEventListener('change', e => {
    guessMode = e.target.checked;
    localStorage.setItem('riverwise.guessMode', guessMode ? '1' : '0');
    guessRevealed = false; lastGuess = null;
  });

  // Boot: open setup.
  buildSeatCfg(+$('#playerCount').value);
  $('#setupDialog').showModal();
})(window.PT = window.PT || {});
