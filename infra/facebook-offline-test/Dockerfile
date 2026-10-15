# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca update && apt-get -o Acquire::https::CaInfo=/run/secrets/proxy_ca install -y --no-install-recommends python3 python3-venv ca-certificates; \
    else apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates; fi && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then PIP_CERT=/run/secrets/proxy_ca pip install --no-cache-dir 'psycopg[binary]==3.2.6'; \
    else pip install --no-cache-dir 'psycopg[binary]==3.2.6'; fi
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node features ./features
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node supabase/drafts ./supabase/drafts
COPY --chown=node:node infra/facebook-offline-test/supabase-root-ca-2021.crt /app/certs/supabase-root-ca-2021.crt
# Pin the exact public Supabase Root 2021 CA file (not a credential).
RUN echo '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7  /app/certs/supabase-root-ca-2021.crt' | sha256sum --check
USER node
ENV FLIP_ISOLATED_TESTS=1 PORT=10000
EXPOSE 10000
CMD ["python", "scripts/start-facebook-remote-test.py"]
