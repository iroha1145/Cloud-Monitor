FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend

ENV PYTHONPATH=/app/backend
ENV DATABASE_PATH=/data/cloud-monitor.sqlite3
ENV FRONTEND_DIR=/app/frontend
ENV HOST=0.0.0.0
ENV PORT=7878

RUN mkdir -p /data
EXPOSE 7878

CMD ["python", "-m", "uvicorn", "hub.main:app", "--host", "0.0.0.0", "--port", "7878"]
