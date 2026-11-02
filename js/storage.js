/* storage.js — localStorage-backed hand history.
 * Deliberately a tiny CRUD interface so a real DB/account backend can
 * replace it later without touching callers.
 */
(function (PT) {
  const KEY = 'riverwise.hands.v1';

  function all() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch { return []; }
  }
  function write(list) { localStorage.setItem(KEY, JSON.stringify(list.slice(-500))); }

  PT.storage = {
    saveHand(hand) { const l = all(); l.push(hand); write(l); },
    listHands() { return all().reverse(); },
    clear() { localStorage.removeItem(KEY); }
  };
})(window.PT = window.PT || {});
