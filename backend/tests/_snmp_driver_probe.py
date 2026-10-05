"""Real BER/UDP SNMP regression probe; serves only the loopback interface."""

import asyncio
import sys
from pathlib import Path

# This process deliberately has no pytest conftest or mocked SNMP modules.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pyasn1.codec.ber import decoder, encoder
from pysnmp.entity import config
from pysnmp.hlapi.v3arch.asyncio import USM_AUTH_NONE, USM_PRIV_NONE, SnmpEngine
from pysnmp.proto import api
from pysnmp.proto.rfc1902 import Integer32, OctetString
from pysnmp.proto.rfc1905 import EndOfMibView, NoSuchObject

import snmp_scanner as scanner

SCALAR = scanner.OID_SYS_NAME
TABLE = scanner.OID_IF_DESCR
BITMASK = scanner.OID_DOT1Q_VLAN_STATIC_EGRESS
# Binary engine ID with non-printable bytes (enterprise 47196, MAC format).
ENGINE_ID_BYTES = bytes.fromhex("80000b85030011223344ff")


class LoopbackAgent(asyncio.DatagramProtocol):
    def __init__(self, scenario):
        self.scenario = scenario
        self.requests = 0
        self.failure = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, address):
        try:
            message, tail = decoder.decode(data, asn1Spec=api.v2c.Message())
            assert not tail
            assert str(api.v2c.apiMessage.get_community(message)) == "loopback-test"
            self.requests += 1
            if self.scenario == "retry" and self.requests == 1:
                return
            pdu = api.v2c.apiMessage.get_pdu(message)
            varbinds = api.v2c.apiPDU.get_varbinds(pdu)
            requested = str(varbinds[0][0])
            if pdu.isSameTypeWith(api.v2c.GetRequestPDU()):
                values = {
                    SCALAR: OctetString("fixture-switch"),
                    scanner.OID_SYS_DESCR: OctetString("ArubaOS-CX fixture"),
                    scanner.OID_SYS_LOCATION: OctetString("test-rack"),
                    scanner.OID_SYS_OBJECT_ID: api.v2c.ObjectIdentifier("1.3.6.1.4.1.47196"),
                    scanner.OID_SNMP_ENGINE_ID: OctetString(ENGINE_ID_BYTES),
                }
                response_rows = [(oid, values.get(str(oid), NoSuchObject())) for oid, _ in varbinds]
            else:
                assert pdu.isSameTypeWith(api.v2c.GetBulkRequestPDU())
                assert int(api.v2c.apiBulkPDU.get_max_repetitions(pdu)) == 25
                if self.scenario == "duplicate":
                    response_rows = [(requested, OctetString("stale"))]
                elif requested == BITMASK:
                    response_rows = [(BITMASK + ".7", OctetString(b"\x80\x01")),
                                     (BITMASK + ".7", EndOfMibView())]
                elif requested == TABLE:
                    response_rows = [(TABLE + ".9", OctetString("port9")),
                                     (TABLE + ".10", OctetString("port10"))]
                else:
                    response_rows = [(requested, EndOfMibView())]
            response = api.v2c.apiMessage.get_response(message)
            response_pdu = api.v2c.apiMessage.get_pdu(response)
            api.v2c.apiPDU.set_varbinds(response_pdu, response_rows)
            self.transport.sendto(encoder.encode(response), address)
        except Exception as exc:
            self.failure = exc


def check_credentials():
    assert scanner.build_auth("v2c", community="fixture").communityName == "fixture"
    assert scanner.build_auth("v2c").message_processing_model == 1
    engine = SnmpEngine()
    try:
        no_auth = scanner.build_auth("v3", v3_username="plain", v3_security_level="noAuthNoPriv")
        assert no_auth.authentication_protocol == USM_AUTH_NONE
        assert no_auth.privacy_protocol == USM_PRIV_NONE
        default = scanner.build_auth("v3", v3_username="default", v3_auth_password="auth-test-pass",
                                     v3_priv_password="priv-test-pass")
        assert default.authentication_protocol == scanner.AUTH_PROTOCOLS["SHA-256"]
        assert default.privacy_protocol == scanner.PRIV_PROTOCOLS["AES-128"]
        for auth_name, auth_protocol in scanner.AUTH_PROTOCOLS.items():
            for priv_name, priv_protocol in scanner.PRIV_PROTOCOLS.items():
                user = scanner.build_auth(
                    "v3", v3_username=auth_name + priv_name, v3_auth_protocol=auth_name,
                    v3_auth_password="auth-test-pass", v3_priv_protocol=priv_name,
                    v3_priv_password="priv-test-pass",
                )
                assert user.authentication_protocol == auth_protocol
                assert user.privacy_protocol == priv_protocol
                config.add_v3_user(engine, user.userName, user.authentication_protocol, user.authentication_key,
                                   user.privacy_protocol, user.privacy_key)
            user = scanner.build_auth("v3", v3_username=auth_name, v3_security_level="authNoPriv",
                                      v3_auth_protocol=auth_name, v3_auth_password="auth-test-pass")
            assert user.authentication_protocol == auth_protocol
            assert user.privacy_protocol == USM_PRIV_NONE
        # Load the actual crypto implementations, so missing optional crypto cannot pass silently.
        from pysnmp.proto.secmod.eso.priv.des3 import PysnmpCryptoError as des3_missing
        from pysnmp.proto.secmod.rfc3414.priv.des import PysnmpCryptoError as des_missing
        from pysnmp.proto.secmod.rfc3826.priv.aes import PysnmpCryptoError as aes_missing

        assert not (des_missing or des3_missing or aes_missing)
        # Engine ID override is passed as securityEngineId; empty means discovery.
        pinned = scanner.build_auth("v3", v3_username="pinned", v3_auth_password="auth-test-pass",
                                    v3_priv_password="priv-test-pass", v3_engine_id="80000b85030011223344ff")
        assert bytes(pinned.securityEngineId) == ENGINE_ID_BYTES
        config.add_v3_user(engine, pinned.userName, pinned.authentication_protocol, pinned.authentication_key,
                           pinned.privacy_protocol, pinned.privacy_key,
                           securityEngineId=pinned.securityEngineId)
        assert default.securityEngineId is None
        assert scanner.build_auth("v2c", v3_engine_id="80000b85030011223344ff").communityName == "public"
        assert scanner.engine_id_to_hex(OctetString(ENGINE_ID_BYTES)) == ENGINE_ID_BYTES.hex()
        assert scanner.engine_id_to_hex(OctetString(b"\x01\x02")) == ""
        encoded = encoder.encode(Integer32(42))
        decoded, tail = decoder.decode(encoded, asn1Spec=Integer32())
        assert int(decoded) == 42 and not tail
    finally:
        engine.close_dispatcher()


async def check_udp(scenario):
    loop = asyncio.get_running_loop()
    transport, agent = await loop.create_datagram_endpoint(lambda: LoopbackAgent(scenario),
                                                          local_addr=("127.0.0.1", 0))
    port = transport.get_extra_info("sockname")[1]
    auth = scanner.build_auth("v2c", community="loopback-test")
    try:
        if scenario in {"get", "retry"}:
            result = await scanner.snmp_get("127.0.0.1", port, auth, SCALAR, "1.3.6.1.2.1.1.99.0",
                                            timeout=0.1, retries=1)
            assert result == {SCALAR: "fixture-switch"}, result
            assert agent.requests == (2 if scenario == "retry" else 1)
        elif scenario == "walk":
            result = await scanner.snmp_bulk_walk("127.0.0.1", port, auth, TABLE, timeout=0.1, retries=0)
            assert result == [(TABLE + ".9", "port9"), (TABLE + ".10", "port10")], result
            assert agent.requests == 2
        elif scenario == "raw":
            result = await scanner.snmp_bulk_walk_raw("127.0.0.1", port, auth, BITMASK, timeout=0.1, retries=0)
            assert result == [(BITMASK + ".7", b"\x80\x01")], result
            assert scanner.parse_port_bitmask(result[0][1]) == {1, 16}
            assert agent.requests == 1
        elif scenario == "duplicate":
            result = await scanner.snmp_bulk_walk("127.0.0.1", port, auth, TABLE, timeout=0.1, retries=0)
            assert result == [], result
            assert agent.requests == 1
        elif scenario == "discovery":
            result = await scanner.scan_switch("127.0.0.1", community="loopback-test", snmp_port=port,
                                              snmp_timeout=0.1, snmp_retries=0, scan_type="discovery")
            assert result is not None
            assert result.sys_name == "fixture-switch"
            assert result.location == "test-rack"
            assert result.vendor == "aruba_cx"
            # Raw binary snmpEngineID must survive as lowercase hex.
            assert result.engine_id == ENGINE_ID_BYTES.hex(), result.engine_id
            # System scalars + separate snmpEngineID.0 GET.
            assert agent.requests == 2
        assert agent.failure is None, agent.failure
    finally:
        transport.close()


if __name__ == "__main__":
    if sys.argv[1] == "credentials":
        check_credentials()
    else:
        asyncio.run(check_udp(sys.argv[1]))
