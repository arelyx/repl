# C/C++: clangd. The binary comes with the image's LLVM (apt.llvm.org, see
# LLVM_VERSION in the Dockerfile); this script only checks it and writes the
# defaults clangd uses for files that have no compile flags of their own.
#
# Clang would otherwise pick the distro's older libstdc++ (GCC 15 in /usr)
# and default to C++17/C17, while code here is built with GCC 16 from
# /usr/local, which defaults to C++20/C23. The defaults go into clang driver
# config files (--config=...): options from a config file are *prepended* to
# the command line, so a project's own compile_flags.txt, .clangd or
# compile_commands.json still wins.
CLANGD_MAJOR=23

clangd --version | grep -q "clangd version ${CLANGD_MAJOR}\." \
  || { echo "expected clangd ${CLANGD_MAJOR}"; clangd --version; exit 1; }

GCC_DIR="$(dirname "$(gcc -print-libgcc-file-name)")"   # /usr/local/lib/gcc/<triple>/<ver>
[ -d "$GCC_DIR/../../../../include/c++" ] || { echo "no libstdc++ headers next to $GCC_DIR"; exit 1; }

D=/opt/lsp/clangd
mkdir -p "$D/xdg/clangd"
printf -- '--gcc-install-dir=%s\n-std=gnu23\n' "$GCC_DIR" > "$D/c.cfg"
printf -- '--gcc-install-dir=%s\n-std=gnu++26\n' "$GCC_DIR" > "$D/cpp.cfg"
printf -- '--gcc-install-dir=%s\n' "$GCC_DIR" > "$D/header.cfg"

# clangd's user config; the language server runs with XDG_CONFIG_HOME=$D/xdg.
cat > "$D/xdg/clangd/config.yaml" <<EOF
If:
  PathMatch: ['.*\.c', '.*\.i']
CompileFlags:
  Add: ['--config=$D/c.cfg']
---
If:
  PathMatch: ['.*\.(cc|cpp|cxx|c\+\+|C|ii|hpp|hh|hxx|h\+\+|ipp|tpp|inl|cppm|ixx)']
CompileFlags:
  Add: ['--config=$D/cpp.cfg']
---
If:
  PathMatch: ['.*\.h']
CompileFlags:
  Add: ['--config=$D/header.cfg']
EOF
chmod -R a+rX "$D"
