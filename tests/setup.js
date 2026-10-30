/**
 * Jest setup: bind the database layer to an in-memory SQLite (D1-compatible)
 */

"use strict";

const { configure } = require("../lib/database");
const { SqliteD1Adapter } = require("../lib/sqlite-d1-adapter");

configure(new SqliteD1Adapter(":memory:"));
