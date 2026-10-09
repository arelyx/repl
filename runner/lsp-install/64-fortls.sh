# Fortran: fortls (completion, hover, signature help, structural diagnostics).
# Compiler diagnostics from gfortran are layered on top by compiler_ls.py.
FORTLS_VERSION=3.2.2
python3 -m pip install --no-cache-dir "fortls==${FORTLS_VERSION}"
ln -sf /opt/python/current/bin/fortls /usr/local/bin/fortls
fortls --version
