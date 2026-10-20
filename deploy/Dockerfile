# Build from the repo root: docker build -f deploy/Dockerfile -t agentrelay .
FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY server/ ./server/
COPY portal/ ./portal/
RUN mkdir -p /var/data && chown node:node /var/data
ENV HOST=0.0.0.0 PORT=8787 DATA_FILE=/var/data/data.json
VOLUME /var/data
EXPOSE 8787
USER node
CMD ["node", "server.js"]
