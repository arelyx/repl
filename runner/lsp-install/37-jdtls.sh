# Java: Eclipse JDT Language Server (milestone build), run on the image JDK.
JDTLS_VERSION=1.61.0
JDTLS_BUILD=202609031315
dir=/opt/lsp/jdtls
mkdir -p "$dir"
curl -fsSL "https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}/jdt-language-server-${JDTLS_VERSION}-${JDTLS_BUILD}.tar.gz" \
  | tar xz -C "$dir"
chmod -R a+rX "$dir"
# Launcher: the shipped config is a read-only shared configuration; per-user
# config and one -data workspace per project directory live in the user's cache.
# Eclipse metadata (.project, .classpath, .settings) goes into that workspace
# rather than the repl's file tree; like vscode-java, this is set as a system
# property (the initializationOptions setting alone did not stop it).
cat > /usr/local/bin/jdtls <<'SH'
#!/bin/sh
home=/opt/lsp/jdtls
cache="${XDG_CACHE_HOME:-$HOME/.cache}/jdtls"
ws="$cache/workspace/$(pwd | md5sum | cut -c1-12)"
mkdir -p "$cache/config" "$ws"
exec java \
  -Declipse.application=org.eclipse.jdt.ls.core.id1 \
  -Dosgi.bundles.defaultStartLevel=4 \
  -Declipse.product=org.eclipse.jdt.ls.core.product \
  -Dosgi.checkConfiguration=true \
  -Dosgi.sharedConfiguration.area="$home/config_linux" \
  -Dosgi.sharedConfiguration.area.readOnly=true \
  -Dosgi.configuration.cascaded=true \
  -Djava.import.generatesMetadataFilesAtProjectRoot=false \
  -Xms64m -Xmx1G -XX:+UseSerialGC \
  --add-modules=ALL-SYSTEM \
  --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang=ALL-UNNAMED \
  -jar "$(ls "$home"/plugins/org.eclipse.equinox.launcher_*.jar | head -n1)" \
  -configuration "$cache/config" \
  -data "$ws" "$@"
SH
chmod 755 /usr/local/bin/jdtls
ls "$dir"/plugins/org.eclipse.jdt.ls.core_*.jar
