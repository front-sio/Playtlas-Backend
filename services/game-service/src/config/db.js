const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  errorFormat: 'pretty',
  log: ['error'],
});

prisma.$connect()
  .then(() => {
    console.log('✓ Game service database connected via Prisma');
  })
  .catch((err) => {
    console.error('✗ Failed to connect to database:', err);
    process.exit(1);
  });

module.exports = { prisma };
