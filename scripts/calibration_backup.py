"""Consistent SQLite snapshots; retain raw inputs independently."""
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1] / 'data'
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
dest = root / 'backups' / stamp
dest.mkdir(parents=True, exist_ok=True)
for name in ('lab.sqlite', 'calibration_library.sqlite'):
    source = root / 'state' / name
    if source.exists():
        with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as reader, sqlite3.connect(dest / name) as writer:
            reader.backup(writer)
print(dest)
