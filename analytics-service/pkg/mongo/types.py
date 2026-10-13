from dataclasses import dataclass
from typing import Any

from pymongo.asynchronous.database import AsyncDatabase

#: A raw BSON document as pymongo hands it over. Repositories map these to and
#: from dataclasses explicitly; nothing outside a repository should hold one.
Document = dict[str, Any]

#: The database handle a repository is constructed with.
Database = AsyncDatabase[Document]


@dataclass(frozen=True)
class MongoConfig:
    uri: str
    database: str
    #: How long the first command waits for a reachable server. pymongo's
    #: default is 30s, which turns "mongod isn't running" into a half-minute
    #: hang at boot; a few seconds fails fast with the same error.
    server_selection_timeout_ms: int = 5000
    #: Shows up in mongod's logs and `db.currentOp()` — who is connected.
    app_name: str | None = None
