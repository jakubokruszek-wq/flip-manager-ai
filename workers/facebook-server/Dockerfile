FROM mcr.microsoft.com/playwright:v1.61.1-noble
ENV NODE_ENV=production DISPLAY=:99
RUN apt-get update && apt-get install -y --no-install-recommends x11vnc novnc websockify gosu tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY workers/facebook-server/package*.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY workers/facebook-server/*.mjs ./
COPY extensions/facebook-collector/ /app/extension/
COPY workers/facebook-server/entrypoint.sh /app/entrypoint.sh
RUN chmod 755 /app/entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
