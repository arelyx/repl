#!/bin/bash
# Print every toolchain's version; exit non-zero if any is missing or broken.
# Runs at image build time (as a smoke test) and via `make versions`.
set -u
fail=0
check() {
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1 | grep -m1 -E '[0-9]')" && [ -n "$out" ]; then
    printf '%-12s %s\n' "$name" "$out"
  else
    printf '%-12s MISSING (%s)\n' "$name" "$*"; fail=1
  fi
}
check python     python3 --version
check node       node --version
check typescript tsc --version
check go         go version
check rust       rustc --version
check java       java --version
check maven      mvn --version
check kotlin     kotlinc -version
check dotnet     dotnet --version
check gcc        gcc --version
check g++        g++ --version
check gfortran   gfortran --version
check clang      clang --version
check ruby       ruby --version
check php        php --version
check perl       perl -e 'print "perl $^V\n"'
check lua        lua -v
check ghc        ghc --version
check r          R --version
check sbcl       sbcl --version
check fpc        fpc -iV
check guile      guile --version
check nasm       nasm -v
check bash       bash --version
exit $fail
