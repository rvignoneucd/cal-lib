# Atmos Calibration Library

Standalone source snapshot of the Atmos lab calibration tool. Includes calibration drafts and immutable published versions, manual peak integration, curve previews, workbook import/export, PubChem structures, and optional NIST bridge integration.

## Run locally

Requires Node.js 22.12+ (Node 24 recommended), npm, Docker and Docker Compose.

```sh
npm ci
npm run build
docker compose -f deploy/calibration-lab/compose.yaml up --build -d
```

Open http://localhost:8787. Health check: http://localhost:8787/api/health.

The service stores application state under `data/state` and reads source runs from `data/source`. Create those directories and make `data/state` writable by container UID 1000 before starting on Linux. Supply your own complete acquisition folders. No lab data, databases, user identities, credentials, NIST software, or licensed spectral libraries are included.

## Security

This adapter is for a trusted, private lab environment, not an internet-facing service. It trusts identity headers from a private proxy and has a local fallback identity; it does not implement public authentication. Keep the default loopback-only binding. Do not expose it publicly without adding authentication, authorization, and a trusted proxy that strips client-supplied identity headers.

## Optional NIST search

NIST is an identification aid; analyst assignments and reviewed areas remain authoritative. To connect your separately licensed search service, set `ATMOS_MSPEPSEARCH_URL` and `ATMOS_MSPEPSEARCH_TOKEN` in your shell before starting Compose. Never commit the token. Without a configured bridge, NIST-dependent searches are unavailable.

## Tests

With Python 3.13 and the dependencies installed:

```sh
pip install -r deploy/calibration-lab/requirements.txt pytest httpx
python -m pytest tests -q
```

The included tests exercise calibration storage, validation, and publication. This repository is an initial source snapshot, not the full Atmos application or its Git history.
