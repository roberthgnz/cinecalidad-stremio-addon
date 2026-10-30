/**
 * @file Main Stremio addon implementation
 * @author Cinecalidad Team
 * @version 1.0.0
 */

"use strict";

// Builder only: the SDK index also pulls in express-based servers
const AddonBuilder = require("stremio-addon-sdk/src/builder");
const { getManifest, config } = require("../config/settings.js");
const CineCalidadService = require("../services/cine-calidad-service.js");
const TorrentParserService = require("../services/torrent-parser-service.js");
const { movieMetadata } = require("../lib/metadata.js");
const logger = require("../lib/logger");
const { getInstance: getDatabase } = require("../lib/database");

// Import handlers
const MetaHandler = require("./handlers/MetaHandler");
const { ErrorHandler } = require("./lib/errors");

// Import specialized handlers
const CatalogHandler = require("./handlers/CatalogHandler");
const StreamHandler = require("./handlers/StreamHandler");

/**
 * Constants for the addon
 */
const Constants = Object.freeze({
  STREMIO_ID_PREFIX: "cc_",
  CACHE_CLEANUP_INTERVAL: 30 * 60 * 1000, // 30 minutes
  DEFAULT_CATALOG_LIMIT: 20,
  SUPPORTED_VIDEO_EXTENSIONS: [
    "mp4",
    "mkv",
    "avi",
    "mov",
    "wmv",
    "flv",
    "m4v",
    "webm",
  ],
  BINGE_GROUP_PREFIX: "cinecalidad-",
  COUNTRY_WHITELIST: [
    "MX",
    "ES",
    "AR",
    "CO",
    "PE",
    "CL",
    "VE",
    "EC",
    "BO",
    "PY",
    "UY",
  ],
});

/**
 * Dependency injection container
 * @class
 */
class DependencyContainer {
  constructor() {
    this._dependencies = new Map();
    this._initialized = false;
  }

  /**
   * Initialize all dependencies
   * @throws {Error} If initialization fails
   */
  async initialize() {
    if (this._initialized) {
      return;
    }

    try {
      // Initialize database
      const database = getDatabase();
      this._dependencies.set("database", database);

      // Initialize Cinecalidad service
      const cineCalidadService = new CineCalidadService({
        siteLink: config.cinecalidad.siteLink,
        maxLatestPageLimit: config.cinecalidad.maxLatestPageLimit,
        maxSearchPageLimit: config.cinecalidad.maxSearchPageLimit,
        requestDelay: config.cinecalidad.requestDelay,
        detailsDelay: config.cinecalidad.detailsDelay,
      });
      this._dependencies.set("cineCalidadService", cineCalidadService);

      // Initialize torrent parser service
      const torrentParserService = TorrentParserService.getInstance();
      this._dependencies.set("torrentParserService", torrentParserService);

      // Initialize metadata service
      const metadataService = { getMovieMetadata: movieMetadata };
      this._dependencies.set("metadataService", metadataService);

      this._initialized = true;
      logger.info("Dependencies initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize dependencies", {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get dependency by name
   * @param {string} name - Dependency name
   * @returns {*} The dependency instance
   * @throws {Error} If dependency not found
   */
  get(name) {
    if (!this._initialized) {
      throw new Error("Dependencies not initialized");
    }

    if (!this._dependencies.has(name)) {
      throw new Error(`Dependency '${name}' not found`);
    }

    return this._dependencies.get(name);
  }

  /**
   * Get all dependencies as object
   * @returns {object} All dependencies
   */
  getAll() {
    if (!this._initialized) {
      throw new Error("Dependencies not initialized");
    }

    return Object.fromEntries(this._dependencies);
  }
}

/**
 * Main Addon class
 * @class
 */
class CineCalidadAddon {
  constructor() {
    this.container = new DependencyContainer();
    this.builder = null;
    this.handlers = new Map();
  }

  /**
   * Initialize the addon
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      await this.container.initialize();
      await this._initializeHandlers();
      this._buildAddon();

      logger.info("Cinecalidad addon initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize addon", { error: error.message });
      throw error;
    }
  }

  /**
   * Initialize all handlers
   * @private
   */
  async _initializeHandlers() {
    const dependencies = this.container.getAll();

    // Initialize handlers
    this.handlers.set("meta", new MetaHandler(dependencies));
    this.handlers.set("catalog", new CatalogHandler(dependencies));
    this.handlers.set("stream", new StreamHandler(dependencies));
  }

  /**
   * Shutdown the addon gracefully
   */
  async shutdown() {
    try {
      // Shutdown handlers if they have cleanup methods
      if (
        this.catalogHandler &&
        this.catalogHandler.cacheService &&
        this.catalogHandler.cacheService.shutdown
      ) {
        this.catalogHandler.cacheService.shutdown();
      }
      if (
        this.streamHandler &&
        this.streamHandler.cacheService &&
        this.streamHandler.cacheService.shutdown
      ) {
        this.streamHandler.cacheService.shutdown();
      }

      // Clean up torrent parser service
      const torrentParserService = this.container?.get("torrentParserService");
      if (torrentParserService && torrentParserService.destroy) {
        torrentParserService.destroy();
      }

      logger.info("Addon shutdown completed");
    } catch (error) {
      logger.error("Error during addon shutdown", { error: error.message });
    }
  }

  /**
   * Build the Stremio addon
   * @private
   */
  _buildAddon() {
    // `new`: the SDK builder assigns to `this`, which is undefined in strict-mode bundles
    this.builder = new AddonBuilder(getManifest());

    // Define handlers
    this.builder.defineCatalogHandler(this._createCatalogHandler());
    this.builder.defineMetaHandler(this._createMetaHandler());
    this.builder.defineStreamHandler(this._createStreamHandler());
  }

  /**
   * Create catalog handler
   * @private
   * @returns {Function} Catalog handler function
   */
  _createCatalogHandler() {
    return async (args) => {
      const requestId = this._generateRequestId();
      const startTime = performance.now();

      try {
        logger.info("Catalog request initiated", {
          requestId,
          type: args.type,
          id: args.id,
        });

        const handler = this.handlers.get("catalog");
        const result = await handler.handle(args);

        const duration = performance.now() - startTime; // ms

        logger.info("Catalog request completed", {
          requestId,
          success: true,
          duration,
          itemCount: result.metas?.length || 0,
        });

        return result;
      } catch (error) {
        const duration = performance.now() - startTime;

        logger.error("Catalog request failed", {
          requestId,
          duration,
          error: error.message,
        });

        return ErrorHandler.handle(error, {
          requestId,
          type: args.type,
          id: args.id,
        });
      }
    };
  }

  /**
   * Create meta handler
   * @private
   * @returns {Function} Meta handler function
   */
  _createMetaHandler() {
    return async (args) => {
      const requestId = this._generateRequestId();
      const startTime = performance.now();

      try {
        logger.info("Meta request initiated", {
          requestId,
          type: args.type,
          id: args.id,
        });

        const handler = this.handlers.get("meta");
        const result = await handler.handle(args);

        const duration = performance.now() - startTime;

        logger.info("Meta request completed", {
          requestId,
          success: !!result.meta,
          duration,
          title: result.meta?.name,
        });

        return result;
      } catch (error) {
        const duration = performance.now() - startTime;

        logger.error("Meta request failed", {
          requestId,
          duration,
          error: error.message,
        });

        return ErrorHandler.handle(error, {
          requestId,
          type: args.type,
          id: args.id,
        });
      }
    };
  }

  /**
   * Create stream handler
   * @private
   * @returns {Function} Stream handler function
   */
  _createStreamHandler() {
    return async (args) => {
      const requestId = this._generateRequestId();
      const startTime = performance.now();

      try {
        logger.info("Stream request initiated", {
          requestId,
          type: args.type,
          id: args.id,
        });

        const handler = this.handlers.get("stream");
        const result = await handler.handle(args);

        const duration = performance.now() - startTime;

        logger.info("Stream request completed", {
          requestId,
          success: true,
          duration,
          streamCount: result.streams?.length || 0,
        });

        return result;
      } catch (error) {
        const duration = performance.now() - startTime;

        logger.error("Stream request failed", {
          requestId,
          duration,
          error: error.message,
        });

        return ErrorHandler.handle(error, {
          requestId,
          type: args.type,
          id: args.id,
        });
      }
    };
  }

  /**
   * Generate unique request ID
   * @private
   * @returns {string} Request ID
   */
  _generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Get the addon builder
   * @returns {object} Stremio addon builder
   */
  getBuilder() {
    return this.builder;
  }
}

/**
 * Factory function to create and initialize addon
 * @returns {Promise<object>} Addon builder
 */
async function createAddon() {
  const addon = new CineCalidadAddon();
  await addon.initialize();
  return addon.getBuilder();
}

// Export the addon creation function
module.exports = { createAddon, CineCalidadAddon, Constants };
