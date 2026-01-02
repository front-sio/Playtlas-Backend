#!/bin/bash

# PRISMA MIGRATION COMPLETE - CODE CONVERSION HELPER
# This script helps convert Drizzle queries to Prisma in each service

SERVICES=(
  "auth-service"
  "game-service"
  "tournament-service"
  "player-service"
  "wallet-service"
  "notification-service"
  "payment-service"
  "admin-service"
  "matchmaking-service"
)

BACKEND_DIR="/home/masanja/API/Billard-Game/backend"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           PRISMA MIGRATION - CODE CONVERSION GUIDE              ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Find all files with Drizzle imports
echo "🔍 Finding files with Drizzle imports..."
echo ""

for service in "${SERVICES[@]}"; do
  SERVICE_PATH="$BACKEND_DIR/services/$service"
  
  echo "📍 $service:"
  
  # Find Drizzle imports
  DRIZZLE_FILES=$(grep -r "drizzle-orm" "$SERVICE_PATH/src" --include="*.js" 2>/dev/null | cut -d: -f1 | sort -u)
  
  if [ -z "$DRIZZLE_FILES" ]; then
    echo "  ✓ No Drizzle imports found"
  else
    echo "  Files needing conversion:"
    echo "$DRIZZLE_FILES" | while read file; do
      echo "    - $(basename $file)"
      # Count queries
      QUERY_COUNT=$(grep -c "db\." "$file" 2>/dev/null || echo "0")
      if [ "$QUERY_COUNT" -gt 0 ]; then
        echo "      ($QUERY_COUNT queries to convert)"
      fi
    done
  fi
  
  echo ""
done

echo "════════════════════════════════════════════════════════════════"
echo "📋 CONVERSION PATTERNS (Quick Reference)"
echo "════════════════════════════════════════════════════════════════"
echo ""

cat << 'PATTERNS'
SELECT ALL:
  OLD: const results = await db.select().from(table);
  NEW: const results = await prisma.model.findMany();

SELECT FIRST:
  OLD: const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  NEW: const user = await prisma.user.findFirst({ where: { id } });

SELECT UNIQUE:
  OLD: const [user] = await db.select().from(users).where(eq(users.id, id));
  NEW: const user = await prisma.user.findUnique({ where: { id } });

INSERT:
  OLD: const [new] = await db.insert(users).values(data);
  NEW: const new = await prisma.user.create({ data });

UPDATE:
  OLD: await db.update(users).set(data).where(eq(users.id, id));
  NEW: await prisma.user.update({ where: { id }, data });

DELETE:
  OLD: await db.delete(users).where(eq(users.id, id));
  NEW: await prisma.user.delete({ where: { id } });

WHERE CONDITIONS:
  OLD: where(and(eq(users.role, 'admin'), gt(users.points, 100)))
  NEW: where: { role: 'admin', points: { gt: 100 } }

PATTERNS

echo ""
echo "✅ Conversion guide ready"
echo ""
echo "📚 For detailed examples, see:"
echo "   backend/PRISMA_QUICK_REFERENCE.md"
echo ""
