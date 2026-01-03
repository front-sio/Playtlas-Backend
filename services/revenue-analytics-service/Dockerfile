FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code
COPY . .

RUN npx prisma generate
# Create logs directory
RUN mkdir -p logs

# Expose port
EXPOSE 3008

# Start the application
CMD ["npm", "start"]
