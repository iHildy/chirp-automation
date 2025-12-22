FROM budtmo/docker-android:emulator_11.0

USER root
WORKDIR /opt/chirp

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates python3-xdg \
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
COPY docker/entrypoint.sh /opt/chirp/entrypoint.sh

RUN chmod +x /opt/chirp/entrypoint.sh \
  && chown -R androidusr:androidusr /opt/chirp

# budtmo/docker-android images expect to run as `androidusr`.
# Running as root can break AVD discovery (HOME/.android paths).
USER androidusr

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080 6080

ENTRYPOINT ["/opt/chirp/entrypoint.sh"]
