/* coach.js — decision grading + tutor.
 * INFORMATION ISOLATION: everything consumes engine.coachView() only —
 * hero cards, board, pot, stacks, action history, archetype labels.
 * Villain hole cards are structurally unavailable.
 *
 * Grading is RANGE-BASED: each opponent carries a weighted range that starts
 * from their archetype prior and narrows after every observed action.
 * Your equity/EV is estimated against THOSE ranges — not "any two cards" —
 * so verdicts stop being uniformly "Excellent".
 *
 * LLM seam: replace explainVerdict/tutorReply bodies with an API call
 * passing the same coachView-derived context. Nothing else changes.
 */
(function (PT) {
  const GRADES = [
    { key: 'excellent', label: 'Excellent', maxLoss: 0.2 },
    { key: 'good', label: 'Good', maxLoss: 0.8 },
    { key: 'marginal', label: 'Inaccuracy', maxLoss: 2 },
    { key: 'mistake', label: 'Mistake', maxLoss: 4.5 },
    { key: 'blunder', label: 'Major mistake / blunder', maxLoss: Infinity }
  ];
  const pct = x => x == null ? '—' : (x * 100).toFixed(0) + '%';
  const bb = x => (Math.round(x * 10) / 10).toString();

  /* ---------- range tracking per villain, rebuilt from action history ---------- */

  function buildVillainRanges(view, heroId) {
    const trackers = {};
    for (const p of view.players) {
      if (p.isHero || p.folded) continue;
      trackers[p.id] = new PT.ranges.RangeTracker(p.archetype, PT.ranges.positionClass(view, p.id));
    }
    return PT.ranges.replay(view, trackers);
  }

  // Equity of hero vs ALL live villains (each sampled from its own tracked range).
  // On the river this is exact-vs-range (no more cards to come).
  function equityVsField(heroHole, board, trackers, iters) {
    iters = iters || 700;
    const ids = Object.keys(trackers);
    if (!ids.length) return 1;
    let win = 0, tie = 0, tot = 0;
    const used0 = new Set([...heroHole, ...board].map(c => c.id));
    for (let it = 0; it < iters; it++) {
      const used = new Set(used0);
      const vhs = [];
      let ok = true;
      for (const id of ids) {
        const h = trackers[id].sample(used, Math.random);
        if (!h) { ok = false; break; }
        used.add(h[0].id); used.add(h[1].id);
        vhs.push(h);
      }
      if (!ok) continue;
      let runout = board;
      if (board.length < 5) {
        const remaining = PT.math.fullDeckMinus([...heroHole, ...board, ...vhs.flat()]);
        runout = board.slice();
        while (runout.length < 5) runout.push(remaining[Math.floor(Math.random() * remaining.length)]);
      }
      const hb = PT.eval.bestHand([...heroHole, ...runout]);
      let res = 1;
      for (const vh of vhs) {
        const cmp = PT.eval.compareRank(hb, PT.eval.bestHand([...vh, ...runout]));
        if (cmp < 0) { res = 0; break; }
        if (cmp === 0) res = Math.min(res, 0.5);
      }
      tot++;
      if (res === 1) win++; else if (res === 0.5) tie++;
    }
    return tot ? (win + tie / 2) / tot : null;
  }

  /* ---------- EV of each legal action vs tracked ranges ---------- */

  // Copy of a tracker keeping only combos for which `rule(key)` says they continue.
  function continuingTracker(tracker, rule, board) {
    const t = Object.create(Object.getPrototypeOf(tracker));
    t.range = {};
    t.archetype = tracker.archetype;
    const prof = PT.opponents.ARCHETYPES[tracker.archetype];
    for (const k of Object.keys(tracker.range)) {
      const w = tracker.range[k];
      t.range[k] = w <= 0 ? 0 : rule(k) ? w : w * (board.length >= 3 ? 0.05 + prof.loose * 0.1 : 0.03);
    }
    return t;
  }

  // Returns key => true if villain v continues (calls or re-raises) vs a raise of frac × pot.
  function continueRule(view, v, frac, tracker) {
    const prof = PT.opponents.ARCHETYPES[v.archetype];
    if (view.board.length >= 3) {
      const thr = Math.min(0.9, 0.5 + frac * 0.25 - prof.loose * 0.35);
      return k => board2cls(view.board, k) >= thr;
    }
    const pre = view.history.filter(h => h.street === 'preflop');
    const raises = pre.filter(h => / raises to /.test(h.text)).length;
    const lastOwn = pre.map(h => h.text.startsWith(v.name + ' ') && / (raises to|calls) /.test(h.text)).lastIndexOf(true);
    const sizeAdj = Math.max(0.5, 1.2 - 0.25 * Math.min(frac, 2));
    let cutoff;
    if (lastOwn >= 0 && tracker) {
      // Already invested: continue with the top share of THEIR OWN range (a 3-bettor's range is
      // already narrow, so an absolute cutoff would wrongly say they never fold), less per extra raise.
      const raisedOwn = / raises to /.test(pre[lastOwn].text);
      const limped = !raisedOwn && !pre.slice(0, lastOwn).some(h => / raises to /.test(h.text));
      const raisesSince = pre.slice(lastOwn + 1).filter(h => / raises to /.test(h.text)).length;
      const base = raisedOwn ? (0.38 + prof.loose * 0.3) * (PT.ranges.positionClass(view, v.id) === 'early' ? 1.25 : 1)
        : limped ? 0.45 + prof.loose * 0.35 : 0.25 + prof.loose * 0.35;
      const share = base * sizeAdj * Math.pow(0.5, raisesSince);
      cutoff = topShareCutoff(tracker, Math.min(0.9, share));
    } else {
      let pct;
      if (v.id === view.bbSeat) pct = 0.04 + prof.loose * 0.35;
      else if (v.id === view.sbSeat) pct = 0.03 + prof.loose * 0.2;
      else pct = 0.03 + prof.agg * 0.03 + prof.loose * 0.12;
      cutoff = pct * Math.pow(0.4, raises) * sizeAdj;   // each earlier raise tightens cold players
    }
    const rule = k => PT.ranges.PREFLOP_PCTL[k] < cutoff;
    // Strongest ~third of the continuing range re-raises instead of calling.
    rule.reraises = k => PT.ranges.PREFLOP_PCTL[k] < cutoff * 0.35;
    return rule;
  }

  // Percentile cutoff below which `share` of the tracked range's combos lie.
  function topShareCutoff(t, share) {
    const keys = Object.keys(t.range).filter(k => t.range[k] > 0).sort((a, b) => PT.ranges.PREFLOP_PCTL[a] - PT.ranges.PREFLOP_PCTL[b]);
    const w = k => t.range[k] * comboCount(k);
    const tot = keys.reduce((s, k) => s + w(k), 0);
    let acc = 0;
    for (const k of keys) {
      acc += w(k);
      if (acc >= share * tot) return PT.ranges.PREFLOP_PCTL[k] + 1e-9;
    }
    return 1;
  }

  // One evaluation per decision point, so the Math tab, tutor and grade all see the same numbers.
  const EVAL_CACHE = new Map();
  function decisionKey(view, heroId) {
    const h = view.players[heroId];
    return [view.handNo, heroId, (h.hole || []).map(c => c.id).join(''), view.board.map(c => c.id).join(''),
      view.players.map(p => `${p.name}:${p.archetype}:${p.stack}:${p.streetBet}:${p.folded ? 'f' : ''}`).join(','),
      view.history.map(x => x.text).join('|')].join('#');
  }

  function evaluateActions(view, heroId, exactBetTo) {
    const key = decisionKey(view, heroId);
    let base = EVAL_CACHE.get(key);
    if (!base) {
      base = computeEvaluation(view, heroId);
      EVAL_CACHE.set(key, base);
      if (EVAL_CACHE.size > 30) EVAL_CACHE.delete(EVAL_CACHE.keys().next().value);
    }
    const priced = a => (a.action === 'bet' || a.action === 'raise') && Math.abs(a.amount - exactBetTo) < 0.05;
    if (!exactBetTo || base.actions.some(priced)) return base;
    const hero = view.players[heroId];
    const a = priceBet(view, hero, base.villains, base.trackers, Math.min(exactBetTo, hero.streetBet + hero.stack), base.toCall, base.pot, base.realization.factor, base.seed);
    if (!a) return base;
    const actions = [...base.actions, a];
    return { ...base, actions, best: actions.reduce((x, y) => (y.ev > x.ev ? y : x)) };
  }

  function computeEvaluation(view, heroId) {
    const hero = view.players[heroId];
    const villains = view.players.filter(p => !p.folded && p.id !== heroId);
    const trackers = buildVillainRanges(view, heroId);
    const pot = view.pot;
    const toCall = Math.max(0, view.currentBet - hero.streetBet);
    const liveIds = villains.map(p => p.id);

    // Scenario-weighted raw equity + realization (fixes #1/#2)
    const inPotIds = toCall > 0 ? PT.spot.playersInForBet(view, heroId) : liveIds;
    const inSet = new Set(inPotIds);
    const yetIds = liveIds.filter(id => !inSet.has(id));
    const hw = PT.spot.headlineEquity(hero.hole, view.board, trackers,
      inPotIds, toCall > 0 ? yetIds : [], toCall || Math.max(1, view.currentBet), view);
    const rz = PT.spot.realizationFactor(view, heroId);
    const eq = hw.eq;            // raw, scenario-weighted
    const eqReal = hw.eq * rz.factor;

    const out = { equity: eq, equityRealized: eqReal, realization: rz, pot, toCall, trackers, actions: [],
      eqIn: hw.eqIn, scenarios: hw.scenarios, villains, seed: Math.floor(Math.random() * 2 ** 31) };

    if (toCall > 0) out.actions.push({ action: 'fold', ev: 0, plain: 'give up the pot', formula: 'EV = 0: you put in nothing more and win nothing more (money already in the pot is not counted)' });

    if (toCall > 0 && hero.stack > 0) {
      const call = Math.min(toCall, hero.stack);
      const ev = eqReal * (pot + call) - call;
      out.actions.push({ action: 'call', amount: call, ev, plain: `call ${bb(call)} into a final pot of ${bb(pot + call)} (you profit ${bb(pot)} if you win)`,
        formula: `EV = realized equity × final pot − cost = ${pct(eqReal)} × ${bb(pot + call)} − ${bb(call)} = ${bb(ev)} BB` });
    } else if (toCall === 0) {
      const ev = eqReal * pot * 0.9;
      out.actions.push({ action: 'check', ev, plain: 'see the next card free',
        formula: `EV ≈ realized equity × pot × 0.9 = ${pct(eqReal)} × ${bb(pot)} × 0.9 = ${bb(ev)} BB (0.9 because checking gives opponents free chances to bet you off the hand)` });
    }

    // Fix #4: EV(bet/raise) = F·P + (1−F)·(E_calling · FinalPot − Risk)
    for (const betTo0 of candidateSizes(view, pot)) {
      const betTo = Math.min(betTo0, hero.streetBet + hero.stack);
      const a = priceBet(view, hero, villains, trackers, betTo, toCall, pot, rz.factor, out.seed);
      if (a) out.actions.push(a);
    }
    out.best = out.actions.reduce((a, b) => (b.ev > a.ev ? b : a));
    return out;
  }

  // Preflop: 3x/4x (+1 per limper) or 3x/4x vs a raise. Postflop: ½ and ¾ pot.
  function candidateSizes(view, pot) {
    if (view.street !== 'preflop') return [0.5, 0.75].map(f => view.currentBet + Math.max(f * pot, 1));
    const pre = view.history.filter(h => h.street === 'preflop');
    if (pre.some(h => /raises to/.test(h.text))) return [3, 4].map(k => view.currentBet * k);
    const limpers = pre.filter(h => /calls/.test(h.text) && !h.text.startsWith('You')).length;
    return [3, 4].map(k => view.currentBet * (k + limpers));
  }

  // Simulates each villain folding or continuing independently, then plays out vs callers only.
  // Seeded so every size is priced on the same deals (sizing comparisons aren't noise).
  function priceBet(view, hero, villains, trackers, betTo, toCall, pot, realization, seed) {
    const put = Math.round((betTo - hero.streetBet) * 100) / 100;
    if (put <= 0 || put <= toCall) return null;
    const frac = Math.min(3, (betTo - view.currentBet) / Math.max(1, pot));

    const parts = villains.filter(v => trackers[v.id]).map(v => {
      const t = trackers[v.id];
      const rule = continueRule(view, v, frac, t);
      let contW = 0, totW = 0;
      for (const k of Object.keys(t.range)) {
        const w = t.range[k] * comboCount(k);
        totW += w;
        if (w > 0 && rule(k)) contW += w;
      }
      let pCont = totW > 0 ? Math.min(0.95, contW / totW) : 0.3;
      if (v.archetype === 'station' && view.board.length >= 3) pCont = Math.max(pCont, view.street === 'river' ? 0.85 : 0.7);
      return { v, pCont, rule, cont: continuingTracker(t, rule, view.board) };
    });
    // Players call river bluffs more often than raw range shares suggest.
    if (view.street === 'river' && parts.length) {
      const floor = 1 - Math.pow(0.45, 1 / parts.length);
      for (const p of parts) p.pCont = Math.max(p.pCont, floor);
    }

    const maxCover = Math.max(0, ...parts.map(p => p.v.stack + p.v.streetBet - hero.streetBet));
    const risk = Math.min(put, maxCover);
    const allIn = put >= hero.stack - 0.01;
    const rf = allIn || view.board.length === 5 ? 1 : realization;
    const used0 = new Set([...hero.hole, ...view.board].map(c => c.id));
    const heroFoldsToReraise = view.board.length < 3 && !allIn && PT.ranges.PREFLOP_PCTL[keyOf(hero.hole)] > 0.05;
    const rng = mulberry32(seed);
    const N = 4000;
    let evSum = 0, foldAll = 0, calledN = 0, shareSum = 0;
    for (let it = 0; it < N; it++) {
      const callers = [];
      const used = new Set(used0);
      for (const p of parts) {
        if (rng() >= p.pCont) continue;
        const h = p.cont.sample(used, rng);
        if (!h) continue;
        used.add(h[0].id); used.add(h[1].id);
        callers.push({ p, h });
      }
      if (!callers.length) { foldAll++; evSum += pot; continue; }
      // Preflop re-raise: non-premium hands fold and lose the whole raise.
      if (heroFoldsToReraise && callers.some(c => c.p.rule.reraises && c.p.rule.reraises(keyOf(c.h)))) {
        evSum -= risk; calledN++;
        continue;
      }
      const deck = PT.math.fullDeckMinus([...hero.hole, ...view.board, ...callers.flatMap(c => c.h)]);
      const runout = view.board.slice();
      for (let i = 0; runout.length < 5; i++) {
        const j = i + Math.floor(rng() * (deck.length - i));
        [deck[i], deck[j]] = [deck[j], deck[i]];
        runout.push(deck[i]);
      }
      const hb = PT.eval.bestHand([...hero.hole, ...runout]);
      let lost = false, ties = 0;
      for (const c of callers) {
        const cmp = PT.eval.compareRank(hb, PT.eval.bestHand([...c.h, ...runout]));
        if (cmp < 0) { lost = true; break; }
        if (cmp === 0) ties++;
      }
      const share = lost ? 0 : 1 / (1 + ties);
      let finalPot = pot + risk;
      for (const c of callers) finalPot += Math.max(0, Math.min(c.p.v.stack, risk + hero.streetBet - c.p.v.streetBet));
      evSum += share * rf * finalPot - risk;
      calledN++; shareSum += share;
    }
    const F = foldAll / N, E = calledN ? shareSum / calledN : 0, ev = evSum / N;
    const evCalled = calledN ? (ev - F * pot) / (1 - F) : 0;
    return {
      action: view.currentBet === 0 ? 'bet' : 'raise', amount: betTo, frac, foldEq: F, eqCalled: E, ev, risk,
      formula: `EV = P(everyone folds) × pot + P(called) × EV when called = ${pct(F)} × ${bb(pot)} + ${pct(1 - F)} × ${bb(evCalled)} = ${bb(ev)} BB. ` +
        `You put in ${bb(risk)} BB; when called you end up with ~${pct(E)} of the final pot on average${heroFoldsToReraise ? ', and you fold (losing the raise) if re-raised' : ''}. ` +
        `Fold chances come from simulating each opponent's range: hands below their continue threshold fold`,
      plain: `everyone folds ~${pct(F)} (you win ${bb(pot)}); when someone continues you end up with ~${pct(E)} of the pot${heroFoldsToReraise ? ' (you fold if re-raised)' : ''} → EV = ${pct(F)} × ${bb(pot)} + ${pct(1 - F)} × ${bb(evCalled)} = ${bb(ev)} BB`
    };
  }

  function board2cls(board, key) {
    if (board.length < 3) {
      const combo = PT.ranges.ALL.find(c => c.key === key);
      return combo ? combo.score / 12 : 0.3;
    }
    const cls = PT.ranges.comboClassOnBoard(key, board);
    return Math.max(cls.made, 0.45 + cls.draw);
  }

  const comboCount = k => k.length === 2 ? 6 : k[2] === 's' ? 4 : 12;

  function keyOf(cards) {
    const [a, b] = cards.slice().sort((x, y) => y.ri - x.ri);
    return a.ri === b.ri ? a.rank + b.rank : a.rank + b.rank + (a.si === b.si ? 's' : 'o');
  }

  function mulberry32(a) {
    return () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------- grading + plain-English explanation ---------- */

  function grade(view, heroId, action, betTo, depth) {
    const ev = evaluateActions(view, heroId, (action === 'bet' || action === 'raise') ? betTo : undefined);
    let chosen;
    if (action === 'bet' || action === 'raise') {
      const sized = ev.actions.filter(a => a.action === action);
      chosen = sized.length ? sized.reduce((a, b) => Math.abs(b.amount - betTo) < Math.abs(a.amount - betTo) ? b : a) : null;
    } else {
      chosen = ev.actions.find(a => a.action === action);
    }
    if (!chosen) chosen = { ev: 0, plain: '', action };
    // Thresholds in BB with mild pot scaling: in a 100 BB pot a 4 BB error is
    // still a mistake, not a blunder; in a 4 BB pot a 4 BB error IS a blunder.
    const scale = Math.max(3, Math.min(40, 3 + ev.pot * 0.2));
    const rawLoss = Math.max(0, ev.best.ev - chosen.ev);
    // A sizing gap inside Monte Carlo noise isn't a mistake, but losing to a different action still is.
    const otherBest = Math.max(-Infinity, ...ev.actions.filter(a => a.action !== chosen.action).map(a => a.ev));
    const loss = chosen.action === ev.best.action && rawLoss < 0.15 + 0.04 * ev.pot ? Math.max(0, otherBest - chosen.ev) : rawLoss;
    let g = GRADES.find(x => loss <= x.maxLoss * scale / 6);

    // Relative-error floor: small pots shouldn't launder big ratio errors.
    // Calling with less than 60% of the required equity is a mistake even if
    // the absolute BB loss is small; so is folding with 1.8x required.
    const eqR = ev.equityRealized != null ? ev.equityRealized : ev.equity;
    if (ev.toCall > 0 && eqR != null) {
      const req = PT.math.potOdds(ev.toCall, ev.pot);
      if (action === 'call' && eqR < req * 0.6 && ['excellent', 'good', 'marginal'].includes(g.key))
        g = GRADES.find(x => x.key === (eqR < req * 0.35 ? 'blunder' : 'mistake'));
      if (action === 'fold' && eqR > req * 1.8 && eqR > req + 0.1 && ['excellent', 'good', 'marginal'].includes(g.key))
        g = GRADES.find(x => x.key === 'mistake');
    }
    // Choosing a losing action when a non-losing one existed is never Good/Excellent.
    if (loss >= 0.05 && chosen.ev < 0 && ev.best.ev >= 0 && ['excellent', 'good'].includes(g.key))
      g = GRADES.find(x => x.key === 'marginal');
    // Giving up 30%+ of the best option's value is an inaccuracy even when the BB amount is small.
    if (loss >= 0.2 && ev.best.ev > 0 && chosen.ev < ev.best.ev * 0.7 && ['excellent', 'good'].includes(g.key))
      g = GRADES.find(x => x.key === 'marginal');
    // A size worse than the best size by more than the estimate's noise matches the "your size is the problem" text.
    if (chosen.action === ev.best.action && rawLoss >= 0.15 + 0.04 * ev.pot && ['excellent', 'good'].includes(g.key))
      g = GRADES.find(x => x.key === 'marginal');
    // A clearly profitable line keeping most of the best line's value is at worst a mistake.
    if (g.key === 'blunder' && chosen.ev > 0 && chosen.ev >= ev.best.ev * 0.5)
      g = GRADES.find(x => x.key === 'mistake');

    return {
      grade: g.key, label: g.label, evLoss: loss, equity: ev.equity, ev,
      best: ev.best, chosen,
      plain: explainVerdict(view, heroId, ev, chosen),
      lines: detailLines(view, heroId, ev, depth, chosen)
    };
  }

  const VERB = { fold: 'Folding', check: 'Checking', call: 'Calling', bet: 'Betting', raise: 'Raising' };
  const actionText = a => VERB[a.action] + ((a.action === 'bet' || a.action === 'raise') && a.amount != null ? ` to ${bb(a.amount)} BB` : '');

  // One reason per action, built only from computed numbers.
  function reasonFor(a, ev) {
    if (a.action === 'fold') return 'folding risks nothing more (EV 0 BB)';
    if (a.action === 'check') return `checking keeps your ~${pct(ev.equityRealized)} share of the ${bb(ev.pot)} BB pot for free (EV ${bb(a.ev)} BB)`;
    if (a.action === 'call') return `calling needs ${pct(PT.math.potOdds(ev.toCall, ev.pot))} equity and you realize ~${pct(ev.equityRealized)} (EV ${bb(a.ev)} BB)`;
    return a.plain;
  }

  function explainVerdict(view, heroId, ev, chosen) {
    const hole = view.players[heroId].hole.map(c => c.id).join(' ');
    const gap = ev.best.ev - chosen.ev;
    const noise = 0.15 + 0.04 * ev.pot;
    const isBest = chosen === ev.best || gap < 0.05;
    const sameAction = chosen.action === ev.best.action;
    const alt = ev.actions.filter(a => a.action !== chosen.action).reduce((a, b) => (!a || b.ev > a.ev ? b : a), null);
    let s;
    if ((isBest || sameAction) && alt && gap < noise && chosen.ev - alt.ev < noise)
      s = `Close decision with ${hole}: ${lowerFirst(actionText(chosen))} (EV ${bb(chosen.ev)} BB) and ${lowerFirst(actionText(alt))} (EV ${bb(alt.ev)} BB) are within the estimate's noise, so either is fine. ${VERB[chosen.action]}: ${reasonFor(chosen, ev)}.`;
    else if (isBest) s = `${actionText(chosen)} is the best option with ${hole}: ${reasonFor(chosen, ev)}.`;
    else if (sameAction && gap >= noise) s = `Your size is the problem: ${lowerFirst(actionText(chosen))} (EV ${bb(chosen.ev)} BB) gives up ${bb(gap)} BB compared with ${lowerFirst(actionText(ev.best))} (EV ${bb(ev.best.ev)} BB). ${VERB[chosen.action]} was right with ${hole}, but ${chosen.amount > ev.best.amount ? 'the bigger size risks more than it gains' : 'the smaller size leaves money behind'}: ${reasonFor(ev.best, ev)}.`;
    else if (sameAction) s = `${VERB[chosen.action]} is the right action with ${hole}; ${bb(chosen.amount)} BB (EV ${bb(chosen.ev)}) vs ${bb(ev.best.amount)} BB (EV ${bb(ev.best.ev)}) is a sizing difference within the estimate's noise: ${reasonFor(chosen, ev)}.`;
    else s = `${actionText(chosen)} (EV ${bb(chosen.ev)} BB) is ${chosen.ev > 0.05 ? 'profitable, but ' : ''}${gap < noise ? 'slightly' : 'clearly'} worse than ${lowerFirst(actionText(ev.best))} (EV ${bb(ev.best.ev)} BB)${gap < noise ? ', within the estimate\'s noise' : ''}: ${reasonFor(ev.best, ev)}.`;
    return s + ' ' + lessonFor(view, chosen, isBest || sameAction);
  }

  const lowerFirst = s => s[0].toLowerCase() + s.slice(1);

  function lessonFor(view, chosen, isBest) {
    const a = chosen.action;
    if (view.street === 'preflop') {
      if (a === 'call') return isBest ? 'Flatting works here because the price is good and your hand plays well multiway.' : 'Preflop, prefer raise-or-fold: flatting with hands that are often dominated leaks money.';
      if (a === 'raise' || a === 'bet') return 'A raise wins two ways: everyone folds now, or you play a bigger pot with the initiative against fewer, weaker callers.';
      if (a === 'fold') return isBest ? 'Folding marginal hands preflop is cheap; profit comes from entering pots with an edge.' : 'Count who is already in and who is yet to act before folding a hand that beats the price.';
      return '';
    }
    if (a === 'call' || a === 'fold') return 'Facing a bet, compare the equity you will actually realize with the price, against everyone already in the pot.';
    if (a === 'bet' || a === 'raise') return isBest ? 'Name the hands you target: worse hands that call (value) or better hands that fold (bluff).' : 'A bet needs enough folds now or enough equity when called; this one had neither.';
    if (a === 'check') return isBest ? 'Checking is right when a bet gets called mostly by better hands and folds out mostly worse ones.' : 'Ask "what worse hands call?" — if many do, betting earns more than checking.';
    return '';
  }

  const hasActed = (view, p) => view.history.some(h => h.text.startsWith(p.name + ' ') && !/ posts /.test(h.text));

  function rangeLine(view, id, t) {
    const p = view.players[id];
    const bd = t.breakdown(view.board);
    const [a, b, c] = view.board.length >= 3 ? ['strong', 'draws', 'weak'] : ['premium', 'playable', 'weak'];
    const status = hasActed(view, p) ? '' : ' — yet to act, so this is every hand they could hold';
    return `${p.name} (${PT.opponents.ARCHETYPES[p.archetype].label}): ~${pct(t.sizePct())} of hands — ${pct(bd.value)} ${a} / ${pct(bd.draws)} ${b} / ${pct(bd.air)} ${c}${status}`;
  }

  function detailLines(view, heroId, ev, depth, chosen) {
    if (depth === 'None') return [];
    const lines = [];
    const a = chosen.action;
    if (ev.equity != null)
      lines.push(`Your equity: raw ${pct(ev.equity)} → realized ~${pct(ev.equityRealized)} (${ev.realization.reason}). Counts players already in, plus those yet to act weighted by how often they continue.`);
    if ((a === 'call' || a === 'fold') && ev.toCall > 0)
      lines.push(`Price: call ${bb(ev.toCall)} into a final pot of ${bb(ev.pot + ev.toCall)} (you profit ${bb(ev.pot)} if you win) → need ${pct(PT.math.potOdds(ev.toCall, ev.pot))}; you realize ~${pct(ev.equityRealized)}.`);
    if (a === 'bet' || a === 'raise') lines.push(`${a === 'bet' ? 'Bet' : 'Raise'} math: ${chosen.plain}.`);
    for (const [id, t] of Object.entries(ev.trackers)) lines.push(rangeLine(view, id, t) + '.');
    if (depth === 'Advanced' || depth === 'Pro')
      lines.push('EV table: ' + ev.actions.map(x => `${x.action}${x.amount ? ' ' + bb(x.amount) : ''} = ${bb(x.ev)} BB`).join(' · '));
    if (depth === 'Pro')
      ev.actions.forEach(x => x.plain && lines.push(`• ${x.action}${x.amount ? ' ' + bb(x.amount) : ''}: ${x.plain}`));
    return lines;
  }

  /* ---------- tutor ---------- */

  // locked: a Test-mode decision is pending, so don't reveal the best action.
  function tutorReply(question, view, heroId, locked) {
    const q = question.toLowerCase();
    const hero = view.players[heroId];
    if (!hero || !hero.hole) return 'No live hand right now — start a session.';
    const ev = evaluateActions(view, heroId);
    const pot = ev.pot, toCall = ev.toCall;
    const board = view.board.map(c => c.id).join(' ') || 'none yet';
    const street = view.street;

    const wantsAction = /what should i do|best (play|move|action)|should i (call|fold|raise|bet|shove)/.test(q);
    if (wantsAction && locked)
      return `Test mode — I won't name the play before you commit. Reason it out: you need ${toCall > 0 ? pct(PT.math.potOdds(toCall, pot)) + ' equity to call' : 'a plan for the pot'}. What's their range after their actions, and how much of it do you beat?`;
    if (wantsAction) {
      const alt = ev.actions.filter(a => a.action !== ev.best.action).reduce((a, b) => (!a || b.ev > a.ev ? b : a), null);
      const close = alt && ev.best.ev - alt.ev < 0.15 + 0.04 * ev.pot
        ? ` Close decision: ${lowerFirst(actionText(alt))} (EV ${bb(alt.ev)} BB) is within the estimate's noise, so both are reasonable.` : '';
      return `Engine recommendation: ${lowerFirst(actionText(ev.best))} (EV ${bb(ev.best.ev)} BB) — ${reasonFor(ev.best, ev)}.${close} Before acting, ask: what worse hands call, or what better hands fold?`;
    }

    if (/pot odds|required equity|need.*equity/.test(q)) {
      if (toCall <= 0) return `No bet to call right now, so pot odds don't apply this exact second. When facing a bet: required equity = bet / (pot after your call).`;
      return `You must call ${bb(toCall)} BB into ${bb(pot)} BB. After calling, the pot is ${bb(pot + toCall)}, so you need ${pct(PT.math.potOdds(toCall, pot))} equity. Your estimated equity vs their ranges is ~${pct(ev.equity)} — ${ev.equity > PT.math.potOdds(toCall, pot) ? 'above' : 'below'} the threshold.`;
    }
    if (/range/.test(q)) {
      const parts = Object.entries(ev.trackers).map(([id, t]) => rangeLine(view, id, t));
      return parts.length
        ? `Based only on their actions this hand:\n• ${parts.join('\n• ')}\nRanges narrow with every action — a raise cuts out the weak portion, a call caps the strong portion.`
        : 'No live opponents with ranges to estimate.';
    }
    if (/spr|stack.to.pot/.test(q)) {
      const eff = Math.min(...view.players.filter(p => !p.folded).map(p => p.stack + p.streetBet));
      const s = PT.math.spr(eff, pot);
      return `Effective stack ${bb(eff)} BB, pot ${bb(pot)} BB → SPR ${s === Infinity ? '∞' : s.toFixed(1)}. Under ~3: top-pair hands can commit. Over ~10: you need much stronger than one pair to stack off, and implied odds matter most.`;
    }
    if (/mdf|minimum defense/.test(q)) {
      if (toCall <= 0) return 'MDF matters when you face a bet: MDF = pot / (pot + bet) — how often you must continue so bluffs can\'t auto-profit.';
      return `Facing ${bb(toCall)} into ${bb(pot)}: MDF = ${pct(PT.math.mdf(pot, toCall))}. Continue at least that often (calls + raises combined) or aggressive opponents profitably bluff any two cards against you.`;
    }
    if (/bluff/.test(q)) {
      const bet = Math.max(1, pot * 0.66);
      return `A bluff must work bet/(pot+bet) of the time to break even. A ⅔-pot bluff here (${bb(bet)} BB) needs ${pct(PT.math.breakEvenBluff(bet, pot))} folds. Best bluffs block their continuing range and keep some equity when called.`;
    }
    if (/outs|draw/.test(q)) {
      const o = PT.math.countOuts(hero.hole, view.board);
      if (!o) return 'Outs are countable on the flop/turn. Right now there\'s no draw count to give.';
      return `Roughly ${o.outs} cards improve you (${o.improving.slice(0, 14).join(' ')}${o.improving.length > 14 ? '…' : ''}). Rule of 2 and 4: about ${o.outs * (view.board.length === 3 ? 4 : 2)}% to improve by the river.`;
    }
    if (/board|texture/.test(q)) return boardTextureLine(view.board);
    const bets = ev.actions.filter(a => a.action === 'bet' || a.action === 'raise');
    if (/siz|how (much|big)|amount/.test(q)) {
      const rule = street === 'preflop'
        ? (view.currentBet > 1 ? 're-raising to 3x and 4x their raise' : 'opening to 3x and 4x the big blind (+1 BB per limper)')
        : 'betting ½ pot and ¾ pot';
      if (locked || !bets.length) return `The engine compares ${rule}. A bigger size wins the pot more often right away but loses more when a stronger hand calls — pick the size where (fold% × pot) + (call% × EV when called) is highest.`;
      return `The engine compares ${rule}, pricing each one: ` +
        bets.map(a => `${lowerFirst(actionText(a))} gets folds ~${pct(a.foldEq)} for EV ${bb(a.ev)} BB`).join('; ') +
        `. The bigger size buys more folds but risks more when called — the higher EV wins.`;
    }
    if (/\bev\b|expected value|calculat|comput|where.*(number|come)/.test(q)) {
      if (locked) return 'EV = sum of (probability × result) for each outcome. Calling: realized equity × final pot − cost. Betting: fold% × pot + call% × EV when called. Commit your action and I\'ll show the real numbers.';
      return 'How each EV is computed:\n• ' + ev.actions.map(a => `${actionText(a)}: ${a.formula || a.plain}`).join('\n• ');
    }
    if (/why/.test(q))
      return `On ${street} with board ${board}: an opponent's action narrows their range in a way their archetype colors — nits act narrowly, stations call wide, LAGs bet wide with bluffs. Combine "who they are" with "what this board does to their range vs yours".`;
    if (/equity/.test(q))
      return `~${pct(ev.equity)} vs ${Object.keys(ev.trackers).length} opponent(s)' tracked ranges right now (${street}, board ${board}).`;
    return `Spot: ${street}, pot ${bb(pot)} BB${toCall ? `, ${bb(toCall)} to call` : ''}, board ${board}, your equity ~${pct(ev.equity)}. Ask about pot odds, SPR, MDF, ranges, texture, outs, or "what should I do".`;
  }

  function boardTextureLine(board) {
    if (board.length < 3) return `Board: ${board.map(c => c.id).join(' ') || 'none yet'} — texture talk starts on the flop.`;
    const suits = {}; board.forEach(c => suits[c.suit] = (suits[c.suit] || 0) + 1);
    const maxSuit = Math.max(...Object.values(suits));
    const ranks = [...new Set(board.map(c => c.ri))].sort((a, b) => a - b);
    const paired = ranks.length < board.length;
    const connected = ranks.length >= 3 && ranks[ranks.length - 1] - ranks[0] <= 4;
    const high = board.filter(c => c.ri >= 9).length;
    const t = [maxSuit >= 3 ? 'flush possible' : maxSuit === 2 ? 'two-tone' : 'rainbow',
      paired ? 'paired' : 'unpaired', connected ? 'connected' : 'disconnected',
      high >= 2 ? 'high-card heavy' : 'low/mid'];
    return `Board ${board.map(c => c.id).join(' ')}: ${t.join(', ')}. ${high >= 2 ? 'Favors the preflop raiser.' : 'Favors the preflop caller.'} Whoever's range this favors should do most of the betting.`;
  }

  // The engine analysis the AI tutor must stay consistent with. Locked: omit the recommendation.
  function tutorFacts(view, heroId, locked) {
    const hero = view.players[heroId];
    const ev = evaluateActions(view, heroId);
    const spot = PT.spot.analyze(view, heroId, ev);
    const L = [
      `Street ${view.street}, board ${view.board.map(c => c.id).join(' ') || 'none'}, pot ${bb(ev.pot)} BB, student holds ${hero.hole.map(c => c.id).join(' ')}${ev.toCall > 0 ? `, ${bb(ev.toCall)} BB to call` : ', no bet to call'}.`,
      `Spot: ${spot.guidance.title}. ${spot.guidance.metric}`,
      `Equity: raw ${pct(ev.equity)}, realized ~${pct(ev.equityRealized)} (${ev.realization.reason}).`
    ];
    L.push('How equity is computed: the rest of the board is dealt out thousands of times against hands sampled from each opponent\'s estimated range; ' +
      'equity is the share of the pot you win. Realized equity scales that for position and number of opponents.');
    if (ev.toCall > 0) L.push(`Required equity to call: ${pct(PT.math.potOdds(ev.toCall, ev.pot))} = ${bb(ev.toCall)} / (${bb(ev.pot)} + ${bb(ev.toCall)}).`);
    for (const [id, t] of Object.entries(ev.trackers)) L.push(rangeLine(view, id, t) + '.');
    L.push('How bet sizes are chosen: ' + (view.street === 'preflop'
      ? (view.currentBet > 1 ? 'versus a raise the engine compares re-raising to 3x and 4x the raise' : 'opening, the engine compares 3x and 4x the big blind, plus 1 BB per limper')
      : 'postflop the engine compares betting 1/2 pot and 3/4 pot') +
      '. Bigger sizes win the pot more often right away but lose more when called by a stronger hand; the size with the higher EV is preferred.');
    if (!locked) {
      L.push('EV per action (expected profit in BB from this point):');
      for (const x of ev.actions) L.push(`- ${lowerFirst(actionText(x))}: EV ${bb(x.ev)} BB. ${x.formula || x.plain}.`);
      L.push(`Recommended: ${lowerFirst(actionText(ev.best))} (EV ${bb(ev.best.ev)} BB) — ${reasonFor(ev.best, ev)}.`);
      const alt = ev.actions.filter(a => a.action !== ev.best.action).reduce((a, b) => (!a || b.ev > a.ev ? b : a), null);
      if (alt && ev.best.ev - alt.ev < 0.15 + 0.04 * ev.pot)
        L.push(`Close decision: ${lowerFirst(actionText(alt))} (EV ${bb(alt.ev)} BB) is within the estimate's noise, so say both are reasonable.`);
    }
    return { text: L.join('\n'), best: lowerFirst(actionText(ev.best)), bestAction: ev.best.action };
  }

  // Which earlier decision a tutor question refers to (by an amount the student bet, or a street name), or -1.
  function pickDecision(question, decisions, currentStreet) {
    if (!question || !decisions || !decisions.length) return -1;
    const q = question.toLowerCase().replace(/pre[\s-]?flop/g, 'preflop');
    const amounts = [...q.matchAll(/(\d+(?:\.\d+)?)\s*(?:bb|big blinds?)?/g)].map(m => +m[1]);
    for (let i = decisions.length - 1; i >= 0; i--)
      if (decisions[i].amount != null && amounts.some(a => Math.abs(a - decisions[i].amount) < 0.05)) return i;
    const street = ['preflop', 'river', 'turn', 'flop'].find(s => new RegExp(`\\b${s}\\b`).test(q));
    if (!street || street === currentStreet) return -1;
    for (let i = decisions.length - 1; i >= 0; i--) if (decisions[i].street === street) return i;
    return -1;
  }

  PT.coach = { grade, tutorReply, tutorFacts, pickDecision, evaluateActions, buildVillainRanges, equityVsField, GRADES, clearCache: () => EVAL_CACHE.clear() };
})(window.PT = window.PT || {});
