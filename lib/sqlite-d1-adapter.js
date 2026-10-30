/**
 * @file Minimal Cloudflare D1-compatible wrapper around Node's
 * built-in `node:sqlite`, so the same DatabaseService runs under Node
 * (local dev, Docker, tests) and on Cloudflare Workers (D1 binding).
 * Node-only: never import this from the Worker entry.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

class PreparedStatement {
  constructor(stmt, params = []) {
    this._stmt = stmt;
    this._params = params;
  }

  bind(...params) {
    return new PreparedStatement(this._stmt, params);
  }

  async first(column) {
    const row = this._stmt.get(...this._params);
    if (!row) return null;
    return column ? row[column] : { ...row };
  }

  async all() {
    const rows = this._stmt.all(...this._params).map((row) => ({ ...row }));
    return { results: rows, success: true, meta: {} };
  }

  async run() {
    const info = this._stmt.run(...this._params);
    return {
      success: true,
      meta: {
        changes: Number(info.changes),
        // eslint-disable-next-line camelcase -- D1 result field name
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }
}

class SqliteD1Adapter {
  /**
   * @param {string} file - SQLite file path, or ":memory:"
   */
  constructor(file) {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this._db = new DatabaseSync(file);
    if (file !== ":memory:") {
      this._db.exec("PRAGMA journal_mode = WAL");
    }
    this._applyMigrations();
  }

  _applyMigrations() {
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      this._db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  prepare(sql) {
    return new PreparedStatement(this._db.prepare(sql));
  }

  async exec(sql) {
    this._db.exec(sql);
  }

  close() {
    this._db.close();
  }
}

module.exports = { SqliteD1Adapter };
