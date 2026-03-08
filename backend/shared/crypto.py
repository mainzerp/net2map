"""Fernet-based encryption for sensitive fields (SNMP passwords)."""
import logging
import os

_KEY = os.getenv("ENCRYPTION_KEY", "")
if not _KEY:
    logging.getLogger(__name__).warning(
        "ENCRYPTION_KEY not set -- passwords stored unencrypted"
    )

_fernet = None
if _KEY:
    from cryptography.fernet import Fernet
    _fernet = Fernet(_KEY.encode())


def encrypt(value: str) -> str:
    """Encrypt a string value. Returns the value unchanged if no key is set."""
    if not value or not _fernet:
        return value
    return _fernet.encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    """Decrypt a string value. Falls back to returning the raw value for
    legacy unencrypted data or when no key is set."""
    if not value or not _fernet:
        return value
    try:
        return _fernet.decrypt(value.encode()).decode()
    except Exception:
        return value  # legacy unencrypted value
