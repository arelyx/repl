/**
 * Which language server handles which file, and the LSP languageId to send.
 * Server names and extensions match the agent's lsp/*.json entries.
 */

export const WORKSPACE_ROOT = "/home/runner/app";
export const ROOT_URI = `file://${WORKSPACE_ROOT}`;

interface ServerSpec {
  /** extension (lower case, no dot) -> LSP languageId */
  exts: Record<string, string>;
  /** Human name for the status bar. */
  label: string;
}

export const SERVERS: Record<string, ServerSpec> = {
  pyright: { label: "Pyright", exts: { py: "python" } },
  typescript: {
    label: "TypeScript",
    exts: {
      js: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      jsx: "javascriptreact",
      ts: "typescript",
      mts: "typescript",
      cts: "typescript",
      tsx: "typescriptreact",
    },
  },
  vue: { label: "Vue", exts: { vue: "vue" } },
  clangd: {
    label: "clangd",
    exts: { c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp" },
  },
  gopls: { label: "gopls", exts: { go: "go" } },
  "rust-analyzer": { label: "rust-analyzer", exts: { rs: "rust" } },
  csharp: { label: "C#", exts: { cs: "csharp" } },
  jdtls: { label: "Java", exts: { java: "java" } },
  kotlin: { label: "Kotlin", exts: { kt: "kotlin", kts: "kotlin" } },
  ruby: { label: "Ruby", exts: { rb: "ruby" } },
  php: { label: "PHP", exts: { php: "php" } },
  perl: { label: "Perl", exts: { pl: "perl", pm: "perl" } },
  lua: { label: "Lua", exts: { lua: "lua" } },
  bash: { label: "Bash", exts: { sh: "shellscript", bash: "shellscript" } },
  haskell: { label: "Haskell", exts: { hs: "haskell" } },
  r: { label: "R", exts: { r: "r" } },
  fortran: {
    label: "Fortran",
    exts: { f90: "fortran", f95: "fortran", f03: "fortran", f08: "fortran", f: "fortran" },
  },
  pascal: { label: "Pascal", exts: { pas: "pascal", pp: "pascal" } },
  nasm: { label: "NASM", exts: { asm: "nasm", s: "nasm", nasm: "nasm" } },
  scheme: { label: "Scheme", exts: { scm: "scheme", ss: "scheme" } },
  commonlisp: { label: "Common Lisp", exts: { lisp: "commonlisp", lsp: "commonlisp", cl: "commonlisp" } },
  html: { label: "HTML", exts: { html: "html", htm: "html" } },
  css: { label: "CSS", exts: { css: "css", scss: "scss", less: "less" } },
  json: { label: "JSON", exts: { json: "json" } },
};

const BY_EXT = new Map<string, { server: string; languageId: string }>();
for (const [server, spec] of Object.entries(SERVERS)) {
  for (const [ext, languageId] of Object.entries(spec.exts)) BY_EXT.set(ext, { server, languageId });
}

export function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** The server and languageId for a repl path, or null if no server covers it. */
export function serverForPath(path: string): { server: string; languageId: string } | null {
  return BY_EXT.get(extOf(path)) ?? null;
}

export function serverExtensions(server: string): string[] {
  return Object.keys(SERVERS[server]?.exts ?? {});
}

/** Repl-relative path -> file:///home/runner/app/<path> (percent-encoded like vscode-uri). */
export function pathToUri(path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `${ROOT_URI}/${clean.split("/").map(encodeSegment).join("/")}`;
}

function encodeSegment(s: string) {
  // Same escaping as vscode-uri's toString(): keep unreserved and a few safe characters.
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** file:///home/runner/app/<path> -> <path>, or null if outside the repl. */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let p: string;
  try {
    p = decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
  // Windows-ish "file:///c%3A/..." can't occur here; normalize a host-less form.
  if (!p.startsWith(WORKSPACE_ROOT + "/")) return null;
  const rel = p.slice(WORKSPACE_ROOT.length + 1);
  if (!rel || rel.split("/").some((s) => s === ".." || s === "")) return null;
  return rel;
}

/** Canonical form for comparing URIs that different servers may escape differently. */
export function normalizeUri(uri: string): string {
  const p = uriToPath(uri);
  return p === null ? uri : pathToUri(p);
}
