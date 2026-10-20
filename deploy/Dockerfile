# Build from the repo root: docker build -f deploy/Dockerfile -t agentrelay .
FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY server/ ./server/
COPY portal/ ./portal/
ENV HOST=0.0.0.0 PORT=8787 DATA_FILE=/data/data.json
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.js"]
