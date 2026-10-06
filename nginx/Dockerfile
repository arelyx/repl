# Build context is the repo root so the SPA can be built here.
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM nginx:1.28.2-alpine
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=frontend /build/dist/ /usr/share/nginx/html/
