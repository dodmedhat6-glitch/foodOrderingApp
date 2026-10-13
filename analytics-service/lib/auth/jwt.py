import jwt
from pydantic import ValidationError

from lib.appcontext.context import Claims
from lib.auth.errors import ERR_UNAUTHENTICATED
from lib.auth.types import AccessTokenClaims

#: Pinned, never read from the token header. Accepting whatever ``alg`` the
#: token names is the classic JWT hole (``alg: none``, or HS256 signed with an
#: RS256 public key); core signs HS256, so that is the only thing we verify.
ALGORITHMS = ["HS256"]


def verify_access_token(token: str, secret: str) -> Claims:
    """Signature, expiry and claim shape — any failure is the same 401.

    The reason a token was refused (expired, bad signature, garbage) is
    deliberately not told to the caller; it would only help someone probing.
    """
    try:
        decoded = jwt.decode(token, secret, algorithms=ALGORITHMS)
        raw = AccessTokenClaims.model_validate(decoded)
    except (jwt.PyJWTError, ValidationError) as exc:
        raise ERR_UNAUTHENTICATED from exc

    return Claims(
        user_id=raw.user_id,
        role=raw.role,
        email=raw.email,
        restaurant_id=raw.restaurantId,
        restaurant_role=raw.restaurantRole,
        branch_ids=tuple(raw.branchIds),
    )
