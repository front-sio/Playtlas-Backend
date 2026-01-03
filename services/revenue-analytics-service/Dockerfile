FROM node:18-alpine

RUN apk add --no-cache openssl1.1-compat

WORKDIR /app

COPY services/revenue-analytics-service/package*.json ./
RUN npm install --omit=dev

COPY shared/package*.json /shared/
RUN npm install --omit=dev --prefix /shared

COPY services/revenue-analytics-service/ ./
COPY shared /shared

RUN npx prisma generate
RUN mkdir -p logs

EXPOSE 3000

CMD ["npm", "start"]
