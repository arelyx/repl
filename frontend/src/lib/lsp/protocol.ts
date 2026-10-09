/**
 * The subset of Language Server Protocol 3.17 types this client uses.
 * Positions are 0-based and counted in UTF-16 code units, which is what both
 * JavaScript strings and Monaco columns use, so no re-encoding is needed.
 */

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface InsertReplaceEdit {
  newText: string;
  insert: Range;
  replace: Range;
}

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export type MarkedString = string | { language: string; value: string };

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: number | string;
  codeDescription?: { href: string };
  source?: string;
  message: string;
  tags?: (1 | 2)[];
  relatedInformation?: { location: Location; message: string }[];
  data?: unknown;
}

export interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: Diagnostic[];
}

export interface CompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | MarkupContent;
  deprecated?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: 1 | 2;
  insertTextMode?: 1 | 2;
  textEdit?: TextEdit | InsertReplaceEdit;
  textEditText?: string;
  additionalTextEdits?: TextEdit[];
  commitCharacters?: string[];
  command?: Command;
  data?: unknown;
}

export interface CompletionList {
  isIncomplete: boolean;
  itemDefaults?: {
    commitCharacters?: string[];
    editRange?: Range | { insert: Range; replace: Range };
    insertTextFormat?: 1 | 2;
    insertTextMode?: 1 | 2;
    data?: unknown;
  };
  items: CompletionItem[];
}

export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

export interface ParameterInformation {
  label: string | [number, number];
  documentation?: string | MarkupContent;
}

export interface SignatureInformation {
  label: string;
  documentation?: string | MarkupContent;
  parameters?: ParameterInformation[];
  activeParameter?: number;
}

export interface SignatureHelp {
  signatures: SignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

export interface DocumentHighlight {
  range: Range;
  kind?: 1 | 2 | 3;
}

export interface TextDocumentEdit {
  textDocument: { uri: string; version: number | null };
  edits: (TextEdit & { annotationId?: string })[];
}

export interface CreateFile {
  kind: "create";
  uri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}
export interface RenameFile {
  kind: "rename";
  oldUri: string;
  newUri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}
export interface DeleteFile {
  kind: "delete";
  uri: string;
  options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
}

export interface WorkspaceEdit {
  changes?: { [uri: string]: TextEdit[] };
  documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[];
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEdit;
  command?: Command;
  data?: unknown;
}

export interface ProgressParams {
  token: string | number;
  value: {
    kind: "begin" | "report" | "end";
    title?: string;
    message?: string;
    percentage?: number;
    cancellable?: boolean;
  };
}

export type TextDocumentSyncKind = 0 | 1 | 2;

/** Server capabilities, loosely typed: only the fields we read. */
export interface ServerCapabilities {
  positionEncoding?: string;
  textDocumentSync?:
    | TextDocumentSyncKind
    | {
        openClose?: boolean;
        change?: TextDocumentSyncKind;
        save?: boolean | { includeText?: boolean };
      };
  completionProvider?: {
    triggerCharacters?: string[];
    allCommitCharacters?: string[];
    resolveProvider?: boolean;
  };
  hoverProvider?: boolean | object;
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  declarationProvider?: boolean | object;
  definitionProvider?: boolean | object;
  typeDefinitionProvider?: boolean | object;
  implementationProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentHighlightProvider?: boolean | object;
  codeActionProvider?: boolean | { codeActionKinds?: string[]; resolveProvider?: boolean };
  documentFormattingProvider?: boolean | object;
  documentRangeFormattingProvider?: boolean | object;
  documentOnTypeFormattingProvider?: { firstTriggerCharacter: string; moreTriggerCharacter?: string[] };
  renameProvider?: boolean | { prepareProvider?: boolean };
  executeCommandProvider?: { commands: string[] };
  [k: string]: unknown;
}

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  RequestCancelled: -32800,
  ContentModified: -32801,
} as const;
