# JavaScript/TypeScript: typescript-language-server driving a pinned
# TypeScript 6.x tsserver.
#
# The image's global `typescript` is 7.x, the Go-native compiler. It ships no
# tsserver.js, so typescript-language-server cannot drive it, and its own LSP
# (`tsc --lsp`) only offers pull diagnostics, which the editor does not
# request, and has no tsserver plugins (Vue's hybrid mode needs one).
# TypeScript 6.0 is the last JS-based line with the same type system.
TS_LS_VERSION=6.0.1
TYPESCRIPT_VERSION=6.0.3
dir=/opt/lsp/typescript
mkdir -p "$dir/bin"
cat > "$dir/package.json" <<JSON
{
  "private": true,
  "dependencies": {
    "typescript-language-server": "${TS_LS_VERSION}",
    "typescript": "${TYPESCRIPT_VERSION}"
  }
}
JSON
(cd "$dir" && npm install --no-fund --no-audit --omit=dev)

# Automatic type acquisition (ATA): for JS projects tsserver fetches @types/*
# packages for what the code requires into ~/.cache/typescript/<major.minor>.
# Seed that cache with the typings the templates need (Node built-ins,
# Express, React), installed exactly the way tsserver's typings installer
# does, so `process.`/`app.`/`React.` complete on first open and offline.
TS_MM="${TYPESCRIPT_VERSION%.*}"
seed="$dir/ata-seed"
mkdir -p "$seed"
echo '{ "private": true }' > "$seed/package.json"
(cd "$seed" && npm install --ignore-scripts --save-dev --no-fund --no-audit \
  types-registry "@types/node@ts${TS_MM}" "@types/express@ts${TS_MM}" \
  "@types/react@ts${TS_MM}" "@types/react-dom@ts${TS_MM}")

# ATA covers JavaScript only, and since TypeScript 6 `types` defaults to [],
# so a .ts file using `process` needs `"types": ["node"]` in its tsconfig
# (the typescript template has it) plus an @types/node to resolve. Type
# references resolve through node_modules/@types in every ancestor
# directory, nearest first, so a copy above the repl (/home/runner/app)
# serves repls that never ran npm; one installed in the project still wins.
mkdir -p /home/node_modules/@types
cp -R "$seed/node_modules/@types/node" /home/node_modules/@types/node
cp -R "$seed/node_modules/undici-types" /home/node_modules/undici-types   # @types/node imports it
chmod -R a+rX /home/node_modules

cat > "$dir/bin/typescript-language-server" <<SH
#!/bin/sh
cache="\${XDG_CACHE_HOME:-\$HOME/.cache}/typescript/${TS_MM}"
if [ ! -d "\$cache/node_modules/types-registry" ]; then
  mkdir -p "\$cache" && cp -R $seed/. "\$cache/" 2>/dev/null || true
fi
exec node $dir/node_modules/typescript-language-server/lib/cli.mjs "\$@"
SH
chmod 755 "$dir/bin/typescript-language-server"
chmod -R a+rX "$dir"
node "$dir/node_modules/typescript-language-server/lib/cli.mjs" --version
