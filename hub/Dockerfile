FROM python:3.12-slim

# 非 root 运行；/data 由 compose 卷挂载并在启动前修正属主
RUN groupadd -r monitor && useradd -r -g monitor monitor \
    && mkdir -p /data && chown monitor:monitor /data

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend
COPY tm-frontend /app/tm-frontend

ENV PYTHONPATH=/app/backend \
    DATABASE_PATH=/data/cloud-monitor.sqlite3 \
    FRONTEND_DIR=/app/frontend \
    HOST=0.0.0.0 \
    PORT=7878 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER monitor
EXPOSE 7878

# 单 worker：SQLite 单进程模型，不开多 worker 规避并发问题
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7878/api/v1/health', timeout=4).status == 200 else 1)"

CMD ["python", "-m", "uvicorn", "hub.main:app", "--host", "0.0.0.0", "--port", "7878", "--workers", "1"]
