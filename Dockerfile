# Freo shop server, as a container.
#
# This runs the same single file the systemd install runs, which is the point: one
# artifact is tested, and the two ways of starting it cannot drift. If you are reading
# this on the office box and you did not ask for Docker, `ops/server-install.sh` does
# the same job without it.
#
#     docker build -t freo-server:0.1.0 .
#     docker run -d -p 8787:8787 -v ./data:/data --name freo freo-server:0.1.0
#
# or `docker compose up -d`, which is the same thing written down once.
#
# Build it after `pnpm run build:server`, which makes the one line this image
# genuinely needs.

FROM node:22-alpine

# The app files and the data folder are separate on purpose: `data/` is a volume, so
# `docker rm` never takes the shop's numbers with it.
WORKDIR /app

# The bundle is dependency-free by design, so there is no `npm ci` here and no
# node_modules layer to rebuild when the app changes.
COPY server/freo-server.mjs /app/freo-server.mjs
COPY dist /app/dist

# One port, both jobs. The app and the API come from the same origin, which is what
# lets the front end probe /api/health without a CORS conversation.
ENV FREO_DATA=/data \
    FREO_STATIC=/app/dist \
    FREO_PORT=8787 \
    NODE_ENV=production

EXPOSE 8787

# The data lives here. Back this up - `ops/server-backup.sh` is the shortest way to
# say what has to happen at least once a day.
VOLUME /data

# node:22-alpine ships a `node` user at uid 1000. Running as root inside a container
# buys nothing and costs everything if something in the request path ever breaks out.
#
# The trap to know about: with a bind mount (`-v ./data:/data`) the folder on the host
# keeps its own ownership, and if the user there is not uid 1000 the server starts and
# then cannot write. `chown -R 1000:1000 ./data` on the host fixes it, and the server
# says so at startup rather than on the shop's first save.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

# A container that is up but not answering is the failure mode nobody sees coming, so
# the image can answer that question by itself.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/freo-server.mjs"]
