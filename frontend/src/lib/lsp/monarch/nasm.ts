import type * as Monaco from "monaco-editor";

export const conf: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: ";" },
  brackets: [
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
  ],
  autoClosingPairs: [
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "{", close: "}" },
    { open: '"', close: '"', notIn: ["string", "comment"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
    { open: "`", close: "`", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

const REGS = [
  "rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
  "eax", "ebx", "ecx", "edx", "esi", "edi", "ebp", "esp", "ax", "bx", "cx", "dx", "si", "di", "bp", "sp",
  "al", "ah", "bl", "bh", "cl", "ch", "dl", "dh", "sil", "dil", "bpl", "spl", "rip", "eip", "ip",
  "cs", "ds", "es", "fs", "gs", "ss", "cr0", "cr2", "cr3", "cr4", "dr0", "dr1", "dr2", "dr3", "dr6", "dr7",
  "st0", "st1", "st2", "st3", "st4", "st5", "st6", "st7",
];
for (let i = 8; i <= 15; i++) REGS.push(`r${i}d`, `r${i}w`, `r${i}b`);
for (let i = 0; i <= 31; i++) REGS.push(`xmm${i}`, `ymm${i}`, `zmm${i}`);
for (let i = 0; i <= 7; i++) REGS.push(`mm${i}`, `k${i}`);

export const language: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".nasm",
  ignoreCase: true,
  registers: REGS,
  directives: [
    "section", "segment", "global", "extern", "common", "bits", "use16", "use32", "use64", "default",
    "org", "align", "alignb", "absolute", "struc", "endstruc", "istruc", "iend", "at", "times", "equ",
    "db", "dw", "dd", "dq", "dt", "do", "dy", "dz", "resb", "resw", "resd", "resq", "rest", "reso",
    "resy", "resz", "incbin", "cpu", "float", "static", "rel", "abs", "wrt", "seg", "strict",
  ],
  sizes: ["byte", "word", "dword", "qword", "tword", "oword", "yword", "zword", "ptr", "near", "far", "short"],
  tokenizer: {
    root: [
      [/;.*$/, "comment"],
      [/^\s*%\s*\w+/, "keyword.directive"],
      [/%%?[\w.]+|%\d+/, "variable.predefined"],
      [/^\s*[.\w$?@]+:/, "type.identifier"],
      [/\$\$?(?![\w])/, "variable.predefined"],
      [
        /[.a-zA-Z_?@][\w$?@.#~]*/,
        {
          cases: {
            "@registers": "variable.predefined",
            "@directives": "keyword",
            "@sizes": "type",
            "@default": "identifier",
          },
        },
      ],
      [/0[xh][0-9a-f_]+|\$[0-9][0-9a-f_]*|[0-9][0-9a-f_]*h\b/, "number.hex"],
      [/0[by][01_]+|[01][01_]*[by]\b/, "number.binary"],
      [/0[oq][0-7_]+|[0-7][0-7_]*[oq]\b/, "number.octal"],
      [/\d[\d_]*(\.\d+)?(e[+-]?\d+)?/, "number"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/'[^']*'/, "string"],
      [/`([^`\\]|\\.)*`/, "string"],
      [/[[\](){}]/, "@brackets"],
      [/[-+*/%&|^~<>!=,:]/, "operator"],
    ],
  },
};
