"""Project-authorized lab column inventory used by calibration drafts."""
import json
import math
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, Depends, HTTPException

COLUMN_FIELDS = ('column_model', 'column_phase', 'column_length_m', 'column_id_um', 'column_film_um')


class ColumnStore:
    def __init__(self, path):
        self.path = path

    @contextmanager
    def connection(self):
        path = Path(self.path())
        path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(path, timeout=30)
        try:
            db.execute('CREATE TABLE IF NOT EXISTS calibration_columns (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)')
            with db:
                yield db
        finally:
            db.close()

    def get(self, id):
        with self.connection() as db:
            row = db.execute('SELECT body FROM calibration_columns WHERE id=?', (id,)).fetchone()
        if not row:
            raise HTTPException(404, 'Column not found')
        return json.loads(row[0])

    def all(self):
        with self.connection() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT body FROM calibration_columns ORDER BY rowid DESC')]

    def save(self, record, expected=None):
        with self.connection() as db:
            if expected is None:
                db.execute('INSERT INTO calibration_columns VALUES (?, ?, ?)', (record['id'], record['revision'], json.dumps(record)))
            elif db.execute('UPDATE calibration_columns SET revision=?,body=? WHERE id=? AND revision=?',
                            (record['revision'], json.dumps(record), record['id'], expected)).rowcount != 1:
                raise HTTPException(409, 'Column changed. Reload before saving.')


def register_columns(app, *, current_user, authorize, path):
    store = ColumnStore(path)

    def accessible(id, user):
        record = store.get(id)
        authorize(record['project_id'], user, 'viewer')
        return record

    @app.get('/api/calibration-library/columns')
    def browse(user: dict = Depends(current_user)):
        result = []
        for record in store.all():
            try:
                _, role = authorize(record['project_id'], user, 'viewer')
            except HTTPException as error:
                if error.status_code in (403, 404):
                    continue
                raise
            result.append({**record, 'editable': role in ('owner', 'editor')})
        return {'columns': result}

    @app.post('/api/calibration-library/columns')
    def save(payload: dict = Body(...), user: dict = Depends(current_user)):
        old = accessible(payload['id'], user) if payload.get('id') else None
        project_id = old['project_id'] if old else payload.get('project_id')
        if not isinstance(project_id, str) or not project_id:
            raise HTTPException(400, 'Choose the column inventory project')
        authorize(project_id, user, 'editor')
        if old and payload.get('revision') != old['revision']:
            raise HTTPException(409, 'Column changed. Reload before saving.')
        record = {'id': old['id'] if old else str(uuid.uuid4()), 'project_id': project_id,
                  'revision': old['revision'] + 1 if old else 1,
                  'updated_at': datetime.now(timezone.utc).isoformat(), 'updated_by': user['id']}
        for field in ('name', 'manufacturer', 'serial', 'notes', *COLUMN_FIELDS):
            value = payload.get(field, '')
            if not isinstance(value, str) or len(value) > (2000 if field == 'notes' else 240):
                raise HTTPException(400, f'Invalid {field}')
            record[field] = value.strip()
        if not all(record[field] for field in ('name', *COLUMN_FIELDS)):
            raise HTTPException(400, 'Column name, model, phase and dimensions are required')
        for field in COLUMN_FIELDS[2:]:
            try:
                value = float(record[field])
                if not math.isfinite(value) or value <= 0:
                    raise ValueError()
                record[field] = str(value)
            except ValueError:
                raise HTTPException(400, 'Column dimensions must be positive finite numbers')
        record['active'] = payload.get('active', True) is True
        store.save(record, old['revision'] if old else None)
        return {**record, 'editable': True}

    return accessible
