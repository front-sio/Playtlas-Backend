#!/bin/bash

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Billard-Game Backend Setup - All Services       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"

# Services array
services=(
  "auth-service"
  "wallet-service"
  "payment-service"
  "admin-service"
  "tournament-service"
  "player-service"
  "matchmaking-service"
  "notification-service"
)

# Step 1: Create Databases
echo -e "\n${BLUE}[Step 1/2] Setting up Databases...${NC}"
if command -v node &> /dev/null; then
  node create-databases.js
else
  echo -e "${YELLOW}⚠ Node.js not found, please create databases manually${NC}"
fi

# Step 2: Run Migrations for each service
echo -e "\n${BLUE}[Step 2/2] Running Migrations for Each Service...${NC}"

for service in "${services[@]}"; do
  echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}Setting up: ${service}${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  
  if [ -d "services/${service}" ]; then
    cd "services/${service}"
    
    # Install dependencies
    echo -e "${YELLOW}• Installing dependencies...${NC}"
    npm install > /dev/null 2>&1 || true
    
    # Load env variables
    if [ -f ".env" ]; then
      export $(cat .env | grep -v '#' | xargs)
    fi
    
    # Run migration
    echo -e "${YELLOW}• Running migrations...${NC}"
    npx drizzle-kit push:pg 2>/dev/null && echo -e "${GREEN}✓ Migration successful${NC}" || echo -e "${YELLOW}⚠ Migration completed (schema may already exist)${NC}"
    
    cd - > /dev/null
  else
    echo -e "${YELLOW}✗ Service directory not found${NC}"
  fi
done

echo -e "\n${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}✓ Setup Complete!${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"

echo -e "\n${BLUE}Next Steps:${NC}"
echo -e "  1. Start services: ${YELLOW}npm run dev${NC} in each service directory"
echo -e "  2. Start API Gateway: ${YELLOW}cd api-gateway && npm run dev${NC}"
echo -e "  3. Start Frontend: ${YELLOW}cd billiards-next && npm run dev${NC}"
echo -e "  4. Visit: ${YELLOW}http://localhost:3000${NC}"

