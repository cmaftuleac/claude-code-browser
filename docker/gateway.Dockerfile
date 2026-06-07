# syntax=docker/dockerfile:1.7
#
# Gateway image — the public entrypoint. The prod config is baked in so the image
# is self-contained/portable. The dev override (docker-compose.dev.yml) mounts
# gateway.dev.conf over this path, which cleanly shadows the baked file (a single
# bind mount, no compose volume-merge conflict).
FROM nginx:alpine
COPY docker/nginx/gateway.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
