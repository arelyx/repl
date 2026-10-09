import * as monaco from "monaco-editor";
import type {
  Diagnostic,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  Position,
  Range,
  TextEdit,
} from "./protocol";

export const toPosition = (p: monaco.IPosition): Position => ({ line: p.lineNumber - 1, character: p.column - 1 });

export const toLspRange = (r: monaco.IRange): Range => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});

export const toRange = (r: Range): monaco.Range =>
  new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);

export const toTextEdit = (e: TextEdit): monaco.languages.TextEdit => ({ range: toRange(e.range), text: e.newText });

function escapeMarkdown(text: string) {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&").replace(/\n/g, "\n\n");
}

export function toMarkdown(doc: string | MarkupContent | undefined | null): monaco.IMarkdownString | undefined {
  if (doc === undefined || doc === null) return undefined;
  if (typeof doc === "string") return doc ? { value: escapeMarkdown(doc) } : undefined;
  if (!doc.value) return undefined;
  return doc.kind === "markdown" ? { value: doc.value, supportThemeIcons: false } : { value: escapeMarkdown(doc.value) };
}

/** Completion/signature docs: plain strings become plain text, markup keeps its kind. */
export function toDocumentation(doc: string | MarkupContent | undefined): string | monaco.IMarkdownString | undefined {
  if (doc === undefined || doc === null) return undefined;
  if (typeof doc === "string") return doc || undefined;
  if (!doc.value) return undefined;
  return doc.kind === "markdown" ? { value: doc.value } : doc.value;
}

function markedToMarkdown(m: MarkedString): monaco.IMarkdownString {
  if (typeof m === "string") return { value: m };
  return { value: "```" + (m.language || "") + "\n" + m.value + "\n```" };
}

export function hoverContents(h: Hover): monaco.IMarkdownString[] {
  const c = h.contents;
  if (Array.isArray(c)) return c.map(markedToMarkdown).filter((m) => m.value.trim());
  if (typeof c === "object" && c && "kind" in c) {
    const md = toMarkdown(c as MarkupContent);
    return md ? [md] : [];
  }
  const md = markedToMarkdown(c as MarkedString);
  return md.value.trim() ? [md] : [];
}

const K = monaco.languages.CompletionItemKind;
const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  1: K.Text,
  2: K.Method,
  3: K.Function,
  4: K.Constructor,
  5: K.Field,
  6: K.Variable,
  7: K.Class,
  8: K.Interface,
  9: K.Module,
  10: K.Property,
  11: K.Unit,
  12: K.Value,
  13: K.Enum,
  14: K.Keyword,
  15: K.Snippet,
  16: K.Color,
  17: K.File,
  18: K.Reference,
  19: K.Folder,
  20: K.EnumMember,
  21: K.Constant,
  22: K.Struct,
  23: K.Event,
  24: K.Operator,
  25: K.TypeParameter,
};
export const toCompletionKind = (k: number | undefined) => (k && COMPLETION_KIND[k]) ?? K.Text;

const S = monaco.MarkerSeverity;
export const toSeverity = (s: Diagnostic["severity"]) =>
  s === 2 ? S.Warning : s === 3 ? S.Info : s === 4 ? S.Hint : S.Error;

export function toMarker(d: Diagnostic): monaco.editor.IMarkerData {
  const r = toRange(d.range);
  let code: monaco.editor.IMarkerData["code"];
  if (d.code !== undefined && d.code !== null) {
    code = d.codeDescription?.href
      ? { value: String(d.code), target: monaco.Uri.parse(d.codeDescription.href) }
      : String(d.code);
  }
  const tags: monaco.MarkerTag[] = [];
  if (d.tags?.includes(1)) tags.push(monaco.MarkerTag.Unnecessary);
  if (d.tags?.includes(2)) tags.push(monaco.MarkerTag.Deprecated);
  return {
    severity: toSeverity(d.severity),
    message: d.message,
    source: d.source,
    code,
    startLineNumber: r.startLineNumber,
    startColumn: r.startColumn,
    endLineNumber: r.endLineNumber,
    // Zero-width ranges would render no squiggle; Monaco widens them to the word.
    endColumn: r.endColumn,
    tags: tags.length ? tags : undefined,
    relatedInformation: d.relatedInformation?.map((ri) => {
      const rr = toRange(ri.location.range);
      return {
        resource: monaco.Uri.parse(ri.location.uri),
        message: ri.message,
        startLineNumber: rr.startLineNumber,
        startColumn: rr.startColumn,
        endLineNumber: rr.endLineNumber,
        endColumn: rr.endColumn,
      };
    }),
  };
}

/** Location | Location[] | LocationLink[] | null -> a flat list of LocationLinks. */
export function toLocationLinks(res: Location | Location[] | LocationLink[] | null | undefined): LocationLink[] {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  return arr.map((l) =>
    "targetUri" in l
      ? l
      : { targetUri: l.uri, targetRange: l.range, targetSelectionRange: l.range },
  );
}

/** Position -> offset in a plain string (for editing files that have no model). */
export function offsetAt(text: string, lineStarts: number[], p: Position): number {
  if (p.line >= lineStarts.length) return text.length;
  const start = lineStarts[p.line]!;
  const end = p.line + 1 < lineStarts.length ? lineStarts[p.line + 1]! : text.length;
  return Math.min(start + p.character, end);
}

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (c === 10) starts.push(i + 1);
  }
  return starts;
}

/** Apply LSP text edits to a string (edits must not overlap, per the spec). */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const starts = lineStartsOf(text);
  const withOffsets = edits
    .map((e, i) => ({ s: offsetAt(text, starts, e.range.start), e: offsetAt(text, starts, e.range.end), t: e.newText, i }))
    .sort((a, b) => b.s - a.s || b.i - a.i);
  let out = text;
  for (const x of withOffsets) out = out.slice(0, x.s) + x.t + out.slice(x.e);
  return out;
}
