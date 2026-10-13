from pydantic import BaseModel, ConfigDict, Field


class AccessTokenClaims(BaseModel):
    """The claim set core signs (its ``src/app/auth/utils.ts`` ``JwtPayload``),
    exactly as it is on the wire — including ``user_id`` in snake_case beside
    ``restaurantId`` in camelCase. Renaming a claim means reissuing every live
    token, so this model follows core rather than tidying it.

    Validation is the point: a token signed with the right secret but missing
    ``user_id`` (or carrying ``"user_id": "abc"``) is still not a user.
    """

    model_config = ConfigDict(extra="ignore")

    user_id: int = Field(gt=0)
    role: str = Field(min_length=1)
    email: str = ""
    restaurantId: int | None = None
    restaurantRole: str | None = None
    branchIds: list[int] = Field(default_factory=list)
