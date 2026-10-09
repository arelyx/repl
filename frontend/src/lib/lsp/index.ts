import * as monaco from "monaco-editor";
import { wireMonaco } from "./manager";
import { registerExtraLanguages } from "./monarch";

/** Call once at startup, before any editor is created. */
export function setupMonacoLanguages() {
  registerExtraLanguages(monaco);
  wireMonaco();
  // Monaco rejects pending delayed work with a "Canceled" error when an editor
  // is disposed mid-request (switching tabs during a hover/lightbulb query).
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { name?: string; message?: string } | undefined;
    if (r && r.name === "Canceled" && r.message === "Canceled") e.preventDefault();
  });
}

export { LspManager, getActiveManager, setActiveManager } from "./manager";
export { useLspStore } from "./store";
export { serverForPath, pathToUri, SERVERS } from "./servers";
