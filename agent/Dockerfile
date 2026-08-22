FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY sync_agent.py token_monitor_bridge.py /app/

# macOS 宿主机上的本地 monitor 通过 host.docker.internal 访问
ENV LOCAL_MONITOR_URL=http://host.docker.internal:7878
ENV STATE_PATH=/data/agent-state.json
ENV PYTHONUNBUFFERED=1

RUN mkdir -p /data

CMD ["python", "sync_agent.py"]
