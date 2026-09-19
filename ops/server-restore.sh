#!/usr/bin/env bash
#
# Put a backup back.
#
#   sudo ops/server-restore.sh dist-server/freo-data-20260918-231000.tar.gz [--force]
#
# The order of the checks is the whole design of this script.
#
# It looks inside the archive before it touches anything, because an archive that does
# not hold `state.json` is either the wrong file or a backup of an empty shop, and both
# of those are discovered far too late when the discovery happens on a screen in front
# of the floor.
#
# It refuses a data folder that already has something in it. Overwriting the current
# shop with an old one is the standard way a restore becomes a second incident, and the
# difference between "I am putting the machine back" and "I have just typed the wrong
# filename" is invisible to a script - so the script asks for --force and makes the
# person decide, rather than guessing.
#
# It stops short of stopping the service for you. A server writing while its files are
# swapped underneath it produces a state nobody can explain afterwards; saying which two
# commands to run is more useful than running them silently and having systemd restart
# something you did not mean to start.

set -euo pipefail

service="freo"
data_dir="${FREO_DATA:-/opt/freo/data}"
force=0
archive=""

for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) [ -z "$archive" ] && archive="$arg" ;;
  esac
done

if [ -z "$archive" ]; then
  echo "One argument: the backup to put back." >&2
  echo "  sudo $0 /opt/freo/backups/freo-data-20260918-231000.tar.gz" >&2
  exit 1
fi
if [ ! -f "$archive" ]; then
  echo "No such file: $archive" >&2
  exit 1
fi

# -- look inside first -----------------------------------------------------------
#
# `state.json` is what makes this archive a shop and not a folder. Anything else in it
# is welcome; that one is required.
listing="$(tar -tzf "$archive")"
if ! printf '%s\n' "$listing" | grep -Eq '(^|/)state\.json$'; then
  echo "This archive does not contain a state.json, so it is not a backup of a shop:" >&2
  echo "  $archive" >&2
  echo "The first few entries in it are:" >&2
  printf '%s\n' "$listing" | head -5 | sed 's/^/    /' >&2
  exit 1
fi

if ! printf '%s\n' "$listing" | grep -Eq '(^|/)exports/'; then
  echo "Note: no exports/ in this archive, so both MYOB workbooks will be missing after the restore."
fi

# -- is the service in the way? --------------------------------------------------
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$service" 2>/dev/null; then
  cat >&2 <<END
The $service service is running. Its files are about to change under it, so stop it
first and start it again afterwards:

  sudo systemctl stop $service
  sudo systemctl start $service

Then check the log says it is listening:  journalctl -u $service -n 20 --no-pager
END
  exit 1
fi

# -- is there something already here? --------------------------------------------
if [ -d "$data_dir" ] && [ -n "$(ls -A "$data_dir" 2>/dev/null)" ]; then
  files="$(find "$data_dir" -type f | wc -l | tr -d ' ')"
  if [ "$force" -ne 1 ]; then
    cat >&2 <<END
$data_dir already holds $files file(s). A restore replaces them, and the current shop is
lost if this archive is older than it.

  Look first:   ls -l $data_dir
  Then, if this really is the swap:  sudo $0 $archive --force

The current folder is kept as ${data_dir}-before-restore-<timestamp> either way, so this
is reversible; it is not reversible twice.
END
    exit 1
  fi
  saved="${data_dir}-before-restore-$(date +%Y%m%d-%H%M%S)"
  mv "$data_dir" "$saved"
  echo "Moved the current data folder aside: $saved"
fi

# -- put it back -----------------------------------------------------------------
#
# The archive was made with the data folder as its top entry, but a folder restored from
# a machine where it was called something else must still land in the right place, so it
# is unpacked into a scratch directory and the half holding state.json is moved in.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
tar -xzf "$archive" -C "$stage"

found="$(find "$stage" -type f -name state.json | head -1)"
if [ -z "$found" ]; then
  # Already checked above; this is here so a strange archive stops here rather than
  # copying an empty folder into place.
  echo "Unpacked but found no state.json. Nothing was changed." >&2
  exit 1
fi

mkdir -p "$(dirname "$data_dir")"
mv "$(dirname "$found")" "$data_dir"

# A restore run as root leaves root-owned files, and the service runs as `freo`: the
# server would start and then be unable to write, which looks like a bad archive.
if [ "$(id -u)" -eq 0 ] && id -u freo >/dev/null 2>&1; then
  chown -R freo:freo "$data_dir"
fi

echo "Restored $archive"
echo "  data: $data_dir"
find "$data_dir" -maxdepth 2 -type f | sed 's/^/    /' | head -10

cat <<END

Start the server again:

  sudo systemctl start $service

Then open the app and check the numbers are the ones you expected. If they are not, the
folder you just replaced is still on this disk, and swapping the two names back is the
way to undo this.
END
