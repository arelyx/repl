/**
 * Per-language accent colors. All share roughly the same lightness so dark ink
 * (#14171d) on them stays at 7:1 or better and they read at 6:1 or better as text on
 * the slate panels. The workspace sets the active one as the CSS variable --lang.
 */
const ACCENTS: Record<string, string> = {
  python: "#7daef0",
  javascript: "#e8cf62",
  nodejs: "#8fcb6b",
  typescript: "#4fc1e9",
  go: "#5ed6c4",
  rust: "#e39a84",
  java: "#f2a65a",
  kotlin: "#b79bf5",
  c: "#a9b4c6",
  cpp: "#f290b8",
  csharp: "#7fd49a",
  ruby: "#f08a8a",
  php: "#9ea8f0",
  lua: "#a7b8ff",
  perl: "#6fc2d6",
  bash: "#a6d86e",
  shell: "#a6d86e",
  haskell: "#c49ce0",
  r: "#6fa8dc",
  fortran: "#b4a6f0",
  pascal: "#e3e07a",
  nasm: "#c9b48a",
  assembly: "#c9b48a",
  scheme: "#8fb0e8",
  lisp: "#6cd3a6",
  "common-lisp": "#6cd3a6",
  commonlisp: "#6cd3a6",
  html: "#f0956a",
  css: "#8fb0e8",
};

export const DEFAULT_ACCENT = "#82aaff";

export function langAccent(language: string | null | undefined): string {
  return ACCENTS[(language ?? "").toLowerCase()] ?? DEFAULT_ACCENT;
}

const NAMES: Record<string, string> = {
  python: "Python",
  javascript: "JavaScript",
  nodejs: "Node.js",
  typescript: "TypeScript",
  go: "Go",
  rust: "Rust",
  java: "Java",
  kotlin: "Kotlin",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  ruby: "Ruby",
  php: "PHP",
  lua: "Lua",
  perl: "Perl",
  bash: "Bash",
  haskell: "Haskell",
  r: "R",
  fortran: "Fortran",
  pascal: "Pascal",
  nasm: "NASM",
  scheme: "Scheme",
  lisp: "Common Lisp",
  "common-lisp": "Common Lisp",
  html: "HTML",
};

export function langName(language: string | null | undefined): string {
  const key = (language ?? "").toLowerCase();
  return NAMES[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Plain text");
}

/** Two-letter abbreviation used on language chips. */
export function langAbbr(language: string, label?: string): string {
  const key = language.toLowerCase();
  if (label) {
    const words = label.replace(/[^A-Za-z0-9+#\s]/g, " ").trim().split(/\s+/).filter(Boolean);
    if (words.length > 1 && /^[A-Z]/.test(words[1]!)) return (words[0]![0]! + words[1]![0]!).toUpperCase();
    const w = words[0] ?? key;
    if (w === "C++" || w === "C#") return w;
    return w.charAt(0).toUpperCase() + (w.charAt(1) ?? "").toLowerCase();
  }
  if (key === "cpp") return "C++";
  if (key === "csharp") return "C#";
  if (key === "javascript") return "JS";
  if (key === "typescript") return "TS";
  return key.charAt(0).toUpperCase() + key.charAt(1);
}
