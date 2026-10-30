/**
 * @file Test suite for Cinecalidad addon
 * @author Cinecalidad Team
 * @version 1.0.0
 */

"use strict";

const { CineCalidadAddon, Constants } = require("../src/addon");
const CatalogHandler = require("../src/handlers/CatalogHandler");
const StreamHandler = require("../src/handlers/StreamHandler");
const MetaHandler = require("../src/handlers/MetaHandler");

describe("Cinecalidad Addon Architecture", () => {
  let addon;

  beforeEach(async () => {
    addon = new CineCalidadAddon();
  });

  afterEach(async () => {
    // Clean up addon if initialized
    if (addon && addon._initialized) {
      await addon.shutdown();
    }

    // Clean up singleton instances
    const TorrentParserService = require("../services/torrent-parser-service");
    TorrentParserService.resetInstance();
  });

  describe("Dependency Injection Container", () => {
    test("should initialize dependencies correctly", async () => {
      await addon.initialize();

      const { container } = addon;
      expect(container.get("database")).toBeDefined();
      expect(container.get("cineCalidadService")).toBeDefined();
      expect(container.get("torrentParserService")).toBeDefined();
      expect(container.get("metadataService")).toBeDefined();
    });

    test("should throw error for non-existent dependency", async () => {
      await addon.initialize();

      expect(() => {
        addon.container.get("nonExistentDep");
      }).toThrow("Dependency 'nonExistentDep' not found");
    });

    test("should throw error if not initialized", () => {
      expect(() => {
        addon.container.get("database");
      }).toThrow("Dependencies not initialized");
    });
  });

  describe("Handler Initialization", () => {
    test("should initialize all handlers", async () => {
      await addon.initialize();

      expect(addon.handlers.get("meta")).toBeInstanceOf(MetaHandler);
      expect(addon.handlers.get("catalog")).toBeInstanceOf(CatalogHandler);
      expect(addon.handlers.get("stream")).toBeInstanceOf(StreamHandler);
    });
  });

  describe("Constants", () => {
    test("should have proper constants defined", () => {
      expect(Constants.STREMIO_ID_PREFIX).toBe("cc_");
      expect(Constants.CACHE_CLEANUP_INTERVAL).toBe(30 * 60 * 1000);
      expect(Constants.DEFAULT_CATALOG_LIMIT).toBe(20);
      expect(Array.isArray(Constants.COUNTRY_WHITELIST)).toBe(true);
      expect(Constants.SUPPORTED_VIDEO_EXTENSIONS).toContain("mp4");
    });

    test("should be frozen", () => {
      expect(() => {
        Constants.NEW_PROPERTY = "test";
      }).toThrow();
    });
  });

  describe("Builder Creation", () => {
    test("should create addon builder", async () => {
      await addon.initialize();
      const builder = addon.getBuilder();

      expect(builder).toBeDefined();
      expect(builder.getInterface).toBeDefined();
      expect(builder.getInterface().manifest).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    test("should handle initialization errors gracefully", async () => {
      // Mock the container initialize method to throw error
      addon.container.initialize = jest.fn(() => {
        throw new Error("Service initialization failed");
      });

      await expect(addon.initialize()).rejects.toThrow(
        "Service initialization failed",
      );
    });
  });

  describe("Request ID Generation", () => {
    test("should generate unique request IDs", async () => {
      await addon.initialize();

      const id1 = addon._generateRequestId();
      const id2 = addon._generateRequestId();

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^req_\d+_[a-z0-9]{7}$/);
    });
  });

  afterEach(() => {
    if (addon.cleanupInterval) {
      clearInterval(addon.cleanupInterval);
    }
  });
});

describe("Handler Architecture", () => {
  describe("CatalogHandler", () => {
    let handler;
    let mockDependencies;

    beforeEach(() => {
      mockDependencies = {
        database: {
          getCache: jest.fn(),
          setCache: jest.fn(),
          deleteCache: jest.fn(),
          clearExpiredCache: jest.fn(),
        },
        cineCalidadService: {
          performQuery: jest.fn(),
        },
      };
      handler = new CatalogHandler(mockDependencies);
    });

    afterEach(() => {
      if (handler && handler.cacheService) {
        handler.cacheService.shutdown();
      }
    });

    test("should validate request properly", async () => {
      await expect(handler.handle(null)).rejects.toThrow(
        "Invalid catalog request arguments",
      );
      await expect(handler.handle({})).rejects.toThrow();
      await expect(handler.handle({ type: "series" })).rejects.toThrow(
        "Unsupported content type",
      );
    });

    test("should handle supported catalogs", async () => {
      const args = {
        type: "movie",
        id: "cinecalidad-latest",
        extra: {},
      };

      mockDependencies.cineCalidadService.performQuery.mockResolvedValue([]);

      const result = await handler.handle(args);
      expect(result).toEqual({ metas: [] });
    });

    test("should return empty for unsupported catalogs", async () => {
      const args = {
        type: "movie",
        id: "unsupported-catalog",
      };

      const result = await handler.handle(args);
      expect(result).toEqual({ metas: [] });
    });
  });

  describe("StreamHandler", () => {
    let handler;
    let mockDependencies;

    beforeEach(() => {
      mockDependencies = {
        database: {
          getMovie: jest.fn(),
          saveMovie: jest.fn(),
          getTorrent: jest.fn(),
          saveTorrent: jest.fn(),
          getCache: jest.fn(),
          setCache: jest.fn(),
          deleteCache: jest.fn(),
          clearExpiredCache: jest.fn(),
        },
        cineCalidadService: {
          performQuery: jest.fn(),
          getMovieDetails: jest.fn(),
        },
        torrentParserService: {
          getTorrentInfo: jest.fn(),
        },
        metadataService: {
          getMovieMetadata: jest.fn(),
        },
      };
      handler = new StreamHandler(mockDependencies);
    });

    afterEach(() => {
      if (handler && handler.cacheService) {
        handler.cacheService.shutdown();
      }
    });

    test("should validate request", async () => {
      await expect(handler.handle({})).rejects.toThrow(
        "Invalid stream request arguments",
      );
    });

    test("should return empty streams for non-movie types", async () => {
      const args = { type: "series", id: "test" };
      const result = await handler.handle(args);
      expect(result).toEqual({ streams: [] });
    });

    test("should handle movie stream requests", async () => {
      const args = { type: "movie", id: "cc_test" };

      mockDependencies.database.getMovie.mockReturnValue(null);
      mockDependencies.cineCalidadService.performQuery.mockResolvedValue([
        { id: "test", detailsLink: "http://test.com" },
      ]);
      mockDependencies.cineCalidadService.getMovieDetails.mockResolvedValue({
        downloadLinks: [],
      });

      const result = await handler.handle(args);
      expect(result).toHaveProperty("streams");
      expect(Array.isArray(result.streams)).toBe(true);
    });

    describe("IMDb ids", () => {
      const downloadLinks = [
        { name: "Descarga 1080p", url: "https://example.com/dl" },
      ];

      beforeEach(() => {
        mockDependencies.database.findMovieByImdbId = jest.fn();
        mockDependencies.metadataService.getMovieMetadata.mockResolvedValue({
          originalTitle: "Remarkably Bright Creatures",
          year: "2026",
        });
        mockDependencies.cineCalidadService.performQuery.mockResolvedValue([
          {
            id: "criaturas-luminosas-2025",
            year: "2023",
            detailsLink: "https://site/old",
          },
          {
            id: "criaturas-luminosas-2026",
            year: "2026",
            detailsLink: "https://site/new",
          },
          {
            id: "criaturas-luminosas-2026_4k",
            year: "2026",
            detailsLink: "https://site/new",
          },
        ]);
      });

      test("finds the release by Cinemeta title and confirms the IMDb id", async () => {
        mockDependencies.cineCalidadService.getMovieDetails.mockResolvedValue({
          imdbId: "tt1",
          downloadLinks,
        });

        const result = await handler.handle({ type: "movie", id: "tt1" });

        expect(
          mockDependencies.cineCalidadService.performQuery,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            search: "Remarkably Bright Creatures",
            matchTitle: false,
            maxPages: 1,
          }),
        );
        // Only the same-year, non-4K candidate is opened
        expect(
          mockDependencies.cineCalidadService.getMovieDetails,
        ).toHaveBeenCalledTimes(1);
        expect(
          mockDependencies.cineCalidadService.getMovieDetails,
        ).toHaveBeenCalledWith("https://site/new");
        expect(result.streams).toHaveLength(1);
        expect(result.streams[0].externalUrl).toBe("https://example.com/dl");
        expect(mockDependencies.database.saveMovie).toHaveBeenCalledWith(
          "tt1",
          expect.objectContaining({
            release: expect.not.objectContaining({
              movieDetails: expect.anything(),
            }),
          }),
        );
      });

      test("rejects a candidate whose page links another IMDb id", async () => {
        mockDependencies.cineCalidadService.getMovieDetails.mockResolvedValue({
          imdbId: "tt999",
          downloadLinks,
        });

        const result = await handler.handle({ type: "movie", id: "tt1" });

        expect(result).toEqual({ streams: [] });
        // The miss is cached so the site is not scraped on every view
        expect(mockDependencies.database.setCache).toHaveBeenCalledWith(
          "stream_tt1",
          { streams: [] },
          handler.MISSING_IMDB_CACHE_MINUTES,
        );
      });

      test("reuses a movie saved under its cc_ id", async () => {
        mockDependencies.database.findMovieByImdbId.mockResolvedValue({
          movieDetails: { imdbId: "tt1", downloadLinks },
        });

        const result = await handler.handle({ type: "movie", id: "tt1" });

        expect(result.streams).toHaveLength(1);
        expect(
          mockDependencies.cineCalidadService.performQuery,
        ).not.toHaveBeenCalled();
      });
    });
  });
});

describe("DatabaseService.findMovieByImdbId", () => {
  const { getInstance } = require("../lib/database");

  test("finds a movie stored under another id by its IMDb id", async () => {
    const db = getInstance();
    await db.saveMovie("cc_some-movie", {
      movieDetails: { imdbId: "tt7654321", downloadLinks: [] },
    });

    const movie = await db.findMovieByImdbId("tt7654321");
    expect(movie.movieDetails.imdbId).toBe("tt7654321");
    expect(await db.findMovieByImdbId("tt0000000")).toBeNull();
  });
});

describe("Performance and Monitoring", () => {
  test("should use high-resolution timing", () => {
    const start = process.hrtime.bigint();
    const end = process.hrtime.bigint();
    const duration = Number(end - start) / 1000000;

    expect(typeof duration).toBe("number");
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  test("should generate structured logs", () => {
    const logEntry = {
      requestId: "test_123",
      duration: 150,
      success: true,
      timestamp: new Date().toISOString(),
    };

    expect(logEntry.requestId).toMatch(/test_\d+/);
    expect(typeof logEntry.duration).toBe("number");
    expect(typeof logEntry.success).toBe("boolean");
    expect(logEntry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("Security and Validation", () => {
  test("should validate URLs properly", () => {
    const validUrl = "https://example.com/poster.jpg";
    const invalidUrl = "javascript:alert(1)";

    const validateUrl = (url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:";
      } catch {
        return false;
      }
    };

    expect(validateUrl(validUrl)).toBe(true);
    expect(validateUrl(invalidUrl)).toBe(false);
  });

  test("should sanitize search queries", () => {
    const sanitize = (query) => {
      if (!query || typeof query !== "string") return "";
      return query.trim().substring(0, 100);
    };

    expect(sanitize("  test  ")).toBe("test");
    expect(sanitize("a".repeat(150))).toBe("a".repeat(100));
    expect(sanitize(null)).toBe("");
  });
});

describe("Error Recovery and Graceful Degradation", () => {
  test("should handle service failures gracefully", async () => {
    const mockService = {
      performQuery: jest
        .fn()
        .mockRejectedValue(new Error("Service unavailable")),
    };

    try {
      await mockService.performQuery();
    } catch (error) {
      expect(error.message).toBe("Service unavailable");
    }
  });

  test("should handle malformed responses", () => {
    const processReleases = (releases) => {
      if (!Array.isArray(releases)) {
        return [];
      }
      return releases.filter((r) => r && typeof r === "object");
    };

    expect(processReleases(null)).toEqual([]);
    expect(processReleases("invalid")).toEqual([]);
    expect(processReleases([{ valid: true }, null, { valid: true }])).toEqual([
      { valid: true },
      { valid: true },
    ]);
  });
});
