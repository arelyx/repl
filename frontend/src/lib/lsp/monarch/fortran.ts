import type * as Monaco from "monaco-editor";

export const conf: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "!" },
  brackets: [
    ["(", ")"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: '"', close: '"', notIn: ["string", "comment"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  indentationRules: {
    increaseIndentPattern:
      /^\s*((program|module|submodule|subroutine|function|interface|type(?!\s*\()|block|associate|select|where|forall|critical)\b|(do|if\b.*\bthen)\b|.*\b(then|else|contains)\s*(!.*)?$)/i,
    decreaseIndentPattern: /^\s*(end|else|contains|case)\b/i,
  },
  folding: {
    markers: {
      start: /^\s*(program|module|subroutine|function|do|if.*then|select|type\s+\w)\b/i,
      end: /^\s*end\b/i,
    },
  },
};

export const language: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".f90",
  ignoreCase: true,
  keywords: [
    "allocatable", "allocate", "assign", "associate", "asynchronous", "backspace", "bind", "block",
    "call", "case", "class", "close", "codimension", "common", "concurrent", "contains", "contiguous",
    "continue", "critical", "cycle", "data", "deallocate", "default", "deferred", "dimension", "do",
    "elemental", "else", "elseif", "elsewhere", "end", "enddo", "endif", "entry", "enum", "enumerator",
    "equivalence", "error", "exit", "extends", "external", "final", "flush", "forall", "format",
    "function", "generic", "go", "goto", "if", "implicit", "import", "impure", "in", "include",
    "inout", "inquire", "intent", "interface", "intrinsic", "module", "namelist", "none", "non_overridable",
    "nopass", "nullify", "only", "open", "operator", "optional", "out", "parameter", "pass", "pause",
    "pointer", "print", "private", "procedure", "program", "protected", "public", "pure", "read",
    "recursive", "result", "return", "rewind", "save", "select", "sequence", "stop", "submodule",
    "subroutine", "target", "then", "to", "type", "use", "value", "volatile", "wait", "where",
    "while", "write",
  ],
  typeKeywords: ["integer", "real", "double", "precision", "complex", "character", "logical", "kind", "len"],
  builtins: [
    "abs", "achar", "acos", "adjustl", "adjustr", "aimag", "aint", "all", "allocated", "anint", "any",
    "asin", "associated", "atan", "atan2", "ceiling", "char", "cmplx", "cos", "cosh", "count", "cpu_time",
    "date_and_time", "dble", "dot_product", "epsilon", "exp", "floor", "huge", "iachar", "ichar", "index",
    "int", "len_trim", "lbound", "log", "log10", "matmul", "max", "maxval", "merge", "min", "minval",
    "mod", "modulo", "nint", "present", "product", "random_number", "random_seed", "repeat", "reshape",
    "shape", "sign", "sin", "sinh", "size", "sqrt", "sum", "system_clock", "tan", "tanh", "tiny", "transpose",
    "trim", "ubound", "get_command_argument", "command_argument_count",
  ],
  tokenizer: {
    root: [
      [/!.*$/, "comment"],
      [/^\*.*$/, "comment"],
      [/\.(true|false)\.(_\w+)?/, "constant"],
      [/\.(and|or|not|eqv|neqv|eq|ne|lt|le|gt|ge)\./, "operator"],
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@builtins": "predefined",
            "@default": "identifier",
          },
        },
      ],
      [/\d+\.\d*([eEdD][+-]?\d+)?(_\w+)?/, "number.float"],
      [/\.\d+([eEdD][+-]?\d+)?(_\w+)?/, "number.float"],
      [/\d+[eEdD][+-]?\d+(_\w+)?/, "number.float"],
      [/\d+(_\w+)?/, "number"],
      [/[bB]'[01]+'|[oO]'[0-7]+'|[zZ]'[0-9a-fA-F]+'/, "number.hex"],
      [/"/, "string", "@dstring"],
      [/'/, "string", "@sstring"],
      [/[()[\]]/, "@brackets"],
      [/(\*\*|\/\/|==|\/=|<=|>=|=>|::|[-+*/=<>%&])/, "operator"],
      [/[,;:]/, "delimiter"],
    ],
    dstring: [
      [/[^"]+/, "string"],
      [/""/, "string.escape"],
      [/"/, "string", "@pop"],
    ],
    sstring: [
      [/[^']+/, "string"],
      [/''/, "string.escape"],
      [/'/, "string", "@pop"],
    ],
  },
};
