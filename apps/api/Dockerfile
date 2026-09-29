FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/miniprogram/package.json apps/miniprogram/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN npm run build --workspace @home-medicine/contracts
RUN npm run build --workspace @home-medicine/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/miniprogram/package.json apps/miniprogram/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/db ./apps/api/db
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
RUN mkdir -p /var/lib/medbox/private-uploads && chown -R node:node /var/lib/medbox
ENV PRIVATE_UPLOAD_DIR=/var/lib/medbox/private-uploads

EXPOSE 3000
USER node
CMD ["node", "apps/api/dist/server.js"]
