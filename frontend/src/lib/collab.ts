import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { wsBase } from "@/lib/api";

const COLORS = ["#f26207", "#0079f2", "#00b37e", "#a259ff", "#ff4d8d", "#e5b400", "#00b8d9", "#ff6b4a"];
export const randomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)]!;

/** One color per browser session, so a user's cursor keeps its color across files. */
let sessionColor: string | null = null;
export function myColor() {
  if (!sessionColor) sessionColor = randomColor();
  return sessionColor;
}

export interface CollabSession {
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  destroy: () => void;
}

/**
 * Open the Hocuspocus room `${replId}::${path}`. The server authenticates from the
 * WS upgrade's cookie; the token is a placeholder so onAuthenticate runs.
 */
export function openCollab(
  replId: string,
  path: string,
  user: { name: string; color: string },
  handlers: { onSynced: () => void; onDisconnect: () => void; onAuthFailed: () => void },
): CollabSession {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `${wsBase()}/collab`,
    name: `${replId}::${path}`,
    document: ydoc,
    token: "cookie",
    onSynced: () => handlers.onSynced(),
    onDisconnect: () => handlers.onDisconnect(),
    onAuthenticationFailed: () => handlers.onAuthFailed(),
  });
  provider.setAwarenessField("user", user);

  const styleEl = document.createElement("style");
  document.head.appendChild(styleEl);
  const updateCursorStyles = () => {
    const rules: string[] = [];
    provider.awareness?.getStates().forEach((state, clientId) => {
      if (clientId === ydoc.clientID) return;
      const u = (state as { user?: { name?: string; color?: string } }).user;
      if (!u) return;
      const color = u.color || "#f26207";
      const name = String(u.name || "anonymous").replace(/["\\\n]/g, "");
      rules.push(
        `.yRemoteSelection-${clientId}{background-color:${color}40;}`,
        `.yRemoteSelectionHead-${clientId}{position:absolute;border-left:2px solid ${color};border-top:2px solid ${color};border-bottom:2px solid ${color};height:100%;box-sizing:border-box;}`,
        `.yRemoteSelectionHead-${clientId}::after{content:"${name}";background-color:${color};}`,
      );
    });
    styleEl.textContent = rules.join("\n");
  };
  provider.awareness?.on("change", updateCursorStyles);

  return {
    ydoc,
    ytext: ydoc.getText("content"),
    provider,
    destroy: () => {
      provider.awareness?.off("change", updateCursorStyles);
      styleEl.remove();
      provider.destroy();
      ydoc.destroy();
    },
  };
}
