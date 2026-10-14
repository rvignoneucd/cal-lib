"""Read-only calibration handoff. Never copies records into a user workspace."""
from fastapi import HTTPException


def inspection_manifest(draft, version, lookup, areas):
    selected = draft
    if version != 'draft':
        selected = next((v for v in draft.get('versions', []) if v['version'] == version), None)
        if selected is None:
            raise HTTPException(404, 'Published version not found')
    files = {}
    # Include the entire current series, plus runs retained only by the chosen version.
    for source in (draft, selected):
        for file in (source.get('discovery') or {}).get('files', []):
            files[file['id']] = file
        for row in source.get('rows', []):
            files.setdefault(row['dataset_id'], {'id': row['dataset_id']})
    rows = {r['dataset_id']: r for r in selected.get('rows', [])}
    runs = []
    for id, file in files.items():
        run = lookup(id)
        row = rows.get(id, {})
        runs.append(dict(id=id, filename=(run or {}).get('filename') or file.get('filename') or id,
            available=run is not None, excluded=bool(row.get('excluded')), concentration=row.get('concentration'),
            area=row.get('area'), peak_id=row.get('peak_id'),
            measurement=next((a['measurement'] for a in areas if a['dataset_id'] == id), None) if version == 'draft' else None))
    return dict(id=draft['id'], compound=selected.get('compound'), name=selected['name'], version=version,
        rt=(selected.get('discovery') or {}).get('target_rt'), runs=runs, read_only=True)
