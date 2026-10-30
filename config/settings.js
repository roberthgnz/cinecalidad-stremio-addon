/**
 * Application configuration settings
 */
const config = {
  // Server configuration
  server: {
    port: Number(process.env.PORT) || 7000,
    host: process.env.HOST || "0.0.0.0", // Allow external connections in production
  },

  // Cinecalidad configuration
  cinecalidad: {
    siteLink: "https://www.cinecalidad.rs",
    maxLatestPageLimit: 3,
    maxSearchPageLimit: 6,
    requestDelay: 1000,
    detailsDelay: 1500,
    cacheTimeout: 30 * 60 * 1000, // 30 minutes
    retryAttempts: 3,
    retryDelay: 2000,
  },

  // Addon manifest configuration
  addon: {
    id: "org.cinecalidad.addon",
    version: "1.0.0",
    name: "Películas de Cinecalidad",
    description:
      "Cinecalidad es un sitio público para Películas Full UHD/HD en Latino Dual.",
    resources: ["stream", "meta", "catalog"],
    types: ["movie"],
    idPrefixes: ["cc_", "tt"],
  },

  // OMDB API configuration
  omdb: {
    apiKey: process.env.OMDB_API_KEY,
    baseUrl: "http://www.omdbapi.com/",
    timeout: 5000,
  },

  // Logging configuration
  logging: {
    enableFileLogging: false,
    logLevel: "info",
  },
};

/**
 * Get the complete addon manifest
 * @returns {object} Stremio addon manifest
 */
function getManifest() {
  return {
    id: config.addon.id,
    version: config.addon.version,
    name: config.addon.name,
    description: config.addon.description,
    logo: "https://raw.githubusercontent.com/rxb3rth/cinecalidad-stremio-addon/refs/heads/main/logo.png",
    resources: config.addon.resources,
    types: config.addon.types,
    catalogs: [
      {
        type: "movie",
        id: "cinecalidad-latest",
        name: "Últimas Películas de Cinecalidad",
        extra: [
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false },
        ],
      },
      {
        type: "movie",
        id: "cinecalidad-search",
        name: "Búsqueda en Cinecalidad",
        extra: [
          { name: "search", isRequired: true },
          { name: "skip", isRequired: false },
        ],
      },
    ],
    idPrefixes: config.addon.idPrefixes,
    stremioAddonsConfig: {
      issuer: "https://stremio-addons.net",
      signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..UztY6fApYLyzz93FY9Nr9g.9ZXUsQSp97BcZ18FBKEgEClqrJpu0KSQlC38F-D2H1mucEx0k2-KlPV9ZwKcUYqMpubIRiQW955m7UbC8XiWDuGu5c9QIXQm_lWz-zVBQFE_IJZnYO9vhCzf2u3bLokJ.hE3Ox95UvWT0svWfsoWXDA"
    }
  };
}

/**
 * Get addon server URL
 * @returns {string} Addon server URL
 */
function getAddonUrl() {
  return `http://${config.server.host}:${config.server.port}`;
}

module.exports = {
  config,
  getManifest,
  getAddonUrl,
};
