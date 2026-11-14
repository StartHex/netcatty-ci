#!/bin/sh
# Builds the test doubles into the layout an application host has:
#
#   <out>/mdb/dci/lib      libsi_dci.so libdci.so      ($DCI_HOME = <out>/mdb)
#   <out>/ddci/lib         libddci.so                  (no column names, no break)
#   <out>/dsci/{lib,cfg}   libdsci.so db.cfg           ($DSCI_PATH = <out>/dsci)
#   <out>/dsci_plain/...   the same without _DSCI_GetSqlDb
#
# usage: build_fakes.sh <out dir>
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=$1
cc=${CC:-cc}
flags="-shared -fPIC -O1 -Wall -Wextra"

mkdir -p "$out/mdb/dci/lib" "$out/ddci/lib" "$out/dsci/lib" "$out/dsci/cfg" \
  "$out/dsci_plain/lib" "$out/dsci_plain/cfg"

$cc $flags -DFAKE_PREFIX=si_dci_ -o "$out/mdb/dci/lib/libsi_dci.so" "$here/fake_mdb.c"
$cc $flags -DFAKE_PREFIX=dci_ -o "$out/mdb/dci/lib/libdci.so" "$here/fake_mdb.c"
$cc $flags -DFAKE_PREFIX=ddci_ -DFAKE_DDCI -DFAKE_MINIMAL -o "$out/ddci/lib/libddci.so" "$here/fake_mdb.c"

links="-L$out/mdb/dci/lib -L$out/ddci/lib -lsi_dci -lddci"
$cc $flags -o "$out/dsci/lib/libdsci.so" "$here/fake_dsci.c" $links
$cc $flags -DFAKE_PLAIN -o "$out/dsci_plain/lib/libdsci.so" "$here/fake_dsci.c" $links

for dir in dsci dsci_plain; do
  cat > "$out/$dir/cfg/db.cfg" <<'CFG'
[SYS]
DEFAULT_DB = DB02

[DB01]
login = ${DSCI_PATH}/cfg/login.imdb
Server=imdb-main
Type=imdb

[DB02]
login = ${DSCI_PATH}/cfg/login.dmdb
#login = ${DSCI_PATH}/cfg/login.old
Server=dmdb-cluster	# trailing comment
Type=DMDB

[DB03]
login = ${DSCI_PATH}/cfg/login.mysql
Server=10.0.0.9:3306
Type=mysql

[OTHER]
Type=ignored
CFG
done
echo "$out"
