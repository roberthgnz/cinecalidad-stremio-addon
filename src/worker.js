/**
 * @file Cloudflare Workers entry point.
 * Serves the Stremio addon protocol over fetch and runs DB cleanup on a cron.
 */

import { createAddon } from "./addon.js";
import { configure as configureDatabase } from "../lib/database.js";
import logger from "../lib/logger.js";
import pkg from "../package.json";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Origin, X-Requested-With, Content-Type, Accept",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const RESOURCE_ROUTE =
  /^\/(catalog|meta|stream)\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/;

const CACHE_HEADERS = {
  cacheMaxAge: "max-age",
  staleRevalidate: "stale-while-revalidate",
  staleError: "stale-if-error",
};

// One addon instance per isolate, created on first request
let addonInterfacePromise = null;

/**
 * Get (or lazily build) the addon interface
 * @param {object} env - Worker bindings
 * @returns {Promise<object>} Stremio addon interface ({ manifest, get })
 */
function getAddonInterface(env) {
  configureDatabase(env.DB);

  if (!addonInterfacePromise) {
    addonInterfacePromise = createAddon()
      .then((builder) => builder.getInterface())
      .catch((error) => {
        addonInterfacePromise = null;
        throw error;
      });
  }

  return addonInterfacePromise;
}

/**
 * Build a JSON response with CORS headers
 * @param {*} body - Response body
 * @param {number} status - HTTP status
 * @param {object} headers - Extra headers
 * @returns {Response} Response
 */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

/**
 * Translate the addon response cache hints into a Cache-Control header
 * @param {object} resp - Addon handler response
 * @returns {object} Headers
 */
function cacheHeaders(resp) {
  const directives = Object.entries(CACHE_HEADERS)
    .filter(([prop]) => Number.isInteger(resp[prop]))
    .map(([prop, directive]) => `${directive}=${resp[prop]}`);

  return directives.length
    ? { "Cache-Control": `${directives.join(", ")}, public` }
    : {};
}

/**
 * Handle a resource request (catalog/meta/stream)
 * @param {object} addon - Addon interface
 * @param {string[]} match - Route regex match
 * @returns {Promise<Response>} Response
 */
async function handleResource(addon, match) {
  const [, resource, type, rawId, rawExtra] = match;
  const id = decodeURIComponent(rawId);
  const extra = rawExtra
    ? Object.fromEntries(new URLSearchParams(rawExtra))
    : {};

  try {
    const resp = await addon.get(resource, type, id, extra, {});

    if (resp.redirect) {
      return new Response(null, {
        status: 307,
        headers: { Location: resp.redirect, ...CORS_HEADERS },
      });
    }

    return json(resp, 200, cacheHeaders(resp));
  } catch (error) {
    if (error && error.noHandler) {
      return json({ err: "not found" }, 404);
    }

    logger.error("Resource handler error", {
      resource,
      type,
      id,
      error: error?.message || error,
    });
    return json({ err: "handler error" }, 500);
  }
}

export default {
  /**
   * @param {Request} request - Incoming request
   * @param {object} env - Worker bindings
   * @returns {Promise<Response>} Response
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    if (url.pathname === "/health") {
      return json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        version: pkg.version,
      });
    }

    if (url.pathname === "/") {
      return Response.redirect(`${url.origin}/manifest.json`, 302);
    }

    try {
      const addon = await getAddonInterface(env);

      if (url.pathname === "/manifest.json") {
        return json(addon.manifest);
      }

      const match = url.pathname.match(RESOURCE_ROUTE);
      if (match) {
        return await handleResource(addon, match);
      }

      return json(
        { error: "Not Found", message: `Route ${url.pathname} not found` },
        404,
      );
    } catch (error) {
      logger.error("Worker error", {
        error: error.message,
        stack: error.stack,
      });
      return json(
        {
          error: "Internal Server Error",
          message:
            env.NODE_ENV === "development"
              ? error.message
              : "Something went wrong",
        },
        500,
      );
    }
  },

  /**
   * Cron trigger: purge expired cache rows and stale movies
   * @param {object} controller - Scheduled controller
   * @param {object} env - Worker bindings
   * @param {object} ctx - Execution context
   */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(configureDatabase(env.DB).cleanup());
  },
};
