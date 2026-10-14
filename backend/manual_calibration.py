"""Manual measurements, isolated from file-derived calibration records."""
import json
import math
import sqlite3
import uuid
from datetime import datetime, timezone
from .gcms_calibration import fit_points

BRANCHES = {'GC-MS': None, 'UV-VIS': 'uv-vis', 'LC-MS': 'lc-ms', 'Hapsite': 'hapsite'}
UNITS = ('mg/mL', 'ug/mL', 'ng/mL', 'mg/L', 'ug/L', 'mol/L', 'mmol/L')


def branch_path(root, instrument):
    if instrument not in BRANCHES:
        raise ValueError('Choose an instrument')
    branch = BRANCHES[instrument]
    return (root / 'instruments' / branch if branch else root) / 'calibration_library.sqlite'


def connection(root, instrument):
    path = branch_path(root, instrument)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.execute('CREATE TABLE IF NOT EXISTS manual_calibrations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)')
    return db


def list_manual(root, instrument):
    db = connection(root, instrument)
    try:
        return [json.loads(row[0]) for row in db.execute('SELECT body FROM manual_calibrations ORDER BY rowid DESC')]
    finally:
        db.close()


def text(value, label, required=False, limit=500):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError(f'Invalid {label}')
    return value.strip()


def numeric(value, label, optional=False, positive=False):
    if optional and value in ('', None):
        return None
    if value in ('', None) or isinstance(value, bool):
        raise ValueError(f'{label} must be a finite number')
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(f'{label} must be a finite number')
    if not math.isfinite(result) or result < 0 or (positive and result == 0):
        raise ValueError(f'{label} must be {"positive" if positive else "nonnegative"} and finite')
    return result


def prepare(payload):
    instrument = payload.get('instrument')
    if instrument not in BRANCHES:
        raise ValueError('Choose an instrument')
    identifier = str(uuid.UUID(payload.get('id', '')))
    rows = payload.get('rows')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 200:
        raise ValueError('Add between 1 and 200 measurement rows')
    result = {'id': identifier, 'instrument': instrument, 'origin': 'manual',
              'source': text(payload.get('source', ''), 'source'),
              'method': text(payload.get('method', ''), 'method'),
              'notes': text(payload.get('notes', ''), 'notes', limit=4000),
              'date': text(payload.get('date', ''), 'date'), 'rows': []}
    if result['date']:
        datetime.fromisoformat(result['date'])
    response_type = payload.get('response_type', 'Area')
    if response_type not in ('Area', 'Height', 'Absorbance') or (instrument == 'UV-VIS' and response_type != 'Absorbance'):
        raise ValueError('Choose a valid instrument response type')
    result['response_type'] = response_type
    groups = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError('Invalid measurement row')
        compound = text(row.get('compound', ''), f'compound in row {index + 1}', required=True)
        unit = row.get('unit')
        if unit not in UNITS:
            raise ValueError(f'Choose a concentration unit in row {index + 1}')
        identity = row.get('identity')
        if identity is not None:
            if not isinstance(identity, dict) or identity.get('name') != compound or identity.get('source') not in ('PubChem', 'Lab'):
                raise ValueError('Compound identity does not match the selected name')
            identity = {key: identity.get(key) for key in ('name', 'source', 'cid')}
            if identity['cid'] is not None and (type(identity['cid']) is not int or not 1 <= identity['cid'] <= 2147483647):
                raise ValueError('Invalid PubChem CID')
        item = {'compound': compound, 'identity': identity, 'unit': unit,
                'concentration': numeric(row.get('concentration'), 'Concentration'),
                'rt': numeric(row.get('rt'), 'Retention time', optional=True),
                'wavelength': numeric(row.get('wavelength'), 'Wavelength', optional=True, positive=True),
                'response': numeric(row.get('response'), 'Response', optional=True)}
        if instrument == 'UV-VIS' and item['response'] is not None and item['wavelength'] is None:
            raise ValueError('Wavelength is required for UV-VIS response measurements')
        result['rows'].append(item)
        key = (compound.casefold(), identity.get('cid') if identity else None, unit, item['wavelength'])
        groups.setdefault(key, []).append(item)
    result['curves'] = []
    for items in groups.values():
        curve = {'compound': items[0]['compound'], 'unit': items[0]['unit'], 'wavelength': items[0]['wavelength'], 'fit': None}
        try:
            curve['fit'] = fit_points([{'concentration': r['concentration'], 'area': r['response']} for r in items])
        except ValueError as exc:
            curve['issue'] = str(exc)
        result['curves'].append(curve)
    return result


def save_manual(root, payload, user):
    result = prepare(payload)
    db = connection(root, result['instrument'])
    try:
        with db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT revision,body FROM manual_calibrations WHERE id=?', (result['id'],)).fetchone()
            if row:
                existing = json.loads(row[1])
                if all(existing.get(k) == v for k, v in result.items()):
                    return existing
                if payload.get('revision') != row[0]:
                    raise ValueError('This manual entry changed. Reopen it before saving.')
            elif payload.get('revision') not in (None, 0):
                raise ValueError('Manual entry not found in this instrument branch')
            result.update(revision=(row[0] + 1 if row else 1), updated_at=datetime.now(timezone.utc).isoformat(), updated_by=user)
            db.execute('INSERT OR REPLACE INTO manual_calibrations VALUES (?,?,?)', (result['id'], result['revision'], json.dumps(result, allow_nan=False)))
        return result
    finally:
        db.close()
