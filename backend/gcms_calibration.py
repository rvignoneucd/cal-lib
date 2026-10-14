"""Project calibration snapshots built from explicitly selected saved peak areas."""
import copy
import hashlib
import json
import math
import re
from threading import RLock
from datetime import datetime, timezone

from fastapi import Body, Depends, HTTPException
from scipy.stats import linregress
import numpy as np

LOCK = RLock()


def parse_standard(name):
    parts = re.sub(r'\.d$', '', name, flags=re.I).split('_')
    if parts and re.fullmatch(r'\d{6}', parts[0]):
        parts = parts[1:]
    for index, part in enumerate(parts):
        match = re.fullmatch(r'(\d+(?:\.\d+)?)\s*(ug|µg|μg|mg|ng)\s*/?\s*ml', part, re.I)
        if match and index + 1 < len(parts):
            return {'compound': parts[index + 1], 'concentration': float(match[1]),
                    'unit': match[2].lower().replace('µ', 'u').replace('μ', 'u') + '/mL'}
    return {'compound': '', 'concentration': None, 'unit': 'ug/mL'}


def peak_identity(peak):
    name = str(peak.get('compound') or '').strip()
    hit = peak.get('library_match') or (peak.get('reference_library_match') or {}).get('hit') or {}
    aliases = [str(hit.get(k) or '').strip().casefold() for k in ('name', 'common_name')]
    cas = re.sub(r'\D', '', str(hit.get('cas') or '')) if name.casefold() in aliases else ''
    return {'name': name, 'cas': cas}


def fit_points(points, force_zero=False, auto_zero=False):
    valid = [p for p in points if not p.get('excluded') and p.get('area') is not None and p.get('concentration') is not None]
    if len(valid) < 3 or len({p['concentration'] for p in valid}) < 3:
        raise ValueError('Select measured peaks at three or more different concentrations')
    xs = np.asarray([p['concentration'] for p in valid], dtype=float)
    ys = np.asarray([p['area'] for p in valid], dtype=float)
    if auto_zero:
        force_zero = float(linregress(xs, ys).intercept) > 0
    if force_zero:
        slope = float(np.linalg.lstsq(xs[:, None], ys, rcond=None)[0][0])
        intercept = 0.0
        total = float(np.sum((ys - ys.mean()) ** 2))
        r2 = 1 - float(np.sum((ys - slope * xs) ** 2)) / total if total > 0 else float('nan')
    else:
        fit = linregress(xs, ys)
        slope, intercept, r2 = float(fit.slope), float(fit.intercept), float(fit.rvalue ** 2)
    if not all(math.isfinite(v) for v in (slope, intercept, r2)) or slope <= 0:
        raise ValueError('Calibration requires a positive slope')
    return {'slope': slope, 'intercept': intercept, 'r2': r2, 'force_zero': bool(force_zero),
            'min': min(p['concentration'] for p in valid), 'max': max(p['concentration'] for p in valid),
            'n': len(valid), 'points': valid}


def quantify(peaks, config):
    curves = config.get('link', {}).get('curves', [])
    dilution = config.get('link', {}).get('dilution', 1)
    output = {}
    for peak in peaks:
        identity = peak_identity(peak)
        matches = [c for c in curves if (identity['cas'] and c.get('cas') == identity['cas']) or
                   (not identity['cas'] and c.get('name', '').casefold() == identity['name'].casefold())]
        area = peak.get('area_value') if peak.get('area_value') is not None else peak.get('net_area')
        if len(matches) != 1 or isinstance(area, bool) or not isinstance(area, (int, float)) or not math.isfinite(area) or area <= 0:
            continue
        curve = matches[0]
        value = (area - curve['intercept']) / curve['slope']
        if not math.isfinite(value) or not math.isfinite(value * dilution):
            continue
        warning = 'Below calibration range' if value < curve['min'] else 'Above calibration range' if value > curve['max'] else ''
        output[peak.get('annotationId')] = {'value': value * dilution, 'measured': value, 'unit': curve['unit'],
            'warning': warning, 'curve_version': curve['version'], 'source_project': config['link']['project_id'],
            'dilution': dilution, 'r2': curve['r2']}
    return output


def register_gcms_calibration(app, *, current_user, authorize, metadata, annotations, load, save):
    def read(project):
        return load(project['owner_id'], project['id'])

    def write(project, config):
        config = {**config, 'revision': config.get('revision', 0) + 1}
        save(project['owner_id'], project['id'], config)
        return config

    def standards(project, user, dataset_ids=None):
        files = []
        for dataset in metadata(project, user=user).get('datasets', []):
            if dataset.get('instrument_type') != 'GCMS':
                continue
            if dataset_ids is not None and dataset['id'] not in dataset_ids:
                continue
            filename = str(dataset.get('source_name') or dataset.get('name') or '')
            peaks = []
            for p in annotations(user, dataset['id']):
                area = p.get('area_value') if p.get('area_value') is not None else p.get('net_area')
                peaks.append({**peak_identity(p), 'id': p.get('annotationId'), 'rt': p.get('rt_apex'),
                              'area': area if isinstance(area, (int, float)) and math.isfinite(area) and area > 0 else None})
            files.append({'id': dataset['id'], 'filename': filename, **parse_standard(filename), 'peaks': peaks})
        return files

    @app.get('/api/projects/{project_id}/gcms-calibration/enabled')
    def get_enabled(project_id: str, user: dict = Depends(current_user)):
        project, role = authorize(project_id, user, 'viewer')
        return {'enabled': read(project).get('enabled') is True, 'editable': role in ('owner', 'editor')}

    @app.post('/api/projects/{project_id}/gcms-calibration/enabled')
    def set_enabled(project_id: str, payload: dict = Body(...), user: dict = Depends(current_user)):
        project, _ = authorize(project_id, user, 'editor')
        if type(payload.get('enabled')) is not bool:
            raise HTTPException(400, 'Enabled must be true or false')
        with LOCK:
            config = read(project)
            if (config.get('enabled') is True) != payload['enabled']:
                write(project, {**config, 'enabled': payload['enabled']})
        return {'enabled': payload['enabled'], 'editable': True}

    @app.get('/api/projects/{project_id}/gcms-calibration')
    def get(project_id: str, user: dict = Depends(current_user)):
        project, role = authorize(project_id, user, 'viewer')
        config = read(project)
        if config.get('link', {}).get('project_id'):
            authorize(config['link']['project_id'], user, 'viewer')
        return {'config': config, 'files': standards(project, user), 'editable': role in ('owner', 'editor')}

    @app.get('/api/projects/{project_id}/gcms-calibration/summary')
    def summary(project_id: str, user: dict = Depends(current_user)):
        project, _ = authorize(project_id, user, 'viewer')
        config = read(project)
        if project.get('project_type') == 'gcms_calibration':
            return {'curves': config.get('curves', []), 'source': project['name']}
        linked = config.get('link') or {}
        if linked.get('project_id'):
            authorize(linked['project_id'], user, 'viewer')
        return {'curves': linked.get('curves', []), 'source': linked.get('name', '')}

    @app.post('/api/projects/{project_id}/gcms-calibration/curves')
    def build(project_id: str, payload: dict = Body(...), user: dict = Depends(current_user)):
        project, _ = authorize(project_id, user, 'editor')
        if project.get('project_type') != 'gcms_calibration':
            raise HTTPException(400, 'Choose GC-MS Calibration as the project type first')
        rows = payload.get('rows')
        if not isinstance(payload.get('force_zero') or {}, dict):
            raise HTTPException(400, 'Invalid fit options')
        if not isinstance(rows, list) or len(rows) > 1000 or not rows:
            raise HTTPException(400, 'Choose calibration standards')
        scope = payload.get('series_ids')
        if scope is not None:
            if (not isinstance(scope, list) or not scope or
                    any(not isinstance(id, str) for id in scope) or len(set(scope)) != len(scope) or
                    any(not isinstance(row, dict) or not isinstance(row.get('id'), str) for row in rows) or
                    set(scope) != {row.get('id') for row in rows}):
                raise HTTPException(400, 'Series files must match the selected standards')
        files = {f['id']: f for f in standards(project, user, set(scope) if scope is not None else None)}
        groups = {}
        seen = set()
        try:
            for row in rows:
                if row['id'] in seen:
                    raise ValueError('A standard file cannot be included twice')
                seen.add(row['id'])
                file = files[row['id']]
                if row.get('excluded'):
                    continue
                name = str(row.get('compound') or '').strip()[:120]
                unit = row.get('unit')
                if not name or unit not in ('ug/mL', 'mg/mL', 'ng/mL'):
                    raise ValueError('Every standard needs a compound and concentration unit')
                concentration = float(row['concentration'])
                if not math.isfinite(concentration) or concentration < 0:
                    raise ValueError('Concentration must be a nonnegative number')
                peak = next((p for p in file['peaks'] if p['id'] == row.get('peakId')), None)
                if not row.get('excluded') and (not peak or peak['area'] is None):
                    raise ValueError(f"{file['filename']}: choose a measured peak")
                key = name.casefold()
                group = groups.setdefault(key, {'name': name, 'unit': unit, 'points': [], 'identities': []})
                if group['unit'] != unit:
                    raise ValueError(f'{name}: concentration units must match')
                if peak and not row.get('excluded'):
                    group['identities'].append({'name': peak['name'], 'cas': peak['cas']})
                group['points'].append({**row, 'filename': file['filename'], 'concentration': concentration,
                                        'area': peak['area'] if peak else None})
            curves = []
            if not groups:
                raise ValueError('Include at least one compound calibration set')
            for key, group in groups.items():
                identities = group.pop('identities')
                names = {p['name'].casefold() for p in identities}
                cases = {p['cas'] for p in identities if p['cas']}
                if len(names) != 1 or len(cases) > 1:
                    raise ValueError(f"{group['name']}: selected peaks must identify the same compound")
                force_zero = (payload.get('force_zero') or {}).get(key) is True
                try:
                    fit = fit_points(group['points'], force_zero)
                except ValueError as error:
                    raise ValueError(f"{group['name']}: {error}") from error
                curve = {**group, **fit, 'label': group['name'],
                         'name': identities[0]['name'], 'cas': next(iter(cases), ''), 'id': key}
                curve['version'] = hashlib.sha256(json.dumps(curve, sort_keys=True).encode()).hexdigest()[:16]
                curves.append(curve)
        except (ValueError, TypeError, KeyError) as error:
            raise HTTPException(400, str(error)) from error
        with LOCK:
            config = read(project)
            if payload.get('revision') != config.get('revision', 0):
                raise HTTPException(409, 'Calibration changed. Reload before saving.')
            if scope is not None:
                # A sidebar save replaces only these compounds, never other saved calibrations.
                replaced = {curve['id'] for curve in curves}
                old_curves = config.get('curves', [])
                removed_ids = set(scope) | {point['id'] for curve in old_curves
                    if curve['id'] in replaced for point in curve.get('points', [])}
                if any(point['id'] in scope for curve in old_curves if curve['id'] not in replaced
                       for point in curve.get('points', [])):
                    raise HTTPException(400, 'A series file belongs to another saved curve. Review it in Calibration curves.')
                curves = [curve for curve in old_curves if curve['id'] not in replaced] + curves
                rows = [row for row in config.get('rows', []) if row['id'] not in removed_ids
                        and str(row.get('compound') or '').strip().casefold() not in replaced] + rows
            return write(project, {**config, 'curves': curves, 'rows': rows, 'saved_at': datetime.now(timezone.utc).isoformat()})

    @app.post('/api/projects/{project_id}/gcms-calibration/refresh')
    def refresh(project_id: str, payload: dict = Body(...), user: dict = Depends(current_user)):
        project, _ = authorize(project_id, user, 'editor')
        if project.get('project_type') != 'gcms_calibration':
            return {'updated': False}
        dataset_id = payload.get('dataset_id')
        with LOCK:
            config = read(project)
            row = next((row for row in config.get('rows', []) if row['id'] == dataset_id), None)
            if not row or row.get('excluded'):
                return {'updated': False}
            key = str(row.get('compound') or '').strip().casefold()
            curve = next((curve for curve in config.get('curves', []) if curve['id'] == key), None)
            if not curve:
                return {'updated': False}
            file = next(iter(standards(project, user, {dataset_id})), None)
            peak = next((peak for peak in (file or {}).get('peaks', []) if peak['id'] == row.get('peakId')), None)
            old_point = next((point for point in curve.get('points', []) if point['id'] == dataset_id), None)
            if (peak and old_point and peak['area'] == old_point.get('area')
                    and peak['name'] == curve['name'] and peak['cas'] == curve.get('cas', '')):
                return {'updated': False}
            rows = [row for row in config.get('rows', [])
                    if str(row.get('compound') or '').strip().casefold() == key]
            # Read the latest selection under the same lock as saving. Never add runs
            # or overwrite a concurrently edited exclusion / fit-through-zero option.
            updated = build(project_id, {'rows': rows, 'series_ids':[row['id'] for row in rows],
                'force_zero':{key:curve.get('force_zero', False)}, 'revision':config.get('revision', 0)}, user)
            return {'updated': True, 'curve_id':key, 'revision':updated['revision']}

    @app.post('/api/projects/{project_id}/gcms-calibration/link')
    def link(project_id: str, payload: dict = Body(...), user: dict = Depends(current_user)):
        project, _ = authorize(project_id, user, 'editor')
        source_id = payload.get('source_id')
        linked = None
        if source_id:
            source, _ = authorize(source_id, user, 'viewer')
            source_config = read(source)
            if source.get('project_type') != 'gcms_calibration' or not source_config.get('curves'):
                raise HTTPException(400, 'Choose a calibration project with saved curves')
            if not payload.get('confirmed'):
                raise HTTPException(400, 'Confirm compatible acquisition, response and integration settings')
            try:
                dilution = float(payload.get('dilution', 1))
                if not math.isfinite(dilution) or dilution <= 0:
                    raise ValueError()
            except (ValueError, TypeError):
                raise HTTPException(400, 'Dilution multiplier must be positive')
            linked = {'project_id': source_id, 'name': source['name'], 'curves': copy.deepcopy(source_config['curves']),
                      'dilution': dilution, 'saved_at': source_config.get('saved_at')}
        with LOCK:
            config = read(project)
            if payload.get('revision') != config.get('revision', 0):
                raise HTTPException(409, 'Calibration changed. Reload before saving.')
            return write(project, {**config, 'link': linked or {}})

    @app.get('/api/projects/{project_id}/gcms-calibration/concentrations/{dataset_id}')
    def concentrations(project_id: str, dataset_id: str, user: dict = Depends(current_user)):
        project, _ = authorize(project_id, user, 'viewer')
        config = read(project)
        if config.get('enabled') is not True or not config.get('link'):
            return {'results': {}}
        authorize(config['link']['project_id'], user, 'viewer')
        files = {f['id'] for f in metadata(project, user=user).get('datasets', []) if f.get('instrument_type') == 'GCMS'}
        if dataset_id not in files:
            raise HTTPException(404, 'File not in this project')
        return {'results': quantify(annotations(user, dataset_id), config), 'link': config['link']['name']}
