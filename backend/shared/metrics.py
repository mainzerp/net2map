"""Prometheus metrics for the Net2Map backend."""
from prometheus_client import Counter, Gauge, Histogram

SCAN_DURATION = Histogram("net2map_scan_duration_seconds", "Scan execution duration", ["scan_type"])
SCAN_TOTAL = Counter("net2map_scans_total", "Total number of scans", ["scan_type", "status"])
SCAN_ACTIVE = Gauge("net2map_scans_active", "Currently running scans")
DEVICE_COUNT = Gauge("net2map_devices_total", "Total discovered devices")
PORT_COUNT = Gauge("net2map_ports_total", "Total ports", ["status"])
ENDPOINT_COUNT = Gauge("net2map_endpoints_total", "Total discovered endpoints")
STALE_LEASE_REJECTIONS = Counter(
    "net2map_stale_lease_rejections_total",
    "Transactions rejected by the database because their lease fencing token was stale",
    ["lease"],
)
REQUEST_LATENCY = Histogram("net2map_request_duration_seconds", "HTTP request duration", ["method", "endpoint"])
REQUEST_TOTAL = Counter("net2map_requests_total", "Total HTTP requests", ["method", "endpoint", "status"])
