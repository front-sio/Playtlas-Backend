FROM node:20-alpine

WORKDIR /app

COPY api-gateway/package*.json ./
RUN npm install --omit=dev

COPY api-gateway ./
COPY shared/package*.json /shared/
RUN npm install --omit=dev --prefix /shared
COPY shared /shared

RUN ln -s /shared /app/shared

EXPOSE 6000

CMD ["npm", "start"]
