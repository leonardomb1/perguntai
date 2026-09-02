# PerguntAI code-execution sandbox image (BETA) — the OCI image every
# microsandbox microVM boots from (MSB_IMAGE). Everything the model may use is
# preinstalled, so runs need no network and no per-run pip installs:
#
#   - Python + the analysis stack (pandas/numpy/statsmodels/scikit-learn)
#   - basalt: columnar SQL over the files piped into /work (CSV/Parquet/JSON)
#
# Build & publish (bump the tag deliberately — MSB_IMAGE pins it):
#   docker build -t ghcr.io/leonardomb1/perguntai-sandbox:v1 deploy/sandbox
#   docker push ghcr.io/leonardomb1/perguntai-sandbox:v1
#
# The app pulls it through the microsandbox SDK on warm-up (server start or
# capability toggle-on), cached under ~/.microsandbox in the msbcache volume.
FROM python:3.13-slim

RUN pip install --no-cache-dir --upgrade pip \
	&& pip install --no-cache-dir --only-binary=:all: pandas numpy statsmodels scikit-learn

# basalt — single static binary, no dependencies. Pinned + checksum-verified.
ARG BASALT_VERSION=v0.6.5
ADD https://github.com/leonardomb1/basalt/releases/download/${BASALT_VERSION}/basalt-x86_64-linux /usr/local/bin/basalt
ADD https://github.com/leonardomb1/basalt/releases/download/${BASALT_VERSION}/basalt-x86_64-linux.sha256 /tmp/basalt.sha256
RUN cd /usr/local/bin \
	&& sed 's|basalt-x86_64-linux|basalt|' /tmp/basalt.sha256 | sha256sum -c - \
	&& chmod +x basalt \
	&& rm /tmp/basalt.sha256

# Dedicated non-root user with a real (disk-backed) home — the app runs
# scripts from /home/perguntai (guest /tmp is a small tmpfs, never use it).
RUN useradd -m -u 1000 -s /bin/bash perguntai
USER perguntai
WORKDIR /home/perguntai
CMD ["sleep", "infinity"]
