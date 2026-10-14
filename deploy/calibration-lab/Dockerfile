FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS node
FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libxrender1 libxext6 libexpat1 && rm -rf /var/lib/apt/lists/*
COPY deploy/calibration-lab/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend ./backend
COPY src/calibrations/*.js ./src/calibrations/
COPY src/features/batch/batchEvidence.js ./src/features/batch/batchEvidence.js
COPY scripts/calibration_lab_worker.mjs ./scripts/calibration_lab_worker.mjs
COPY package.json ./package.json
COPY dist-calibration-lab ./web
ENV CAL_STATE=/data/state CAL_SOURCE=/data/source CAL_WEB=/app/web ATMOS_STATE_ROOT=/data/state
USER 1000:1000
CMD ["uvicorn", "backend.calibration_lab:app", "--host", "0.0.0.0", "--port", "8787", "--workers", "1"]
