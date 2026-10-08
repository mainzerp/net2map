"""Minimal in-memory Redis stand-in for latency monitor/API tests."""


class FakePipeline:
    def __init__(self, redis):
        self._redis = redis
        self._ops = []

    def __getattr__(self, name):
        def _queue(*args, **kwargs):
            self._ops.append((name, args, kwargs))
            return self
        return _queue

    def execute(self):
        return [getattr(self._redis, name)(*args, **kwargs) for name, args, kwargs in self._ops]


class FakeRedis:
    def __init__(self):
        self.kv = {}
        self.hashes = {}
        self.ttl = {}

    def pipeline(self):
        return FakePipeline(self)

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.kv:
            return None
        self.kv[key] = value
        if ex is not None:
            self.ttl[key] = ex
        return True

    def get(self, key):
        return self.kv.get(key)

    def expire(self, key, ttl):
        self.ttl[key] = ttl
        return key in self.kv or key in self.hashes

    def delete(self, *keys):
        removed = 0
        for key in keys:
            removed += int(self.kv.pop(key, None) is not None)
            removed += int(self.hashes.pop(key, None) is not None)
        return removed

    def hset(self, key, mapping=None, **kwargs):
        self.hashes.setdefault(key, {}).update(mapping or {})
        return len(mapping or {})

    def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    def hkeys(self, key):
        return list(self.hashes.get(key, {}))

    def hdel(self, key, *fields):
        h = self.hashes.get(key, {})
        return sum(1 for f in fields if h.pop(f, None) is not None)
