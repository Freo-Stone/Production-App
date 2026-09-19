#!/usr/bin/env bash
#
# Put the shop server on a Linux box and make it start by itself from now on.
#
#   sudo ./ops/server-install.sh [path-to-the-unpacked-folder]
#
# Run it from inside the folder that came out of the tarball (it defaults to the
# folder this script sits in, so `sudo ./ops/server-install.sh` is normally enough).
#
# What it does, in one sentence: copies the app and the single server file into
# /opt/freo, writes a systemd unit that starts it again after a reboot, and leaves
# /opt/freo/data exactly as it found it.
#
# The reason it is a script and not six lines in the docs is that same person at 7am.
# The install has to be the same on the current server and on the office box, and
# "never overwrite data/" has to be a line of code rather than a paragraph somebody
# skips.

set -euo pipefail

SERVICE="freo"
PREFIX="/opt/freo"
PORT="${FREO_PORT:-8787}"
HOST="${FREO_HOST:-0.0.0.0}"

source_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This writes a systemd unit, so it needs root:  sudo $0 $*" >&2
  exit 1
fi

if [ ! -f "$source_dir/freo-server.mjs" ] || [ ! -d "$source_dir/dist" ]; then
  cat >&2 <<END
I need the unpacked archive, not a half folder.

  looking in:  $source_dir
  expected:    freo-server.mjs  and  dist/

Unpack the tarball first (tar xzf freo-server-<version>.tar.gz) and run this from
inside the folder it makes.
END
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node is not installed. The server is one file with no dependencies; it needs Node 20 or newer." >&2
  echo "  apt install nodejs   (or nvm, or the NodeSource package - whatever this box normally uses)" >&2
  exit 1
fi

node_major="$(node -p "parseInt(process.versions.node, 10)")"
if [ "$node_major" -lt 20 ]; then
  echo "Node $(node -p "process.versions.node") is too old for this server (it needs 20 or newer)." >&2
  echo "The bundle is built for node20 syntax; on an older Node it fails at start with a syntax error" >&2
  echo "that says nothing about the version, so fix the version first." >&2
  exit 1
fi

echo "Installing the Freo shop server into $PREFIX (node $(node -p "process.versions.node"), port $PORT)"

# - the data folder is never touched ---------------------------------------------
#
# This is the whole safety of an upgrade. Everything else here is a copy that can be
# done again; this is the shop's numbers. A reinstall that starts an empty shop is the
# one way to turn a routine Tuesday into an incident, so the folder is created if
# missing and otherwise left alone - no merge, no overwrite, no "keep newer".
mkdir -p "$PREFIX/data/exports"
if [ -f "$PREFIX/data/state.json" ]; then
  size_kb=$(( $(wc -c < "$PREFIX/data/state.json") / 1024 ))
  echo "  data/     kept: a ${size_kb} kB shop document is already here, untouched"
else
  # docs/server.md promised one extra thing on this path, so this is it: an empty box
  # is offered the numbers that are in the repository today. It stays an offer rather
  # than an action because doing it here would mean asking for somebody's GitHub token
  # in a shell script, and the shop's numbers should not pass through a script that is
  # not the app. It is also two commands a person can check before the service starts.
  cat <<END
  data/     empty. The first save from any device creates the shop document.

            This box can start with today's numbers instead of an empty shop. Put the
            current document from the repository in place, before starting the service:

              curl -s -H "Authorization: Bearer <your GitHub token>" \\
                "https://api.github.com/repos/<owner>/<repo>/contents/state/state.json?ref=main" \\
                | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(Buffer.from(JSON.parse(s).content,'base64')))" \\
                > $PREFIX/data/state.json

            Then look at what actually arrived:

              node -e "console.log(JSON.parse(require('fs').readFileSync('$PREFIX/data/state.json','utf8')).products.length+' products')"

            It needs no translation on the way in, which is the payoff of hashing files
            the way git does: the number this server computes for that file is the
            number the app already has for it.

            Two things the recipe does not cover. Device keys are not in the
            repository, so every PC and phone connects again with the setup code. And
            the two MYOB workbooks stay where they are until the office PC writes them
            here. docs/server.md, "Moving the store is not the same as moving the shop".
END
fi

# The app files are disposable, so they go in and the previous copy is kept one step
# to the side. When a build is wrong, `mv dist.new dist` is a five-second rollback,
# which matters most when it is 7am and the floor is waiting.
rm -rf "$PREFIX/dist.old"
if [ -d "$PREFIX/dist" ]; then mv "$PREFIX/dist" "$PREFIX/dist.old"; fi
cp -R "$source_dir/dist" "$PREFIX/dist"
cp "$source_dir/freo-server.mjs" "$PREFIX/freo-server.mjs"
if [ -f "$source_dir/docs/server.md" ]; then
  mkdir -p "$PREFIX/docs"
  cp "$source_dir/docs/server.md" "$PREFIX/docs/"
fi
bundle_kb=$(( $(wc -c < "$PREFIX/freo-server.mjs") / 1024 ))
echo "  app       $(find "$PREFIX/dist" -type f | wc -l | tr -d ' ') files in dist/, server bundle ${bundle_kb} kB"

# Run as a user with no shell and no password, so a bug in the request path owns one
# folder on this box rather than the box. Skipped, with a line about it, on a machine
# where one cannot be created - a shop server running as root is better than no shop
# server, and the print says which one you got.
service_user="freo"
if id -u freo >/dev/null 2>&1; then
  :
elif command -v useradd >/dev/null 2>&1; then
  useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin freo 2>/dev/null || service_user="root"
else
  service_user="root"
fi
if [ "$service_user" = "root" ]; then
  echo "  user      root (no 'freo' user could be created on this box - worth fixing later)"
else
  chown -R freo:freo "$PREFIX"
  echo "  user      freo (the server owns $PREFIX and nothing else)"
fi

# - the service -------------------------------------------------------------------
#
# Restart=always, not on-failure: a box that loses power is the normal case here, and
# a service that stays down because the exit code looked deliberate is a shop with no
# server until someone notices. systemd's own restart throttle already stops a crash
# loop from spinning the CPU.
unit="/etc/systemd/system/$SERVICE.service"
cat > "$unit" <<UNIT
[Unit]
Description=Freo shop server (production, curing and MYOB exports)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env node $PREFIX/freo-server.mjs
WorkingDirectory=$PREFIX
Environment=FREO_DATA=$PREFIX/data
Environment=FREO_STATIC=$PREFIX/dist
Environment=FREO_PORT=$PORT
Environment=FREO_HOST=$HOST
Restart=always
RestartSec=3
# The server drains in-flight saves for five seconds on SIGTERM; give it room to do
# that before systemd sends the rude signal.
TimeoutStopSec=15
User=$service_user
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

sleep 1
if ! systemctl is-active --quiet "$SERVICE"; then
  echo "The service did not come up. The last lines it wrote:" >&2
  journalctl -u "$SERVICE" -n 20 --no-pager >&2 || true
  exit 1
fi

# The URL says the box's own address rather than localhost, because the answer that
# gets typed into the shop PC is the one that was printed for it.
box_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "  running:  http://${box_ip:-localhost}:$PORT/"
echo "  status:   systemctl status $SERVICE"
echo "  log:      journalctl -u $SERVICE -f"
echo "  data:     $PREFIX/data"
echo

# The two warnings docs/server.md promised would be said out loud rather than buried.
cat <<'WARN'
Two things to decide before this is trusted with a day's work.

  1. This is plain HTTP on the office network. Anyone plugged into the same switch,
     or anyone who can reach this port over wifi, can read the device tokens as they
     travel and use them. On a private office network that can be a defensible
     choice - it is a choice, not a default. The tidy answers are a certificate on
     this box, or keeping the server where it already is and letting the office
     machines reach it over the internet.

  2. Nothing here backs itself up. The data is one JSON file, two workbooks and a
     write log in /opt/freo/data. Put this in root's crontab today:

       10 23 * * * /opt/freo/ops/server-backup.sh >> /var/log/freo-backup.log 2>&1

     and run server-restore.sh once, on purpose, while there is nothing to lose. A
     backup nobody has restored is a rumour.
WARN

# The cron line above is only actionable if the script is where it says it is.
mkdir -p "$PREFIX/ops"
if [ -f "$source_dir/ops/server-backup.sh" ]; then
  cp "$source_dir/ops/server-backup.sh" "$source_dir/ops/server-restore.sh" "$PREFIX/ops/"
  chmod +x "$PREFIX/ops/"*.sh
  if [ "$service_user" != "root" ]; then chown -R freo:freo "$PREFIX/ops"; fi
fi

# The setup code is on the console of a box most people will never look at, so it is
# worth saying where to find it instead of making someone plug a monitor in.
echo "First device: read the setup code with  journalctl -u $SERVICE -n 40 --no-pager"
echo "It works once. Every device after that is introduced by one that is already connected."
