// cards.test.js — coaching-card regressions: grade, EV ranking and text must agree.
global.window = {};
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
for (const f of ['deck', 'evaluator', 'pokermath', 'ranges', 'engine', 'opponents', 'coach', 'spot', 'llm', 'stats']) require('../js/' + f + '.js');
const PT = global.window.PT;
let failures = 0;
const check = (n, c, extra) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' — ' + extra : '')); if (!c) failures++; };
const card = (r, s) => ({ rank: r, suit: s, ri: PT.RANKS.indexOf(r), si: PT.SUITS.indexOf(s), id: r + s });
const VERBOSE = process.argv.includes('-v');

// 6-max, Mara on the button: Ben SB, Sofia BB, Theo UTG, Iris HJ, hero CO.
function cardOneSpot() {
  const seats = [{ name: 'You', archetype: 'tag', isHero: true },
    { name: 'Mara', archetype: 'elite' }, { name: 'Ben', archetype: 'elite' }, { name: 'Sofia', archetype: 'elite' },
    { name: 'Theo', archetype: 'elite' }, { name: 'Iris', archetype: 'adaptive' }];
  const e = new PT.HoldemEngine({ seats, stackBB: 100, sb: 0.5, bb: 1 });
  ['log', 'hand', 'turn', 'street', 'done'].forEach(t => e.on(t, () => {}));
  e.button = 0;
  e.newHand();
  e.players[0].hole = [card('T', '♦'), card('K', '♣')];
  e.act(4, 'fold'); e.act(5, 'call');
  return e;
}

/* Card 1: KTo iso-raise in the CO over a limp, three players yet to act. */
{
  const e = cardOneSpot();
  const view = e.coachView();
  check('card1 setup: hero CO, Mara/Ben/Sofia yet to act', e.positionName(0) === 'CO' && e.current === 0, e.positionName(0));
  const v = PT.coach.grade(view, 0, 'raise', 4.5, 'Pro');
  const raise = v.chosen;
  if (VERBOSE) { console.log('   ', v.label, '|', v.plain); v.lines.forEach(l => console.log('     ', l)); }
  check('card1: iso-raise KTo graded good/excellent', ['excellent', 'good'].includes(v.grade), v.label);
  check('card1: raise priced with fold equity (F and E present)', raise.foldEq != null && raise.eqCalled != null, `F=${raise.foldEq} E=${raise.eqCalled}`);
  check('card1: no call pot-odds line for a raise', !v.lines.some(l => /^Pot odds: call/.test(l)));
  check('card1: no "calling with dominated hands" tip on a raise', !/calling with dominated/.test(v.plain));
  const tr = PT.coach.buildVillainRanges(view, 0);
  const bdBen = tr[2].breakdown([]);
  check('card1: yet-to-act blind range includes weak hands', bdBen.air > 0.4, JSON.stringify(bdBen));
}

/* Card 3 class: when the chosen action has lower EV than the best, text must not claim it is better. */
{
  const e = cardOneSpot();
  e.players[0].hole = [card('7', '♦'), card('3', '♣')];
  const view = e.coachView();
  const v = PT.coach.grade(view, 0, 'raise', 4.5, 'Essential');
  const foldEV = v.ev.actions.find(a => a.action === 'fold').ev;
  const noise = 0.15 + 0.04 * v.ev.pot;
  if (VERBOSE) console.log('   ', v.label, '| best', v.best.action, v.best.ev.toFixed(2), '| chosen', v.chosen.ev.toFixed(2), '|', v.plain);
  check('card3: 73o iso-raise is not meaningfully better than folding', v.chosen.ev - foldEV < noise, `raise=${v.chosen.ev.toFixed(2)} fold=${foldEV.toFixed(2)}`);
  check('card3: text never calls the raise better when its EV is not higher', !/better/i.test(v.plain) && (/worse than/i.test(v.plain) || /close decision/i.test(v.plain)), v.plain);
  check('card3: a raise below fold EV is never graded Good/Excellent', !(v.chosen.ev < foldEV - 0.05 && ['excellent', 'good'].includes(v.grade)), v.label);
}

/* Card 2 class: fold where raw equity beats the price but realized equity does not. */
{
  const e = cardOneSpot();
  e.players[0].hole = [card('Q', '♠'), card('4', '♦')];
  const view = e.coachView();
  const v = PT.coach.grade(view, 0, 'fold', undefined, 'Essential');
  if (VERBOSE) { console.log('   ', v.label, '|', v.plain); v.lines.forEach(l => console.log('     ', l)); }
  check('card2: fold text never says the hand "plays well"', !/plays well/.test(v.plain), v.plain);
  check('card2: equity line shows raw and realized', v.lines.some(l => /raw .* realized/i.test(l)));
}

/* Validator: grade/EV consistency and invented numbers. */
{
  const ctx = { verdict: 'Good', numbers: 'EV raise -0.2, fold 0.0, need 29%', chosenIsBest: false, chosenAction: 'raise', bestAction: 'fold', evTable: 'fold=0.0BB, raise=-0.2BB' };
  check('validator rejects "raising is better than folding" when fold is best', !PT.llm.validateExplanation('Raising is better than folding here.', ctx));
  check('validator rejects numbers not in the facts', !PT.llm.validateExplanation('You had 61% equity, so fold.', { ...ctx, chosenIsBest: true }));
  check('validator accepts grounded text', PT.llm.validateExplanation('Folding at 0.0 BB beats the raise at -0.2 BB since you need 29% equity.', { ...ctx, chosenIsBest: true, chosenAction: 'fold' }));
}

console.log(failures === 0 ? '\nALL CARD TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
