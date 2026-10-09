# Rust: rust-analyzer (weekly GitHub release), plus the toolchain's rust-src
# component, which rust-analyzer needs to understand std/core/alloc.
RUST_ANALYZER_VERSION=2026-10-05
dir=/opt/lsp/rust-analyzer
mkdir -p "$dir"
curl -fsSL "https://github.com/rust-lang/rust-analyzer/releases/download/${RUST_ANALYZER_VERSION}/rust-analyzer-x86_64-unknown-linux-gnu.gz" \
  | gunzip > "$dir/rust-analyzer"
chmod 755 "$dir/rust-analyzer"
CARGO_HOME=/opt/cargo rustup component add rust-src
chmod -R a+rX "$dir"
# Only touch what lacks the bits (a blanket chmod -R would copy the toolchain into this layer).
find "$RUSTUP_HOME" ! -type l \( ! -perm -o+r -o -perm -u+x ! -perm -o+x \) -exec chmod a+rX {} +
# /opt/cargo/bin/rust-analyzer is rustup's proxy and comes first on PATH, but
# it fails unless the toolchain's own rust-analyzer component is installed;
# the launch spec uses this binary by absolute path instead.
"$dir/rust-analyzer" --version
