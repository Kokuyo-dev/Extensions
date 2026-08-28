// ═══════════════════════════════════════════════════════════════════
// KOKUYO (黒曜) — JPDB Mining Extension
//
// Mines words to JPDB decks for spaced repetition review.
// This is a Tier 1 (client-side) extension that runs in a Web Worker.
// It replaces the shell's built-in JPDB mining integration, moving
// all JPDB API calls into the extension system (blind-shell doctrine).
//
// Capability: mining-target
// Methods: mine, isMined, getMinedWords
//
// The shell calls host.capability('mining-target').invoke('mine', {...})
// when the user clicks "Mine" on a word in the subtitle popup.
// ═══════════════════════════════════════════════════════════════════

var JPDB_API_BASE = 'https://jpdb.io/api/v1'

// ─── Structured error helper ───────────────────────────────────────
function extError(code, message, extra) {
  var err = { __extensionError: true, code: code, message: message }
  if (extra) {
    if (extra.retryAfter !== undefined) err.retryAfter = extra.retryAfter
    if (extra.details !== undefined) err.details = extra.details
  }
  return err
}

// ─── Check API response and throw structured error if failed ──────
async function checkResponse(res, context) {
  if (res.ok) return
  var code = 'unknown'
  var message = context + ' failed: HTTP ' + res.status
  var retryAfter = undefined

  if (res.status === 401) {
    code = 'auth-failed'
    message = 'Invalid JPDB API key'
  } else if (res.status === 429) {
    code = 'rate-limit'
    message = 'JPDB rate limit exceeded'
    var ra = res.headers.get('x-ratelimit-reset-after')
    if (ra) retryAfter = parseFloat(ra)
  } else if (res.status === 404) {
    code = 'not-found'
    message = 'Not found: ' + context
  } else if (res.status >= 500) {
    code = 'upstream'
    message = 'JPDB server error'
  } else if (res.status >= 400) {
    code = 'network'
  }

  // Try to extract error_message from JPDB response body
  try {
    var data = await res.json()
    if (data.error_message) message = data.error_message
  } catch { /* non-fatal */ }

  throw extError(code, message, retryAfter ? { retryAfter: retryAfter } : undefined)
}

module.exports = {
  id: 'org.kokuyo.mining',
  name: 'JPDB Mining',
  version: '1.1.0',

  // ─── Mine a word to JPDB ───────────────────────────────────────
  // Params: { word, reading, sentence?, vid, sid, deckId? }
  // Returns: { success, wordKey }
  async mine(ctx, params) {
    var apiKey = ctx.config && ctx.config.apiKey
    if (!apiKey) {
      throw extError('config-missing', 'No JPDB API key configured')
    }

    var vid = params.vid
    var sid = params.sid
    var sentence = params.sentence || ''
    var deckId = params.deckId || (ctx.config && ctx.config.deckId)

    if (!vid || !sid) {
      throw extError('bad-params', 'vid and sid are required for JPDB mining')
    }

    var results = { reviewSuccess: false, sentenceSuccess: false, deckSuccess: false }

    // 1. Review the word (mark as "something" — seen but not yet learned)
    try {
      var res = await ctx.fetch(JPDB_API_BASE + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ vid: vid, sid: sid, grade: 'something' }),
      })
      await checkResponse(res, 'review')
      results.reviewSuccess = true
    } catch (err) {
      // Review failure is non-fatal — continue with sentence + deck
      ctx.logger && ctx.logger.warn && ctx.logger.warn('Review failed: ' + (err.message || err))
    }

    // 2. Add sentence context (if provided)
    if (sentence) {
      try {
        var sentRes = await ctx.fetch(JPDB_API_BASE + '/set-card-sentence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({ vid: vid, sid: sid, sentence: sentence, translation: '' }),
        })
        await checkResponse(sentRes, 'set-card-sentence')
        results.sentenceSuccess = true
      } catch (err) {
        ctx.logger && ctx.logger.warn && ctx.logger.warn('Sentence failed: ' + (err.message || err))
      }
    }

    // 3. Add to deck (if deckId configured or provided)
    if (deckId) {
      try {
        var deckRes = await ctx.fetch(JPDB_API_BASE + '/deck/add-vocabulary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({ id: parseInt(deckId, 10), vocabulary: [[vid, sid]] }),
        })
        await checkResponse(deckRes, 'add-to-deck')
        results.deckSuccess = true
      } catch (err) {
        ctx.logger && ctx.logger.warn && ctx.logger.warn('Deck add failed: ' + (err.message || err))
      }
    }

    // Track in extension cache
    var wordKey = vid + '|' + sid
    var minedSet = ctx.cache.get('mined-set') || {}
    if (Array.isArray(minedSet)) {
      // Legacy format — convert to object
      var obj = {}
      for (var i = 0; i < minedSet.length; i++) obj[minedSet[i]] = true
      minedSet = obj
    }
    minedSet[wordKey] = {
      wordKey: wordKey,
      word: params.word || '',
      reading: params.reading || '',
      minedAt: Date.now(),
    }
    ctx.cache.set('mined-set', minedSet, 86400000) // 24hr TTL

    var success = results.reviewSuccess || results.sentenceSuccess || results.deckSuccess
    return { success: success, wordKey: wordKey, results: results }
  },

  // ─── Check if a word is already mined ──────────────────────────
  // Params: { wordKey }
  // Returns: boolean
  async isMined(ctx, params) {
    var wordKey = params.wordKey
    if (!wordKey) return false
    var minedSet = ctx.cache.get('mined-set')
    if (!minedSet) return false
    if (Array.isArray(minedSet)) {
      return minedSet.indexOf(wordKey) !== -1
    }
    return !!minedSet[wordKey]
  },

  // ─── Get all mined words ───────────────────────────────────────
  // Returns: Array<{ wordKey, word, reading }>
  async getMinedWords(ctx, params) {
    var minedSet = ctx.cache.get('mined-set')
    if (!minedSet) return []
    if (Array.isArray(minedSet)) return []
    var result = []
    for (var key in minedSet) {
      if (minedSet.hasOwnProperty(key)) {
        var entry = minedSet[key]
        result.push({
          wordKey: entry.wordKey,
          word: entry.word || '',
          reading: entry.reading || '',
        })
      }
    }
    return result
  },
}
