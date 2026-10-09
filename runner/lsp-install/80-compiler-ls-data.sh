# Word lists for runner/agent/compiler_ls.py (the small compiler-backed server
# used for Pascal, Scheme, Common Lisp, and as an add-on for NASM, Fortran and
# Perl). Generated from the image's own toolchains so names, signatures and
# docstrings match the installed versions:
#   commonlisp.json  every external symbol of COMMON-LISP (SBCL lambda lists + docstrings)
#   scheme.json      Guile's core bindings plus SRFI-1/13 and common ice-9 modules
#   perl.json        every builtin in the image perl's perlfunc
# No version to pin: the data comes from the toolchains already in the image.
out=/opt/lsp/compiler-ls
mkdir -p "$out"
work="$(mktemp -d)"

# Records: \x1e-separated, fields \x1f-separated: name, kind, signature, doc.
cat > "$work/cl.lisp" <<'LISP'
(defun field (x) (substitute #\Space (code-char 31) (substitute #\Space (code-char 30) (or x ""))))
(let ((*print-case* :downcase) (*print-pretty* nil))
  (do-external-symbols (s :cl)
    (let* ((name (string-downcase (symbol-name s)))
           (fn (and (fboundp s) (not (special-operator-p s)) (or (macro-function s) (fdefinition s))))
           (kind (cond ((special-operator-p s) "special") ((macro-function s) "macro") ((fboundp s) "function")
                       ((constantp s) "constant") ((boundp s) "variable") ((find-class s nil) "class") (t "keyword")))
           (ll (and fn (ignore-errors (sb-kernel:%fun-lambda-list fn))))
           (args (and fn ll (listp ll) (ignore-errors (princ-to-string ll))))
           (sig (cond (args (format nil "(~a ~a)" name (subseq args 1 (1- (length args)))))
                      (fn (format nil "(~a)" name))
                      ((member kind '("constant" "variable") :test #'string=) name)
                      (t "")))
           (doc (or (documentation s 'function) (documentation s 'variable) (documentation s 'type) "")))
      (format t "~a~a~a~a~a~a~a~a" (code-char 30) (field name) (code-char 31) kind (code-char 31)
              (field sig) (code-char 31) (field doc)))))
LISP
sbcl --noinform --non-interactive --no-sysinit --no-userinit --load "$work/cl.lisp" > "$work/cl.out"

cat > "$work/scm.scm" <<'SCM'
(use-modules (ice-9 match) (ice-9 rdelim) (ice-9 format) (srfi srfi-1)
             (system vm program) (ice-9 documentation))
(define (clean s) (string-map (lambda (c) (if (memv c '(#\x1e #\x1f)) #\space c)) s))
(define (arg-names lst prefix)
  (let loop ((l lst) (i 1) (acc '()))
    (if (null? l) (reverse acc)
        (loop (cdr l) (+ i 1)
              (cons (if (eq? (car l) '_) (format #f "~a~a" prefix i) (symbol->string (car l))) acc)))))
(define (sig name proc)
  (let ((args (false-if-exception (program-arguments-alist proc))))
    (if (not args) ""
        (let ((req (arg-names (or (assq-ref args 'required) '()) "arg"))
              (opt (arg-names (or (assq-ref args 'optional) '()) "opt"))
              (kw (map car (or (assq-ref args 'keyword) '())))
              (rest (assq-ref args 'rest)))
          (string-append "(" (symbol->string name)
                         (apply string-append (map (lambda (a) (string-append " " a)) req))
                         (if (null? opt) "" (string-append " [" (string-join opt " ") "]"))
                         (apply string-append (map (lambda (k) (format #f " #:~a" k)) kw))
                         (if rest (format #f " . ~a" (if (eq? rest '_) "rest" rest)) "")
                         ")")))))
(define seen (make-hash-table))
(for-each
 (lambda (modname)
   (let ((iface (false-if-exception (resolve-interface modname))))
     (when iface
       (module-for-each
        (lambda (name var)
          (unless (hashq-ref seen name)
            (hashq-set! seen name #t)
            (let* ((val (and (variable-bound? var) (variable-ref var)))
                   (kind (cond ((macro? val) "macro") ((procedure? val) "function") (else "variable")))
                   (doc (or (false-if-exception (object-documentation val)) ""))
                   (s (if (procedure? val) (sig name val) "")))
              (display (string #\x1e)) (display (clean (symbol->string name))) (display (string #\x1f))
              (display kind) (display (string #\x1f)) (display (clean s)) (display (string #\x1f))
              (display (clean (if (string? doc) doc ""))))))
        iface))))
 '((guile) (srfi srfi-1) (srfi srfi-13) (ice-9 rdelim) (ice-9 match) (ice-9 format) (ice-9 popen)
   (ice-9 textual-ports) (ice-9 hash-table) (ice-9 receive) (ice-9 string-fun) (ice-9 pretty-print)))
SCM
guile --no-auto-compile "$work/scm.scm" > "$work/scm.out"

podfile="$(perl -MConfig -e 'print $Config{privlib}')/pod/perlfunc.pod"

python3 -I - "$work" "$out" "$podfile" <<'PY'
import json, os, re, sys
work, out, podfile = sys.argv[1:4]

def records(path):
    data = open(path, encoding="utf-8", errors="replace").read()
    for rec in data.split("\x1e")[1:]:
        f = rec.split("\x1f")
        if len(f) >= 4:
            yield f[0].strip(), f[1].strip(), f[2].strip(), f[3].strip()

def tidy(doc, limit=1200):
    doc = doc.strip()
    return doc if len(doc) <= limit else doc[:limit].rsplit(" ", 1)[0] + " ..."

GUILE_HEAD = re.compile(r"\s*-\s*Scheme (?:Procedure|Syntax|Macro): ([^\n]*)\n?(.*)", re.S)
for lang, src in (("commonlisp", "cl.out"), ("scheme", "scm.out")):
    table = {}
    for name, kind, sig, doc in records(os.path.join(work, src)):
        if not name or name.startswith("%"):
            continue
        m = GUILE_HEAD.match(doc)
        if m:  # Guile's snarfed docs start with "- Scheme Procedure: name args"
            sig = "(" + " ".join(m.group(1).replace(" . ", " . ").split()) + ")"
            doc = re.sub(r"(?m)^\s*-\s*Scheme (?:Procedure|Syntax|Macro): .*\n?", "", m.group(2))
            doc = "\n".join(l.strip() for l in doc.splitlines())
        table[name] = {"kind": kind, "sig": sig, "doc": tidy(doc)}
    json.dump(table, open(os.path.join(out, lang + ".json"), "w"), indent=0, sort_keys=True)
    print(f"{lang}: {len(table)} entries, {sum(1 for e in table.values() if e['doc'])} with docs")

# perlfunc.pod: a group of "=item NAME ARGS" lines, an optional
# "=for Pod::Functions summary", then the description paragraphs.
def unpod(s):
    s = s.replace("E<lt>", "<").replace("E<gt>", ">").replace("E<sol>", "/").replace("E<verbar>", "|")
    for _ in range(3):
        s = re.sub(r"[A-Z]<<+\s+(.*?)\s+>>+", r"\1", s)
        s = re.sub(r"L<([^>|]*)\|[^>]*>", r"\1", s)
        s = re.sub(r"[A-Z]<([^<>]*)>", r"\1", s)
    return s

text = open(podfile, encoding="utf-8", errors="replace").read()
text = text[text.find("=head2 Alphabetical Listing of Perl Functions"):]
table = {}
items, body, summary = [], [], [""]

def flush():
    names = []
    for it in items:
        m = re.match(r"([a-z_][a-z0-9_]*)\b", it)
        if m and m.group(1) not in names:
            names.append(m.group(1))
    paras = [p for p in body if p and not p.startswith(("=", " ", "\t"))]
    desc = unpod(" ".join(paras[0].split())) if paras else ""
    doc = desc
    if summary[0]:
        doc = summary[0][0].upper() + summary[0][1:] + ".\n\n" + desc
    for n in names:
        sigs = [unpod(i) for i in items if re.match(re.escape(n) + r"\b", i)]
        if n not in table:
            table[n] = {"kind": "function", "sig": "\n".join(sigs[:6]), "doc": tidy(doc.strip(), 900)}

for para in text.split("\n\n"):
    para = para.strip("\n")
    if para.startswith("=item "):
        if body or summary[0]:
            flush()
            items.clear(); body.clear(); summary[0] = ""
        first = para[6:].split("\n")[0]
        items.append(re.sub(r"X<[^>]*>", "", first).strip())
    elif para.startswith("=for Pod::Functions "):
        rest = para[len("=for Pod::Functions "):].strip()
        if not rest.startswith("="):
            summary[0] = unpod(" ".join(rest.split()))
    elif para.startswith(("=over", "=back", "=head", "=begin", "=end", "=for", "=cut")):
        continue
    else:
        para = re.sub(r"^(X<[^>]*>\s*)+", "", para)
        if para:
            body.append(para)
flush()
json.dump(table, open(os.path.join(out, "perl.json"), "w"), indent=0, sort_keys=True)
print(f"perl: {len(table)} entries")
PY
rm -rf "$work"
chmod -R a+rX "$out"
