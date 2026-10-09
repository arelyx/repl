import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource/fragment-mono/latin-400.css";
import "@fontsource/fragment-mono/latin-ext-400.css";
import "@fontsource/fragment-mono/latin-400-italic.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/index.css";
import App from "./App.tsx";
import { setupMonacoLanguages } from "@/lib/lsp";
import { defineFjordThemes } from "@/lib/fjordThemes";
import "@/stores/theme";

// Use the locally bundled monaco-editor instead of loading from a CDN.
// Only the base editor worker: language services run without dedicated workers.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
// Extra Monarch grammars + language-server hooks (go-to-definition across files, markers).
setupMonacoLanguages();
defineFjordThemes(monaco);
// Monaco measures glyph widths once; re-measure after the self-hosted mono face arrives.
void document.fonts?.load('14px "Fragment Mono"').then(() => monaco.editor.remeasureFonts());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
