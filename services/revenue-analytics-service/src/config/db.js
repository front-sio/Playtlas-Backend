const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

// Test database connection
prisma.$connect()
  .then(() => console.log('✅ Revenue Analytics Database connected'))
  .catch((err) => console.error('❌ Revenue Analytics Database connection failed:', err));

module.exports = { prisma };
