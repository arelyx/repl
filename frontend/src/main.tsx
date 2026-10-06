import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "@xterm/xterm/css/xterm.css";
import "./styles/index.css";
import App from "./App.tsx";

// Use the locally bundled monaco-editor instead of loading from a CDN.
// Only the base editor worker: language services run without dedicated workers.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
