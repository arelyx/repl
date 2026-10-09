# Lua: lua-language-server (LuaLS), official Linux x64 build.
LUALS_VERSION=3.19.1
dir=/opt/lsp/lua-language-server
mkdir -p "$dir"
curl -fsSL "https://github.com/LuaLS/lua-language-server/releases/download/${LUALS_VERSION}/lua-language-server-${LUALS_VERSION}-linux-x64.tar.gz" \
  | tar xz -C "$dir"
chmod -R a+rX "$dir"
# LuaLS writes logs and generated meta files next to itself by default; the
# install dir is read-only to the repl user, so keep both in the user's cache.
cat > /usr/local/bin/lua-language-server <<'SH'
#!/bin/sh
cache="${XDG_CACHE_HOME:-$HOME/.cache}/lua-language-server"
exec /opt/lsp/lua-language-server/bin/lua-language-server \
  --logpath="$cache/log" --metapath="$cache/meta" "$@"
SH
chmod 755 /usr/local/bin/lua-language-server
lua-language-server --version
