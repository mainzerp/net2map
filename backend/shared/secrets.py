"""Secret SNMP fields: mask-sentinel handling and at-rest encryption upkeep."""
import logging

from schemas import MASK_SENTINELS
from shared.crypto import encrypt, is_encrypted, looks_encrypted

_log = logging.getLogger(__name__)

# Columns holding SNMP secrets on both Credential and SnmpProfile. They are
# stored Fernet-encrypted and masked in every API response and export.
SECRET_FIELDS = ("community", "v3_auth_password", "v3_priv_password")


def strip_mask_sentinels(data: dict) -> None:
    """Remove fields whose value is a mask sentinel (treated as 'unchanged')."""
    for field in SECRET_FIELDS:
        if data.get(field) in MASK_SENTINELS:
            del data[field]


def normalize_mask_sentinels(data: dict) -> None:
    """Normalize mask sentinels to empty strings before insert."""
    for field in SECRET_FIELDS:
        if data.get(field) in MASK_SENTINELS:
            data[field] = ""


def masked_secret_fields(data: dict) -> set:
    """Secret fields of ``data`` whose value is a mask sentinel."""
    return {field for field in SECRET_FIELDS if data.get(field) in MASK_SENTINELS}


def encrypt_plaintext_secrets(db) -> int:
    """Encrypt secret columns that were stored in plaintext (no ENCRYPTION_KEY yet).

    Idempotent: values that already decrypt with the current key are left
    alone. Values shaped like a Fernet token that do NOT decrypt (key changed
    or lost) are never re-encrypted; they are logged instead, because double
    encryption would hide the problem. Commits on the given session and
    returns the number of encrypted values.
    """
    from database import Credential, SnmpProfile

    changed = 0
    undecryptable = 0
    for model in (Credential, SnmpProfile):
        for row in db.query(model).all():
            for field in SECRET_FIELDS:
                value = getattr(row, field)
                if not value or value in MASK_SENTINELS or is_encrypted(value):
                    continue
                if looks_encrypted(value):
                    undecryptable += 1
                    continue
                setattr(row, field, encrypt(value))
                changed += 1
    if changed:
        db.commit()
        _log.warning("Encrypted %d plaintext SNMP secret value(s) at rest", changed)
    if undecryptable:
        _log.error(
            "%d SNMP secret value(s) look encrypted but do not decrypt with the current ENCRYPTION_KEY; "
            "they were left unchanged (was the key rotated?)", undecryptable,
        )
    return changed
