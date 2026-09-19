#!/usr/bin/env bash
#
# Make the one file that moves this server to another machine.
#
#   ops/server-pack.sh
#
# Everything the shop's server needs is in this repository, and nothing on the box at
# work has this repository. So the transfer is a tarball: `dist/` (the app), the single
# server bundle, the two files that start it, the page that explains why it is shaped
# like this, and the scripts that install, back up and restore it.
#
# Why the ops scripts go in the archive too: they are no use sitting here. A person
# standing in front of the new box has the tarball and nothing else, and the first
# thing they need is `server-install.sh`.
#
# Refuses to pack without `dist/`. That is not fussiness: an archive that installs a
# server with no app is a server that answers 404 at the shop's first click, and the
# difference between the two takes about thirty seconds of `pnpm run build`.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

out_dir="dist-server"
version="$(node -p "require('./package.json').version" 2>/dev/null || echo '')"
if [ -z "$version" ]; then
  echo "Could not read a version out of package.json. Run this from the repository root." >&2
  exit 1
fi

bundle="server/freo-server.mjs"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

if [ ! -d dist ]; then
  cat >&2 <<'MISSING'
There is no dist/ to pack, so there is no app to serve yet.

  pnpm run build          makes dist/
  pnpm run build:server   makes server/freo-server.mjs

This script will not make a half archive: a server with no front end looks exactly
like a broken install until somebody opens it in a browser.
MISSING
  exit 1
fi

if [ ! -f "$bundle" ]; then
  echo "There is no $bundle. Run: pnpm run build:server" >&2
  exit 1
fi

if [ ! -f Dockerfile ] || [ ! -f docker-compose.yml ]; then
  echo "Dockerfile and docker-compose.yml have to be in the repository root to be packed." >&2
  exit 1
fi

package="freo-server"
mkdir -p "$stage/$package"

# Everything lands in one folder inside the archive, so unpacking it on the box leaves
# a directory and not a scatter of files in whatever folder the person happened to be
# standing in.
cp -R dist "$stage/$package/dist"
cp "$bundle" "$stage/$package/freo-server.mjs"
cp Dockerfile docker-compose.yml "$stage/$package/"
mkdir -p "$stage/$package/docs"
cp docs/server.md "$stage/$package/docs/server.md"
mkdir -p "$stage/$package/ops"
cp ops/server-install.sh ops/server-backup.sh ops/server-restore.sh "$stage/$package/ops/"
chmod +x "$stage/$package/ops/"*.sh

cat > "$stage/$package/README.txt" <<README
Freo shop server $version
================================================================================

Four commands on the new box, in this folder, in this order:

  1.  docker build -t freo-server:$version .
  2.  docker compose up -d
  3.  docker compose logs -f            (read the setup code, then Ctrl-C)
  4.  open http://localhost:8787/       (on the shop PC, not on the box)

The setup code printed at step 3 is typed into the app on the first device, once.
Every device after that is introduced by one that is already connected.

No Docker? Same folder, same files:

  sudo ./ops/server-install.sh

Before it is trusted with the shop's numbers
--------------------------------------------------------------------------------
Back it up. docs/server.md says why: the files in ./data are the whole shop, and this
server keeps the current versions and a write log, not every old version.

  sudo ./ops/server-backup.sh           put it in cron, daily
  sudo ./ops/server-restore.sh FILE     to prove a backup is worth having

Then write down the box's address, because every phone and PC in the shop has to be
pointed at it, and the numbers still in GitHub do not move by themselves.
README

mkdir -p "$out_dir"
target="$out_dir/freo-server-$version.tar.gz"
rm -f "$target"

# `COPYFILE_DISABLE=1` stops macOS from putting its resource forks in the archive,
# which unpack on Linux as ./._index.html and serve as nothing.
tar --exclude='.DS_Store' -C "$stage" -czf "$target" "$package"

echo "Packed $target"
ls -lh "$target" | awk '{print "  " $5 "  " $NF}'
echo "  contents: dist/  freo-server.mjs  Dockerfile  docker-compose.yml  docs/server.md  ops/  README.txt"
echo
echo "Carry it with:  scp $target user@the-box:~/"
