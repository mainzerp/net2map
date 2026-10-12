FROM python:3.12-slim

# iputils-ping is required by _ping_host_async() in main.py.
# The ping flags used (-c, -W) are Linux-specific.
# gosu enables privilege dropping from root to appuser at container start (needed for volume chown).
# libpq-dev is required to build psycopg2 from source if needed (psycopg2-binary covers most cases).
RUN apt-get update && apt-get install -y iputils-ping gosu libpq5 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Celery keeps the working directory on sys.path only while loading the app;
# lazy imports inside tasks (e.g. routers.topology) need /app on the path.
ENV PYTHONPATH=/app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create unprivileged user; /data ownership is fixed at container start by entrypoint.sh
# because Docker volume mounts happen after build-time chown.
RUN adduser --disabled-password --gecos "" appuser && mkdir -p /data

EXPOSE 8000

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Default 1 worker. With Redis configured (REDIS_URL), multiple workers are safe.
# Override via UVICORN_WORKERS env var (e.g. UVICORN_WORKERS=2).
# --proxy-headers + --forwarded-allow-ips make uvicorn honor X-Forwarded-For from
# the nginx reverse proxy so rate limiting sees real client IPs. Restrict the
# trusted proxy range via UVICORN_FORWARDED_ALLOW_IPS (default "*" for compose).
ENTRYPOINT ["/entrypoint.sh"]
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-1} --loop asyncio --timeout-keep-alive 75 --proxy-headers --forwarded-allow-ips \"${UVICORN_FORWARDED_ALLOW_IPS:-*}\""]
