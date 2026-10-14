"""Atomically receive a read-only source snapshot uploaded by the lab PC."""
import hashlib
import json
import re
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


def receive(base, token):
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ValueError('Invalid snapshot token')
    source = base / 'data/source'
    staging = base / 'data/staging'
    manifest = json.loads((staging / f'{token}.json').read_text(encoding='utf-8-sig'))
    archive = staging / f'{token}.tar'
    with archive.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != manifest['archive_sha256'].lower():
            raise ValueError('Source archive checksum differs')
    if manifest['fingerprint'] != token or manifest['folder'] != f'snapshots/{token}/Cal Test':
        raise ValueError('Invalid source manifest')
    snapshots = source / 'snapshots'
    snapshots.mkdir(parents=True, exist_ok=True)
    target = snapshots / token
    if not target.exists():
        with tempfile.TemporaryDirectory(dir=snapshots) as temporary:
            with tarfile.open(archive) as tar:
                for member in tar.getmembers():
                    path = PurePosixPath(member.name)
                    if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'Cal Test':
                        raise ValueError('Invalid archive path')
                    if not (member.isfile() or member.isdir()):
                        raise ValueError('Links and devices are not allowed')
                tar.extractall(temporary, filter='data')
            Path(temporary).rename(target)
    # Only switch the active manifest after extraction and checksum verification.
    active = source / 'active.json.tmp'
    active.write_text(json.dumps(manifest), encoding='utf-8')
    active.replace(source / 'active.json')
    archive.unlink()
    (staging / f'{token}.json').unlink()
    print(json.dumps({'received': token, 'folder': manifest['folder']}))


if __name__ == '__main__':
    receive(Path(__file__).resolve().parents[1], sys.argv[1])
