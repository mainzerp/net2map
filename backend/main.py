"""FastAPI application entry point – NetMap backend."""
import logging
import os
import threading

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import create_tables, get_db
from scan_engine import _background_scheduler
from shared.auth import _require_auth

from routers import (
    health, settings, credentials, snmp_profiles, racks,
    switch_classes, switch_models, scan, scan_runs, topology,
    map_bg, scan_settings, bulk, config, logs,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

CORS_ORIGIN = os.getenv("CORS_ORIGIN", "http://localhost:3000")

app = FastAPI(title="NetMap API", version="1.0.0", dependencies=[Depends(_require_auth)])

app.add_middleware(
    CORSMiddleware,
    allow_origins=[CORS_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(settings.router)
app.include_router(credentials.router)
app.include_router(snmp_profiles.router)
app.include_router(racks.router)
app.include_router(switch_classes.router)
app.include_router(switch_models.router)
app.include_router(scan.router)
app.include_router(scan_runs.router)
app.include_router(topology.router)
app.include_router(map_bg.router)
app.include_router(scan_settings.router)
app.include_router(bulk.router)
app.include_router(config.router)
app.include_router(logs.router)


@app.on_event("startup")
def on_startup():
    create_tables()
    threading.Thread(target=_background_scheduler, daemon=True).start()
