/**
 * @fileoverview Main application entry point
 * @author Cinecalidad Team
 * @version 1.0.0
 */

"use strict";

const path = require("path");
const express = require("express");
const { config, getAddonUrl } = require("./config/settings.js");
const { createAddon, Constants } = require("./src/addon.js");
const { configure: configureDatabase } = require("./lib/database");
const { SqliteD1Adapter } = require("./lib/sqlite-d1-adapter");
const logger = require("./lib/logger");

const DATABASE_PATH =
  process.env.DATABASE_PATH || path.join(__dirname, "data", "cinecalidad.db");

/**
 * Application class
 * @class
 */
class CineCalidadApp {
  constructor() {
    this.app = express();
    this.server = null;
    this.addon = null;
    this.database = null;
    this.cleanupInterval = null;
  }

  /**
   * Initialize and start the application
   * @returns {Promise<void>}
   */
  async start() {
    try {
      logger.info("Starting Cinecalidad Stremio Addon...");

      await this._initializeAddon();
      this._setupMiddleware();
      this._setupRoutes();
      await this._startServer();

      logger.info("Application started successfully", {
        port: config.server.port,
        host: config.server.host,
        addonUrl: getAddonUrl(),
      });
    } catch (error) {
      logger.error("Failed to start application", { error: error.message });
      process.exit(1);
    }
  }

  /**
   * Initialize the Stremio addon
   * @private
   */
  async _initializeAddon() {
    try {
      this.database = configureDatabase(new SqliteD1Adapter(DATABASE_PATH));
      this.cleanupInterval = setInterval(() => {
        this.database.cleanup();
      }, Constants.CACHE_CLEANUP_INTERVAL);

      this.addon = await createAddon();
      logger.info("Addon initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize addon", { error: error.message });
      throw error;
    }
  }

  /**
   * Setup Express middleware
   * @private
   */
  _setupMiddleware() {
    // CORS middleware (required by Stremio)
    this.app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept",
      );
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );

      if (req.method === "OPTIONS") {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // Request logging middleware
    this.app.use((req, res, next) => {
      logger.debug("Request received", {
        method: req.method,
        url: req.url,
        userAgent: req.get("User-Agent"),
      });
      next();
    });
  }

  /**
   * Setup application routes
   * @private
   */
  _setupRoutes() {
    // Health check endpoint
    this.app.get("/health", (req, res) => {
      res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        version: require("./package.json").version,
      });
    });

    // Addon routes
    const { getRouter } = require("stremio-addon-sdk");
    const addonRouter = getRouter(this.addon.getInterface());
    this.app.use("/", addonRouter);

    // Also expose manifest at root for compatibility
    this.app.get("/manifest.json", (req, res) => {
      res.json(this.addon.getInterface().manifest);
    });

    // Error handling middleware
    this.app.use((err, req, res, next) => {
      logger.error("Express error handler", {
        error: err.message,
        stack: err.stack,
        url: req.url,
      });

      res.status(500).json({
        error: "Internal Server Error",
        message:
          process.env.NODE_ENV === "development"
            ? err.message
            : "Something went wrong",
      });
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: "Not Found",
        message: `Route ${req.url} not found`,
      });
    });
  }

  /**
   * Start the HTTP server
   * @private
   * @returns {Promise<void>}
   */
  async _startServer() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(
        config.server.port,
        config.server.host,
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      );

      this.server.on("error", (error) => {
        if (error.code === "EADDRINUSE") {
          logger.error("Port already in use", { port: config.server.port });
        } else {
          logger.error("Server error", { error: error.message });
        }
        reject(error);
      });
    });
  }

  /**
   * Graceful shutdown
   * @returns {Promise<void>}
   */
  async shutdown() {
    logger.info("Shutting down application...");

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info("Server closed successfully");
          resolve();
        });
      });
    }
  }
}

/**
 * Main application startup function
 */
async function startApplication() {
  const app = new CineCalidadApp();

  // Setup graceful shutdown
  process.on("SIGINT", async () => {
    logger.info("SIGINT received, shutting down gracefully...");
    await app.shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received, shutting down gracefully...");
    await app.shutdown();
    process.exit(0);
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled Promise Rejection", {
      reason: reason?.message || reason,
      promise: promise.toString(),
    });
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught Exception", {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });

  await app.start();
}

// Start the application if this is the main module
if (require.main === module) {
  startApplication().catch((error) => {
    logger.error("Failed to start application", { error: error.message });
    process.exit(1);
  });
}

module.exports = { CineCalidadApp, startApplication };
