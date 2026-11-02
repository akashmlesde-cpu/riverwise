// brief.test.js — regression hands A–H: equity framing, realization, street-specific coaching.
global.window = {};
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
for (const f of ['deck', 'evaluator', 'pokermath', 'ranges', 'engine', 'opponents', 'coach', 'spot', 'calibration', 'stats']) require('../js/' + f + '.js');
const PT = global.window.PT;
let failures = 0;
const check = (n, c, extra) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' — ' + extra : '')); if (!c) failures++; };
const card = (r, s) => ({ rank: r, suit: s, ri: PT.RANKS.indexOf(r), si: PT.SUITS.indexOf(s), id: r + s });
const mk = (villains, heroFirst) => {
  const seats = [{ name: 'You', archetype: 'tag', isHero: true }, ...villains.map((v, i) => ({ name: v.name || 'V' + i, archetype: v.archetype }))];
  const e = new PT.HoldemEngine({ seats, stackBB: 100, sb: 0.5, bb: 1 });
  ['log', 'hand', 'turn', 'street', 'done'].forEach(t => e.on(t, () => {}));
  e.newHand();
  return e;
};

// The user's real hand: hero A♦T♥ opens BTN, both call; flop 6♣T♦6♦ Ben bets,
// Theo calls, hero raises to 27.3, both call; turn 4♠ Ben bets 38, Theo calls.
function realHandAT() {
  const e = mk([{ name: 'Ben', archetype: 'elite' }, { name: 'Theo', archetype: 'elite' }]);
  e.players[0].hole = [card('A', '♦'), card('T', '♥')];
  e.act(0, 'raise', 4.5); e.act(1, 'call'); e.act(2, 'call');
  e.board = [card('6', '♣'), card('T', '♦'), card('6', '♦')];
  e.act(1, 'bet', 4.5); e.act(2, 'call'); e.act(0, 'raise', 27.3); e.act(1, 'call'); e.act(2, 'call');
  e.board = [card('6', '♣'), card('T', '♦'), card('6', '♦'), card('4', '♠')];
  e.act(1, 'bet', 38); e.act(2, 'call');
  return e;
}

/* A. Facing a bet with a caller already in: headline must include BOTH villains. */
{
  const e = realHandAT();
  const view = e.coachView();
  const ev = PT.coach.evaluateActions(view, 0);
  const spot = PT.spot.analyze(view, 0, ev);
  const req = PT.math.potOdds(ev.toCall, ev.pot);
  check('A: in-pot includes bettor AND caller', spot.inPotIds.length === 2, JSON.stringify(spot.inPotIds));
  const huBettor = PT.coach.equityVsField(view.players[0].hole, view.board, { 1: ev.trackers[1] }, 1500);
  check('A: equity vs both is below equity vs bettor alone', spot.raw < huBettor, `both=${(spot.raw * 100).toFixed(1)}% bettorOnly=${(huBettor * 100).toFixed(1)}%`);
  check('A: decision follows realized vs required', (spot.realized > req) === (ev.best.action !== 'fold'), `realized=${(spot.realized * 100).toFixed(1)}% req=${(req * 100).toFixed(1)}% best=${ev.best.action}`);
  check('A: guidance does not say "aggressor only" decides', !/Use the aggressor/.test(spot.guidance.teach));
}

/* B. Turn all-in review: EV(shove) uses F and E vs calling ranges; grade follows EV. */
{
  const e = realHandAT();
  const view = e.coachView();
  const ev = PT.coach.evaluateActions(view, 0);
  const raiseActs = ev.actions.filter(a => a.action === 'raise');
  check('B: raise actions carry foldEq + eqCalled', raiseActs.length > 0 && raiseActs.every(a => a.foldEq != null && a.eqCalled != null));
  const gradeRaise = PT.coach.grade(view, 0, 'raise', 81, 'Essential');
  const gradeFold = PT.coach.grade(view, 0, 'fold', undefined, 'Essential');
  const bestIsFold = ev.best.action === 'fold';
  check('B: grade follows EV ranking', bestIsFold ? ['excellent', 'good'].includes(gradeFold.grade) && ['mistake', 'blunder', 'marginal'].includes(gradeRaise.grade) : true,
    `best=${ev.best.action}, raiseGrade=${gradeRaise.label}, foldGrade=${gradeFold.label}`);
}

/* C. Strong made hand IP: realization ≥95% of raw. */
{
  const e = mk([{ name: 'Ben', archetype: 'elite' }, { name: 'Theo', archetype: 'elite' }]);
  e.players[0].hole = [card('A', '♦'), card('T', '♥')];
  const board = [card('6', '♣'), card('T', '♦'), card('6', '♦')];
  // hero on BTN, in position, top pair top kicker
  const view = { ...e.coachView(), board, street: 'flop' };
  const rz = PT.spot.realizationFactor(view, 0);
  check('C: TPTK IP realization ≥ 0.95', rz.factor >= 0.95, `factor=${rz.factor} (${rz.reason})`);
  check('C: river realization is 1.0', PT.spot.realizationFactor({ ...view, street: 'river' }, 0).factor === 1);
}

/* D. Unopened pot: open/fold framing, no pot odds, break-even fold %. */
{
  const e = mk([{ name: 'Ben', archetype: 'nit' }, { name: 'Theo', archetype: 'nit' }]);
  e.players[0].hole = [card('5', '♥'), card('4', '♠')];
  const view = e.coachView(); // preflop, hero BTN first to act
  const ev = PT.coach.evaluateActions(view, 0);
  const spot = PT.spot.analyze(view, 0, ev);
  check('D: spot = unopened', spot.spot === 'unopened', spot.spot);
  check('D: guidance mentions break-even fold %, not pot odds', /all fold|everyone folds/.test(spot.guidance.metric) && !/Required equity/.test(spot.guidance.metric));
  check('D: limp (call) still graded but never the RECOMMENDED action for 54o', ev.best.action !== 'call', `best=${ev.best.action}`);
}

/* E. Preflop facing raise with blinds behind: scenario-weighted, realized; fold. */
{
  const e = mk([{ name: 'UTG', archetype: 'tag' }, { name: 'SB', archetype: 'tag' }, { name: 'BB', archetype: 'tag' }]);
  // 4-max: seats 0 hero... make hero BTN: players 0=You(BTN), 1=UTG? In 4-max order: BTN, SB, BB, UTG.
  e.players[0].hole = [card('T', '♥'), card('6', '♠')];
  // UTG (last seat) opens; hero faces it with blinds behind
  e.act(3, 'raise', 4); // seat 3 = UTG acts first preflop in 4-max
  const view = e.coachView();
  const ev = PT.coach.evaluateActions(view, 0);
  const spot = PT.spot.analyze(view, 0, ev);
  const req = PT.math.potOdds(ev.toCall, ev.pot);
  const noise = 0.15 + 0.04 * ev.pot;
  check('E: T6o vs UTG raise, blinds behind → fold (a 3-bet bluff at most ties)', spot.realized < req && ev.best.action !== 'call' && (ev.best.action === 'fold' || ev.best.ev < noise),
    `realized=${(spot.realized * 100).toFixed(1)}% req=${(req * 100).toFixed(1)}% best=${ev.best.action} ${ev.best.ev.toFixed(2)}`);
  check('E: scenarios computed for yet-to-act blinds', spot.scenarios.length >= 1, `${spot.scenarios.length} scenarios`);
}

/* F. River: river framing, no pot odds, value-bet test mentioned. */
{
  const e = mk([{ name: 'Ben', archetype: 'station' }]);
  e.players[0].hole = [card('K', '♣'), card('T', '♦')];
  e.board = [card('T', '♠'), card('5', '♣'), card('2', '♥'), card('A', '♥'), card('A', '♠')];
  e.street = 'river';
  for (const p of e.players) { p.streetBet = 0; p.acted = false; }
  e.currentBet = 0;
  e.act(1, 'check');
  const view = e.coachView();
  const ev = PT.coach.evaluateActions(view, 0);
  const spot = PT.spot.analyze(view, 0, ev);
  check('F: spot = river', spot.spot === 'river');
  check('F: value-bet test in verdict', /Value-bet test/.test(spot.guidance.verdict));
  check('F: no pot odds in river framing', !/Required equity/.test(spot.guidance.metric));
}

/* G. Decision vs result: a clearly -EV call is graded a mistake regardless of runout. */
{
  const e = realHandAT();
  e.players[0].hole = [card('8', '♣'), card('2', '♥')];
  const view = e.coachView();
  const v = PT.coach.grade(view, 0, 'call', undefined, 'Essential');
  check('G: calling 38 with 8-high vs bet+caller on 6T64 = mistake/blunder', ['mistake', 'blunder'].includes(v.grade), v.label);
}

/* H. Calibration: showdown with out-of-range hand gets flagged. */
{
  PT.calibration.reset();
  const tracker = new PT.ranges.RangeTracker('elite', 'late');
  tracker.update('preflop', '3bet', [], 0); // very strong range
  const fakePlayer = { name: 'Ben', archetype: 'elite', hole: [card('K', '♠'), card('6', '♠')] };
  PT.calibration.recordShowdown(fakePlayer, tracker);
  const report = PT.calibration.report();
  check('H: K6s in a 3bet elite range flagged as calibration miss', /miss/.test(report) && report.includes('K♠ 6♠'), report.split('\n').slice(-1)[0]);
}

console.log(failures === 0 ? '\nALL BRIEF TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
