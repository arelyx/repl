# Go: gopls, built with the image's Go toolchain.
GOPLS_VERSION=v0.23.0
dir=/opt/lsp/gopls
mkdir -p "$dir/bin"
build="$(mktemp -d)"
GOBIN="$dir/bin" GOPATH="$build/gopath" GOCACHE="$build/cache" GOTOOLCHAIN=local GOFLAGS=-trimpath \
  go install "golang.org/x/tools/gopls@${GOPLS_VERSION}"
rm -rf "$build"
chmod -R a+rX "$dir"
ln -sf "$dir/bin/gopls" /usr/local/bin/gopls
gopls version
