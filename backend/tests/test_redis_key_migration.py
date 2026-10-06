"""One-time migration of legacy NetMap Redis keys (netmap:* -> net2map:*)."""
import fnmatch

import shared.state as _st


class FakeRedis:
    def __init__(self, data):
        self.data = dict(data)

    def scan_iter(self, match="*", count=None):
        return [k.encode() for k in list(self.data) if fnmatch.fnmatchcase(k, match)]

    def renamenx(self, src, dst):
        if dst in self.data:
            return False
        self.data[dst] = self.data.pop(src)
        return True


def test_renames_legacy_keys_without_overwriting(monkeypatch):
    fake = FakeRedis({
        "netmap:logs": "old-logs",
        "netmap:fence:scan:lock": "42",
        "netmap:topo_version": "old",
        "net2map:topo_version": "new",
        "token_blacklist:abc": "1",
    })
    monkeypatch.setattr(_st, "get_redis", lambda: fake)

    assert _st.migrate_legacy_redis_keys() == 2
    assert fake.data["net2map:logs"] == "old-logs"
    assert fake.data["net2map:fence:scan:lock"] == "42"
    assert fake.data["net2map:topo_version"] == "new"
    assert fake.data["netmap:topo_version"] == "old"
    assert fake.data["token_blacklist:abc"] == "1"
    assert "netmap:logs" not in fake.data

    assert _st.migrate_legacy_redis_keys() == 0


def test_noop_without_redis(monkeypatch):
    monkeypatch.setattr(_st, "get_redis", lambda: None)
    assert _st.migrate_legacy_redis_keys() == 0
