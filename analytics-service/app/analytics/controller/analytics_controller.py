from fastapi.responses import JSONResponse

from app.analytics.dto.restaurant_days_request import RestaurantDaysQuery
from app.analytics.dto.restaurant_days_response import RestaurantDayResponse
from app.analytics.service.analytics_service import AnalyticsService
from lib.http.response import send_success


class AnalyticsController:
    """Thin, like every controller: inputs already validated (FastAPI did
    that against the parameter types and the query model) -> one service
    call -> response DTOs -> envelope. No business rules, no try/except."""

    def __init__(self, service: AnalyticsService) -> None:
        self._service = service

    async def get_restaurant_days(self, restaurant_id: int, query: RestaurantDaysQuery) -> JSONResponse:
        rows = await self._service.get_restaurant_days(restaurant_id, query.to_range())
        return send_success([RestaurantDayResponse.from_row(row) for row in rows])
