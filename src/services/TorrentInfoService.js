/**
 * @file Torrent Information Service
 * @author Cinecalidad Team
 * @version 1.0.0
 */

"use strict";

const logger = require("../../lib/logger");

/**
 * Service for processing torrent information
 * @class
 */
class TorrentInfoService {
  /**
   * @param {object} dependencies - Injected dependencies
   */
  constructor(dependencies) {
    this.database = dependencies.database;
    this.torrentParserService = dependencies.torrentParserService;

    this.SUPPORTED_VIDEO_EXTENSIONS = new Set([
      "mp4",
      "mkv",
      "avi",
      "mov",
      "wmv",
      "flv",
      "m4v",
      "webm",
    ]);
    this.COUNTRY_WHITELIST = [
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
    ];
  }

  /**
   * Process a magnet link
   * @param {object} link - Magnet link object
   * @param {object} movieData - Movie data
   * @param {string} id - Movie ID
   * @returns {Promise<Array>} Array of streams
   */
  async processLink(link, movieData, id) {
    try {
      logger.debug("Processing magnet link", { name: link.name });

      // Get torrent info (cached or fresh)
      let magnetInfo = await this.database.getTorrent(link.url);

      if (!magnetInfo) {
        magnetInfo = await this._fetchTorrentInfo(link.url);
        if (magnetInfo) {
          await this.database.saveTorrent(link.url, magnetInfo);
        }
      } else {
        logger.debug("Using cached torrent info", { name: link.name });
      }

      if (!magnetInfo) {
        logger.debug("Failed to parse torrent info", { name: link.name });
        return [];
      }

      return this._createStreamsFromTorrent(magnetInfo, movieData, id);
    } catch (error) {
      logger.error("Error processing magnet link", {
        name: link.name,
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Fetch torrent information
   * @private
   * @param {string} magnetUri - Magnet URI
   * @returns {Promise<object | null>} Torrent info
   */
  async _fetchTorrentInfo(magnetUri) {
    try {
      const torrentInfo =
        await this.torrentParserService.getTorrentInfo(magnetUri);

      if (!torrentInfo) {
        logger.warn("Failed to get torrent info from parser service");
        return null;
      }

      return {
        displayName: torrentInfo.name,
        fileSize: torrentInfo.totalSizeFormatted,
        totalSize: torrentInfo.totalSize,
        quality: torrentInfo.quality,
        source: torrentInfo.source,
        codec: torrentInfo.codec,
        group: torrentInfo.group,
        language: torrentInfo.language,
        hash: torrentInfo.infoHash,
        trackers: torrentInfo.trackers,
        trackerCount: torrentInfo.trackers.length,
        fileCount: torrentInfo.fileCount,
        files: torrentInfo.files,
        mainVideoFile: torrentInfo.mainVideoFile,
      };
    } catch (error) {
      logger.error("Error fetching torrent info", { error: error.message });
      return null;
    }
  }

  /**
   * Create streams from torrent info
   * @private
   * @param {object} magnetInfo - Magnet info
   * @param {object} movieData - Movie data
   * @param {string} id - Movie ID
   * @returns {Array} Array of streams
   */
  _createStreamsFromTorrent(magnetInfo, movieData, id) {
    const bingeGroupId = this._getBingeGroupId(movieData, id);

    if (magnetInfo.files && magnetInfo.files.length > 0) {
      return this._createMultiFileStreams(magnetInfo, bingeGroupId);
    }

    return this._createSingleFileStream(magnetInfo, bingeGroupId);
  }

  /**
   * Create streams for multi-file torrents
   * @private
   * @param {object} magnetInfo - Magnet info
   * @param {string} bingeGroupId - Binge group ID
   * @returns {Array} Array of streams
   */
  _createMultiFileStreams(magnetInfo, bingeGroupId) {
    const videoFiles = magnetInfo.files.filter((file) => {
      const ext = file.name.toLowerCase().split(".").pop();
      return this.SUPPORTED_VIDEO_EXTENSIONS.has(ext);
    });

    if (videoFiles.length === 0) {
      return this._createSingleFileStream(magnetInfo, bingeGroupId);
    }

    return videoFiles.map((file) => {
      const streamInfo = this._generateStreamInfo(magnetInfo);
      const sources = this._prepareSources(magnetInfo.trackers);

      return {
        name:
          `🎬 ${streamInfo.quality}${streamInfo.source}${streamInfo.codec} ` +
          `${magnetInfo.language} | ${file.sizeFormatted}${streamInfo.group}`,
        title:
          `${streamInfo.quality}${streamInfo.source}${streamInfo.codec} • ` +
          `${magnetInfo.language} • ${file.sizeFormatted}`,
        description: `${file.name} (${file.sizeFormatted})`,
        infoHash: magnetInfo.hash,
        fileIdx: file.index,
        sources: sources.length > 0 ? sources : undefined,
        // Stremio reads filename/videoSize from behaviorHints (subtitle matching)
        behaviorHints: {
          bingeGroup: `cinecalidad-${bingeGroupId}`,
          videoSize: file.size || undefined,
          filename: file.name || undefined,
        },
      };
    });
  }

  /**
   * Create single file stream
   * @private
   * @param {object} magnetInfo - Magnet info
   * @param {string} bingeGroupId - Binge group ID
   * @returns {Array} Array with single stream
   */
  _createSingleFileStream(magnetInfo, bingeGroupId) {
    const streamInfo = this._generateStreamInfo(magnetInfo);
    const sources = this._prepareSources(magnetInfo.trackers);

    const streamDescription = magnetInfo.mainVideoFile
      ? `${magnetInfo.mainVideoFile.name} (${magnetInfo.mainVideoFile.sizeFormatted})`
      : `${magnetInfo.displayName.substring(0, 50)}${magnetInfo.displayName.length > 50 ? "..." : ""}`;

    return [
      {
        name:
          `🎬 ${streamInfo.quality}${streamInfo.source}${streamInfo.codec} ` +
          `${magnetInfo.language} | ${magnetInfo.fileSize}${streamInfo.group}`,
        title:
          `${streamInfo.quality}${streamInfo.source}${streamInfo.codec} • ` +
          `${magnetInfo.language} • ${magnetInfo.fileSize}`,
        description: streamDescription,
        infoHash: magnetInfo.hash,
        fileIdx: magnetInfo.mainVideoFile ? magnetInfo.mainVideoFile.index : 0,
        sources: sources.length > 0 ? sources : undefined,
        behaviorHints: {
          bingeGroup: `cinecalidad-${bingeGroupId}`,
          // Magnets carry no size; 0 would mislead subtitle addons
          videoSize:
            (magnetInfo.mainVideoFile
              ? magnetInfo.mainVideoFile.size
              : magnetInfo.totalSize) || undefined,
          filename: magnetInfo.mainVideoFile
            ? magnetInfo.mainVideoFile.name
            : magnetInfo.displayName,
        },
      },
    ];
  }

  /**
   * Generate stream info from magnet info
   * @private
   * @param {object} magnetInfo - Magnet info
   * @returns {object} Stream info
   */
  _generateStreamInfo(magnetInfo) {
    return {
      quality: magnetInfo.quality || "Unknown",
      source: magnetInfo.source ? ` ${magnetInfo.source}` : "",
      codec: magnetInfo.codec ? ` ${magnetInfo.codec}` : "",
      group: magnetInfo.group ? ` - ${magnetInfo.group}` : "",
    };
  }

  /**
   * Prepare sources from trackers
   * @private
   * @param {Array} trackers - Tracker array
   * @returns {Array} Prepared sources
   */
  _prepareSources(trackers) {
    if (!Array.isArray(trackers)) {
      return [];
    }

    return trackers
      .filter((tracker) => tracker && tracker.trim())
      .map((tracker) => `tracker:${tracker.trim()}`);
  }

  /**
   * Get binge group ID
   * @private
   * @param {object} movieData - Movie data
   * @param {string} id - Movie ID
   * @returns {string} Binge group ID
   */
  _getBingeGroupId(movieData, id) {
    return (
      movieData.movieDetails?.externalMeta?.imdb ||
      movieData.movieDetails?.imdbId ||
      id
    );
  }
}

module.exports = { TorrentInfoService };
