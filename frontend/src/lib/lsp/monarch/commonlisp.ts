import type * as Monaco from "monaco-editor";

export const conf: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: ";", blockComment: ["#|", "|#"] },
  wordPattern: /[^\s()'"`,;#]+/,
  brackets: [["(", ")"]],
  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string", "comment"] },
    { open: "#|", close: " |#", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
};

export const language: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".lisp",
  ignoreCase: true,
  constants: ["nil", "t"],
  specialForms: [
    "block", "catch", "eval-when", "flet", "function", "go", "if", "labels", "let", "let*", "load-time-value",
    "locally", "macrolet", "multiple-value-call", "multiple-value-prog1", "progn", "progv", "quote",
    "return-from", "setq", "symbol-macrolet", "tagbody", "the", "throw", "unwind-protect",
    "and", "or", "when", "unless", "cond", "case", "ecase", "typecase", "etypecase", "loop", "do", "do*",
    "dolist", "dotimes", "return", "lambda", "handler-case", "handler-bind", "ignore-errors",
    "destructuring-bind", "multiple-value-bind", "with-open-file", "with-output-to-string",
    "with-slots", "with-accessors", "prog1", "prog2", "setf", "incf", "decf", "push", "pop", "assert",
    "check-type", "declare", "in-package",
  ],
  definers: [
    "defun", "defmacro", "defvar", "defparameter", "defconstant", "defclass", "defmethod", "defgeneric",
    "defstruct", "defpackage", "deftype", "define-condition", "defsetf", "define-modify-macro",
    "define-symbol-macro", "define-compiler-macro",
  ],
  builtins: [
    "car", "cdr", "cons", "list", "list*", "append", "reverse", "length", "mapcar", "mapc", "maplist",
    "reduce", "remove", "remove-if", "remove-if-not", "find", "find-if", "position", "member", "assoc",
    "format", "print", "princ", "prin1", "terpri", "write", "write-line", "read", "read-line",
    "funcall", "apply", "not", "null", "eq", "eql", "equal", "equalp", "first", "second", "third",
    "rest", "nth", "nthcdr", "last", "butlast", "subseq", "concatenate", "sort", "make-hash-table",
    "gethash", "remhash", "maphash", "make-array", "aref", "vector", "values", "error", "signal",
    "make-instance", "slot-value", "string=", "string-upcase", "string-downcase", "parse-integer",
    "max", "min", "abs", "mod", "rem", "floor", "ceiling", "round", "truncate", "sqrt", "expt",
    "zerop", "plusp", "minusp", "evenp", "oddp", "numberp", "stringp", "symbolp", "listp", "consp",
    "1+", "1-",
  ],
  tokenizer: {
    root: [
      [/;.*$/, "comment"],
      [/#\|/, "comment", "@blockComment"],
      [/"/, "string", "@string"],
      [/#\\(?:[a-zA-Z]+|.)/, "string"],
      [/[()]/, "@brackets"],
      [/['`]|,@?/, "operator"],
      [/#'/, "operator"],
      [/:[^\s()'"`,;]+/, "constant"],
      [/[+-]?\d+\/\d+/, "number"],
      [/[+-]?\d+\.\d*([eEdDfFsSlL][+-]?\d+)?(?=[\s()]|$)/, "number.float"],
      [/[+-]?\d+(?=[\s()]|$)/, "number"],
      [/#[xX][0-9a-fA-F]+|#[bB][01]+|#[oO][0-7]+/, "number.hex"],
      [/\*[^\s()'"`,;*]+\*/, "variable.predefined"],
      [
        /[^\s()'"`,;#|]+/,
        {
          cases: {
            "@constants": "constant",
            "@definers": "keyword",
            "@specialForms": "keyword",
            "@builtins": "predefined",
            "@default": "identifier",
          },
        },
      ],
    ],
    blockComment: [
      [/[^|#]+/, "comment"],
      [/#\|/, "comment", "@push"],
      [/\|#/, "comment", "@pop"],
      [/[|#]/, "comment"],
    ],
    string: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],
  },
};
