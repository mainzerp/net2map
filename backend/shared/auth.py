"""Authentication helpers: SECRET_TOKEN, HTTPBearer scheme, and require_auth dependency."""
import os

from fastapi import HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

SECRET_TOKEN = os.getenv("SECRET_TOKEN", "")
_bearer = HTTPBearer(auto_error=False)


def _require_auth(credentials: HTTPAuthorizationCredentials = Security(_bearer)):
    if not SECRET_TOKEN:
        return  # auth disabled if no token configured
    if not credentials or credentials.credentials != SECRET_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing token",
            headers={"WWW-Authenticate": "Bearer"},
        )
