const cheerio = require("cheerio");
const { findImdb } = require("../lib/imdb-search");
const logger = require("../lib/logger");

/**
 * Cinecalidad Service - Inspired by Jackett's CCServerService.cs
 * Provides structured scraping and content management for Cinecalidad
 */
class CineCalidadService {
  constructor(options = {}) {
    this.siteLink = options.siteLink || "https://www.cinecalidad.rs";
    this.maxLatestPageLimit = options.maxLatestPageLimit || 3;
    this.maxSearchPageLimit = options.maxSearchPageLimit || 6;
    this.requestDelay = options.requestDelay || 1000;
    this.detailsDelay = options.detailsDelay || 1500;

    // Legacy site links for fallback
    this.legacySiteLinks = [
      "https://www.cinecalidad.vg/",
      "https://www.cinecalidad.so/",
      "https://cinecalidad.fi/",
    ];

    // Cache for content
    this.cache = new Map();
    this.cacheTimeout = 30 * 60 * 1000; // 30 minutes
  }

  /**
   * Perform query with pagination and search support
   * @param {Object} query - Query parameters
   * @param {string} query.search - Search term
   * @param {number} query.skip - Number of items to skip
   * @param {number} query.limit - Maximum items to return
   * @param {number} [query.maxPages] - Override the page limit
   * @param {boolean} [query.matchTitle] - false keeps results whose card title
   *   does not contain the search words (the site also matches original titles)
   * @returns {Promise<Array>} Array of movie releases
   */
  async performQuery(query = {}) {
    logger.debug(`[performQuery] Starting query:`, query);

    const releases = [];
    const isSearch = query.search && query.search.trim().length > 0;
    const maxPages =
      query.maxPages ||
      (isSearch ? this.maxSearchPageLimit : this.maxLatestPageLimit);

    logger.debug(
      `[performQuery] Search mode: ${isSearch}, Max pages: ${maxPages}`,
    );

    // Build template URL
    let templateUrl = this.siteLink;
    if (isSearch) {
      templateUrl += "/{0}?s=" + encodeURIComponent(query.search.trim());
    } else {
      templateUrl += "/{0}";
    }

    logger.debug(`[performQuery] Template URL: ${templateUrl}`);

    let lastPublishDate = new Date();

    for (let page = 1; page <= maxPages; page++) {
      try {
        const pageParam = page > 1 ? `page/${page}` : "";
        const searchUrl = templateUrl.replace("{0}", pageParam);

        logger.debug(`[performQuery] Fetching page ${page}: ${searchUrl}`);

        const html = await this.requestWithRetry(searchUrl);
        logger.debug(
          `[performQuery] Page ${page} HTML length: ${html.length} characters`,
        );

        const pageReleases = this.parseReleases(html, query);
        logger.debug(
          `[performQuery] Page ${page} returned ${pageReleases.length} releases`,
        );

        // Add relative publish dates for sorting
        pageReleases.forEach((release) => {
          release.publishDate = lastPublishDate;
          lastPublishDate = new Date(lastPublishDate.getTime() - 60000); // 1 minute earlier
        });

        releases.push(...pageReleases);
        logger.debug(
          `[performQuery] Total releases so far: ${releases.length}`,
        );

        // Check if there are more pages available by looking for pagination indicators
        const $ = cheerio.load(html);
        const hasMorePages =
          $(".load_more_texto").length > 0 || $(".wp-pagenavi").length > 0;

        logger.debug(`[performQuery] Has more pages: ${hasMorePages}`);

        // Break if no pagination indicators found (no more pages)
        if (!hasMorePages) {
          logger.debug(
            `[performQuery] No pagination indicators found on page ${page}, stopping pagination`,
          );
          break;
        }

        // Break if no results found on search
        if (pageReleases.length < 1 && isSearch) {
          logger.debug(
            `[performQuery] No results found on search page ${page}, stopping`,
          );
          break;
        }

        // Reduced delay between requests for better performance
        if (page < maxPages) {
          await this.delay(Math.min(this.requestDelay, 500));
        }
      } catch (error) {
        logger.error(
          `[performQuery] Error fetching page ${page}:`,
          error.message,
        );
        // Continue to next page instead of breaking on single page failure
        if (page === 1) {
          // If first page fails, break
          logger.debug(`[performQuery] First page failed, stopping`);
          break;
        }
        continue;
      }
    }

    logger.debug(
      `[performQuery] Before applying skip/limit - Total releases: ${releases.length}`,
    );

    // Apply skip and limit
    const startIndex = query.skip || 0;
    const endIndex = query.limit ? startIndex + query.limit : releases.length;

    logger.debug(
      `[performQuery] Applying slice from ${startIndex} to ${endIndex}`,
    );
    const finalReleases = releases.slice(startIndex, endIndex);
    logger.debug(
      `[performQuery] Final result: ${finalReleases.length} releases`,
    );

    return finalReleases;
  }

  /**
   * Parse releases from HTML response
   * @param {string} html - HTML content
   * @param {Object} query - Query parameters for filtering
   * @returns {Array} Parsed releases
   */
  parseReleases(html, query = {}) {
    const releases = [];

    try {
      const $ = cheerio.load(html);
      const rows = $(
        "article:has(a.absolute):has(img.rounded), .home_post_cont.post_box",
      );

      console.log(
        `[parseReleases] Found ${rows.length} potential movie elements`,
      );
      console.log(`[parseReleases] HTML length: ${html.length} characters`);
      console.log(`[parseReleases] Query:`, query);

      rows.each((index, element) => {
        const $row = $(element);

        // Skip series content (we only support movies)
        if ($row.find("div.selt").length > 0) {
          return;
        }

        const $link = $row.find("a.absolute, a").first();
        const $img = $row.find("img.rounded, .wp-post-image").first();

        if (!$link.length || !$img.length) {
          return;
        }

        // Try multiple ways to extract the title
        let title = $row.find(".in_title").text().trim();

        // If .in_title is not found, try other selectors including nested ones
        if (!title) {
          title =
            $row.find(".hover_caption_caption .in_title").text() ||
            $row.find(".home_post_content .in_title").text() ||
            $link.attr("title") ||
            $img.attr("title") ||
            $img.attr("alt") ||
            $link.text() ||
            "";
        }

        // Clean up the title
        title = title.trim();

        // Debug logging
        console.log(`Debug - Element ${index}:`);
        console.log(`  Final title: "${title}"`);
        console.log(`  Link href: "${$link.attr("href")}"`);

        // Skip if title doesn't match search query
        if (
          query.search &&
          query.matchTitle !== false &&
          !this.checkTitleMatchWords(query.search, title)
        ) {
          return;
        }

        // Skip if no title found
        if (!title) {
          console.log(`  Skipping - no title found`);
          return;
        }

        const href = $link.attr("href");
        if (!href) {
          console.log("  Skipping - no href found");
          return;
        }

        // Extract year from title if available
        const yearMatch = title.match(/\((\d{4})\)/);
        const yearText = yearMatch ? yearMatch[1] : null;

        // Get poster image
        const posterSrc = $img.attr("data-src") || $img.attr("src");
        const poster = posterSrc ? this.getAbsoluteUrl(posterSrc) : null;

        console.log(
          `  Creating release: title="${title}", year=${yearText}, poster=${poster ? "found" : "not found"}`,
        );

        // Create release info
        const link = this.getAbsoluteUrl(href);
        const movieId = this.extractMovieId(link);

        // Standard HD release - only include real data
        const release = {
          id: movieId,
          title: title, // Use original title without fake formatting
          originalTitle: title,
          year: yearText || null,
          poster: poster,
          link: link,
          detailsLink: link,
          category: "movie",
          quality: "1080p", // This can be inferred from the site
          size: null, // No fake size estimates
          publishDate: null,
          imdbId: null,
        };

        releases.push(release);

        // Check for 4K availability
        if ($row.find('a[aria-label="4K"]').length > 0) {
          const release4k = {
            id: `${movieId}_4k`,
            title: `${title} (4K)`, // Simple 4K indicator without fake formatting
            originalTitle: title,
            year: yearText || null,
            poster: poster,
            link: `${link}?type=4k`,
            detailsLink: link,
            category: "movie",
            quality: "2160p",
            size: null, // No fake size estimates
            publishDate: null,
            imdbId: null,
          };

          releases.push(release4k);
        }
      });
    } catch (error) {
      logger.error("Error parsing releases:", error.message);
    }

    logger.debug(
      `[parseReleases] Parsed ${releases.length} releases successfully`,
    );
    logger.debug(
      `[parseReleases] Sample releases:`,
      releases
        .slice(0, 3)
        .map((r) => ({ title: r.title, year: r.year, link: r.link })),
    );

    return releases;
  }

  /**
   * Get detailed movie information
   * @param {string} movieUrl - URL to movie page
   * @returns {Promise<Object|null>} Movie details or null
   */
  async getMovieDetails(movieUrl) {
    logger.debug(`[getMovieDetails] Processing: ${movieUrl}`);

    try {
      console.log(`[getMovieDetails] Fetching movie details from: ${movieUrl}`);

      const html = await this.requestWithRetry(movieUrl);
      const $ = cheerio.load(html);

      console.log(`[getMovieDetails] HTML length: ${html.length} characters`);

      // Extract basic movie information from the page
      const title = $("#main_container > div.single_left > h1").text().trim();
      console.log(`[getMovieDetails] Extracted title: "${title}"`);

      const year = title.match(/\((\d{4})\)/)?.[1] || null;
      console.log(`[getMovieDetails] Extracted year: ${year}`);

      const poster =
        $(".poster img").attr("src") ||
        $(".movie-poster img").attr("src") ||
        $('meta[property="og:image"]').attr("content");
      console.log(`[getMovieDetails] Poster found: ${!!poster}`);

      // Try to extract IMDB ID from the page first
      const imdbLink = $("#imdb-box > a").attr("href");
      let imdbId = null;
      console.log(`[getMovieDetails] IMDB link found on page: ${imdbLink}`);

      if (imdbLink) {
        const imdbMatch = imdbLink.match(/\/title\/(tt\d+)\//);
        imdbId = imdbMatch ? imdbMatch[1] : null;
        console.log(`[getMovieDetails] Extracted IMDB ID from page: ${imdbId}`);
      }

      // Get complete movie information from IMDB using IMDb search
      let movieInfo = null;
      if (title) {
        console.log(
          `[getMovieDetails] Getting complete movie info from IMDB using IMDb search...`,
        );
        movieInfo = await this.getMovieInfoFromImdb(title, year);
        console.log(
          `[getMovieDetails] Movie info from IMDB:`,
          movieInfo ? "Found" : "Not found",
        );

        // Use the IMDB ID from IMDb search if we didn't find it on the page
        if (movieInfo && !imdbId) {
          imdbId = movieInfo.imdbId;
        }
      }

      // Extract basic description from the page as fallback
      const pageDescription =
        $(".wp-content p").first().text().trim() ||
        $('meta[property="og:description"]').attr("content");
      console.log(
        `[getMovieDetails] Page description length: ${pageDescription ? pageDescription.length : 0}`,
      );

      // Only return data if we have essential information
      if (!title || !imdbId) {
        console.log(
          `[getMovieDetails] Skipping movie - missing essential data: title=${!!title}, imdbId=${!!imdbId}`,
        );
        return null;
      }

      const downloadLinks = await this.extractDownloadLinks($);
      console.log(
        `[getMovieDetails] Found ${downloadLinks.length} download links`,
      );

      // Combine information from IMDB and page
      const result = {
        imdbId,
        title: movieInfo?.title || title,
        year: movieInfo?.year || year,
        poster:
          movieInfo?.poster || (poster ? this.getAbsoluteUrl(poster) : null),
        description: pageDescription || null, // Use page description since IMDb search doesn't provide plot
        genre: null, // IMDb search doesn't provide genre info
        director: null, // IMDb search doesn't provide director info
        cast: movieInfo?.starring || null, // Use starring actors from IMDb search
        duration: null, // IMDb search doesn't provide duration
        rating: null, // IMDb search doesn't provide rating
        country: null, // IMDb search doesn't provide country
        language: null, // IMDb search doesn't provide language
        starring: movieInfo?.starring || null, // Main actors
        type: movieInfo?.type || "movie",
        sourceUrl: movieUrl,
        downloadLinks,
      };

      console.log(
        `[getMovieDetails] Successfully processed movie: ${result.title} (${result.year}) - ${result.imdbId}`,
      );
      console.log(
        `[getMovieDetails] Has genre: ${!!result.genre}, director: ${!!result.director}, cast: ${!!result.cast}`,
      );
      return result;
    } catch (error) {
      logger.error(
        `[getMovieDetails] Error fetching movie details from ${movieUrl}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Extract download links from movie page
   * @param {Object} $ - Cheerio instance
   * @returns {Promise<Array>} Download links
   */
  async extractDownloadLinks($) {
    const links = [];

    try {
      // Look for BitTorrent download link in the specific panel
      const promises = [];
      $('#panel_descarga [service="BitTorrent"]').each((index, element) => {
        const $link = $(element);
        const href = $link.attr("href") || $link.attr("data-url");
        const text = $link.text().trim();

        if (href) {
          // Extract the real URL from the 's' parameter if it's an ouo.io link
          let finalUrl = href;
          if (href.includes("ouo.io") && href.includes("?s=")) {
            const urlParams = new URL(href);
            const sParam = urlParams.searchParams.get("s");
            if (sParam) {
              finalUrl = decodeURIComponent(sParam);
            }
          }

          // Fetch the page to extract the magnet link
          const promise = this.extractMagnetFromPage(finalUrl, text);
          promises.push(promise);
        }
      });

      // Wait for all magnet extractions to complete with timeout
      const extractedLinks = await Promise.allSettled(promises);
      const validLinks = extractedLinks
        .filter(
          (result) => result.status === "fulfilled" && result.value !== null,
        )
        .map((result) => result.value);

      console.log(
        `[extractDownloadLinks] Valid links extracted:`,
        JSON.stringify(validLinks, null, 2),
      );
      links.push(...validLinks);
    } catch (error) {
      logger.error("Error extracting download links:", error.message);
    }

    return links;
  }

  async extractMagnetFromPage(pageUrl, linkName) {
    try {
      console.log(`[extractMagnetFromPage] Processing URL: ${pageUrl}`);
      const html = await this.requestWithRetry(pageUrl);
      const $ = cheerio.load(html);

      // Extract magnet link using the specified selector
      const magnetLink = $("#texto > div > a").attr("href");
      console.log(
        `[extractMagnetFromPage] Found magnet link: ${magnetLink ? magnetLink.substring(0, 100) + "..." : "null"}`,
      );

      if (magnetLink && magnetLink.startsWith("magnet:")) {
        // Validate magnet URI format
        const hashMatch = magnetLink.match(
          /btih:([a-fA-F0-9]{40}|[a-fA-F0-9]{32})/,
        );
        if (!hashMatch) {
          console.error(
            `[extractMagnetFromPage] Invalid magnet URI format: ${magnetLink.substring(0, 100)}...`,
          );
          return null;
        }

        console.log(
          `[extractMagnetFromPage] Valid magnet URI extracted with hash: ${hashMatch[1]}`,
        );
        return {
          name: linkName || "BitTorrent Download",
          url: magnetLink,
          type: "magnet",
        };
      }

      console.log(`[extractMagnetFromPage] No valid magnet link found on page`);
      return null;
    } catch (error) {
      logger.error(
        `[extractMagnetFromPage] Error extracting magnet from ${pageUrl}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Get complete movie information using IMDb search
   * @param {string} title - Movie title
   * @param {string} year - Movie year (optional)
   * @returns {Promise<Object|null>} Complete movie information or null
   */
  async getMovieInfoFromImdb(title, year = null) {
    try {
      console.log(
        `[getMovieInfoFromImdb] Starting search for: "${title}" (${year})`,
      );

      // Clean the title by removing quality indicators and extra info
      let cleanTitle = title
        .replace(/\(\d{4}\)/g, "") // Remove year in parentheses
        .replace(/\b(4K|UHD|HD|BluRay|BRRip|DVDRip|WEBRip|HDTV)\b/gi, "") // Remove quality indicators
        .replace(/\b(Latino|Dual|Subtitulado|Spanish|English)\b/gi, "") // Remove language indicators
        .replace(/[\[\]()]/g, "") // Remove brackets and parentheses
        .replace(/\s+/g, " ") // Replace multiple spaces with single space
        .trim();

      console.log(`[getMovieInfoFromImdb] Cleaned title: "${cleanTitle}"`);
      console.log(`[getMovieInfoFromImdb] Search year: ${year}`);

      const searchOptions = {
        name: cleanTitle,
        year: year ? parseInt(year) : undefined,
      };

      console.log(`[getMovieInfoFromImdb] Search options:`, searchOptions);

      const meta = await findImdb(searchOptions);
      console.log(`[getMovieInfoFromImdb] Raw result from IMDb search:`, meta);

      if (!meta || !meta.id || !meta.id.startsWith("tt")) {
        console.log(
          `[getMovieInfoFromImdb] No valid movie info found for "${cleanTitle}"`,
        );
        return null;
      }

      const movieInfo = {
        imdbId: meta.id,
        title: meta.name || cleanTitle,
        year: meta.year || year,
        poster: meta.image ? meta.image.src : null,
        starring: meta.starring || null, // This contains main actors
        type: meta.type || "movie",
        // Note: IMDb suggestions don't provide detailed metadata like genre, director, etc.
        // We'll need to keep these as null and rely on page extraction or other sources
        genre: null,
        director: null,
        cast: meta.starring || null, // Use starring as cast
        duration: null,
        rating: null,
        description: null,
        country: null,
        language: null,
      };

      console.log(
        `[getMovieInfoFromImdb] Found complete movie info for: ${movieInfo.title} (${movieInfo.year}) - ${movieInfo.imdbId}`,
      );
      console.log(
        `[getMovieInfoFromImdb] Starring: ${movieInfo.starring}, Type: ${movieInfo.type}`,
      );
      return movieInfo;
    } catch (error) {
      logger.error(
        `[getMovieInfoFromImdb] Error in getMovieInfoFromImdb for "${title}":`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Get IMDB ID using IMDb search (legacy method, kept for compatibility)
   * @param {string} title - Movie title
   * @param {string} year - Movie year (optional)
   * @returns {Promise<string|null>} IMDB ID or null
   */
  async getImdbIdFromTitle(title, year = null) {
    try {
      const movieInfo = await this.getMovieInfoFromImdb(title, year);
      return movieInfo ? movieInfo.imdbId : null;
    } catch (error) {
      logger.error(
        `[getImdbIdFromTitle] Error in getImdbIdFromTitle for "${title}":`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Check if title matches search words
   * @param {string} queryStr - Search query
   * @param {string} title - Title to check
   * @returns {boolean} True if matches
   */
  checkTitleMatchWords(queryStr, title) {
    if (!queryStr || !title) return true;

    // Normalize function to remove accents and special characters
    const normalize = (str) =>
      str
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove diacritics/accents
        .replace(/[^\w\s]/g, " ") // Replace non-word chars with spaces
        .replace(/\s+/g, " ") // Normalize spaces
        .trim();

    const queryWords = normalize(queryStr)
      .split(/\s+/)
      .filter((word) => word.length > 2);

    const titleWords = normalize(title)
      .split(/\s+/)
      .filter((word) => word.length > 2);

    const matches = queryWords.every((word) =>
      titleWords.some((titleWord) => titleWord.includes(word)),
    );

    // Debug logging for failed matches
    if (!matches) {
      console.log(`[MATCH FAIL] Query: "${queryStr}" -> Title: "${title}"`);
      console.log(`  Query words: [${queryWords.join(", ")}]`);
      console.log(`  Title words: [${titleWords.join(", ")}]`);
    }

    return matches;
  }

  /**
   * Extract movie ID from URL
   * @param {string} url - Movie URL
   * @returns {string} Movie ID
   */
  extractMovieId(url) {
    const parts = url.split("/");
    return parts[parts.length - 2] || parts[parts.length - 1] || "unknown";
  }

  /**
   * Extract year from title
   * @param {string} title - Movie title
   * @returns {string|null} Year or null
   */
  extractYearFromTitle(title) {
    const yearMatch = title.match(/\((\d{4})\)/);
    return yearMatch ? yearMatch[1] : null;
  }

  /**
   * Get absolute URL
   * @param {string} url - Relative or absolute URL
   * @returns {string} Absolute URL
   */
  getAbsoluteUrl(url) {
    if (!url) return "";

    url = url.trim();

    if (url.startsWith("http")) {
      return url;
    }

    return this.siteLink + (url.startsWith("/") ? url : "/" + url);
  }

  /**
   * Make HTTP request with retry logic
   * @param {string} url - URL to request
   * @param {number} retries - Number of retries
   * @returns {Promise<string>} HTML content
   */
  async requestWithRetry(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.text();
      } catch (error) {
        console.error(
          `Request attempt ${i + 1} failed for ${url}:`,
          error.message,
        );

        if (i === retries) {
          throw error;
        }

        // Shorter wait before retry for better performance
        await this.delay(500 * (i + 1));
      }
    }
  }

  /**
   * Delay execution
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise} Promise that resolves after delay
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      timeout: this.cacheTimeout,
    };
  }
}

module.exports = CineCalidadService;
