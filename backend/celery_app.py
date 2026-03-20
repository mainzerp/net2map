"""Celery application configuration for NetMap background tasks."""
from celery import Celery

from config import settings

REDIS_URL = settings.redis_url or "redis://localhost:6379/0"

celery_app = Celery("netmap", broker=REDIS_URL, backend=REDIS_URL, include=["tasks"])
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
)
celery_app.conf.beat_schedule = {
    "scheduler-tick": {
        "task": "tasks.scheduler_tick",
        "schedule": 5.0,
    },
    "purge-old-audit-logs": {
        "task": "tasks.purge_old_audit_logs",
        "schedule": 21600.0,  # every 6 hours
    },
}

from celery.signals import worker_shutting_down

@worker_shutting_down.connect
def on_worker_shutdown(sig, how, exitcode, **kwargs):
    import logging
    logging.getLogger(__name__).info(
        "Celery worker shutting down (signal=%s, how=%s)", sig, how
    )
