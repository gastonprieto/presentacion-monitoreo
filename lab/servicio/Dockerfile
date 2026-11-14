FROM node:22.23.5-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY otel.js server.js ./
EXPOSE 3000
CMD ["node", "--require", "./otel.js", "server.js"]
