// engine.test.js — headless engine smoke tests: full hands, chip conservation, side pots.
global.window = {};
for (const f of ['deck', 'evaluator', 'pokermath', 'ranges', 'engine', 'opponents', 'coach', 'spot', 'stats']) {
  require('../js/' + f + '.js');
}
const PT = global.window.PT;
let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) failures++; };

// 1) Run 25 full hands with AI deciding for every seat; verify chip conservation.
const seats = [{ name: 'H', archetype: 'tag', isHero: true }];
['nit', 'station', 'lag', 'tag', 'adaptive'].forEach((a, i) => seats.push({ name: 'AI' + i, archetype: a }));

// 0) A 'bet' sent while facing a bet (e.g. from an AI) is logged as a raise, so range tracking sees it.
{
  const e = new PT.HoldemEngine({ seats, stackBB: 100, sb: 0.5, bb: 1 });
  ['log', 'hand', 'turn', 'street', 'done'].forEach(t => e.on(t, () => {}));
  e.newHand();
  const s = e.current;
  e.act(s, 'bet', 3);
  check('preflop "bet" over the blind is logged as "raises to"', / raises to 3 BB/.test(e.history[e.history.length - 1].text));
}
const eng = new PT.HoldemEngine({ seats, stackBB: 100, sb: 0.5, bb: 1 });
let done = 0, chipOK = true, illegalRejections = 0;
eng.on('log', () => {});
eng.on('hand', () => {});
eng.on('street', () => {});
eng.on('turn', (seat) => {
  if (eng.over || seat === -1) return;
  const d = PT.opponents.decide(eng, seat, null);
  const r = eng.act(seat, d.action, d.betTo);
  if (!r.ok) { illegalRejections++; console.error('AI action rejected:', r.error, JSON.stringify(d)); }
});
eng.on('done', () => {
  done++;
  const total = eng.players.reduce((s, p) => s + p.stack, 0);
  if (Math.abs(total - 600) > 0.51) { chipOK = false; console.error('CHIP LEAK hand', done, ':', total); }
  if (done < 25) eng.newHand(); else finish();
});
eng.newHand();

function finish() {
  check('25 hands completed', done === 25);
  check('chip conservation', chipOK);
  check('no AI action rejected as illegal', illegalRejections === 0);

  // 1b) Bots play their style's preflop ranges and real-world sizes.
  {
    const dealt = n => { const e = new PT.HoldemEngine({ seats, stackBB: 100, sb: 0.5, bb: 1 }); ['log', 'hand', 'turn', 'street', 'done'].forEach(t => e.on(t, () => {})); e.newHand(); return e; };
    const firstIn = (style, n) => {
      let played = 0, odd = 0;
      for (let i = 0; i < n; i++) {
        const e = dealt();
        const s = e.current;
        e.players[s].archetype = style;
        const d = PT.opponents.decide(e, s, null);
        if (d.action !== 'fold' && d.action !== 'check') played++;
        if (d.betTo && Math.abs(d.betTo * 2 - Math.round(d.betTo * 2)) > 1e-9) odd++;
      }
      return { played: played / n, odd };
    };
    const nit = firstIn('nit', 400), lag = firstIn('lag', 400), station = firstIn('station', 400);
    check(`nit plays few hands first in (${(nit.played * 100).toFixed(0)}%)`, nit.played < 0.2);
    check(`LAG plays more than a nit (${(lag.played * 100).toFixed(0)}%)`, lag.played > nit.played * 1.8);
    check(`station limps/plays wide (${(station.played * 100).toFixed(0)}%)`, station.played > 0.3);
    check('bot open sizes are on 0.5 BB steps', nit.odd + lag.odd + station.odd === 0);
  }

  // 2) Side pots: A=20, B=50, C=100 -> pots 60/60/50
  const e = new PT.HoldemEngine({ seats: [{ name: 'A', archetype: 'nit', isHero: true }, { name: 'B', archetype: 'nit' }, { name: 'C', archetype: 'nit' }], stackBB: 100, sb: 0.5, bb: 1 });
  e.players[0].totalBet = 20; e.players[1].totalBet = 50; e.players[2].totalBet = 100;
  const pots = e.buildPots();
  check('side pot amounts 60/60/50', JSON.stringify(pots.map(p => p.amount)) === '[60,60,50]');
  check('side pot eligibility', JSON.stringify(pots.map(p => p.eligible)) === '[[0,1,2],[1,2],[2]]');

  // 3) Info isolation: coachView must never contain villain hole cards mid-hand
  e.newHand();
  const cv = e.coachView();
  check('coachView hides villain cards', cv.players.every(p => p.isHero || !p.hole));
  check('coachView shows hero cards', !!cv.players[0].hole && cv.players[0].hole.length === 2);

  // 4) Equity sanity: AA vs one random hand ~85%
  const AA = [{ rank: 'A', suit: '♠', ri: 12, si: 0, id: 'A♠' }, { rank: 'A', suit: '♥', ri: 12, si: 1, id: 'A♥' }];
  const eq = PT.math.equity(AA, [], 1, 3000);
  console.log('   AA equity vs 1 random:', eq.equity.toFixed(3));
  check('AA vs random 80-90%', eq.equity > 0.80 && eq.equity < 0.90);

  // 5) Pot odds math: risk 50 to win (100+50) -> 50/150 = 33.3%
  check('pot odds 50 into 100 = 33.3%', Math.abs(PT.math.potOdds(50, 100) - 1 / 3) < 1e-9);
  check('MDF 100 pot 50 bet = 66.7%', Math.abs(PT.math.mdf(100, 50) - 2 / 3) < 1e-9);

  // 6) Coach grades a clear over-fold preflop as a mistake
  const e2 = new PT.HoldemEngine({ seats: [{ name: 'You', archetype: 'tag', isHero: true }, { name: 'Nit', archetype: 'nit' }], stackBB: 100, sb: 0.5, bb: 1 });
  e2.on('log', () => {}); e2.on('hand', () => {}); e2.on('turn', () => {}); e2.on('street', () => {}); e2.on('done', () => {});
  e2.newHand();
  // hero is button/SB heads-up; force a fold with AA preflop and grade it
  e2.players[heroIdx(e2)].hole = AA.map(c => ({ ...c }));
  const view = e2.coachView();
  const v = PT.coach.grade(view, heroIdx(e2), 'fold', undefined, 'Essential');
  console.log('   fold AA preflop grade:', v.label);
  check('folding AA preflop graded blunder/mistake', v.grade === 'blunder' || v.grade === 'mistake');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
}
function heroIdx(e) { return e.players.findIndex(p => p.isHero); }
