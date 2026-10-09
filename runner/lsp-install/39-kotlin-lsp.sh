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
# /opt/kotlinc's stdlib on the classpath over the image JDK. Indexing that from
# scratch takes about a minute, so `make runner` pre-builds the index after
# this image is built, in a separate memory-capped container
# (runner/kotlin-index/), and layers it in at index-seed/.
#
# The warm-up must NOT run here. docker build steps have no memory limit and
# run with oom_score_adj -500, and the 263.x server has twice misbehaved in
# this step (a heap OOM + native abort at 1 GB; once ~30 GB of native memory
# in 3 minutes, which took the host's desktop session down with it).
install -m 0644 /dev/stdin "$dir/workspace.json" <<'JSON'
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
chmod -R a+rX "$dir"

# Caches, logs and the index live in ~/.cache/kotlin-lsp (the default is a new
# /tmp dir per launch); runner/agent/lsp/kotlin.json passes the same path as
# indexDir. Keep the workspace.json above identical to the template's.
cat > /usr/local/bin/kotlin-lsp <<'SH'
#!/bin/sh
cache="$HOME/.cache/kotlin-lsp"
if [ ! -d "$cache" ] && [ -d /opt/lsp/kotlin-lsp/index-seed ]; then
  mkdir -p "$HOME/.cache"
  cp -r /opt/lsp/kotlin-lsp/index-seed "$cache.$$" && mv -T "$cache.$$" "$cache" 2>/dev/null
  rm -rf "$cache.$$"
fi
exec /opt/lsp/kotlin-lsp/bin/intellij-server --stdio --data-sharing=none --system-path="$cache" "$@"
SH
chmod 755 /usr/local/bin/kotlin-lsp
cat "$dir/build.txt"
