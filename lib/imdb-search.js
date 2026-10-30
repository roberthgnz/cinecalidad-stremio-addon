/**
 * @file Fetch-based IMDb title lookup.
 * Port of the `imdbFind` provider from name-to-imdb (MIT, Ivo Georgiev),
 * which depended on Node's http stack via `needle`. Uses the global
 * fetch so it runs on Node and Cloudflare Workers alike.
 */

"use strict";

const logger = require("./logger");

const SUGGEST_URL = "https://v2.sg.media-imdb.com/suggestion";
const SIMILARITY_GOAL = 0.6;

/**
 *
 * @param str
 */
function removeDiacritics(str) {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 *
 * @param term
 */
function parseSearchTerm(term) {
  if (!term || typeof term !== "string") return null;
  // Keep Basic Latin through combining marks only (as name-to-imdb does)
  // eslint-disable-next-line no-control-regex
  return removeDiacritics(term.replace(/[^\u0000-ͯ][ \t]*/gm, ""));
}

/**
 *
 * @param parsedYear
 * @param altYear
 */
function yearSimilar(parsedYear, altYear) {
  if (!parsedYear || !altYear) return true;
  const a = parseInt(parsedYear, 10);
  const b = parseInt(altYear, 10);
  return b >= a - 1 && b <= a + 1;
}

/**
 *
 * @param name
 */
function sanitizeName(name) {
  return name
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .toLowerCase()
    .replace("the ", "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 *
 * @param s1
 * @param s2
 */
function levenshteinSimilarity(s1, s2) {
  const longer = s1.length >= s2.length ? s1 : s2;
  const shorter = s1.length >= s2.length ? s2 : s1;
  if (longer.length === 0) return 1.0;

  const costs = [];
  for (let i = 0; i <= longer.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= shorter.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (longer.charAt(i - 1) !== shorter.charAt(j - 1)) {
          newValue = Math.min(newValue, lastValue, costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[shorter.length] = lastValue;
  }

  return (longer.length - costs[shorter.length]) / longer.length;
}

/**
 *
 * @param a
 * @param b
 */
function nameSimilar(a, b) {
  if (!a || !b) return 0;
  a = sanitizeName(a);
  b = sanitizeName(b);
  return a === b ? 1 : levenshteinSimilarity(a.toLowerCase(), b.toLowerCase());
}

/**
 *
 * @param a
 * @param b
 */
function nameAlmostSimilar(a, b) {
  if (!a || !b) return false;
  a = sanitizeName(a);
  b = sanitizeName(b);
  return a.startsWith(b) || a.endsWith(b) || b.startsWith(a) || b.endsWith(a);
}

/**
 *
 * @param searchTerm
 */
async function getSuggestions(searchTerm) {
  const first = searchTerm.charAt(0).toLowerCase();
  const url = `${SUGGEST_URL}/${encodeURIComponent(first)}/${encodeURIComponent(searchTerm)}.json`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const body = await response.json();
    return Array.isArray(body.d) && body.d.length ? body.d : null;
  } catch (error) {
    logger.warn(`[imdbSearch] Suggestion request failed: ${error.message}`);
    return null;
  }
}

/**
 *
 * @param task
 * @param results
 */
function pickBest(task, results) {
  let pick = null;
  let secondBest = null;
  let firstResult = null;

  for (const result of results) {
    if (!result?.id || !/tt\d{7,8}/.test(result.id)) continue;

    const res = {
      id: result.id,
      name: result.l,
      year: result.y,
      type: result.q,
      yearRange: result.yr,
      image: result.i?.imageUrl
        ? {
            src: result.i.imageUrl,
            width: result.i.width,
            height: result.i.height,
          }
        : undefined,
      starring: result.s,
    };

    const movieMatch =
      task.type === "movie" && ["feature", "TV special"].includes(res.type);
    const seriesMatch =
      task.type === "series" &&
      ["TV series", "TV mini-series"].includes(res.type);

    if (task.type && !movieMatch && !seriesMatch) continue;
    if (!yearSimilar(task.year, res.year)) continue;

    const similarity = nameSimilar(task.name, res.name);
    if (
      similarity > SIMILARITY_GOAL &&
      (!pick || similarity > pick.similarity)
    ) {
      pick = { ...res, similarity };
    }
    if (!secondBest && nameAlmostSimilar(task.name, res.name)) {
      secondBest = res;
    }
    if (!firstResult) {
      firstResult = res;
    }
  }

  if (secondBest && pick && !nameAlmostSimilar(task.name, pick.name)) {
    pick = secondBest;
  }

  return pick || secondBest || firstResult || null;
}

/**
 * Find the best IMDb match for a title
 * @param {object} args - Search arguments
 * @param {string} args.name - Title to search
 * @param {number} [args.year] - Release year
 * @param {string} [args.type] - "movie" or "series"
 * @returns {Promise<object|null>} Match ({ id, name, year, type, image, starring }) or null
 */
async function findImdb({ name, year, type }) {
  const task = { name: parseSearchTerm(name), year, type };
  if (!task.name) return null;

  // Search "name year" first, then loosen to name only
  const terms = task.year
    ? [`${task.name} ${task.year}`, task.name]
    : [task.name];

  for (const term of terms) {
    const results = await getSuggestions(term);
    const match = results && pickBest(task, results);
    if (match) return match;
  }

  return null;
}

module.exports = { findImdb };
