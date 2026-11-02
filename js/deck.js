/* deck.js — 52-card deck with cryptographically secure unbiased shuffle. */
(function (PT) {
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const SUITS = ['♠', '♥', '♦', '♣'];

  function secureRandomInt(max) {
    // Rejection sampling to avoid modulo bias.
    if (window.crypto && crypto.getRandomValues) {
      const limit = Math.floor(0x100000000 / max) * max;
      const buf = new Uint32Array(1);
      do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
      return buf[0] % max;
    }
    return Math.floor(Math.random() * max); // fallback only
  }

  class Deck {
    constructor() {
      this.cards = [];
      for (let r = 0; r < 13; r++)
        for (let s = 0; s < 4; s++)
          this.cards.push({ rank: RANKS[r], suit: SUITS[s], ri: r, si: s, id: RANKS[r] + SUITS[s] });
      for (let i = this.cards.length - 1; i > 0; i--) {
        const j = secureRandomInt(i + 1);
        [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
      }
    }
    draw() { return this.cards.pop(); }
  }

  PT.Deck = Deck;
  PT.RANKS = RANKS;
  PT.SUITS = SUITS;
})(window.PT = window.PT || {});
