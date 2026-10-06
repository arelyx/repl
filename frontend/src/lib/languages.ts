const EXT: Record<string, string> = {
  py: "python",
  pyw: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  sh: "shell",
  bash: "shell",
  hs: "haskell",
  r: "r",
  f90: "fortran",
  f: "fortran",
  pas: "pascal",
  asm: "asm",
  s: "asm",
  scm: "scheme",
  ss: "scheme",
  lisp: "lisp",
  cl: "lisp",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  vue: "html",
  dockerfile: "dockerfile",
  swift: "swift",
  dart: "dart",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  txt: "plaintext",
};

export function languageForPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "plaintext";
  if (lower === ".replit") return "ini";
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return EXT[ext] ?? "plaintext";
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

export function imageMime(path: string): string | null {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return IMAGE_MIME[ext] ?? null;
}
