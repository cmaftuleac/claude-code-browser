# syntax=docker/dockerfile:1.7
#
# Headless Chromium worker (Mode A). Exposes a raw Chrome DevTools Protocol
# endpoint on :9222 that the backend connects to via playwright-core's
# connectOverCDP — for both the agent's browser tools and the human mirror's
# screencast/input. Internal-only on the `ccb` network; never published.
#
# Debian (glibc) chromium, not alpine: matches the rest of the stack and avoids
# musl quirks. --remote-allow-origins=* is REQUIRED since Chrome 111 to accept a
# CDP connection whose Host header isn't localhost (the backend dials by service
# name). --no-sandbox is required unprivileged-in-container.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation fonts-noto-color-emoji tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home chrome

USER chrome
EXPOSE 9222

# tini reaps the zombie renderer processes Chromium spawns.
ENTRYPOINT ["tini", "--"]
CMD ["chromium", \
     "--headless=new", \
     "--no-sandbox", \
     "--disable-gpu", \
     "--disable-dev-shm-usage", \
     "--remote-debugging-address=0.0.0.0", \
     "--remote-debugging-port=9222", \
     "--remote-allow-origins=*"]
