"""Prometheus metrics for the NetMap backend."""
from prometheus_client import Counter, Histogram, Gauge

SCAN_DURATION = Histogram("netmap_scan_duration_seconds", "Scan execution duration", ["scan_type"])
SCAN_TOTAL = Counter("netmap_scans_total", "Total number of scans", ["scan_type", "status"])
SCAN_ACTIVE = Gauge("netmap_scans_active", "Currently running scans")
DEVICE_COUNT = Gauge("netmap_devices_total", "Total discovered devices")
PORT_COUNT = Gauge("netmap_ports_total", "Total ports", ["status"])
REQUEST_LATENCY = Histogram("netmap_request_duration_seconds", "HTTP request duration", ["method", "endpoint"])
REQUEST_TOTAL = Counter("netmap_requests_total", "Total HTTP requests", ["method", "endpoint", "status"])
