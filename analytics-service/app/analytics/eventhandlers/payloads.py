"""Inbound payload contracts — what order-service's ``lib/events/types.ts`` sends.

One pydantic model per event, mirroring the TS interface field for field.
They are validated at the edge (the handler), so the service only ever sees
the typed ``OnOrderPlacedInput``. Fields this module does not use yet are
still declared: they document the contract, and the homework handlers need
them.
"""

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


class _Payload(BaseModel):
    # extra="ignore": order-service may add fields; that must not dead-letter
    # every event until this service redeploys.
    model_config = ConfigDict(extra="ignore")


class OrderPlacedItem(_Payload):
    productId: int
    quantity: int = Field(gt=0)
    unitPriceMinor: int = Field(ge=0)
    lineTotal: int = Field(ge=0)


class OrderPlacedPayload(_Payload):
    orderId: str
    region: str
    countryCode: str
    restaurantId: int = Field(gt=0)
    branchId: int = Field(gt=0)
    customerId: int
    status: str
    paymentMethod: str
    subtotal: int = Field(ge=0)
    deliveryFee: int = Field(ge=0)
    serviceFee: int = Field(ge=0)
    #: Integer minor units. A float here (2500.0) is a contract break, and
    #: pydantic's lax int would silently accept it — hence strict.
    total: int = Field(ge=0, strict=True)
    currency: str = Field(min_length=3, max_length=3)
    items: list[OrderPlacedItem] = Field(default_factory=list)
    #: Must carry an offset (order-service always sends ...Z). A naive
    #: timestamp has no defined UTC day, so it is rejected, not guessed.
    placedAt: AwareDatetime
