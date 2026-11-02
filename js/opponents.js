/* opponents.js — opponent styles and the built-in opponent AI.
 * Preflop: each style plays its own ranges (ARCHETYPES[].pre), the same ranges the coach uses to read it.
 * Postflop: equity vs opponents' ranges narrowed by their actions, adjusted per style. Weaker styles
 * misjudge strength (skill-based noise); that's what makes them exploitable.
 */
(function (PT) {
  // pre: preflop ranges as "top x% of hands". open = raise first in [early, late, blinds];
  // limp = extra hands limped first in; threeBet / flat = re-raise / call vs one raise; call3 = call vs a 3-bet.
  const ARCHETYPES = {
    recreational: { label: 'Recreational', loose: 0.46, agg: 0.30, bluff: 0.15, skill: 0.30,
      pre: { open: [0.10, 0.16, 0.12], limp: 0.22, threeBet: 0.04, flat: 0.24, call3: 0.10 } },
    station:      { label: 'Calling station', loose: 0.55, agg: 0.12, bluff: 0.04, skill: 0.25,
      pre: { open: [0.05, 0.07, 0.05], limp: 0.40, threeBet: 0.025, flat: 0.38, call3: 0.18 } },
    nit:          { label: 'Nit', loose: 0.14, agg: 0.35, bluff: 0.06, skill: 0.50,
      pre: { open: [0.08, 0.14, 0.10], limp: 0, threeBet: 0.03, flat: 0.05, call3: 0.03 } },
    lag:          { label: 'Loose-aggressive', loose: 0.40, agg: 0.72, bluff: 0.30, skill: 0.65,
      pre: { open: [0.22, 0.48, 0.38], limp: 0, threeBet: 0.11, flat: 0.14, call3: 0.08 } },
    tag:          { label: 'Solid TAG', loose: 0.24, agg: 0.55, bluff: 0.15, skill: 0.78,
      pre: { open: [0.14, 0.32, 0.25], limp: 0, threeBet: 0.06, flat: 0.09, call3: 0.05 } },
    gto:          { label: 'GTO / math-heavy', loose: 0.27, agg: 0.60, bluff: 0.22, skill: 0.90,
      pre: { open: [0.16, 0.38, 0.30], limp: 0, threeBet: 0.08, flat: 0.10, call3: 0.06 } },
    live:         { label: 'Exploitative live pro', loose: 0.30, agg: 0.50, bluff: 0.20, skill: 0.75,
      pre: { open: [0.15, 0.36, 0.26], limp: 0, threeBet: 0.07, flat: 0.12, call3: 0.06 } },
    pressure:     { label: 'Pressure pro', loose: 0.34, agg: 0.80, bluff: 0.30, skill: 0.85,
      pre: { open: [0.20, 0.45, 0.35], limp: 0, threeBet: 0.12, flat: 0.08, call3: 0.07 } },
    elite:        { label: 'Elite balanced pro', loose: 0.28, agg: 0.65, bluff: 0.24, skill: 0.95,
      pre: { open: [0.16, 0.38, 0.30], limp: 0, threeBet: 0.09, flat: 0.10, call3: 0.06 } },
    adaptive:     { label: 'Adaptive (exploits you)', loose: 0.28, agg: 0.60, bluff: 0.22, skill: 0.85, adaptive: true,
      pre: { open: [0.16, 0.36, 0.28], limp: 0, threeBet: 0.08, flat: 0.10, call3: 0.06 } }
  };

  const AI_NAMES = ['Mara', 'Ben', 'Sofia', 'Theo', 'Iris', 'Owen', 'Nia', 'Vik'];
  const DEFAULT_LINEUP = ['tag', 'station', 'nit', 'lag', 'adaptive', 'recreational', 'gto', 'pressure'];

  // Build range trackers for everyone EXCEPT `seat`, from the hand's actions.
  // The bot can't see hero's cards — only the range hero's actions imply.
  function opponentTrackers(engine, seat) {
    const trackers = {};
    for (const p of engine.players) {
      if (p.id === seat || p.folded) continue;
      trackers[p.id] = new PT.ranges.RangeTracker(p.isHero ? 'tag' : p.archetype, PT.ranges.positionClass(engine, p.id));
    }
    return PT.ranges.replay(engine, trackers);
  }

  // Bot's equity estimate: vs narrowed ranges of remaining opponents (postflop only).
  // Weak bots add optimistic noise (they misjudge ranges) — that's their leak.
  function estimateEquity(engine, seat, prof) {
    const p = engine.players[seat];
    const trackers = opponentTrackers(engine, seat);
    const ids = Object.keys(trackers);
    if (!ids.length) return 1;
    const iters = 300;
    const eq = PT.coach.equityVsField(p.hole, engine.board, trackers, iters);
    if (eq == null) return 0.5;
    const bias = (1 - prof.skill) * 0.15;   // weak players overestimate
    return Math.max(0.02, Math.min(0.98, eq + bias));
  }

  const handKey = hole => {
    const [a, b] = hole.slice().sort((x, y) => y.ri - x.ri);
    return a.ri === b.ri ? a.rank + b.rank : a.rank + b.rank + (a.si === b.si ? 's' : 'o');
  };

  // Round to sizes people actually use (0.5 BB steps when small, whole BBs above 10), kept legal.
  function niceSize(x, L) {
    const step = x < 10 ? 0.5 : 1;
    let v = Math.round(x / step) * step;
    if (v < L.minBetTo) v = Math.ceil(L.minBetTo / step) * step;
    return Math.min(v, L.maxBetTo);
  }

  function preflopDecision(engine, seat, prof, L) {
    const p = engine.players[seat];
    const pos = PT.ranges.positionClass(engine, seat);
    const plan = PT.ranges.preflopPlan(prof, pos);
    const pre = engine.history.filter(h => h.street === 'preflop');
    const raises = pre.filter(h => / raises to /.test(h.text)).length;
    const lastRaise = pre.map(h => / raises to /.test(h.text)).lastIndexOf(true);
    const callers = pre.slice(lastRaise + 1).filter(h => / calls /.test(h.text)).length;
    // Weaker players misjudge hand strength; everyone mixes a little near the edge of a range.
    const pctl = PT.ranges.PREFLOP_PCTL[handKey(p.hole)] * (1 + (Math.random() - 0.5) * (0.15 + 0.5 * (1 - prof.skill)));
    const bb = engine.cfg.bb;
    const raiseTo = x => {
      const to = x > 0.4 * (p.stack + p.streetBet) ? L.maxBetTo : niceSize(x, L);
      return { action: engine.currentBet > 0 ? 'raise' : 'bet', betTo: to };
    };
    const giveUp = L.canCheck ? { action: 'check' } : { action: 'fold' };

    if (raises === 0) {
      if (L.canBetRaise && pctl < plan.open) return raiseTo(((pos === 'late' ? 2.5 : 3) + callers) * bb);
      if (pctl < plan.enter) return L.canCheck ? { action: 'check' } : { action: 'call' };
      return giveUp;
    }
    if (raises === 1) {
      if (L.canBetRaise && pctl < plan.threeBet) return raiseTo(engine.currentBet * ((pos === 'blinds' ? 4 : 3) + callers));
      if (pctl < plan.threeBet + plan.flat) return { action: 'call' };
      return giveUp;
    }
    if (L.canBetRaise && pctl < plan.fourBet) return raiseTo(engine.currentBet * 2.3);
    if (pctl < plan.fourBet + plan.call3) return { action: 'call' };
    return giveUp;
  }

  function decide(engine, seat, heroStats) {
    const p = engine.players[seat];
    const prof = ARCHETYPES[p.archetype];
    const L = engine.legal(seat);
    if (engine.street === 'preflop') return preflopDecision(engine, seat, prof, L);
    const pot = engine.pot();
    const nLive = engine.livePlayers().length - 1; // opponents still in
    const multiway = nLive >= 2;

    const e = estimateEquity(engine, seat, prof);
    const noise = (Math.random() - 0.5) * 0.20 * (1 - prof.skill);
    const eff = Math.max(0.02, Math.min(0.98, e + noise));

    let { loose, agg, bluff } = prof;
    if (prof.adaptive && heroStats && heroStats.hands >= 10) {
      if (heroStats.foldToBet() > 0.6) { bluff += 0.15; agg += 0.1; }
      if (heroStats.vpip() > 0.45) loose -= 0.08;
      if (heroStats.vpip() < 0.18) bluff += 0.08;
    }

    const raiseTo = (mult) => niceSize(engine.currentBet + engine.minRaise * mult, L);
    const betTo = (frac) => niceSize(Math.max(frac * pot, engine.cfg.bb), L);

    if (L.toCall > 0) {
      const odds = PT.math.potOdds(L.toCall, pot);
      // Continue threshold: pot odds, loosened by archetype, TIGHTENED multiway.
      let threshold = odds * (1.05 - loose * 0.55);
      if (multiway) threshold *= (1 + 0.35 * (nLive - 1)); // need more vs 2+
      // stations override: they call with anything (that's their leak)
      if (p.archetype === 'station') threshold = odds * 0.45;

      const raiseScore = 0.78 - agg * 0.18 + (multiway ? 0.06 : 0);
      if (L.canBetRaise && eff >= raiseScore && Math.random() < 0.35 + agg * 0.55)
        return { action: 'raise', betTo: raiseTo(2.5 + agg) };
      // bluff-raise: suppressed multiway (suicide into 2+ shown strength)
      if (L.canBetRaise && !multiway && eff < 0.30 && Math.random() < bluff * 0.25)
        return { action: 'raise', betTo: raiseTo(2.5) };
      if (eff > threshold) return { action: 'call' };
      return { action: 'fold' };
    }

    // Postflop, nobody bet: value bet or bluff (bluffs smaller + rarer multiway)
    const valueScore = 0.62 + (multiway ? 0.08 : 0);
    if (L.canBetRaise && eff >= valueScore && Math.random() < 0.30 + agg * 0.6)
      return { action: 'bet', betTo: betTo(0.35 + agg * 0.45) };
    if (L.canBetRaise && eff < 0.32 && Math.random() < bluff * (multiway ? 0.15 : 0.45))
      return { action: 'bet', betTo: betTo(multiway ? 0.4 : 0.5) };
    return { action: 'check' };
  }

  PT.opponents = { ARCHETYPES, AI_NAMES, DEFAULT_LINEUP, decide, opponentTrackers, estimateEquity, handKey, niceSize };
})(window.PT = window.PT || {});
