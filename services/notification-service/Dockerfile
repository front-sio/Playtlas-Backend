FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY services/notification-service/package*.json ./
RUN npm install --omit=dev

COPY shared/package*.json /shared/
RUN npm install --omit=dev --prefix /shared

COPY services/notification-service/ ./
COPY shared /shared

RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "start"]
