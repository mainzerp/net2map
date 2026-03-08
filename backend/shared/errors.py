"""Structured error response helpers."""
from fastapi import HTTPException


def api_error(
    status_code: int,
    code: str,
    message: str,
    field: str = None,
    details: list = None,
):
    """Raise an HTTPException with a structured error body.

    Response shape: {"error": {"code": "...", "message": "...", ...}}
    """
    body: dict = {"code": code, "message": message}
    if field:
        body["field"] = field
    if details:
        body["details"] = details
    raise HTTPException(status_code=status_code, detail={"error": body})
