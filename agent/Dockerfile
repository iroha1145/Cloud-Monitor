FROM python:3.12-slim

RUN groupadd -r monitor && useradd -r -g monitor monitor \
    && mkdir -p /data && chown monitor:monitor /data

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY sync_agent.py token_monitor_bridge.py healthcheck.py /app/

ENV LOCAL_MONITOR_URL=http://host.docker.internal:7878 \
    STATE_PATH=/data/agent-state.json \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER monitor

# 上次成功同步过旧或存在未解决永久错误时判定不健康
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD ["python", "/app/healthcheck.py"]

CMD ["python", "sync_agent.py"]
