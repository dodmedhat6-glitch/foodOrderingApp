"""MongoDB connection lifecycle — connect, hand out the database, disconnect.

That is the whole job. This module knows nothing about the collections the
service keeps or the indexes they need: those are application knowledge and
live with the repositories that use them
(``app/analytics/repository/indexes.py``). The Node analogue is
``pkg/cache/redis.ts`` — a client wrapper with no key names in it.
"""

from pymongo import AsyncMongoClient

from pkg.mongo.types import Database, Document, MongoConfig


class MongoClient:
    def __init__(self, config: MongoConfig) -> None:
        self._config = config
        self._client: AsyncMongoClient[Document] | None = None
        self._db: Database | None = None

    async def connect(self) -> Database:
        """Open the pool and prove the server answers.

        ``AsyncMongoClient(...)`` itself performs no I/O — it would happily
        "connect" to a host that does not exist and fail on the first real
        query instead. The ``ping`` is what makes a dead mongod a boot error
        rather than a 500 on the first request.
        """
        if self._db is not None:
            return self._db

        client: AsyncMongoClient[Document] = AsyncMongoClient(
            self._config.uri,
            serverSelectionTimeoutMS=self._config.server_selection_timeout_ms,
            appname=self._config.app_name,
            tz_aware=True,  # datetimes come back as aware UTC, not naive
        )
        try:
            await client.admin.command("ping")
        except BaseException:
            await client.close()
            raise

        self._client = client
        self._db = client[self._config.database]
        return self._db

    @property
    def db(self) -> Database:
        if self._db is None:
            raise RuntimeError("MongoClient.connect() has not been awaited")
        return self._db

    async def ping(self) -> bool:
        """Health-check probe: never raises, just answers yes or no."""
        if self._client is None:
            return False
        try:
            await self._client.admin.command("ping")
            return True
        except Exception:
            return False

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
        self._client = None
        self._db = None
