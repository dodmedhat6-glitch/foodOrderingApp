"""Guard for *inbound* service-to-service calls — order-service's ``api-key.ts``.

No route in the video slice uses it: every endpoint today is read by a
human with a JWT. It exists so that the first internal route (the backfill
trigger in the homework is the obvious candidate) does not invent its own
check. Wire it the same way as ``Authenticate``::

    router.post("/internal/backfill", dependencies=[Depends(require_api_key)])

The outbound direction — this service calling core — is not this file; it
is the ``x-api-key`` header ``lib/coreclient/client.py`` sends.
"""

import hmac

from fastapi import Request

from lib.auth.errors import ERR_UNAUTHENTICATED

HEADER = "x-api-key"


class RequireApiKey:
    def __init__(self, expected: str) -> None:
        self._expected = expected.encode()

    async def __call__(self, request: Request) -> None:
        presented = request.headers.get(HEADER, "").encode()
        # An unset key denies everything rather than accepting an empty header.
        # compare_digest: a plain == leaks, through timing, how many leading
        # bytes matched.
        if not self._expected or not hmac.compare_digest(presented, self._expected):
            raise ERR_UNAUTHENTICATED
