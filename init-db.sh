#!/bin/sh
set -e

create_db() {
  local db="$1"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE ${db}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${db}')\\gexec
EOSQL
}

create_db "auth_db"
create_db "player_db"
create_db "game_db"
create_db "matchmaking_db"
create_db "tournament_db"
create_db "payment_db"
create_db "wallet_db"
create_db "admin_db"
create_db "notification_db"
create_db "agent_db"
create_db "revenue_analytics_db"
