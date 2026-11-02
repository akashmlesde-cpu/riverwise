/* spot.js — spot classification, scenario-weighted equity, realization,
 * explainable breakdown. All inputs derive from coachView (isolation intact).
 *
 * Fix #1: headline equity = equity vs players ALREADY IN the pot (bettor +
 * callers/raisers of the current bet) + scenario-weighted scenarios for
 * players yet to act (each may fold/call/raise per archetype).
 * Fix #2: realization factor keyed to hand class; river = 1.0.
 */
(function (PT) {
  const pct = (x, d) => x == null ? '—' : (x * 100).toFixed(d == null ? 0 : d) + '%';

  function findAggressor(view, heroId) {
    for (let i = view.history.length - 1; i >= 0; i--) {
      const h = view.history[i];
      if (h.street !== view.street) break;
      const m = h.text.match(/^(.+?) (bets|raises to)/);
      if (m) {
        const p = view.players.find(pl => pl.name === m[1]);
        if (p && p.id !== heroId) return p.id;
      }
    }
    return -1;
  }

  // Players already committed to the current bet level this street:
  // the aggressor + anyone who called/raised after them this street.
  // Players who already matched the current bet (bettor, callers, limpers, unraised BB) or are all-in.
  function playersInForBet(view, heroId) {
    if (view.currentBet <= 0) return [];
    return view.players
      .filter(p => !p.folded && p.id !== heroId && (p.allIn || p.streetBet >= view.currentBet))
      .map(p => p.id);
  }

  // Per-player continue probabilities when facing a bet (archetype-based).
  function continueProbs(view, playerId, betSize) {
    const p = view.players[playerId];
    const prof = PT.opponents.ARCHETYPES[p.archetype];
    const potOddsReq = PT.math.potOdds(betSize, view.pot);
    // looser players continue more; bigger bets continue less
    const cont = Math.min(0.92, Math.max(0.05, prof.loose * 1.4 - potOddsReq * 0.8));
    const raise = cont * (0.15 + prof.agg * 0.25);
    const call = cont - raise;
    return { fold: 1 - cont, call, raise };
  }

  /* ---------- equity helpers ---------- */

  function eqField(heroHole, board, trackers, ids, iters) {
    const sub = {};
    for (const id of ids) if (trackers[id]) sub[id] = trackers[id];
    if (!Object.keys(sub).length) return 1;
    return PT.coach.equityVsField(heroHole, board, sub, iters || 700);
  }

  /* ---------- Fix #1: scenario-weighted headline equity ---------- */
  // inPot: must beat ALL of them. yetToAct: weighted over fold/call/raise.
  // Approximation: E ≈ E(inPot) × [ Π_i (fold_i + call_i × winFactor_i) ]
  // where winFactor_i = P(beat player i | beat inPot) estimated from HU equity.
  function headlineEquity(heroHole, board, trackers, inPotIds, yetIds, betSize, view) {
    const eqIn = inPotIds.length ? eqField(heroHole, board, trackers, inPotIds) : 1;
    if (!yetIds.length) return { eq: eqIn, eqIn, scenarios: [] };
    const scenarios = [];
    let factor = 1;
    for (const id of yetIds) {
      const p = continueProbs(view, id, betSize);
      const eqHU = eqField(heroHole, board, trackers, [id], 400);
      // conditional win factor vs this player given hero beats the in-pot group:
      // approximation via HU equity (slightly optimistic, documented)
      const winFactor = Math.min(0.98, 0.35 + eqHU * 0.6);
      factor *= (p.fold + p.call * winFactor + p.raise * winFactor * 0.7);
      scenarios.push({ id, name: view.players[id].name, p, eqHU });
    }
    return { eq: eqIn * factor, eqIn, scenarios };
  }

  /* ---------- Fix #2: realization by hand class ---------- */
  function handClass(heroHole, board) {
    if (board.length < 3) {
      // preflop classes from cards only
      const [a, b] = heroHole.slice().sort((x, y) => y.ri - x.ri);
      if (a.ri === b.ri) return a.ri >= 8 ? 'strongMade' : 'mediumMade';
      const suited = a.si === b.si, gap = a.ri - b.ri;
      if (suited && gap <= 2) return 'draw';
      if (!suited && gap >= 4) return 'junk';
      return a.ri >= 10 ? 'mediumMade' : 'junk';
    }
    const rank = PT.eval.bestHand([...heroHole, ...board]);
    const cat = rank[0];
    if (cat >= 4) return 'strongMade';                    // straight+
    if (cat === 3) return 'strongMade';                   // trips
    if (cat === 2) return rank[1] >= 10 ? 'strongMade' : 'mediumMade'; // two pair: strong if top pair is high
    if (cat === 1) {                                       // one pair
      const pairRank = rank[1];                          // pair's rank value (2..14)
      const topBoard = Math.max(...board.map(c => c.ri + 2));
      const kicker = rank[2];                            // first kicker value
      if (pairRank >= topBoard) return kicker >= 12 ? 'strongMade' : 'mediumMade'; // top pair: strong with A/K kicker
      if (pairRank >= topBoard - 2) return 'mediumMade'; // second pair
      return 'junk';                                     // underpair-ish pairs play weak postflop
    }
    // high card: check draws
    const draws = PT.ranges.comboClassOnBoard ?
      null : null;
    const o = PT.math.countOuts(heroHole, board);
    if (o && o.outs >= 8) return 'draw';
    if (o && o.outs >= 4) return 'draw';
    return 'junk';
  }

  function realizationFactor(view, heroId) {
    if (view.street === 'river') return { factor: 1, reason: 'river — no more cards, equity is final' };
    const hero = view.players[heroId];
    const cls = handClass(hero.hole, view.board);
    const n = view.players.length;
    const order = id => (id - view.button - 1 + n) % n;
    const live = view.players.filter(p => !p.folded && p.id !== heroId);
    // Preflop, the opponents that matter are those who entered; otherwise the blinds who defend.
    const entered = live.filter(p => view.history.some(h => h.street === 'preflop' && h.text.startsWith(p.name + ' ') && / (calls|raises to) /.test(h.text)));
    const relevant = view.street !== 'preflop' ? live : entered.length ? entered : live.filter(p => p.id === view.sbSeat || p.id === view.bbSeat);
    const inPosition = relevant.every(p => order(heroId) > order(p.id));
    const pre = view.board.length < 3;
    const label = pre
      ? { strongMade: 'premium hand', mediumMade: 'decent high-card hand', draw: 'suited/connected hand' }[cls] || 'weak offsuit hand'
      : { strongMade: 'strong made hand', mediumMade: 'medium made hand', draw: 'drawing hand' }[cls] || 'weak hand';
    let f;
    switch (cls) {
      case 'strongMade': f = inPosition ? 1.0 : 0.95; break;
      case 'mediumMade': f = inPosition ? 0.92 : 0.82; break;
      case 'draw': f = inPosition ? 0.95 : 0.85; break;
      default: f = inPosition ? 0.85 : 0.7;
    }
    const why = [label, inPosition ? 'in position' : 'out of position'];
    if (cls !== 'strongMade' && (pre ? entered.length : live.length) >= 2) { f *= 0.9; why.push('multiway'); }
    f = Math.max(0.5, Math.min(1.1, f));
    return { factor: f, reason: why.join(', ') };
  }

  /* ---------- Fix #3: spot classification ---------- */
  function analyze(view, heroId, coachEval) {
    const hero = view.players[heroId];
    const live = view.players.filter(p => !p.folded && p.id !== heroId);
    const nLive = live.length;
    const toCall = coachEval.toCall;
    const pot = coachEval.pot;
    const trackers = coachEval.trackers;
    const aggId = findAggressor(view, heroId);
    const inPotIds = playersInForBet(view, heroId);
    const inSet = new Set(inPotIds);
    const yetIds = live.map(p => p.id).filter(id => !inSet.has(id));
    const fairShare = 1 / (nLive + 1);

    // Reuse the coach's evaluation when given, so every panel shows the same equity.
    const hw = coachEval.scenarios
      ? { eq: coachEval.equity, eqIn: coachEval.eqIn, scenarios: coachEval.scenarios }
      : headlineEquity(hero.hole, view.board, trackers,
        toCall > 0 ? inPotIds : live.map(p => p.id),
        toCall > 0 ? yetIds : [], toCall || Math.max(1, view.currentBet), view);

    const rz = coachEval.realization || realizationFactor(view, heroId);
    const realized = hw.eq * rz.factor;

    // Monte Carlo CI at 95% (~700 iters)
    const se = hw.eq != null ? 1.96 * Math.sqrt(Math.max(0.001, hw.eq * (1 - hw.eq)) / 700) : null;

    // equity views (labeled, P2) — keep for transparency
    const views = [];
    views.push({ key: 'headline', label: 'Headline (in-pot + scenarios, realized)', eq: realized, note: 'The number that decides this spot.' });
    views.push({ key: 'inpot', label: toCall > 0 ? `vs players already in (${inPotIds.length})` : `vs whole field (${nLive})`, eq: hw.eqIn, note: toCall > 0 ? 'You must beat all of them to win.' : 'Everyone still live.' });
    if (aggId >= 0 && trackers[aggId] && nLive > 1)
      views.push({ key: 'aggressor', label: `vs ${view.players[aggId].name} only`, eq: eqField(hero.hole, view.board, trackers, [aggId], 500), note: 'Reference only — ignores callers already in.' });
    views.push({ key: 'fair', label: 'Fair share', eq: fairShare, note: `100% ÷ ${nLive + 1} players.` });

    // spot classification
    const preflop = view.street === 'preflop';
    // Unopened = preflop, no raise, and no voluntary entries (limp) by anyone.
    // Blind posts contain "posts" and never match 'calls'/'raises to'.
    const unopened = preflop &&
      !view.history.some(h => /raises to/.test(h.text)) &&
      !view.history.some(h => h.street === 'preflop' && /calls/.test(h.text) && !h.text.startsWith('You'));

    let spot, guidance;
    if (unopened) {
      spot = 'unopened';
      const risk = 2.5;
      const beFold = risk / (risk + pot);
      const pAllFold = yetIds.length
        ? yetIds.reduce((s, id) => s * (1 - PT.opponents.ARCHETYPES[view.players[id].archetype].loose), 1)
        : Math.pow(0.75, live.length);
      guidance = {
        title: 'Unopened pot — open-or-fold decision (not equity)',
        metric: `A 2.5 BB open risks 2.5 to win ${pot.toFixed(1)} → breaks even if all fold ${pct(beFold, 1)} of the time.`,
        verdict: `Estimated P(everyone folds) ≈ ${pct(pAllFold)}${pAllFold > beFold ? ' → opening shows an immediate profit' : ' → open needs postflop playability'}.`,
        teach: 'When nobody has entered the pot, ask "how often does everyone fold?" — pot odds and equity don\'t decide this.'
      };
    } else if (toCall > 0) {
      spot = 'facing-bet';
      const req = PT.math.potOdds(toCall, pot);
      guidance = {
        title: 'You face a bet — pot-odds decision',
        metric: `Required equity: ${pct(req, 1)} (call ${toCall.toFixed(1)} into a final pot of ${(pot + toCall).toFixed(1)})`,
        verdict: `Your equity: ~${pct(realized, 1)}${se ? ` ±${pct(se, 1)}` : ''} → ${realized > req ? 'continuing is profitable' : 'continuing loses money'}.`,
        teach: inPotIds.length > 1
          ? `Note: ${inPotIds.length} players are already in for this bet — you must beat ALL of them. That's why the headline isn't just vs the bettor.`
          : yetIds.length ? `Plus ${yetIds.length} player(s) yet to act, scenario-weighted.` : 'Compare required equity to your equity only when facing a bet.'
      };
    } else if (view.street === 'river') {
      spot = 'river';
      guidance = {
        title: 'River — equity = share of their range you beat',
        metric: `You beat ~${pct(realized, 1)} of their range.`,
        verdict: 'Value-bet test: will WORSE hands call more often than BETTER hands call or raise? Yes → bet small. No → check.',
        teach: 'No more cards — equity is final. The question is what a bet accomplishes, not "am I ahead".'
      };
    } else {
      spot = 'bet-or-check';
      guidance = {
        title: 'No bet to face — bet-vs-check decision',
        metric: 'Pot odds don\'t apply (nobody has bet).',
        verdict: 'Ask: (1) What WORSE hands call a bet? (2) What BETTER hands fold? If neither answer is good, check.',
        teach: 'Equity alone doesn\'t decide this spot — what a bet accomplishes against their range does.'
      };
    }

    return { spot, views, se, guidance, yetToAct: yetIds.length, fairShare, realized, raw: hw.eq, realization: rz, inPotIds, scenarios: hw.scenarios };
  }

  /* ---------- P3: explainable breakdown (unchanged concept) ---------- */
  function equityBreakdown(heroHole, board, trackers, iters) {
    iters = iters || 500;
    const ids = Object.keys(trackers);
    if (!ids.length || board.length === 5) return null;
    const used0 = new Set([...heroHole, ...board].map(c => c.id));
    const B = {
      beating: { label: 'Hands beating you now', share: 0, eqSum: 0 },
      worseMade: { label: 'Worse made hands', share: 0, eqSum: 0 },
      draws: { label: 'Draws / overcards', share: 0, eqSum: 0 },
      air: { label: 'Air / nothing', share: 0, eqSum: 0 },
      chop: { label: 'Chops', share: 0, eqSum: 0 }
    };
    let tot = 0;
    for (let it = 0; it < iters; it++) {
      const used = new Set(used0);
      const vhs = [];
      let ok = true;
      for (const id of ids) {
        const h = trackers[id].sample(used, Math.random);
        if (!h) { ok = false; break; }
        used.add(h[0].id); used.add(h[1].id); vhs.push(h);
      }
      if (!ok) continue;
      const remaining = PT.math.fullDeckMinus([...heroHole, ...board, ...vhs.flat()]);
      const runout = board.slice();
      while (runout.length < 5) runout.push(remaining[Math.floor(Math.random() * remaining.length)]);
      const heroNow = board.length >= 3 ? PT.eval.bestHand([...heroHole, ...board]) : null;
      const heroFinal = PT.eval.bestHand([...heroHole, ...runout]);
      for (const vh of vhs) {
        tot++;
        const vNow = board.length >= 3 ? PT.eval.bestHand([...vh, ...board]) : null;
        const vFinal = PT.eval.bestHand([...vh, ...runout]);
        const cmpFinal = PT.eval.compareRank(heroFinal, vFinal);
        const eqOutcome = cmpFinal > 0 ? 1 : cmpFinal === 0 ? 0.5 : 0;
        let bucket;
        if (heroNow && vNow) {
          const cmpNow = PT.eval.compareRank(heroNow, vNow);
          if (cmpFinal === 0) bucket = 'chop';
          else if (cmpNow < 0) bucket = 'beating';
          else if (vNow[0] >= 1) bucket = 'worseMade';
          else if (cmpFinal < 0) bucket = 'draws';
          else bucket = 'air';
        } else {
          bucket = cmpFinal < 0 ? 'beating' : cmpFinal === 0 ? 'chop' : 'worseMade';
        }
        B[bucket].share++;
        B[bucket].eqSum += eqOutcome;
      }
    }
    if (!tot) return null;
    const buckets = Object.values(B).filter(b => b.share > 0).map(b => ({
      label: b.label, share: b.share / tot, eq: b.eqSum / b.share
    }));
    const formula = buckets.map(b => `(${pct(b.share)} × ${pct(b.eq)})`).join(' + ');
    const total = buckets.reduce((s, b) => s + b.share * b.eq, 0);
    return { buckets, formula, total };
  }

  // Multiway mental shortcut (brief P3): product of HU equities for made hands.
  function multiwayShortcut(heroHole, board, trackers, ids) {
    if (ids.length < 2) return null;
    let prod = 1;
    for (const id of ids) prod *= eqField(heroHole, board, trackers, [id], 400) ?? 0.5;
    return prod;
  }

  PT.spot = {
    analyze, equityBreakdown, findAggressor, realizationFactor, handClass,
    headlineEquity, playersInForBet, continueProbs, multiwayShortcut
  };
})(window.PT = window.PT || {});
