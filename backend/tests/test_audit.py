"""Tests for audit log listing and audit trail side-effects."""
from datetime import datetime, timedelta, timezone

from database import AuditLog

# ---------------------------------------------------------------------------
# T3b: Audit Logging Tests (7 tests)
# ---------------------------------------------------------------------------

class TestAuditListEndpoint:
    """GET /api/audit-logs"""

    def test_list_audit_logs_empty(self, client, jwt_headers):
        resp = client.get("/api/audit-logs", headers=jwt_headers)
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_audit_logs_returns_entries(self, client, jwt_headers, db):
        db.add(AuditLog(
            username="admin", action="create", resource="credential",
            resource_id="1", details={"ip": "10.0.0.1"},
        ))
        db.commit()
        resp = client.get("/api/audit-logs", headers=jwt_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["action"] == "create"
        assert data[0]["resource"] == "credential"

    def test_list_audit_logs_respects_limit(self, client, jwt_headers, db):
        for i in range(5):
            db.add(AuditLog(
                username="u", action="update", resource="device",
                resource_id=str(i), details={},
            ))
        db.commit()
        resp = client.get("/api/audit-logs?limit=3", headers=jwt_headers)
        assert resp.status_code == 200
        assert len(resp.json()) == 3

    def test_list_audit_logs_limit_above_500_rejected(self, client, jwt_headers):
        resp = client.get("/api/audit-logs?limit=9999", headers=jwt_headers)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "INVALID_LIMIT"

    def test_list_audit_logs_negative_limit_rejected(self, client, jwt_headers):
        resp = client.get("/api/audit-logs?limit=-5", headers=jwt_headers)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "INVALID_LIMIT"

    def test_viewer_cannot_access_audit_logs(self, client, viewer_jwt_headers):
        resp = client.get("/api/audit-logs", headers=viewer_jwt_headers)
        assert resp.status_code == 403


class TestAuditSideEffects:
    """Audit entries created as side effects of other API actions."""

    def test_credential_create_generates_audit_entry(self, client, jwt_headers, db):
        """Creating a credential should produce an audit log entry."""
        client.post(
            "/api/credentials",
            headers=jwt_headers,
            json={"label": "TestSwitch", "ip": "10.0.0.1"},
        )
        logs = db.query(AuditLog).filter(AuditLog.resource == "credential").all()
        assert len(logs) >= 1
        assert logs[0].action == "create"

    def test_credential_delete_generates_audit_entry(self, client, jwt_headers, db):
        """Deleting a credential should produce an audit log entry."""
        resp = client.post(
            "/api/credentials",
            headers=jwt_headers,
            json={"label": "DelSwitch", "ip": "10.0.0.2"},
        )
        cred_id = resp.json()["id"]
        client.delete(f"/api/credentials/{cred_id}", headers=jwt_headers)
        logs = db.query(AuditLog).filter(
            AuditLog.resource == "credential",
            AuditLog.action == "delete",
        ).all()
        assert len(logs) >= 1


class TestAuditPurge:
    """DELETE /api/audit-logs/purge"""

    def test_purge_deletes_old_entries(self, client, jwt_headers, db):
        old = datetime.now(timezone.utc) - timedelta(days=120)
        recent = datetime.now(timezone.utc) - timedelta(days=10)
        db.add(AuditLog(username="u", action="a", resource="r",
                        resource_id="1", details={}, timestamp=old))
        db.add(AuditLog(username="u", action="a", resource="r",
                        resource_id="2", details={}, timestamp=recent))
        db.commit()
        resp = client.delete("/api/audit-logs/purge?days=90", headers=jwt_headers)
        assert resp.status_code == 200
        assert resp.json()["deleted"] == 1
        assert db.query(AuditLog).count() == 1

    def test_purge_requires_admin(self, client, viewer_jwt_headers):
        resp = client.delete("/api/audit-logs/purge", headers=viewer_jwt_headers)
        assert resp.status_code == 403

    def test_purge_custom_days(self, client, jwt_headers, db):
        old = datetime.now(timezone.utc) - timedelta(days=5)
        db.add(AuditLog(username="u", action="a", resource="r",
                        resource_id="1", details={}, timestamp=old))
        db.commit()
        resp = client.delete("/api/audit-logs/purge?days=3", headers=jwt_headers)
        assert resp.status_code == 200
        assert resp.json()["deleted"] == 1

    def test_purge_non_positive_days_rejected(self, client, jwt_headers):
        for days in (0, -10):
            resp = client.delete(f"/api/audit-logs/purge?days={days}", headers=jwt_headers)
            assert resp.status_code == 400
            assert resp.json()["error"]["code"] == "INVALID_RETENTION"


class TestAuditPurgeTask:
    def test_purge_task_runs(self, db, monkeypatch):
        import tasks
        monkeypatch.setattr("tasks.SessionLocal", lambda: db)
        old = datetime.now(timezone.utc) - timedelta(days=120)
        db.add(AuditLog(username="u", action="a", resource="r",
                        resource_id="1", details={}, timestamp=old))
        db.commit()
        tasks.purge_old_audit_logs()
        assert db.query(AuditLog).count() == 0


class TestAuditRetentionSetting:
    """The audit_retention_days app setting overrides AUDIT_RETENTION_DAYS."""

    def _set(self, db, value):
        from database import AppSetting
        db.add(AppSetting(key="audit_retention_days", value=value))
        db.commit()

    def _add_entry(self, db, age_days):
        db.add(AuditLog(username="u", action="a", resource="r", resource_id="1", details={},
                        timestamp=datetime.now(timezone.utc) - timedelta(days=age_days)))
        db.commit()

    def test_env_default_without_db_setting(self, db, monkeypatch):
        from config import settings
        from shared.audit import get_audit_retention_days
        monkeypatch.setattr(settings, "audit_retention_days", 42)
        assert get_audit_retention_days(db) == 42

    def test_db_setting_wins(self, db, monkeypatch):
        from config import settings
        from shared.audit import get_audit_retention_days
        monkeypatch.setattr(settings, "audit_retention_days", 90)
        self._set(db, " 7 ")
        assert get_audit_retention_days(db) == 7

    def test_invalid_db_setting_falls_back_to_env(self, db, monkeypatch):
        from config import settings
        from database import AppSetting
        from shared.audit import get_audit_retention_days
        monkeypatch.setattr(settings, "audit_retention_days", 30)
        for bad in ("abc", "0", "-5", "1.5", ""):
            db.query(AppSetting).delete()
            self._set(db, bad)
            assert get_audit_retention_days(db) == 30, bad

    def test_purge_task_uses_db_setting(self, db, monkeypatch):
        import tasks
        from config import settings
        monkeypatch.setattr(settings, "audit_retention_days", 90)
        self._set(db, "10")
        self._add_entry(db, 20)
        self._add_entry(db, 5)
        tasks.purge_old_audit_logs()
        assert db.query(AuditLog).count() == 1

    def test_purge_task_disabled_by_env_without_db_setting(self, db, monkeypatch):
        import tasks
        from config import settings
        monkeypatch.setattr(settings, "audit_retention_days", 0)
        self._add_entry(db, 500)
        tasks.purge_old_audit_logs()
        assert db.query(AuditLog).count() == 1

    def test_purge_endpoint_default_uses_db_setting(self, client, jwt_headers, db, monkeypatch):
        from config import settings
        monkeypatch.setattr(settings, "audit_retention_days", 90)
        self._set(db, "10")
        self._add_entry(db, 20)
        resp = client.delete("/api/v1/audit-logs/purge", headers=jwt_headers)
        assert resp.status_code == 200
        assert resp.json()["deleted"] == 1
