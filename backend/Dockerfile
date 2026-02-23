FROM python:3.12-slim

# iputils-ping is required by _ping_host_async() in main.py.
# The ping flags used (-c, -W) are Linux-specific.
# gosu enables privilege dropping from root to appuser at container start (needed for volume chown).
RUN apt-get update && apt-get install -y iputils-ping gosu && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV DATABASE_URL=sqlite:////data/netmap.db

# Create unprivileged user; /data ownership is fixed at container start by entrypoint.sh
# because Docker volume mounts happen after build-time chown.
RUN adduser --disabled-password --gecos "" appuser && mkdir -p /data

EXPOSE 8000

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# workers=1 is required: LOG_BUFFER is in-process memory (see main.py)
ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--loop", "asyncio", "--timeout-keep-alive", "75"]
