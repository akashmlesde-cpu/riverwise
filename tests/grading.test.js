// grading.test.js — range-based grading discriminates good and bad decisions.
global.window = {};
for (const f of ['deck', 'evaluator', 'pokermath', 'ranges', 'engine', 'opponents', 'coach', 'spot', 'stats']) require('../js/' + f + '.js');
const PT = global.window.PT;
let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) failures++; };
const card = (r, s) => ({ rank: r, suit: s, ri: PT.RANKS.indexOf(r), si: PT.SUITS.indexOf(s), id: r + s });

function mkEngine(villainArchetype) {
  const e = new PT.HoldemEngine({
    seats: [{ name: 'You', archetype: 'tag', isHero: true }, { name: 'Villain', archetype: villainArchetype }],
    stackBB: 100, sb: 0.5, bb: 1
  });
  ['log', 'hand', 'turn', 'street', 'done'].forEach(t => e.on(t, () => {}));
  e.newHand();
  return e;
}

// Heads-up: seat 0 (hero) is BTN+SB, acts FIRST preflop. Villain is BB.
// Scenario A: hero open-limps-ish call, villain (nit) raises big, hero folds 72o.
{
  const e = mkEngine('nit');
  const h = e.players[0];
  h.hole = [card('7', '♣'), card('2', '♦')];
  e.act(0, 'call');                    // hero limps
  e.act(1, 'raise', 6);                // nit raises to 6
  const view = e.coachView();          // hero to act, facing 5 more
  const v = PT.coach.grade(view, 0, 'fold', undefined, 'Essential');
  check('fold 72o vs nit 6x raise = good/excellent', ['excellent', 'good', 'marginal'].includes(v.grade), v.label);
}

// Scenario B: same spot, hero shoves 72o — should be a mistake/blunder.
{
  const e = mkEngine('nit');
  e.players[0].hole = [card('7', '♣'), card('2', '♦')];
  e.act(0, 'call');
  e.act(1, 'raise', 6);
  const view = e.coachView();
  const v = PT.coach.grade(view, 0, 'raise', 100, 'Essential');
  check('shove 72o vs nit raise = mistake/blunder', ['mistake', 'blunder'].includes(v.grade), v.label);
}

// Scenario C: river, hero has K-high, station bets small.
// Correct behavior: fold is right when equity (~7%) << required (~18%);
// calling must be the mistake.
{
  const e = mkEngine('station');
  e.players[0].hole = [card('K', '♠'), card('Q', '♠')];
  e.act(0, 'bet', 3); e.act(1, 'call');
  e.board = [card('2', '♦'), card('7', '♣'), card('9', '♥'), card('J', '♦'), card('3', '♣')];
  e.street = 'river';
  for (const p of e.players) { p.streetBet = 0; p.acted = p.folded || p.allIn; }
  e.currentBet = 0;
  e.act(1, 'bet', 2); // station bets 2 into ~7
  const view = e.coachView();
  const vFold = PT.coach.grade(view, 0, 'fold', undefined, 'Essential');
  const vCall = PT.coach.grade(view, 0, 'call', undefined, 'Essential');
  check('fold KQ-high vs station river bet with 7% equity = excellent/good', ['excellent', 'good'].includes(vFold.grade), vFold.label);
  check('calling with 7% vs 18% required = mistake/blunder', ['mistake', 'blunder'].includes(vCall.grade), vCall.label);
}

// Scenario D: villain range narrows after nit raises — breakdown should be value-heavy.
{
  const e = mkEngine('nit');
  e.players[0].hole = [card('A', '♠'), card('K', '♦')];
  e.act(0, 'call');
  e.act(1, 'raise', 6);
  const view = e.coachView();
  const trackers = PT.coach.buildVillainRanges(view, 0);
  const bd = trackers[1].breakdown([]);
  check('nit raise range is value-heavy', bd.value > 0.5, JSON.stringify(bd));
}

// A 4-bet vs an opener + 3-bettor must get realistic folds (the 3-bettor's range is already
// narrow, so it was modelled as never folding: ~2% fold equity).
{
  const seats = [{ name: 'You', archetype: 'tag', isHero: true }, ...[['Mara', 'tag'], ['Ben', 'station'], ['Sofia', 'nit'], ['Theo', 'lag'], ['Iris', 'adaptive']].map(([name, archetype]) => ({ name, archetype }))];
  const e = new PT.HoldemEngine({ seats, stackBB: 100, sb: 0.5, bb: 1 });
  ['log', 'hand', 'turn', 'street', 'done'].forEach(t => e.on(t, () => {}));
  e.newHand();
  e.players[0].hole = [card('7', '♠'), card('5', '♣')];
  e.act(3, 'fold'); e.act(4, 'raise', 2.5); e.act(5, 'raise', 7.5);
  const ev = PT.coach.evaluateActions(e.coachView(), 0);
  const raise = ev.actions.find(a => a.action === 'raise');
  check('4-bet vs open + 3-bet gets 25-70% folds', raise.foldEq > 0.25 && raise.foldEq < 0.7, (raise.foldEq * 100).toFixed(0) + '%');
  check('75o still folds to a 3-bet', ev.best.action === 'fold', ev.best.action);
}

console.log(failures === 0 ? '\nALL GRADING TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
