# Kotlin: JetBrains' official Kotlin LSP (standalone archive, bundled JBR).
KOTLIN_LSP_VERSION=263.6379.0
dir=/opt/lsp/kotlin-lsp
mkdir -p "$dir"
curl -fsSL "https://download.jetbrains.com/language-server/kotlin-server/${KOTLIN_LSP_VERSION}/kotlin-server-${KOTLIN_LSP_VERSION}.tar.gz" \
  | tar xz -C "$dir" --strip-components=1
# Repl containers have 2 GB of RAM; the shipped options ask for a 2 GB heap.
sed -i -e 's/^-Xmx.*/-Xmx1g/' -e 's/^-XX:ReservedCodeCacheSize=.*/-XX:ReservedCodeCacheSize=240m/' \
  "$dir/bin/intellij-server.vmoptions"

# Without a Gradle or Maven build the server only imports a project described
# by workspace.json in its root; the kotlin template ships one that puts
# /opt/kotlinc's stdlib on the classpath over the image JDK. Indexing that JDK
# and stdlib from scratch takes about a minute and peaks near the container's
# 2 GB, so build the index here, once, against an identical workspace.json;
# the launcher copies it into the user's cache on first start.
scratch="$(mktemp -d)"
mkdir -p "$scratch/project" "$scratch/home"
cat > "$scratch/project/workspace.json" <<'JSON'
{
  "modules": [
    {
      "name": "main",
      "dependencies": [
        {"type": "inheritedSdk"},
        {"type": "moduleSource"},
        {"type": "library", "name": "kotlin-stdlib", "scope": "compile"}
      ],
      "contentRoots": [
        {"path": ".", "sourceRoots": [{"path": ".", "type": "java-source"}]}
      ]
    }
  ],
  "libraries": [
    {
      "name": "kotlin-stdlib",
      "type": null,
      "roots": [
        {"path": "/opt/kotlinc/lib/kotlin-stdlib.jar"},
        {"path": "/opt/kotlinc/lib/kotlin-stdlib-sources.jar", "type": "SOURCES"}
      ]
    }
  ],
  "sdks": [
    {"name": "JDK", "type": "JavaSDK", "version": "27", "homePath": "/opt/java", "additionalData": ""}
  ]
}
JSON
printf 'fun main() {\n    println("warm-up")\n}\n' > "$scratch/project/main.kt"
seed="$dir/index-seed"
# warmup.py exits non-zero when the server needs killing after shutdown, so
# judge success by the ready notification instead.
HOME="$scratch/home" TMPDIR="$scratch" timeout 1200 python3 "$dir/bin/warmup.py" --build-tool json \
  --timeout 1100 "$scratch/project" "$seed" > "$scratch/warmup.log" 2>&1 || true
if ! grep -q 'intellij/ready-for-test' "$scratch/warmup.log"; then
  tail -n 40 "$scratch/warmup.log"
  exit 1
fi
rm -rf "$scratch" "$seed/.app.lock" "$seed/system/log"
test -d "$seed/rocks"
chmod -R a+rX "$dir"

# Caches, logs and the index live in ~/.cache/kotlin-lsp (the default is a new
# /tmp dir per launch); runner/agent/lsp/kotlin.json passes the same path as
# indexDir. Keep the workspace.json above identical to the template's.
cat > /usr/local/bin/kotlin-lsp <<'SH'
#!/bin/sh
cache="$HOME/.cache/kotlin-lsp"
if [ ! -d "$cache" ]; then
  mkdir -p "$HOME/.cache"
  cp -r /opt/lsp/kotlin-lsp/index-seed "$cache.$$" && mv -T "$cache.$$" "$cache" 2>/dev/null
  rm -rf "$cache.$$"
fi
exec /opt/lsp/kotlin-lsp/bin/intellij-server --stdio --data-sharing=none --system-path="$cache" "$@"
SH
chmod 755 /usr/local/bin/kotlin-lsp
cat "$dir/build.txt"
