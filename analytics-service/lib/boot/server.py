import contextlib
import signal
import threading
from collections.abc import Generator

import uvicorn
from uvicorn.server import HANDLED_SIGNALS


class GracefulServer(uvicorn.Server):
    """uvicorn's server, without the signal re-raise.

    After a Ctrl+C / SIGTERM, ``uvicorn.Server.serve()`` shuts HTTP down
    cleanly and then *re-raises the signal* so the process dies the way it
    would have without uvicorn. That is right when uvicorn owns the process.
    Here ``lib/boot`` owns it and still has a consumer to drain, a broker to
    close and Mongo to disconnect after HTTP stops — the re-raised SIGINT
    would interrupt exactly that. This override keeps uvicorn's handling
    (first signal: graceful; second: force) and drops the re-raise.
    """

    @contextlib.contextmanager
    def capture_signals(self) -> Generator[None]:
        if threading.current_thread() is not threading.main_thread():
            yield
            return
        original = {sig: signal.signal(sig, self.handle_exit) for sig in HANDLED_SIGNALS}
        try:
            yield
        finally:
            for sig, handler in original.items():
                signal.signal(sig, handler)
