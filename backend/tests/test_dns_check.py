"""DNS diagnostics: shared.dns_check and POST /dns-settings/test."""
import socket

import routers.scan_settings as scan_settings_router
import shared.dns_check as dns_check


def test_dns_test_endpoint_reports_each_resolver(client, auth_headers, monkeypatch):
    assert client.put("/api/v1/dns-settings", json={"servers": ["10.0.0.53"]}, headers=auth_headers).status_code == 200
    seen = {}

    def fake_check(ip, servers):
        seen["args"] = (ip, servers)
        return [
            {"resolver": "custom", "nameservers": servers, "host": "printer.lan", "error": ""},
            {"resolver": "system", "nameservers": ["127.0.0.11"], "host": "", "error": "herror: not found"},
        ]

    monkeypatch.setattr(scan_settings_router, "check_reverse_dns", fake_check)
    r = client.post("/api/v1/dns-settings/test", json={"ip": " 10.0.0.5 "}, headers=auth_headers)
    assert r.status_code == 200
    assert seen["args"] == ("10.0.0.5", ["10.0.0.53"])
    body = r.json()
    assert body["ip"] == "10.0.0.5"
    assert [x["resolver"] for x in body["results"]] == ["custom", "system"]
    assert body["results"][0]["host"] == "printer.lan"


def test_dns_test_endpoint_rejects_invalid_ip(client, auth_headers):
    r = client.post("/api/v1/dns-settings/test", json={"ip": "not-an-ip"}, headers=auth_headers)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_IP"


def test_check_reverse_dns_system_only_without_servers(monkeypatch):
    monkeypatch.setattr(socket, "gethostbyaddr", lambda ip: ("host.lan", [], [ip]))
    results = dns_check.check_reverse_dns("10.0.0.5", [])
    assert [r["resolver"] for r in results] == ["system"]
    assert results[0]["host"] == "host.lan" and results[0]["error"] == ""


def test_check_reverse_dns_reports_system_error(monkeypatch):
    def boom(ip):
        raise socket.herror(1, "Unknown host")

    monkeypatch.setattr(socket, "gethostbyaddr", boom)
    result = dns_check.check_reverse_dns("10.0.0.5", [])[0]
    assert result["host"] == "" and "Unknown host" in result["error"]
