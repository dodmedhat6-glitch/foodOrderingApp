from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

DependencyState = Literal["up", "down"]


class HealthResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)

    status: Literal["ok", "degraded"]
    mongo: DependencyState
    rabbit: DependencyState
