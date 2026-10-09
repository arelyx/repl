import type * as Monaco from "monaco-editor";

export const MONACO_THEME = "replot-graphite";
export const CODE_FONT = '"Red Hat Mono Variable", ui-monospace, "SFMono-Regular", Menlo, monospace';

let defined = false;

/** Graphite editor theme matching the dense-pro tokens. Safe to call before every mount. */
export function defineMonacoTheme(monaco: typeof Monaco) {
  if (defined) return;
  defined = true;
  monaco.editor.defineTheme(MONACO_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "dce1ea" },
      { token: "comment", foreground: "7f899b", fontStyle: "italic" },
      { token: "keyword", foreground: "c3a6ff" },
      { token: "keyword.control", foreground: "c3a6ff" },
      { token: "storage", foreground: "c3a6ff" },
      { token: "string", foreground: "b5d88a" },
      { token: "string.escape", foreground: "6fd0e8" },
      { token: "regexp", foreground: "6fd0e8" },
      { token: "number", foreground: "f2b56b" },
      { token: "constant", foreground: "f2a65a" },
      { token: "type", foreground: "6fd0e8" },
      { token: "type.identifier", foreground: "6fd0e8" },
      { token: "identifier", foreground: "dce1ea" },
      { token: "function", foreground: "82aaff" },
      { token: "delimiter", foreground: "9aa4b5" },
      { token: "operator", foreground: "9aa4b5" },
      { token: "tag", foreground: "f08a8a" },
      { token: "metatag", foreground: "f08a8a" },
      { token: "attribute.name", foreground: "e8cf62" },
      { token: "attribute.value", foreground: "b5d88a" },
      { token: "variable", foreground: "dce1ea" },
      { token: "variable.predefined", foreground: "f2a65a" },
      { token: "annotation", foreground: "e8cf62" },
      { token: "key", foreground: "82aaff" },
    ],
    colors: {
      "editor.background": "#1c2029",
      "editor.foreground": "#dce1ea",
      "editorLineNumber.foreground": "#6b7486",
      "editorLineNumber.activeForeground": "#c6ccd7",
      "editor.lineHighlightBackground": "#232834",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#82aaff3d",
      "editor.inactiveSelectionBackground": "#82aaff22",
      "editor.selectionHighlightBackground": "#82aaff1f",
      "editor.wordHighlightBackground": "#82aaff1a",
      "editor.findMatchBackground": "#f2b54455",
      "editor.findMatchHighlightBackground": "#f2b54426",
      "editorCursor.foreground": "#82aaff",
      "editorIndentGuide.background1": "#2c3240",
      "editorIndentGuide.activeBackground1": "#454d5e",
      "editorWhitespace.foreground": "#3a4252",
      "editorBracketMatch.background": "#82aaff1a",
      "editorBracketMatch.border": "#82aaff80",
      "editorGutter.background": "#1c2029",
      "editorWidget.background": "#262b36",
      "editorWidget.border": "#363d4b",
      "editorSuggestWidget.background": "#262b36",
      "editorSuggestWidget.border": "#363d4b",
      "editorSuggestWidget.selectedBackground": "#2f3645",
      "editorSuggestWidget.highlightForeground": "#82aaff",
      "editorHoverWidget.background": "#262b36",
      "editorHoverWidget.border": "#363d4b",
      "editorError.foreground": "#f07178",
      "editorWarning.foreground": "#e8cf62",
      "editorInfo.foreground": "#82aaff",
      "editorOverviewRuler.border": "#00000000",
      "scrollbarSlider.background": "#4a536680",
      "scrollbarSlider.hoverBackground": "#5a6478a0",
      "scrollbarSlider.activeBackground": "#82aaff80",
      "focusBorder": "#82aaff",
      "input.background": "#1c2029",
      "input.border": "#3e4656",
      "list.hoverBackground": "#2c3240",
      "list.activeSelectionBackground": "#2f3645",
      "list.highlightForeground": "#82aaff",
      "menu.background": "#262b36",
      "menu.border": "#363d4b",
    },
  });
  // Monaco measures glyphs at mount; remeasure once the variable mono face has loaded.
  void document.fonts
    ?.load('13px "Red Hat Mono Variable"')
    .then(() => monaco.editor.remeasureFonts())
    .catch(() => {});
}
