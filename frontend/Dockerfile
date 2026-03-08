# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
# Use `npm ci` for reproducible builds when package-lock.json is present.
# Falls back to `npm install` if no lockfile exists.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
# API URL is injected at build time; defaults to same-host nginx proxy
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ── Stage 2: serve ────────────────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
