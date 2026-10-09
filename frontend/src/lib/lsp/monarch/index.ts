import type * as Monaco from "monaco-editor";
import * as commonlisp from "./commonlisp";
import * as fortran from "./fortran";
import * as haskell from "./haskell";
import * as nasm from "./nasm";

/** Languages Monaco ships no Monarch grammar for. */
const EXTRA: { id: string; extensions: string[]; aliases: string[]; mod: { conf: Monaco.languages.LanguageConfiguration; language: Monaco.languages.IMonarchLanguage } }[] = [
  { id: "haskell", extensions: [".hs", ".lhs"], aliases: ["Haskell"], mod: haskell },
  { id: "fortran", extensions: [".f90", ".f95", ".f03", ".f08", ".f", ".for"], aliases: ["Fortran"], mod: fortran },
  { id: "nasm", extensions: [".asm", ".s", ".nasm"], aliases: ["NASM", "Assembly"], mod: nasm },
  { id: "commonlisp", extensions: [".lisp", ".lsp", ".cl"], aliases: ["Common Lisp"], mod: commonlisp },
];

let done = false;

export function registerExtraLanguages(monaco: typeof Monaco) {
  if (done) return;
  done = true;
  for (const l of EXTRA) {
    monaco.languages.register({ id: l.id, extensions: l.extensions, aliases: l.aliases });
    monaco.languages.setMonarchTokensProvider(l.id, l.mod.language);
    monaco.languages.setLanguageConfiguration(l.id, l.mod.conf);
  }
}
