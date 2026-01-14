#!/usr/bin/env node

// Debug script to test timeout calculations
require('dotenv').config();
const { prisma } = require('./src/config/db');

async function testTimeoutCalculations() {
  try {
    console.log('🔍 Testing timeout calculations...\n');
    
    // Get the most recent active sessions
    const sessions = await prisma.gameSession.findMany({
      where: { status: { in: ['active', 'completed'] } },
      orderBy: { createdAt: 'desc' },
      take: 3
    });
    
    for (const session of sessions) {
      console.log(`📋 Session: ${session.sessionId}`);
      console.log(`   Status: ${session.status}`);
      console.log(`   Created: ${session.createdAt}`);
      console.log(`   Started: ${session.startedAt}`);
      
      if (session.metadata) {
        const metadata = typeof session.metadata === 'string' 
          ? JSON.parse(session.metadata) 
          : session.metadata;
          
        console.log(`   Max Duration: ${metadata.maxDurationSeconds || 300}s`);
        console.log(`   Game Type: ${metadata.gameType || 'unknown'}`);
        console.log(`   AI Difficulty: ${metadata.aiDifficulty || 'none'}`);
        
        // Test timing calculations
        const maxDurationSeconds = metadata.maxDurationSeconds || 300;
        const startTime = metadata.startTime ? 
          new Date(metadata.startTime) : 
          new Date(session.startedAt || session.createdAt);
          
        const now = new Date();
        const elapsedSeconds = Math.max(0, (now - startTime) / 1000);
        const timeRemainingSeconds = Math.max(0, maxDurationSeconds - elapsedSeconds);
        
        console.log(`   Start Time: ${startTime.toISOString()}`);
        console.log(`   Elapsed: ${Math.round(elapsedSeconds)}s`);
        console.log(`   Remaining: ${Math.round(timeRemainingSeconds)}s`);
        console.log(`   Expired: ${elapsedSeconds >= maxDurationSeconds ? '⚠️  YES' : '✅ NO'}`);
      }
      
      console.log(''); // Empty line
    }
    
    console.log('✅ Timeout calculation test completed');
  } catch (error) {
    console.error('❌ Error testing timeout calculations:', error);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  testTimeoutCalculations();
}

module.exports = { testTimeoutCalculations };