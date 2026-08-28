FROM python:3.12.11-slim

# 非 root 运行；空 named volume 首次挂载时 Docker 会以镜像内 /data 属主
# 初始化卷，之后属主随卷保持——restore.sh 回写文件后必须自行 chown
RUN groupadd -r monitor && useradd -r -g monitor monitor \
    && mkdir -p /data /update && chown monitor:monitor /data /update

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend

ARG CM_VERSION=dev
ARG CM_GIT_SHA=unknown
ENV CM_VERSION=$CM_VERSION \
    CM_GIT_SHA=$CM_GIT_SHA \
    CM_UPDATE_DIR=/update

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
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7878/api/v1/health/live', timeout=4).status == 200 else 1)"]

CMD ["python", "-m", "uvicorn", "hub.main:app", "--host", "0.0.0.0", "--port", "7878", "--workers", "1", "--loop", "uvloop"]
