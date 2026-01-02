const { PrismaClient, Prisma } = require('@prisma/client');

const sql = Prisma.sql;

const prisma = new PrismaClient({
  errorFormat: 'pretty',
  log: ['error'],
});

const testConnection = async () => {
  try {
    await prisma.$connect();
    console.log('✓ Payment service database connected via Prisma');
    return true;
  } catch (err) {
    console.error('✗ Failed to connect to database:', err);
    return false;
  }
};

module.exports = { prisma, testConnection, sql };