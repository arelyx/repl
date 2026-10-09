# Haskell: haskell-language-server via ghcup, built for the image's GHC.
# New HLS releases reach ghcup's vanilla channel first (the default channel can
# lag a release), so install from there.
HLS_VERSION=2.15.0.0
export GHCUP_INSTALL_BASE_PREFIX=/opt
ghc_version="$(ghc --numeric-version)"
ghcup --url-source=https://raw.githubusercontent.com/haskell/ghcup-metadata/master/ghcup-vanilla-0.1.0.yaml \
  install hls "${HLS_VERSION}" --set
# The bindist ships one server per supported GHC (~400 MB each); keep only
# the one for the image's GHC.
hls="/opt/.ghcup/hls/${HLS_VERSION}"
lib="${hls}/lib/haskell-language-server-${HLS_VERSION}"
test -x "${lib}/bin/haskell-language-server-${ghc_version}"
for v in $(ls "${lib}/lib"); do
  [ "$v" = "$ghc_version" ] && continue
  rm -rf "${lib}/lib/${v}" "${lib}/bin/haskell-language-server-${v}" "${hls}/bin/haskell-language-server-${v}" \
         "/opt/.ghcup/bin/haskell-language-server-${v}" "/opt/.ghcup/bin/haskell-language-server-${v}~${HLS_VERSION}"
done
ghcup gc --cache --tmpdirs
# Only touch what lacks the bits: a blanket chmod -R would copy GHC (a lower
# image layer, ~3 GB) into this one.
find /opt/.ghcup ! -type l \( ! -perm -o+r -o -perm -u+x ! -perm -o+x \) -exec chmod a+rX {} +
haskell-language-server-wrapper --version
test -x "/opt/.ghcup/bin/haskell-language-server-${ghc_version}"
