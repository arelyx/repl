import { JsonRpcConnection, RpcError, type CancelToken } from "./jsonrpc";
import {
  ErrorCodes,
  type ProgressParams,
  type PublishDiagnosticsParams,
  type ServerCapabilities,
  type TextDocumentSyncKind,
} from "./protocol";

export type ClientState =
  | "idle" // created, waiting for the container
  | "connecting"
  | "initializing"
  | "ready"
  | "reconnecting"
  | "unavailable" // server not installed, no access, or keeps failing to start
  | "stopped";

export interface ClientStatus {
  state: ClientState;
  /** Active $/progress (e.g. "Indexing… 40%"), or the reason when unavailable. */
  message: string | null;
  /** True while at least one work-done progress is running. */
  busy: boolean;
}

export interface ContentChange {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  rangeLength?: number;
  text: string;
}

interface Doc {
  uri: string;
  languageId: string;
  version: number;
  getText: () => string;
  /** Whether the current server process has seen didOpen for it. */
  opened: boolean;
}

export interface LspClientOptions {
  server: string;
  /** ws(s):// URL of the bridge. */
  url: string;
  rootUri: string;
  /** Plain GET of the bridge URL: 404 = not installed, 401/403 = no access, 400 = exists. */
  probe?: () => Promise<number>;
  createSocket?: (url: string) => WebSocket;
  onStatus?: (s: ClientStatus) => void;
  onDiagnostics?: (p: PublishDiagnosticsParams) => void;
  /** Called after every successful initialize (capabilities may differ per process). */
  onReady?: (caps: ServerCapabilities) => void;
  /** Called when the connection to a ready server goes away. */
  onDown?: () => void;
  /** Requests from the server the client doesn't answer generically. */
  onServerRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  onShowMessage?: (type: number, message: string) => void;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];
const MAX_STARTUP_FAILURES = 4;
const INIT_TIMEOUT_MS = 60000;
const SHUTDOWN_TIMEOUT_MS = 1500;

export const COMPLETION_KINDS = Array.from({ length: 25 }, (_, i) => i + 1);

export function clientCapabilities() {
  const docFormats = ["markdown", "plaintext"];
  return {
    general: { positionEncodings: ["utf-16"], markdown: { parser: "marked", version: "1.1.0" } },
    workspace: {
      applyEdit: true,
      workspaceEdit: {
        documentChanges: true,
        resourceOperations: ["create", "rename", "delete"],
        failureHandling: "abort",
        normalizesLineEndings: true,
      },
      didChangeConfiguration: { dynamicRegistration: false },
      workspaceFolders: true,
      configuration: true,
      executeCommand: { dynamicRegistration: false },
    },
    textDocument: {
      synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
      completion: {
        dynamicRegistration: false,
        contextSupport: true,
        insertTextMode: 2,
        completionItem: {
          snippetSupport: true,
          commitCharactersSupport: true,
          documentationFormat: docFormats,
          deprecatedSupport: true,
          preselectSupport: true,
          tagSupport: { valueSet: [1] },
          insertReplaceSupport: true,
          resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
          insertTextModeSupport: { valueSet: [1, 2] },
          labelDetailsSupport: true,
        },
        completionItemKind: { valueSet: COMPLETION_KINDS },
        completionList: { itemDefaults: ["commitCharacters", "editRange", "insertTextFormat", "insertTextMode", "data"] },
      },
      hover: { dynamicRegistration: false, contentFormat: docFormats },
      signatureHelp: {
        dynamicRegistration: false,
        contextSupport: true,
        signatureInformation: {
          documentationFormat: docFormats,
          parameterInformation: { labelOffsetSupport: true },
          activeParameterSupport: true,
        },
      },
      declaration: { dynamicRegistration: false, linkSupport: true },
      definition: { dynamicRegistration: false, linkSupport: true },
      typeDefinition: { dynamicRegistration: false, linkSupport: true },
      implementation: { dynamicRegistration: false, linkSupport: true },
      references: { dynamicRegistration: false },
      documentHighlight: { dynamicRegistration: false },
      codeAction: {
        dynamicRegistration: false,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              "",
              "quickfix",
              "refactor",
              "refactor.extract",
              "refactor.inline",
              "refactor.rewrite",
              "source",
              "source.organizeImports",
              "source.fixAll",
            ],
          },
        },
        isPreferredSupport: true,
        disabledSupport: true,
        dataSupport: true,
        resolveSupport: { properties: ["edit"] },
      },
      formatting: { dynamicRegistration: false },
      rangeFormatting: { dynamicRegistration: false },
      onTypeFormatting: { dynamicRegistration: false },
      rename: { dynamicRegistration: false, prepareSupport: true, prepareSupportDefaultBehavior: 1 },
      publishDiagnostics: {
        relatedInformation: true,
        tagSupport: { valueSet: [1, 2] },
        versionSupport: true,
        codeDescriptionSupport: true,
        dataSupport: true,
      },
    },
    window: {
      workDoneProgress: true,
      showMessage: { messageActionItem: { additionalPropertiesSupport: false } },
      showDocument: { support: true },
    },
  };
}

/**
 * One language server connection (one server process in the repl's container).
 * Keeps the set of open documents so a reconnect re-opens them all.
 */
export class LspClient {
  readonly server: string;
  capabilities: ServerCapabilities = {};
  private conn: JsonRpcConnection | null = null;
  private docs = new Map<string, Doc>();
  private status: ClientStatus = { state: "idle", message: null, busy: false };
  private enabled = false;
  private disposed = false;
  private attempt = 0;
  private startupFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private progress = new Map<string | number, { title: string; message?: string; percentage?: number }>();

  constructor(private opts: LspClientOptions) {
    this.server = opts.server;
  }

  get state() {
    return this.status.state;
  }
  get isReady() {
    return this.status.state === "ready" && !!this.conn?.isOpen;
  }

  /** Connect while the container runs; disconnect (without giving up) when it stops. */
  setEnabled(on: boolean) {
    if (this.disposed || on === this.enabled) return;
    this.enabled = on;
    if (on) {
      if (this.status.state === "unavailable") return;
      this.attempt = 0;
      this.connect();
    } else {
      this.clearRetry();
      this.dropConnection();
      this.setStatus({ state: "idle", message: null, busy: false });
    }
  }

  /** Try again after "unavailable" (e.g. the user clicked retry). */
  retry() {
    if (this.disposed || !this.enabled) return;
    this.startupFailures = 0;
    this.attempt = 0;
    this.clearRetry();
    this.dropConnection();
    this.connect();
  }

  // ---- documents -------------------------------------------------------

  hasDocument(uri: string) {
    return this.docs.has(uri);
  }

  openDocument(uri: string, languageId: string, getText: () => string) {
    const existing = this.docs.get(uri);
    if (existing) {
      existing.getText = getText;
      return;
    }
    const doc: Doc = { uri, languageId, version: 0, getText, opened: false };
    this.docs.set(uri, doc);
    if (this.isReady) this.sendOpen(doc);
  }

  /** Swap the text source (e.g. the model was disposed and we keep a snapshot). */
  setTextSource(uri: string, getText: () => string) {
    const doc = this.docs.get(uri);
    if (doc) doc.getText = getText;
  }

  get syncKind(): TextDocumentSyncKind {
    const s = this.capabilities.textDocumentSync;
    if (typeof s === "number") return s;
    return s?.change ?? 0;
  }

  /** `changes` null means "the whole text changed". */
  changeDocument(uri: string, changes: ContentChange[] | null) {
    const doc = this.docs.get(uri);
    if (!doc) return;
    doc.version++;
    if (!this.isReady || !doc.opened) return;
    const kind = this.syncKind;
    if (kind === 0) return;
    const contentChanges = kind === 2 && changes ? changes : [{ text: doc.getText() }];
    this.conn!.notify("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges });
  }

  saveDocument(uri: string) {
    const doc = this.docs.get(uri);
    if (!doc || !doc.opened || !this.isReady) return;
    const s = this.capabilities.textDocumentSync;
    const save = typeof s === "object" ? s.save : undefined;
    if (typeof s === "object" && !save) return;
    const includeText = typeof save === "object" && !!save.includeText;
    this.conn!.notify("textDocument/didSave", {
      textDocument: { uri },
      ...(includeText ? { text: doc.getText() } : {}),
    });
  }

  closeDocument(uri: string) {
    const doc = this.docs.get(uri);
    if (!doc) return;
    this.docs.delete(uri);
    if (doc.opened && this.isReady) this.conn!.notify("textDocument/didClose", { textDocument: { uri } });
  }

  documentUris() {
    return [...this.docs.keys()];
  }

  private sendOpen(doc: Doc) {
    doc.version++;
    doc.opened = true;
    this.conn!.notify("textDocument/didOpen", {
      textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.getText() },
    });
  }

  // ---- requests --------------------------------------------------------

  request<R>(method: string, params: unknown, token?: CancelToken): Promise<R> {
    if (!this.isReady) return Promise.reject(new RpcError(ErrorCodes.ServerNotInitialized, "not ready"));
    return this.conn!.request<R>(method, params, token);
  }

  notify(method: string, params?: unknown) {
    if (this.isReady) this.conn!.notify(method, params);
  }

  // ---- connection lifecycle --------------------------------------------

  private setStatus(s: ClientStatus) {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private progressStatus(): Pick<ClientStatus, "message" | "busy"> {
    const items = [...this.progress.values()];
    if (!items.length) return { message: null, busy: false };
    const p = items[items.length - 1]!;
    const pct = p.percentage !== undefined ? ` ${Math.round(p.percentage)}%` : "";
    const text = [p.title, p.message].filter(Boolean).join(": ");
    return { message: `${text}${pct}`.trim() || "Working…", busy: true };
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private dropConnection() {
    const c = this.conn;
    this.conn = null;
    this.progress.clear();
    for (const d of this.docs.values()) d.opened = false;
    c?.close();
  }

  private connect() {
    if (this.disposed || !this.enabled) return;
    this.clearRetry();
    this.setStatus({
      state: this.attempt === 0 ? "connecting" : "reconnecting",
      message: null,
      busy: false,
    });
    let ws: WebSocket;
    try {
      ws = this.opts.createSocket ? this.opts.createSocket(this.opts.url) : new WebSocket(this.opts.url);
    } catch {
      void this.onFailure(false);
      return;
    }
    const conn = new JsonRpcConnection(ws);
    this.conn = conn;
    let opened = false;
    let initialized = false;
    conn.onRequest((m, p) => this.handleRequest(m, p));
    conn.onNotification((m, p) => this.handleNotification(m, p));
    conn.onClose(() => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.progress.clear();
      for (const d of this.docs.values()) d.opened = false;
      const wasReady = initialized;
      if (wasReady) this.opts.onDown?.();
      if (this.disposed) return;
      void this.onFailure(opened && wasReady);
    });
    ws.addEventListener("open", () => {
      if (this.conn !== conn) return;
      opened = true;
      this.setStatus({ state: "initializing", message: null, busy: false });
      const timer = setTimeout(() => {
        if (this.conn === conn && !initialized) conn.close();
      }, INIT_TIMEOUT_MS);
      conn
        .request<{ capabilities: ServerCapabilities }>("initialize", this.initializeParams())
        .then((res) => {
          clearTimeout(timer);
          if (this.conn !== conn) return;
          initialized = true;
          this.capabilities = res?.capabilities ?? {};
          conn.notify("initialized", {});
          this.attempt = 0;
          this.startupFailures = 0;
          this.setStatus({ state: "ready", ...this.progressStatus() });
          for (const d of this.docs.values()) this.sendOpen(d);
          this.opts.onReady?.(this.capabilities);
        })
        .catch(() => {
          clearTimeout(timer);
          if (this.conn === conn) conn.close();
        });
    });
  }

  /** The socket closed or never opened: decide between retrying and giving up. */
  private async onFailure(wasReady: boolean) {
    if (this.disposed || !this.enabled) return;
    if (!wasReady) this.startupFailures++;
    // Distinguish "not installed / no access" (permanent) from transient errors.
    if (!wasReady && this.opts.probe) {
      let code = 0;
      try {
        code = await this.opts.probe();
      } catch {
        code = 0;
      }
      if (this.disposed || !this.enabled) return;
      if (code === 404) return this.giveUp("not installed");
      if (code === 401 || code === 403) return this.giveUp("no access");
    }
    if (this.startupFailures >= MAX_STARTUP_FAILURES) return this.giveUp("failed to start");
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.setStatus({ state: "reconnecting", message: null, busy: false });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private giveUp(reason: string) {
    this.clearRetry();
    this.setStatus({ state: "unavailable", message: reason, busy: false });
  }

  private initializeParams() {
    const root = this.opts.rootUri;
    return {
      processId: null,
      clientInfo: { name: "Replot", version: "1.0" },
      locale: "en",
      rootPath: decodeURIComponent(root.replace(/^file:\/\//, "")),
      rootUri: root,
      workspaceFolders: [{ uri: root, name: "app" }],
      capabilities: clientCapabilities(),
      initializationOptions: {},
      trace: "off",
    };
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "workspace/configuration": {
        // The bridge answers this itself; reply with nulls if one slips through.
        const items = (params as { items?: unknown[] })?.items ?? [];
        return items.map(() => null);
      }
      case "workspace/workspaceFolders":
        return [{ uri: this.opts.rootUri, name: "app" }];
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "workspace/semanticTokens/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/codeLens/refresh":
      case "workspace/diagnostic/refresh":
      case "workspace/inlineValue/refresh":
        return null;
      case "window/showMessageRequest": {
        const p = params as { type: number; message: string; actions?: { title: string }[] };
        this.opts.onShowMessage?.(p.type, p.message);
        return p.actions?.[0] ?? null;
      }
      default:
        if (this.opts.onServerRequest) {
          const r = await this.opts.onServerRequest(method, params);
          if (r !== undefined) return r;
        }
        throw new RpcError(ErrorCodes.MethodNotFound, `unhandled method ${method}`);
    }
  }

  private handleNotification(method: string, params: unknown) {
    switch (method) {
      case "textDocument/publishDiagnostics":
        this.opts.onDiagnostics?.(params as PublishDiagnosticsParams);
        break;
      case "$/progress": {
        const p = params as ProgressParams;
        const v = p.value;
        if (!v || typeof v !== "object" || !("kind" in v)) break;
        if (v.kind === "begin") this.progress.set(p.token, { title: v.title ?? "", message: v.message, percentage: v.percentage });
        else if (v.kind === "report") {
          const cur = this.progress.get(p.token) ?? { title: "" };
          this.progress.set(p.token, { ...cur, message: v.message ?? cur.message, percentage: v.percentage ?? cur.percentage });
        } else this.progress.delete(p.token);
        if (this.status.state === "ready") this.setStatus({ state: "ready", ...this.progressStatus() });
        break;
      }
      case "window/showMessage": {
        const p = params as { type: number; message: string };
        this.opts.onShowMessage?.(p.type, p.message);
        break;
      }
      case "window/logMessage":
        if ((params as { type?: number })?.type === 1) console.warn(`[lsp:${this.server}]`, (params as { message: string }).message);
        break;
      default:
        break;
    }
  }

  /** Graceful shutdown: shutdown request, exit notification, close. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRetry();
    const conn = this.conn;
    this.conn = null;
    this.docs.clear();
    if (conn?.isOpen && this.status.state === "ready") {
      try {
        await Promise.race([
          conn.request("shutdown"),
          new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS)),
        ]);
        conn.notify("exit");
      } catch {
        /* closing anyway */
      }
    }
    conn?.close();
    this.setStatus({ state: "stopped", message: null, busy: false });
  }
}
