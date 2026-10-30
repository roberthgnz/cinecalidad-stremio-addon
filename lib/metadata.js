const logger = require("./logger");
const { getInstance: getDatabase } = require("./database");

const CINEMETA_URL = process.env.CINEMETA_URL || "https://v3-cinemeta.strem.io";
const METADATA_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Escapes and normalizes title for better matching
 * @param title
 */
function escapeTitle(title) {
  if (!title) return "";

  return title
    .toLowerCase()
    .normalize("NFKD") // normalize non-ASCII characters
    .replace(/[\u0300-\u036F]/g, "") // remove diacritics
    .replace(/&/g, "and")
    .replace(/[.,_+ -]+/g, " ") // replace dots, commas or underscores with spaces
    .replace(/[^\w- ()]/gi, "") // remove all non-alphanumeric chars
    .trim();
}

/**
 * Gets metadata from cache or fetches from external sources
 * @param imdbId
 * @param type
 */
async function getMetadata(imdbId, type) {
  try {
    // Check cache first
    const cacheKey = `metadata_${imdbId}_${type}`;
    const cachedMetadata = await getDatabase().getCache(cacheKey);

    if (cachedMetadata) {
      logger.debug(`Using cached metadata for ${imdbId}`);
      return cachedMetadata;
    }

    // Try to get from Cinemeta first (more reliable)
    let metadata;
    try {
      metadata = await getMetadataCinemeta(imdbId, type);
      logger.debug(`Got metadata from Cinemeta for ${imdbId}`);
    } catch (error) {
      logger.warn(
        `Cinemeta failed for ${imdbId}, trying fallback: ${error.message}`,
      );
      // Fallback to basic IMDB info if available
      metadata = await getBasicMetadata(imdbId);
    }

    // Cache the result
    if (metadata) {
      await getDatabase().setCache(cacheKey, metadata, METADATA_CACHE_TTL);
    }

    return metadata;
  } catch (error) {
    logger.error(`Failed to get metadata for ${imdbId}:`, error);
    return null;
  }
}

/**
 * Gets metadata from Cinemeta addon
 * @param imdbId
 * @param type
 */
async function getMetadataCinemeta(imdbId, type) {
  const url = `${CINEMETA_URL}/meta/${type}/${imdbId}.json`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      "User-Agent": "Cinecalidad-Stremio-Addon/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data || !data.meta || !data.meta.name) {
    throw new Error("Invalid response from Cinemeta");
  }

  const { meta } = data;

  return {
    title: escapeTitle(meta.name),
    originalTitle: meta.name,
    year: meta.year,
    poster: meta.poster,
    background: meta.background,
    description: meta.description,
    genres: meta.genres,
    cast: meta.cast,
    director: meta.director,
    writer: meta.writer,
    imdbRating: meta.imdbRating,
    type: meta.type,
    // For series, extract episode count per season
    episodeCount:
      meta.videos && type === "series"
        ? extractEpisodeCount(meta.videos)
        : undefined,
  };
}

/**
 * Extracts episode count per season from Cinemeta videos data
 * @param videos
 */
function extractEpisodeCount(videos) {
  const seasonCounts = {};

  videos.forEach((video) => {
    if (video.season && video.season > 0) {
      seasonCounts[video.season] = (seasonCounts[video.season] || 0) + 1;
    }
  });

  // Convert to array format expected by the addon
  const maxSeason = Math.max(...Object.keys(seasonCounts).map(Number));
  const episodeCount = [];

  for (let i = 1; i <= maxSeason; i++) {
    episodeCount.push(seasonCounts[i] || 0);
  }

  return episodeCount;
}

/**
 * Basic metadata fallback (minimal info)
 * @param imdbId
 */
async function getBasicMetadata(imdbId) {
  // This is a fallback that just returns the IMDB ID
  // In the future, this could be enhanced with other metadata sources
  return {
    title: `Movie ${imdbId}`,
    originalTitle: `Movie ${imdbId}`,
    year: null,
    poster: null,
    background: null,
    description: null,
    genres: [],
    cast: [],
    type: "movie",
  };
}

/**
 * Gets movie metadata
 * @param args
 */
async function movieMetadata(args) {
  const metadata = await getMetadata(args.id, "movie");

  if (!metadata) {
    return null;
  }

  return {
    imdb: args.id,
    title: metadata.title,
    originalTitle: metadata.originalTitle,
    year: metadata.year,
    poster: metadata.poster,
    background: metadata.background,
    description: metadata.description,
    genres: metadata.genres,
    cast: metadata.cast,
    director: metadata.director,
    writer: metadata.writer,
    imdbRating: metadata.imdbRating,
    type: metadata.type,
  };
}

/**
 * Gets series metadata
 * @param args
 */
async function seriesMetadata(args) {
  const [imdbId, seasonStr, episodeStr] = args.id.split(":");
  const season = parseInt(seasonStr, 10);
  const episode = parseInt(episodeStr, 10);

  const metadata = await getMetadata(imdbId, "series");

  if (!metadata) {
    return null;
  }

  const hasEpisodeCount =
    metadata.episodeCount && metadata.episodeCount.length >= season;
  const seasonString = season < 10 ? `0${season}` : `${season}`;
  const episodeString = episode < 10 ? `0${episode}` : `${episode}`;

  return {
    imdb: imdbId,
    title: metadata.title,
    originalTitle: metadata.originalTitle,
    episodeTitle: `${metadata.title} s${seasonString}e${episodeString}`,
    season,
    episode,
    absoluteEpisode: hasEpisodeCount
      ? metadata.episodeCount
          .slice(0, season - 1)
          .reduce((a, b) => a + b, episode)
      : episode,
    totalEpisodes: hasEpisodeCount
      ? metadata.episodeCount.reduce((a, b) => a + b, 0)
      : null,
    episodesInSeason: hasEpisodeCount
      ? metadata.episodeCount[season - 1]
      : null,
    year: metadata.year,
    poster: metadata.poster,
    background: metadata.background,
    description: metadata.description,
    genres: metadata.genres,
    cast: metadata.cast,
    director: metadata.director,
    writer: metadata.writer,
    imdbRating: metadata.imdbRating,
    type: metadata.type,
  };
}

/**
 * Updates cached metadata with community title
 * @param imdbId
 * @param communityTitle
 */
async function addCommunityTitle(imdbId, communityTitle) {
  try {
    const cacheKey = `metadata_${imdbId}_movie`;
    const database = getDatabase();
    const metadata = await database.getCache(cacheKey);

    if (metadata) {
      metadata.communityTitle = communityTitle;
      await database.setCache(cacheKey, metadata, METADATA_CACHE_TTL);
      logger.debug(`Added community title "${communityTitle}" for ${imdbId}`);
    }
  } catch (error) {
    logger.error(`Failed to add community title for ${imdbId}:`, error);
  }
}

module.exports = {
  movieMetadata,
  seriesMetadata,
  addCommunityTitle,
  escapeTitle,
  getMetadata,
};
