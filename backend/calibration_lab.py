"""Private lab adapter. Never register this app on the public Atmos server."""
import asyncio
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from contextlib import asynccontextmanager, contextmanager
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

import numpy as np
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from rainbow.agilent.chemstation import parse_ms

from .calibration_library import register_calibration_library, stamp, CalibrationStore
from .calibration_inspection import inspection_manifest
from .calibration_method import acquisition_profile, acquisition_timing
from .calibration_signal import signal_endpoints
from .calibration_baseline import baseline_bounds
from .gcms_calibration import fit_points
from .parsers.gcms_agilent import parse_chromatograms
from .library.mspepsearch_bridge import search_spectrum_with_mspepsearch, hits_to_dicts, remote_status

STATE = Path(os.getenv('CAL_STATE', '/data/state'))
SOURCE = Path(os.getenv('CAL_SOURCE', '/data/source'))
REPOSITORY_ROOT = Path(os.getenv('CAL_REPOSITORY_ROOT', '/mnt/Nguyen Lab')).resolve()
WEB = Path(os.getenv('CAL_WEB', '/app/web'))
PROJECT = {'id': 'cal-test', 'name': 'Cal Test', 'can_edit': True, 'project_type': 'gcms_calibration'}
SUPPORTED_INSTRUMENTS = ('GC-MS', 'Orbitrap', 'UV-VIS', 'LC-MS', 'Hapsite')
WORK_LOCK = threading.Lock()
CONVERT_LOCK = threading.Lock()
STOP = threading.Event()
TRANSFER_LOCK = threading.Lock()

LIBRARY_SCHEMA = {
    'calibration_drafts': 'CREATE TABLE IF NOT EXISTS calibration_drafts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL)',
    'calibration_versions': 'CREATE TABLE IF NOT EXISTS calibration_versions (id TEXT NOT NULL REFERENCES calibration_drafts(id), version TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id, version))',
    'calibration_preparations': 'CREATE TABLE IF NOT EXISTS calibration_preparations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, dataset_id TEXT NOT NULL, body TEXT NOT NULL)',
}
PUBLISHED_INSTALL_NOTE = '''# Published calibration package\n\nThis package contains the latest published version for each calibration. It is safe to import into an existing library: matching records are skipped, and conflicting IDs are rejected instead of overwritten.\n'''


@contextmanager
def database():
    STATE.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(STATE / 'lab.sqlite', timeout=60)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, body TEXT, PRIMARY KEY(kind,id))')
        with db:
            yield db
    finally:
        db.close()


def put(kind, id, body):
    with database() as db:
        db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?)', (kind, id, json.dumps(body, allow_nan=False)))
    return body


def get(kind, id, default=None):
    with database() as db:
        row = db.execute('SELECT body FROM records WHERE kind=? AND id=?', (kind, id)).fetchone()
    return json.loads(row[0]) if row else default


def all_records(kind):
    with database() as db:
        return [json.loads(row[0]) for row in db.execute('SELECT body FROM records WHERE kind=? ORDER BY rowid', (kind,))]


def repository_path(value=''):
    """Resolve a user-selected repository path without allowing traversal."""
    raw = str(value or '').strip()
    candidate = Path(raw) if raw.startswith('/') else REPOSITORY_ROOT / raw
    candidate = candidate.resolve()
    if not candidate.is_relative_to(REPOSITORY_ROOT):
        raise HTTPException(400, 'Folder must be inside the mounted Nguyen Lab share')
    return candidate


def actor(request: Request):
    return {'id': request.headers.get('tailscale-user-login') or 'lab-worker',
            'name': request.headers.get('tailscale-user-name') or 'Lab'}


def authorize(project_id, user, required='viewer'):
    if project_id != PROJECT['id']:
        raise HTTPException(404, 'Source project not found')
    return PROJECT, 'owner'


def dataset(id):
    row = get('run', id)
    if not row:
        raise HTTPException(404, 'Run not found')
    return row


def run_path(id):
    stored = Path(dataset(id)['path'])
    path = (stored if stored.is_absolute() else SOURCE / stored).resolve()
    allowed = path.is_relative_to(SOURCE.resolve()) or path.is_relative_to(REPOSITORY_ROOT)
    if not allowed or not path.is_dir():
        raise HTTPException(404, 'Source run unavailable')
    return path


def annotations(user, id):
    dataset(id)
    return get('annotations', id, [])


def metadata(project, user=None):
    return {'datasets': [{'id': r['id'], 'source_name': r['filename'], 'instrument_type': 'GCMS'} for r in all_records('run')]}


def method_metadata(id, user):
    row = dataset(id)
    try:
        folder = run_path(id)
        issue = '' if any(p.is_file() and p.suffix.lower() == '.ms' for p in folder.iterdir()) else 'Missing MS data; restore the complete .D folder before selecting this run.'
    except HTTPException:
        issue = 'Source run unavailable'
    return {key: row.get(key, '') for key in ('profile', 'source', 'acquired_at', 'time_source')} | {'source_error': issue}


def scan_source():
    selected = get('state', 'selected_source') or get('state', 'source_roots', {}).get('GC-MS')
    manifest = SOURCE / 'active.json'
    info = json.loads(manifest.read_text()) if manifest.is_file() else None
    if selected:
        root = repository_path(selected['path'])
        fingerprint = hashlib.sha256()
        synced_at = stamp()
    elif info:
        root = (SOURCE / info['folder']).resolve()
        if not root.is_relative_to(SOURCE.resolve()):
            raise ValueError('Invalid source path')
        fingerprint = None
        synced_at = info.get('synced_at', '')
    else:
        return {'fingerprint': '', 'ids': [], 'synced_at': '', 'error': 'Choose a source folder or wait for source-folder sync'}
    ids = []
    for folder in sorted(root.iterdir()):
        if not folder.is_dir() or folder.suffix.lower() != '.d':
            continue
        digest = hashlib.sha256(folder.name.encode())
        for file in sorted(p for p in folder.rglob('*') if p.is_file()):
            if not file.resolve().is_relative_to(root):
                raise ValueError('Source symlinks are not supported')
            digest.update(str(file.relative_to(folder)).encode())
            with file.open('rb') as stream:
                digest.update(hashlib.file_digest(stream, 'sha256').digest())
        id = 'run-' + digest.hexdigest()[:24]
        if fingerprint is not None:
            fingerprint.update(id.encode())
        method = folder / 'acqmeth.txt'
        acquired_profile = acquisition_profile(method) if method.is_file() else {}
        existing = get('run', id)
        if existing is None:
            path = str(folder) if selected else str(folder.relative_to(SOURCE))
            put('run', id, {'id': id, 'filename': folder.name, 'path': path,
                           'profile': {**acquired_profile,
                                       'response': 'TIC', 'area_multiplier': '10', 'integration': 'endpoints'},
                           'source': 'acqmeth.txt', **acquisition_timing(folder)})
        elif acquired_profile:
            refreshed_profile = {**existing.get('profile', {}), **acquired_profile}
            if refreshed_profile != existing.get('profile', {}):
                put('run', id, {**existing, 'profile': refreshed_profile})
        ids.append(id)
    result = {'fingerprint': fingerprint.hexdigest() if fingerprint is not None else info['fingerprint'],
              'ids': ids, 'synced_at': synced_at, 'error': '', 'folder': str(root)}
    put('state', 'source', result)
    return result


def convert(id):
    path = STATE / 'converted' / f'{id}.npz'
    if path.is_file():
        return path
    with CONVERT_LOCK:
        if path.is_file():
            return path
        folder = run_path(id)
        chrom = parse_chromatograms(folder)
        ms_files = sorted(p for p in folder.iterdir() if p.suffix.lower() == '.ms')
        masses = parse_ms(str(ms_files[0]))
        if masses is None or masses.data.shape[0] != len(chrom.rt):
            raise ValueError('Mass spectra and chromatogram scans disagree')
        if not np.allclose(np.asarray(masses.xlabels), chrom.rt, atol=1e-7):
            raise ValueError('Mass-spectrum timestamps disagree with chromatogram')
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp.npz')
        np.savez_compressed(temporary, rt=chrom.rt, tic=chrom.tic, mz=masses.ylabels, intensity=masses.data)
        temporary.replace(path)
        return path


@lru_cache(maxsize=2)
def converted(id):
    with np.load(convert(id), allow_pickle=False) as data:
        return {key: data[key] for key in data.files}


def points(id, trace):
    if trace and trace != 'TIC':
        raise HTTPException(400, 'Only TIC is supported for this library')
    run = converted(id)
    return 'TIC', [SimpleNamespace(x=float(x), y=float(y)) for x, y in zip(run['rt'], run['tic'])]


auto_peaks, integrate = signal_endpoints(points, lambda id, user: dataset(id))


def run_job(job):
    try:
        job.update(state='running', started_at=stamp(), progress='Checking source files')
        put('job', job['id'], job)
        source = scan_source()
        job['fingerprint'] = source['fingerprint']
        put('job', job['id'], job)
        failures = []
        for index, id in enumerate(source['ids']):
            job.update(progress=f"Importing file {index + 1}/{len(source['ids'])}")
            put('job', job['id'], job)
            try:
                convert(id)
            except Exception as error:
                failures.append({'id': id, 'error': str(error)})
        job.update(state='complete', completed_at=stamp(), progress='Files ready; no peak detection performed',
                   result={'runs': len(source['ids']), 'failed': len(failures), 'failures': failures,
                           'created': 0, 'peaks': 0})
        put('state', 'processed', {'fingerprint': source['fingerprint']})
    except Exception as error:
        job.update(state='error', error=str(error), completed_at=stamp())
    finally:
        put('job', job['id'], job)
        WORK_LOCK.release()


def start_job():
    if not WORK_LOCK.acquire(blocking=False):
        return next((j for j in reversed(all_records('job')) if j['state'] in ('queued', 'running')), {})
    job = {'id': str(uuid.uuid4()), 'state': 'queued', 'created_at': stamp(), 'progress': 'Queued'}
    put('job', job['id'], job)
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return job


def monitor_folder(root):
    digest = hashlib.sha256()
    count = 0
    latest = 0
    for base, directories, files in os.walk(root):
        directories[:] = sorted(directory for directory in directories if not directory.startswith('$'))
        for name in sorted(files):
            path = Path(base) / name
            try:
                stat = path.stat()
            except OSError:
                continue
            relative = str(path.relative_to(root))
            digest.update(relative.encode())
            digest.update(str(stat.st_size).encode())
            digest.update(str(stat.st_mtime_ns).encode())
            count += 1
            latest = max(latest, stat.st_mtime_ns)
    return {'fingerprint': digest.hexdigest(), 'file_count': count,
            'last_modified': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(latest / 1_000_000_000)) if latest else ''}


def monitor_sources():
    roots = get('state', 'source_roots', {})
    if not roots:
        return
    changed = False
    for instrument, record in list(roots.items()):
        try:
            root = repository_path(record.get('path'))
            snapshot = monitor_folder(root)
            previous = record.get('fingerprint', '')
            roots[instrument] = {**record, **snapshot, 'last_checked_at': stamp(),
                                 'last_changed_at': stamp() if snapshot['fingerprint'] != previous else record.get('last_changed_at', '')}
            changed = True
        except (HTTPException, OSError, ValueError) as error:
            roots[instrument] = {**record, 'last_checked_at': stamp(), 'error': str(error)}
            changed = True
    if changed:
        put('state', 'source_roots', roots)


def watch():
    while not STOP.wait(60):
        try:
            monitor_sources()
            source = scan_source()
            if source['ids'] and get('state', 'settings', {'automatic': True})['automatic']:
                if source['fingerprint'] != get('state', 'processed', {}).get('fingerprint'):
                    start_job()
        except Exception as error:
            put('state', 'watch_error', {'error': str(error), 'at': stamp()})


@asynccontextmanager
async def lifespan(app):
    STOP.clear()
    for job in all_records('job'):
        if job['state'] in ('queued', 'running'):
            put('job', job['id'], {**job, 'state': 'interrupted', 'error': 'Service restarted; saved run results will be reused'})
    thread = threading.Thread(target=watch, daemon=True)
    thread.start()
    yield
    STOP.set()


app = FastAPI(title='Lab Curve Library', lifespan=lifespan)


@app.post('/api/lab/workbook')
def export_workbook(payload: dict = Body(...)):
    from fastapi.responses import Response
    from .lab_workbook import calibration_workbook
    return Response(calibration_workbook(payload), media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers={'Content-Disposition': 'attachment; filename="calibration.xlsx"'})


@app.get('/api/lab/repositories')
def repositories(instrument: str):
    if instrument not in SUPPORTED_INSTRUMENTS:
        raise HTTPException(400, 'Unknown instrument')
    return get('repositories', instrument, {'revision': 0, 'locations': []})


@app.put('/api/lab/repositories')
def save_repositories(instrument: str, payload: dict = Body(...)):
    repositories(instrument)
    locations = payload.get('locations')
    if not isinstance(locations, list) or len(locations) > 20:
        raise HTTPException(400, 'Use up to 20 locations per instrument')
    clean, seen = [], set()
    for location in locations:
        if not isinstance(location, dict):
            raise HTTPException(400, 'Invalid location')
        path, name = location.get('path', ''), location.get('name', '')
        if not isinstance(path, str) or not isinstance(name, str):
            raise HTTPException(400, 'Location and name must be text')
        path, name = path.strip(), name.strip()
        if not path or len(path) > 1000 or not name or len(name) > 120 or any(ord(c) < 32 for c in path + name):
            raise HTTPException(400, 'Enter a name and valid folder path for every location')
        if not (path.startswith('\\\\') or path.startswith('/') or re.match(r'^[A-Za-z]:[\\/]', path)):
            raise HTTPException(400, 'Use an absolute mounted path or network share path')
        key = path.replace('\\', '/').rstrip('/').casefold() if not path.startswith('/') else path.rstrip('/')
        if key in seen:
            raise HTTPException(400, 'This folder is listed more than once')
        seen.add(key)
        clean.append({'name': name, 'path': path, 'status': 'pending_connection'})
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute("SELECT body FROM records WHERE kind='repositories' AND id=?", (instrument,)).fetchone()
        current = json.loads(row[0]) if row else {'revision': 0}
        if payload.get('revision') != current['revision']:
            raise HTTPException(409, 'Locations changed elsewhere. Reopen the list before saving.')
        result = {'revision': current['revision'] + 1, 'locations': clean}
        db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?)', ('repositories', instrument, json.dumps(result)))
    return result

BRANCHES = {'GC-MS': None, 'Orbitrap': 'orbitrap', 'UV-VIS': 'uv-vis', 'LC-MS': 'lc-ms', 'Hapsite': 'hapsite'}


@app.get('/api/lab/manual-calibrations')
def manual_entries(instrument: str):
    from .manual_calibration import list_manual
    try:
        return {'entries': list_manual(STATE, instrument)}
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post('/api/lab/workbook-imports/preview')
def workbook_preview(payload: dict = Body(...)):
    from .workbook_calibration import preview_upload
    try:
        return preview_upload(payload)
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))


@app.get('/api/lab/workbook-imports')
def workbook_entries(instrument: str):
    return {'entries': [entry for entry in all_records('workbook_import') if entry['instrument'] == instrument]}


@app.post('/api/lab/workbook-imports/fit')
def workbook_fit(payload: dict = Body(...)):
    from .workbook_calibration import fit_curve
    try:
        return fit_curve(payload)
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))


@app.post('/api/lab/workbook-imports')
def workbook_save(request: Request, payload: dict = Body(...)):
    from .workbook_calibration import fit_curve, INSTRUMENTS
    try:
        identifier = str(uuid.UUID(payload.get('id', '')))
        if payload.get('instrument') not in INSTRUMENTS:
            raise ValueError('Choose an instrument')
        if len(json.dumps(payload, allow_nan=False)) > 2_000_000:
            raise ValueError('Import exceeds size limit')
        curves = payload.get('curves', [])
        if not isinstance(curves, list) or not 1 <= len(curves) <= 100:
            raise ValueError('Choose 1 to 100 curves')
        curves = [fit_curve(curve) for curve in curves]
        publishing = payload.get('publish') is True
        selected = [curve for curve in curves if curve.get('selected') is True]
        if publishing and (not selected or any(not c['fit'] or c.get('reviewed') is not True for c in selected)):
            raise ValueError('Review each selected curve and resolve its fit before publishing')
        with database() as db:
            db.execute('BEGIN IMMEDIATE')
            record = db.execute('SELECT body FROM records WHERE kind=? AND id=?', ('workbook_import', identifier)).fetchone()
            old = json.loads(record[0]) if record else {'revision': 0}
            if old.get('status') == 'published':
                raise ValueError('Published imports are read-only')
            if old['revision'] != payload.get('revision', 0):
                raise ValueError('Import draft changed; reopen the saved draft')
            result = {**payload, 'id': identifier, 'curves': curves, 'revision': old['revision'] + 1,
                      'status': 'published' if publishing else 'draft', 'updated_at': stamp(), 'updated_by': actor(request)['id']}
            result.pop('publish', None)
            if publishing:
                result['published_curves'] = selected
                result['published_at'] = stamp()
            db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?)', ('workbook_import', identifier, json.dumps(result, allow_nan=False)))
        return result
    except (ValueError, TypeError) as error:
        raise HTTPException(400, str(error))


@app.post('/api/lab/manual-calibrations')
def manual_save(request: Request, payload: dict = Body(...)):
    from .manual_calibration import save_manual
    try:
        return save_manual(STATE, payload, actor(request)['id'])
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(400, str(exc))


@app.get('/api/lab/compound-suggestions')
def compound_suggestions(q: str, instrument: str):
    from difflib import SequenceMatcher
    from .manual_calibration import list_manual
    from .library.compound_search import search_compounds
    if not 2 <= len(q.strip()) <= 180 or instrument not in BRANCHES:
        raise HTTPException(400, 'Enter 2 to 180 characters and choose an instrument')
    q = q.strip()
    names = {entry.get('compound', '') for entry in instrument_library(instrument)['entries']}
    for entry in list_manual(STATE, instrument):
        names.update(row['compound'] for row in entry['rows'])
    ranked = sorted(((1 if q.casefold() in name.casefold() else SequenceMatcher(None, q.casefold(), name.casefold()).ratio(), name) for name in names if name), reverse=True)
    results = [{'name': name, 'source': 'Lab', 'cid': None} for score, name in ranked[:8] if score >= .45]
    warning = ''
    try:
        results += [{**item, 'source': 'PubChem'} for item in search_compounds(q, 'name')['results']]
    except (LookupError, ValueError):
        warning = 'PubChem unavailable or no exact result; showing local matches.'
    return {'results': results[:20], 'warning': warning}


@app.get('/api/lab/instrument-library')
def instrument_library(instrument: str):
    from .calibration_library import CalibrationStore
    from .calibration_columns import ColumnStore
    if instrument not in BRANCHES:
        raise HTTPException(400, 'Unknown instrument database')
    branch = BRANCHES[instrument]
    root = STATE / 'instruments' / branch if branch else STATE
    path = root / 'calibration_library.sqlite'
    store = CalibrationStore(lambda: path)
    with store.connection() as db:
        entries = [json.loads(row['body']) for row in db.execute('SELECT body FROM calibration_drafts')]
    with ColumnStore(lambda: path).connection():
        pass
    return {'instrument': instrument, 'branch': branch or 'gc-ms', 'entries': entries,
            'import_supported': instrument == 'GC-MS'}


@app.get('/api/lab/compound-info')
def lab_compound_info(name: str):
    from urllib.parse import quote
    from .library.pubchem import _rate_limited_get, _PUBCHEM_BASE, compound_summary
    from .library.compound_structure import compound_structure, StructureUnavailable
    name = name.strip()
    if not name or len(name) > 500:
        raise HTTPException(400, 'Invalid compound name')
    cached = get('pubchem_info', name)
    if cached:
        return cached
    raw = _rate_limited_get(f'{_PUBCHEM_BASE}/compound/name/{quote(name, safe="")}/cids/JSON')
    if not raw:
        return {'found': False, 'message': 'PubChem lookup unavailable. Try again later.'}
    ids = set(json.loads(raw).get('IdentifierList', {}).get('CID', []))
    if len(ids) != 1:
        return {'found': False, 'message': 'No unique PubChem identity for this name.'}
    cid = ids.pop()
    info = compound_summary(cid=cid, name=name)
    try:
        svg = compound_structure(cid)
    except StructureUnavailable:
        svg = None
    result = {'found': True, 'info': info, 'svg': svg}
    if svg and info and info.get('formula'):
        put('pubchem_info', name, result)
    return result


@app.middleware('http')
async def same_origin(request, call_next):
    origin = request.headers.get('origin')
    if request.method not in ('GET', 'HEAD', 'OPTIONS') and origin and urlparse(origin).netloc != request.headers.get('host'):
        return JSONResponse({'detail': 'Cross-origin writes are not allowed'}, status_code=403)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Cache-Control'] = 'no-store' if request.url.path.startswith('/api/') else 'no-cache'
    return response


@app.get('/api/health')
def health():
    with database() as db:
        db.execute('SELECT 1')
    return {'ok': True, 'service': 'private-calibration-library'}


def compound_drafts(draft_id):
    with sqlite3.connect(STATE / 'calibration_library.sqlite') as db:
        drafts = [json.loads(row[0]) for row in db.execute('SELECT body FROM calibration_drafts')]
    target = next((d for d in drafts if d['id'] == draft_id), None)
    if not target:
        raise HTTPException(404, 'Calibration draft not found')
    def scope(d):
        discovery = d.get('discovery') or {}
        return (d.get('project_id'), discovery.get('series'), tuple(sorted(f['id'] for f in discovery.get('files', []))))
    return [d for d in drafts if scope(d) == scope(target)]


def compound_role(draft):
    saved = get('compound_role', draft.get('id', ''))
    if saved:
        return saved['role']
    discovery = draft.get('discovery') or {}
    if discovery.get('identity_source') == 'analyst' and draft.get('compound'):
        return 'calibration'
    if discovery.get('series') == 'CalMix2' and draft.get('compound', '').lower() == 'quinoline':
        return 'normalize'
    return 'calibration' if (discovery.get('qualification') or {}).get('qualified') else 'found'


@app.get('/api/lab/compound-roles')
def compound_roles():
    with database() as db:
        return {'roles': {row['id']: json.loads(row['body'])['role'] for row in db.execute("SELECT id,body FROM records WHERE kind='compound_role'")}}


@app.get('/api/lab/compounds/{draft_id}')
def compound_list(draft_id: str):
    drafts = compound_drafts(draft_id)
    items = [{'id': d['id'], 'compound': d.get('compound'), 'rt': d.get('discovery', {}).get('target_rt'),
              'candidate': d.get('discovery', {}).get('candidate'), 'role': compound_role(d),
              'qualification': d.get('discovery', {}).get('qualification'),
              'normalization': normalization_setting(d['id'], drafts)} for d in drafts]
    items.sort(key=lambda item: item['rt'] if item['rt'] is not None else float('inf'))
    return {'items': items, 'normalization': normalization_setting(draft_id, drafts)}


def normalization_setting(draft_id, drafts):
    saved = get('compound_normalization', draft_id)
    if saved is not None:
        return saved
    return get('normalization', min(d['id'] for d in drafts), {'enabled': False})


@app.put('/api/lab/compounds/{draft_id}')
def assign_compound(draft_id: str, payload: dict = Body(...)):
    drafts = compound_drafts(draft_id)
    if 'role' in payload:
        if payload['role'] not in ('found', 'calibration', 'normalize', 'excluded'):
            raise HTTPException(400, 'Invalid compound role')
        put('compound_role', draft_id, {'role': payload['role'], 'updated_at': stamp()})
    if 'normalization' in payload:
        if not isinstance(payload['normalization'], bool):
            raise HTTPException(400, 'Normalization must be true or false')
        if payload['normalization']:
            target = next(d for d in drafts if d['id'] == draft_id)
            if compound_role(target) != 'calibration' or len([d for d in drafts if compound_role(d) == 'normalize']) != 1:
                raise HTTPException(400, 'Choose exactly one internal standard in the Normalize List first.')
        put('compound_normalization', draft_id, {'enabled': payload['normalization']})
    return compound_list(draft_id)


@app.post('/api/lab/preview')
def preview(payload: dict = Body(...)):
    result = raw_preview(payload)
    if not payload.get('id'):
        return result
    drafts = compound_drafts(payload['id'])
    role = compound_role(payload)
    if role != 'calibration':
        return {**result, 'fit': None, 'issue': 'This compound is not in the Calibration List.'}
    enabled = normalization_setting(payload['id'], drafts).get('enabled')
    if not enabled:
        return result
    references = [d for d in drafts if compound_role(d) == 'normalize']
    if len(references) != 1:
        return {**result, 'fit': None, 'issue': 'Select exactly one normalization reference for this sequence.'}
    reference = references[0]
    areas = {p['dataset_id']: p['area'] for p in raw_preview(reference)['points']}
    rows, issues = [], list(result.get('issues', []))
    for point in result['points']:
        area = areas.get(point['dataset_id'])
        if not area or area <= 0:
            issues.append(f"{point['filename']}: missing normalization area")
            continue
        rows.append({**point, 'raw_area': point['area'], 'reference_area': area, 'area': point['area'] / area})
    try:
        fit = fit_points(rows, payload.get('force_zero', False), auto_zero=not payload.get('force_zero_manual', False))
        issue = None
    except ValueError as error:
        fit, issue = None, str(error)
    return {'fit': fit, 'points': rows, 'issues': issues, 'issue': issue, 'provisional': True,
            'normalized': True, 'reference': reference['compound']}


def raw_preview(payload):
    discovery = payload.get('discovery') or {}
    target = discovery.get('candidate') or {}
    anchor = discovery.get('target_rt')
    rows, issues = [], []
    if anchor is None:
        return {'fit': None, 'points': [], 'issue': 'No compound RT selected'}
    with sqlite3.connect(STATE / 'calibration_library.sqlite') as db:
        prepared = {}
        for id in discovery.get('preparations', []):
            record = db.execute('SELECT body FROM calibration_preparations WHERE id=?', (id,)).fetchone()
            if record:
                run = json.loads(record[0])
                prepared[run['id']] = run
    for file in discovery.get('files', []):
        excluded = any(row.get('dataset_id') == file['id'] and row.get('excluded') for row in payload.get('rows', []))
        run = prepared.get(file['id'], {})
        candidates = []
        for peak in run.get('peaks', []):
            hit = (peak.get('hits') or [{}])[0]
            same = hit.get('cas') == target['cas'] if target.get('cas') else hit.get('name') == target.get('name')
            selected = discovery.get('selected_peaks') or {}
            assigned = abs(peak['rt_apex'] - selected[file['id']]) < 0.000001 if file['id'] in selected else same
            if assigned:
                candidates.append(peak)
        level = (file.get('hint') or {}).get('level') or {}
        candidate_rt = candidates[0]['rt_apex'] if len(candidates) == 1 else (discovery.get('selected_peaks') or {}).get(file['id'], anchor)
        correction = get('draft_area', f"{payload.get('id')}:{file['id']}:{candidate_rt:.6f}")
        if not correction and payload.get('id'):
            covering = [a for a in draft_areas(payload['id'])['areas'] if a['dataset_id'] == file['id']
                        and a['measurement']['left'] <= candidate_rt <= a['measurement']['right']]
            if len(covering) == 1:
                correction = covering[0]
        if (len(candidates) != 1 and not correction) or level.get('value') is None:
            if level.get('value') is None:
                issues.append(f"{file['filename']}: enter concentration")
            elif not excluded:
                issues.append(f"{file['filename']}: draw area")
            continue
        peak = candidates[0] if len(candidates) == 1 else {'rt_apex': candidate_rt}
        if correction:
            peak = {**peak, **correction['measurement']}
            peak['rt_apex'] = correction['measurement'].get('apex_x', candidate_rt)
        if not math.isfinite(peak['net_area']) or peak['net_area'] <= 0:
            issues.append(f"{file['filename']}: non-positive automatic area; review baseline")
            continue
        rows.append({'dataset_id': file['id'], 'filename': file['filename'], 'concentration': level['value'],
                     'area': peak['net_area'], 'rt': peak['rt_apex'], 'unconfirmed_manual': bool(correction), 'excluded': excluded})
    rows.sort(key=lambda row: row['concentration'])
    qualification = discovery.get('qualification')
    if qualification and not qualification.get('qualified') and compound_role(payload) != 'calibration':
        return {'fit': None, 'points': rows, 'issues': issues, 'issue': qualification.get('reason'), 'provisional': True}
    try:
        fit = fit_points(rows, payload.get('force_zero', False), auto_zero=not payload.get('force_zero_manual', False))
        for row in rows:
            row['residual'] = row['area'] - (fit['slope'] * row['concentration'] + fit['intercept'])
        return {'fit': fit, 'points': rows, 'issues': issues, 'provisional': True}
    except ValueError as error:
        return {'fit': None, 'points': rows, 'issues': issues, 'issue': str(error), 'provisional': True}


@app.get('/api/lab/areas/{draft_id}')
def draft_areas(draft_id: str):
    return {'areas': [record for record in all_records('draft_area') if record['draft_id'] == draft_id]}


@app.get('/api/lab/preparation/{dataset_id}')
def existing_preparation(dataset_id: str):
    dataset(dataset_id)
    with sqlite3.connect(STATE / 'calibration_library.sqlite') as db:
        rows = db.execute('SELECT body FROM calibration_preparations WHERE dataset_id=? ORDER BY rowid DESC', (dataset_id,)).fetchall()
    records = [json.loads(row[0]) for row in rows]
    return {'preparation': next((record for record in records if not record.get('error')), None)}


@app.put('/api/lab/areas/{draft_id}/{dataset_id}')
def save_draft_area(draft_id: str, dataset_id: str, payload: dict = Body(...)):
    with sqlite3.connect(STATE / 'calibration_library.sqlite') as db:
        found = db.execute('SELECT body FROM calibration_drafts WHERE id=?', (draft_id,)).fetchone()
    if not found:
        raise HTTPException(404, 'Calibration draft not found')
    draft = json.loads(found[0])
    if dataset_id not in [file['id'] for file in draft.get('discovery', {}).get('files', [])]:
        raise HTTPException(400, 'Run does not belong to this series')
    rt = payload.get('candidate_rt')
    if not isinstance(rt, (float, int)) or not math.isfinite(rt):
        raise HTTPException(400, 'A finite candidate RT is required')
    result = measure(dataset_id, payload)
    record = {'draft_id': draft_id, 'dataset_id': dataset_id, 'candidate_rt': rt,
              'measurement': result, 'updated_at': stamp()}
    put('draft_area', f'{draft_id}:{dataset_id}:{rt:.6f}', record)
    return record


@app.get('/api/projects')
def projects():
    return {'projects': [PROJECT]}


@app.get('/api/lab/compound-names')
def compound_names(name: str):
    if not name.strip() or len(name) > 240:
        raise HTTPException(400, 'Enter a compound name up to 240 characters')
    from .library.pubchem import common_name_choices
    return common_name_choices(name=name.strip(), limit=100)


def _library_rows(path, table):
    columns = {
        'calibration_drafts': ('id', 'project_id', 'revision', 'body'),
        'calibration_versions': ('id', 'version', 'body'),
        'calibration_preparations': ('id', 'project_id', 'dataset_id', 'body'),
    }[table]
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        db.execute(LIBRARY_SCHEMA[table])
        return [tuple(row[column] for column in columns) for row in db.execute(
            f"SELECT {', '.join(columns)} FROM {table}")]


def _make_published_package():
    source = STATE / 'calibration_library.sqlite'
    published = []
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(prefix='published-export-', suffix='.sqlite', delete=False) as handle:
            temp_path = Path(handle.name)
        with sqlite3.connect(temp_path) as output:
            for statement in LIBRARY_SCHEMA.values():
                output.execute(statement)
            if source.exists():
                with sqlite3.connect(source) as current:
                    current.row_factory = sqlite3.Row
                    drafts = current.execute(
                        'SELECT id, project_id, revision, body FROM calibration_drafts '
                        'WHERE id IN (SELECT DISTINCT id FROM calibration_versions) ORDER BY rowid').fetchall()
                    for draft in drafts:
                        versions = current.execute(
                            'SELECT id, version, body FROM calibration_versions WHERE id=? ORDER BY rowid DESC',
                            (draft['id'],)).fetchall()
                        if not versions:
                            continue
                        version = versions[0]
                        output.execute('INSERT INTO calibration_drafts VALUES (?,?,?,?)', tuple(draft))
                        output.execute('INSERT INTO calibration_versions VALUES (?,?,?)', tuple(version))
                        published.append(json.loads(version['body']))
            output.commit()
        database_bytes = temp_path.read_bytes()
    finally:
        if temp_path:
            temp_path.unlink(missing_ok=True)
    published_bytes = json.dumps(published, indent=2, ensure_ascii=False, allow_nan=False).encode('utf-8')
    manifest = {
        'exported_at_utc': stamp(),
        'scope': 'Latest published version per calibration only',
        'count': len(published),
        'calibrations': [{'id': item.get('id'), 'compound': item.get('compound', ''), 'version': item.get('version')}
                         for item in published],
        'sha256': {
            'calibration_library.sqlite': hashlib.sha256(database_bytes).hexdigest(),
            'published.json': hashlib.sha256(published_bytes).hexdigest(),
        },
    }
    package = io.BytesIO()
    with zipfile.ZipFile(package, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('manifest.json', json.dumps(manifest, indent=2, ensure_ascii=False).encode('utf-8'))
        archive.writestr('INSTALL.md', PUBLISHED_INSTALL_NOTE.encode('utf-8'))
        archive.writestr('calibration_library.sqlite', database_bytes)
        archive.writestr('published.json', published_bytes)
    return package.getvalue(), manifest


def _validate_published_package(payload):
    if len(payload) > 50 * 1024 * 1024:
        raise HTTPException(413, 'Published package is larger than 50 MB')
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
        names = archive.namelist()
        allowed = {'manifest.json', 'published.json', 'calibration_library.sqlite', 'INSTALL.md'}
        if len(names) != len(set(names)) or any('/' in name or name not in allowed for name in names):
            raise ValueError('Unexpected package contents')
        required = {'manifest.json', 'published.json', 'calibration_library.sqlite'}
        if not required.issubset(names):
            raise ValueError('Package is missing a required file')
        manifest = json.loads(archive.read('manifest.json'))
        published = json.loads(archive.read('published.json'))
        database_bytes = archive.read('calibration_library.sqlite')
    except (zipfile.BadZipFile, KeyError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(400, f'Invalid published package: {error}')
    if not isinstance(manifest, dict) or not isinstance(published, list):
        raise HTTPException(400, 'Invalid published package metadata')
    expected_hashes = manifest.get('sha256') or {}
    for name, data in (('calibration_library.sqlite', database_bytes),
                       ('published.json', archive.read('published.json'))):
        if expected_hashes.get(name) != hashlib.sha256(data).hexdigest():
            raise HTTPException(400, f'Checksum failed for {name}')
    if manifest.get('count') != len(published) or manifest.get('scope') != 'Latest published version per calibration only':
        raise HTTPException(400, 'Unsupported published package scope')
    published_keys = {(item.get('id'), item.get('version')) for item in published
                      if isinstance(item, dict) and item.get('id') and item.get('version')}
    if len(published_keys) != len(published):
        raise HTTPException(400, 'Published records must have unique IDs and versions')
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(prefix='published-import-', suffix='.sqlite', delete=False) as handle:
            temp_path = Path(handle.name)
            handle.write(database_bytes)
        with sqlite3.connect(temp_path) as incoming:
            if incoming.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('SQLite integrity check failed')
            for statement in LIBRARY_SCHEMA.values():
                table = statement.split()[5]
                if not incoming.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                    raise ValueError(f'Missing table {table}')
            incoming_versions = {(row[0], row[1]) for row in incoming.execute('SELECT id, version FROM calibration_versions')}
            if incoming_versions != published_keys:
                raise ValueError('Published JSON does not match the database versions')
            rows = {table: _library_rows(temp_path, table) for table in LIBRARY_SCHEMA}
    except (sqlite3.DatabaseError, ValueError) as error:
        raise HTTPException(400, f'Invalid published database: {error}')
    finally:
        if temp_path:
            temp_path.unlink(missing_ok=True)
    return rows, published


@app.get('/api/lab/published/export')
def published_export():
    with TRANSFER_LOCK:
        package, _ = _make_published_package()
    filename = f"calibration-published-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}.zip"
    return Response(package, media_type='application/zip',
                    headers={'Content-Disposition': f'attachment; filename="{filename}"'})


@app.post('/api/lab/published/import')
async def published_import(request: Request):
    rows, published = _validate_published_package(await request.body())
    db_path = STATE / 'calibration_library.sqlite'
    key_columns = {
        'calibration_drafts': ('id',),
        'calibration_versions': ('id', 'version'),
        'calibration_preparations': ('id',),
    }
    with TRANSFER_LOCK:
        STATE.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(db_path) as current:
            for statement in LIBRARY_SCHEMA.values():
                current.execute(statement)
            conflicts = []
            skipped = {table: 0 for table in LIBRARY_SCHEMA}
            inserts = {table: 0 for table in LIBRARY_SCHEMA}
            to_insert = {table: [] for table in LIBRARY_SCHEMA}
            for table, incoming_rows in rows.items():
                columns = tuple(key_columns[table])
                key_sql = ' AND '.join(f'{column}=?' for column in columns)
                for row in incoming_rows:
                    key = tuple(row[index] for index, column in enumerate(('id', 'version', 'body', 'project_id', 'revision', 'dataset_id')) if column in columns)
                    # The row layouts are fixed above; derive keys directly to keep the conflict check explicit.
                    if table == 'calibration_drafts':
                        key = (row[0],)
                    elif table == 'calibration_versions':
                        key = (row[0], row[1])
                    else:
                        key = (row[0],)
                    existing = current.execute(f'SELECT * FROM {table} WHERE {key_sql}', key).fetchone()
                    if existing:
                        if tuple(existing) != tuple(row):
                            conflicts.append(f'{table}:{key}')
                        else:
                            skipped[table] += 1
                    else:
                        to_insert[table].append(row)
            if conflicts:
                raise HTTPException(409, 'Import contains conflicting existing records: ' + ', '.join(conflicts[:10]))
            backup_name = None
            if any(to_insert.values()):
                backup_name = f"calibration_library.before-import-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}.sqlite"
                backup_path = STATE / backup_name
                current.commit()
                with sqlite3.connect(backup_path) as backup:
                    current.backup(backup)
            current.execute('BEGIN IMMEDIATE')
            for table in ('calibration_drafts', 'calibration_versions', 'calibration_preparations'):
                columns = {'calibration_drafts': 'id,project_id,revision,body',
                            'calibration_versions': 'id,version,body',
                            'calibration_preparations': 'id,project_id,dataset_id,body'}[table]
                for row in to_insert[table]:
                    current.execute(f'INSERT OR IGNORE INTO {table} ({columns}) VALUES ({",".join("?" for _ in row)})', row)
                inserts[table] = len(to_insert[table])
            current.commit()
    return {'ok': True, 'calibrations': len(published), 'imported': inserts, 'skipped': skipped,
            'backup': backup_name}


@app.get('/api/lab/status')
def status():
    return {'source': get('state', 'source', {}), 'selection': get('state', 'selected_source', {}),
            'selections': get('state', 'source_roots', {}),
            'jobs': list(reversed(all_records('job')))[0:10],
            'settings': get('state', 'settings', {'automatic': True}),
            'watch_error': get('state', 'watch_error', {}), 'runs': len(all_records('run'))}


@app.get('/api/lab/nist')
def nist_status():
    info = remote_status()
    return {'available': bool(info.get('available')), 'error': info.get('error', ''), 'engine': 'NIST MSPepSearch'}


@app.put('/api/lab/settings')
def settings(payload: dict = Body(...)):
    if not isinstance(payload.get('automatic'), bool):
        raise HTTPException(400, 'Automatic must be true or false')
    return put('state', 'settings', {'automatic': payload['automatic']})


@app.post('/api/lab/scan')
def scan():
    return {'job': start_job()}


@app.get('/api/lab/repository-browse')
def repository_browse(path: str = ''):
    current = repository_path(path)
    entries = []
    for entry in sorted(current.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold())):
        if entry.is_dir() and not entry.name.startswith('$'):
            entries.append({'name': entry.name, 'path': str(entry.relative_to(REPOSITORY_ROOT))})
    relative = str(current.relative_to(REPOSITORY_ROOT)) if current != REPOSITORY_ROOT else ''
    parent = str(current.parent.relative_to(REPOSITORY_ROOT)) if current != REPOSITORY_ROOT else None
    return {'root': str(REPOSITORY_ROOT), 'path': relative, 'absolute_path': str(current),
            'parent_path': parent, 'entries': entries[:500]}


@app.get('/api/lab/source-selection')
def source_selection(instrument: str = 'GC-MS'):
    if instrument not in SUPPORTED_INSTRUMENTS:
        raise HTTPException(400, 'Unknown instrument')
    roots = get('state', 'source_roots', {})
    return roots.get(instrument, {'instrument': instrument, 'path': '', 'name': ''})


@app.put('/api/lab/source-selection')
def save_source_selection(instrument: str, payload: dict = Body(...)):
    if instrument not in SUPPORTED_INSTRUMENTS:
        raise HTTPException(400, 'Unknown instrument')
    path = repository_path(payload.get('path'))
    if not path.is_dir():
        raise HTTPException(400, 'Choose an existing folder')
    roots = get('state', 'source_roots', {})
    result = {'instrument': instrument, 'path': str(path), 'name': path.name or str(path),
              'updated_at': stamp(), 'error': ''}
    roots[instrument] = result
    put('state', 'source_roots', roots)
    if instrument == 'GC-MS':
        put('state', 'selected_source', result)
    return result


@app.get('/api/lab/current-runs')
def current_runs():
    return {'ids': get('state', 'source', {}).get('ids', [])}


@app.post('/api/datasets/precompute-acg-ams')
def precompute(payload: dict = Body(...)):
    ids = payload.get('dataset_ids', [])
    if not isinstance(ids, list) or not 0 < len(ids) <= 500:
        raise HTTPException(400, 'Select up to 500 runs')
    errors = []
    for id in ids:
        try:
            convert(id)
        except Exception as error:
            errors.append({'id': id, 'error': str(error)})
    return {'job': {'id': str(uuid.uuid4()), 'state': 'complete' if not errors else 'error', 'errors': errors}}


@app.get('/api/datasets/{id}/chromatogram')
def chromatogram(id: str):
    try:
        _, data = points(id, 'TIC')
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return {'points': [vars(p) for p in data]}


@app.get('/api/lab/inspection-run/{run_id}')
def inspection_run(run_id: str):
    record = get('run', run_id)
    if not record:
        raise HTTPException(404, 'Source run not found')
    return {'compound': '', 'runs': [{'id': run_id, 'filename': record.get('filename', run_id), 'available': True}]}


@app.get('/api/lab/inspection-run/{run_id}/spectrum')
def inspection_run_spectrum(run_id: str, rt: float):
    inspection_run(run_id)
    return run_spectrum(run_id, rt)


@app.get('/api/lab/inspection/{id}')
def inspection(id: str, version: str = 'draft'):
    draft = CalibrationStore(lambda: STATE / 'calibration_library.sqlite').get(id)
    return inspection_manifest(draft, version, lambda run_id: get('run', run_id), draft_areas(id)['areas'])


@app.get('/api/lab/inspection/{id}/spectrum/{run_id}')
def inspection_spectrum(id: str, run_id: str, rt: float, version: str = 'draft'):
    manifest = inspection(id, version)
    if not any(run['id'] == run_id for run in manifest['runs']):
        raise HTTPException(404, 'Run not in this series')
    return run_spectrum(run_id, rt)


def run_spectrum(run_id, rt):
    if not math.isfinite(rt):
        raise HTTPException(400, 'Invalid retention time')
    run = converted(run_id)
    index = int(np.argmin(np.abs(run['rt'] - rt)))
    intensity = run['intensity'][index]
    mask = intensity > 0
    return {'rt': float(run['rt'][index]), 'points': [{'mz': float(m), 'intensity': float(y)} for m, y in zip(run['mz'][mask], intensity[mask])]}


@app.post('/api/datasets/{id}/auto-peaks')
def detect(id: str, payload: dict = Body(...)):
    payload = {'area_multiplier': 10, **payload}
    result = auto_peaks(id, payload)
    _, raw = points(id, 'TIC')
    for peak, (left, right) in zip(result['peaks'], baseline_bounds(raw, result['peaks'])):
        if right <= left:
            continue
        measured = integrate(id, {**payload, 'left': left, 'right': right, 'baseline_mode': 'endpoints'})
        peak.update(measured)
        peak.update(rt_left=left, rt_right=right)
        if not left < peak['rt_apex'] < right or measured['net_area'] <= 0:
            peak['integration_error'] = 'Automatic baseline is invalid; redraw and verify this peak.'
    return result


@app.post('/api/datasets/{id}/integrate')
def measure(id: str, payload: dict = Body(...)):
    payload = {'area_multiplier': 10, **payload}
    try:
        if not all(math.isfinite(float(payload[k])) for k in ('left', 'right')):
            raise ValueError()
        if float(payload.get('area_multiplier', 60)) <= 0 or not math.isfinite(float(payload.get('area_multiplier', 60))):
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise HTTPException(400, 'Finite bounds and a positive area multiplier are required')
    if payload.get('baseline_mode', 'endpoints') != 'endpoints':
        raise HTTPException(400, 'This library uses endpoint baselines')
    return integrate(id, payload)


@app.post('/api/datasets/{id}/library/search-batch')
def search(id: str, payload: dict = Body(...)):
    full = True  # Calibration evidence always uses a full NIST search.
    rts = payload.get('rts')
    if not isinstance(rts, list) or len(rts) > 12 or not all(isinstance(t, (int, float)) and math.isfinite(t) for t in rts):
        raise HTTPException(400, 'Choose up to 12 finite retention times')
    run = converted(id)
    results = []
    for rt in rts:
        index = int(np.argmin(np.abs(run['rt'] - rt)))
        key = f'{id}:{index}:nist23-mainlib-full-v1' if full else f'{id}:{index}:nist23-mainlib-v1'
        cached = get('search', key)
        if cached is None:
            try:
                intensity = run['intensity'][index]
                mask = intensity > 0
                hits = search_spectrum_with_mspepsearch(run['mz'][mask], intensity[mask], top_n=5, min_score=0,
                                                       search_type='sI' if full else 'I',
                                                       query_name=f'Cal Library {id} {rt:.5f}', timeout_seconds=60,
                                                       dataset_id=id, project_id=PROJECT['id'])
                cached = {'hits': hits_to_dicts(hits), 'engine': 'mspepsearch', 'search_type': 'sI' if full else 'I', 'searched_at': stamp()}
                put('search', key, cached)
            except Exception as error:
                cached = {'hits': [], 'error': str(error)}
        selected = get('identity', f'{id}:{index}')
        if selected:
            cached = {**cached, 'hits': [selected['hit']] + [h for h in cached.get('hits', []) if h != selected['hit']], 'identity_confirmed': True}
        if full and cached.get('hits') and not selected:
            from .library.pubchem import lookup_by_cas
            hit = cached['hits'][0]
            if hit.get('cas') and not hit.get('common_name'):
                try:
                    record = lookup_by_cas(hit['cas'])
                    if record and record.common_name:
                        hit = {**hit, 'common_name': record.common_name, 'pubchem_cid': record.pubchem_cid}
                        cached = {**cached, 'hits': [hit, *cached['hits'][1:]]}
                        put('search', key, cached)
                except Exception:
                    pass  # Naming enrichment must not discard successful spectral evidence.
        results.append({**cached, 'rt': rt})
    return {'results': results}


def filename_support(filename, hit):
    clean = lambda text: re.sub(r'[^a-z0-9]', '', str(text).lower())
    aliases = {'90028': ['salicylaldehyde', 'salicyldehyde'], '121335': ['vanillin'], '91225': ['quinoline']}
    names = [hit.get('name', ''), hit.get('common_name', '')] + aliases.get(clean(hit.get('cas', '')), [])
    return any(len(clean(name)) >= 5 and clean(name) in clean(filename) for name in names)


@app.get('/api/datasets/{id}/peak-identity')
def peak_identity(id: str, rt: float):
    if not math.isfinite(rt):
        raise HTTPException(400, 'Finite RT required')
    run = converted(id)
    index = int(np.argmin(np.abs(run['rt'] - rt)))
    intensity = run['intensity'][index]
    mask = intensity > 0
    key = f'{id}:{index}:nist23-mainlib-full-top50-v1'
    cached = get('search', key)
    if cached is None:
        hits = search_spectrum_with_mspepsearch(run['mz'][mask], intensity[mask], top_n=50, min_score=0,
            search_type='sI', query_name=f'Identity review {id} {rt:.5f}', timeout_seconds=60, dataset_id=id, project_id=PROJECT['id'])
        cached = {'hits': hits_to_dicts(hits)}
        put('search', key, cached)
    filename = dataset(id)['filename']
    hits = [{**hit, 'rank': i+1, 'filename_support': filename_support(filename, hit)} for i, hit in enumerate(cached['hits'])]
    # Filename evidence is a small, visible tie-breaker, never a confirmed identity.
    hits.sort(key=lambda h: -(float(h.get('match_score') or 0) + (20 if h['filename_support'] else 0)))
    return {'rt': float(run['rt'][index]), 'filename': filename, 'hits': hits,
            'spectrum': [{'mz': float(m), 'intensity': float(y)} for m,y in zip(run['mz'][mask], intensity[mask])],
            'selected': get('identity', f'{id}:{index}')}


@app.put('/api/datasets/{id}/peak-identity')
def confirm_peak_identity(id: str, payload: dict = Body(...)):
    rt, rank = payload.get('rt'), payload.get('rank')
    if not isinstance(rt, (int, float)) or not math.isfinite(rt) or not isinstance(rank, int):
        raise HTTPException(400, 'RT and search rank required')
    run = converted(id)
    index = int(np.argmin(np.abs(run['rt'] - rt)))
    cached = get('search', f'{id}:{index}:nist23-mainlib-full-top50-v1')
    if not cached or not 1 <= rank <= len(cached['hits']):
        raise HTTPException(400, 'Select a returned NIST candidate')
    hit = cached['hits'][rank-1]
    result = put('identity', f'{id}:{index}', {'hit': hit, 'rt': float(run['rt'][index]), 'confirmed_at': stamp()})
    start_job()
    return result


@app.get('/api/datasets/{id}/annotations')
def read_annotations(id: str):
    values = annotations(None, id)
    return {'peaks': values, 'stored_peaks': values}


@app.put('/api/datasets/{id}/annotations')
def save_annotations(id: str, payload: dict = Body(...)):
    dataset(id)
    peaks = payload.get('peaks')
    if not isinstance(peaks, list) or len(peaks) > 2000 or any(not isinstance(p, dict) for p in peaks):
        raise HTTPException(400, 'Invalid reviewed areas')
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute("SELECT body FROM records WHERE kind='annotations' AND id=?", (id,)).fetchone()
        old = json.loads(existing[0]) if existing else []
        if payload.get('expected_peaks') != old:
            raise HTTPException(409, 'Reviewed areas changed. Reload before saving.')
        # Recalculate reviewed measurement values from the immutable raw scans.
        for peak in peaks:
            if peak in old:
                continue
            review = peak.get('calibration_preparation', {})
            identity_confirmed = review.get('match_confirmed') is True or (review.get('identity_confirmed') is True and review.get('identity_source') == 'analyst' and bool(str(peak.get('compound') or '').strip()))
            if not identity_confirmed or not (review.get('area_confirmed') is True or review.get('area_drawn') is True):
                raise HTTPException(400, 'Confirm identity and area before saving')
            measured = measure(id, {'left': peak.get('rt_left'), 'right': peak.get('rt_right'),
                                    'area_multiplier': review.get('area_multiplier')})
            peak.update(area_value=measured['net_area'], net_area=measured['net_area'],
                        area=str(measured['net_area']), segment=measured['segment'])
        db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?)', ('annotations', id, json.dumps(peaks, allow_nan=False)))
    return {'peaks': peaks}


register_calibration_library(app, current_user=actor, authorize=authorize, metadata=metadata,
                             annotations=annotations, method_metadata=method_metadata,
                             path=lambda: STATE / 'calibration_library.sqlite', literal_search=True)

if (WEB / 'assets').is_dir():
    app.mount('/assets', StaticFiles(directory=WEB / 'assets'), name='assets')

if (WEB / 'cal-lib-logo.png').is_file():
    @app.get('/cal-lib-logo.png')
    def cal_lib_logo():
        return FileResponse(WEB / 'cal-lib-logo.png', media_type='image/png')


@app.get('/')
@app.get('/calibrations/')
@app.get('/inspection/')
def index():
    return FileResponse(WEB / 'calibration-lab.html')
