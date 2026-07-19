"use strict";

// todo-txt source bundle — protocol v1 (contracts §4).
//
// Task store: a todo.txt-format file at $TODO_FILE (manifest default
// `~/todo.txt`). This module is the whole bundle's logic; the `list`, `get`,
// and `update` scripts are thin dispatchers over it. Node builtins only — a
// bundle is a language-agnostic process that must run from a global install.
//
// Line grammar (documented in full in README.md):
//   [x] [(A)] [YYYY-MM-DD] title words +project @context key:value ...
//   - leading `x ` marks the line completed  -> terminal: true
//   - `(A)`..`(Z)` priority                  -> higher protocol number = first
//   - `id:<slug>`   explicit id (else a stable content hash of the line)
//   - `repos:a,b`   repo designation (comma-separated; repeatable)
//   - `agent:<name>` agent routing
//   - `blocked:<v>` blocked unless v ∈ {false,0,no}
// Blank lines and `#` comments are ignored.

const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})\s+/;
const PRIORITY_PREFIX = /^\(([A-Z])\)\s+/;
const KEY_VALUE = /^([A-Za-z][A-Za-z0-9_-]*):(\S+)$/;
const FALSEY = new Set(["false", "0", "no"]);
// 'Z' = 90. A..Z -> 26..1 so (A) dispatches before (Z) (higher number first).
const Z_CODE = "Z".codePointAt(0);

function today() {
  return new Date().toISOString().slice(0, 10);
}

function expandHome(value) {
  if (value.startsWith("~/") || value === "~") {
    return value.replace(/^~/, os.homedir());
  }
  return value;
}

function resolveTodoFile() {
  const value = process.env["TODO_FILE"];
  if (!value || value.trim() === "") {
    throw new Error(
      "TODO_FILE is not set. Point it at a todo.txt file (manifest default ~/todo.txt).",
    );
  }
  return expandHome(value);
}

function hashLine(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function priorityLetterToNumber(letter) {
  return Z_CODE - letter.codePointAt(0) + 1;
}

// Parse one physical line into a protocol task plus the bookkeeping `update`
// needs to rewrite it. Returns undefined for blanks/comments.
function parseLine(raw, lineIndex) {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return undefined;
  }

  let rest = trimmed;
  let completed = false;
  if (rest.startsWith("x ")) {
    completed = true;
    rest = rest.slice(2).trimStart();
    const done = DATE_PREFIX.exec(rest);
    if (done) {
      rest = rest.slice(done[0].length);
    }
  }

  let priorityLetter;
  const priority = PRIORITY_PREFIX.exec(rest);
  if (priority) {
    priorityLetter = priority[1];
    rest = rest.slice(priority[0].length);
  }

  const creation = DATE_PREFIX.exec(rest);
  if (creation) {
    rest = rest.slice(creation[0].length);
  }

  const tags = Object.create(null);
  const titleParts = [];
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const kv = KEY_VALUE.exec(token);
    if (kv) {
      const key = kv[1].toLowerCase();
      (tags[key] ??= []).push(kv[2]);
    } else {
      titleParts.push(token);
    }
  }

  const id = tags["id"]?.[0] ?? hashLine(trimmed);
  const repos = (tags["repos"] ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const agent = tags["agent"]?.[0];
  const blockedValue = tags["blocked"]?.[0];
  const blocked = blockedValue !== undefined && !FALSEY.has(blockedValue.toLowerCase());

  const task = {
    id,
    title: titleParts.join(" "),
    description: trimmed,
    terminal: completed,
  };
  if (priorityLetter !== undefined) {
    task.priority = priorityLetterToNumber(priorityLetter);
  }
  if (blocked) {
    task.blocked = true;
  }
  if (agent !== undefined) {
    task.agent = agent;
  }
  if (repos.length > 0) {
    task.repos = repos;
  }

  return { task, lineIndex, completed, priorityLetter };
}

function parseFile(content) {
  const physicalLines = content.split("\n");
  const parsed = [];
  for (const [lineIndex, raw] of physicalLines.entries()) {
    const entry = parseLine(raw, lineIndex);
    if (entry) {
      parsed.push(entry);
    }
  }
  return { physicalLines, parsed };
}

function readStore() {
  const path = resolveTodoFile();
  let content = "";
  try {
    content = fs.readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      content = "";
    } else {
      throw error;
    }
  }
  return { path, ...parseFile(content) };
}

function listTasks() {
  const { parsed } = readStore();
  return { tasks: parsed.map((entry) => entry.task) };
}

function getTask(input) {
  const id = input?.id;
  if (id === undefined) {
    throw new Error("get requires an `id`");
  }
  const { parsed } = readStore();
  const entry = parsed.find((candidate) => candidate.task.id === id);
  if (!entry) {
    throw new Error(`task ${String(id)} not found in todo.txt`);
  }
  return { task: entry.task };
}

function stripPriorityPrefix(trimmed) {
  const match = PRIORITY_PREFIX.exec(trimmed);
  return match ? { letter: match[1], body: trimmed.slice(match[0].length) } : { body: trimmed };
}

function noteSlug(message) {
  return message
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .slice(0, 80);
}

// Mark a line completed per todo.txt convention: `x <date>` prefix, and move any
// priority into a `pri:` tag (completed tasks carry no bracketed priority).
function completeLine(trimmed) {
  if (trimmed.startsWith("x ")) {
    return trimmed;
  }
  const { letter, body } = stripPriorityPrefix(trimmed);
  const suffix = letter ? ` pri:${letter}` : "";
  return `x ${today()} ${body}${suffix}`;
}

// Keep a failed/stopped line open; append note tags recording the outcome.
function annotateOpenLine(trimmed, outcome, message) {
  const tags = [`gc-outcome:${outcome}`, `gc-updated:${today()}`];
  const slug = message ? noteSlug(message) : "";
  if (slug) {
    tags.push(`gc-note:${slug}`);
  }
  return `${trimmed} ${tags.join(" ")}`;
}

function applyUpdate(input) {
  const event = input?.event ?? {};
  if (event.type === "claimed") {
    return { result: "ok" };
  }
  if (event.type !== "completed") {
    // progress and any future event: acknowledged, no store mutation.
    return { result: "ok" };
  }

  const id = input?.id;
  const store = readStore();
  const entry = store.parsed.find((candidate) => candidate.task.id === id);
  if (!entry) {
    throw new Error(`cannot write back: task ${String(id)} not found in todo.txt`);
  }

  const original = store.physicalLines[entry.lineIndex];
  const trimmed = original.trim();
  const rewritten =
    event.outcome === "delivered"
      ? completeLine(trimmed)
      : annotateOpenLine(trimmed, event.outcome ?? "failed", event.message);

  if (rewritten !== trimmed) {
    store.physicalLines[entry.lineIndex] = rewritten;
    fs.writeFileSync(store.path, store.physicalLines.join("\n"));
  }
  return { result: "ok" };
}

// --- protocol plumbing (contracts §4.2): one JSON object in, one out ---

function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return {};
  }
}

function emit(object) {
  process.stdout.write(JSON.stringify(object) + "\n");
  process.exit(0);
}

async function run(handler) {
  try {
    const data = await handler(readStdin());
    emit({ ok: true, data });
  } catch (error) {
    emit({ ok: false, error: { message: error?.message ?? String(error) } });
  }
}

module.exports = {
  run,
  listTasks,
  getTask,
  applyUpdate,
  // exported for direct unit reuse if needed
  parseLine,
  priorityLetterToNumber,
};
