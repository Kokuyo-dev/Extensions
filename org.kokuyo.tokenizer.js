// ═══════════════════════════════════════════════════════════════════
// KOKUYO (黒曜) — JPDB Tokenizer Extension (v2)
//
// A functional Tier 1 (client-side) tokenizer extension that wraps the
// JPDB parse API (jpdb.io/api/v1/parse). Implements the v2 `tokenizer`
// capability with a single `tokenize` method.
//
// API contract (mirrors src/lib/anime/jpdb-client.ts:parseDirectBatch):
//   Endpoint: POST https://jpdb.io/api/v1/parse
//   Auth:     Authorization: Bearer <api_key>   ← Bearer prefix IS used
//             (unlike Jimaku, which uses the raw key).
//   Body: {
//     text: [line1, line2, ...],                ← array, even for 1 line
//     token_fields: ['vocabulary_index','position','length','furigana'],
//     position_length_encoding: 'utf16',         ← matches JS string.slice
//     vocabulary_fields: ['vid','sid','rid','spelling','reading',
//       'frequency_rank','meanings','part_of_speech','pitch_accent',
//       'card_level','card_state']
//   }
//   Response: {
//     tokens: [[tok,...], [tok,...], ...],        ← 1 inner array per text
//     vocabulary: [vocab,...]                     ← flat, shared across texts
//   }
//     Each token:  [vocabulary_index, position, length, furigana]
//     Each vocab:  [vid, sid, rid, spelling, reading, frequency_rank,
//                   meanings, part_of_speech, pitch_accent, card_level,
//                   card_state]
//     Furigana:    Array<string | [kanji, reading]> | null
//                  (mixed: tuples for kanji segments, plain strings for
//                   kana segments — consumers check Array.isArray(seg))
//
// Chunking: JPDB's /parse rejects requests with combined text length
//   > ~5680 chars (returns HTTP 400 with "text is too long"). We split
//   long inputs on sentence boundaries (。！？\n) and send each sentence
//   as a separate text in the batch array. Token offsets are remapped
//   to be relative to the FULL original input text.
//
// Network: declared in manifest as https://jpdb.io/api/v1/* (covers the
//          /parse endpoint and the SRS endpoints if extended later).
//
// Returns the de facto JpdbToken shape used by existing consumers
// (SubtitleOverlay, WordPopup, buildRomajiFromTokens) so this extension
// is a drop-in replacement for the shell-level jpdb-client flow that R8
// recommended extracting into a Tier-1 extension.
// ═══════════════════════════════════════════════════════════════════

var JPDB_PARSE_URL = 'https://jpdb.io/api/v1/parse'
var JPDB_MAX_TEXT_CHARS = 5000  // Safe margin under the ~5680 hard limit

var TOKEN_FIELDS = ['vocabulary_index', 'position', 'length', 'furigana']
var VOCAB_FIELDS = [
  'vid', 'sid', 'rid', 'spelling', 'reading',
  'frequency_rank', 'meanings', 'part_of_speech',
  'pitch_accent', 'card_level', 'card_state',
]

// ─── Helpers ──────────────────────────────────────

/**
 * Build a structured extension error. The worker runtime detects
 * __extensionError + code and surfaces it to the host as a typed RpcError
 * (see extension-worker.js serializeError).
 */
function extError(code, message, extra) {
  var err = Object.assign(new Error(message), {
    __extensionError: true,
    code: code,
  })
  if (extra) {
    if (extra.retryAfter !== undefined) err.retryAfter = extra.retryAfter
    if (extra.details !== undefined) err.details = extra.details
  }
  return err
}

/**
 * Map a non-OK HTTP response from the JPDB API to a structured extension
 * error. Handles auth failures, rate limiting, oversized-text, and
 * upstream/network errors.
 */
async function handleApiError(res, context) {
  var status = res.status

  // 400 — usually "text is too long" (we pre-chunk, but a single sentence
  // could still exceed JPDB's limit if extremely long).
  if (status === 400) {
    var body400 = ''
    try { body400 = await res.text() } catch (_) { /* ignore */ }
    var msg400 = 'JPDB rejected the request (HTTP 400).'
    try {
      var j = JSON.parse(body400)
      if (j && typeof j.error_message === 'string') msg400 = 'JPDB: ' + j.error_message
    } catch (_) { /* not JSON */ }
    throw extError('bad-request', msg400, { details: { status: 400, body: body400.slice(0, 200) } })
  }

  // 401 — invalid API key.
  if (status === 401) {
    throw extError('auth-failed', 'Invalid JPDB API key. Re-check the key in your extension settings (jpdb.io/settings → Account).')
  }

  // 403 — usually a free-tier key hitting a paid-only endpoint (not /parse
  // currently, but defensively handled) or a banned key.
  if (status === 403) {
    throw extError('auth-failed', 'JPDB rejected the API key (HTTP 403). The key may be invalid or suspended.')
  }

  // 429 — rate limited. JPDB doesn't document a rate limit on /parse for
  // paying customers, but free-tier keys are throttled. The Retry-After
  // header (seconds) is the standard hint.
  if (status === 429) {
    var retryAfter = res.headers.get('retry-after')
    var retryAfterSec = retryAfter ? parseInt(retryAfter, 10) : 60
    if (isNaN(retryAfterSec) || retryAfterSec <= 0) retryAfterSec = 60
    throw extError('rate-limit', 'JPDB rate limit exceeded. Try again in ' + retryAfterSec + ' seconds.', {
      retryAfter: retryAfterSec,
    })
  }

  // 5xx — JPDB server error. Retryable upstream.
  if (status >= 500) {
    throw extError('upstream', 'JPDB server error (HTTP ' + status + '). Try again in a moment.')
  }

  // Other — generic network error.
  var bodyText = ''
  try { bodyText = await res.text() } catch (_) { /* ignore */ }
  throw extError('network', 'JPDB API request to ' + context + ' failed (HTTP ' + status + ').', {
    details: { status: status, body: bodyText.slice(0, 200) },
  })
}

/**
 * Split a long text into sentence-sized chunks that each fit within
 * JPDB's text-length limit (~5000 chars, safe margin).
 *
 * Splits on Japanese sentence terminators (。！？) and newlines, preserving
 * the delimiter with the preceding sentence. Returns an array of:
 *   { text: string, startOffset: number }
 * where startOffset is the character offset of the sentence's first
 * character within the original full text.
 *
 * If a single sentence exceeds the limit (rare but possible — e.g. a
 * long run of narration with no terminator), it's hard-split at the
 * limit boundary.
 */
function splitIntoSentences(text) {
  var sentences = []
  var start = 0

  for (var i = 0; i < text.length; i++) {
    var ch = text[i]
    // Treat 。！？\n as sentence boundaries. Include the boundary char
    // AND any trailing 」』）】 etc. that often closes quoted speech.
    if (ch === '。' || ch === '！' || ch === '？' || ch === '\n') {
      var end = i + 1
      // Consume trailing closing brackets that follow the terminator
      // (e.g. 「さようなら。」」 → the second 」 belongs to the sentence)
      while (end < text.length) {
        var nc = text[end]
        if (nc === '」' || nc === '』' || nc === '）' || nc === '】' || nc === '）' || nc === ')' || nc === ' ' || nc === '\t') {
          end++
        } else {
          break
        }
      }
      var sentence = text.slice(start, end)
      if (sentence.length > 0) {
        sentences.push({ text: sentence, startOffset: start })
      }
      start = end
    }
  }

  // Trailing fragment with no terminator
  if (start < text.length) {
    sentences.push({ text: text.slice(start), startOffset: start })
  }

  // Now group sentences into chunks under JPDB_MAX_TEXT_CHARS. Each chunk
  // is one batch call to /parse. We don't merge sentences across the
  // limit. If a single sentence exceeds the limit, hard-split it.
  var chunks = []
  var current = []
  var currentLen = 0

  for (var s = 0; s < sentences.length; s++) {
    var sent = sentences[s]
    if (sent.text.length > JPDB_MAX_TEXT_CHARS) {
      // Flush current chunk first
      if (current.length > 0) {
        chunks.push(current)
        current = []
        currentLen = 0
      }
      // Hard-split the oversized sentence
      var off = sent.startOffset
      for (var c = 0; c < sent.text.length; c += JPDB_MAX_TEXT_CHARS) {
        var piece = sent.text.slice(c, c + JPDB_MAX_TEXT_CHARS)
        chunks.push([{ text: piece, startOffset: off + c }])
      }
      continue
    }
    if (currentLen + sent.text.length > JPDB_MAX_TEXT_CHARS && current.length > 0) {
      chunks.push(current)
      current = []
      currentLen = 0
    }
    current.push(sent)
    currentLen += sent.text.length
  }
  if (current.length > 0) chunks.push(current)

  return chunks
}

/**
 * POST a chunk of sentences to JPDB /parse. Returns the raw response:
 *   { tokens: [[tok,...], ...], vocabulary: [vocab,...] }
 * or throws a structured extension error.
 */
async function parseChunk(ctx, apiKey, sentences) {
  if (ctx.logger) {
    ctx.logger.info('JPDB parse: ' + sentences.length + ' sentence(s), ' +
      sentences.reduce(function (a, s) { return a + s.text.length }, 0) + ' chars')
  }

  var res = await ctx.fetch(JPDB_PARSE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      text: sentences.map(function (s) { return s.text }),
      token_fields: TOKEN_FIELDS,
      position_length_encoding: 'utf16',
      vocabulary_fields: VOCAB_FIELDS,
    }),
  })

  if (!res.ok) {
    await handleApiError(res, 'parse')
  }

  var data
  try {
    data = await res.json()
  } catch (e) {
    throw extError('network', 'JPDB returned invalid JSON.', {
      details: { error: e && e.message ? e.message : String(e) },
    })
  }

  // Normalize response shape. JPDB returns:
  //   - For a single-text input: { tokens: [tok, tok, ...], vocabulary: [...] }
  //   - For a multi-text input:  { tokens: [[tok,...], [tok,...]], vocabulary: [...] }
  // We always send an array, so the batch shape is expected, but
  // defensively handle both.
  var tokensArr = data.tokens
  var vocabArr = data.vocabulary || []
  if (!Array.isArray(tokensArr)) {
    return { tokens: [], vocabulary: vocabArr }
  }
  // Detect single-text-flat response: tokens[0] is a number (vocabulary_index)
  // rather than an array.
  if (tokensArr.length > 0 && !Array.isArray(tokensArr[0])) {
    // Wrap in an outer array so the batch logic works.
    tokensArr = [tokensArr]
  }

  return { tokens: tokensArr, vocabulary: vocabArr }
}

/**
 * Convert a JPDB raw vocab positional array to a typed object.
 * Mirrors mapVocab() in jpdb-client.ts.
 */
function mapVocab(v) {
  if (!Array.isArray(v)) return null
  return {
    vid: v[0],
    sid: v[1],
    rid: v[2],
    spelling: v[3],
    reading: v[4],
    frequencyRank: v[5],
    meanings: Array.isArray(v[6]) ? v[6] : [],
    partOfSpeech: Array.isArray(v[7]) ? v[7] : [],
    pitchAccent: Array.isArray(v[8]) ? v[8] : [],
    cardLevel: v[10] === undefined ? null : v[10],
    cardState: Array.isArray(v[11]) ? v[11] : null,
  }
}

// ─── Kana → Romaji (minimal, inline) ─────────────────────────────
//
// We inline a minimal kana→romaji converter (no external CDN dependency)
// so the extension is self-contained in the Web Worker. Handles:
//   - All hiragana + katakana single chars
//   - Yōon (きゃ kya, しゃ sha, ちゃ cha, etc.)
//   - Sokuon っ (doubles the following consonant: がっこう → gakkō)
//   - Chōonpu ー (extends the previous vowel: コーヒー → kōhī)
//   - ん (n, with apostrophe before a/i/u/e/o/y to disambiguate: こんにちは → kon'nichiwa)
//
// Long-vowel macron conversion (おう → ō, おお → ō, etc.) is NOT applied —
// we use the simple "extend previous vowel" rule for ー, and leave other
// long vowels as written. This matches the JPDB-style romaji that the
// existing client computes via wanakana for the vast majority of cases.

var HIRAGANA_BASE = {
  'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
  'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
  'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
  'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
  'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
  'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
  'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
  'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
  'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
  'わ': 'wa', 'を': 'wo', 'ん': 'n',
  'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
  'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
  'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
  'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
  'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
}

var YOON = {
  'き': 'ky', 'し': 'sh', 'ち': 'ch', 'に': 'ny', 'ひ': 'hy',
  'み': 'my', 'り': 'ry', 'ぎ': 'gy', 'じ': 'j', 'び': 'by', 'ぴ': 'py',
}

var YOON_VOWELS = { 'ゃ': 'a', 'ゅ': 'u', 'ょ': 'o' }

// Build a katakana base map from the hiragana one (replace ッ→っ small, etc.)
var KATA_BASE = {}
Object.keys(HIRAGANA_BASE).forEach(function (h) {
  // Convert hiragana char to its katakana equivalent by adding 0x60
  // to the char code (U+3041 → U+30A1). This works for the full block.
  var k = String.fromCharCode(h.charCodeAt(0) + 0x60)
  KATA_BASE[k] = HIRAGANA_BASE[h]
})

function toRomaji(s) {
  if (!s) return ''
  var out = ''
  var i = 0
  while (i < s.length) {
    var c = s[i]
    var next = s[i + 1]

    // Sokuon っ / ッ — doubles the following consonant
    if (c === 'っ' || c === 'ッ') {
      if (next && (HIRAGANA_BASE[next] || KATA_BASE[next])) {
        var nr = HIRAGANA_BASE[next] || KATA_BASE[next]
        // Double the first consonant letter (tsu → ttsu, ka → kka, etc.)
        out += nr[0]
        // The next char will be handled normally on the next iteration
      }
      i++
      continue
    }

    // Chōonpu ー — extend previous vowel
    if (c === 'ー') {
      if (out.length > 0) {
        var last = out[out.length - 1]
        // Map a/i/u/e/o → ā/ī/ū/ē/ō (with macron)
        var macron = { 'a': 'ā', 'i': 'ī', 'u': 'ū', 'e': 'ē', 'o': 'ō' }[last]
        if (macron) {
          out = out.slice(0, -1) + macron
        }
      }
      i++
      continue
    }

    // ん / ン — n, with apostrophe before a/i/u/e/o/y
    if (c === 'ん' || c === 'ン') {
      if (next) {
        var lower = next
        if (lower === 'あ' || lower === 'い' || lower === 'う' || lower === 'え' || lower === 'お' ||
            lower === 'ア' || lower === 'イ' || lower === 'ウ' || lower === 'エ' || lower === 'オ' ||
            lower === 'や' || lower === 'ゆ' || lower === 'よ' ||
            lower === 'ヤ' || lower === 'ユ' || lower === 'ヨ') {
          out += "n'"
        } else {
          out += 'n'
        }
      } else {
        out += 'n'
      }
      i++
      continue
    }

    // Yōon (きゃ kya, しゃ sha, ちゃ cha, etc.)
    if (YOON[c] && next && YOON_VOWELS[next]) {
      var stem = YOON[c]
      var vowel = YOON_VOWELS[next]
      // じ + ゃ → "ja" (not "jya"), ち + ゃ → "cha" (not "chya")
      out += stem + vowel
      i += 2
      continue
    }

    // Plain hiragana / katakana
    if (HIRAGANA_BASE[c]) {
      out += HIRAGANA_BASE[c]
      i++
      continue
    }
    if (KATA_BASE[c]) {
      out += KATA_BASE[c]
      i++
      continue
    }

    // Katakana yōon (キャ kya, シャ sha, etc.) — same as hiragana yōon
    // but with katakana small ャ/ュ/ョ
    if (YOON[c]) {
      var ks = YOON[c]
      // Check katakana small y-vowels
      var kv = next === 'ャ' ? 'a' : next === 'ュ' ? 'u' : next === 'ョ' ? 'o' : null
      if (kv) {
        out += ks + kv
        i += 2
        continue
      }
    }

    // Unknown char (punctuation, kanji, latin, etc.) — pass through.
    out += c
    i++
  }
  return out
}

/**
 * Derive the SURFACE-FORM reading from JPDB's furigana array.
 *
 * JPDB's vocab.reading is the DICTIONARY form (e.g. 知る→しる), but the
 * surface form might be conjugated (知った→しった). The furigana array
 * gives us the surface reading: join all segment readings.
 *
 * Examples:
 *   furigana [["知","し"],"った"] → "しった"
 *   furigana [["日","にっ"],["本","ぽん"],["語","ご"]] → "にっぽんご"
 *   furigana null → fall back to vocab.reading (or word itself if equal)
 */
function deriveSurfaceReading(furigana, vocab, word) {
  if (furigana && Array.isArray(furigana) && furigana.length > 0) {
    var parts = []
    for (var i = 0; i < furigana.length; i++) {
      var seg = furigana[i]
      if (Array.isArray(seg)) {
        parts.push(seg[1])
      } else if (typeof seg === 'string') {
        parts.push(seg)
      }
    }
    return parts.join('')
  }
  // No furigana — fall back to vocab.reading (if different from spelling)
  // or the surface word itself.
  if (vocab && vocab.spelling !== vocab.reading) return vocab.reading
  return word
}

/**
 * Map one JPDB token → the de facto JpdbToken shape used by consumers.
 *
 * Returns the minimal Token contract fields (surface, reading, start, end,
 * furigana, lemma, pos, romaji) PLUS the JPDB-specific fields consumers
 * expect (word, vid, sid, rid, spelling, meanings, frequencyRank,
 * pitchAccent, cardLevel, cardState). The `[key: string]: unknown`
 * index signature on Token permits these extra fields.
 *
 * @param {Array} rawTok - JPDB token: [vocabulary_index, position, length, furigana]
 * @param {object} vocab - Mapped vocab object (from mapVocab)
 * @param {string} sentenceText - The sentence this token came from
 * @param {number} sentenceOffset - The sentence's start offset in the FULL input text
 */
function mapToken(rawTok, vocab, sentenceText, sentenceOffset) {
  var vocabIndex = rawTok[0]
  var position = rawTok[1]
  var length = rawTok[2]
  var furigana = rawTok[3] === undefined ? null : rawTok[3]

  // Surface form from the sentence text. position/length are utf16 code
  // units, matching JS string indexing exactly (per
  // position_length_encoding: 'utf16' in the request).
  var word = sentenceText.slice(position, position + length)

  var surfaceReading = deriveSurfaceReading(furigana, vocab, word)
  // Reading for display: empty string if pure kana (spelling == reading)
  // and no furigana — the UI uses this to decide whether to show furigana.
  var kanaReading = surfaceReading !== word ? surfaceReading : ''

  var romaji = toRomaji(surfaceReading)

  var pos = (vocab && vocab.partOfSpeech && vocab.partOfSpeech.length > 0)
    ? vocab.partOfSpeech.join('/')
    : ''
  var meaning = (vocab && vocab.meanings && vocab.meanings.length > 0)
    ? vocab.meanings.join('; ')
    : null

  // Offsets relative to the FULL input text (sentence offset + token's
  // position within the sentence).
  var start = sentenceOffset + position
  var end = sentenceOffset + position + length

  return {
    // ── Minimal Token contract fields ──
    surface: word,
    reading: kanaReading,
    lemma: vocab ? vocab.spelling : undefined,
    pos: pos,
    start: start,
    end: end,
    furigana: furigana,
    romaji: romaji,

    // ── JPDB-specific fields (consumers like SubtitleOverlay/WordPopup
    //    read these directly — preserved for drop-in compatibility with
    //    the existing jpdb-client flow). ──
    word: word,            // = surface (SubtitleOverlay reads tok.word)
    vid: vocab ? vocab.vid : 0,
    sid: vocab ? vocab.sid : 0,
    rid: vocab ? vocab.rid : 0,
    spelling: vocab ? vocab.spelling : undefined,
    meanings: (vocab && vocab.meanings && vocab.meanings.length > 0) ? vocab.meanings : undefined,
    meaning: meaning,
    frequencyRank: vocab ? (vocab.frequencyRank || null) : null,
    pitchAccent: vocab ? (vocab.pitchAccent || null) : null,
    cardLevel: vocab ? (vocab.cardLevel === undefined ? null : vocab.cardLevel) : null,
    cardState: vocab ? (vocab.cardState || null) : null,
  }
}

// ─── Extension Object ──────────────────────────────

module.exports = {
  // ── Identity (required by the worker) ──
  id: 'org.kokuyo.tokenizer',
  name: 'JPDB Tokenizer',
  version: '1.1.0',
  baseUrl: 'https://jpdb.io',

  // ═══ tokenizer: tokenize ═══════════════════════
  /**
   * Tokenize a Japanese text into morphemes with readings, furigana,
   * pitch accent, and JPDB SRS metadata.
   *
   * For long text (>5000 chars), splits on sentence boundaries (。！？\n)
   * and sends each chunk as a separate batch to JPDB /parse. Token
   * offsets are remapped to be relative to the FULL input text.
   *
   * @param {object} ctx
   * @param {object} params - { text: string }
   * @returns {Promise<Array>} Token[] (flat, with offsets relative to params.text)
   */
  async tokenize(ctx, params) {
    var p = params || {}
    var text = p.text

    if (typeof text !== 'string') {
      throw extError('bad-params', 'tokenize requires { text: string }.')
    }
    if (text.length === 0) {
      return []
    }

    var apiKey = ctx.config && ctx.config.apiKey
    if (!apiKey) {
      throw extError('config-missing', 'No JPDB API key configured. Add your key in the extension settings (jpdb.io/settings → Account).')
    }

    // Split into chunks under JPDB's text-length limit. Each chunk is
    // an array of { text, startOffset } sentence objects.
    var chunks = splitIntoSentences(text)
    if (ctx.logger) {
      ctx.logger.info('JPDB tokenize: ' + text.length + ' chars in ' + chunks.length + ' chunk(s)')
    }

    // Send all chunks in parallel for speed (mirrors jpdb-client.ts
    // parseDirectBatch which does the same).
    var chunkResults = await Promise.all(
      chunks.map(function (chunk) {
        return parseChunk(ctx, apiKey, chunk).catch(function (err) {
          // If one chunk fails, log + return null so other chunks can
          // still produce tokens. If ALL chunks fail, we throw below.
          if (ctx.logger) ctx.logger.error('JPDB chunk failed: ' + (err && err.message ? err.message : err))
          return null
        })
      })
    )

    // If every chunk failed, throw a structured error.
    var allFailed = chunkResults.every(function (r) { return r === null })
    if (allFailed) {
      throw extError('network', 'JPDB parse failed for all chunks. Check your API key and network connection.')
    }

    // Flatten all chunk results into a single Token[] with offsets
    // relative to the FULL input text.
    var flatTokens = []
    for (var ci = 0; ci < chunks.length; ci++) {
      var chunkData = chunkResults[ci]
      var sentences = chunks[ci]
      if (!chunkData) continue // this chunk failed — skip

      var vocabulary = (chunkData.vocabulary || []).map(mapVocab)

      // Each chunk's tokens array has one inner array per sentence in the chunk.
      for (var si = 0; si < sentences.length; si++) {
        var sentence = sentences[si]
        var rawTokens = chunkData.tokens[si] || []
        for (var ti = 0; ti < rawTokens.length; ti++) {
          var rawTok = rawTokens[ti]
          if (!Array.isArray(rawTok)) continue
          var vocabIndex = rawTok[0]
          var vocab = vocabulary[vocabIndex]
          if (!vocab) continue
          flatTokens.push(mapToken(rawTok, vocab, sentence.text, sentence.startOffset))
        }
      }
    }

    if (ctx.logger) ctx.logger.info('JPDB tokenize: ' + flatTokens.length + ' tokens from ' + text.length + ' chars')
    return flatTokens
  },

  // ═══ tokenizer: tokenizeBatch ═══════════════════
  /**
   * Tokenize MANY texts in ONE call — the fast path for full-episode
   * tokenization.
   *
   * Why this exists: the JPDB /parse endpoint natively accepts a `text`
   * ARRAY (one request can carry many lines). The single-text `tokenize`
   * method sends one line per request, so a 300-line episode = 300 HTTP
   * round-trips ≈ 60-100s. This method groups all lines into a handful
   * of chunked /parse calls (each under the ~5000-char limit) and sends
   * them in parallel, collapsing 300 round-trips into ~1-3.
   *
   * Returns Token[][] — one inner array per input text, same length +
   * order as `texts`. Token offsets are relative to THAT text (line),
   * not the combined chunk.
   *
   * Chunking strategy: greedily pack lines into chunks whose combined
   * text length stays under JPDB_MAX_TEXT_CHARS. Each chunk becomes ONE
   * /parse call with `text: [line1, line2, ...]`. JPDB returns
   * `tokens: [[...], [...]]` — one inner array per input text element,
   * with positions relative to that element — so per-line offsets come
   * for free. A single line exceeding the limit (extremely rare for
   * subtitles) is hard-split into its own sub-chunk(s); offsets are
   * remapped via subOffset so consumers still see line-relative coords.
   *
   * @param {object} ctx
   * @param {object} params - { texts: string[] }
   * @returns {Promise<Array<Array>>} Token[][] (one per input text)
   */
  async tokenizeBatch(ctx, params) {
    var p = params || {}
    var texts = p.texts

    if (!Array.isArray(texts)) {
      throw extError('bad-params', 'tokenizeBatch requires { texts: string[] }.')
    }
    if (texts.length === 0) {
      return []
    }

    var apiKey = ctx.config && ctx.config.apiKey
    if (!apiKey) {
      throw extError('config-missing', 'No JPDB API key configured. Add your key in the extension settings (jpdb.io/settings → Account).')
    }

    // ── Build chunks ──
    // Each chunk entry: { text, originalIndex, subOffset }
    //   - originalIndex: index into the input `texts` array (so we can
    //     place results back in the right slot)
    //   - subOffset: character offset within the ORIGINAL line (only
    //     non-zero when a single line was hard-split across chunks)
    var chunks = []
    var current = []
    var currentLen = 0

    for (var i = 0; i < texts.length; i++) {
      var t = texts[i]
      if (typeof t !== 'string') t = String(t == null ? '' : t)
      var len = t.length

      // Skip empty lines entirely — they map to an empty token array,
      // and including them in a /parse call would just waste payload.
      if (len === 0) continue

      // Hard-split a single oversized line into <=JPDB_MAX_TEXT_CHARS pieces.
      // (Extremely rare for subtitles, but keeps us safe under JPDB's limit.)
      if (len > JPDB_MAX_TEXT_CHARS) {
        // Flush current chunk first
        if (current.length > 0) {
          chunks.push(current)
          current = []
          currentLen = 0
        }
        for (var c = 0; c < len; c += JPDB_MAX_TEXT_CHARS) {
          chunks.push([{
            text: t.slice(c, c + JPDB_MAX_TEXT_CHARS),
            originalIndex: i,
            subOffset: c,
          }])
        }
        continue
      }

      // Greedy pack: start a new chunk if adding this line would overflow.
      if (currentLen + len > JPDB_MAX_TEXT_CHARS && current.length > 0) {
        chunks.push(current)
        current = []
        currentLen = 0
      }
      current.push({ text: t, originalIndex: i, subOffset: 0 })
      currentLen += len
    }
    if (current.length > 0) chunks.push(current)

    if (ctx.logger) {
      ctx.logger.info('JPDB tokenizeBatch: ' + texts.length + ' lines in ' + chunks.length + ' chunk(s)')
    }

    // Send all chunks in parallel — JPDB handles each independently.
    var chunkResults = await Promise.all(
      chunks.map(function (chunk) {
        return parseChunk(ctx, apiKey, chunk).catch(function (err) {
          if (ctx.logger) ctx.logger.error('JPDB batch chunk failed: ' + (err && err.message ? err.message : err))
          return null
        })
      })
    )

    var allFailed = chunkResults.every(function (r) { return r === null })
    if (allFailed) {
      throw extError('network', 'JPDB parse failed for all chunks. Check your API key and network connection.')
    }

    // ── Reassemble Token[][] indexed by original line ──
    // results[i] = Token[] for texts[i]. Pre-fill with [] for empties
    // and hard-split continuations concatenate onto the existing array.
    var results = new Array(texts.length)
    for (var r = 0; r < texts.length; r++) results[r] = []

    var totalTokens = 0
    for (var ci = 0; ci < chunks.length; ci++) {
      var chunkData = chunkResults[ci]
      var chunkLines = chunks[ci]
      if (!chunkData) continue // this chunk failed — leave its lines empty

      var vocabulary = (chunkData.vocabulary || []).map(mapVocab)
      // tokensArr has one inner array per text element in this chunk.
      var tokensArr = chunkData.tokens
      if (!Array.isArray(tokensArr)) tokensArr = []

      for (var si = 0; si < chunkLines.length; si++) {
        var lineObj = chunkLines[si]
        var rawTokens = tokensArr[si] || []
        var lineTokens = []
        for (var ti = 0; ti < rawTokens.length; ti++) {
          var rawTok = rawTokens[ti]
          if (!Array.isArray(rawTok)) continue
          var vocabIndex = rawTok[0]
          var vocab = vocabulary[vocabIndex]
          if (!vocab) continue
          // mapToken computes surface from sentenceText.slice(position, position+length)
          // and start/end = sentenceOffset + position. For batch mode each
          // text element is its own "sentence" with offset = subOffset,
          // so offsets come out relative to the ORIGINAL line.
          lineTokens.push(mapToken(rawTok, vocab, lineObj.text, lineObj.subOffset))
        }
        results[lineObj.originalIndex] = results[lineObj.originalIndex].concat(lineTokens)
        totalTokens += lineTokens.length
      }
    }

    if (ctx.logger) ctx.logger.info('JPDB tokenizeBatch: ' + totalTokens + ' tokens from ' + texts.length + ' lines')
    return results
  },
}
