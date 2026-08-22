FROM node:22-slim

# vendored 官方 hub（见 vendor/NOTICE.md），零 npm 依赖
RUN groupadd -r monitor && useradd -r -g monitor monitor \
    && mkdir -p /data && chown monitor:monitor /data

WORKDIR /app
COPY vendor /app/vendor
COPY run.js /app/run.js

ENV TOKEN_MONITOR_PORT=17321 \
    TOKEN_MONITOR_HOST=0.0.0.0 \
    TOKEN_MONITOR_DATA_FILE=/data/devices.json \
    NODE_ENV=production

USER monitor
EXPOSE 17321

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:17321/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "run.js"]
