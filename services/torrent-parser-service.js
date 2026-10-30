const parseMagnet = require("magnet-uri");
const parseTorrentTitle = require("parse-torrent-title");
const logger = require("../lib/logger");

class TorrentParserService {
  constructor() {
    this.torrentCache = new Map();
    this.cacheTimeout = 30 * 60 * 1000; // 30 minutes
    // Expired entries are evicted lazily on read (no timers: Workers
    // can't run background intervals)
  }

  // Singleton instance
  static instance = null;

  static getInstance() {
    if (!TorrentParserService.instance) {
      TorrentParserService.instance = new TorrentParserService();
    }
    return TorrentParserService.instance;
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.torrentCache.clear();
  }

  /**
   * Reset singleton instance
   */
  static resetInstance() {
    if (TorrentParserService.instance) {
      TorrentParserService.instance.destroy();
      TorrentParserService.instance = null;
    }
  }

  /**
   * Get detailed torrent information from magnet URI
   * @param {string} magnetUri - Magnet URI
   * @returns {Promise<Object>} Torrent information
   */
  async getTorrentInfo(magnetUri) {
    try {
      logger.debug(
        `[TorrentParserService] Processing magnet URI: ${magnetUri.substring(0, 100)}...`,
      );

      // Validate magnet URI format first
      if (!magnetUri || !magnetUri.startsWith("magnet:")) {
        logger.error(
          `[TorrentParserService] Invalid magnet URI: not a magnet link`,
        );
        return null;
      }

      const infoHash = this.extractInfoHash(magnetUri);
      if (!infoHash) {
        logger.error(
          `[TorrentParserService] Invalid magnet URI: no valid info hash found`,
        );
        return null;
      }

      logger.debug(
        `[TorrentParserService] Valid magnet URI with hash: ${infoHash}`,
      );

      // Check cache first
      const cacheKey = infoHash;
      if (cacheKey && this.torrentCache.has(cacheKey)) {
        const cached = this.torrentCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          logger.debug(
            `[TorrentParserService] Returning cached result for hash: ${infoHash}`,
          );
          return cached.data;
        }
        this.torrentCache.delete(cacheKey);
      }

      // Parse magnet URI using magnet-uri
      let torrentInfo;
      try {
        const parsed = parseMagnet(magnetUri);
        torrentInfo = this.extractTorrentInfo(parsed);

        // Cache the result
        if (cacheKey) {
          this.torrentCache.set(cacheKey, {
            data: torrentInfo,
            timestamp: Date.now(),
          });
        }

        logger.debug(
          `[TorrentParserService] Successfully parsed torrent: ${torrentInfo.name}`,
        );
        return torrentInfo;
      } catch (parseError) {
        logger.warn(
          `[TorrentParserService] Failed to parse with magnet-uri, falling back to basic parsing:`,
          parseError.message,
        );

        // Fallback to basic magnet parsing
        torrentInfo = this.parseBasicMagnetInfo(magnetUri);

        // Cache the fallback result
        if (cacheKey && torrentInfo) {
          this.torrentCache.set(cacheKey, {
            data: torrentInfo,
            timestamp: Date.now(),
          });
        }

        return torrentInfo;
      }
    } catch (error) {
      logger.error(`[TorrentParserService] Error getting torrent info:`, error);
      return null;
    }
  }

  /**
   * Extract detailed information from parsed torrent using parse-torrent-title
   * @param {Object} parsed - Parsed torrent object from magnet-uri
   * @returns {Object} Extracted torrent information
   */
  extractTorrentInfo(parsed) {
    // Validate parsed object
    if (!parsed) {
      throw new Error("Parsed torrent object is null or undefined");
    }

    const name = parsed.name || "Unknown";
    const infoHash = parsed.infoHash || "";
    const magnetUri = parsed.magnetURI || "";

    // Use parse-torrent-title to extract metadata
    const titleInfo = parseTorrentTitle.parse(name);
    logger.debug(
      `[TorrentParserService] Title info from parse-torrent-title:`,
      {
        title: titleInfo.title,
        year: titleInfo.year,
        season: titleInfo.season,
        episode: titleInfo.episode,
        resolution: titleInfo.resolution,
        source: titleInfo.source,
        codec: titleInfo.codec,
        group: titleInfo.group,
        language: titleInfo.language,
      },
    );

    // Handle files
    const files = parsed.files || [];
    const fileCount = files.length;

    // Find video files
    const videoFiles = files.filter((file) => {
      const ext = file.name ? file.name.toLowerCase().split(".").pop() : "";
      return [
        "mp4",
        "mkv",
        "avi",
        "mov",
        "wmv",
        "flv",
        "m4v",
        "webm",
        "ts",
        "mpg",
        "mpeg",
      ].includes(ext);
    });

    // Find main video file (largest)
    const mainVideoFile = videoFiles.reduce(
      (largest, file) =>
        file.length > (largest?.length || 0) ? file : largest,
      null,
    );

    // Calculate total size
    const totalSize = parsed.length || 0;

    // Create enhanced file list
    const fileList = files.map((file, index) => {
      const isVideo = file.name && this.isVideoFile(file.name);
      const fileInfo = isVideo ? parseTorrentTitle.parse(file.name) : null;

      return {
        name: file.name,
        size: file.length,
        sizeFormatted: this.formatBytes(file.length),
        index: index,
        path: file.path || file.name,
        isVideo: isVideo,
        ...(fileInfo && {
          title: fileInfo.title,
          resolution: fileInfo.resolution,
          codec: fileInfo.codec,
          language: fileInfo.language,
        }),
      };
    });

    // Return comprehensive torrent info
    return {
      // Basic info
      name: name,
      infoHash: infoHash.toLowerCase(),
      magnetUri: magnetUri,
      totalSize: totalSize,
      totalSizeFormatted:
        totalSize > 0
          ? `${(totalSize / (1024 * 1024 * 1024)).toFixed(2)} GB`
          : this.estimateSizeFromQuality(titleInfo.resolution),

      // Parsed metadata from parse-torrent-title
      title: titleInfo.title || name,
      year: titleInfo.year,
      season: titleInfo.season,
      episode: titleInfo.episode,
      resolution: titleInfo.resolution || "1080p", // Default fallback
      quality: titleInfo.resolution || "1080p",
      source: titleInfo.source,
      codec: titleInfo.codec,
      language: this.formatLanguage(titleInfo.language),
      group: titleInfo.group,

      // File information
      fileCount: fileCount,
      files: fileList,
      videoFiles: fileList.filter((f) => f.isVideo),
      mainVideoFile: mainVideoFile
        ? {
            name: mainVideoFile.name,
            size: mainVideoFile.length,
            sizeFormatted: this.formatBytes(mainVideoFile.length),
            index: videoFiles.indexOf(mainVideoFile),
          }
        : null,

      // Technical info
      trackers: parsed.announce || [],
      created: parsed.created || null,
      createdBy: parsed.createdBy || null,
      comment: parsed.comment || null,

      // Additional flags from parse-torrent-title
      complete: titleInfo.complete,
      hardcoded: titleInfo.hardcoded,
      proper: titleInfo.proper,
      repack: titleInfo.repack,
      widescreen: titleInfo.widescreen,
      unrated: titleInfo.unrated,
      extended: titleInfo.extended,
      convert: titleInfo.convert,
      dubbed: titleInfo.dubbed,
    };
  }

  /**
   * Parse basic magnet info as fallback using parse-torrent-title
   * @param {string} magnetUri - Magnet URI
   * @returns {Object} Basic torrent information
   */
  parseBasicMagnetInfo(magnetUri) {
    try {
      const url = new URL(magnetUri);
      const params = new URLSearchParams(url.search);

      const displayName = params.get("dn") || "Unknown";
      const decodedName = decodeURIComponent(displayName);

      // Use parse-torrent-title to extract info
      const titleInfo = parseTorrentTitle.parse(decodedName);

      logger.debug(`[TorrentParserService] Basic magnet title info:`, {
        title: titleInfo.title,
        resolution: titleInfo.resolution,
        source: titleInfo.source,
        language: titleInfo.language,
      });

      const exactLength = params.get("xl");
      let totalSize = 0;
      let totalSizeFormatted = this.estimateSizeFromQuality(
        titleInfo.resolution,
      );

      if (exactLength) {
        totalSize = parseInt(exactLength);
        if (totalSize > 0) {
          const gb = (totalSize / (1024 * 1024 * 1024)).toFixed(2);
          totalSizeFormatted = `${gb} GB`;
        }
      }

      const trackers = params.getAll("tr");
      const infoHash = this.extractInfoHash(magnetUri);

      return {
        // Basic info
        name: decodedName,
        infoHash: infoHash,
        magnetUri: magnetUri,
        totalSize: totalSize,
        totalSizeFormatted: totalSizeFormatted,

        // Parsed metadata from parse-torrent-title
        title: titleInfo.title || decodedName,
        year: titleInfo.year,
        season: titleInfo.season,
        episode: titleInfo.episode,
        resolution: titleInfo.resolution || "1080p", // Default fallback
        quality: titleInfo.resolution || "1080p",
        source: titleInfo.source,
        codec: titleInfo.codec,
        language: this.formatLanguage(titleInfo.language),
        group: titleInfo.group,

        // Limited file info for magnets
        fileCount: 0,
        files: [],
        videoFiles: [],
        mainVideoFile: null,
        trackers: trackers,
        created: null,
        createdBy: null,
        comment: null,

        // Additional flags
        complete: titleInfo.complete,
        hardcoded: titleInfo.hardcoded,
        proper: titleInfo.proper,
        repack: titleInfo.repack,
        widescreen: titleInfo.widescreen,
        unrated: titleInfo.unrated,
        extended: titleInfo.extended,
        convert: titleInfo.convert,
        dubbed: titleInfo.dubbed,
      };
    } catch (error) {
      logger.error(
        `[TorrentParserService] Error parsing basic magnet info:`,
        error,
      );
      return null;
    }
  }

  /**
   * Format language from parse-torrent-title result
   * @param {string|Array} language - Language info
   * @returns {string} Formatted language
   */
  formatLanguage(language) {
    if (!language) {
      return "Multi";
    }

    if (Array.isArray(language)) {
      return language.join(", ");
    }

    return language;
  }

  /**
   * Estimate file size based on quality/resolution
   * @param {string} resolution - Video resolution
   * @returns {string} Estimated size
   */
  estimateSizeFromQuality(resolution) {
    if (!resolution) return "~2-4 GB";

    const res = resolution.toLowerCase();
    if (res.includes("4k") || res.includes("2160p")) return "~8-15 GB";
    if (res.includes("1440p") || res.includes("2k")) return "~4-8 GB";
    if (res.includes("1080p") || res.includes("fhd")) return "~2-4 GB";
    if (res.includes("720p") || res.includes("hd")) return "~1-2 GB";
    if (res.includes("480p") || res.includes("sd")) return "~0.5-1 GB";

    return "~2-4 GB"; // Default estimate
  }

  /**
   * Check if file is a video file
   * @param {string} filename - File name
   * @returns {boolean} Is video file
   */
  isVideoFile(filename) {
    if (!filename) return false;

    const ext = filename.toLowerCase().split(".").pop();
    return [
      "mp4",
      "mkv",
      "avi",
      "mov",
      "wmv",
      "flv",
      "m4v",
      "webm",
      "ts",
      "mpg",
      "mpeg",
      "ogv",
      "3gp",
    ].includes(ext);
  }

  /**
   * Extract info hash from magnet URI
   * @param {string} magnetUri - Magnet URI
   * @returns {string|null} Info hash
   */
  extractInfoHash(magnetUri) {
    if (!magnetUri) return null;

    const match = magnetUri.match(
      /xt=urn:btih:([a-fA-F0-9]{40}|[a-fA-F0-9]{32})/,
    );
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Format bytes to human readable format
   * @param {number} bytes - Bytes
   * @returns {string} Formatted size
   */
  formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  /**
   * Clean up old cache entries
   */
  cleanupCache() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.torrentCache.entries()) {
      if (now - value.timestamp > this.cacheTimeout) {
        this.torrentCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(
        `[TorrentParserService] Cleaned up ${cleaned} expired cache entries`,
      );
    }
  }

  /**
   * Clear all cache
   */
  clearCache() {
    this.torrentCache.clear();
    logger.debug("[TorrentParserService] Cache cleared");
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.torrentCache.size,
      timeout: this.cacheTimeout,
    };
  }
}

module.exports = TorrentParserService;
