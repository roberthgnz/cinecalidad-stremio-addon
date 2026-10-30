/**
 * Cache Service
 * Handles caching with proper TTL, eviction, and performance monitoring
 */

const logger = require("../../lib/logger");

class CacheService {
  constructor(database) {
    this.database = database;
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      errors: 0,
    };
    this.startedAt = Date.now();
    // Expired rows are purged by the scheduled cleanup (cron on Workers,
    // interval in the Node server); reads already ignore expired entries
  }

  /**
   * Get item from cache
   * @param {string} key - Cache key
   * @param {object} context - Request context for logging
   * @returns {*} Cached value or null
   */
  async get(key, context = {}) {
    const cacheContext = { ...context, cacheKey: key, operation: "get" };

    try {
      const startTime = Date.now();
      const result = await this.database.getCache(key);
      const duration = Date.now() - startTime;

      if (result) {
        this.stats.hits++;
        logger.debug("Cache hit", { ...cacheContext, duration });
        return result;
      } else {
        this.stats.misses++;
        logger.debug("Cache miss", { ...cacheContext, duration });
        return null;
      }
    } catch (error) {
      this.stats.errors++;
      logger.warn("Cache get error", { ...cacheContext, error: error.message });
      return null; // Graceful degradation
    }
  }

  /**
   * Set item in cache
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   * @param {object} context - Request context for logging
   * @param {number} ttlMinutes - TTL in minutes
   * @returns {boolean} Success status
   */
  async set(key, value, context = {}, ttlMinutes = 30) {
    const cacheContext = {
      ...context,
      cacheKey: key,
      operation: "set",
      ttlMinutes,
    };

    try {
      const startTime = Date.now();
      await this.database.setCache(key, value, ttlMinutes);
      const duration = Date.now() - startTime;

      this.stats.sets++;
      logger.debug("Cache set successful", { ...cacheContext, duration });
      return true;
    } catch (error) {
      this.stats.errors++;
      logger.warn("Cache set error", { ...cacheContext, error: error.message });
      return false;
    }
  }

  /**
   * Delete item from cache
   * @param {string} key - Cache key
   * @param {object} context - Request context for logging
   * @returns {boolean} Success status
   */
  async delete(key, context = {}) {
    const cacheContext = { ...context, cacheKey: key, operation: "delete" };

    try {
      await this.database.deleteCache(key);
      logger.debug("Cache delete successful", cacheContext);
      return true;
    } catch (error) {
      this.stats.errors++;
      logger.warn("Cache delete error", {
        ...cacheContext,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Get or set pattern - common caching pattern
   * @param {string} key - Cache key
   * @param {Function} producer - Function that produces the value if not cached
   * @param {object} context - Request context
   * @param {number} ttlMinutes - TTL in minutes
   * @returns {*} Cached or produced value
   */
  async getOrSet(key, producer, context = {}, ttlMinutes = 30) {
    const cached = await this.get(key, context);

    if (cached !== null) {
      return cached;
    }

    try {
      const value = await producer();

      if (value !== null && value !== undefined) {
        await this.set(key, value, context, ttlMinutes);
      }

      return value;
    } catch (error) {
      logger.error("Cache producer function failed", {
        ...context,
        cacheKey: key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Clear all cache entries matching a pattern
   * @param {string} pattern - Key pattern (supports wildcards)
   * @param {object} context - Request context
   * @returns {number} Number of entries cleared
   */
  async clearPattern(pattern, context = {}) {
    try {
      // This would need implementation in the database layer
      // For now, just log the request
      logger.info("Cache pattern clear requested", { pattern, ...context });
      return 0;
    } catch (error) {
      logger.error("Cache pattern clear failed", {
        pattern,
        ...context,
        error: error.message,
      });
      return 0;
    }
  }

  /**
   * Get cache statistics
   * @returns {object} Cache statistics
   */
  getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate =
      totalRequests > 0
        ? ((this.stats.hits / totalRequests) * 100).toFixed(2)
        : 0;

    return {
      ...this.stats,
      hitRate: parseFloat(hitRate),
      totalRequests,
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      errors: 0,
    };

    logger.info("Cache statistics reset");
  }

  /**
   * Get cache health status
   * @returns {object} Health information
   */
  getHealth() {
    const stats = this.getStats();

    return {
      status:
        stats.errors < stats.totalRequests * 0.05 ? "healthy" : "degraded",
      hitRate: stats.hitRate,
      errorRate:
        stats.totalRequests > 0
          ? ((stats.errors / stats.totalRequests) * 100).toFixed(2)
          : 0,
      totalRequests: stats.totalRequests,
      uptime: (Date.now() - this.startedAt) / 1000,
    };
  }

  /**
   * Perform cache cleanup
   * @private
   */
  async _performCleanup() {
    try {
      const startTime = Date.now();
      await this.database.clearExpiredCache();
      const duration = Date.now() - startTime;

      logger.debug("Cache cleanup completed", { duration });
    } catch (error) {
      logger.error("Cache cleanup failed", { error: error.message });
    }
  }

  /**
   * Shutdown cache service gracefully
   */
  shutdown() {
    logger.info("Cache service shut down", { finalStats: this.getStats() });
  }
}

module.exports = { CacheService };
