# Caddy + افزونه‌ی layer4 (برای ترمینیت TLS روی پورت TURN 5349)
FROM caddy:2-builder-alpine AS builder
RUN xcaddy build --with github.com/mholt/caddy-l4@v0.1.2

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
