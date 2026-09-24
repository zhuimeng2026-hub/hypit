# Dumb-HTTP git mirror for the Hypit repository.
#
# Why dumb HTTP: Alpine's git package does not ship `git-http-backend` (the CGI
# binary that powers smart-HTTP), and rebuilding git from source in a 50 MB
# image is not worth it for a read-only LAN mirror. Dumb HTTP — what github.io
# pages uses — is built into every git client and needs nothing more than
# `git update-server-info` and a plain nginx. Trade-off: every `git fetch`
# downloads the full ref list and the pack indexes; for an occasional
# `git pull` on a single-repo checkout this is fine.
#
# Layout on disk (populated on first start):
#   /var/lib/git/hypit.git/       bare mirror of github.com/hypit-ai/hypit
#
# Clients reach it with `git clone http://<host>/hypit.git`. Push is rejected
# at the protocol level because git clients do not advertise `receive-pack`
# against a non-CGI endpoint.

FROM nginx:1.27-alpine

RUN apk add --no-cache \
        bash \
        git \
        tzdata \
    && mkdir -p /var/lib/git /run/nginx \
    && git config --global init.defaultBranch main \
    && git config --global http.postBuffer 524288000 \
    && git config --global http.lowSpeedLimit 1000 \
    && git config --global http.lowSpeedTime 30 \
    && rm -f /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/git-mirror.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
    CMD wget -qO- http://127.0.0.1/healthz || exit 1

ENTRYPOINT ["/entrypoint.sh"]
