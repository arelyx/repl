#!/usr/bin/env python3
"""compiler_ls: a small, real language server for languages without a good one.

    compiler_ls.py LANG                       # standalone server
    compiler_ls.py LANG [OPTIONS] -- CMD ...  # proxy in front of a real server

Standalone, it provides for LANG:
  * diagnostics: the language's own compiler/checker runs on a temporary copy
    of the in-memory text on open and save, and ~700 ms after the last edit;
    its `file:line:col: error: ...` style output becomes LSP diagnostics;
  * completion: keywords, standard routines (with signatures and short docs)
    and the identifiers already in the document;
  * hover and signature help for the known routines.

In front of a real server (proxy mode) it passes everything through and adds
only what that server lacks:
  --check            merge LANG's compiler diagnostics into the server's;
  --builtins         merge LANG's curated completions/hover into the server's;
  --pull-diagnostics the server only answers pull diagnostics
                     (textDocument/diagnostic): pull after every change and
                     publish the result, so push-only clients see them;
  --hold-until M     hold client requests until the server sends notification
                     M (e.g. Intelephense's indexingEnded), at most 10 s, so
                     the first completion isn't empty while it indexes;
                     M = $/progress waits for the server's first progress
                     "end" (work-done progress is requested on the client's
                     behalf when the client didn't);
  --filter-completion trim a server's unfiltered completion list (asm-lsp
                     returns every mnemonic, ~3 MB) to the typed prefix.

Python standard library only. Extra word lists generated at image build time
(/opt/lsp/compiler-ls/<lang>.json) are merged in when present.
"""
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

DATA_DIR = os.environ.get("COMPILER_LS_DATA", "/opt/lsp/compiler-ls")
DEBOUNCE = 0.7
CHECK_TIMEOUT = 20

# LSP enums
ERROR, WARNING, INFO, HINT = 1, 2, 3, 4
K_TEXT, K_FUNCTION, K_VARIABLE, K_CLASS, K_MODULE, K_KEYWORD, K_SNIPPET, K_CONSTANT, K_STRUCT = 1, 3, 6, 7, 9, 14, 15, 21, 22
KIND_NAMES = {"function": K_FUNCTION, "procedure": K_FUNCTION, "macro": K_KEYWORD, "special": K_KEYWORD,
              "keyword": K_KEYWORD, "variable": K_VARIABLE, "constant": K_CONSTANT, "type": K_CLASS,
              "class": K_CLASS, "unit": K_MODULE, "module": K_MODULE, "directive": K_KEYWORD,
              "register": K_VARIABLE, "instruction": K_FUNCTION, "struct": K_STRUCT}


def log(*a):
    print("compiler_ls:", *a, file=sys.stderr, flush=True)


# ── JSON-RPC framing ─────────────────────────────────────────────────────────

def read_message(stream):
    """One framed JSON-RPC message from a binary stream; None at EOF."""
    length = None
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            if length is not None:
                break
            continue
        name, _, value = line.decode("ascii", "replace").partition(":")
        if name.lower() == "content-length":
            length = int(value.strip())
    body = b""
    while len(body) < length:
        chunk = stream.read(length - len(body))
        if not chunk:
            return None
        body += chunk
    try:
        return json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return {}


class Writer:
    def __init__(self, stream):
        self.stream = stream
        self.lock = threading.Lock()

    def send(self, obj):
        body = json.dumps(obj, separators=(",", ":")).encode()
        with self.lock:
            try:
                self.stream.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
                self.stream.flush()
            except (BrokenPipeError, ValueError, OSError):
                pass


# ── Documents ────────────────────────────────────────────────────────────────

def uri_to_path(uri):
    from urllib.parse import unquote, urlparse
    return unquote(urlparse(uri).path)


def utf16_to_index(line, units):
    """Python index in `line` of a UTF-16 code-unit offset."""
    if line.isascii():
        return min(units, len(line))
    n = 0
    for i, ch in enumerate(line):
        if n >= units:
            return i
        n += 2 if ord(ch) > 0xFFFF else 1
    return len(line)


def index_to_utf16(line, index):
    if line.isascii():
        return index
    return sum(2 if ord(c) > 0xFFFF else 1 for c in line[:index])


class Document:
    def __init__(self, uri, text, version):
        self.uri = uri
        self.path = uri_to_path(uri)
        self.text = text
        self.version = version

    def lines(self):
        return self.text.split("\n")

    def offset(self, pos):
        lines = self.text.split("\n")
        line = max(0, min(pos["line"], len(lines) - 1)) if lines else 0
        off = sum(len(lines[i]) + 1 for i in range(line))
        return off + utf16_to_index(lines[line], pos["character"])

    def apply(self, changes, version):
        for ch in changes:
            if "range" in ch and ch["range"] is not None:
                start = self.offset(ch["range"]["start"])
                end = self.offset(ch["range"]["end"])
                self.text = self.text[:start] + ch["text"] + self.text[end:]
            else:
                self.text = ch["text"]
        self.version = version

    def line_text(self, line):
        lines = self.lines()
        return lines[line] if 0 <= line < len(lines) else ""


# ── Diagnostic helpers ───────────────────────────────────────────────────────

def make_range(text_lines, line, col=None, end_col=None, word_re=r"[A-Za-z0-9_$.]"):
    """Range for a 0-based (line, col); col None means the whole line's code."""
    line = max(0, min(line, len(text_lines) - 1)) if text_lines else 0
    src = text_lines[line] if text_lines else ""
    if col is None:
        start = len(src) - len(src.lstrip())
        end = len(src.rstrip())
        if end <= start:
            start, end = 0, max(len(src), 1)
    else:
        start = max(0, min(col, len(src)))
        if end_col is not None:
            end = max(start + 1, end_col)
        else:
            end = start
            while end < len(src) and re.match(word_re, src[end]):
                end += 1
            if end == start:
                end = start + 1
    return {"start": {"line": line, "character": index_to_utf16(src, start)},
            "end": {"line": line, "character": index_to_utf16(src, min(end, max(len(src), start + 1)))}}


def offset_to_linecol(text, offset):
    offset = max(0, min(offset, len(text)))
    line = text.count("\n", 0, offset)
    col = offset - (text.rfind("\n", 0, offset) + 1)
    return line, col


def unbalanced_open_paren(text, line_comment=";", block=("#|", "|#"), datum_comment=None):
    """Offset of the first '(' left unclosed in Lisp-family source, else None."""
    stack = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
        elif c == line_comment:
            while i < n and text[i] != "\n":
                i += 1
        elif block and text.startswith(block[0], i):
            j = text.find(block[1], i + 2)
            i = n if j < 0 else j + 1
        elif c == "#" and i + 1 < n and text[i + 1] == "\\":
            i += 2  # character literal like #\( or #\)
        elif c in "([":
            stack.append(i)
        elif c in ")]":
            if stack:
                stack.pop()
        i += 1
    return stack[0] if stack else None


# ── Language definitions ─────────────────────────────────────────────────────

def parse_table(block, kind="function"):
    """'name|signature|doc' lines -> {name: {sig, doc, kind}}. A line may start
    with '@kind ' to switch the kind for the lines that follow."""
    out = {}
    for raw in block.strip().splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        if raw.startswith("@"):
            kind = raw[1:].strip()
            continue
        parts = raw.split("|", 2)
        name = parts[0].strip()
        sig = parts[1].strip() if len(parts) > 1 else ""
        doc = parts[2].strip() if len(parts) > 2 else ""
        out[name] = {"sig": sig, "doc": doc, "kind": kind}
    return out


class Language:
    name = "text"
    source = None            # diagnostic source label (the checker's name)
    md = ""                  # markdown code-fence language for hover
    case_insensitive = False
    word = r"[A-Za-z0-9_]"   # one identifier character
    lisp = False             # (operator args...) call syntax
    trigger = []
    keywords = {}
    builtins = {}

    def __init__(self):
        self.table = {}
        for k, v in self.keywords.items():
            self.table[k] = dict(v, kind=v.get("kind") or "keyword")
        self.table.update(self.builtins)
        self.load_data()
        self.index = {self.key(k): k for k in self.table}

    def key(self, name):
        return name.lower() if self.case_insensitive else name

    def load_data(self):
        path = os.path.join(DATA_DIR, f"{self.name}.json")
        try:
            with open(path) as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        for name, entry in data.items():
            cur = self.table.get(name)
            if cur is None:
                self.table[name] = entry
            else:  # keep curated text, fill gaps from the generated data
                for k in ("sig", "doc"):
                    if not cur.get(k) and entry.get(k):
                        cur[k] = entry[k]

    def lookup(self, name):
        real = self.index.get(self.key(name))
        return (real, self.table[real]) if real else (None, None)

    # Diagnostics: subclasses return [(line0, col0|None, severity, message)]
    def check(self, path, text, src_dir):
        return None


def run(cmd, cwd, env=None, timeout=CHECK_TIMEOUT):
    try:
        p = subprocess.run(cmd, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, timeout=timeout, env=env)
        return p.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired as e:
        return (e.stdout or b"").decode("utf-8", "replace")
    except OSError as e:
        log("cannot run", cmd[0], e)
        return ""


# ---- Pascal (Free Pascal) ----

PASCAL_KEYWORDS = parse_table("""
@keyword
program|program Name;|Starts a program.
unit|unit Name;|Starts a unit (module) with interface and implementation sections.
uses|uses Unit1, Unit2;|Imports units.
interface|interface|Public part of a unit.
implementation|implementation|Private part of a unit.
initialization|initialization|Unit initialization code.
finalization|finalization|Unit finalization code.
const|const Name = Value;|Declares constants.
type|type Name = ...;|Declares types.
var|var Name: Type;|Declares variables.
threadvar|threadvar Name: Type;|Declares thread-local variables.
resourcestring|resourcestring Name = 'text';|Declares localizable strings.
label|label L;|Declares goto labels.
begin|begin ... end|Starts a compound statement.
end|end|Ends a block, record, class or case.
procedure|procedure Name(params);|Declares a procedure.
function|function Name(params): ResultType;|Declares a function.
constructor|constructor Create;|Declares a constructor.
destructor|destructor Destroy; override;|Declares a destructor.
operator|operator + (a, b: T): T;|Declares an operator overload.
property|property Name: Type read FName write SetName;|Declares a property.
if|if Condition then ... else ...|Conditional statement.
then|then|Part of if ... then.
else|else|Alternative branch.
case|case Expr of ... end|Multi-way branch.
of|of|Part of case/array/set/file declarations.
for|for i := a to b do ...|Counting loop (also downto, for ... in).
to|to|Ascending for loop bound.
downto|downto|Descending for loop bound.
in|in|Set membership / for-in loop.
do|do|Loop / with body.
while|while Condition do ...|Pre-tested loop.
repeat|repeat ... until Condition;|Post-tested loop.
until|until|Ends a repeat loop.
with|with Record do ...|Opens a record's fields as a scope.
goto|goto Label;|Jumps to a label.
try|try ... except ... end / try ... finally ... end|Exception handling block.
except|except on E: Exception do ...|Exception handler section.
finally|finally|Code that always runs.
raise|raise Exception.Create('msg');|Raises an exception.
on|on E: EClass do|Exception handler clause.
exit|Exit / Exit(Value)|Leaves the current routine (optionally setting the result).
break|Break|Leaves the innermost loop.
continue|Continue|Next iteration of the innermost loop.
array|array[Low..High] of T|Array type.
record|record ... end|Record (struct) type.
packed|packed record|Packed (unaligned) structure.
set|set of T|Set type.
file|file of T|Typed file.
string|string|String type.
class|class(TParent) ... end|Class type.
object|object ... end|Old-style object type.
interface|interface ... end|Interface type.
private|private|Visibility: unit-private members.
protected|protected|Visibility: descendants only.
public|public|Visibility: everyone.
published|published|Visibility: public with RTTI.
strict|strict private / strict protected|Strict visibility.
virtual|virtual;|Virtual method directive.
override|override;|Overrides a virtual method.
abstract|abstract;|Abstract method directive.
overload|overload;|Allows several routines with the same name.
reintroduce|reintroduce;|Hides an inherited virtual method.
inherited|inherited Name;|Calls the ancestor's implementation.
forward|forward;|Forward declaration.
external|external 'lib';|Routine implemented in an external library.
inline|inline;|Inline routine.
cdecl|cdecl;|C calling convention.
stdcall|stdcall;|Stdcall calling convention.
nil|nil|The null pointer.
self|Self|The current object instance.
result|Result|The current function's return value.
and|a and b|Boolean / bitwise and.
or|a or b|Boolean / bitwise or.
xor|a xor b|Boolean / bitwise xor.
not|not a|Boolean / bitwise not.
div|a div b|Integer division.
mod|a mod b|Integer remainder.
shl|a shl n|Shift left.
shr|a shr n|Shift right.
is|obj is TClass|Type test.
as|obj as TClass|Checked type cast.
true|True|Boolean true.
false|False|Boolean false.
specialize|specialize TGeneric<T>|Instantiates a generic (objfpc mode).
generic|generic TList<T> = class ... end|Declares a generic type (objfpc mode).
@type
Integer|Integer|Signed integer (16-bit in FPC/TP mode, 32-bit in objfpc/delphi mode).
Cardinal|Cardinal|Unsigned 32-bit integer.
ShortInt|ShortInt|Signed 8-bit integer.
SmallInt|SmallInt|Signed 16-bit integer.
LongInt|LongInt|Signed 32-bit integer.
Int64|Int64|Signed 64-bit integer.
Byte|Byte|Unsigned 8-bit integer.
Word|Word|Unsigned 16-bit integer.
LongWord|LongWord|Unsigned 32-bit integer.
QWord|QWord|Unsigned 64-bit integer.
NativeInt|NativeInt|Pointer-sized signed integer.
NativeUInt|NativeUInt|Pointer-sized unsigned integer.
SizeInt|SizeInt|Signed integer the size of a pointer (string/array lengths).
Real|Real|Floating point (Double on x86-64).
Single|Single|32-bit floating point.
Double|Double|64-bit floating point.
Extended|Extended|Extended-precision floating point.
Currency|Currency|Fixed-point currency type.
Boolean|Boolean|True or False.
Char|Char|One byte character.
WideChar|WideChar|UTF-16 code unit.
AnsiString|AnsiString|Reference-counted byte string.
ShortString|ShortString|Length-prefixed string of at most 255 chars.
UnicodeString|UnicodeString|Reference-counted UTF-16 string.
WideString|WideString|COM-compatible UTF-16 string.
PChar|PChar|Pointer to a null-terminated string.
Pointer|Pointer|Untyped pointer.
Text|Text|Text file type.
TextFile|TextFile|Text file type (Delphi name).
Variant|Variant|Dynamically typed value.
TObject|TObject|Root of the class hierarchy.
Exception|Exception|Base exception class (SysUtils).
TStringList|TStringList|List of strings (Classes unit).
TList|TList|List of pointers (Classes unit).
""")

PASCAL_BUILTINS = parse_table("""
@procedure
Write|procedure Write([var F: Text;] Args...)|Writes the arguments to standard output (or file F).
WriteLn|procedure WriteLn([var F: Text;] Args...)|Writes the arguments followed by a line ending.
Read|procedure Read([var F: Text;] var V...)|Reads values from standard input (or file F).
ReadLn|procedure ReadLn([var F: Text;] var V...)|Reads values, then skips to the next line.
Assign|procedure Assign(var F; const Name: string)|Associates a file variable with a file name.
AssignFile|procedure AssignFile(var F; const Name: string)|Associates a file variable with a file name (Delphi name).
Reset|procedure Reset(var F [; RecSize: LongInt])|Opens an existing file for reading.
Rewrite|procedure Rewrite(var F [; RecSize: LongInt])|Creates/truncates a file and opens it for writing.
Append|procedure Append(var F: Text)|Opens a text file for appending.
Close|procedure Close(var F)|Closes a file.
CloseFile|procedure CloseFile(var F)|Closes a file (Delphi name).
BlockRead|procedure BlockRead(var F: File; var Buf; Count: LongInt [; var Result: LongInt])|Reads records from an untyped file.
BlockWrite|procedure BlockWrite(var F: File; const Buf; Count: LongInt [; var Result: LongInt])|Writes records to an untyped file.
Seek|procedure Seek(var F; N: Int64)|Moves the file position to record N.
Truncate|procedure Truncate(var F)|Truncates the file at the current position.
Flush|procedure Flush(var F: Text)|Writes buffered output of a text file.
Erase|procedure Erase(var F)|Deletes a closed file.
Rename|procedure Rename(var F; const NewName: string)|Renames a closed file.
Inc|procedure Inc(var X [; N: LongInt])|Increments X by 1 (or N).
Dec|procedure Dec(var X [; N: LongInt])|Decrements X by 1 (or N).
Include|procedure Include(var S: set of T; E: T)|Adds an element to a set.
Exclude|procedure Exclude(var S: set of T; E: T)|Removes an element from a set.
New|procedure New(var P: ^T)|Allocates memory for a typed pointer.
Dispose|procedure Dispose(var P: ^T)|Frees memory allocated with New.
GetMem|procedure GetMem(var P: Pointer; Size: PtrUInt)|Allocates Size bytes.
FreeMem|procedure FreeMem(var P: Pointer)|Frees memory from GetMem.
ReallocMem|procedure ReallocMem(var P: Pointer; Size: PtrUInt)|Resizes a block from GetMem.
FillChar|procedure FillChar(var X; Count: SizeInt; Value: Byte)|Fills Count bytes of X with Value.
FillByte|procedure FillByte(var X; Count: SizeInt; Value: Byte)|Fills Count bytes with Value.
Move|procedure Move(const Source; var Dest; Count: SizeInt)|Copies Count bytes from Source to Dest.
SetLength|procedure SetLength(var S; NewLength: SizeInt...)|Resizes a string or dynamic array.
Delete|procedure Delete(var S: string; Index, Count: SizeInt)|Deletes Count characters from S starting at Index.
Insert|procedure Insert(const Source: string; var S: string; Index: SizeInt)|Inserts Source into S at Index.
Str|procedure Str(X[:Width[:Decimals]]; var S: string)|Converts a number to a string.
Val|procedure Val(const S: string; var V; var Code: Word)|Converts a string to a number; Code is 0 on success.
Randomize|procedure Randomize|Seeds the random number generator.
Halt|procedure Halt([ExitCode: LongInt])|Stops the program.
RunError|procedure RunError([ErrorCode: Word])|Stops the program with a run-time error.
Assert|procedure Assert(Condition: Boolean [; const Msg: string])|Raises EAssertionFailed if Condition is false (with -Sa).
Initialize|procedure Initialize(var V)|Initializes a managed variable.
Finalize|procedure Finalize(var V)|Finalizes a managed variable.
ChDir|procedure ChDir(const S: string)|Changes the current directory.
MkDir|procedure MkDir(const S: string)|Creates a directory.
RmDir|procedure RmDir(const S: string)|Removes an empty directory.
GetDir|procedure GetDir(Drive: Byte; var Dir: string)|Returns the current directory.
SetTextBuf|procedure SetTextBuf(var F: Text; var Buf [; Size: SizeInt])|Sets a text file's buffer.
Sleep|procedure Sleep(Milliseconds: Cardinal)|Pauses the program (SysUtils).
FreeAndNil|procedure FreeAndNil(var Obj)|Frees an object and sets the variable to nil (SysUtils).
Beep|procedure Beep|Sounds a beep (SysUtils).
Abort|procedure Abort|Raises a silent EAbort exception (SysUtils).
DecodeDate|procedure DecodeDate(Date: TDateTime; out Year, Month, Day: Word)|Splits a date (SysUtils).
DecodeTime|procedure DecodeTime(Time: TDateTime; out Hour, Min, Sec, MSec: Word)|Splits a time (SysUtils).
@function
Length|function Length(S): SizeInt|Length of a string or array.
High|function High(X): Ordinal|Highest index/value of an array, ordinal type or string.
Low|function Low(X): Ordinal|Lowest index/value of an array, ordinal type or string.
SizeOf|function SizeOf(X): SizeInt|Size in bytes of a variable or type.
Ord|function Ord(X: Ordinal): Int64|Ordinal value of a char, enum or boolean.
Chr|function Chr(B: Byte): Char|Character with the given ordinal value.
Succ|function Succ(X: Ordinal): Ordinal|Next value of an ordinal.
Pred|function Pred(X: Ordinal): Ordinal|Previous value of an ordinal.
Odd|function Odd(X: Int64): Boolean|True if X is odd.
Abs|function Abs(X): Number|Absolute value.
Sqr|function Sqr(X): Number|X squared.
Sqrt|function Sqrt(X: Real): Real|Square root.
Sin|function Sin(X: Real): Real|Sine (radians).
Cos|function Cos(X: Real): Real|Cosine (radians).
ArcTan|function ArcTan(X: Real): Real|Arctangent (radians).
Exp|function Exp(X: Real): Real|e raised to X.
Ln|function Ln(X: Real): Real|Natural logarithm.
Pi|function Pi: Real|The constant pi.
Int|function Int(X: Real): Real|Integer part of X (as a real).
Frac|function Frac(X: Real): Real|Fractional part of X.
Trunc|function Trunc(X: Real): Int64|Truncates towards zero.
Round|function Round(X: Real): Int64|Rounds to the nearest integer (banker's rounding).
Random|function Random[(L: LongInt)]: LongInt or Real|Random integer in [0, L), or real in [0, 1).
Copy|function Copy(const S: string; Index, Count: SizeInt): string|Substring (also copies dynamic array slices).
Pos|function Pos(const Substr, S: string [; Offset: SizeInt]): SizeInt|1-based position of Substr in S, 0 if absent.
Concat|function Concat(S1, S2 [, ...]: string): string|Concatenates strings.
UpCase|function UpCase(C: Char): Char|Uppercase of a character (or string).
LowerCase|function LowerCase(const S: string): string|Lowercase copy of S.
UpperCase|function UpperCase(const S: string): string|Uppercase copy of S.
Assigned|function Assigned(P): Boolean|True if a pointer, object or procedure variable is not nil.
Addr|function Addr(X): Pointer|Address of X (same as @X).
Ptr|function Ptr(Sel, Off: LongInt): Pointer|Builds a pointer.
EOF|function EOF[(var F)]: Boolean|True at end of file (standard input if F is omitted).
EOLn|function EOLn[(var F: Text)]: Boolean|True at end of line.
SeekEOF|function SeekEOF[(var F: Text)]: Boolean|EOF, skipping whitespace.
SeekEOLn|function SeekEOLn[(var F: Text)]: Boolean|EOLn, skipping whitespace.
FilePos|function FilePos(var F): Int64|Current record position in a file.
FileSize|function FileSize(var F): Int64|Number of records in a file.
IOResult|function IOResult: Word|Result of the last I/O operation (with {$I-}).
ParamCount|function ParamCount: LongInt|Number of command-line parameters.
ParamStr|function ParamStr(L: LongInt): string|Command-line parameter L (0 is the program).
Hi|function Hi(X): Byte or Word|High byte/word of X.
Lo|function Lo(X): Byte or Word|Low byte/word of X.
Swap|function Swap(X): X|Swaps the high and low halves of X.
TypeOf|function TypeOf(X): Pointer|VMT pointer of an object.
Default|function Default(T): T|Default (zero) value of type T.
GetTypeKind|function GetTypeKind(T): TTypeKind|Kind of a type at compile time.
IntToStr|function IntToStr(Value: Int64): string|Integer to string (SysUtils).
StrToInt|function StrToInt(const S: string): LongInt|String to integer; raises EConvertError (SysUtils).
StrToIntDef|function StrToIntDef(const S: string; Default: LongInt): LongInt|String to integer with a default (SysUtils).
TryStrToInt|function TryStrToInt(const S: string; out I: LongInt): Boolean|String to integer without exceptions (SysUtils).
StrToInt64|function StrToInt64(const S: string): Int64|String to Int64 (SysUtils).
FloatToStr|function FloatToStr(Value: Extended): string|Float to string (SysUtils).
StrToFloat|function StrToFloat(const S: string): Extended|String to float (SysUtils).
StrToFloatDef|function StrToFloatDef(const S: string; Default: Extended): Extended|String to float with a default (SysUtils).
TryStrToFloat|function TryStrToFloat(const S: string; out Value: Double): Boolean|String to float without exceptions (SysUtils).
FloatToStrF|function FloatToStrF(Value: Extended; Format: TFloatFormat; Precision, Digits: Integer): string|Formatted float to string (SysUtils).
FormatFloat|function FormatFloat(const Fmt: string; Value: Extended): string|Formats a float with a pattern like '0.00' (SysUtils).
Format|function Format(const Fmt: string; const Args: array of const): string|printf-style formatting, e.g. Format('%d items', [N]) (SysUtils).
BoolToStr|function BoolToStr(B: Boolean; UseBoolStrs: Boolean = False): string|Boolean to string (SysUtils).
StrToBool|function StrToBool(const S: string): Boolean|String to boolean (SysUtils).
IntToHex|function IntToHex(Value: Int64; Digits: Integer): string|Hexadecimal representation (SysUtils).
Trim|function Trim(const S: string): string|Removes leading and trailing whitespace (SysUtils).
TrimLeft|function TrimLeft(const S: string): string|Removes leading whitespace (SysUtils).
TrimRight|function TrimRight(const S: string): string|Removes trailing whitespace (SysUtils).
CompareStr|function CompareStr(const S1, S2: string): Integer|Case-sensitive comparison (SysUtils).
CompareText|function CompareText(const S1, S2: string): Integer|Case-insensitive comparison (SysUtils).
SameText|function SameText(const S1, S2: string): Boolean|Case-insensitive equality (SysUtils).
AnsiUpperCase|function AnsiUpperCase(const S: string): string|Locale-aware uppercase (SysUtils).
AnsiLowerCase|function AnsiLowerCase(const S: string): string|Locale-aware lowercase (SysUtils).
StringReplace|function StringReplace(const S, OldPattern, NewPattern: string; Flags: TReplaceFlags): string|Replaces occurrences, Flags like [rfReplaceAll, rfIgnoreCase] (SysUtils).
QuotedStr|function QuotedStr(const S: string): string|S in single quotes with quotes doubled (SysUtils).
StringOfChar|function StringOfChar(C: Char; N: SizeInt): string|N copies of C.
Now|function Now: TDateTime|Current date and time (SysUtils).
Date|function Date: TDateTime|Current date (SysUtils).
Time|function Time: TDateTime|Current time (SysUtils).
DateToStr|function DateToStr(D: TDateTime): string|Date to string (SysUtils).
TimeToStr|function TimeToStr(T: TDateTime): string|Time to string (SysUtils).
DateTimeToStr|function DateTimeToStr(DT: TDateTime): string|Date and time to string (SysUtils).
FormatDateTime|function FormatDateTime(const Fmt: string; DT: TDateTime): string|Formats a date/time, e.g. 'yyyy-mm-dd hh:nn:ss' (SysUtils).
EncodeDate|function EncodeDate(Year, Month, Day: Word): TDateTime|Builds a date (SysUtils).
EncodeTime|function EncodeTime(Hour, Min, Sec, MSec: Word): TDateTime|Builds a time (SysUtils).
DayOfWeek|function DayOfWeek(D: TDateTime): Integer|1 = Sunday ... 7 = Saturday (SysUtils).
IsLeapYear|function IsLeapYear(Year: Word): Boolean|True for leap years (SysUtils).
GetTickCount64|function GetTickCount64: QWord|Milliseconds since an arbitrary start (SysUtils).
FileExists|function FileExists(const Name: string): Boolean|True if the file exists (SysUtils).
DirectoryExists|function DirectoryExists(const Dir: string): Boolean|True if the directory exists (SysUtils).
DeleteFile|function DeleteFile(const Name: string): Boolean|Deletes a file (SysUtils).
RenameFile|function RenameFile(const Old, New: string): Boolean|Renames a file (SysUtils).
CreateDir|function CreateDir(const Dir: string): Boolean|Creates a directory (SysUtils).
ForceDirectories|function ForceDirectories(const Dir: string): Boolean|Creates a directory and its parents (SysUtils).
GetCurrentDir|function GetCurrentDir: string|Current directory (SysUtils).
ExtractFileName|function ExtractFileName(const Path: string): string|File name part of a path (SysUtils).
ExtractFilePath|function ExtractFilePath(const Path: string): string|Directory part of a path, with trailing separator (SysUtils).
ExtractFileExt|function ExtractFileExt(const Path: string): string|Extension including the dot (SysUtils).
ChangeFileExt|function ChangeFileExt(const Path, Ext: string): string|Replaces the extension (SysUtils).
ExpandFileName|function ExpandFileName(const Path: string): string|Absolute path (SysUtils).
GetEnvironmentVariable|function GetEnvironmentVariable(const Name: string): string|Value of an environment variable (SysUtils).
SysErrorMessage|function SysErrorMessage(Code: Integer): string|Text for an OS error code (SysUtils).
Max|function Max(A, B): Number|Larger of two numbers (Math).
Min|function Min(A, B): Number|Smaller of two numbers (Math).
Power|function Power(Base, Exponent: Float): Float|Base raised to Exponent (Math).
IntPower|function IntPower(Base: Float; Exponent: Integer): Float|Base raised to an integer exponent (Math).
Ceil|function Ceil(X: Float): Integer|Smallest integer >= X (Math).
Floor|function Floor(X: Float): Integer|Largest integer <= X (Math).
Log10|function Log10(X: Float): Float|Base-10 logarithm (Math).
Log2|function Log2(X: Float): Float|Base-2 logarithm (Math).
LogN|function LogN(Base, X: Float): Float|Logarithm of X in Base (Math).
Tan|function Tan(X: Float): Float|Tangent (Math).
ArcSin|function ArcSin(X: Float): Float|Arcsine (Math).
ArcCos|function ArcCos(X: Float): Float|Arccosine (Math).
ArcTan2|function ArcTan2(Y, X: Float): Float|Angle of the vector (X, Y) (Math).
Hypot|function Hypot(X, Y: Float): Float|sqrt(X*X + Y*Y) (Math).
Sum|function Sum(const Data: array of Double): Double|Sum of an array (Math).
Mean|function Mean(const Data: array of Double): Float|Average of an array (Math).
MaxIntValue|function MaxIntValue(const Data: array of Integer): Integer|Largest element (Math).
MinIntValue|function MinIntValue(const Data: array of Integer): Integer|Smallest element (Math).
RandomRange|function RandomRange(From, To: Integer): Integer|Random integer in [From, To) (Math).
Sign|function Sign(X): Integer|-1, 0 or 1 (Math).
DegToRad|function DegToRad(Deg: Float): Float|Degrees to radians (Math).
RadToDeg|function RadToDeg(Rad: Float): Float|Radians to degrees (Math).
EnsureRange|function EnsureRange(Value, Min, Max): Number|Clamps Value into [Min, Max] (Math).
InRange|function InRange(Value, Min, Max): Boolean|True if Min <= Value <= Max (Math).
IsNan|function IsNan(X: Float): Boolean|True if X is NaN (Math).
IsInfinite|function IsInfinite(X: Float): Boolean|True if X is infinite (Math).
ReverseString|function ReverseString(const S: string): string|S reversed (StrUtils).
DupeString|function DupeString(const S: string; N: Integer): string|S repeated N times (StrUtils).
LeftStr|function LeftStr(const S: string; N: Integer): string|First N characters (StrUtils).
RightStr|function RightStr(const S: string; N: Integer): string|Last N characters (StrUtils).
MidStr|function MidStr(const S: string; Start, Count: Integer): string|Substring (StrUtils).
PosEx|function PosEx(const Substr, S: string; Offset: Cardinal = 1): Integer|Pos starting at Offset (StrUtils).
StartsStr|function StartsStr(const Sub, S: string): Boolean|True if S starts with Sub (StrUtils).
EndsStr|function EndsStr(const Sub, S: string): Boolean|True if S ends with Sub (StrUtils).
ContainsStr|function ContainsStr(const S, Sub: string): Boolean|True if S contains Sub (StrUtils).
ContainsText|function ContainsText(const S, Sub: string): Boolean|Case-insensitive ContainsStr (StrUtils).
AnsiStartsStr|function AnsiStartsStr(const Sub, S: string): Boolean|True if S starts with Sub (StrUtils).
SplitString|function SplitString(const S, Delimiters: string): TStringArray|Splits S at any delimiter character (StrUtils).
WordCount|function WordCount(const S: string; const Delims: TSysCharSet): Integer|Number of words (StrUtils).
ExtractWord|function ExtractWord(N: Integer; const S: string; const Delims: TSysCharSet): string|N-th word (StrUtils).
PadLeft|function PadLeft(const S: string; N: Integer): string|Pads with spaces on the left to length N (StrUtils).
PadRight|function PadRight(const S: string; N: Integer): string|Pads with spaces on the right to length N (StrUtils).
IfThen|function IfThen(Cond: Boolean; const ATrue, AFalse): T|ATrue if Cond else AFalse (Math/StrUtils).
""")


class Pascal(Language):
    name, md, source = "pascal", "pascal", "fpc"
    case_insensitive = True
    trigger = ["."]
    keywords = PASCAL_KEYWORDS
    builtins = PASCAL_BUILTINS
    LINE = re.compile(r"^(?P<file>[^\s(][^(]*)\((?P<line>\d+)(?:,(?P<col>\d+))?\) (?P<sev>Error|Fatal|Warning|Note|Hint): (?P<msg>.*)$")

    def check(self, path, text, src_dir):
        out_dir = os.path.join(os.path.dirname(path), "out")
        os.makedirs(out_dir, exist_ok=True)
        output = run(["fpc", "-Cn", "-vewn", "-l-", f"-FE{out_dir}", f"-FU{out_dir}",
                      f"-Fu{src_dir}", f"-Fi{src_dir}", os.path.basename(path)], cwd=os.path.dirname(path))
        diags = []
        for line in output.splitlines():
            m = self.LINE.match(line.strip())
            if not m or os.path.basename(m["file"]) != os.path.basename(path):
                continue
            msg = m["msg"]
            if m["sev"] == "Fatal" and msg.startswith(("Compilation aborted", "There were")):
                continue
            sev = {"Error": ERROR, "Fatal": ERROR, "Warning": WARNING, "Note": INFO, "Hint": HINT}[m["sev"]]
            diags.append((int(m["line"]) - 1, int(m["col"]) - 1 if m["col"] else None, sev, msg))
        return diags


# ---- NASM (diagnostics only; asm-lsp provides completion) ----

class Nasm(Language):
    name, md, source = "nasm", "nasm", "nasm"
    case_insensitive = True
    word = r"[A-Za-z0-9_.$@?]"
    LINE = re.compile(r"^(?P<file>[^:]+):(?P<line>\d+): (?P<sev>error|warning|fatal|panic): (?P<msg>.*)$")

    def check(self, path, text, src_dir):
        output = run(["nasm", "-f", "elf64", "-o", "/dev/null", f"-I{src_dir}/", os.path.basename(path)],
                     cwd=os.path.dirname(path))
        diags = []
        for line in output.splitlines():
            m = self.LINE.match(line.strip())
            if not m or os.path.basename(m["file"]) != os.path.basename(path):
                continue
            sev = WARNING if m["sev"] == "warning" else ERROR
            msg = re.sub(r"\s*\[-w\+[a-z-]+\]$", "", m["msg"])
            diags.append((int(m["line"]) - 1, None, sev, msg))
        return diags


# ---- Fortran (gfortran; completion comes from fortls) ----

class Fortran(Language):
    name, md, source = "fortran", "fortran", "gfortran"
    case_insensitive = True
    LINE = re.compile(r"^(?P<file>[^:]+):(?P<line>\d+):(?P<col>\d+): (?P<sev>Error|Fatal Error|Warning|Note): (?P<msg>.*)$")

    def check(self, path, text, src_dir):
        mod_dir = os.path.join(os.path.dirname(path), "mod")
        os.makedirs(mod_dir, exist_ok=True)
        output = run(["gfortran", "-fsyntax-only", "-fdiagnostics-plain-output", "-fmax-errors=50",
                      "-Wall", "-Wno-unused-dummy-argument", f"-J{mod_dir}", f"-I{src_dir}",
                      os.path.basename(path)], cwd=os.path.dirname(path))
        diags = []
        for line in output.splitlines():
            m = self.LINE.match(line.strip())
            if not m or os.path.basename(m["file"]) != os.path.basename(path):
                continue
            sev = {"Error": ERROR, "Fatal Error": ERROR, "Warning": WARNING, "Note": INFO}[m["sev"]]
            msg = re.sub(r" at \(1\)", "", m["msg"])
            msg = re.sub(r"\s*\[-W[a-z-]+\]$", "", msg)
            diags.append((int(m["line"]) - 1, int(m["col"]) - 1, sev, msg))
        return diags


# ---- Scheme (Guile) ----

SCHEME_TABLE = parse_table("""
@special
define|(define name value) / (define (name args...) body...)|Binds a top-level or internal variable or procedure.
define-syntax|(define-syntax name transformer)|Defines a macro.
define-record-type|(define-record-type <name> (ctor field...) pred? (field accessor [modifier])...)|Defines a record type (R7RS).
define-values|(define-values (var...) expr)|Binds several values.
define-module|(define-module (name ...) #:use-module ...)|Declares a Guile module.
use-modules|(use-modules (module name) ...)|Imports Guile modules.
import|(import (scheme base) ...)|Imports R7RS libraries.
lambda|(lambda (args...) body...)|Creates a procedure.
case-lambda|(case-lambda ((args...) body...) ...)|Procedure dispatching on argument count.
let|(let ((var init) ...) body...) / (let name ((var init) ...) body...)|Local bindings (named let loops).
let*|(let* ((var init) ...) body...)|Sequential local bindings.
letrec|(letrec ((var init) ...) body...)|Recursive local bindings.
letrec*|(letrec* ((var init) ...) body...)|Sequential recursive bindings.
let-values|(let-values (((a b) expr) ...) body...)|Binds multiple values.
let*-values|(let*-values (((a b) expr) ...) body...)|Sequential multiple-value bindings.
let-syntax|(let-syntax ((name transformer) ...) body...)|Local macros.
syntax-rules|(syntax-rules (literals...) (pattern template) ...)|Pattern-based macro transformer.
syntax-case|(syntax-case stx (literals...) clauses...)|Procedural macro transformer.
if|(if test consequent [alternate])|Conditional.
cond|(cond (test expr...) ... (else expr...))|Multi-way conditional.
case|(case key ((datum...) expr...) ... (else expr...))|Dispatch on a value.
when|(when test body...)|Runs body when test is true.
unless|(unless test body...)|Runs body when test is false.
and|(and expr...)|Logical and (short-circuit).
or|(or expr...)|Logical or (short-circuit).
not|(not obj)|#t if obj is #f.
begin|(begin expr...)|Sequence of expressions.
do|(do ((var init step) ...) (test result...) body...)|Iteration.
set!|(set! var value)|Assigns to a variable.
quote|(quote datum) / 'datum|Literal data.
quasiquote|(quasiquote template) / `template|Template with unquote (,) and unquote-splicing (,@).
delay|(delay expr)|Creates a promise.
delay-force|(delay-force expr)|Iterative lazy promise.
make-promise|(make-promise obj)|A promise already holding obj.
force|(force promise)|Evaluates a promise.
parameterize|(parameterize ((param value) ...) body...)|Dynamically rebinds parameters.
guard|(guard (var clause...) body...)|Catches raised conditions (R7RS).
dynamic-wind|(dynamic-wind before thunk after)|Runs before/after around thunk.
call-with-current-continuation|(call-with-current-continuation proc)|Captures the current continuation.
call/cc|(call/cc proc)|Captures the current continuation.
values|(values obj...)|Returns multiple values.
call-with-values|(call-with-values producer consumer)|Passes producer's values to consumer.
receive|(receive (formals...) expr body...)|Binds multiple values (SRFI 8).
match|(match expr (pattern body...) ...)|Pattern matching ((ice-9 match)).
@function
display|(display obj [port])|Writes obj for humans (strings without quotes).
write|(write obj [port])|Writes obj in machine-readable form.
newline|(newline [port])|Writes a newline.
write-string|(write-string string [port])|Writes a string.
write-char|(write-char char [port])|Writes a character.
read|(read [port])|Reads a datum.
read-line|(read-line [port])|Reads a line as a string ((ice-9 rdelim)).
read-char|(read-char [port])|Reads a character.
peek-char|(peek-char [port])|Next character without consuming it.
format|(format dest fmt arg...)|Formatted output; dest #t for stdout, #f for a string. ~a display, ~s write, ~% newline.
error|(error message obj...)|Raises an error.
raise|(raise obj)|Raises obj as an exception.
exit|(exit [status])|Exits the program.
car|(car pair)|First element of a pair.
cdr|(cdr pair)|Rest of a pair.
cons|(cons a b)|New pair.
list|(list obj...)|New list.
length|(length list)|Number of elements.
append|(append list...)|Concatenates lists.
reverse|(reverse list)|Reversed copy.
list-ref|(list-ref list k)|k-th element.
list-tail|(list-tail list k)|List after k elements.
list-copy|(list-copy list)|Shallow copy.
memq|(memq obj list)|Sublist starting at obj (eq?).
member|(member obj list [compare])|Sublist starting at obj (equal?).
assq|(assq key alist)|Association lookup (eq?).
assoc|(assoc key alist [compare])|Association lookup (equal?).
map|(map proc list...)|Applies proc to elements, returns the results.
for-each|(for-each proc list...)|Applies proc to elements for effect.
filter|(filter pred list)|Elements satisfying pred.
reduce|(reduce proc default list)|Combines elements (SRFI 1).
fold|(fold kons knil list...)|Left fold (SRFI 1).
fold-right|(fold-right kons knil list...)|Right fold (SRFI 1).
apply|(apply proc arg... list)|Calls proc with arguments from a list.
iota|(iota count [start step])|List of count numbers.
null?|(null? obj)|#t for the empty list.
pair?|(pair? obj)|#t for pairs.
list?|(list? obj)|#t for proper lists.
number?|(number? obj)|#t for numbers.
integer?|(integer? obj)|#t for integers.
string?|(string? obj)|#t for strings.
symbol?|(symbol? obj)|#t for symbols.
procedure?|(procedure? obj)|#t for procedures.
boolean?|(boolean? obj)|#t for booleans.
vector?|(vector? obj)|#t for vectors.
char?|(char? obj)|#t for characters.
eq?|(eq? a b)|Identity comparison.
eqv?|(eqv? a b)|Value comparison for atoms.
equal?|(equal? a b)|Structural comparison.
zero?|(zero? z)|#t if z is zero.
positive?|(positive? x)|#t if x > 0.
negative?|(negative? x)|#t if x < 0.
odd?|(odd? n)|#t for odd integers.
even?|(even? n)|#t for even integers.
max|(max x...)|Largest argument.
min|(min x...)|Smallest argument.
abs|(abs x)|Absolute value.
quotient|(quotient n1 n2)|Integer quotient.
remainder|(remainder n1 n2)|Remainder with the sign of n1.
modulo|(modulo n1 n2)|Remainder with the sign of n2.
gcd|(gcd n...)|Greatest common divisor.
lcm|(lcm n...)|Least common multiple.
floor|(floor x)|Largest integer <= x.
ceiling|(ceiling x)|Smallest integer >= x.
round|(round x)|Nearest integer (ties to even).
truncate|(truncate x)|Integer part of x.
exact->inexact|(exact->inexact z)|Converts to floating point.
inexact->exact|(inexact->exact z)|Converts to an exact number.
exact|(exact z)|Exact version of z.
inexact|(inexact z)|Inexact version of z.
sqrt|(sqrt z)|Square root.
expt|(expt z1 z2)|z1 to the power z2.
exp|(exp z)|e to the power z.
log|(log z [base])|Logarithm.
sin|(sin z)|Sine.
cos|(cos z)|Cosine.
tan|(tan z)|Tangent.
number->string|(number->string z [radix])|Number to string.
string->number|(string->number string [radix])|String to number, #f if invalid.
string-length|(string-length string)|Number of characters.
string-ref|(string-ref string k)|k-th character.
substring|(substring string start [end])|Part of a string.
string-append|(string-append string...)|Concatenates strings.
string-copy|(string-copy string [start end])|Copy of a string.
string->list|(string->list string)|List of characters.
list->string|(list->string list)|String from characters.
string->symbol|(string->symbol string)|Symbol with that name.
symbol->string|(symbol->string symbol)|Name of a symbol.
string-upcase|(string-upcase string)|Uppercase copy.
string-downcase|(string-downcase string)|Lowercase copy.
string-join|(string-join list [delimiter grammar])|Joins strings (Guile).
string-split|(string-split string char)|Splits at a character (Guile).
string-index|(string-index string pred)|Index of the first match (Guile).
string-contains|(string-contains s1 s2)|Index of s2 in s1 or #f (Guile).
string-null?|(string-null? string)|#t for the empty string.
string=?|(string=? s1 s2...)|String equality.
string<?|(string<? s1 s2...)|Lexicographic less-than.
string-for-each|(string-for-each proc string...)|Calls proc on each character.
string-map|(string-map proc string...)|Maps characters.
vector|(vector obj...)|New vector.
make-vector|(make-vector k [fill])|Vector of k elements.
vector-ref|(vector-ref vector k)|k-th element.
vector-set!|(vector-set! vector k obj)|Stores obj at k.
vector-length|(vector-length vector)|Number of elements.
vector->list|(vector->list vector)|List of elements.
list->vector|(list->vector list)|Vector from a list.
vector-map|(vector-map proc vector...)|Maps over vectors.
vector-for-each|(vector-for-each proc vector...)|Iterates over vectors.
vector-fill!|(vector-fill! vector fill)|Fills a vector.
make-hash-table|(make-hash-table [size])|New hash table (Guile).
hash-ref|(hash-ref table key [default])|Looks up a key (Guile).
hash-set!|(hash-set! table key value)|Stores a value (Guile).
hash-remove!|(hash-remove! table key)|Removes a key (Guile).
hash-for-each|(hash-for-each proc table)|Calls (proc key value) for each entry (Guile).
hash-count|(hash-count pred table)|Counts matching entries (Guile).
char-upcase|(char-upcase char)|Uppercase character.
char-downcase|(char-downcase char)|Lowercase character.
char-alphabetic?|(char-alphabetic? char)|#t for letters.
char-numeric?|(char-numeric? char)|#t for digits.
char-whitespace?|(char-whitespace? char)|#t for whitespace.
char->integer|(char->integer char)|Code point.
integer->char|(integer->char n)|Character for a code point.
assert|(assert expr)|Raises an error if expr is false.
current-output-port|(current-output-port)|The current output port.
current-input-port|(current-input-port)|The current input port.
open-input-file|(open-input-file filename)|Opens a file for reading.
open-output-file|(open-output-file filename)|Opens a file for writing.
call-with-input-file|(call-with-input-file filename proc)|Calls proc with an input port.
call-with-output-file|(call-with-output-file filename proc)|Calls proc with an output port.
with-output-to-string|(with-output-to-string thunk)|Captures output as a string.
close-port|(close-port port)|Closes a port.
eof-object?|(eof-object? obj)|#t for the end-of-file object.
random|(random n)|Random number below n.
current-time|(current-time)|Seconds since the epoch (Guile).
sort|(sort list less?)|Sorted copy.
""")


class Scheme(Language):
    name, md, source = "scheme", "scheme", "guile"
    word = r"[^\s()\[\]'`,;\"#|]"
    lisp = True
    trigger = ["("]
    builtins = SCHEME_TABLE
    WARN = re.compile(r"^(?:;;; )?(?P<file>[^:\s]+):(?P<line>\d+):(?P<col>\d+): (?P<sev>warning|error): (?P<msg>.*)$")
    ERR = re.compile(r"^(?P<file>[^:\s]+):(?P<line>\d+):(?P<col>\d+): (?P<msg>.*)$")
    DRIVER = ("(use-modules (system base compile))"
              "(compile-file (cadr (command-line)) #:output-file (caddr (command-line))"
              " #:opts (list #:warnings (list 'unbound-variable 'macro-use-before-definition 'arity-mismatch"
              " 'format 'duplicate-case-datum 'bad-case-datum 'unused-variable 'use-before-definition)))")

    def check(self, path, text, src_dir):
        out = os.path.join(os.path.dirname(path), "out.go")
        env = dict(os.environ, GUILE_LOAD_PATH=src_dir + (":" + os.environ["GUILE_LOAD_PATH"] if os.environ.get("GUILE_LOAD_PATH") else ""))
        output = run(["guile", "--no-auto-compile", "-c", self.DRIVER, os.path.basename(path), out],
                     cwd=os.path.dirname(path), env=env)
        base = os.path.basename(path)
        diags = []
        lines = output.splitlines()
        for i, line in enumerate(lines):
            line = line.strip()
            m = self.WARN.match(line)
            if m and os.path.basename(m["file"]) == base:
                sev = ERROR if m["sev"] == "error" else WARNING
                diags.append((int(m["line"]) - 1, int(m["col"]), sev, m["msg"]))
                continue
            m = self.ERR.match(line)
            if m and os.path.basename(m["file"]) == base and not m["msg"].startswith("In procedure"):
                msg = m["msg"]
                ln, col = int(m["line"]) - 1, int(m["col"])
                if "end of input" in msg:
                    off = unbalanced_open_paren(text)
                    if off is not None:
                        ln, col = offset_to_linecol(text, off)
                        msg = "unclosed parenthesis (" + msg + ")"
                diags.append((ln, col, ERROR, msg))
            elif line.startswith("unknown location:"):
                msg = line[len("unknown location:"):].strip()
                ln, col = 0, None
                form = re.search(r"in form (.*)$", msg)
                if form:
                    pos = text.find(form.group(1))
                    if pos < 0:  # match the operator only, e.g. "(lambda"
                        op = re.match(r"\(\S+", form.group(1))
                        pos = text.find(op.group(0)) if op else -1
                    if pos >= 0:
                        ln, col = offset_to_linecol(text, pos)
                diags.append((ln, col, ERROR, msg))
        if not diags and ("error" in output.lower() or "exception" in output.lower()):
            # Some other failure (e.g. an error raised while expanding a macro).
            msg = next((l.strip() for l in reversed(lines) if l.strip() and not l.startswith("ice-9/")), "")
            if msg:
                diags.append((0, None, ERROR, msg))
        return diags


# ---- Common Lisp (SBCL) ----

CL_TABLE = parse_table("""
@special
defun|(defun name (args...) [doc] body...)|Defines a global function.
defmacro|(defmacro name (args...) body...)|Defines a macro.
defvar|(defvar *name* [value [doc]])|Defines a special variable (value set only if unbound).
defparameter|(defparameter *name* value [doc])|Defines a special variable (always assigned).
defconstant|(defconstant +name+ value [doc])|Defines a constant.
defstruct|(defstruct name slot...)|Defines a structure with constructor, accessors and predicate.
defclass|(defclass name (superclass...) (slot-spec...) option...)|Defines a CLOS class.
defgeneric|(defgeneric name (args...) option...)|Defines a generic function.
defmethod|(defmethod name [qualifier] (specialized-args...) body...)|Defines a method.
defpackage|(defpackage :name (:use :cl) (:export ...))|Defines a package.
in-package|(in-package :name)|Sets the current package.
lambda|(lambda (args...) body...)|Anonymous function.
let|(let ((var value) ...) body...)|Parallel local bindings.
let*|(let* ((var value) ...) body...)|Sequential local bindings.
flet|(flet ((name (args) body...)) body...)|Local functions.
labels|(labels ((name (args) body...)) body...)|Local recursive functions.
macrolet|(macrolet ((name (args) body...)) body...)|Local macros.
if|(if test then [else])|Conditional.
when|(when test body...)|Runs body if test is true.
unless|(unless test body...)|Runs body if test is false.
cond|(cond (test form...) ...)|Multi-way conditional; use t for the default clause.
case|(case key ((keys...) form...) ... (otherwise form...))|Dispatch on a value (eql).
ecase|(ecase key clauses...)|case that signals an error when nothing matches.
typecase|(typecase value (type form...) ...)|Dispatch on type.
and|(and form...)|Logical and.
or|(or form...)|Logical or.
progn|(progn form...)|Sequence, returns the last value.
prog1|(prog1 first form...)|Sequence, returns the first value.
block|(block name body...)|Named block for return-from.
return-from|(return-from name [value])|Returns from a named block.
return|(return [value])|Returns from the nil block (loops).
tagbody|(tagbody tag|form...)|Body with go tags.
go|(go tag)|Jumps to a tagbody tag.
setq|(setq var value ...)|Assigns variables.
setf|(setf place value ...)|Assigns generalized places.
incf|(incf place [delta])|Increments a place.
decf|(decf place [delta])|Decrements a place.
push|(push item place)|Conses item onto a place.
pop|(pop place)|Removes and returns the first element of a place.
quote|(quote x) / 'x|Literal data.
function|(function f) / #'f|The function named f.
loop|(loop for x in list collect ...)|The extended iteration macro: for/in/from/to/collect/sum/when/do/finally.
dolist|(dolist (var list [result]) body...)|Iterates over a list.
dotimes|(dotimes (var count [result]) body...)|Iterates count times.
do|(do ((var init step) ...) (end-test result...) body...)|General iteration.
multiple-value-bind|(multiple-value-bind (vars...) form body...)|Binds multiple values.
destructuring-bind|(destructuring-bind lambda-list form body...)|Destructures a list.
handler-case|(handler-case form (condition-type (var) body...) ...)|Catches conditions.
handler-bind|(handler-bind ((type handler) ...) body...)|Installs condition handlers without unwinding.
unwind-protect|(unwind-protect form cleanup...)|Always runs cleanup.
ignore-errors|(ignore-errors form...)|Returns nil and the condition on error.
with-open-file|(with-open-file (stream path &key direction if-exists) body...)|Opens a file for the extent of body.
with-output-to-string|(with-output-to-string (var) body...)|Collects output into a string.
declare|(declare (type fixnum x) (ignore y) ...)|Declarations.
the|(the type form)|Type assertion.
@function
format|(format destination control-string &rest args)|Formatted output; destination t for stdout, nil for a string. ~a aesthetic, ~s standard, ~d decimal, ~% newline.
print|(print object &optional stream)|Prints object readably after a newline.
princ|(princ object &optional stream)|Prints object for humans.
prin1|(prin1 object &optional stream)|Prints object readably.
terpri|(terpri &optional stream)|Outputs a newline.
read-line|(read-line &optional stream eof-error-p eof-value)|Reads a line.
read|(read &optional stream eof-error-p eof-value)|Reads an object.
car|(car list)|First element.
cdr|(cdr list)|Rest of a list.
cons|(cons a b)|New cons cell.
list|(list &rest objects)|New list.
append|(append &rest lists)|Concatenates lists.
reverse|(reverse sequence)|Reversed copy.
length|(length sequence)|Number of elements.
nth|(nth n list)|n-th element.
first|(first list)|First element.
rest|(rest list)|Rest of a list.
last|(last list &optional n)|Last cons(es).
mapcar|(mapcar function list &rest lists)|Applies function to elements, collects results.
mapc|(mapc function list &rest lists)|Applies function for effect.
reduce|(reduce function sequence &key initial-value from-end)|Combines elements.
remove-if|(remove-if predicate sequence)|Copy without matching elements.
remove-if-not|(remove-if-not predicate sequence)|Copy with only matching elements.
find|(find item sequence &key test key)|First matching element.
position|(position item sequence &key test key)|Index of the first match.
member|(member item list &key test key)|Tail starting at item.
assoc|(assoc item alist &key test key)|Association lookup.
sort|(sort sequence predicate &key key)|Destructively sorts.
funcall|(funcall function &rest args)|Calls a function.
apply|(apply function &rest args list)|Calls a function with a final argument list.
gethash|(gethash key hash-table &optional default)|Hash table lookup (setf-able).
make-hash-table|(make-hash-table &key test size)|New hash table; use :test #'equal for string keys.
remhash|(remhash key hash-table)|Removes a key.
maphash|(maphash function hash-table)|Calls (function key value) for each entry.
concatenate|(concatenate result-type &rest sequences)|Joins sequences, e.g. (concatenate 'string a b).
subseq|(subseq sequence start &optional end)|Subsequence.
string-upcase|(string-upcase string)|Uppercase copy.
string-downcase|(string-downcase string)|Lowercase copy.
parse-integer|(parse-integer string &key start end radix junk-allowed)|String to integer.
write-to-string|(write-to-string object)|Printed representation.
error|(error datum &rest args)|Signals an error.
""")


class CommonLisp(Language):
    name, md, source = "commonlisp", "lisp", "sbcl"
    case_insensitive = True
    word = r"[^\s()'`,;\"|]"
    lisp = True
    trigger = ["("]
    builtins = CL_TABLE
    RS, US = "\x1e", "\x1f"
    DRIVER = r"""
(defun %cls-report (sev c)
  (let* ((ctx (ignore-errors (sb-c::find-error-context nil)))
         (pos (and ctx (ignore-errors (sb-c::compiler-error-context-file-position ctx))))
         (src (and ctx (ignore-errors (sb-c::compiler-error-context-original-source ctx)))))
    (format t "~a~a~a~a~a~a~a~a" (code-char 30) sev (code-char 31) (or pos -1) (code-char 31)
            (or src "") (code-char 31) (or (ignore-errors (princ-to-string c)) (type-of c)))))
(handler-bind ((sb-ext:compiler-note (lambda (c) (muffle-warning c)))
               (sb-c:compiler-error (lambda (c) (%cls-report "E" c)))
               (style-warning (lambda (c) (%cls-report "W" c) (muffle-warning c)))
               (warning (lambda (c) (%cls-report "E" c) (muffle-warning c))))
  (let ((*error-output* (make-broadcast-stream)) (*compile-verbose* nil) (*compile-print* nil))
    (compile-file (second sb-ext:*posix-argv*) :output-file (third sb-ext:*posix-argv*))))
(terpri)
"""

    def check(self, path, text, src_dir):
        out = os.path.join(os.path.dirname(path), "out.fasl")
        output = run(["sbcl", "--noinform", "--non-interactive", "--no-sysinit", "--no-userinit",
                      "--eval", "(progn " + self.DRIVER + ")", "--end-toplevel-options", path, out],
                     cwd=os.path.dirname(path))
        diags, seen = [], set()
        for rec in output.split(self.RS)[1:]:
            parts = rec.split(self.US)
            if len(parts) < 4:
                continue
            sev = ERROR if parts[0] == "E" else WARNING
            pos, src, msg = int(parts[1]), parts[2].strip(), parts[3].strip()
            ln = col = None
            if msg.startswith("READ error"):
                m = re.search(r"Line: (\d+), Column: (\d+)", msg)
                if "end of file" in msg:
                    off = unbalanced_open_paren(text)
                    if off is not None:
                        ln, col = offset_to_linecol(text, off)
                    elif (m2 := re.search(r"position: (\d+)", msg)):
                        ln, col = offset_to_linecol(text, int(m2.group(1)))
                    msg = "end of file: unclosed parenthesis or string"
                elif m:
                    ln, col = int(m.group(1)) - 1, int(m.group(2)) - 1
                    msg = msg.split("\n\n")[1].strip() if "\n\n" in msg else msg
                msg = re.sub(r"\s*Stream: #<.*$", "", msg, flags=re.S)
            elif pos >= 0:
                ln, col = offset_to_linecol(text, self.locate(text, pos, src))
            else:
                ln, col = 0, None
            msg = re.sub(r"\n\s*See also:.*", "", msg, flags=re.S).strip()
            key = (ln, col, msg)
            if key not in seen:
                seen.add(key)
                diags.append((ln, col, sev, msg))
        return diags

    @staticmethod
    def locate(text, pos, src):
        """Offset of the subform `src` (as printed by SBCL) inside the
        top-level form starting at `pos`."""
        if not src:
            return pos
        words = re.findall(r"[^\s()]+|[()]", src)
        if not words:
            return pos
        # Regex over the printed tokens, whitespace-insensitive and case-insensitive.
        pat = r"\s*".join(re.escape(w) for w in words[:12])
        m = re.compile(pat, re.I).search(text, pos)
        if m:
            return m.start()
        head = re.escape("".join(words[:2]))
        m = re.compile(head, re.I).search(text, pos)
        return m.start() if m else pos


# ---- Perl (curated additions to Perl Navigator) ----

class Perl(Language):
    name, md = "perl", "perl"
    word = r"[A-Za-z0-9_:]"
    keywords = parse_table("""
my|my $var|Declares a lexical variable.
our|our $var|Declares a package variable visible in the lexical scope.
local|local $var|Temporarily gives a global variable a new value.
state|state $var|Lexical variable initialised once (use feature 'state').
sub|sub name { ... }|Declares a subroutine.
package|package Name;|Starts a package (namespace).
use|use Module LIST;|Loads a module at compile time and imports from it.
no|no Module LIST;|Unimports a module or pragma.
require|require Module;|Loads a module at run time.
if|if (COND) { ... }|Conditional.
elsif|elsif (COND) { ... }|Else-if branch.
else|else { ... }|Else branch.
unless|unless (COND) { ... }|Negated conditional.
while|while (COND) { ... }|Loop while true.
until|until (COND) { ... }|Loop until true.
for|for my $x (LIST) { ... }|Loop (foreach or C-style).
foreach|foreach my $x (LIST) { ... }|Iterates over a list.
last|last [LABEL]|Exits a loop.
next|next [LABEL]|Next iteration.
redo|redo [LABEL]|Restarts the iteration.
return|return LIST|Returns from a subroutine.
BEGIN|BEGIN { ... }|Runs at compile time.
END|END { ... }|Runs at program exit.
__PACKAGE__|__PACKAGE__|The current package name.
__FILE__|__FILE__|The current file name.
__LINE__|__LINE__|The current line number.
__DATA__|__DATA__|Starts the DATA section.
__END__|__END__|End of the program text.
""")


# ---- Plain proxies (no extra language knowledge) ----

class Plain(Language):
    pass


LANGUAGES = {"pascal": Pascal, "nasm": Nasm, "fortran": Fortran, "scheme": Scheme,
             "commonlisp": CommonLisp, "perl": Perl}


# ── The server ───────────────────────────────────────────────────────────────

class Server:
    def __init__(self, lang, opts, child_cmd):
        self.lang = lang
        self.opts = opts
        self.out = Writer(sys.stdout.buffer)
        self.docs = {}
        self.docs_lock = threading.Lock()
        self.own_diags = {}
        self.srv_diags = {}
        self.cv = threading.Condition()
        self.due = {}            # uri -> time a check is due
        self.child = None
        self.child_out = None
        self.pending = {}        # client request id -> (method, params) we post-process
        self.own_requests = {}   # our request id -> uri (pull diagnostics)
        self.own_seq = itertools.count(1)
        self.client_progress = True  # False: progress tokens are ours to swallow
        self.own_tokens = set()
        self.held = []
        self.holding = bool(opts.get("hold_until"))
        self.tmp = tempfile.mkdtemp(prefix="compiler-ls-")
        if child_cmd:
            self.child = subprocess.Popen(child_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            self.child_out = Writer(self.child.stdin)
            threading.Thread(target=self.pump_child, daemon=True).start()
        if opts.get("check"):
            threading.Thread(target=self.check_loop, daemon=True).start()
        if self.holding:
            threading.Timer(10, self.release).start()

    # ---- plumbing ----

    def reply(self, id_, result=None, error=None):
        msg = {"jsonrpc": "2.0", "id": id_}
        if error:
            msg["error"] = error
        else:
            msg["result"] = result
        self.out.send(msg)

    def to_child(self, msg):
        self.child_out.send(msg)

    def release(self):
        with self.cv:
            if not self.holding:
                return
            self.holding = False
            held, self.held = self.held, []
        for m in held:
            self.to_child(m)

    # ---- client -> server ----

    def serve(self):
        stdin = sys.stdin.buffer
        while True:
            msg = read_message(stdin)
            if msg is None:
                break
            if not isinstance(msg, dict):
                continue
            try:
                stop = self.from_client(msg)
            except Exception as e:  # never die on one bad message
                log("error handling", msg.get("method"), repr(e))
                stop = False
                if "id" in msg and "method" in msg and not self.child:
                    self.reply(msg["id"], None)
            if stop:
                break
        if self.child:
            try:
                self.child.terminate()
            except OSError:
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def from_client(self, msg):
        method = msg.get("method")
        params = msg.get("params") or {}
        if self.child and method == "textDocument/didChange":
            self.ranged_changes(params)
        self.track_document(method, params)

        if not self.child:
            return self.handle_standalone(msg, method, params)

        if "id" in msg and method in ("initialize", "textDocument/completion", "textDocument/hover"):
            self.pending[msg["id"]] = (method, params)
        if method == "initialize" and self.opts.get("hold_until") == "$/progress":
            # Ask the server to report progress so we can tell when it is ready.
            window = params.setdefault("capabilities", {}).setdefault("window", {})
            self.client_progress = bool(window.get("workDoneProgress"))
            window["workDoneProgress"] = True
            msg["params"] = params
        if self.holding and "id" in msg and method and method not in ("initialize", "shutdown"):
            with self.cv:
                if self.holding:
                    self.held.append(msg)
                    return False
        self.to_child(msg)
        if self.opts.get("pull") and method in ("textDocument/didOpen", "textDocument/didSave"):
            self.pull(params["textDocument"]["uri"])
        elif self.opts.get("pull") and method == "textDocument/didChange":
            uri = params["textDocument"]["uri"]
            threading.Timer(0.3, self.pull, args=(uri, params["textDocument"].get("version"))).start()
        return method == "exit"

    def ranged_changes(self, params):
        """Rewrite whole-document changes (no "range") as one ranged edit.

        Both forms are valid LSP whatever sync kind a server advertises, but
        asm-lsp 0.10.1 exits on a range-less change ("Bad edit info, failed
        to edit tree - Error: Invalid edit range"). Editors send full text
        after a reload or a remote reset, so the wrapped server must never
        see one. Positions are UTF-16 code units, as LSP requires."""
        uri = params.get("textDocument", {}).get("uri")
        with self.docs_lock:
            doc = self.docs.get(uri)
            if not doc:
                return
            shadow = Document(uri, doc.text, doc.version)
        out = []
        for ch in params.get("contentChanges") or []:
            if ch.get("range") is None:
                lines = shadow.text.split("\n")
                end = {"line": len(lines) - 1, "character": index_to_utf16(lines[-1], len(lines[-1]))}
                ch = {"range": {"start": {"line": 0, "character": 0}, "end": end}, "text": ch.get("text", "")}
            shadow.apply([ch], shadow.version)
            out.append(ch)
        params["contentChanges"] = out

    def track_document(self, method, params):
        if method == "textDocument/didOpen":
            td = params["textDocument"]
            with self.docs_lock:
                self.docs[td["uri"]] = Document(td["uri"], td.get("text", ""), td.get("version", 0))
            self.schedule(td["uri"], 0)
        elif method == "textDocument/didChange":
            td = params["textDocument"]
            with self.docs_lock:
                doc = self.docs.get(td["uri"])
                if doc:
                    doc.apply(params.get("contentChanges") or [], td.get("version", doc.version + 1))
            self.schedule(td["uri"], DEBOUNCE)
        elif method == "textDocument/didSave":
            uri = params["textDocument"]["uri"]
            if params.get("text") is not None:
                with self.docs_lock:
                    if uri in self.docs:
                        self.docs[uri].text = params["text"]
            self.schedule(uri, 0)
        elif method == "textDocument/didClose":
            uri = params["textDocument"]["uri"]
            with self.docs_lock:
                self.docs.pop(uri, None)
            with self.cv:
                self.due.pop(uri, None)
            self.own_diags.pop(uri, None)
            self.srv_diags.pop(uri, None)
            if self.opts.get("check"):
                self.publish(uri)

    # ---- server -> client (proxy) ----

    def pump_child(self):
        while True:
            msg = read_message(self.child.stdout)
            if msg is None:
                break
            try:
                self.from_child(msg)
            except Exception as e:
                log("error relaying", repr(e))
                self.out.send(msg)
        # The real server is gone: end this process too so the bridge notices.
        os._exit(0)

    def from_child(self, msg):
        method = msg.get("method")
        if method == "textDocument/publishDiagnostics":
            p = msg["params"]
            self.srv_diags[p["uri"]] = p.get("diagnostics") or []
            if self.opts.get("check"):
                self.publish(p["uri"])
                return
        elif method == "window/workDoneProgress/create" and "id" in msg and not self.client_progress:
            # We asked for progress on the client's behalf: accept it ourselves.
            self.own_tokens.add(json.dumps((msg.get("params") or {}).get("token")))
            self.to_child({"jsonrpc": "2.0", "id": msg["id"], "result": None})
            return
        elif method == "$/progress":
            p = msg.get("params") or {}
            if self.holding and self.opts.get("hold_until") == "$/progress" \
                    and (p.get("value") or {}).get("kind") == "end":
                self.release()
            if json.dumps(p.get("token")) in self.own_tokens:
                return
        elif method and self.holding and method == self.opts.get("hold_until"):
            self.release()
        elif method == "workspace/diagnostic/refresh" and "id" in msg and self.opts.get("pull"):
            self.to_child({"jsonrpc": "2.0", "id": msg["id"], "result": None})
            with self.docs_lock:
                uris = list(self.docs)
            for uri in uris:
                self.pull(uri)
            return
        elif "id" in msg and method is None:
            if msg["id"] in self.own_requests:
                self.on_pull_result(self.own_requests.pop(msg["id"]), msg)
                return
            if msg["id"] in self.pending:
                req_method, params = self.pending.pop(msg["id"])
                if "result" in msg:
                    if req_method == "initialize":
                        self.patch_capabilities(msg["result"])
                    elif req_method == "textDocument/completion":
                        if self.opts.get("builtins"):
                            msg["result"] = self.merge_completion(params, msg["result"])
                        if self.opts.get("filter"):
                            msg["result"] = self.filter_completion(params, msg["result"])
                    elif req_method == "textDocument/hover" and self.opts.get("builtins") and not msg["result"]:
                        msg["result"] = self.hover(params)
        self.out.send(msg)

    def patch_capabilities(self, result):
        caps = result.setdefault("capabilities", {})
        if self.opts.get("pull"):
            caps.pop("diagnosticProvider", None)
        if self.opts.get("builtins"):
            cp = caps.get("completionProvider") or {}
            cp["triggerCharacters"] = sorted(set(cp.get("triggerCharacters") or []) | set(self.lang.trigger))
            caps["completionProvider"] = cp
            caps["hoverProvider"] = True
        if self.opts.get("check") or self.opts.get("pull"):
            sync = caps.get("textDocumentSync")
            if isinstance(sync, int) or sync is None:
                sync = {"openClose": True, "change": sync if isinstance(sync, int) else 1}
            if not sync.get("save"):
                sync["save"] = {"includeText": False}
            caps["textDocumentSync"] = sync

    def pull(self, uri, version=None):
        with self.docs_lock:
            doc = self.docs.get(uri)
            if not doc or (version is not None and doc.version != version):
                return
        rid = f"compiler_ls:{next(self.own_seq)}"
        self.own_requests[rid] = uri
        self.to_child({"jsonrpc": "2.0", "id": rid, "method": "textDocument/diagnostic",
                       "params": {"textDocument": {"uri": uri}}})

    def on_pull_result(self, uri, msg):
        res = msg.get("result") or {}
        if res.get("kind") == "unchanged":
            return
        self.srv_diags[uri] = res.get("items") or []
        self.publish(uri)

    # ---- diagnostics ----

    def schedule(self, uri, delay):
        if not self.opts.get("check"):
            return
        with self.cv:
            due = time.monotonic() + delay
            if delay == 0 or uri not in self.due:
                self.due[uri] = due
            else:
                self.due[uri] = max(self.due[uri], due)
            self.cv.notify()

    def check_loop(self):
        while True:
            with self.cv:
                while True:
                    now = time.monotonic()
                    ready = [u for u, t in self.due.items() if t <= now]
                    if ready:
                        uri = min(ready, key=lambda u: self.due[u])
                        del self.due[uri]
                        break
                    timeout = min(self.due.values()) - now if self.due else None
                    self.cv.wait(timeout)
            with self.docs_lock:
                doc = self.docs.get(uri)
                snapshot = (doc.text, doc.version, doc.path) if doc else None
            if snapshot is None:
                continue
            text, version, path = snapshot
            try:
                diags = self.run_check(path, text)
            except Exception as e:
                log("check failed:", repr(e))
                continue
            if diags is None:
                continue
            with self.docs_lock:
                doc = self.docs.get(uri)
                stale = doc is None or doc.version != version
            with self.cv:
                newer_pending = uri in self.due
            if stale and newer_pending:
                continue
            self.own_diags[uri] = diags
            self.publish(uri)

    def run_check(self, path, text):
        work = tempfile.mkdtemp(dir=self.tmp)
        try:
            copy = os.path.join(work, os.path.basename(path))
            with open(copy, "w") as f:
                f.write(text)
            raw = self.lang.check(copy, text, os.path.dirname(path))
            if raw is None:
                return None
            lines = text.split("\n")
            out = []
            for line, col, sev, msg in raw[:200]:
                out.append({"range": make_range(lines, line, col, word_re=self.lang.word),
                            "severity": sev, "source": self.lang.source or self.lang.name, "message": msg})
            return out
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def publish(self, uri):
        diags = list(self.srv_diags.get(uri, [])) + list(self.own_diags.get(uri, []))
        self.out.send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
                       "params": {"uri": uri, "diagnostics": diags}})

    # ---- standalone requests ----

    def handle_standalone(self, msg, method, params):
        id_ = msg.get("id")
        if method == "initialize":
            self.reply(id_, {
                "capabilities": {
                    "textDocumentSync": {"openClose": True, "change": 2, "save": {"includeText": False}},
                    "completionProvider": {"triggerCharacters": self.lang.trigger, "resolveProvider": False},
                    "hoverProvider": True,
                    "signatureHelpProvider": {"triggerCharacters": ["(", " " if self.lang.lisp else ","]},
                },
                "serverInfo": {"name": f"compiler_ls ({self.lang.name})", "version": "1.0"},
            })
        elif method == "shutdown":
            self.reply(id_, None)
        elif method == "exit":
            return True
        elif method == "textDocument/completion":
            self.reply(id_, self.completion(params))
        elif method == "textDocument/hover":
            self.reply(id_, self.hover(params))
        elif method == "textDocument/signatureHelp":
            self.reply(id_, self.signature_help(params))
        elif id_ is not None and method:
            self.reply(id_, None)
        return False

    # ---- language features ----

    def doc_and_offset(self, params):
        with self.docs_lock:
            doc = self.docs.get(params["textDocument"]["uri"])
            if not doc:
                return None, None, None
            text = doc.text
            off = doc.offset(params["position"])
        return doc, text, off

    def word_at(self, text, off, whole=False):
        w = re.compile(self.lang.word)
        start = off
        while start > 0 and w.match(text[start - 1]):
            start -= 1
        end = off
        if whole:
            while end < len(text) and w.match(text[end]):
                end += 1
        return text[start:end], start, end

    def item(self, name, entry):
        kind = KIND_NAMES.get(entry.get("kind", "function"), K_FUNCTION)
        it = {"label": name, "kind": kind}
        if entry.get("sig"):
            it["detail"] = entry["sig"]
        if entry.get("doc"):
            it["documentation"] = {"kind": "markdown", "value": entry["doc"]}
        return it

    def completion_items(self, prefix, text, exclude=()):
        lang = self.lang
        key = lang.key(prefix)
        items, seen = [], set(exclude)
        for name, entry in lang.table.items():
            if lang.key(name).startswith(key) and lang.key(name) not in seen:
                seen.add(lang.key(name))
                items.append(self.item(name, entry))
        if text is not None:
            for m in re.finditer(lang.word + "+", text):
                w = m.group(0)
                if len(w) < 3 or w[0].isdigit() or w == prefix:
                    continue
                k = lang.key(w)
                if k.startswith(key) and k not in seen:
                    seen.add(k)
                    items.append({"label": w, "kind": K_TEXT})
                    if len(items) > 2000:
                        break
        return items

    def completion(self, params):
        doc, text, off = self.doc_and_offset(params)
        if doc is None:
            return {"isIncomplete": False, "items": []}
        prefix, _, _ = self.word_at(text, off)
        if self.lang.lisp and prefix.startswith(("#'", "'")):
            prefix = prefix.lstrip("#'")
        items = self.completion_items(prefix, text)
        return {"isIncomplete": len(prefix) == 0, "items": items}

    def merge_completion(self, params, result):
        doc, text, off = self.doc_and_offset(params)
        if doc is None:
            return result
        prefix, start, _ = self.word_at(text, off)
        # Only add builtins where a bare identifier is being typed.
        before = text[start - 1] if start > 0 else ""
        if before in "$@%&>:" or not prefix:
            return result
        items = result.get("items", []) if isinstance(result, dict) else list(result or [])
        have = {self.lang.key(i.get("label", "")) for i in items}
        extra = self.completion_items(prefix, None, exclude=have)
        merged = items + extra
        if isinstance(result, dict):
            result = dict(result, items=merged)
            return result
        return merged

    def filter_completion(self, params, result, limit=200):
        """Trim a server's unfiltered completion list to the typed prefix
        (case-insensitively, one item per spelling); the list is marked
        incomplete so the client asks again as the prefix grows."""
        doc, text, off = self.doc_and_offset(params)
        if doc is None or result is None:
            return result
        prefix = self.word_at(text, off)[0].lower()
        items = result.get("items", []) if isinstance(result, dict) else list(result)
        best = {}
        for it in items:
            label = (it.get("filterText") or it.get("label") or "")
            key = label.lower()
            if not key.startswith(prefix):
                continue
            cur = best.get(key)
            if cur is None or (label.islower() and not (cur.get("filterText") or cur["label"]).islower()):
                best[key] = it
        kept = sorted(best.values(), key=lambda i: (len(i.get("label", "")), i.get("label", "").lower()))
        return {"isIncomplete": True, "items": kept[:limit]}

    def hover(self, params):
        doc, text, off = self.doc_and_offset(params)
        if doc is None:
            return None
        word, start, end = self.word_at(text, off, whole=True)
        if not word and self.lang.lisp:
            return None
        name, entry = self.lang.lookup(word)
        if not entry:
            return None
        parts = []
        if entry.get("sig"):
            parts.append(f"```{self.lang.md}\n{entry['sig']}\n```")
        if entry.get("doc"):
            parts.append(entry["doc"])
        if not parts:
            return None
        sl, sc = offset_to_linecol(text, start)
        el, ec = offset_to_linecol(text, end)
        lines = text.split("\n")
        return {"contents": {"kind": "markdown", "value": "\n\n".join(parts)},
                "range": {"start": {"line": sl, "character": index_to_utf16(lines[sl], sc)},
                          "end": {"line": el, "character": index_to_utf16(lines[el], ec)}}}

    def signature_help(self, params):
        doc, text, off = self.doc_and_offset(params)
        if doc is None:
            return None
        depth, i, commas = 0, off - 1, 0
        lo = max(0, off - 4000)
        while i >= lo:
            c = text[i]
            if c in ")]":
                depth += 1
            elif c in "([":
                if depth == 0:
                    break
                depth -= 1
            elif c == "," and depth == 0:
                commas += 1
            elif c == "\n" and not self.lang.lisp and depth == 0 and text[i - 1:i] == ";":
                return None
            i -= 1
        if i < lo:
            return None
        if self.lang.lisp:
            m = re.match(self.lang.word + "+", text[i + 1:])
            name = m.group(0) if m else ""
            inner = text[i + 1 + len(name):off]
            active = max(0, len(re.findall(r"(?:^|\s)\S", inner.strip() + " x")) - 1) if inner.strip() else 0
        else:
            j = i
            while j > 0 and text[j - 1] in " \t":
                j -= 1
            name, _, _ = self.word_at(text, j)
            active = commas
        name, entry = self.lang.lookup(name)
        if not entry or not entry.get("sig"):
            return None
        sig = {"label": entry["sig"]}
        if entry.get("doc"):
            sig["documentation"] = {"kind": "markdown", "value": entry["doc"]}
        return {"signatures": [sig], "activeSignature": 0, "activeParameter": active}


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    lang_name, rest = argv[0], argv[1:]
    child = None
    if "--" in rest:
        i = rest.index("--")
        rest, child = rest[:i], rest[i + 1:]
    opts = {}
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--check":
            opts["check"] = True
        elif a == "--builtins":
            opts["builtins"] = True
        elif a == "--pull-diagnostics":
            opts["pull"] = True
        elif a == "--filter-completion":
            opts["filter"] = True
        elif a == "--hold-until":
            i += 1
            opts["hold_until"] = rest[i]
        else:
            print(f"compiler_ls: unknown option {a}", file=sys.stderr)
            return 2
        i += 1
    cls = LANGUAGES.get(lang_name, Plain)
    lang = cls()
    if cls is Plain:
        lang.name = lang_name
    if not child:
        opts["check"] = cls.check is not Language.check
    Server(lang, opts, child).serve()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
