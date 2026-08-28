// ═══════════════════════════════════════════════════════════════════
// KOKUYO (黒曜) — AniList Metadata Extension (v2)
//
// A functional Tier 1 (client-side) metadata extension that queries
// the AniList GraphQL API. Implements the v2 `metadata-provider` and
// `tag-taxonomy` capabilities.
//
// Methods:
//   search(query, page)         → { items, hasNextPage }
//   getDetails(id)              → anime details (cover, synopsis, etc.)
//   getRelations(id)            → related anime (sequels, prequels, etc.)
//   getTags()                   → AniList tag collection
//
// Network: https://graphql.anilist.co/* (declared in manifest)
// Auth: optional API token via ctx.config.apiKey (raises rate limits)
// ═══════════════════════════════════════════════════════════════════

const ANILIST_GQL = 'https://graphql.anilist.co'

/** GraphQL fetch helper — uses ctx.fetch (network-allowlist-enforced). */
async function anilistFetch(ctx, query, variables) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }
  // Optional API token for higher rate limits
  const token = ctx.config?.apiKey
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await ctx.fetch(ANILIST_GQL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`AniList API error: HTTP ${res.status}`)
  }

  const json = await res.json()
  if (json.errors) {
    throw new Error(`AniList GraphQL error: ${json.errors.map(e => e.message).join(', ')}`)
  }

  return json.data
}

/** Map an AniList Media node to a unified search result. */
function mapMediaToResult(media) {
  return {
    id: String(media.id),
    contentId: media.id,
    altId: null,                // Kitsu ID — not available from AniList API
    altId2: media.idMal ?? null, // MAL ID
    titleRomaji: media.title?.romaji ?? null,
    titleEnglish: media.title?.english ?? null,
    titleNative: media.title?.native ?? null,
    coverImage: media.coverImage?.extraLarge ?? media.coverImage?.large ?? null,
    bannerImage: media.bannerImage ?? null,
    description: media.description ?? null,
    episodes: media.episodes ?? null,
    season: media.season ?? null,
    seasonYear: media.seasonYear ?? null,
    format: media.format ?? null,
    status: media.status ?? null,
    genres: media.genres ?? [],
    primaryScore: media.averageScore ?? null,
    altPopularity: media.popularity ?? null,
    siteUrl: media.siteUrl ?? null,
    synonyms: media.synonyms ?? [],
    provider: 'primary',
    difficulty: null,
    difficultyRaw: null,
  }
}

// ─── Extension Object ──────────────────────────────────────────────

module.exports = {
  // ── Identity (required by the worker) ──
  id: 'org.kokuyo.metadata',
  name: 'AniList Metadata',
  version: '1.0.0',
  baseUrl: ANILIST_GQL, // required by the worker (v1 compat)

  // ── v2 Capability Methods ──

  /**
   * Search AniList for anime matching the query.
   * @param {object} ctx - The extension context (fetch, config, etc.)
   * @param {object} params - { query: string, page: number }
   * @returns {{ items: array, hasNextPage: boolean }}
   */
  async search(ctx, { query, page = 1 }) {
    const gql = `
      query ($search: String, $page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage currentPage lastPage }
          media(type: ANIME, search: $search, sort: SEARCH_MATCH) {
            id idMal
            title { romaji english native }
            coverImage { extraLarge large }
            bannerImage
            description
            episodes season seasonYear format status
            genres averageScore popularity siteUrl synonyms
          }
        }
      }`

    const data = await anilistFetch(ctx, gql, { search: query, page, perPage: 20 })
    const pageData = data.Page
    return {
      items: pageData.media.map(mapMediaToResult),
      hasNextPage: pageData.pageInfo.hasNextPage,
    }
  },

  /**
   * Get full details for a single anime by AniList ID.
   * @param {object} ctx
   * @param {object} params - { id: number }
   * @returns {object} Anime details with cover, synopsis, tags, studios
   */
  async getDetails(ctx, { id }) {
    const gql = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id idMal
          title { romaji english native }
          coverImage { large extraLarge color }
          bannerImage
          description
          episodes season seasonYear format status
          genres averageScore popularity siteUrl synonyms
          tags { name rank }
          studios { edges { isMain node { name isAnimationStudio } } }
          nextAiringEpisode { episode airingAt timeUntilAiring }
          relations {
            edges { relationType }
            nodes { id title { romaji english } coverImage { extraLarge large } format episodes seasonYear status }
          }
        }
      }`

    const data = await anilistFetch(ctx, gql, { id: Number(id) })
    const m = data.Media
    if (!m) return null

    return {
      ...mapMediaToResult(m),
      tags: (m.tags ?? []).map(t => t.name),
      studios: (m.studios?.edges ?? []).map(e => ({
        name: e.node.name,
        isAnimationStudio: e.node.isAnimationStudio ?? e.isMain,
      })),
      nextAiringEpisode: m.nextAiringEpisode ? {
        episode: m.nextAiringEpisode.episode,
        airingAt: m.nextAiringEpisode.airingAt,
        timeUntilAiring: m.nextAiringEpisode.timeUntilAiring,
      } : null,
      relations: (m.relations?.edges ?? []).map((edge, i) => ({
        contentId: m.relations.nodes[i]?.id ?? null,
        title: m.relations.nodes[i]?.title?.romaji ?? null,
        titleEnglish: m.relations.nodes[i]?.title?.english ?? null,
        coverImage: m.relations.nodes[i]?.coverImage?.extraLarge ?? m.relations.nodes[i]?.coverImage?.large ?? null,
        format: m.relations.nodes[i]?.format ?? null,
        episodes: m.relations.nodes[i]?.episodes ?? null,
        seasonYear: m.relations.nodes[i]?.seasonYear ?? null,
        relationType: edge.relationType,
        status: m.relations.nodes[i]?.status ?? null,
      })),
    }
  },

  /**
   * Get related anime (sequels, prequels, side stories, etc.)
   * @param {object} ctx
   * @param {object} params - { id: number }
   * @returns {array} Related anime list
   */
  async getRelations(ctx, { id }) {
    const gql = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          relations {
            edges { relationType }
            nodes { id title { romaji english } coverImage { extraLarge large } format episodes seasonYear status }
          }
        }
      }`

    const data = await anilistFetch(ctx, gql, { id: Number(id) })
    const m = data.Media
    if (!m?.relations) return []

    return m.relations.edges.map((edge, i) => ({
      contentId: m.relations.nodes[i]?.id ?? null,
      title: m.relations.nodes[i]?.title?.romaji ?? null,
      titleEnglish: m.relations.nodes[i]?.title?.english ?? null,
      coverImage: m.relations.nodes[i]?.coverImage?.extraLarge ?? m.relations.nodes[i]?.coverImage?.large ?? null,
      format: m.relations.nodes[i]?.format ?? null,
      episodes: m.relations.nodes[i]?.episodes ?? null,
      seasonYear: m.relations.nodes[i]?.seasonYear ?? null,
      relationType: edge.relationType,
      status: m.relations.nodes[i]?.status ?? null,
    }))
  },

  /**
   * Get the AniList tag collection (all tags with categories).
   * @param {object} ctx
   * @returns {array} Tag list
   */
  async getTags(ctx) {
    const gql = `{ MediaTagCollection { id name category isAdult } }`
    const data = await anilistFetch(ctx, gql, {})
    return data.MediaTagCollection ?? []
  },

  /**
   * Batch-fetch cover art + basic details for multiple anime by ID.
   * Uses AniList's Page query to fetch up to 50 anime per request
   * in a SINGLE GraphQL query — much faster than N individual getDetails calls.
   *
   * Supports TWO lookup modes (can be combined in one call):
   *   - ids:    AniList media IDs (queried via id_in)
   *   - malIds: MAL IDs (queried via idMal_in — for anime not on AniList
   *             but tracked in the DB via their MAL ID)
   *
   * Results from both queries are merged and deduplicated by AniList ID.
   *
   * @param {object} ctx
   * @param {object} params - { ids?: number[], malIds?: number[] }
   * @returns {{ items: array }} Array of anime details with coverImage
   */
  async getBatchDetails(ctx, { ids, malIds }) {
    var allMedia = [];

    // ── Fetch by AniList IDs (id_in) ──
    if (ids && ids.length > 0) {
      var chunks = [];
      for (var i = 0; i < ids.length; i += 50) {
        chunks.push(ids.slice(i, i + 50));
      }
      for (var c = 0; c < chunks.length; c++) {
        var chunk = chunks[c];
        var gql = `
          query ($ids: [Int]) {
            Page(page: 1, perPage: 50) {
              media(id_in: $ids, type: ANIME) {
                id idMal
                title { romaji english native }
                coverImage { extraLarge large }
                bannerImage
                description
                episodes season seasonYear format status
                genres averageScore popularity siteUrl synonyms
              }
            }
          }`;
        var data = await anilistFetch(ctx, gql, { ids: chunk });
        allMedia = allMedia.concat(data.Page.media || []);
      }
    }

    // ── Fetch by MAL IDs (idMal_in) ──
    if (malIds && malIds.length > 0) {
      var malChunks = [];
      for (var mi = 0; mi < malIds.length; mi += 50) {
        malChunks.push(malIds.slice(mi, mi + 50));
      }
      for (var mc = 0; mc < malChunks.length; mc++) {
        var malChunk = malChunks[mc];
        var malGql = `
          query ($idMal_in: [Int]) {
            Page(page: 1, perPage: 50) {
              media(idMal_in: $idMal_in, type: ANIME) {
                id idMal
                title { romaji english native }
                coverImage { extraLarge large }
                bannerImage
                description
                episodes season seasonYear format status
                genres averageScore popularity siteUrl synonyms
              }
            }
          }`;
        var malData = await anilistFetch(ctx, malGql, { idMal_in: malChunk });
        allMedia = allMedia.concat(malData.Page.media || []);
      }
    }

    // Deduplicate by AniList ID (an anime might appear in both id_in
    // and idMal_in results if it has both an AniList ID and a MAL ID)
    var seen = {};
    var deduped = [];
    for (var d = 0; d < allMedia.length; d++) {
      var m = allMedia[d];
      if (m && !seen[m.id]) {
        seen[m.id] = true;
        deduped.push(m);
      }
    }

    return { items: deduped.map(mapMediaToResult) };
  },

  /**
   * Get the episode list for a single anime.
   * AniList provides per-episode titles, air dates, and thumbnails.
   * @param {object} ctx
   * @param {object} params - { id: number }
   * @returns {array} Episode list
   */
  async getEpisodes(ctx, { id }) {
    const gql = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          episodes
          nextAiringEpisode { episode airingAt }
          streamingEpisodes {
            title
            thumbnail
          }
        }
      }`
    const data = await anilistFetch(ctx, gql, { id: Number(id) })
    const m = data.Media
    if (!m) return []

    // Determine total episode count:
    // - For finished anime: m.episodes is reliable (e.g. 26)
    // - For ongoing anime: m.episodes is null — use nextAiringEpisode.episode
    //   (the next episode to air, so the count is nextEp - 1, or nextEp if
    //   we include the upcoming one). We use nextAiringEpisode.episode as the
    //   count since the user can watch up to that point.
    // - Fallback: 0 (no episodes)
    var totalEps = m.episodes || 0;
    if (!totalEps && m.nextAiringEpisode) {
      totalEps = m.nextAiringEpisode.episode - 1; // next to air = haven't aired yet
    }
    if (!totalEps) return [];

    // streamingEpisodes is a PARTIAL list (AniList only has streaming data
    // for some episodes, often out of order). Build a lookup map by
    // extracting the episode number from the title (e.g. "Episode 130 - ...").
    var streamingEps = m.streamingEpisodes || [];
    var epLookup = {};
    for (var i = 0; i < streamingEps.length; i++) {
      var se = streamingEps[i];
      // Parse episode number from title: "Episode 130 - Scent of Danger!"
      var match = se.title && se.title.match(/Episode\s+(\d+)/i);
      if (match) {
        var epNum = parseInt(match[1], 10);
        epLookup[epNum] = { title: se.title, thumbnail: se.thumbnail };
      }
    }

    // Build the full episode list from 1 to totalEps
    var episodes = [];
    for (var i = 0; i < totalEps; i++) {
      var epNum = i + 1;
      var known = epLookup[epNum];
      episodes.push({
        episodeNumber: epNum,
        title: known?.title || ('Episode ' + String(epNum).padStart(2, '0')),
        titleNative: null,
        thumbnail: known?.thumbnail || null,
        airDate: null,
        duration: null,
        synopsis: null,
        provider: 'primary',
      });
    }
    return episodes;
  },

  // ── Shelf Methods (v2 capability extensions) ──────────────────

  /**
   * Get trending anime (what's popular right now).
   * @param {object} ctx
   * @param {object} params - { page, perPage }
   * @returns {{ items: array, hasNextPage: boolean }}
   */
  async getTrending(ctx, { page = 1, perPage = 20 }) {
    const gql = `
      query ($page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
            id idMal
            title { romaji english native }
            coverImage { extraLarge large }
            bannerImage
            description
            episodes season seasonYear format status
            genres averageScore popularity siteUrl synonyms
          }
        }
      }`
    const data = await anilistFetch(ctx, gql, { page, perPage })
    return {
      items: data.Page.media.map(mapMediaToResult),
      hasNextPage: data.Page.pageInfo.hasNextPage,
    }
  },

  /**
   * Get all-time popular anime.
   * @param {object} ctx
   * @param {object} params - { page, perPage }
   * @returns {{ items: array, hasNextPage: boolean }}
   */
  async getPopular(ctx, { page = 1, perPage = 20 }) {
    const gql = `
      query ($page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
            id idMal
            title { romaji english native }
            coverImage { extraLarge large }
            bannerImage
            description
            episodes season seasonYear format status
            genres averageScore popularity siteUrl synonyms
          }
        }
      }`
    const data = await anilistFetch(ctx, gql, { page, perPage })
    return {
      items: data.Page.media.map(mapMediaToResult),
      hasNextPage: data.Page.pageInfo.hasNextPage,
    }
  },

  /**
   * Get genuine premieres this season (no prequels/sequels).
   * @param {object} ctx
   * @param {object} params - { season, year, page, perPage }
   * @returns {{ items: array, hasNextPage: boolean }}
   */
  async getNewThisSeason(ctx, { season, year, page = 1, perPage = 20 }) {
    const gql = `
      query ($page: Int, $perPage: Int, $season: MediaSeason, $year: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          media(type: ANIME, season: $season, seasonYear: $year, sort: POPULARITY_DESC, isAdult: false) {
            id idMal
            title { romaji english native }
            coverImage { extraLarge large }
            bannerImage
            description
            episodes season seasonYear format status
            genres averageScore popularity siteUrl synonyms
            relations { edges { relationType } }
          }
        }
      }`
    const data = await anilistFetch(ctx, gql, { page, perPage, season, year })
    // Filter out sequels (anime with a PREQUEL relation)
    const filtered = data.Page.media.filter(function(m) {
      var hasPrequel = (m.relations?.edges || []).some(function(e) { return e.relationType === 'PREQUEL'; });
      return !hasPrequel;
    });
    return {
      items: filtered.map(mapMediaToResult),
      hasNextPage: data.Page.pageInfo.hasNextPage,
    }
  },

  /**
   * Get all anime this season (including sequels), chronological by start date.
   * @param {object} ctx
   * @param {object} params - { season, year, page, perPage }
   * @returns {{ items: array, hasNextPage: boolean }}
   */
  async getSeasonCatalog(ctx, { season, year, page = 1, perPage = 20 }) {
    const gql = `
      query ($page: Int, $perPage: Int, $season: MediaSeason, $year: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          media(type: ANIME, season: $season, seasonYear: $year, sort: START_DATE_DESC, isAdult: false) {
            id idMal
            title { romaji english native }
            coverImage { extraLarge large }
            bannerImage
            description
            episodes season seasonYear format status
            genres averageScore popularity siteUrl synonyms
          }
        }
      }`
    const data = await anilistFetch(ctx, gql, { page, perPage, season, year })
    return {
      items: data.Page.media.map(mapMediaToResult),
      hasNextPage: data.Page.pageInfo.hasNextPage,
    }
  },

  /**
   * Get recently-aired episodes across all airing anime.
   * @param {object} ctx
   * @param {object} params - { hoursBack, page, perPage }
   * @returns {{ episodes: array, hasNextPage: boolean }}
   */
  async getLatestEpisodes(ctx, { hoursBack = 48, page = 1, perPage = 24 }) {
    const now = Math.floor(Date.now() / 1000);
    const from = now - (hoursBack * 3600);
    // Fetch a larger batch than perPage so we have enough after dedup.
    // Long-running daily anime (Sazae-san) air every day, producing
    // multiple schedule entries. We dedup by anime ID — only the latest
    // episode per anime is kept. The airingAt_lesser filter caps to
    // past episodes only (no future schedules).
    const fetchCount = Math.max(perPage * 3, 50);
    const gql = `
      query ($page: Int, $perPage: Int, $airingAtGreater: Int, $airingAtLesser: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          airingSchedules(airingAt_greater: $airingAtGreater, airingAt_lesser: $airingAtLesser, sort: TIME_DESC) {
            id
            episode
            airingAt
            media {
              id idMal
              title { romaji english native }
              coverImage { extraLarge large }
              bannerImage
              episodes seasonYear format
            }
          }
        }
      }`
    const data = await anilistFetch(ctx, gql, { page, perPage: fetchCount, airingAtGreater: from, airingAtLesser: now })
    var seenAnime = {};
    var episodes = [];
    for (var i = 0; i < (data.Page.airingSchedules || []).length; i++) {
      var sched = data.Page.airingSchedules[i];
      var m = sched.media;
      if (!m) continue;
      // Dedup by anime ID — only the latest (most recent) episode per anime
      if (seenAnime[m.id]) continue;
      seenAnime[m.id] = true;
      episodes.push({
        contentId: m.id,
        episode: sched.episode,
        airingAt: sched.airingAt,
        titleRomaji: m.title?.romaji ?? null,
        titleEnglish: m.title?.english ?? null,
        // Prefer extraLarge (same as mapMediaToResult) for consistency
        // with other shelves. Previously this used `large` only, which
        // produced smaller cover art in the Latest Episodes shelf.
        coverImage: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
        bannerImage: m.bannerImage ?? null,
        format: m.format ?? null,
        seasonYear: m.seasonYear ?? null,
        episodes: m.episodes ?? null,
      });
      if (episodes.length >= perPage) break;
    }
    return {
      episodes: episodes,
      hasNextPage: data.Page.pageInfo.hasNextPage,
    }
  },

  // ── v1 compat methods (not used by v2, but keep for the worker) ──
  type: 'anime',
  lang: 'en',
  nsfw: false,
  capabilities: {},
}
