#!/bin/bash

# ===============================================
# Run Database Migrations for All Services
# ===============================================

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}===============================================${NC}"
echo -e "${BLUE}Running Database Migrations for All Services${NC}"
echo -e "${BLUE}===============================================${NC}"

# Load root .env if exists
if [ -f ".env" ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Ensure PGPASSWORD is set for psql
if [ -z "$PGPASSWORD" ] && [ ! -z "$POSTGRES_PASSWORD" ]; then
  export PGPASSWORD=$POSTGRES_PASSWORD
fi

# Databases to create
databases=(
  "pool_game_auth"
  "pool_game_wallet"
  "pool_game_payment"
  "pool_game_admin"
  "pool_game_tournament"
  "pool_game_player"
  "pool_game_matchmaking"
  "pool_game_notifications"
)

echo -e "${BLUE}\n[1/2] Creating PostgreSQL Databases...${NC}"

for db in "${databases[@]}"; do
  exists=$(psql -U "$POSTGRES_USER" -h localhost -tAc "SELECT 1 FROM pg_database WHERE datname='$db'")
  if [[ $exists == "1" ]]; then
    echo -e "${GREEN}✓ $db already exists${NC}"
  else
    psql -U "$POSTGRES_USER" -h localhost -c "CREATE DATABASE $db;" && echo -e "${GREEN}✓ $db created${NC}" || echo -e "${RED}✗ Failed to create $db${NC}"
  fi
done

# Services (Prisma-based)
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

echo -e "${BLUE}\n[2/2] Running Migrations for Each Service...${NC}"

for service in "${services[@]}"; do
  echo -e "\n${BLUE}Processing: $service${NC}"

  service_path="services/$service"
  if [ -d "$service_path" ]; then
    cd "$service_path"

    # Load service-specific .env if exists
    if [ -f ".env" ]; then
      export $(grep -v '^#' .env | xargs)
    fi

    if [ -f "prisma/schema.prisma" ]; then
      echo "  Running: npx prisma migrate deploy"
      npx prisma migrate deploy && echo -e "  ${GREEN}✓ Migration successful${NC}" || echo -e "  ${RED}✗ Migration failed${NC}"
    elif [ -f "drizzle.config.js" ]; then
      echo "  Running: npx drizzle-kit push:pg"
      npx drizzle-kit push:pg && echo -e "  ${GREEN}✓ Migration successful${NC}" || echo -e "  ${RED}✗ Migration failed${NC}"
    else
      echo -e "  ${RED}✗ No Prisma/Drizzle config found${NC}"
    fi

    cd - > /dev/null
  else
    echo -e "  ${RED}✗ Service directory not found${NC}"
  fi
done

echo -e "\n${BLUE}===============================================${NC}"
echo -e "${GREEN}✓ All migrations completed!${NC}"
echo -e "${BLUE}===============================================${NC}"
