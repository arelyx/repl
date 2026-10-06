// Hocuspocus server for multiplayer code editing.
// Each open file is a room named "{replId}::{path}" holding Y.Text("content").
// The file on disk (owned by the backend) stays the source of truth: rooms are
// seeded from it on load and written back to it on store.
import { Server } from "@hocuspocus/server";

const PORT = parseInt(process.env.WEBSOCKET_PORT || "1234", 10);
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
    const text = document.getText("content");
    if (text.length > 0) return document;
    const { replId, path } = parseName(documentName);
    const qs = new URLSearchParams({ repl_id: replId, path });
    try {
      const data = await internal("GET", `/files/content?${qs}`);
      if (data && typeof data.content === "string" && text.length === 0) {
        text.insert(0, data.content);
      }
    } catch (err) {
      // New/missing file: start empty; the first store will create it.
      console.warn(`load ${documentName}: ${err.message}`);
    }
    return document;
  },

  async onStoreDocument({ documentName, document }) {
    const { replId, path } = parseName(documentName);
    const content = document.getText("content").toString();
    await internal("PUT", "/files/content", { repl_id: replId, path, content });
  },
});

server.listen().then(() => console.log(`collaboration listening on :${PORT}`));
