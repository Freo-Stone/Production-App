#!/usr/bin/env bash
#
# Back up the shop.
#
#   ops/server-backup.sh [where-to-put-it]
#
# Defaults to /opt/freo/backups (or ./backups next to the data folder if the server was
# installed somewhere else). The whole point is that it is one line in a crontab:
#
#   10 23 * * * /opt/freo/ops/server-backup.sh >> /var/log/freo-backup.log 2>&1
#
# Why a tar of the folder and not a database dump: the store is a folder of files, so
# the backup is that folder, and a restore is that folder back. It has to be possible to
# recover this archive on a machine that has neither this repository nor this server on
# it, which is exactly what a bad day looks like.
#
# Why thirteen: a daily rota that keeps two weeks is small enough to copy onto a USB
# stick and take home, which is the only off-site arrangement this shop is likely to
# actually keep. The count is kept by deleting the oldest, so the folder cannot quietly
# fill a disk two years from now.

set -euo pipefail

data_dir="${FREO_DATA:-/opt/freo/data}"
keep=14

if [ ! -d "$data_dir" ]; then
  # Also accept being run from the unpacked folder, where the data is next to the script.
  here_data="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data"
  if [ -d "$here_data" ]; then
    data_dir="$here_data"
  else
    echo "No data folder at $data_dir. Point FREO_DATA at the folder that holds state.json." >&2
    exit 1
  fi
fi

out_dir="${1:-$(dirname "$data_dir")/backups}"
mkdir -p "$out_dir"

stamp="$(date +%Y%m%d-%H%M%S)"
target="$out_dir/freo-data-$stamp.tar.gz"

# `--warning=no-file-changed`: a workbook being written at 23:10 is normal, and tar
# exiting 1 for a file that changed under it would leave a good archive looking like a
# failed backup. The copy is complete; one file may be one save newer or older than the
# others, and the shop's own compare-and-set handles that on the next write.
archive_status=0
tar --warning=no-file-changed -C "$(dirname "$data_dir")" -czf "$target" "$(basename "$data_dir")" || archive_status=$?
if [ "$archive_status" -ne 0 ] && [ "$archive_status" -ne 1 ]; then
  rm -f "$target"
  echo "tar failed with status $archive_status; nothing was written to $target" >&2
  exit 1
fi

# Count the backups after writing this one, so a disk that is already full cannot
# delete last week's copy and then fail to make today's.
mapfile -t old < <(ls -1t "$out_dir"/freo-data-*.tar.gz 2>/dev/null | tail -n "+$((keep + 1))")
if [ "${#old[@]}" -gt 0 ]; then
  for stale in "${old[@]}"; do
    rm -f "$stale"
  done
fi

size="$(du -h "$target" | awk '{print $1}')"
count="$(ls -1 "$out_dir"/freo-data-*.tar.gz | wc -l | tr -d ' ')"

echo "Backed up $size to $target"
echo "  $count archive(s) kept in $out_dir, oldest deleted past $keep"
echo
echo "To put this backup back on another machine:"
echo "  sudo systemctl stop freo"
echo "  sudo $(dirname "${BASH_SOURCE[0]}")/server-restore.sh $target"
echo "  sudo systemctl start freo"
echo
echo "It is on this machine only. Copy it off before the machine is the thing that breaks."
