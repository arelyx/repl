import type * as Monaco from "monaco-editor";

export const conf: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "--", blockComment: ["{-", "-}"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string", "comment"] },
    { open: "{-", close: " -}", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  indentationRules: {
    increaseIndentPattern: /(\b(where|do|of|let|in|then|else)|=|->|<-)\s*$/,
    decreaseIndentPattern: /^\s*(in|then|else)\b/,
  },
};

export const language: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".hs",
  keywords: [
    "case", "class", "data", "default", "deriving", "do", "else", "family", "forall", "foreign",
    "if", "import", "in", "infix", "infixl", "infixr", "instance", "let", "mdo", "module",
    "newtype", "of", "pattern", "proc", "qualified", "rec", "then", "type", "where", "as", "hiding",
  ],
  builtins: [
    "map", "filter", "foldr", "foldl", "foldl'", "putStrLn", "putStr", "print", "show", "read",
    "return", "pure", "fmap", "mapM_", "mapM", "sequence", "head", "tail", "length", "reverse",
    "concat", "concatMap", "zip", "zipWith", "fst", "snd", "not", "otherwise", "error", "undefined",
    "id", "const", "flip", "maybe", "either", "lines", "unlines", "words", "unwords", "getLine",
    "interact", "div", "mod", "max", "min", "sum", "product", "elem", "take", "drop", "replicate",
  ],
  operators: /[!#$%&*+./<=>?@\\^|~:-]+/,
  escapes: /\\(?:[abfnrtv\\"'&]|x[0-9A-Fa-f]+|o[0-7]+|[0-9]+|\^[A-Z@[\\\]^_]|NUL|SOH|STX|ETX|EOT|ENQ|ACK|BEL|BS|HT|LF|VT|FF|CR|SO|SI|DLE|DC[1-4]|NAK|SYN|ETB|CAN|EM|SUB|ESC|FS|GS|RS|US|SP|DEL)/,
  tokenizer: {
    root: [
      [/\{-#/, "keyword.pragma", "@pragma"],
      [/\{-/, "comment", "@comment"],
      [/--+(?![!#$%&*+./<=>?@\\^|~:]).*$/, "comment"],
      [/^(\s*)(import)(\s+)(qualified\s+)?([A-Z][\w.]*)/, ["", "keyword", "", "keyword", "namespace"]],
      [/[A-Z][\w']*(\.[A-Z][\w']*)*/, "type.identifier"],
      [
        /[a-z_][\w']*/,
        { cases: { "@keywords": "keyword", "@builtins": "predefined", "@default": "identifier" } },
      ],
      [/0[xX][0-9a-fA-F_]+/, "number.hex"],
      [/0[oO][0-7_]+/, "number.octal"],
      [/0[bB][01_]+/, "number.binary"],
      [/\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/, "number"],
      [/"/, "string", "@string"],
      [/'(?:@escapes|[^\\'])'/, "string"],
      [/`[\w']+`/, "operator"],
      [/[()[\]{},;]/, "delimiter"],
      [/@operators/, "operator"],
    ],
    comment: [
      [/[^{-]+/, "comment"],
      [/\{-/, "comment", "@push"],
      [/-\}/, "comment", "@pop"],
      [/[{-]/, "comment"],
    ],
    pragma: [
      [/#-\}/, "keyword.pragma", "@pop"],
      [/[^#]+/, "keyword.pragma"],
      [/#/, "keyword.pragma"],
    ],
    string: [
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, "string", "@pop"],
    ],
  },
};
