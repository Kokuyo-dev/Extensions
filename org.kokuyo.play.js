// ═══════════════════════════════════════════════════════════════════
// KOKUYO (黒曜) — MegaPlay Streaming Extension (v2.1.0)
//
// A Tier 1 streaming extension for megaplay.buzz.
// Resolves playable HLS streams directly from MegaPlay's API.
//
// ─── API flow ─────────────────────────────────────────────────────
//   getVideosDirect({ contentId, episodeNumber })
//     → GET https://megaplay.buzz/stream/ani/{contentId}/{ep}/sub
//       (HTML page — needed to get the file ID from the page's data
//        attributes; MegaPlay's getSourcesNew API takes a numeric file
//        ID, not an anilist ID)
//     → Parse data-id from the #megaplay-player element
//     → GET https://megaplay.buzz/stream/getSourcesNew?id={fileId}
//       → { sources: { file: "https://megap.kotocdn.site/.../master.m3u8" },
//           tracks: [{ file, label, kind, default }] }
//     → Return as Video with type: 'hls' + subtitles[]
//
// ─── v2.1.0 changes ───────────────────────────────────────────────
//   - Stream page: no custom headers needed (HTTP 200 without them).
//   - getSourcesNew API: requires X-Requested-With: XMLHttpRequest header.
//     Without it, returns 403 "This endpoint accepts only AJAX requests."
//     The CORS preflight (OPTIONS) returns 200 + Access-Control-Allow-Origin: *,
//     so the browser allows the actual GET with the custom header.
//   - Removed Referer header from both calls (not required by MegaPlay).
//   - Removed duplicate `id` parameter in getSourcesNew URL.
//   - Updated permissions to use wildcard for MegaPlay CDN domains
//     (MegaPlay rotates CDN domains: kotocdn.site, mikora.top,
//     shiora.site, norami.top, akirax.buzz, etc.)
//
// ─── Why not iframe? ──────────────────────────────────────────────
// Previously this extension returned an iframe embed. But:
//   1. MegaPlay's page explicitly refuses Brave browser ("Brave
//      browser does not support our player")
//   2. Brave Shields blocks JW Player's third-party scripts + the
//      HLS stream loaded inside the iframe
//   3. The iframe's JW Player doesn't send postMessage time events,
//      so subtitle sync required the Kokuyo Companion's time-bridge
//
// Returning the HLS stream directly lets Kokuyo's native hls.js
// player handle playback — works in ALL browsers (including Brave),
// needs no companion, and subtitle sync works via the <video>
// element's currentTime (no postMessage bridge needed).
//
// ─── Network ──────────────────────────────────────────────────────
// MegaPlay (megaplay.buzz) sends Access-Control-Allow-Origin: *, so
// the extension's ctx.fetch can reach it directly (no relay needed).
// The HLS CDN also sends CORS *, so direct browser playback works.
//
// ─── Cloudflare ───────────────────────────────────────────────────
// megaplay.buzz is behind Cloudflare but does NOT challenge plain
// requests. No special headers or companion extension required.
// ═══════════════════════════════════════════════════════════════════

var MEGAPLAY_STREAM_URL = 'https://megaplay.buzz/stream/ani/';
var MEGAPLAY_API = 'https://megaplay.buzz/stream/getSourcesNew';

function extError(code, message, extra) {
  var err = Object.assign(new Error(message), {
    __extensionError: true,
    code: code,
  });
  if (extra) {
    if (extra.retryAfter !== undefined) err.retryAfter = extra.retryAfter;
    if (extra.details !== undefined) err.details = extra.details;
  }
  return err;
}

/**
 * Fetch the MegaPlay stream page and extract the file ID from the
 * #megaplay-player element's data-id attribute.
 *
 * The page is small (~3KB HTML) and returns 200 with no special
 * headers required. MegaPlay sends Access-Control-Allow-Origin: *,
 * so ctx.fetch can reach it directly.
 */
async function resolveFileId(ctx, streamPageUrl) {
  if (ctx.logger) ctx.logger.info('MegaPlay fetch page: ' + streamPageUrl);

  var res = await ctx.fetch(streamPageUrl);

  if (!res.ok) {
    if (res.status === 410) {
      throw extError('not-found', 'MegaPlay returned 410 for ' + streamPageUrl + '. The episode may have been removed.');
    }
    if (res.status === 403) {
      throw extError('upstream', 'MegaPlay blocked the request (HTTP 403 — Cloudflare). Try again in a moment.');
    }
    throw extError('network', 'MegaPlay page fetch failed (HTTP ' + res.status + ').', {
      details: { status: res.status },
    });
  }

  var html = await res.text();

  // Parse the file ID from <div id="megaplay-player" data-id="36396" ...>
  // The data-id attribute is the numeric file ID used by getSourcesNew.
  // Note: attributes may span multiple lines with whitespace — [^>]* handles this.
  var match = html.match(/id="megaplay-player"[^>]*data-id="(\d+)"/);
  if (!match) {
    // Fallback: try data-realid or data-mediaid
    var altMatch = html.match(/data-(?:real|media)id="(\d+)"/);
    if (altMatch) {
      if (ctx.logger) ctx.logger.info('MegaPlay: using fallback data-realid/mediaid');
      return altMatch[1];
    }
    throw extError('not-found', 'Could not find file ID in MegaPlay page. The page structure may have changed.');
  }

  var fileId = match[1];
  if (ctx.logger) ctx.logger.info('MegaPlay: file ID = ' + fileId);
  return fileId;
}

/**
 * Call MegaPlay's getSourcesNew API to get the playable HLS URL +
 * bundled subtitle tracks.
 *
 * Response shape:
 *   {
 *     sources: { file: "https://megap.kotocdn.site/.../master.m3u8" },
 *     tracks: [{ file, label, kind, default }],
 *     t: 1,
 *     intro: { start, end },   // skip markers (seconds)
 *     outro: { start, end }
 *   }
 *
 * Requires X-Requested-With: XMLHttpRequest header (MegaPlay checks for
 * this and returns 403 without it). The CORS preflight returns 200 +
 * Access-Control-Allow-Origin: *, so the browser allows the request.
 */
async function resolveSources(ctx, fileId) {
  var apiUrl = MEGAPLAY_API + '?id=' + encodeURIComponent(fileId);
  if (ctx.logger) ctx.logger.info('MegaPlay getSourcesNew: ' + apiUrl);

  // MegaPlay requires X-Requested-With: XMLHttpRequest on the API call.
  // Without it, returns 403 "This endpoint accepts only AJAX requests."
  // The CORS preflight (OPTIONS) returns 200 + Access-Control-Allow-Origin: *,
  // so the browser allows the actual GET with this custom header.
  var res = await ctx.fetch(apiUrl, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw extError('not-found', 'MegaPlay API returned 404 for file ID ' + fileId + '.');
    }
    throw extError('network', 'MegaPlay API request failed (HTTP ' + res.status + ').', {
      details: { status: res.status },
    });
  }

  var data;
  try {
    data = await res.json();
  } catch (e) {
    throw extError('network', 'MegaPlay API returned invalid JSON.', {
      details: { error: e && e.message ? e.message : String(e) },
    });
  }

  if (!data || !data.sources || !data.sources.file) {
    throw extError('not-found', 'MegaPlay API returned no playable sources for file ID ' + fileId + '.');
  }

  return data;
}

module.exports = {
  id: 'org.kokuyo.play',
  name: 'MegaPlay Streaming',
  version: '2.1.0',
  baseUrl: 'https://megaplay.buzz',

  /**
   * Resolve playable video streams for an episode.
   *
   * Flow:
   *   1. Fetch the MegaPlay stream page (HTML) to get the file ID
   *   2. Call getSourcesNew API to get the HLS URL + subtitle tracks
   *   3. Return as Video with type: 'hls' + bundled subtitles[]
   *
   * @param {object} ctx
   * @param {object} params - { contentId, episodeNumber, animeTitle?, ... }
   * @returns {Promise<Array>} Video[]
   */
  async getVideosDirect(ctx, _params) {
    var params = _params || {};
    var contentId = params.contentId;
    var episodeNumber = params.episodeNumber || 1;

    if (!contentId) {
      throw extError('bad-params', 'getVideosDirect requires contentId.');
    }

    // Build the stream page URL
    var streamPageUrl = MEGAPLAY_STREAM_URL +
      encodeURIComponent(String(contentId)) + '/' +
      encodeURIComponent(String(episodeNumber)) + '/sub';

    // Step 1: Resolve the file ID from the stream page
    var fileId = await resolveFileId(ctx, streamPageUrl);

    // Step 2: Fetch the sources (HLS URL + subtitle tracks)
    var sources = await resolveSources(ctx, fileId);

    // Step 3: Map to Video[]
    var hlsUrl = sources.sources.file;
    var tracks = Array.isArray(sources.tracks) ? sources.tracks : [];

    // Map MegaPlay tracks to our subtitle format
    var subtitles = tracks
      .filter(function (t) { return t && t.file; })
      .map(function (t) {
        // MegaPlay labels look like "English", "Spanish", etc.
        // Map common ones to ISO codes for the platform's language detection.
        var label = (t.label || '').toLowerCase();
        var lang = 'unknown';
        if (label.indexOf('english') === 0 || label === 'en') lang = 'en';
        else if (label.indexOf('spanish') === 0 || label === 'es') lang = 'es';
        else if (label.indexOf('french') === 0 || label === 'fr') lang = 'fr';
        else if (label.indexOf('portuguese') === 0 || label === 'pt') lang = 'pt';
        else if (label.indexOf('arabic') === 0 || label === 'ar') lang = 'ar';
        else if (label.indexOf('russian') === 0 || label === 'ru') lang = 'ru';
        else if (label.indexOf('german') === 0 || label === 'de') lang = 'de';
        else if (label.indexOf('italian') === 0 || label === 'it') lang = 'it';
        else lang = label || 'unknown';

        return {
          lang: lang,
          url: t.file,
        };
      });

    // Extract skip markers (intro/outro) if present
    // These are returned in seconds — the platform can use them for
    // auto-skip features (not currently wired, but future-compatible).
    var introSkip = sources.intro || null;
    var outroSkip = sources.outro || null;
    if (introSkip && ctx.logger) {
      ctx.logger.info('MegaPlay: intro skip ' + introSkip.start + '-' + introSkip.end + 's');
    }
    if (outroSkip && ctx.logger) {
      ctx.logger.info('MegaPlay: outro skip ' + outroSkip.start + '-' + outroSkip.end + 's');
    }

    if (ctx.logger) {
      ctx.logger.info('MegaPlay: HLS = ' + hlsUrl);
      ctx.logger.info('MegaPlay: ' + subtitles.length + ' subtitle track(s)');
    }

    var video = {
      url: hlsUrl,
      quality: 1080,
      qualityLabel: 'MegaPlay Sub',
      source: this.name,
      type: 'hls',
      // The HLS CDN sends Access-Control-Allow-Origin: *, so direct
      // browser playback works. If the platform's HLS relay loader
      // routes through /api/relay, the Referer header is forwarded
      // on every segment request (some CDNs may require it).
      headers: {
        'Referer': 'https://megaplay.buzz/',
      },
      // The platform reads v.subtitles to populate the subtitle picker.
      // These appear alongside any Jimaku tracks the user has installed.
      subtitles: subtitles,
    };

    return [video];
  },
};
