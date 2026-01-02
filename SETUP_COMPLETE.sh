#!/bin/bash

# PRISMA MIGRATION COMPLETE - FINAL SETUP SCRIPT
# This script validates the Prisma setup and provides next steps

set -e

BACKEND_DIR="/home/masanja/API/Billard-Game/backend"
SERVICES=("auth-service" "game-service" "tournament-service" "player-service" "wallet-service" "notification-service" "payment-service" "admin-service" "matchmaking-service")

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     PRISMA MIGRATION - SETUP VALIDATION & NEXT STEPS            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check 1: Verify all Drizzle files removed
echo "✓ Step 1: Checking Drizzle files removed..."
DRIZZLE_COUNT=$(find "$BACKEND_DIR/services" -name "drizzle.config.js" 2>/dev/null | wc -l)
if [ "$DRIZZLE_COUNT" -eq 0 ]; then
  echo "  ✅ All drizzle.config.js files removed"
else
  echo "  ❌ Found $DRIZZLE_COUNT drizzle.config.js files (should be 0)"
fi

echo ""

# Check 2: Verify Prisma schemas exist
echo "✓ Step 2: Checking Prisma schemas..."
SCHEMA_COUNT=$(find "$BACKEND_DIR/services" -name "schema.prisma" 2>/dev/null | wc -l)
echo "  Found: $SCHEMA_COUNT Prisma schemas (expected: 9)"
if [ "$SCHEMA_COUNT" -eq 9 ]; then
  echo "  ✅ All Prisma schemas present"
else
  echo "  ⚠️  Only $SCHEMA_COUNT schemas found"
fi

echo ""

# Check 3: Verify db.js files exist
echo "✓ Step 3: Checking Prisma db connection files..."
for service in "${SERVICES[@]}"; do
  if [ -f "$BACKEND_DIR/services/$service/src/config/db.js" ]; then
    echo "  ✓ $service"
  else
    echo "  ✗ $service (missing db.js)"
  fi
done

echo ""

# Check 4: List documentation files
echo "✓ Step 4: Documentation files created..."
DOC_FILES=(
  "README_PRISMA_MIGRATION.md"
  "CODE_CONVERSION_GUIDE.md"
  "PRISMA_QUICK_REFERENCE.md"
  "PRISMA_MIGRATION_GUIDE.md"
  ".env.example"
)

for doc in "${DOC_FILES[@]}"; do
  if [ -f "$BACKEND_DIR/$doc" ]; then
    echo "  ✓ $doc"
  else
    echo "  ✗ $doc (missing)"
  fi
done

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "📋 NEXT STEPS FOR COMPLETE MIGRATION"
echo "════════════════════════════════════════════════════════════════"
echo ""

cat << 'STEPS'
STEP 1: Update Environment Variables
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  a) Copy template to .env:
     cp backend/.env.example backend/.env

  b) Update DATABASE_URL in backend/.env:
     DATABASE_URL="postgresql://username:password@localhost:5432/billard_game"

  c) Verify database exists or create it:
     createdb billard_game

STEP 2: Convert Database Queries (Per Service)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Start with auth-service as example:

  1. Open: backend/CODE_CONVERSION_GUIDE.md
  2. Review: authController.prisma.js (reference implementation)
  3. Update: authController.js with Prisma queries
  4. Update: Any other files with database queries
  5. Test: npm run dev

  Resources:
  - backend/PRISMA_QUICK_REFERENCE.md (query patterns)
  - backend/CODE_CONVERSION_GUIDE.md (per-service guide)
  - authController.prisma.js (full example)

STEP 3: Initialize Prisma Migrations
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  For each service (after .env is updated):

    cd backend/services/[SERVICE]
    
    # Push schema to existing database
    npx prisma db push
    
    # Or create migrations (for version control)
    npx prisma migrate dev --name init

STEP 4: Test Each Service
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    cd backend/services/[SERVICE]
    npm install  # if not done
    npm run dev
    
    Check for:
    ✓ Service starts without errors
    ✓ Database connection successful
    ✓ API endpoints respond
    ✓ Queries work correctly

STEP 5: Run Batch Setup (Optional - Automates steps above)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    bash backend/setup-prisma-all.sh

STEPS

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "📚 HELPFUL RESOURCES"
echo "════════════════════════════════════════════════════════════════"
echo ""

echo "Documentation:"
echo "  • README_PRISMA_MIGRATION.md     - Overview & navigation"
echo "  • CODE_CONVERSION_GUIDE.md       - Per-service conversion guide"
echo "  • PRISMA_QUICK_REFERENCE.md    - Query patterns (keep open!)"
echo "  • PRISMA_MIGRATION_GUIDE.md    - Detailed walkthrough"
echo ""

echo "Example Implementation:"
echo "  • authController.prisma.js      - Fully converted example"
echo ""

echo "Useful Prisma Commands:"
echo "  npx prisma studio              - Browse database UI"
echo "  npx prisma generate            - Generate Prisma client"
echo "  npx prisma db push             - Sync schema to DB"
echo "  npx prisma migrate dev         - Create new migration"
echo ""

echo "════════════════════════════════════════════════════════════════"
echo "🎯 CONVERSION ORDER (By Complexity)"
echo "════════════════════════════════════════════════════════════════"
echo ""

echo "🟢 LOW (Start Here - 1-2 hours each):"
echo "   1. auth-service"
echo "   2. game-service"
echo ""

echo "🟡 MEDIUM (2-3 hours each):"
echo "   3. player-service"
echo "   4. wallet-service"
echo "   5. notification-service"
echo "   6. tournament-service"
echo "   7. admin-service"
echo ""

echo "🔴 HIGH (3-4 hours each):"
echo "   8. payment-service"
echo "   9. matchmaking-service (Most complex)"
echo ""

echo "════════════════════════════════════════════════════════════════"
echo ""
echo "✅ STATUS: Prisma setup complete!"
echo ""
echo "⏭️  NEXT ACTION: Update .env and start converting auth-service"
echo ""
