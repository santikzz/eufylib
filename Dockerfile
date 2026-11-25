FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8090
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY *.ts ./
RUN mkdir data && chown node:node data
USER node
VOLUME /app/data
EXPOSE 8090
HEALTHCHECK CMD wget -qO- "http://127.0.0.1:${PORT}/up" || exit 1
CMD ["node", "api.ts"]
