"""Deterministic source identities, independent of display names and users."""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re

_PARSER_SOURCE = ContextVar('parser_source', default=None)


def normalized_path(value):
    text = str(value or '').replace('\\', '/')
    if not text:
        raise ValueError('A source locator is required')
    if re.match(r'^[A-Za-z]:/', text) or text.startswith('//'):
        return ntpath.normcase(ntpath.normpath(text)).replace('\\', '/')
    return os.path.normpath(str(Path(text).expanduser().absolute()))


def source_identity(instrument, path, meta=None):
    meta = meta or {}
    item = str(meta.get('box_item_id') or meta.get('box_file_id') or meta.get('box_folder_id') or '')
    identity = {'version': 2, 'instrument': str(instrument).upper()}
    if meta.get('box_source'):
        if not item:
            raise ValueError('Box source is missing its immutable item ID')
        identity.update(provider='box', item=item, kind='folder' if meta.get('box_folder_id') else 'file',
                        revision=str(meta.get('box_modified') or ''), size=meta.get('box_size'))
    else:
        identity.update(provider='local', path=normalized_path(path), revision=source_revision(path))
    if meta.get('uvvis_column'):
        identity['column'] = {'sheet': str(meta.get('sheet') or ''), 'index': int(meta['uvvis_col'])}
    return identity


def canonical_dataset_id(instrument, path, meta=None):
    bound = _PARSER_SOURCE.get()
    if bound and normalized_path(path) == normalized_path(bound[0]):
        meta = {**bound[1], **(meta or {})}
    identity = source_identity(instrument, path, meta)
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return f'{str(instrument).lower()}-src2-{digest}'


def is_canonical(dataset_id):
    return bool(re.fullmatch(r'[a-z0-9]+-src2-[a-f0-9]{64}', str(dataset_id)))


def source_revision(path):
    source = Path(path)
    if not source.exists():
        return None
    files = sorted(source.rglob('*')) if source.is_dir() else [source]
    entries = []
    for item in files:
        if item.is_file() and not item.name.startswith('.atmos'):
            stat = item.stat()
            entries.append((str(item.relative_to(source)) if item != source else '', stat.st_size, stat.st_mtime_ns))
    return hashlib.sha256(json.dumps(entries, separators=(',', ':')).encode()).hexdigest()


def parser_cache_key(path):
    return hashlib.sha256(json.dumps([normalized_path(path), source_revision(path)]).encode()).hexdigest()


def parser_source_metadata(path):
    bound = _PARSER_SOURCE.get()
    if not bound or normalized_path(path) != normalized_path(bound[0]):
        return {}
    return {key: value for key, value in bound[1].items() if key in {
        'box_source', 'box_user_id', 'box_item_id', 'box_file_id',
        'box_folder_id', 'box_uri', 'box_modified', 'box_size',
    }}


@contextmanager
def parser_source(path, meta):
    token = _PARSER_SOURCE.set((path, meta))
    try:
        yield
    finally:
        _PARSER_SOURCE.reset(token)
