# Pocket Planet — single container that builds the PWA and serves it + the API.
# Works on Cloud Run, Render, Railway, Fly.io … anything that runs a container.
FROM node:22-bookworm-slim

WORKDIR /app

# Install ALL deps (build needs tsc/vite; runtime needs tsx to run the TS server).
COPY package*.json ./
RUN npm ci

# Copy the source and build the production PWA into dist/.
COPY . .
RUN npm run build

# Cloud Run (and most hosts) inject PORT; the server reads process.env.PORT and
# binds 0.0.0.0. We default to 8080 to match Cloud Run's convention.
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Serves dist/ (the built app) + /api on $PORT.
CMD ["npm", "run", "start"]
