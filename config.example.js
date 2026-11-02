/* config.example.js — optional. Copy to config.js (git-ignored) to pre-set AI providers.
 * Everything here can also be set in the app via "AI settings" (stored only in your browser).
 * Any OpenAI-compatible API works; provider ids: groq, openai, openrouter, lmstudio, ollama, custom.
 */
window.PT_AI = {
  analysis: 'off',     // AI for analysis notes and the tutor (a provider id, or 'off')
  opponents: 'off',    // AI for opponent decisions (a provider id, or 'off' for the built-in engine)
  providers: {
    groq:     { model: '', key: '' },
    lmstudio: { url: 'http://localhost:1234/v1', model: '' },
    custom:   { url: '', model: '', key: '' }
  }
};
