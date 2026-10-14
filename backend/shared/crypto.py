"""Fernet-based encryption for sensitive fields (SNMP passwords)."""
import logging

from config import settings

_log = logging.getLogger(__name__)

_KEY = settings.encryption_key
if not _KEY:
    _log.warning("ENCRYPTION_KEY not set -- passwords stored unencrypted")

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
        # Do not log the value itself; it may be a legacy plaintext credential.
        _log.warning("Failed to decrypt value -- returning raw value (legacy plaintext?)")
        return value  # legacy unencrypted value


# Every Fernet token starts with the version byte 0x80, which url-safe base64
# encodes as "gAAAAA" (followed by the timestamp's high bytes).
_FERNET_PREFIX = "gAAAAA"


def is_encrypted(value: str) -> bool:
    """True when ``value`` is a Fernet token that decrypts with the current key."""
    if not value or not _fernet:
        return False
    try:
        _fernet.decrypt(value.encode())
        return True
    except Exception:
        return False


def looks_encrypted(value: str) -> bool:
    """True when ``value`` has the shape of a Fernet token (regardless of the key)."""
    return bool(value) and value.startswith(_FERNET_PREFIX)
