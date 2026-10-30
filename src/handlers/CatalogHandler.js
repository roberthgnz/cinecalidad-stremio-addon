/**
 * @file Catalog Handler for Cinecalidad Stremio addon
 * @author Cinecalidad Team
 * @version 1.0.0
 */

"use strict";

const logger = require("../../lib/logger");
const { createError, ErrorCodes } = require("../lib/errors");
const { CacheService } = require("../services/CacheService");

/**
 * Catalog Handler
 * Manages movie catalog requests with proper caching and error handling
 * @class
 */
class CatalogHandler {
  /**
   * @param {object} dependencies - Injected dependencies
   * @param {object} dependencies.database - Database instance
   * @param {object} dependencies.cineCalidadService - Cinecalidad service instance
   */
  constructor(dependencies) {
    this.database = dependencies.database;
    this.cineCalidadService = dependencies.cineCalidadService;
    this.cacheService = new CacheService(dependencies.database);

    // Constants
    this.SUPPORTED_CATALOGS = new Set([
      "cinecalidad-latest",
      "cinecalidad-search",
    ]);
    this.DEFAULT_LIMIT = 20;
    this.MAX_LIMIT = 100;

    // Bind methods
    this.handle = this.handle.bind(this);
  }

  /**
   * Handle catalog request
   * @param {object} args - Request arguments
   * @param {string} args.type - Content type (movie)
   * @param {string} args.id - Catalog ID
   * @param {object} args.extra - Extra parameters
   * @returns {Promise<object>} Catalog response
   */
  async handle(args) {
    try {
      // Validate input
      this._validateRequest(args);

      // Check if this is a supported catalog
      if (!this._isSupportedCatalog(args)) {
        return { metas: [] };
      }

      // Parse query parameters
      const query = this._parseQuery(args);

      // Check cache first
      const cacheKey = this._generateCacheKey(query);
      const cachedData = await this.cacheService.get(cacheKey);

      if (cachedData) {
        logger.debug("Returning cached catalog results", {
          cacheKey,
          itemCount: cachedData.metas?.length || 0,
        });
        return cachedData;
      }

      // Fetch fresh data
      const releases = await this._fetchReleases(query);
      const metas = this._transformToMetas(releases);

      const result = { metas };

      // Cache the result
      await this.cacheService.set(cacheKey, result);

      logger.info("Catalog request processed successfully", {
        query,
        itemCount: metas.length,
      });

      return result;
    } catch (error) {
      logger.error("Catalog handler error", {
        error: error.message,
        args,
      });
      throw error;
    }
  }

  /**
   * Validate catalog request
   * @private
   * @param {object} args - Request arguments
   * @throws {Error} If validation fails
   */
  _validateRequest(args) {
    if (!args || typeof args !== "object") {
      throw createError(
        ErrorCodes.INVALID_INPUT,
        "Invalid catalog request arguments",
      );
    }

    if (args.type !== "movie") {
      throw createError(
        ErrorCodes.UNSUPPORTED_TYPE,
        `Unsupported content type: ${args.type}`,
      );
    }

    if (!args.id || typeof args.id !== "string") {
      throw createError(ErrorCodes.INVALID_INPUT, "Catalog ID is required");
    }
  }

  /**
   * Check if catalog is supported
   * @private
   * @param {object} args - Request arguments
   * @returns {boolean} True if supported
   */
  _isSupportedCatalog(args) {
    return this.SUPPORTED_CATALOGS.has(args.id);
  }

  /**
   * Parse query parameters from request
   * @private
   * @param {object} args - Request arguments
   * @returns {object} Parsed query
   */
  _parseQuery(args) {
    const query = {
      search: args.extra?.search || "",
      skip: Math.max(0, parseInt(args.extra?.skip, 10) || 0),
      limit: Math.min(
        this.MAX_LIMIT,
        parseInt(args.extra?.limit, 10) || this.DEFAULT_LIMIT,
      ),
    };

    // Sanitize search query
    if (query.search) {
      query.search = query.search.trim().substring(0, 100); // Limit search length
    }

    return query;
  }

  /**
   * Generate cache key for request
   * @private
   * @param {object} query - Query parameters
   * @returns {string} Cache key
   */
  _generateCacheKey(query) {
    return `catalog_${query.search}_${query.skip}_${query.limit}`;
  }

  /**
   * Fetch releases from Cinecalidad service
   * @private
   * @param {object} query - Query parameters
   * @returns {Promise<Array>} Array of releases
   */
  async _fetchReleases(query) {
    try {
      logger.debug("Fetching catalog data from Cinecalidad", { query });
      return await this.cineCalidadService.performQuery(query);
    } catch (error) {
      logger.error("Failed to fetch releases from Cinecalidad", {
        error: error.message,
        query,
      });
      throw createError(ErrorCodes.SERVICE_ERROR, "Failed to fetch movie data");
    }
  }

  /**
   * Transform releases to Stremio meta format
   * @private
   * @param {Array} releases - Array of releases
   * @returns {Array} Array of metas
   */
  _transformToMetas(releases) {
    if (!Array.isArray(releases)) {
      logger.warn("Invalid releases format, expected array");
      return [];
    }

    return releases
      .map((release) => this._createMetaFromRelease(release))
      .filter((meta) => meta !== null);
  }

  /**
   * Create Stremio meta from release
   * @private
   * @param {object} release - Release object
   * @returns {object | null} Meta object or null if invalid
   */
  _createMetaFromRelease(release) {
    try {
      const stremioId = this._createStremioId(release);
      if (!stremioId) {
        logger.debug("Skipping release without valid ID", {
          title: release.title,
        });
        return null;
      }

      return {
        id: stremioId,
        type: "movie",
        name: this._getMovieTitle(release),
        poster: this._validatePosterUrl(release.poster),
        year: this._parseYear(release.year),
        description: this._createDescription(release),
        genres: this._getGenres(release),
      };
    } catch (error) {
      logger.warn("Failed to create meta from release", {
        error: error.message,
        release: release.title,
      });
      return null;
    }
  }

  /**
   * Create Stremio-compatible ID
   * @private
   * @param {object} release - Release object
   * @returns {string|null} Stremio ID or null
   */
  _createStremioId(release) {
    // Use movie ID as primary identifier
    if (release.id) {
      return `cc_${release.id}`;
    }

    // Fallback to IMDB ID if available
    if (release.imdbId && release.imdbId.startsWith("tt")) {
      return release.imdbId;
    }

    return null;
  }

  /**
   * Get movie title with fallback
   * @private
   * @param {object} release - Release object
   * @returns {string} Movie title
   */
  _getMovieTitle(release) {
    return release.originalTitle || release.title || "Unknown Title";
  }

  /**
   * Validate and return poster URL
   * @private
   * @param {string} posterUrl - Poster URL
   * @returns {string|undefined} Valid poster URL or undefined
   */
  _validatePosterUrl(posterUrl) {
    if (!posterUrl || typeof posterUrl !== "string") {
      return undefined;
    }

    try {
      const url = new URL(posterUrl);
      return url.protocol === "https:" ? posterUrl : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Parse year from various formats
   * @private
   * @param {*} year - Year value
   * @returns {number|undefined} Parsed year or undefined
   */
  _parseYear(year) {
    if (!year) return undefined;

    const parsed = parseInt(year, 10);
    return parsed >= 1900 && parsed <= new Date().getFullYear() + 5
      ? parsed
      : undefined;
  }

  /**
   * Create description from release data
   * @private
   * @param {object} release - Release object
   * @returns {string} Description
   */
  _createDescription(release) {
    const parts = [];

    if (release.quality) {
      parts.push(`Quality: ${release.quality}`);
    }

    if (release.size && release.size > 0) {
      const sizeGB =
        Math.round((release.size / 1024 / 1024 / 1024) * 100) / 100;
      parts.push(`Size: ${sizeGB}GB`);
    }

    return parts.join(" | ") || "Movie from Cinecalidad";
  }

  /**
   * Get genres from release
   * @private
   * @param {object} release - Release object
   * @returns {Array|undefined} Array of genres or undefined
   */
  _getGenres(release) {
    // "movie" is the content type, not a genre
    if (
      release.category &&
      typeof release.category === "string" &&
      release.category !== "movie"
    ) {
      return [release.category];
    }
    return undefined;
  }
}

module.exports = CatalogHandler;
