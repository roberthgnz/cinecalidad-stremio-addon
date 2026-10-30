const logger = require("./logger");

/**
 * Database service backed by a Cloudflare D1-compatible client.
 * On Workers this is the `DB` binding; under Node it is SqliteD1Adapter.
 * Schema lives in /migrations.
 */
class DatabaseService {
  /**
   * @param {object} db - D1Database (or compatible adapter)
   */
  constructor(db) {
    if (!db) {
      throw new Error("[Database] No D1 database provided");
    }
    this.db = db;
  }

  // Métodos para películas
  async saveMovie(movieId, movieData) {
    try {
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO movies (id, data, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)`,
        )
        .bind(movieId, JSON.stringify(movieData))
        .run();

      logger.debug(`[Database] Saved movie data for ID: ${movieId}`);
    } catch (error) {
      logger.error(`[Database] Error saving movie ${movieId}:`, error);
    }
  }

  async getMovie(movieId) {
    try {
      const result = await this.db
        .prepare("SELECT data FROM movies WHERE id = ?")
        .bind(movieId)
        .first();

      if (result) {
        return JSON.parse(result.data);
      }
      return null;
    } catch (error) {
      logger.error(`[Database] Error getting movie ${movieId}:`, error);
      return null;
    }
  }

  async getAllMovies() {
    try {
      const { results } = await this.db
        .prepare("SELECT id, data FROM movies ORDER BY updated_at DESC")
        .all();

      const movies = {};
      results.forEach((row) => {
        movies[row.id] = JSON.parse(row.data);
      });

      return movies;
    } catch (error) {
      logger.error("[Database] Error getting all movies:", error);
      return {};
    }
  }

  // Buscar película por ID de Cinecalidad en el catálogo guardado
  async findMovieByOriginalId(originalId) {
    try {
      const row = await this.db
        .prepare(
          `SELECT id, data FROM movies
           WHERE json_extract(data, '$.release.id') = ?
              OR json_extract(data, '$.movieDetails.id') = ?
           LIMIT 1`,
        )
        .bind(originalId, originalId)
        .first();

      if (!row) {
        return null;
      }

      return {
        stremioId: row.id,
        data: JSON.parse(row.data),
      };
    } catch (error) {
      logger.error(
        `[Database] Error finding movie by original ID ${originalId}:`,
        error,
      );
      return null;
    }
  }

  // Métodos para caché
  async setCache(key, data, ttlMinutes = 60) {
    try {
      const expiresAt = new Date(
        Date.now() + ttlMinutes * 60 * 1000,
      ).toISOString();

      await this.db
        .prepare(
          `INSERT OR REPLACE INTO cache (key, data, expires_at)
           VALUES (?, ?, ?)`,
        )
        .bind(key, JSON.stringify(data), expiresAt)
        .run();

      logger.debug(
        `[Database] Cached data for key: ${key} (expires: ${expiresAt})`,
      );
    } catch (error) {
      logger.error(`[Database] Error setting cache ${key}:`, error);
    }
  }

  async getCache(key) {
    try {
      // expires_at is stored as ISO-8601, so compare against an ISO "now"
      const result = await this.db
        .prepare("SELECT data FROM cache WHERE key = ? AND expires_at > ?")
        .bind(key, new Date().toISOString())
        .first();

      if (result) {
        logger.debug(`[Database] Cache hit for key: ${key}`);
        return JSON.parse(result.data);
      }

      logger.debug(`[Database] Cache miss for key: ${key}`);
      return null;
    } catch (error) {
      logger.error(`[Database] Error getting cache ${key}:`, error);
      return null;
    }
  }

  async deleteCache(key) {
    try {
      const result = await this.db
        .prepare("DELETE FROM cache WHERE key = ?")
        .bind(key)
        .run();

      if (result.meta.changes > 0) {
        logger.debug(`[Database] Deleted cache for key: ${key}`);
      }
    } catch (error) {
      logger.error(`[Database] Error deleting cache ${key}:`, error);
    }
  }

  async clearExpiredCache() {
    try {
      const result = await this.db
        .prepare("DELETE FROM cache WHERE expires_at <= ?")
        .bind(new Date().toISOString())
        .run();

      if (result.meta.changes > 0) {
        logger.info(
          `[Database] Cleared ${result.meta.changes} expired cache entries`,
        );
      }
    } catch (error) {
      logger.error("[Database] Error clearing expired cache:", error);
    }
  }

  // Métodos para torrents
  async saveTorrent(infoHash, torrentData) {
    try {
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO torrents (info_hash, data, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)`,
        )
        .bind(infoHash, JSON.stringify(torrentData))
        .run();

      // Get the ID of the inserted/updated record
      const id = await this.db
        .prepare("SELECT id FROM torrents WHERE info_hash = ?")
        .bind(infoHash)
        .first("id");

      logger.debug(
        `[Database] Saved torrent data for hash: ${infoHash}, ID: ${id}`,
      );
      return id;
    } catch (error) {
      logger.error(`[Database] Error saving torrent ${infoHash}:`, error);
      return null;
    }
  }

  async getTorrent(infoHash) {
    try {
      const result = await this.db
        .prepare("SELECT data FROM torrents WHERE info_hash = ?")
        .bind(infoHash)
        .first();

      if (result) {
        return JSON.parse(result.data);
      }
      return null;
    } catch (error) {
      logger.error(`[Database] Error getting torrent ${infoHash}:`, error);
      return null;
    }
  }

  async getTorrentById(id) {
    try {
      const result = await this.db
        .prepare("SELECT info_hash, data FROM torrents WHERE id = ?")
        .bind(id)
        .first();

      if (result) {
        return {
          infoHash: result.info_hash,
          ...JSON.parse(result.data),
        };
      }
      return null;
    } catch (error) {
      logger.error(`[Database] Error getting torrent by ID ${id}:`, error);
      return null;
    }
  }

  // Métodos de mantenimiento
  async cleanup() {
    try {
      await this.clearExpiredCache();

      // Limpiar películas muy antiguas (más de 7 días)
      const result = await this.db
        .prepare(
          "DELETE FROM movies WHERE updated_at < datetime('now', '-7 days')",
        )
        .run();

      if (result.meta.changes > 0) {
        logger.info(
          `[Database] Cleaned up ${result.meta.changes} old movie entries`,
        );
      }
    } catch (error) {
      logger.error("[Database] Error during cleanup:", error);
    }
  }

  async getStats() {
    try {
      const count = (sql, ...params) =>
        this.db
          .prepare(sql)
          .bind(...params)
          .first("count");

      const [movies, cache, torrents] = await Promise.all([
        count("SELECT COUNT(*) as count FROM movies"),
        count(
          "SELECT COUNT(*) as count FROM cache WHERE expires_at > ?",
          new Date().toISOString(),
        ),
        count("SELECT COUNT(*) as count FROM torrents"),
      ]);

      return { movies, cache, torrents };
    } catch (error) {
      logger.error("[Database] Error getting stats:", error);
      return { movies: 0, cache: 0, torrents: 0 };
    }
  }
}

// Singleton, bound to whichever D1 client the runtime configures
let instance = null;

module.exports = {
  DatabaseService,

  /**
   * Bind the database layer to a D1 client. Call once per runtime:
   * the Worker passes `env.DB`, Node passes a SqliteD1Adapter.
   * @param {object} db - D1Database (or compatible adapter)
   * @returns {DatabaseService} Database service
   */
  configure(db) {
    if (!instance) {
      instance = new DatabaseService(db);
    } else {
      // Rebind in place so services holding the instance see the new client
      instance.db = db;
    }
    return instance;
  },

  getInstance() {
    if (!instance) {
      throw new Error(
        "[Database] Not configured. Call configure(db) before use.",
      );
    }
    return instance;
  },
};
