import * as monaco from "monaco-editor";
import { toast } from "sonner";
import { languageForPath } from "@/lib/languages";
import { isCancelled } from "./jsonrpc";
import {
  hoverContents,
  toCompletionKind,
  toDocumentation,
  toLocationLinks,
  toLspRange,
  toPosition,
  toRange,
  toTextEdit,
} from "./convert";
import type { LspManager } from "./manager";
import type {
  CodeAction,
  Command,
  CompletionItem,
  CompletionList,
  Diagnostic,
  DocumentHighlight,
  Hover,
  Location,
  LocationLink,
  Range,
  ServerCapabilities,
  SignatureHelp,
  TextEdit,
  WorkspaceEdit,
} from "./protocol";
import { serverExtensions, uriToPath } from "./servers";

const LSP_ITEM = Symbol("lspItem");
type TaggedItem = monaco.languages.CompletionItem & { [LSP_ITEM]?: CompletionItem };

/** Monaco language selector for a server: its languages, narrowed by extension when shared. */
function selectorFor(server: string): monaco.languages.LanguageSelector {
  const byLang = new Map<string, string[]>();
  for (const ext of serverExtensions(server)) {
    const lang = languageForPath(`x.${ext}`);
    if (lang === "plaintext") continue;
    byLang.set(lang, [...(byLang.get(lang) ?? []), ext]);
  }
  const sel: monaco.languages.LanguageFilter[] = [];
  for (const [language, exts] of byLang) {
    // "html" is shared by .html (html server) and .vue (vue server).
    if (language === "html") sel.push({ language, pattern: `**/*.{${exts.join(",")}}` });
    else sel.push({ language });
  }
  return sel;
}

const swallow = <T>(e: unknown): T | null => {
  if (!isCancelled(e)) console.debug("lsp request failed", e);
  return null;
};

function toMonacoCommand(server: string, cmd: Command | undefined): monaco.languages.Command | undefined {
  if (!cmd) return undefined;
  // Commands Monaco itself knows (servers use these to re-trigger suggest / parameter hints).
  if (cmd.command.startsWith("editor.action.")) return { id: cmd.command, title: cmd.title, arguments: cmd.arguments };
  return { id: "lsp.executeCommand", title: cmd.title, arguments: [server, cmd] };
}

/**
 * Workspace locations only: files outside the repl (stdlib, typeshed stubs)
 * can't be loaded into the browser. No toast here, because Monaco also asks
 * for definitions on Ctrl+hover.
 */
async function workspaceLinks(mgr: LspManager, links: LocationLink[]): Promise<monaco.languages.LocationLink[]> {
  const inside = links.filter((l) => uriToPath(l.targetUri) !== null);
  await mgr.ensureModels(inside.map((l) => l.targetUri));
  return inside.map((l) => ({
    uri: monaco.Uri.parse(l.targetUri),
    range: toRange(l.targetRange),
    targetSelectionRange: toRange(l.targetSelectionRange),
    originSelectionRange: l.originSelectionRange ? toRange(l.originSelectionRange) : undefined,
  }));
}

export function registerProviders(mgr: LspManager, server: string, caps: ServerCapabilities): monaco.IDisposable[] {
  const sel = selectorFor(server);
  const regs: monaco.IDisposable[] = [];
  const route = (model: monaco.editor.ITextModel) => mgr.clientForModel(model, server);
  const doc = (uri: string) => ({ textDocument: { uri } });

  // ---- completion ----
  if (caps.completionProvider) {
    const cp = caps.completionProvider;
    regs.push(
      monaco.languages.registerCompletionItemProvider(sel, {
        triggerCharacters: cp.triggerCharacters ?? [],
        async provideCompletionItems(model, position, context, token) {
          const r = route(model);
          if (!r) return undefined;
          const triggerKind = context.triggerKind === 0 ? 1 : context.triggerKind === 1 ? 2 : 3;
          const res = await r.client
            .request<CompletionItem[] | CompletionList | null>(
              "textDocument/completion",
              {
                ...doc(r.uri),
                position: toPosition(position),
                context: { triggerKind, triggerCharacter: triggerKind === 2 ? context.triggerCharacter : undefined },
              },
              token,
            )
            .catch(swallow<null>);
          if (!res) return undefined;
          const list: CompletionList = Array.isArray(res) ? { isIncomplete: false, items: res } : res;
          const defaults = list.itemDefaults;
          const word = model.getWordUntilPosition(position);
          const wordAt = model.getWordAtPosition(position);
          const line = position.lineNumber;
          const defaultRange = {
            insert: new monaco.Range(line, word.startColumn, line, position.column),
            replace: new monaco.Range(line, word.startColumn, line, Math.max(wordAt?.endColumn ?? position.column, position.column)),
          };
          const suggestions = list.items.map((item): TaggedItem => {
            const format = item.insertTextFormat ?? defaults?.insertTextFormat;
            let range: monaco.IRange | monaco.languages.CompletionItemRanges = defaultRange;
            let text: string;
            if (item.textEdit) {
              const te = item.textEdit;
              if ("range" in te) range = toRange(te.range);
              else range = { insert: toRange(te.insert), replace: toRange(te.replace) };
              text = te.newText;
            } else {
              const er = defaults?.editRange;
              if (er) range = "insert" in er ? { insert: toRange(er.insert), replace: toRange(er.replace) } : toRange(er);
              text = item.textEditText ?? item.insertText ?? item.label;
            }
            if (item.data === undefined && defaults?.data !== undefined) item.data = defaults.data;
            let rules = 0;
            if (format === 2) rules |= monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
            if ((item.insertTextMode ?? defaults?.insertTextMode) === 1)
              rules |= monaco.languages.CompletionItemInsertTextRule.KeepWhitespace;
            const deprecated = item.deprecated || item.tags?.includes(1);
            return {
              label: item.labelDetails
                ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description }
                : item.label,
              kind: toCompletionKind(item.kind),
              tags: deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
              detail: item.detail,
              documentation: toDocumentation(item.documentation),
              sortText: item.sortText,
              filterText: item.filterText,
              preselect: item.preselect,
              insertText: text,
              insertTextRules: rules || undefined,
              range,
              commitCharacters: item.commitCharacters ?? defaults?.commitCharacters,
              additionalTextEdits: item.additionalTextEdits?.map(toTextEdit),
              command: toMonacoCommand(server, item.command),
              [LSP_ITEM]: item,
            };
          });
          return { suggestions, incomplete: list.isIncomplete };
        },
        resolveCompletionItem: cp.resolveProvider
          ? async (item: TaggedItem, token) => {
              const orig = item[LSP_ITEM];
              const client = mgr.client(server);
              if (!orig || !client?.isReady) return item;
              const res = await client.request<CompletionItem>("completionItem/resolve", orig, token).catch(swallow<CompletionItem>);
              if (!res) return item;
              return {
                ...item,
                detail: res.detail ?? item.detail,
                documentation: toDocumentation(res.documentation) ?? item.documentation,
                additionalTextEdits: res.additionalTextEdits?.map(toTextEdit) ?? item.additionalTextEdits,
                command: item.command ?? toMonacoCommand(server, res.command),
              };
            }
          : undefined,
      }),
    );
  }

  // ---- hover ----
  if (caps.hoverProvider) {
    regs.push(
      monaco.languages.registerHoverProvider(sel, {
        async provideHover(model, position, token) {
          const r = route(model);
          if (!r) return undefined;
          const h = await r.client
            .request<Hover | null>("textDocument/hover", { ...doc(r.uri), position: toPosition(position) }, token)
            .catch(swallow<null>);
          if (!h) return undefined;
          const contents = hoverContents(h);
          if (!contents.length) return undefined;
          return { contents, range: h.range ? toRange(h.range) : undefined };
        },
      }),
    );
  }

  // ---- signature help ----
  if (caps.signatureHelpProvider) {
    const sp = caps.signatureHelpProvider;
    regs.push(
      monaco.languages.registerSignatureHelpProvider(sel, {
        signatureHelpTriggerCharacters: sp.triggerCharacters ?? ["(", ","],
        signatureHelpRetriggerCharacters: sp.retriggerCharacters ?? [],
        async provideSignatureHelp(model, position, token, context) {
          const r = route(model);
          if (!r) return undefined;
          const active = context.activeSignatureHelp;
          const res = await r.client
            .request<SignatureHelp | null>(
              "textDocument/signatureHelp",
              {
                ...doc(r.uri),
                position: toPosition(position),
                context: {
                  triggerKind: context.triggerKind,
                  triggerCharacter: context.triggerCharacter,
                  isRetrigger: context.isRetrigger,
                  activeSignatureHelp: active
                    ? {
                        signatures: active.signatures.map((s) => ({
                          label: s.label,
                          parameters: s.parameters.map((p) => ({ label: p.label })),
                          activeParameter: s.activeParameter,
                        })),
                        activeSignature: active.activeSignature,
                        activeParameter: active.activeParameter,
                      }
                    : undefined,
                },
              },
              token,
            )
            .catch(swallow<null>);
          if (!res || !res.signatures?.length) return undefined;
          return {
            value: {
              signatures: res.signatures.map((s) => ({
                label: s.label,
                documentation: toDocumentation(s.documentation),
                parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: toDocumentation(p.documentation) })),
                activeParameter: s.activeParameter,
              })),
              activeSignature: Math.min(res.activeSignature ?? 0, res.signatures.length - 1),
              activeParameter: res.activeParameter ?? 0,
            },
            dispose() {},
          };
        },
      }),
    );
  }

  // ---- definition / declaration / type definition / implementation ----
  const locationRequest = (method: string) => async (
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ) => {
    const r = route(model);
    if (!r) return undefined;
    const res = await r.client
      .request<Location | Location[] | LocationLink[] | null>(method, { ...doc(r.uri), position: toPosition(position) }, token)
      .catch(swallow<null>);
    return workspaceLinks(mgr, toLocationLinks(res));
  };
  if (caps.definitionProvider)
    regs.push(monaco.languages.registerDefinitionProvider(sel, { provideDefinition: locationRequest("textDocument/definition") }));
  if (caps.declarationProvider)
    regs.push(monaco.languages.registerDeclarationProvider(sel, { provideDeclaration: locationRequest("textDocument/declaration") }));
  if (caps.typeDefinitionProvider)
    regs.push(
      monaco.languages.registerTypeDefinitionProvider(sel, { provideTypeDefinition: locationRequest("textDocument/typeDefinition") }),
    );
  if (caps.implementationProvider)
    regs.push(
      monaco.languages.registerImplementationProvider(sel, { provideImplementation: locationRequest("textDocument/implementation") }),
    );

  // ---- references ----
  if (caps.referencesProvider) {
    regs.push(
      monaco.languages.registerReferenceProvider(sel, {
        async provideReferences(model, position, context, token) {
          const r = route(model);
          if (!r) return undefined;
          const res = await r.client
            .request<Location[] | null>(
              "textDocument/references",
              { ...doc(r.uri), position: toPosition(position), context: { includeDeclaration: context.includeDeclaration } },
              token,
            )
            .catch(swallow<null>);
          const links = await workspaceLinks(mgr, toLocationLinks(res));
          return links.map((l) => ({ uri: l.uri, range: l.range }));
        },
      }),
    );
  }

  // ---- document highlight ----
  if (caps.documentHighlightProvider) {
    regs.push(
      monaco.languages.registerDocumentHighlightProvider(sel, {
        async provideDocumentHighlights(model, position, token) {
          const r = route(model);
          if (!r) return undefined;
          const res = await r.client
            .request<DocumentHighlight[] | null>("textDocument/documentHighlight", { ...doc(r.uri), position: toPosition(position) }, token)
            .catch(swallow<null>);
          return (res ?? []).map((h) => ({
            range: toRange(h.range),
            kind:
              h.kind === 2
                ? monaco.languages.DocumentHighlightKind.Read
                : h.kind === 3
                  ? monaco.languages.DocumentHighlightKind.Write
                  : monaco.languages.DocumentHighlightKind.Text,
          }));
        },
      }),
    );
  }

  // ---- rename ----
  if (caps.renameProvider) {
    const prepare = typeof caps.renameProvider === "object" && caps.renameProvider.prepareProvider;
    regs.push(
      monaco.languages.registerRenameProvider(sel, {
        async provideRenameEdits(model, position, newName, token) {
          const r = route(model);
          if (!r) return undefined;
          let res: WorkspaceEdit | null;
          try {
            res = await r.client.request<WorkspaceEdit | null>(
              "textDocument/rename",
              { ...doc(r.uri), position: toPosition(position), newName },
              token,
            );
          } catch (e) {
            if (isCancelled(e)) return undefined;
            return { edits: [], rejectReason: e instanceof Error ? e.message : String(e) };
          }
          if (!res) return { edits: [], rejectReason: "Nothing to rename here." };
          return splitRename(mgr, res);
        },
        resolveRenameLocation: prepare
          ? async (model, position, token) => {
              const r = route(model);
              const word = model.getWordAtPosition(position);
              const wordRange = word
                ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
                : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
              if (!r) return { range: wordRange, text: word?.word ?? "" };
              let res: Range | { range: Range; placeholder: string } | { defaultBehavior: boolean } | null;
              try {
                res = await r.client.request("textDocument/prepareRename", { ...doc(r.uri), position: toPosition(position) }, token);
              } catch (e) {
                return { range: wordRange, text: "", rejectReason: e instanceof Error ? e.message : "Cannot rename here." };
              }
              if (!res) return { range: wordRange, text: "", rejectReason: "You cannot rename this element." };
              if ("defaultBehavior" in res) return { range: wordRange, text: word?.word ?? "" };
              if ("placeholder" in res) return { range: toRange(res.range), text: res.placeholder };
              const range = toRange(res);
              return { range, text: model.getValueInRange(range) };
            }
          : undefined,
      }),
    );
  }

  // ---- formatting ----
  const fmtOptions = (o: monaco.languages.FormattingOptions) => ({
    tabSize: o.tabSize,
    insertSpaces: o.insertSpaces,
    trimTrailingWhitespace: true,
    insertFinalNewline: true,
    trimFinalNewlines: true,
  });
  if (caps.documentFormattingProvider) {
    regs.push(
      monaco.languages.registerDocumentFormattingEditProvider(sel, {
        displayName: server,
        async provideDocumentFormattingEdits(model, options, token) {
          const r = route(model);
          if (!r) return undefined;
          const res = await r.client
            .request<TextEdit[] | null>("textDocument/formatting", { ...doc(r.uri), options: fmtOptions(options) }, token)
            .catch(swallow<null>);
          return (res ?? []).map(toTextEdit);
        },
      }),
    );
  }
  if (caps.documentRangeFormattingProvider) {
    regs.push(
      monaco.languages.registerDocumentRangeFormattingEditProvider(sel, {
        displayName: server,
        async provideDocumentRangeFormattingEdits(model, range, options, token) {
          const r = route(model);
          if (!r) return undefined;
          const res = await r.client
            .request<TextEdit[] | null>(
              "textDocument/rangeFormatting",
              { ...doc(r.uri), range: toLspRange(range), options: fmtOptions(options) },
              token,
            )
            .catch(swallow<null>);
          return (res ?? []).map(toTextEdit);
        },
      }),
    );
  }
  if (caps.documentOnTypeFormattingProvider) {
    const otf = caps.documentOnTypeFormattingProvider;
    regs.push(
      monaco.languages.registerOnTypeFormattingEditProvider(sel, {
        autoFormatTriggerCharacters: [otf.firstTriggerCharacter, ...(otf.moreTriggerCharacter ?? [])],
        async provideOnTypeFormattingEdits(model, position, ch, options, token) {
          const r = route(model);
          if (!r) return undefined;
          const res = await r.client
            .request<TextEdit[] | null>(
              "textDocument/onTypeFormatting",
              { ...doc(r.uri), position: toPosition(position), ch, options: fmtOptions(options) },
              token,
            )
            .catch(swallow<null>);
          return (res ?? []).map(toTextEdit);
        },
      }),
    );
  }

  // ---- code actions (lightbulb / quick fix) ----
  if (caps.codeActionProvider) {
    const kinds = typeof caps.codeActionProvider === "object" ? caps.codeActionProvider.codeActionKinds : undefined;
    regs.push(
      monaco.languages.registerCodeActionProvider(
        sel,
        {
          async provideCodeActions(model, range, context, token) {
            const r = route(model);
            if (!r) return undefined;
            const diagnostics = matchDiagnostics(mgr.diagnosticsFor(r.uri), context.markers);
            const res = await r.client
              .request<(Command | CodeAction)[] | null>(
                "textDocument/codeAction",
                {
                  ...doc(r.uri),
                  range: toLspRange(range),
                  context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger },
                },
                token,
              )
              .catch(swallow<null>);
            const actions: monaco.languages.CodeAction[] = (res ?? []).map((a) => {
              if (typeof (a as Command).command === "string") {
                const c = a as Command;
                return { title: c.title, command: toMonacoCommand(server, c) };
              }
              const ca = a as CodeAction;
              return {
                title: ca.title,
                kind: ca.kind,
                isPreferred: ca.isPreferred,
                disabled: ca.disabled?.reason,
                diagnostics: ca.diagnostics ? context.markers.filter((m) => ca.diagnostics!.some((d) => sameDiag(d, m))) : undefined,
                // Edits go through our applier so they can reach files without a model.
                command: { id: "lsp.applyCodeAction", title: ca.title, arguments: [server, ca] },
              };
            });
            return { actions, dispose() {} };
          },
        },
        kinds ? { providedCodeActionKinds: kinds } : undefined,
      ),
    );
  }

  return regs;
}

function sameDiag(d: Diagnostic, m: monaco.editor.IMarkerData) {
  return (
    d.message === m.message &&
    d.range.start.line + 1 === m.startLineNumber &&
    d.range.start.character + 1 === m.startColumn
  );
}

/** The LSP diagnostics behind the markers Monaco passes as code-action context. */
function matchDiagnostics(all: Diagnostic[], markers: monaco.editor.IMarkerData[]): Diagnostic[] {
  return all.filter((d) => markers.some((m) => sameDiag(d, m)));
}

/**
 * Rename result: edits to files shown in an editor are returned to Monaco
 * (one undo step); everything else is applied through the files API.
 */
async function splitRename(mgr: LspManager, edit: WorkspaceEdit): Promise<monaco.languages.WorkspaceEdit> {
  const perUri = new Map<string, TextEdit[]>();
  let hasResourceOps = false;
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if ("kind" in dc) hasResourceOps = true;
      else perUri.set(dc.textDocument.uri, [...(perUri.get(dc.textDocument.uri) ?? []), ...dc.edits]);
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) perUri.set(uri, edits);
  }
  if (hasResourceOps) {
    await mgr.applyWorkspaceEdit(edit, "Rename");
    return { edits: [] };
  }
  const live: monaco.languages.IWorkspaceTextEdit[] = [];
  const rest: Record<string, TextEdit[]> = {};
  for (const [uri, edits] of perUri) {
    const model = mgr.liveModel(uri);
    if (model) {
      for (const e of edits) live.push({ resource: model.uri, versionId: model.getVersionId(), textEdit: toTextEdit(e) });
    } else rest[uri] = edits;
  }
  if (Object.keys(rest).length) {
    const ok = await mgr.applyWorkspaceEdit({ changes: rest }, "Rename");
    if (!ok) toast.error("Rename could not update every file.");
  }
  return { edits: live };
}
