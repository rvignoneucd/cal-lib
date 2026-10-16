"""Hosted calibration drafts and immutable, project-authorized versions."""
import copy
import hashlib
import json
import math
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from fastapi import BackgroundTasks, Body, Depends, HTTPException, Query

from .area_review import auto_area_needs_review
from .gcms_calibration import fit_points, peak_identity
from .calibration_columns import COLUMN_FIELDS, register_columns

PROFILE_FIELDS = ('instrument', 'instrument_label', 'method', 'column_model', 'column_phase',
                  'column_length_m', 'column_id_um', 'column_film_um',
                  'acquisition_mode', 'response', 'area_multiplier', 'integration', 'method_signature')
NUMERIC_PROFILE = ('column_length_m', 'column_id_um', 'column_film_um', 'area_multiplier')
UNITS = ('ug/mL', 'mg/mL', 'ng/mL')


def stamp():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def number(value, label, *, zero=False):
    try:
        if isinstance(value, bool) or value is None or value == '':
            raise ValueError()
        result = float(value)
        if not math.isfinite(result) or (result < 0 if zero else result <= 0):
            raise ValueError()
        return result
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f'{label} must be a finite {"nonnegative" if zero else "positive"} number')


def clean_profile(raw, required=False):
    if not isinstance(raw, dict):
        raise ValueError('Invalid acquisition profile')
    profile = {key: str(raw.get(key) or '').strip()[:240] for key in PROFILE_FIELDS}
    if required:
        missing = [key.replace('_', ' ') for key, value in profile.items()
                   if not value and key not in ('method_signature', 'instrument_label')]
        if missing:
            raise ValueError('Confirm acquisition details: ' + ', '.join(missing))
    for key in NUMERIC_PROFILE:
        if profile[key]:
            profile[key] = str(number(profile[key], key.replace('_', ' ')))
    # The first slice sources saved TIC integrations, not arbitrary responses.
    if profile['response'] and profile['response'].upper() != 'TIC':
        raise ValueError('This version supports saved TIC integrations only')
    profile['response'] = profile['response'].upper()
    return profile


def measurement(peak):
    area = peak.get('area_value') if peak.get('area_value') is not None else peak.get('net_area')
    if isinstance(area, bool) or not isinstance(area, (int, float)) or not math.isfinite(area):
        area = None
    return {**peak_identity(peak), 'peak_id': peak.get('annotationId'), 'area': area,
            'rt': peak.get('rt_apex'), 'left': peak.get('rt_left'), 'right': peak.get('rt_right'),
            'baseline': peak.get('manual_baseline'), 'review_needed': auto_area_needs_review(peak),
            **({'preparation': peak['calibration_preparation']} if peak.get('calibration_preparation') else {})}


def validate_preparation(peak, profile):
    review = peak.get('preparation')
    if review is None:
        return
    if not isinstance(review, dict) or not (review.get('match_confirmed') is True or (review.get('identity_confirmed') is True and review.get('identity_source') == 'analyst')) or not (review.get('area_drawn') is True or review.get('area_confirmed') is True):
        raise ValueError('Confirm the detected identity and review its integration before fitting')
    if number(review.get('area_multiplier'), 'Measured area multiplier') != number(profile.get('area_multiplier'), 'Acquisition area multiplier'):
        raise ValueError('Reviewed area multiplier differs from the acquisition profile')
    if review.get('integration') == 'endpoints' and profile.get('integration', '').casefold() not in ('endpoints', 'linear baseline'):
        raise ValueError('Reviewed area uses an endpoint baseline; acquisition integration must agree')


def build_fit(draft, files):
    """Read server-owned areas; client-provided areas/fit coefficients are ignored."""
    if draft['unit'] not in UNITS or draft['mode'] not in ('external', 'internal'):
        raise ValueError('Choose an external or internal-standard curve and supported units')
    if not draft['compound'].strip():
        raise ValueError('Compound identity is required')
    points, evidence, seen = [], [], set()
    cas = ''
    is_identity = None
    for index, row in enumerate(draft['rows']):
        if not isinstance(row, dict):
            raise ValueError('Invalid standard row')
        if row.get('excluded'):
            if not str(row.get('reason') or '').strip():
                raise ValueError(f'Row {index + 1}: record an exclusion reason')
            continue
        file = files.get(row.get('dataset_id'))
        if not file:
            raise ValueError(f'Row {index + 1}: choose a GC-MS run in this project')
        if file['id'] in seen:
            raise ValueError('Use separate injections for replicate points, not the same run twice')
        seen.add(file['id'])
        peak = next((p for p in file['peaks'] if p['peak_id'] == row.get('peak_id')), None)
        if not peak:
            raise ValueError(f"{file['filename']}: select and review a compound peak, or exclude this injection with a reason")
        if peak['name'].casefold() != draft['compound'].strip().casefold():
            raise ValueError(f"{file['filename']}: selected peak must match the compound name")
        if peak.get('cas'):
            if cas and cas != peak['cas']:
                raise ValueError('Selected compound identities disagree')
            cas = peak['cas']
        for key in PROFILE_FIELDS:
            observed = file.get('profile', {}).get(key)
            expected = draft['profile'].get(key)
            if key in NUMERIC_PROFILE and observed and expected:
                observed, expected = str(float(observed)), str(float(expected))
            if observed and expected and str(observed).casefold() != str(expected).casefold():
                raise ValueError(f"{file['filename']}: {key} differs from the acquisition profile")
        concentration = number(row.get('concentration'), 'Concentration', zero=True)
        if row.get('quantity_confirmed') is False:
            raise ValueError(f"{file['filename']}: confirm the filename concentration before fitting")
        area = number(peak['area'], 'Measured peak area')
        validate_preparation(peak, draft['profile'])
        if peak['review_needed']:
            raise ValueError(f"{file['filename']}: verify the automatic integration in Atmos first")
        x, y = concentration, area
        source = {'dataset_id': file['id'], 'filename': file['filename'], 'analyte': peak,
                  'acquisition': file.get('profile', {}), 'metadata_source': file.get('metadata_source')}
        if draft['mode'] == 'internal':
            internal = next((p for p in file['peaks'] if p['peak_id'] == row.get('is_peak_id')), None)
            if (not internal or internal['peak_id'] == peak['peak_id'] or not internal['name']
                    or internal['name'].casefold() == peak['name'].casefold()):
                raise ValueError(f"{file['filename']}: choose a different identified internal-standard peak")
            if internal['review_needed']:
                raise ValueError(f"{file['filename']}: verify the internal-standard integration first")
            identity = (internal['name'].casefold(), internal['cas'])
            if is_identity is not None and identity != is_identity:
                raise ValueError('All injections must use the same internal-standard identity')
            is_identity = identity
            internal_area = number(internal['area'], 'Internal-standard area')
            validate_preparation(internal, draft['profile'])
            internal_concentration = number(row.get('is_concentration'), 'Internal-standard concentration')
            x, y = concentration / internal_concentration, area / internal_area
            source['internal_standard'] = internal
            source['is_concentration'] = internal_concentration
        points.append({'concentration': x, 'area': y, 'nominal': concentration,
                       'dataset_id': file['id'], 'filename': file['filename']})
        evidence.append(source)
    fit = fit_points(points, draft['force_zero'], auto_zero=not draft.get('force_zero_manual', False))
    for point in fit['points']:
        predicted = fit['slope'] * point['concentration'] + fit['intercept']
        recovered = (point['area'] - fit['intercept']) / fit['slope']
        point['residual'] = point['area'] - predicted
        point['back_calculated'] = recovered
        point['bias_percent'] = (100 * (recovered / point['concentration'] - 1)
                                 if point['concentration'] else None)
    fit['cas'] = cas
    fit['internal_standard'] = ({'name': is_identity[0], 'cas': is_identity[1]} if is_identity else None)
    fit['evidence'] = evidence
    # Reject overflow before anything is persisted or returned as JSON.
    digest(fit)
    return fit


def quantify_version(version, payload):
    if payload.get('concentration_unit') != version['unit']:
        raise ValueError('Specify the calibration concentration unit explicitly')
    profile = clean_profile(payload.get('profile'), required=True)
    mismatches = [key for key in PROFILE_FIELDS if profile[key].casefold() != version['profile'].get(key, '').casefold()]
    if mismatches:
        raise ValueError('Incompatible acquisition: ' + ', '.join(mismatches))
    area = number(payload.get('area'), 'Sample peak area')
    dilution = number(payload.get('dilution', 1), 'Dilution')
    response = area
    internal_concentration = 1
    inputs = {'area': area, 'dilution': dilution}
    if version['mode'] == 'internal':
        identity = version['fit']['internal_standard']
        if str(payload.get('is_name') or '').strip().casefold() != identity['name']:
            raise ValueError('Internal-standard identity does not match the curve')
        if identity['cas'] and re.sub(r'\D', '', str(payload.get('is_cas') or '')) != identity['cas']:
            raise ValueError('Internal-standard CAS does not match the curve')
        internal_area = number(payload.get('is_area'), 'Internal-standard area')
        internal_concentration = number(payload.get('is_concentration'), 'Internal-standard concentration')
        response /= internal_area
        inputs.update(is_area=internal_area, is_concentration=internal_concentration,
                      is_name=identity['name'], is_cas=identity['cas'])
    fit = version['fit']
    estimated = (response - fit['intercept']) / fit['slope']
    measured = estimated * internal_concentration
    result = measured * dilution
    if not all(math.isfinite(v) for v in (response, estimated, measured, result)):
        raise ValueError('Concentration calculation exceeds the supported numeric range')
    warnings = []
    if estimated < fit['min']:
        warnings.append('Below calibration range')
    if estimated > fit['max']:
        warnings.append('Above calibration range')
    if result < 0:
        warnings.append('Negative estimate')
    return {'value': result, 'measured': measured, 'unit': version['unit'], 'warnings': warnings,
            'basis': 'solution concentration', 'version': version['version'], 'inputs': inputs}


class CalibrationStore:
    def __init__(self, path):
        self.path = path

    @contextmanager
    def connection(self):
        path = Path(self.path())
        path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('CREATE TABLE IF NOT EXISTS calibration_drafts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS calibration_versions (id TEXT NOT NULL REFERENCES calibration_drafts(id), version TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id, version))')
            db.execute('CREATE TABLE IF NOT EXISTS calibration_preparations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, dataset_id TEXT NOT NULL, body TEXT NOT NULL)')
            with db:
                yield db
        finally:
            db.close()

    def get(self, id):
        with self.connection() as db:
            row = db.execute('SELECT body FROM calibration_drafts WHERE id=?', (id,)).fetchone()
            if not row:
                raise HTTPException(404, 'Calibration not found')
            draft = json.loads(row['body'])
            versions = [json.loads(v['body']) for v in db.execute('SELECT body FROM calibration_versions WHERE id=? ORDER BY rowid DESC', (id,))]
            return {**draft, 'versions': versions}

    def save(self, draft, expected=None, publication=None):
        with self.connection() as db:
            if expected is None:
                db.execute('INSERT INTO calibration_drafts VALUES (?, ?, ?, ?)',
                           (draft['id'], draft['project_id'], draft['revision'], json.dumps(draft, allow_nan=False)))
            else:
                changed = db.execute('UPDATE calibration_drafts SET revision=?, body=? WHERE id=? AND revision=?',
                                     (draft['revision'], json.dumps(draft, allow_nan=False), draft['id'], expected))
                if changed.rowcount != 1:
                    raise HTTPException(409, 'Calibration changed. Reload before saving.')
            if publication:
                db.execute('INSERT INTO calibration_versions VALUES (?, ?, ?)',
                           (draft['id'], publication['version'], json.dumps(publication, allow_nan=False)))

    def delete_draft(self, id, expected):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT revision FROM calibration_drafts WHERE id=?', (id,)).fetchone()
            if not row:
                raise HTTPException(404, 'Calibration not found')
            if db.execute('SELECT 1 FROM calibration_versions WHERE id=?', (id,)).fetchone():
                raise HTTPException(409, 'Published calibrations cannot be deleted')
            if row['revision'] != expected:
                raise HTTPException(409, 'Draft changed. Refresh before deleting.')
            db.execute('DELETE FROM calibration_drafts WHERE id=?', (id,))

    def all(self):
        with self.connection() as db:
            return [json.loads(row['body']) for row in db.execute('SELECT body FROM calibration_drafts ORDER BY rowid DESC')]

    def preparation(self, id):
        with self.connection() as db:
            row = db.execute('SELECT body FROM calibration_preparations WHERE id=?', (id,)).fetchone()
            if not row:
                raise HTTPException(404, 'Prepared run not found')
            return json.loads(row['body'])

    def save_preparation(self, record):
        with self.connection() as db:
            db.execute('INSERT OR IGNORE INTO calibration_preparations VALUES (?, ?, ?, ?)',
                       (record['preparation_id'], record['project_id'], record['id'], json.dumps(record, allow_nan=False)))


def register_calibration_library(app, *, current_user, authorize, metadata, annotations, path, method_metadata=None, literal_search=False, on_publish=None):
    store = CalibrationStore(path)
    column_record = register_columns(app, current_user=current_user, authorize=authorize, path=path)

    def access(id, user, required='viewer'):
        try:
            entry = store.get(id)
        except HTTPException as error:
            if error.status_code != 404 or not literal_search:
                raise
            primary = next((item for item in store.all() if id in (item.get('discovery') or {}).get('merged_from', [])), None)
            if not primary:
                raise
            entry = store.get(primary['id'])
        _, role = authorize(entry['project_id'], user, required)
        return entry, role

    def files(project_id, user):
        project, _ = authorize(project_id, user, 'viewer')
        result = []
        for dataset in metadata(project, user=user).get('datasets', []):
            if dataset.get('instrument_type') != 'GCMS':
                continue
            acquired = method_metadata(dataset['id'], user) if method_metadata else {'profile': {}}
            profile = {'instrument': dataset.get('instrument_name') or '', 'method': dataset.get('method') or '', **acquired.get('profile', {})}
            result.append({'id': dataset['id'], 'filename': dataset.get('source_name') or dataset.get('name') or dataset['id'],
                           'source_folder': dataset.get('source_folder', ''),
                           'source_path': dataset.get('source_path', ''),
                           'profile': profile, 'metadata_source': acquired.get('source', 'dataset metadata'),
                           'acquired_at': acquired.get('acquired_at', ''), 'time_source': acquired.get('time_source', 'unavailable'),
                           **({'source_error': acquired.get('source_error', '')} if literal_search else {}),
                           'peaks': [measurement(p) for p in annotations(user, dataset['id'])]})
        return result

    def prepared(payload, original, user):
        draft = {key: original[key] for key in ('id', 'project_id', 'created_at', 'created_by', 'revision', 'parent')}
        draft['author'] = original.get('author') or original.get('created_by') or 'Unknown'
        for key in ('name', 'compound', 'unit', 'mode'):
            value = payload.get(key, original.get(key, ''))
            if not isinstance(value, str) or len(value) > 240:
                raise ValueError(f'Invalid {key}')
            draft[key] = value.strip()
        if not draft['name']:
            raise ValueError('Calibration name is required')
        draft['profile'] = clean_profile(payload.get('profile', original.get('profile', {})))
        column_id = payload.get('column_id', original.get('column_id'))
        if column_id:
            if not isinstance(column_id, str):
                raise ValueError('Invalid column reference')
            column = column_record(column_id, user)
            if not column['active']:
                raise ValueError('Choose an active column')
            if any(draft['profile'][key].casefold() != column[key].casefold() for key in COLUMN_FIELDS):
                raise ValueError('Acquisition column fields differ from the selected inventory column')
            draft['column_id'] = column_id
            draft['column_snapshot'] = column
        draft['force_zero'] = payload.get('force_zero', False) is True
        draft['force_zero_manual'] = payload.get('force_zero_manual', False) is True
        rows = payload.get('rows', original.get('rows', []))
        if not isinstance(rows, list) or len(rows) > 500 or any(not isinstance(row, dict) for row in rows):
            raise ValueError('Choose up to 500 standard injections')
        keys = ('dataset_id', 'peak_id', 'concentration', 'is_peak_id', 'is_concentration', 'excluded', 'reason', 'quantity_confirmed')
        draft['rows'] = [{key: row.get(key) for key in keys} for row in rows]
        for row in draft['rows']:
            if row['excluded'] not in (True, False, None):
                raise ValueError('Excluded must be true or false')
            if row.get('quantity_confirmed') not in (True, False, None):
                raise ValueError('Quantity confirmation must be true or false')
            if any(isinstance(value, (list, dict)) or len(str(value)) > 1024 for value in row.values()):
                raise ValueError('Invalid standard row value')
        discovery = payload.get('discovery', original.get('discovery'))
        if discovery is not None:
            if not isinstance(discovery, dict) or len(json.dumps(discovery, allow_nan=False)) > 500000:
                raise ValueError('Invalid discovery evidence')
            draft['discovery'] = discovery
        if original.get('import_key'):
            draft['import_key'] = original['import_key']
        draft.update(updated_at=stamp(), updated_by=user['id'], revision=original['revision'] + 1)
        try:
            draft['fit'] = build_fit(draft, {f['id']: f for f in files(draft['project_id'], user)})
            draft['fit_error'] = ''
        except (ValueError, OverflowError) as error:
            draft['fit'], draft['fit_error'] = None, str(error)
        return draft

    @app.get('/api/calibration-library')
    def browse(q: str = Query('', max_length=240), user: dict = Depends(current_user)):
        entries = []
        query = q.strip().casefold()
        project_files = {}
        for draft in store.all():
            try:
                project, role = authorize(draft['project_id'], user, 'viewer')
            except HTTPException as error:
                if error.status_code in (403, 404):
                    continue
                raise
            discovery = draft.get('discovery') or {}
            source_files = []
            if literal_search:
                if draft['project_id'] not in project_files:
                    project_files[draft['project_id']] = {
                        item['id']: {'id': item['id'], 'filename': item.get('source_name') or item.get('name') or item['id'],
                                     'source_folder': item.get('source_folder', ''), 'source_path': item.get('source_path', '')}
                        for item in metadata(project, user=user).get('datasets', [])}
                names = project_files[draft['project_id']]
                linked = {item['id']: {'id': item['id'], 'filename': item.get('filename') or names.get(item['id'], {}).get('filename', item['id']),
                                       'source_folder': names.get(item['id'], {}).get('source_folder', ''),
                                       'source_path': names.get(item['id'], {}).get('source_path', '')}
                          for item in discovery.get('files', [])}
                for row in draft.get('rows', []):
                    id = row.get('dataset_id')
                    if id and id not in linked:
                        linked[id] = names.get(id, {'id': id, 'filename': row.get('filename') or id})
                source_files = list(linked.values())
            haystack = ' '.join([draft['name'], draft['compound'], (draft.get('fit') or {}).get('cas', ''), *draft['profile'].values(),
                                 *([discovery.get('series') or '', *[file['filename'] for file in source_files]] if literal_search else [])]).casefold()
            score = SequenceMatcher(None, q.casefold(), draft['compound'].casefold()).ratio() if q else 1
            if query and query not in haystack and (literal_search or score < .55):
                continue
            if literal_search:
                compound = draft['compound'].strip().casefold()
                score = 3 if compound == query else 2 if compound.startswith(query) else 1 if query in compound else 0
            detail = store.get(draft['id'])
            candidate = (detail.get('discovery') or {}).get('candidate') or {}
            nist_match_name = candidate.get('name') or candidate.get('common_name') or ''
            entries.append({key: detail[key] for key in ('id', 'project_id', 'name', 'compound', 'unit', 'mode', 'profile', 'revision', 'updated_at')} |
                           {'author': detail.get('author') or detail.get('created_by') or 'Unknown', 'editable': role in ('owner', 'editor'), 'published_count': len(detail['versions']),
                            'latest_version': detail['versions'][0]['version'] if detail['versions'] else None,
                            'nist_match_name': nist_match_name,
                            'series': (detail.get('discovery') or {}).get('series'),
                            'sequence': (detail.get('discovery') or {}).get('sequence'),
                            'qualification': (detail.get('discovery') or {}).get('qualification'),
                            **({'source_files': source_files} if literal_search else {}),
                            'score': score})
        return {'entries': sorted(entries, key=lambda item: (-item['score'], item['name'].casefold()))}

    @app.get('/api/calibration-library/sources/{project_id}')
    def sources(project_id: str, user: dict = Depends(current_user)):
        return {'files': files(project_id, user)}

    @app.get('/api/calibration-library/sources/{project_id}/{dataset_id}/method')
    def source_method(project_id: str, dataset_id: str, user: dict = Depends(current_user)):
        available = files(project_id, user)
        if not any(f['id'] == dataset_id for f in available):
            raise HTTPException(404, 'GC-MS run not in this project')
        return method_metadata(dataset_id, user) if method_metadata else {'profile': {}, 'source': 'unavailable'}

    @app.post('/api/calibration-library')
    def create(payload: dict = Body(...), user: dict = Depends(current_user)):
        project_id = payload.get('project_id')
        if not isinstance(project_id, str):
            raise HTTPException(400, 'Choose a source project')
        authorize(project_id, user, 'editor')
        import_key = payload.get('import_key')
        if import_key is not None and (not isinstance(import_key, str) or not import_key or len(import_key) > 4000):
            raise HTTPException(400, 'Invalid import key')
        id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'calibration:{project_id}:{import_key}')) if import_key else str(uuid.uuid4())
        if import_key:
            try:
                return {**store.get(id), 'editable': True, 'created': False}
            except HTTPException as error:
                if error.status_code != 404:
                    raise
            if literal_search:
                merged = next((item for item in store.all() if item['project_id'] == project_id and
                               import_key in (item.get('discovery') or {}).get('merged_import_keys', [])), None)
                if merged:
                    return {**store.get(merged['id']), 'editable': True, 'created': False}
        original = {'id': id, 'project_id': project_id, 'revision': 0,
                    'created_at': stamp(), 'created_by': user['id'], 'author': user.get('name') or user['id'], 'parent': None}
        if import_key:
            original['import_key'] = import_key
        try:
            draft = prepared(payload, original, user)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        try:
            store.save(draft)
        except sqlite3.IntegrityError:
            if not import_key:
                raise
            return {**store.get(id), 'editable': True, 'created': False}
        return {**draft, 'versions': [], 'editable': True, 'created': True}

    @app.post('/api/calibration-library/preparations/{project_id}')
    def prepare_snapshot(project_id: str, payload: dict = Body(...), user: dict = Depends(current_user)):
        project, _ = authorize(project_id, user, 'editor')
        dataset_id = payload.get('id')
        available = metadata(project, user=user).get('datasets', [])
        if not any(item['id'] == dataset_id and item.get('instrument_type') == 'GCMS' for item in available):
            raise HTTPException(404, 'GC-MS run not in this project')
        try:
            if not isinstance(payload.get('peaks'), list) or len(payload['peaks']) > 2000:
                raise ValueError('Invalid candidate list')
            if any(not isinstance(p, dict) for p in payload['peaks']):
                raise ValueError('Invalid candidate')
            if len(json.dumps(payload, allow_nan=False)) > 16000000:
                raise ValueError('Prepared run is too large')
            number(payload.get('area_multiplier'), 'Area multiplier')
            key = digest({'project_id': project_id, 'payload': payload})
        except (ValueError, TypeError) as error:
            raise HTTPException(400, str(error)) from error
        record = {**payload, 'preparation_id': key, 'project_id': project_id,
                  'prepared_at': stamp(), 'prepared_by': user['id'], 'review_state': 'pending'}
        store.save_preparation(record)
        return {'preparation_id': key}

    @app.get('/api/calibration-library/preparations/{project_id}/{preparation_id}')
    def read_preparation(project_id: str, preparation_id: str, user: dict = Depends(current_user)):
        project, _ = authorize(project_id, user, 'viewer')
        record = store.preparation(preparation_id)
        if record['project_id'] != project_id or not any(
                d['id'] == record['id'] and d.get('instrument_type') == 'GCMS'
                for d in metadata(project, user=user).get('datasets', [])):
            raise HTTPException(404, 'Prepared run not in this project')
        return record

    @app.get('/api/calibration-library/{id}')
    def get(id: str, user: dict = Depends(current_user)):
        entry, role = access(id, user)
        return {**entry, 'editable': role in ('owner', 'editor')}

    @app.delete('/api/calibration-library/{id}')
    def delete_draft(id: str, revision: int = Query(...), user: dict = Depends(current_user)):
        entry, _ = access(id, user, 'editor')
        if entry['id'] != id:
            raise HTTPException(409, 'Draft was merged. Refresh before deleting.')
        store.delete_draft(id, revision)
        return {'deleted': id}

    @app.put('/api/calibration-library/{id}')
    def save(id: str, payload: dict = Body(...), user: dict = Depends(current_user)):
        original, _ = access(id, user, 'editor')
        if payload.get('revision') != original['revision']:
            raise HTTPException(409, 'Calibration changed. Reload before saving.')
        try:
            draft = prepared(payload, original, user)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        store.save(draft, original['revision'])
        return {**store.get(id), 'editable': True}

    @app.post('/api/calibration-library/{id}/publish')
    def publish(id: str, background_tasks: BackgroundTasks, payload: dict = Body(...), user: dict = Depends(current_user)):
        draft, _ = access(id, user, 'editor')
        if payload.get('revision') != draft['revision']:
            raise HTTPException(409, 'Calibration changed. Reload before publishing.')
        if payload.get('confirmed') is not True:
            raise HTTPException(400, 'Confirm acquisition details, concentrations and integration review')
        try:
            profile = clean_profile(draft['profile'], required=True)
            if draft.get('column_id'):
                latest = column_record(draft['column_id'], user)
                if not latest['active'] or latest['revision'] != draft['column_snapshot']['revision']:
                    raise HTTPException(409, 'Column inventory changed. Save and review the draft before publishing.')
            fit = build_fit(draft, {f['id']: f for f in files(draft['project_id'], user)})
            if digest(fit) != digest(draft['fit']):
                raise HTTPException(409, 'Source integrations changed. Save and review the new fit before publishing.')
        except (ValueError, OverflowError) as error:
            raise HTTPException(400, str(error)) from error
        versions = draft.pop('versions')
        version = {**copy.deepcopy(draft), 'profile': profile, 'published_at': stamp(), 'published_by': user['id']}
        version['version'] = digest(version)[:24]
        draft['revision'] += 1
        store.save(draft, payload['revision'], version)
        if on_publish:
            background_tasks.add_task(on_publish, copy.deepcopy(version))
        return {**draft, 'versions': [version, *versions], 'editable': True}

    @app.post('/api/calibration-library/{id}/variants')
    def variant(id: str, payload: dict = Body(...), user: dict = Depends(current_user)):
        original, _ = access(id, user, 'editor')
        parent = next((v for v in original['versions'] if v['version'] == payload.get('version')), None)
        if not parent:
            raise HTTPException(404, 'Choose a published parent version')
        draft = {k: copy.deepcopy(v) for k, v in parent.items() if k not in ('version', 'published_at', 'published_by')}
        draft['author'] = user.get('name') or user['id']
        draft.update(id=str(uuid.uuid4()), revision=1, name=(parent['name'][:225] + ' - variant'),
                     created_at=stamp(), created_by=user['id'], updated_at=stamp(), updated_by=user['id'],
                     parent={'id': id, 'version': parent['version']})
        store.save(draft)
        return {**draft, 'versions': [], 'editable': True}

    @app.post('/api/calibration-library/{id}/versions/{version}/quantify')
    def quantify(id: str, version: str, payload: dict = Body(...), user: dict = Depends(current_user)):
        entry, _ = access(id, user)
        published = next((v for v in entry['versions'] if v['version'] == version), None)
        if not published:
            raise HTTPException(404, 'Published calibration version not found')
        try:
            return quantify_version(published, payload)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
