"""analytics-service API process.

Run from the service root:  python -m cmd.api.main

Deliberately empty of wiring — see lib/boot/boot.py for why.
"""

from lib.boot.boot import run

if __name__ == "__main__":
    run()
