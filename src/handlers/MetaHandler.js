const logger = require("../../lib/logger");
const { createError, ErrorCodes } = require("../lib/errors");
const { validateMovieId, sanitizeId } = require("../lib/validators");
const { MetadataBuilder } = require("../services/MetadataBuilder");
const { CacheService } = require("../services/CacheService");

/**
 * Meta Handler
 * Follows enterprise patterns with proper error handling,
 * logging, validation, and separation of concerns
 */
class MetaHandler {
  constructor(dependencies) {
    this.database = dependencies.database;
    this.cineCalidadService = dependencies.cineCalidadService;
    this.metadataService = dependencies.metadataService;
    this.cacheService = new CacheService(dependencies.database);

    // Use provided MetadataBuilder if available (for testing), otherwise create new one
    this.metadataBuilder =
      dependencies.metadataBuilder || new MetadataBuilder(dependencies);

    // Bind methods to preserve context
    this.handle = this.handle.bind(this);
  }

  /**
   * Handle meta request with enterprise-grade patterns
   * @param {object} args - Request arguments
   * @returns {Promise<object>} Meta response
   */
  async handle(args) {
    const requestId = this._generateRequestId();
    const context = { requestId };

    try {
      // Basic validation first
      if (!args || typeof args !== "object") {
        context.error = "Invalid request arguments";
        return this._handleError(
          createError(ErrorCodes.INVALID_INPUT, "Invalid request arguments"),
          context,
        );
      }

      context.type = args.type;
      context.id = args.id;

      logger.info("Meta request initiated", context);

      // Input validation
      if (args && args.type && args.id) {
        this._validateInput(args);
      } else {
        logger.warn("Invalid or missing arguments", context);
        return { meta: null };
      }

      // Only handle movies
      if (args.type !== "movie") {
        logger.debug("Non-movie type requested, skipping", context);
        return { meta: null };
      }

      const sanitizedId = sanitizeId(args.id);
      context.sanitizedId = sanitizedId;

      // Check cache first
      const cachedResult = await this._getCachedMeta(sanitizedId, context);
      if (cachedResult) {
        logger.info("Cache hit for meta request", context);
        return cachedResult;
      }

      // Route to appropriate handler based on ID type
      const result = await this._routeMetaRequest(sanitizedId, context);

      if (!result) {
        logger.warn("No metadata found for request", context);
        return { meta: null };
      }

      // Handle both direct meta objects and wrapped { meta } objects
      const meta = result.meta || result;

      if (!meta) {
        logger.warn("No metadata found for request", context);
        return { meta: null };
      }

      const response = { meta };

      // Cache the successful response
      await this._cacheMeta(sanitizedId, response, context);

      logger.info("Meta request completed successfully", {
        ...context,
        movieTitle: meta.name,
        hasIMDB: !!meta.imdbId,
      });

      return response;
    } catch (error) {
      return this._handleError(error, context);
    }
  }

  /**
   * Validate input parameters
   * @param args
   * @private
   */
  _validateInput(args) {
    if (!args || typeof args !== "object") {
      throw createError(ErrorCodes.INVALID_INPUT, "Invalid request arguments");
    }

    if (!args.id || typeof args.id !== "string") {
      throw createError(ErrorCodes.INVALID_INPUT, "Missing or invalid ID");
    }

    if (!validateMovieId(args.id)) {
      throw createError(
        ErrorCodes.INVALID_ID_FORMAT,
        `Invalid ID format: ${args.id}`,
      );
    }
  }

  /**
   * Route meta request to appropriate handler
   * @param id
   * @param context
   * @private
   */
  async _routeMetaRequest(id, context) {
    if (id.startsWith("tt")) {
      return this._handleIMDBId(id, context);
    }

    if (id.startsWith("cc_")) {
      return this._handleCineCalidadId(id, context);
    }

    throw createError(
      ErrorCodes.UNSUPPORTED_ID_TYPE,
      `Unsupported ID type: ${id}`,
    );
  }

  /**
   * Handle IMDB ID requests
   * @param id
   * @param context
   * @private
   */
  async _handleIMDBId(id, context) {
    logger.debug("Processing IMDB ID request", context);

    try {
      const metadata = await this.metadataService.getMovieMetadata({
        id,
        type: "movie",
      });

      if (!metadata) {
        logger.warn("No metadata found for IMDB ID", context);
        return null;
      }

      return this.metadataBuilder.buildFromIMDB(id, metadata);
    } catch (error) {
      logger.error("Failed to fetch IMDB metadata", {
        ...context,
        error: error.message,
      });
      throw createError(
        ErrorCodes.EXTERNAL_SERVICE_ERROR,
        "Failed to fetch metadata from external service",
        error,
      );
    }
  }

  /**
   * Handle Cinecalidad ID requests
   * @param id
   * @param context
   * @private
   */
  async _handleCineCalidadId(id, context) {
    const movieId = id.replace("cc_", "");
    context.movieId = movieId;

    logger.debug("Processing Cinecalidad ID request", context);

    try {
      // Try database first
      const savedMovie = await this._getSavedMovie(id, context);
      if (savedMovie) {
        return savedMovie;
      }

      // Try catalog lookup
      const catalogMovie = await this._getCatalogMovie(movieId, context);
      if (catalogMovie) {
        return catalogMovie;
      }

      // Fallback to scraping
      const scrapedMovie = await this._scrapeMovie(movieId, id, context);
      if (scrapedMovie) {
        return scrapedMovie;
      }

      return null;
    } catch (error) {
      logger.error("Failed to process Cinecalidad ID", {
        ...context,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get saved movie from database
   * @param id
   * @param context
   * @private
   */
  async _getSavedMovie(id, context) {
    try {
      const savedMovie = await this.database.getMovie(id);

      if (savedMovie?.meta) {
        logger.debug("Found saved movie in database", context);
        return { meta: savedMovie.meta };
      }

      return null;
    } catch (error) {
      logger.warn("Database lookup failed", {
        ...context,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Get movie from catalog
   * @param movieId
   * @param context
   * @private
   */
  async _getCatalogMovie(movieId, context) {
    try {
      const catalogMovie = await this.database.findMovieByOriginalId(
        movieId,
      );

      if (!catalogMovie) {
        return null;
      }

      logger.debug("Found movie in catalog", context);

      // If we have complete metadata, return it
      if (catalogMovie.data.meta?.meta) {
        return catalogMovie.data.meta;
      }

      // Build metadata from existing catalog data
      if (catalogMovie.data.release) {
        const meta = await this.metadataBuilder.buildFromCatalogData(
          catalogMovie.data,
          context.sanitizedId,
        );

        // Save the built metadata
        await this._saveBuildMetadata(
          context.sanitizedId,
          catalogMovie.data,
          meta,
        );

        return { meta };
      }

      return null;
    } catch (error) {
      logger.warn("Catalog lookup failed", {
        ...context,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Scrape movie data as fallback
   * @param movieId
   * @param fullId
   * @param context
   * @private
   */
  async _scrapeMovie(movieId, fullId, context) {
    logger.debug("Falling back to scraping", context);

    try {
      const searchTitle = this._extractSearchTitle(movieId);
      context.searchTitle = searchTitle;

      const releases = await this.cineCalidadService.performQuery({
        search: searchTitle,
        skip: 0,
        limit: 100,
      });

      const release = this._findMatchingRelease(releases, movieId, context);

      if (!release) {
        logger.warn("No matching release found", context);
        return null;
      }

      const movieDetails = await this.cineCalidadService.getMovieDetails(
        release.detailsLink,
      );
      const externalMeta = await this._getExternalMetadata(
        movieDetails,
        context,
      );

      const meta = await this.metadataBuilder.buildFromScrapedData({
        release,
        movieDetails,
        externalMeta,
        id: fullId,
      });

      // Save for future use
      await this._saveScrapedMovie(fullId, {
        meta: { meta },
        movieDetails,
        release,
        externalMeta,
      });

      return { meta };
    } catch (error) {
      logger.error("Movie scraping failed", {
        ...context,
        error: error.message,
      });
      throw createError(
        ErrorCodes.SCRAPING_ERROR,
        "Failed to scrape movie data",
        error,
      );
    }
  }

  /**
   * Extract search title from movie ID with intelligent parsing
   * @param movieId
   * @private
   */
  _extractSearchTitle(movieId) {
    const COMMON_SUFFIXES = [
      "online",
      "descarga",
      "descargar",
      "gratis",
      "hd",
      "full",
      "latino",
      "dual",
      "subtitulado",
      "español",
      "spanish",
    ];

    const parts = movieId.split("-").filter(Boolean);

    // Find where common suffixes start
    let endIndex = parts.length;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (COMMON_SUFFIXES.includes(parts[i].toLowerCase())) {
        endIndex = i;
      } else {
        break;
      }
    }

    // Ensure we don't return empty string
    if (endIndex === 0) {
      endIndex = Math.max(1, Math.floor(parts.length * 0.7));
    }

    return parts.slice(0, endIndex).join(" ");
  }

  /**
   * Find matching release with intelligent matching
   * @param releases
   * @param targetId
   * @param context
   * @private
   */
  _findMatchingRelease(releases, targetId, context) {
    logger.debug(
      `[MATCH DEBUG] Looking for targetId: "${targetId}" in ${releases.length} releases`,
      context,
    );

    // Log all release IDs for debugging
    releases.forEach((release, index) => {
      logger.debug(
        `[MATCH DEBUG] Release ${index}: id="${release.id}", title="${release.title}"`,
        context,
      );
    });

    // Exact match first
    let release = releases.find((r) => r.id === targetId);

    if (release) {
      logger.debug(`[MATCH DEBUG] Exact match found: "${release.id}"`, context);
      return release;
    }

    if (!release && releases.length > 0) {
      logger.debug(
        `[MATCH DEBUG] No exact match, attempting fuzzy match for: "${targetId}"`,
        context,
      );

      // Fuzzy matching
      const normalizeId = (id) => id.toLowerCase().replace(/[-\s_]/g, "");
      const normalizedTarget = normalizeId(targetId);
      logger.debug(
        `[MATCH DEBUG] Normalized target: "${normalizedTarget}"`,
        context,
      );

      release = releases.find((r) => {
        if (!r.id) return false;

        const normalizedRelease = normalizeId(r.id);
        const minLength = Math.min(
          15,
          Math.min(normalizedTarget.length, normalizedRelease.length),
        );

        const targetSubstring = normalizedTarget.substring(0, minLength);
        const releaseSubstring = normalizedRelease.substring(0, minLength);

        const match1 = targetSubstring === releaseSubstring;
        const match2 = normalizedRelease.includes(
          normalizedTarget.substring(0, minLength),
        );

        logger.debug(
          `[MATCH DEBUG] Comparing "${r.id}" (normalized: "${normalizedRelease}"): ` +
            `match1=${match1}, match2=${match2}`,
          context,
        );

        return match1 || match2;
      });

      if (release) {
        logger.debug(
          `[MATCH DEBUG] Fuzzy match found: "${release.id}"`,
          context,
        );
      } else {
        logger.debug(
          `[MATCH DEBUG] No fuzzy match found for: "${targetId}"`,
          context,
        );
      }
    }

    return release;
  }

  /**
   * Get external metadata with fallback handling
   * @param movieDetails
   * @param context
   * @private
   */
  async _getExternalMetadata(movieDetails, context) {
    if (!movieDetails?.imdbId?.startsWith("tt")) {
      return null;
    }

    try {
      const externalMeta = await this.metadataService.getMovieMetadata({
        id: movieDetails.imdbId,
        type: "movie",
      });

      logger.debug("External metadata fetched", {
        ...context,
        imdbId: movieDetails.imdbId,
        found: !!externalMeta,
      });

      return externalMeta;
    } catch (error) {
      logger.warn("External metadata fetch failed", {
        ...context,
        imdbId: movieDetails.imdbId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Cache management methods
   * @param id
   * @param context
   * @private
   */
  async _getCachedMeta(id, context) {
    return this.cacheService.get(`meta:${id}`, context);
  }

  async _cacheMeta(id, data, context) {
    return this.cacheService.set(`meta:${id}`, data, context);
  }

  /**
   * Database save operations
   * @param id
   * @param catalogData
   * @param meta
   * @private
   */
  async _saveBuildMetadata(id, catalogData, meta) {
    try {
      const updatedData = {
        ...catalogData,
        meta: { meta },
        lastUpdated: new Date().toISOString(),
      };

      await this.database.saveMovie(id, updatedData);
    } catch (error) {
      logger.warn("Failed to save built metadata", {
        id,
        error: error.message,
      });
    }
  }

  async _saveScrapedMovie(id, movieData) {
    try {
      const dataWithTimestamp = {
        ...movieData,
        lastUpdated: new Date().toISOString(),
      };

      await this.database.saveMovie(id, dataWithTimestamp);
    } catch (error) {
      logger.warn("Failed to save scraped movie", { id, error: error.message });
    }
  }

  /**
   * Error handling with proper logging and response
   * @param error
   * @param context
   * @private
   */
  _handleError(error, context) {
    const errorContext = {
      ...context,
      errorType: error.name,
      errorCode: error.code,
      message: error.message,
    };

    if (
      error.code === ErrorCodes.INVALID_INPUT ||
      error.code === ErrorCodes.INVALID_ID_FORMAT
    ) {
      logger.warn("Invalid input provided", errorContext);
    } else {
      logger.error("Meta handler error", {
        ...errorContext,
        stack: error.stack,
      });
    }

    return { meta: null };
  }

  /**
   * Generate unique request ID for tracing
   * @private
   */
  _generateRequestId() {
    return `meta_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = MetaHandler;
