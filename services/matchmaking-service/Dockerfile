FROM node:20-alpine

RUN apk add --no-cache openssl1.1-compat

WORKDIR /app

COPY services/matchmaking-service/package*.json ./
RUN npm install --omit=dev

COPY shared/package*.json /shared/
RUN npm install --omit=dev --prefix /shared

COPY services/matchmaking-service/ ./
COPY shared /shared

RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "start"]
