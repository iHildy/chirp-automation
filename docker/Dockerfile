FROM budtmo/docker-android:emulator_11.0

USER root

# Ensure root user exists in /etc/passwd and /etc/group (fixes "unknown user root" bug in some base images)
RUN grep -q '^root:' /etc/passwd || echo 'root:x:0:0:root:/root:/bin/bash' >> /etc/passwd && \
    grep -q '^root:' /etc/group || echo 'root:x:0:' >> /etc/group
WORKDIR /opt/chirp

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates python3-xdg gosu tini \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY package.json /opt/chirp/package.json
COPY tsconfig.json /opt/chirp/tsconfig.json
COPY src /opt/chirp/src

RUN npm install --no-fund --no-audit \
  && npm run build \
  && npm prune --production

COPY config /opt/chirp/config
# Keep a bundled default config path that won't be shadowed by a volume mount.
COPY config /opt/chirp-default/config
COPY docker/entrypoint.sh /opt/chirp/entrypoint.sh

RUN mkdir -p /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix \
  && chmod +x /opt/chirp/entrypoint.sh \
  && chown -R androidusr:androidusr /opt/chirp /opt/chirp-default

# budtmo/docker-android images expect to run as `androidusr`.
# Entrypoint starts as root to fix /dev/kvm permissions, then drops to androidusr via gosu.
# Do NOT add USER androidusr here - the entrypoint handles privilege drop.

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080 6080

# Container is healthy when the emulator is fully booted.
HEALTHCHECK --interval=10s --timeout=5s --start-period=180s --retries=12 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/readyz" > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/chirp/entrypoint.sh"]
