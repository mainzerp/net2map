"""Bound Redis failures so authentication and lock ownership checks can fail closed."""
import socket
import threading
import time
from unittest.mock import patch

import pytest
import redis

from shared import redis_client


def test_pool_has_finite_connection_and_read_timeouts_without_automatic_retries():
    with patch.object(redis_client, "REDIS_URL", "redis://127.0.0.1:6379/0"), \
            patch.object(redis_client, "_pool", None):
        client = redis_client.get_redis()
        options = client.connection_pool.connection_kwargs
        assert options["socket_connect_timeout"] == 2.0
        assert options["socket_timeout"] == 2.0
        assert options["retry"].get_retries() == 0
        client.connection_pool.disconnect()


def test_redis_server_that_accepts_but_never_replies_is_bounded_without_retries():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.settimeout(0.01)
    stopped = threading.Event()
    connections = []

    def accept_without_reply():
        while not stopped.is_set():
            try:
                connection, _ = listener.accept()
                connections.append(connection)
            except TimeoutError:
                continue

    server = threading.Thread(target=accept_without_reply, daemon=True)
    server.start()
    try:
        port = listener.getsockname()[1]
        with patch.object(redis_client, "REDIS_URL", f"redis://127.0.0.1:{port}/0"), \
                patch.object(redis_client, "REDIS_TIMEOUT_SECONDS", 0.05), \
                patch.object(redis_client, "_pool", None):
            client = redis_client.get_redis()
            started = time.monotonic()
            with pytest.raises(redis.TimeoutError):
                client.ping()
            elapsed = time.monotonic() - started
            assert elapsed < 0.5
            assert len(connections) == 1
            client.connection_pool.disconnect()
    finally:
        stopped.set()
        server.join(timeout=1)
        listener.close()
        for connection in connections:
            connection.close()
