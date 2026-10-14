"""Scientific acquisition metadata for calibration grouping, without scans."""
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

from .parsers.chemstation_method import parse_acqmeth_file, plan_to_dict


def acquisition_profile(path):
    method = plan_to_dict(parse_acqmeth_file(path))
    profile = {}
    if method.get('method_path', '').lower().endswith('.m'):
        profile['method'] = re.split(r'[\\/]', method['method_path'])[-1]
    instrument = ' '.join(method[key] for key in ('instrument_model', 'instrument_serial') if method.get(key))
    if instrument:
        profile['instrument'] = instrument
    for target, key in {'column_model': 'column_model', 'column_phase': 'column_phase',
                        'column_length_m': 'column_length_m', 'column_id_um': 'column_id_um',
                        'column_film_um': 'column_film_thickness_um', 'acquisition_mode': 'acq_mode'}.items():
        if method.get(key) not in (None, ''):
            profile[target] = str(method[key])
    profile['column_phase'] = re.sub(r'^Description\s*:\s*', '', profile.get('column_phase', ''), flags=re.I)
    scientific = {key: value for key, value in method.items() if key not in ('method_path', 'source_file')}
    profile['method_signature'] = hashlib.sha256(json.dumps(scientific, sort_keys=True).encode()).hexdigest()
    return profile


def acquisition_timing(folder):
    """Keep instrument wall time as recorded, not the server's timezone/mtime."""
    path = Path(folder) / 'runstart.txt'
    if path.is_file():
        for line in reversed(path.read_text(encoding='utf-8', errors='ignore').splitlines()):
            try:
                timestamp = datetime.strptime(line.strip(), '%a %b %d %H:%M:%S %Y')
                return {'acquired_at': timestamp.isoformat(), 'time_source': 'runstart.txt'}
            except ValueError:
                continue
    return {'acquired_at': '', 'time_source': 'unavailable'}
