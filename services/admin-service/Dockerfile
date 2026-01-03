FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY services/admin-service/package*.json ./
RUN npm install --omit=dev

COPY shared/package*.json /shared/
RUN npm install --omit=dev --prefix /shared

COPY services/admin-service/ ./
COPY shared /shared

RUN ln -s /shared /app/shared

RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "start"]
