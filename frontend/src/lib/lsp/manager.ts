import * as monaco from "monaco-editor";
import { toast } from "sonner";
import { errorMessage, wsBase } from "@/lib/api";
import { languageForPath } from "@/lib/languages";
import { replsApi } from "@/lib/repls";
import { useWorkspace } from "@/stores/workspace";
import { LspClient, type ContentChange } from "./client";
import { applyTextEdits, toLspRange, toMarker, toRange } from "./convert";
import type { CodeAction, Command, PublishDiagnosticsParams, Range, ServerCapabilities, TextEdit, WorkspaceEdit } from "./protocol";
import { registerProviders } from "./providers";
import { ROOT_URI, normalizeUri, pathToUri, serverForPath, uriToPath } from "./servers";
import { useLspStore } from "./store";

interface DocEntry {
  uri: string;
  path: string;
  server: string;
  languageId: string;
  /** Live model while an editor shows this file. */
  model: monaco.editor.ITextModel | null;
  editor: monaco.editor.ICodeEditor | null;
  subs: monaco.IDisposable[];
  /** Last known text when no model is live (the tab is open but not mounted). */
  snapshot: string;
}

type Reveal = { path: string; range: monaco.IRange };

const MAX_PRELOADED = 40;
const markerOwner = (server: string) => `lsp:${server}`;

/**
 * Per-repl intellisense: one LspClient per language server, shared by every
 * open file of that language; keeps Monaco models, markers and the server's
 * view of the documents in sync.
 */
export class LspManager {
  private clients = new Map<string, LspClient>();
  private docs = new Map<string, DocEntry>();
  private providerRegs = new Map<string, monaco.IDisposable[]>();
  private preloaded = new Map<string, monaco.editor.ITextModel>();
  private pendingReveal: Reveal | null = null;
  private running = false;
  private disposed = false;
  private openTabs = new Set<string>();

  constructor(readonly replId: string) {}

  // ---- lifecycle --------------------------------------------------------

  setContainerRunning(on: boolean) {
    this.running = on;
    for (const c of this.clients.values()) c.setEnabled(on);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const regs of this.providerRegs.values()) regs.forEach((d) => d.dispose());
    this.providerRegs.clear();
    for (const d of this.docs.values()) {
      d.subs.forEach((s) => s.dispose());
      this.clearMarkers(d.uri, d.server);
    }
    this.docs.clear();
    for (const m of this.preloaded.values()) if (!m.isDisposed()) m.dispose();
    this.preloaded.clear();
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => c.dispose()));
  }

  private ensureClient(server: string): LspClient {
    let c = this.clients.get(server);
    if (c) return c;
    const url = `${wsBase()}/ws/repls/${encodeURIComponent(this.replId)}/lsp/${server}`;
    const httpUrl = `${location.protocol}//${location.host}/ws/repls/${encodeURIComponent(this.replId)}/lsp/${server}`;
    c = new LspClient({
      server,
      url,
      rootUri: ROOT_URI,
      probe: async () => (await fetch(httpUrl, { credentials: "include", cache: "no-store" })).status,
      onStatus: (s) => {
        if (!this.disposed) useLspStore.getState().setStatus(server, s);
      },
      onDiagnostics: (p) => this.onDiagnostics(server, p),
      onReady: (caps) => this.onServerReady(server, caps),
      onDown: () => this.onServerDown(server),
      onServerRequest: (method, params) => this.onServerRequest(method, params),
      onShowMessage: (type, message) => {
        if (type === 1) toast.error(`${server}: ${message}`);
        else if (type === 2) toast.warning(`${server}: ${message}`);
      },
    });
    this.clients.set(server, c);
    if (this.running) c.setEnabled(true);
    else useLspStore.getState().setStatus(server, { state: "idle", message: null, busy: false });
    return c;
  }

  client(server: string) {
    return this.clients.get(server) ?? null;
  }

  retry(server: string) {
    this.clients.get(server)?.retry();
  }

  private onServerReady(server: string, caps: ServerCapabilities) {
    if (this.disposed) return;
    this.providerRegs.get(server)?.forEach((d) => d.dispose());
    this.providerRegs.set(server, registerProviders(this, server, caps));
    disableBuiltins(server);
  }

  private onServerDown(server: string) {
    this.providerRegs.get(server)?.forEach((d) => d.dispose());
    this.providerRegs.delete(server);
    // The next process republishes; stale markers would point at old text.
    for (const d of Object.values(useLspStore.getState().diagnostics)) {
      if (d.server === server) this.clearMarkers(d.uri, server);
    }
    useLspStore.getState().clearServerDiagnostics(server);
  }

  // ---- documents ---------------------------------------------------------

  /**
   * Called by CodeEditor once the model holds the file's real content (after
   * the collab binding or the REST load). Returns a disposable for unmount.
   */
  attach(editor: monaco.editor.ICodeEditor, model: monaco.editor.ITextModel, path: string): monaco.IDisposable {
    const route = serverForPath(path);
    if (!route || this.disposed) {
      this.consumeReveal(editor, path);
      return { dispose() {} };
    }
    const uri = normalizeUri(model.uri.toString());
    this.preloaded.delete(uri);
    const client = this.ensureClient(route.server);

    let doc = this.docs.get(uri);
    if (doc && doc.model && doc.model !== model) this.detachModel(doc);
    if (!doc) {
      doc = {
        uri,
        path,
        server: route.server,
        languageId: route.languageId,
        model: null,
        editor: null,
        subs: [],
        snapshot: model.getValue(),
      };
      this.docs.set(uri, doc);
    }
    const d = doc;
    d.model = model;
    d.editor = editor;
    const textOf = () => (d.model && !d.model.isDisposed() ? d.model.getValue() : d.snapshot);
    if (!client.hasDocument(uri)) client.openDocument(uri, route.languageId, textOf);
    else {
      client.setTextSource(uri, textOf);
      // Collaborators may have edited while the tab wasn't mounted.
      if (model.getValue() !== d.snapshot) client.changeDocument(uri, null);
    }

    d.subs.push(
      model.onDidChangeContent((e) => {
        // Local typing and remote edits arriving through Yjs both land here.
        const changes: ContentChange[] = e.changes.map((c) => ({
          range: toLspRange(c.range),
          rangeLength: c.rangeLength,
          text: c.text,
        }));
        client.changeDocument(uri, changes);
      }),
      model.onWillDispose(() => this.detachModel(d)),
    );
    this.applyMarkers(uri);
    this.consumeReveal(editor, path);
    return { dispose: () => this.detachModel(d, model) };
  }

  private detachModel(d: DocEntry, only?: monaco.editor.ITextModel) {
    if (!d.model || (only && d.model !== only)) return;
    if (!d.model.isDisposed()) d.snapshot = d.model.getValue();
    d.subs.forEach((s) => s.dispose());
    d.subs = [];
    d.model = null;
    d.editor = null;
  }

  /** Close documents whose tab was closed (didClose, clear their problems). */
  syncOpenTabs(paths: string[]) {
    this.openTabs = new Set(paths);
    for (const d of [...this.docs.values()]) {
      if (this.openTabs.has(d.path)) continue;
      this.detachModel(d);
      this.docs.delete(d.uri);
      this.clients.get(d.server)?.closeDocument(d.uri);
      this.clearMarkers(d.uri, d.server);
      useLspStore.getState().clearDiagnostics(d.uri);
    }
  }

  didSave(path: string) {
    const uri = pathToUri(path);
    const d = this.docs.get(uri);
    if (d) this.clients.get(d.server)?.saveDocument(uri);
  }

  /** The ready client serving this model, if the model is an open document. */
  clientForModel(model: monaco.editor.ITextModel, server: string): { client: LspClient; uri: string } | null {
    const uri = normalizeUri(model.uri.toString());
    const d = this.docs.get(uri);
    if (!d || d.server !== server) return null;
    const client = this.clients.get(server);
    if (!client?.isReady || !client.hasDocument(uri)) return null;
    return { client, uri };
  }

  /** LSP diagnostics for a model, to send back as code-action context. */
  diagnosticsFor(uri: string) {
    return useLspStore.getState().diagnostics[uri]?.items ?? [];
  }

  // ---- diagnostics -------------------------------------------------------

  private onDiagnostics(server: string, p: PublishDiagnosticsParams) {
    if (this.disposed) return;
    const uri = normalizeUri(p.uri);
    const path = uriToPath(uri);
    if (!path) return;
    useLspStore.getState().setDiagnostics({ uri, path, server, items: p.diagnostics ?? [] });
    this.applyMarkers(uri);
  }

  /** Push the stored diagnostics for `uri` onto its model, if one exists. */
  applyMarkers(uri: string) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model) return;
    const d = useLspStore.getState().diagnostics[uri];
    const server = d?.server ?? this.docs.get(uri)?.server;
    if (!server) return;
    monaco.editor.setModelMarkers(model, markerOwner(server), (d?.items ?? []).map(toMarker));
  }

  private clearMarkers(uri: string, server: string) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, markerOwner(server), []);
  }

  // ---- navigation --------------------------------------------------------

  /**
   * Open `uri` in an editor tab and select `range`. Returns false for
   * locations outside the repl (e.g. typeshed stubs) so callers can say so.
   */
  reveal(uri: string, range: monaco.IRange): boolean {
    const path = uriToPath(uri);
    if (!path) return false;
    const live = this.docs.get(normalizeUri(uri));
    const ws = useWorkspace.getState();
    if (live?.editor && live.model && !live.model.isDisposed() && ws.activePath === path) {
      revealIn(live.editor, range);
      return true;
    }
    this.pendingReveal = { path, range };
    ws.openFile(path);
    return true;
  }

  private consumeReveal(editor: monaco.editor.ICodeEditor, path: string) {
    const r = this.pendingReveal;
    if (!r || r.path !== path) return;
    this.pendingReveal = null;
    revealIn(editor, r.range);
  }

  /**
   * Make sure Monaco has models for these repl files so peek views can show
   * them. Files are read through the REST API (disk is kept in sync by collab).
   */
  async ensureModels(uris: string[]) {
    const todo = [...new Set(uris.map(normalizeUri))].filter(
      (u) => uriToPath(u) !== null && !monaco.editor.getModel(monaco.Uri.parse(u)),
    );
    await Promise.all(
      todo.slice(0, 20).map(async (u) => {
        const path = uriToPath(u)!;
        try {
          const f = await replsApi.readFile(this.replId, path);
          if (f.encoding !== "utf-8" || this.disposed) return;
          const muri = monaco.Uri.parse(u);
          if (monaco.editor.getModel(muri)) return;
          const m = monaco.editor.createModel(f.content, languageForPath(path), muri);
          this.preloaded.set(u, m);
          m.onWillDispose(() => {
            if (this.preloaded.get(u) === m) this.preloaded.delete(u);
          });
          this.applyMarkers(u);
        } catch {
          /* the location still works for navigation */
        }
      }),
    );
    // Bound memory: drop the oldest preloaded models no editor is using.
    while (this.preloaded.size > MAX_PRELOADED) {
      const [k, m] = this.preloaded.entries().next().value as [string, monaco.editor.ITextModel];
      this.preloaded.delete(k);
      if (!m.isDisposed()) m.dispose();
    }
  }

  // ---- workspace edits ---------------------------------------------------

  /**
   * Apply an LSP WorkspaceEdit: open (mounted) files are edited through their
   * Monaco model, so the edit flows through Yjs/REST like typing; other files
   * are read, edited and written back through the files API (the backend then
   * reloads any collab rooms for them).
   */
  async applyWorkspaceEdit(edit: WorkspaceEdit, label = "Edit"): Promise<boolean> {
    type Op =
      | { kind: "text"; uri: string; edits: TextEdit[] }
      | { kind: "create"; uri: string; options?: { overwrite?: boolean; ignoreIfExists?: boolean } }
      | { kind: "rename"; oldUri: string; newUri: string }
      | { kind: "delete"; uri: string };
    const ops: Op[] = [];
    if (edit.documentChanges) {
      for (const dc of edit.documentChanges) {
        if ("kind" in dc) ops.push(dc as Op);
        else ops.push({ kind: "text", uri: dc.textDocument.uri, edits: dc.edits });
      }
    } else if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) ops.push({ kind: "text", uri, edits });
    }
    // documentChanges apply in order, each relative to the result of the previous ones.
    let touchedTree = false;
    for (const op of ops) {
      try {
        if (op.kind === "text") {
          if (op.edits.length) await this.editFile(op.uri, op.edits);
        } else if (op.kind === "create") {
          const p = mustPath(op.uri);
          try {
            await replsApi.createFile(this.replId, p, "file");
          } catch (e) {
            if (!op.options?.ignoreIfExists && !op.options?.overwrite) throw e;
          }
          touchedTree = true;
        } else if (op.kind === "rename") {
          const from = mustPath(op.oldUri);
          const to = mustPath(op.newUri);
          await replsApi.rename(this.replId, from, to);
          useWorkspace.getState().onPathRenamed(from, to);
          touchedTree = true;
        } else if (op.kind === "delete") {
          const p = mustPath(op.uri);
          await replsApi.deleteFile(this.replId, p);
          useWorkspace.getState().onPathDeleted(p);
          touchedTree = true;
        }
      } catch (e) {
        toast.error(`${label} failed: ${errorMessage(e)}`);
        if (touchedTree) void useWorkspace.getState().loadFiles();
        return false;
      }
    }
    if (touchedTree) void useWorkspace.getState().loadFiles();
    return true;
  }

  /** True if the file is shown by a mounted editor (edits go through its model). */
  liveModel(uri: string): monaco.editor.ITextModel | null {
    const d = this.docs.get(normalizeUri(uri));
    return d?.editor && d.model && !d.model.isDisposed() ? d.model : null;
  }

  private async editFile(uri: string, edits: TextEdit[]) {
    const norm = normalizeUri(uri);
    const path = mustPath(norm);
    const live = this.liveModel(norm);
    if (live) {
      const ed = this.docs.get(norm)!.editor!;
      ed.pushUndoStop();
      live.pushEditOperations(
        [],
        edits.map((e) => ({ range: toRange(e.range), text: e.newText, forceMoveMarkers: true })),
        () => null,
      );
      ed.pushUndoStop();
      return;
    }
    const f = await replsApi.readFile(this.replId, path);
    if (f.encoding !== "utf-8") throw new Error(`${path} is not a text file`);
    const next = applyTextEdits(f.content, edits);
    await replsApi.writeFile(this.replId, path, next);
    const pre = monaco.editor.getModel(monaco.Uri.parse(norm));
    if (pre && !pre.isDisposed() && pre.getValue() !== next) pre.setValue(next);
    const d = this.docs.get(norm);
    if (d && !d.model) {
      d.snapshot = next;
      this.clients.get(d.server)?.changeDocument(norm, null);
    }
  }

  // ---- server -> client requests ----------------------------------------

  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "workspace/applyEdit": {
        const p = params as { label?: string; edit: WorkspaceEdit };
        const applied = await this.applyWorkspaceEdit(p.edit, p.label ?? "Edit");
        return { applied };
      }
      case "window/showDocument": {
        const p = params as { uri: string; external?: boolean; selection?: Range };
        if (p.external || !p.uri.startsWith("file:")) {
          window.open(p.uri, "_blank", "noopener");
          return { success: true };
        }
        const r = p.selection ? toRange(p.selection) : new monaco.Range(1, 1, 1, 1);
        return { success: this.reveal(p.uri, r) };
      }
      default:
        return undefined;
    }
  }

  /** Run a code action chosen from the lightbulb / quick-fix menu. */
  async applyCodeAction(server: string, action: CodeAction) {
    const client = this.clients.get(server);
    if (!client?.isReady) return;
    let a = action;
    const cap = client.capabilities.codeActionProvider;
    if (!a.edit && !a.command && typeof cap === "object" && cap.resolveProvider) {
      try {
        a = (await client.request<CodeAction>("codeAction/resolve", a)) ?? a;
      } catch (e) {
        toast.error(`${a.title} failed: ${errorMessage(e)}`);
        return;
      }
    }
    if (a.edit && !(await this.applyWorkspaceEdit(a.edit, a.title))) return;
    if (a.command) await this.executeCommand(server, a.command);
  }

  async executeCommand(server: string, cmd: Command) {
    const client = this.clients.get(server);
    if (!client?.isReady) return;
    try {
      await client.request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments });
    } catch (e) {
      toast.error(`${cmd.title || cmd.command} failed: ${errorMessage(e)}`);
    }
  }
}

function mustPath(uri: string): string {
  const p = uriToPath(uri);
  if (!p) throw new Error(`${uri} is outside the repl`);
  return p;
}

function revealIn(editor: monaco.editor.ICodeEditor, range: monaco.IRange) {
  const r = monaco.Range.lift(range);
  editor.setSelection(r.isEmpty() ? monaco.Range.fromPositions(r.getStartPosition()) : r);
  editor.revealRangeInCenterIfOutsideViewport(r, monaco.editor.ScrollType.Smooth);
  editor.focus();
}

// ---- Monaco's built-in language services --------------------------------

const ALL_OFF = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  documentFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
  colors: false,
  foldingRanges: false,
  selectionRanges: false,
  tokens: false,
  linkedEditingRanges: false,
  links: false,
};
const disabledBuiltins = new Set<string>();

/**
 * Once a real language server is connected, Monaco's bundled services for the
 * same language would only produce duplicates. Keep them when the server is missing.
 */
function disableBuiltins(server: string) {
  if (disabledBuiltins.has(server)) return;
  disabledBuiltins.add(server);
  const m = monaco as unknown as Record<string, Record<string, LanguageDefaults> | undefined>;
  const off = ALL_OFF as never;
  try {
    if (server === "typescript" && m.typescript) {
      for (const d of [m.typescript.typescriptDefaults, m.typescript.javascriptDefaults]) {
        d?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
        d?.setModeConfiguration?.(off);
      }
    } else if (server === "json" && m.json) {
      m.json.jsonDefaults?.setDiagnosticsOptions?.({ validate: false });
      m.json.jsonDefaults?.setModeConfiguration?.(off);
    } else if (server === "css" && m.css) {
      for (const d of [m.css.cssDefaults, m.css.scssDefaults, m.css.lessDefaults]) {
        d?.setOptions?.({ validate: false });
        d?.setModeConfiguration?.(off);
      }
    } else if (server === "html" && m.html) {
      m.html.htmlDefaults?.setModeConfiguration?.(off);
    }
  } catch (e) {
    console.warn("lsp: could not disable built-in language service", server, e);
  }
}

interface LanguageDefaults {
  setDiagnosticsOptions?: (o: object) => void;
  setModeConfiguration?: (o: never) => void;
  setOptions?: (o: object) => void;
}

// ---- process-wide wiring ------------------------------------------------

let activeManager: LspManager | null = null;
export const getActiveManager = () => activeManager;
export function setActiveManager(m: LspManager | null) {
  activeManager = m;
  useLspStore.getState().setManager(m);
  // Handy for poking at the client from devtools / browser tests.
  if (import.meta.env.DEV) (window as unknown as { __replLsp?: LspManager | null }).__replLsp = m;
}

let wired = false;
/** Global Monaco hooks; safe to call more than once. */
export function wireMonaco() {
  if (wired) return;
  wired = true;
  // Markers for models created after the diagnostics arrived (tab re-mounted, peek models).
  monaco.editor.onDidCreateModel((model) => {
    const uri = normalizeUri(model.uri.toString());
    if (useLspStore.getState().diagnostics[uri]) activeManager?.applyMarkers(uri);
  });
  // Go to definition in another repl file: open it in a tab and jump there.
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const m = activeManager;
      if (!m) return false;
      if (source.getModel()?.uri.toString() === resource.toString()) return false;
      let range: monaco.IRange = new monaco.Range(1, 1, 1, 1);
      if (selectionOrPosition && "startLineNumber" in selectionOrPosition) range = selectionOrPosition;
      else if (selectionOrPosition) range = monaco.Range.fromPositions(selectionOrPosition);
      return m.reveal(resource.toString(), range);
    },
  });
  monaco.editor.registerCommand("lsp.executeCommand", (_accessor, server: string, cmd: Command) => {
    void activeManager?.executeCommand(server, cmd);
  });
  monaco.editor.registerCommand("lsp.applyCodeAction", (_accessor, server: string, action: CodeAction) => {
    void activeManager?.applyCodeAction(server, action);
  });
}
