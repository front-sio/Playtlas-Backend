#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE auth_db;
    CREATE DATABASE player_db;
    CREATE DATABASE game_db;
    CREATE DATABASE matchmaking_db;
    CREATE DATABASE tournament_db;
    CREATE DATABASE payment_db;
    CREATE DATABASE wallet_db;
    CREATE DATABASE admin_db;
    CREATE DATABASE notification_db;
EOSQL
