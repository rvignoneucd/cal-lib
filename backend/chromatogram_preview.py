"""Small, persistent TIC previews; never decompress the mass-spectra matrix."""
import hashlib
import json
import tempfile
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np

_LOCK = threading.Lock()


def cached_chromatogram(source):
    source = Path(source)
    stat = source.stat()
    return _cached(str(source), stat.st_mtime_ns, stat.st_size)


@lru_cache(maxsize=64)
def _cached(source, modified_ns, size):
    path = Path(source)
    signature = hashlib.sha256(f'{modified_ns}:{size}'.encode()).hexdigest()[:16]
    cache = path.with_suffix(f'.tic-v1-{signature}.json')
    with _LOCK:
        if cache.is_file():
            content = cache.read_bytes()
        else:
            with np.load(path, allow_pickle=False) as run:
                # NPZ members load independently. Do not read intensity or mz.
                content = json.dumps({'points': [
                    {'x': float(x), 'y': float(y)} for x, y in zip(run['rt'], run['tic'])
                ]}, allow_nan=False, separators=(',', ':')).encode()
            with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(content)
            temporary.replace(cache)
        return content, '"' + hashlib.sha256(content).hexdigest() + '"'
