FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/ ./src/
USER node
EXPOSE 1234
CMD ["node", "src/index.js"]
