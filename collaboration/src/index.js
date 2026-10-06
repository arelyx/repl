// Hocuspocus server for multiplayer code editing.
// Each open file is a room named "{replId}::{path}" holding Y.Text("content").
// The file on disk (owned by the backend) stays the source of truth: rooms are
// seeded from it on load and written back to it on store.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Server } from "@hocuspocus/server";

const PORT = parseInt(process.env.WEBSOCKET_PORT || "1234", 10);
const COMMAND_PORT = parseInt(process.env.COMMAND_PORT || "1235", 10);
const BACKEND = process.env.BACKEND_URL || "http://backend:8000";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "";

if (!INTERNAL_SECRET) {
  console.error("INTERNAL_SECRET is not set; refusing to start");
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection (kept alive):", reason);
});

function parseName(documentName) {
  const i = documentName.indexOf("::");
  if (i <= 0) throw new Error(`bad document name: ${documentName}`);
  return { replId: documentName.slice(0, i), path: documentName.slice(i + 2) };
}

async function internal(method, path, body) {
  const res = await fetch(`${BACKEND}/api/v1/internal${path}`, {
    method,
    headers: { "X-Internal-Secret": INTERNAL_SECRET, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// Rooms whose file vanished from disk; their pending stores are dropped.
const discarded = new Set();
// Room name → file content as of the last load/store/reload. Lets the disk
// poller tell "someone edited the file from the shell" (disk moved) apart
// from "editors have unsaved changes" (room moved).
const lastSynced = new Map();
const POLL_MS = parseInt(process.env.DISK_POLL_MS || "2000", 10);

const server = Server.configure({
  port: PORT,
  timeout: 30_000,
  debounce: 1000,
  maxDebounce: 5000,
  quiet: true,

  async onAuthenticate({ documentName, requestHeaders, connection }) {
    const { replId, path } = parseName(documentName);
    const qs = new URLSearchParams({ repl_id: replId, path });
    const res = await fetch(`${BACKEND}/api/v1/internal/collab-auth?${qs}`, {
      headers: { cookie: requestHeaders.cookie || "" },
    });
    if (!res.ok) throw new Error(`unauthorized (${res.status})`);
    const user = await res.json();
    if (user.read_only) connection.readOnly = true;
    return { user };
  },

  async onLoadDocument({ documentName, document }) {
    discarded.delete(documentName);
    const text = document.getText("content");
    if (text.length > 0) return document;
    const { replId, path } = parseName(documentName);
    const qs = new URLSearchParams({ repl_id: replId, path });
    try {
      const data = await internal("GET", `/files/content?${qs}`);
      if (data && typeof data.content === "string" && text.length === 0) {
        text.insert(0, data.content);
      }
      lastSynced.set(documentName, text.toString());
    } catch (err) {
      // New/missing file: start empty; the first store will create it.
      console.warn(`load ${documentName}: ${err.message}`);
    }
    return document;
  },

  async onStoreDocument({ documentName, document }) {
    // The file was deleted or replaced on disk; don't resurrect stale text.
    if (discarded.has(documentName)) return;
    const { replId, path } = parseName(documentName);
    const content = document.getText("content").toString();
    await internal("PUT", "/files/content", { repl_id: replId, path, content });
    lastSynced.set(documentName, content);
  },

  async afterUnloadDocument({ documentName }) {
    lastSynced.delete(documentName);
  },
});

async function readDisk(name) {
  const { replId, path } = parseName(name);
  const qs = new URLSearchParams({ repl_id: replId, path });
  const res = await fetch(`${BACKEND}/api/v1/internal/files/content?${qs}`, {
    headers: { "X-Internal-Secret": INTERNAL_SECRET },
  });
  if (res.status === 404 || res.status === 400) return { missing: true };
  if (!res.ok) return { error: res.status };
  const { content } = await res.json();
  return { content };
}

function replaceText(name, document, content) {
  const text = document.getText("content");
  if (text.toString() !== content) {
    document.transact(() => {
      text.delete(0, text.length);
      text.insert(0, content);
    }, "disk-reload");
  }
  lastSynced.set(name, content);
}

// Re-sync every open room of a repl with the files on disk. The backend calls
// this after anything that changes files outside the editor (git restore,
// rename, delete, upload, REST saves). Changed text is replaced in place, so
// connected editors update live; rooms whose file is gone are closed.
async function reloadRepl(replId) {
  const prefix = `${replId}::`;
  for (const [name, document] of server.documents) {
    if (!name.startsWith(prefix)) continue;
    const disk = await readDisk(name);
    if (disk.missing) {
      discarded.add(name);
      server.closeConnections(name);
    } else if (typeof disk.content === "string") {
      replaceText(name, document, disk.content);
    }
  }
}

// Pick up edits made outside the editor (shell, a program writing its own
// source, git in the terminal). Only when the room has no unsaved changes of
// its own; otherwise the editors win and their next store overwrites disk.
let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    for (const [name, document] of server.documents) {
      const last = lastSynced.get(name);
      if (last === undefined || discarded.has(name)) continue;
      const disk = await readDisk(name).catch(() => ({ error: true }));
      if (typeof disk.content !== "string" || disk.content === last) continue;
      if (document.getText("content").toString() === last) {
        replaceText(name, document, disk.content);
      }
    }
  } finally {
    polling = false;
  }
}, POLL_MS);

function secretOk(given) {
  const a = Buffer.from(given || "");
  const b = Buffer.from(INTERNAL_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

const commands = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/reload" || !secretOk(req.headers["x-internal-secret"])) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const { repl_id: replId } = JSON.parse(body);
      if (typeof replId !== "string" || !/^[a-z0-9]+$/.test(replId)) throw new Error("bad repl_id");
      await reloadRepl(replId);
      res.writeHead(204).end();
    } catch (err) {
      console.error("reload failed:", err.message);
      res.writeHead(400).end();
    }
  });
});

server.listen().then(() => console.log(`collaboration listening on :${PORT}`));
commands.listen(COMMAND_PORT, () => console.log(`commands listening on :${COMMAND_PORT}`));
