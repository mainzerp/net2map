"""Scan engine package -- re-exports for backward compatibility."""
from scan_engine.broadcast import _broadcast_progress, _broadcast_scan_complete
from scan_engine.event_loop import _get_bg_loop
from scan_engine.ping import _build_ping_cmd, _ping_host
from scan_engine.dns import (
    _DNS_CACHE_MAX, _evict_dns_cache, _resolve_host, _resolve_ip,
)
from scan_engine.db_helpers import (
    _safe_json_list, _canonical_link_key, _persist_scan_run,
    _read_discovery_ranges, _expand_ranges_to_ips,
)
from scan_engine.executor import _execute_scan
from scan_engine.jobs import _run_scan_job, _start_job
from scan_engine.scheduler import (
    _scheduler_wake, _shutdown_requested, _dispatch_scheduled_scan,
    _background_scheduler, shutdown_scheduler,
)

__all__ = [
    "_broadcast_progress", "_broadcast_scan_complete",
    "_get_bg_loop",
    "_build_ping_cmd", "_ping_host",
    "_DNS_CACHE_MAX", "_evict_dns_cache", "_resolve_host", "_resolve_ip",
    "_safe_json_list", "_canonical_link_key", "_persist_scan_run",
    "_read_discovery_ranges", "_expand_ranges_to_ips",
    "_execute_scan",
    "_run_scan_job", "_start_job",
    "_scheduler_wake", "_shutdown_requested", "_dispatch_scheduled_scan",
    "_background_scheduler", "shutdown_scheduler",
]
