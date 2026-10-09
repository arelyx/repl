# HTML, CSS/SCSS/Less, JSON: the language servers extracted from VS Code.
VSCODE_LANGSERVERS_VERSION=4.10.0
npm install -g --no-fund --no-audit "vscode-langservers-extracted@${VSCODE_LANGSERVERS_VERSION}"

# The HTML server looks for TypeScript's lib.*.d.ts two directories above the
# package (a path that only exists in VS Code's source tree), so <script>
# blocks get no DOM/ES library: `document.` completes nothing. Point it at the
# package's own typescript.
pkg=/opt/node/lib/node_modules/vscode-langservers-extracted
libs="$pkg/lib/html-language-server/modes/javascriptLibs.js"
sed -i "s#join)(serverFolder, '../../node_modules/typescript/lib')#join)(serverFolder, '../node_modules/typescript/lib')#" "$libs"
grep -q "'../node_modules/typescript/lib'" "$libs"
test -f "$pkg/node_modules/typescript/lib/lib.es2020.full.d.ts"
