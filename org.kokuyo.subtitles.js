// ═══════════════════════════════════════════════════════════════════
// KOKUYO (黒曜) — Jimaku Subtitles Extension (v2)
//
// A Tier 1 (client-side) subtitle extension that queries the Jimaku
// community subtitle database (jimaku.cc). Implements the v2
// `subtitle-source` capability with `listSubtitles` + `fetchSubtitle`.
//
// API contract (verified empirically by research task R1 + live testing):
//   Base URL:  https://jimaku.cc/api
//   Auth:      Authorization: <api_key>   ← NO "Bearer " prefix.
//              The raw 58-char base64url key is the entire header value.
//   CORS:      Fully open with credentials (origin mirror + allow-credentials).
//              ctx.fetch direct-fetch path works; relay is never triggered.
//              DO NOT route through /api/cors-relay — it strips Authorization.
//   Rate limit: 25 req / 60s per IP. Counts EVERY request, even failed auth.
//              On 429, read x-ratelimit-reset-after (seconds, fractional).
//
// Flow:
//   1. GET /api/entries/search?anilist_id=<contentId>&anime=true → [Entry]
//      Take [0].id. Cache entryId↔contentId (1hr TTL).
//   2. GET /api/entries/{id}/files → [FileEntry]  (ALL files, NO ?episode= filter)
//      Cache the full file list per entry (1hr TTL) — one API call per anime,
//      not per episode. This respects the 25 req/60s rate limit.
//   3. Client-side episode matching: parse each filename to find the TRUE
//      absolute episode number, filter to files matching the requested episode.
//      This is more reliable than Jimaku's server-side ?episode= filter
//      (which is anitomy-based and returns archives, not subtitle files).
//   4. Map matched FileEntry[] → SubtitleTrack[], filtering out archives
//      and picture subs. Mark the first .ass as recommended.
//
// FileEntry shape (4 fields — no uploader, no release-group, no format):
//   { url, name, size, last_modified }
//   url is absolute: https://jimaku.cc/entry/{id}/download/{filename}
//   Downloads are PUBLIC (no auth header), CORS permissive.
//
// Network: declared in manifest as https://jimaku.cc/* (covers both API
//          and download endpoints — same host, no CDN).
//
// Episode matching:
//   The extension owns its own episode-number parsing logic (inlined here).
//   The shell does NOT parse filenames — that's source-specific work that
//   belongs in the extension (blind-scheduler doctrine). The patterns handle:
//     - 第N話 / 第N回 (Japanese absolute episode counters — highest confidence)
//     - S01E#### (Season 1 — E = absolute)
//     - S##E#### with E > 26 (continuous numbering — E = absolute)
//     - E#### / EP#### (standalone episode mark)
//     - "Episode N", [N], " - N", trailing N (progressively lower confidence)
//   All patterns use \d{1,4} to handle anime with 1000+ episodes (e.g. One Piece).
// ═══════════════════════════════════════════════════════════════════

var JIMAKU_BASE = 'https://jimaku.cc/api'
var ENTRY_CACHE_TTL_MS = 60 * 60 * 1000   // 1 hour
var FILE_LIST_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour (per entry, not per episode)

// File extensions we surface as playable subtitle tracks.
var SUPPORTED_EXTS = ['srt', 'ass', 'ssa', 'vtt']

// ─── Episode Number Parsing (inlined — extension owns this logic) ───
//
// Determines the TRUE absolute episode number from a subtitle filename.
// Priority (first match wins):
//   1. 第N話 / 第N回 — Japanese absolute (highest confidence)
//   2. S01E#### — Season 1, E = absolute
//   3. S##E#### with E > 26 — continuous numbering, E = absolute
//   4. S##E#### with E ≤ 26 — can't determine (per-season or unknown) → null
//   5. E#### / EP#### — standalone episode mark
//   6. "Episode N" — episode number
//   7. [N] — bracketed episode number
//   8. " - N" — dash-separated trailing number
//   9. " N" — trailing number (excludes years > 1900)
//
// ALL patterns use \d{1,4} to handle anime with 1000+ episodes.

function parseEpisodeNumber(filename) {
  var stem = filename.replace(/\.[^.]+$/, '') // Remove extension

  // ── 1. 第N話 or 第N回 (Japanese absolute episode counters) ──
  var daiwa = stem.match(/第\s*(\d{1,4})\s*話/)
  if (daiwa) return parseInt(daiwa[1], 10)
  var daiwaKai = stem.match(/第\s*(\d{1,4})\s*回/)
  if (daiwaKai) return parseInt(daiwaKai[1], 10)

  // ── 2-4. S##E#### (season + episode within season) ──
  var sxxexx = stem.match(/[Ss](\d{1,2})[Ee](\d{1,4})/)
  if (sxxexx) {
    var season = parseInt(sxxexx[1], 10)
    var ep = parseInt(sxxexx[2], 10)
    if (season === 1) {
      // Season 1: episode within season = absolute episode
      return ep
    }
    // Multi-season: if E > 26 (typical max season length), treat as continuous
    if (ep > 26) {
      return ep
    }
    // E ≤ 26 and season > 1: return the episode number as-is.
    // The platform may use per-season numbering (S2 E1 = episode 1 of season 2)
    // or continuous numbering. We return the E number and let the caller
    // match it. If the platform says "episode 1" for season 2, and the
    // file says S02E13, these won't match — but we also return it so
    // the caller can do a secondary "season-relative" match.
    return ep
  }

  // ── 5. E#### or EP#### ──
  var epMark = stem.match(/[Ee][Pp]?(\d{1,4})\b/)
  if (epMark) return parseInt(epMark[1], 10)

  // ── 6. "Episode N" ──
  var epWord = stem.match(/[Ee]pisode\s*\.?(\d{1,4})/)
  if (epWord) return parseInt(epWord[1], 10)

  // ── 7. [N] (bracketed) ──
  var bracket = stem.match(/\[(\d{1,4})\]/)
  if (bracket) return parseInt(bracket[1], 10)

  // ── 8. " - N" (dash separator, optionally followed by metadata) ──
  // Matches: "One Piece - 1071" or "One Piece - 1071 (CX 1920x1080 AAC)"
  // The number can be followed by a space + parenthesized/grouped metadata
  // or be at the end of the string.
  var dash = stem.match(/[-–—]\s*(\d{1,4})(?:\s*[\(\[].*)?$/)
  if (dash) {
    var dashNum = parseInt(dash[1], 10)
    if (dashNum < 1900) return dashNum
  }

  // ── 9. " N" (trailing number, excluding years) ──
  // Also handles " N (metadata)" — number followed by optional parenthesized metadata
  var trailing = stem.match(/\s(\d{1,4})(?:\s*[\(\[].*)?$/)
  if (trailing) {
    var num = parseInt(trailing[1], 10)
    if (num < 1900) return num
  }

  return null // No pattern matched
}

// ─── Helpers ──────────────────────────────────────

function inferFormat(filenameOrUrl) {
  if (!filenameOrUrl) return null
  var clean = String(filenameOrUrl).split('?')[0].split('#')[0]
  var dot = clean.lastIndexOf('.')
  if (dot < 0) return null
  var ext = clean.slice(dot + 1).toLowerCase()
  if (ext === 'srt') return 'srt'
  if (ext === 'ass' || ext === 'ssa') return 'ass'
  if (ext === 'vtt') return 'vtt'
  return null
}

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

async function handleApiError(res, context) {
  var status = res.status

  if (status === 401) {
    throw extError('auth-failed', 'Invalid Jimaku API key. Re-check the key in your extension settings.')
  }
  if (status === 429) {
    var resetAfter = res.headers.get('x-ratelimit-reset-after')
    var retryAfterSec = resetAfter ? Math.ceil(parseFloat(resetAfter)) : 60
    throw extError('rate-limit', 'Jimaku rate limit exceeded (25 requests per 60 seconds per IP).', {
      retryAfter: retryAfterSec,
      details: { limit: res.headers.get('x-ratelimit-limit'), remaining: res.headers.get('x-ratelimit-remaining') },
    })
  }
  if (status === 404) {
    throw extError('not-found', 'Jimaku returned 404 while trying to ' + context + '. The anime or episode may not be in the database.')
  }
  if (status >= 500) {
    throw extError('upstream', 'Jimaku server error (HTTP ' + status + ') while trying to ' + context + '. Try again in a moment.')
  }

  var bodyText = ''
  try { bodyText = await res.text() } catch (_) { /* ignore */ }
  throw extError('network', 'Jimaku API request to ' + context + ' failed (HTTP ' + status + ').', {
    details: { status: status, body: bodyText.slice(0, 200) },
  })
}

/**
 * GET helper for the Jimaku API. Sends the raw Authorization header
 * (NO "Bearer " prefix). Returns parsed JSON or throws a structured error.
 */
async function jimakuGet(ctx, url, context) {
  var apiKey = ctx.config && ctx.config.apiKey
  if (!apiKey) {
    throw extError('config-missing', 'No Jimaku API key configured. Add your key in the extension settings (jimaku.cc/account → Developer Access).')
  }

  if (ctx.logger) ctx.logger.info('Jimaku ' + context + ': ' + url)

  var res = await ctx.fetch(url, {
    headers: { Authorization: apiKey },
  })

  if (!res.ok) {
    await handleApiError(res, context)
  }

  if (ctx.logger) {
    var remaining = res.headers.get('x-ratelimit-remaining')
    if (remaining !== null) ctx.logger.info('Jimaku rate-limit remaining: ' + remaining)
  }

  try {
    return await res.json()
  } catch (e) {
    throw extError('network', 'Jimaku returned invalid JSON while trying to ' + context + '.', {
      details: { error: e && e.message ? e.message : String(e) },
    })
  }
}

/**
 * Check if a filename indicates Japanese language.
 */
function isJapaneseLang(name) {
  return /[_\.]ja[_\.\-]|[_\.]jpn[_\.\-]|ja-jp/i.test(name)
}

/**
 * Map Jimaku FileEntry[] → SubtitleTrack[] for the platform's subtitle picker.
 * Filters out archives + picture subs. Marks the first .ass as recommended.
 * Only called with files that ALREADY match the requested episode.
 */
function mapFilesToTracks(files, params) {
  if (!Array.isArray(files)) return []

  var tracks = []
  var firstAssSeen = false

  for (var i = 0; i < files.length; i++) {
    var f = files[i]
    if (!f || !f.url || !f.name) continue

    var format = inferFormat(f.name) || inferFormat(f.url)
    if (!format) continue // unsupported extension (archive, picture sub, unknown)

    var isAss = format === 'ass'
    var recommended = isAss && !firstAssSeen
    if (isAss) firstAssSeen = true

    tracks.push({
      id: f.url,
      url: f.url,
      label: f.name,
      language: 'ja',
      format: format,
      fileSize: typeof f.size === 'number' ? f.size : null,
      uploadedAt: f.last_modified || null,
      fileName: f.name,
      recommended: recommended,
      sourceExtensionId: 'org.kokuyo.subtitles',
      sourceExtensionName: 'Jimaku',
    })
  }

  // If no .ass files were found, mark the FIRST .srt as recommended
  if (!firstAssSeen && tracks.length > 0) {
    for (var j = 0; j < tracks.length; j++) {
      if (tracks[j].format === 'srt') {
        tracks[j].recommended = true
        break
      }
    }
  }

  return tracks
}

// ─── Extension Object ──────────────────────────────

module.exports = {
  id: 'org.kokuyo.subtitles',
  name: 'Jimaku Subtitles',
  version: '1.1.0',
  baseUrl: 'https://jimaku.cc',

  // ═══ subtitle-source: listSubtitles ═════════════
  /**
   * List available subtitle tracks for an episode.
   *
   * Flow:
   *   1. Resolve the Jimaku entry ID for this AniList anime (cached 1hr).
   *   2. Fetch ALL files for the entry (cached 1hr per entry — one API call
   *      per anime, not per episode). We do NOT use the server-side
   *      ?episode=N filter because it returns archives, not subtitle files.
   *   3. Client-side episode matching: parse each filename to find the TRUE
   *      absolute episode number, filter to files matching the requested episode.
   *   4. Sort matched files by format priority (.ass > .srt) + Japanese language.
   *   5. Map to SubtitleTrack[], marking the first .ass as recommended.
   *
   * @param {object} ctx
   * @param {object} params - { episodeRef, contentId, episodeNumber, animeTitle?, ... }
   * @returns {Promise<Array>} SubtitleTrack[]
   */
  async listSubtitles(ctx, params) {
    var p = params || {}
    var contentId = p.contentId
    var episodeNumber = p.episodeNumber

    if (!contentId) {
      throw extError('bad-params', 'listSubtitles requires contentId.')
    }
    if (episodeNumber === undefined || episodeNumber === null) {
      throw extError('bad-params', 'listSubtitles requires episodeNumber.')
    }

    // ── Step 1: Resolve entryId + movie flag (cached). ──
    // We cache both the entry ID and whether it's a movie, because movies
    // have no episode numbers in their filenames — we skip episode filtering
    // for them entirely (the API also ignores ?episode= for movies).
    var entryCacheKey = 'entry:' + contentId
    var entryCacheVal = ctx.cache && ctx.cache.get(entryCacheKey)

    var entryId, isMovie

    if (entryCacheVal && typeof entryCacheVal === 'object') {
      entryId = entryCacheVal.id
      isMovie = entryCacheVal.isMovie
    } else {
      var searchUrl = JIMAKU_BASE + '/entries/search?anilist_id=' + encodeURIComponent(contentId) + '&anime=true'
      var entries = await jimakuGet(ctx, searchUrl, 'search entries')

      if (!Array.isArray(entries) || entries.length === 0) {
        if (ctx.logger) ctx.logger.info('No entries for content ' + contentId)
        return []
      }

      var entry = entries[0]
      entryId = entry.id
      if (entryId === undefined || entryId === null) {
        throw extError('network', 'Search returned an entry without an id.')
      }

      // Check if this entry is a movie (flags.movie = true)
      var flags = entry.flags || {}
      isMovie = !!(flags.movie)

      if (ctx.cache) ctx.cache.set(entryCacheKey, { id: entryId, isMovie: isMovie }, ENTRY_CACHE_TTL_MS)
      if (ctx.logger) ctx.logger.info('Content ' + contentId + ' → entry ' + entryId + (isMovie ? ' (movie)' : ''))
    }

    // ── Step 2: Fetch ALL files for this entry (cached per entry, not per episode). ──
    // We do NOT use ?episode=N — Jimaku's server-side filter is anitomy-based
    // and returns archives (.7z/.zip), not individual subtitle files. Instead,
    // we fetch the full file list once per anime and filter client-side.
    var fileCacheKey = 'files:' + entryId
    var allFiles = ctx.cache && ctx.cache.get(fileCacheKey)

    if (!allFiles) {
      allFiles = await jimakuGet(ctx, JIMAKU_BASE + '/entries/' + encodeURIComponent(entryId) + '/files', 'list files')
      if (!Array.isArray(allFiles)) allFiles = []
      if (ctx.cache) ctx.cache.set(fileCacheKey, allFiles, FILE_LIST_CACHE_TTL_MS)
      if (ctx.logger) ctx.logger.info('Jimaku: entry ' + entryId + ' → ' + allFiles.length + ' total files (cached)')
    } else {
      if (ctx.logger) ctx.logger.info('Jimaku: using cached file list for entry ' + entryId + ' (' + allFiles.length + ' files)')
    }

    // ── Step 3: Client-side episode matching. ──
    // Parse each file's filename to find the TRUE absolute episode number,
    // then filter to files matching the requested episode.
    // MOVIES: skip episode filtering entirely — movie subtitles have no
    // episode number in the filename (e.g. "[Group] A Silent Voice.ja.srt").
    // Jimaku's API also ignores ?episode= for movie entries.
    var matched = []
    var unmatchedCount = 0

    for (var i = 0; i < allFiles.length; i++) {
      var f = allFiles[i]
      if (!f || !f.name) continue

      // Skip archives and picture subs early (before parsing)
      var fmt = inferFormat(f.name)
      if (!fmt) continue

      if (isMovie) {
        // Movies: all subtitle files are relevant, no episode filtering
        matched.push(f)
        continue
      }

      var parsedEp = parseEpisodeNumber(f.name)
      if (parsedEp === null) {
        unmatchedCount++
        continue
      }

      if (parsedEp === episodeNumber) {
        matched.push(f)
      }
    }

    if (ctx.logger) {
      if (isMovie) {
        ctx.logger.info('Jimaku: movie → ' + matched.length + ' subtitle files (no episode filter)')
      } else {
        ctx.logger.info('Jimaku: ep ' + episodeNumber + ' → ' + matched.length + ' matched files (' + unmatchedCount + ' unmatched, ' + (allFiles.length - matched.length - unmatchedCount) + ' non-subtitle)')
      }
    }

    if (matched.length === 0) {
      // No files matched the requested episode.
      // This happens for:
      //   - Specials (AniList episode 1, but Jimaku uses parent-show numbering)
      //   - OVAs with non-standard naming
      //   - Entries where the numbering scheme doesn't match our parser
      //
      // Fallback: return ALL subtitle files for the entry, sorted by quality.
      // The user picks the right one from the subtitle picker. This is better
      // than returning empty — the files exist, we just can't auto-match.
      if (ctx.logger) ctx.logger.info('Jimaku: no exact episode match — returning all subtitle files as fallback')
      matched = []
      for (var j = 0; j < allFiles.length; j++) {
        var ff = allFiles[j]
        if (!ff || !ff.name) continue
        if (inferFormat(ff.name)) matched.push(ff)
      }
      if (matched.length === 0) return [] // truly no subtitle files
    }

    // ── Step 4: Sort matched files by format priority + language. ──
    // .ass > .srt > .ssa > .vtt, Japanese-marked preferred, smaller = better.
    matched.sort(function (a, b) {
      var fmtA = inferFormat(a.name) || 'unknown'
      var fmtB = inferFormat(b.name) || 'unknown'
      var fmtPriority = { ass: 3, srt: 2, ssa: 2, vtt: 1, unknown: 0 }
      var fmtDiff = (fmtPriority[fmtB] || 0) - (fmtPriority[fmtA] || 0)
      if (fmtDiff !== 0) return fmtDiff

      // Japanese language preference
      var jaA = isJapaneseLang(a.name) ? 1 : 0
      var jaB = isJapaneseLang(b.name) ? 1 : 0
      if (jaA !== jaB) return jaB - jaA

      // Smaller files = single-episode (prefer over multi-episode batches)
      return (a.size || 0) - (b.size || 0)
    })

    // ── Step 5: Map to SubtitleTrack[]. ──
    return mapFilesToTracks(matched, p)
  },

  // ═══ subtitle-source: fetchSubtitle ═════════════
  /**
   * Fetch the full subtitle file content for a track.
   *
   * The trackId is the absolute download URL (we set id = url in
   * listSubtitles). Jimaku's download endpoint is PUBLIC — no auth
   * header needed — and CORS-permissive.
   *
   * @param {object} ctx
   * @param {object} params - { trackId: string }
   * @returns {Promise<{ format: 'srt'|'ass'|'vtt', content: string }>}
   */
  async fetchSubtitle(ctx, params) {
    var p = params || {}
    var trackId = p.trackId

    if (!trackId) {
      throw extError('bad-params', 'fetchSubtitle requires trackId.')
    }

    if (ctx.logger) ctx.logger.info('Jimaku download: ' + trackId)

    var res = await ctx.fetch(trackId)
    if (!res.ok) {
      if (res.status === 404) {
        throw extError('not-found', 'Subtitle file not found on Jimaku (it may have been deleted).')
      }
      if (res.status >= 500) {
        throw extError('upstream', 'Jimaku download server error (HTTP ' + res.status + '). Try again.')
      }
      throw extError('network', 'Jimaku download failed (HTTP ' + res.status + ').', {
        details: { status: res.status },
      })
    }

    var content
    try {
      content = await res.text()
    } catch (e) {
      throw extError('network', 'Failed to read subtitle file content from Jimaku.', {
        details: { error: e && e.message ? e.message : String(e) },
      })
    }

    var format = inferFormat(trackId) || 'srt'

    if (ctx.logger) ctx.logger.info('Jimaku download OK: ' + content.length + ' chars, format=' + format)

    return { format: format, content: content }
  },
}
