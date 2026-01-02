#!/usr/bin/env node

/**
 * Script to create admin users, regular users, and tournaments
 * This script registers users with different roles and creates sample tournaments
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// Configuration
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://[::1]:3011';
const ADMIN_SERVICE_URL = process.env.ADMIN_SERVICE_URL || 'http://[::1]:3070';
const TOURNAMENT_SERVICE_URL = process.env.TOURNAMENT_SERVICE_URL || 'http://[::1]:3010';
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://[::1]:3002';

// Admin credentials (you should change these in production)
const ADMIN_CREDENTIALS = {
  username: 'superadmin',
  email: 'admin@pooltable.com',
  password: 'Admin123456',
  firstName: 'Super',
  lastName: 'Admin',
  gender: 'male',
  phoneNumber: '+255712345678'
};

// Finance officers to create
const FINANCE_OFFICERS = [
  {
    username: 'finance_officer_1',
    email: 'finance1@pooltable.com',
    password: 'Finance123456',
    firstName: 'Finance',
    lastName: 'Officer One',
    gender: 'male',
    phoneNumber: '+255712345679'
  },
  {
    username: 'finance_officer_2',
    email: 'finance2@pooltable.com',
    password: 'Finance123456',
    firstName: 'Finance',
    lastName: 'Officer Two',
    gender: 'female',
    phoneNumber: '+255712345680'
  },
  {
    username: 'finance_manager',
    email: 'financemgr@pooltable.com',
    password: 'FinanceMgr123456',
    firstName: 'Finance',
    lastName: 'Manager',
    gender: 'male',
    phoneNumber: '+255712345681'
  }
];

// Game play users
const GAME_PLAY_USERS = [
  {
    username: 'player1',
    email: 'player1@pooltable.com',
    password: 'Player123456',
    firstName: 'Game',
    lastName: 'Player One',
    gender: 'male',
    phoneNumber: '+255712345682'
  },
  {
    username: 'player2',
    email: 'player2@pooltable.com',
    password: 'Player123456',
    firstName: 'Game',
    lastName: 'Player Two',
    gender: 'female',
    phoneNumber: '+255712345683'
  },
  {
    username: 'pro_player',
    email: 'pro@pooltable.com',
    password: 'ProPlayer123456',
    firstName: 'Professional',
    lastName: 'Player',
    gender: 'male',
    phoneNumber: '+255712345684'
  }
];

// Check users (for verification/auditing)
const CHECK_USERS = [
  {
    username: 'auditor1',
    email: 'auditor1@pooltable.com',
    password: 'Audit123456',
    firstName: 'Audit',
    lastName: 'Checker One',
    gender: 'male',
    phoneNumber: '+255712345685'
  },
  {
    username: 'verifier1',
    email: 'verifier1@pooltable.com',
    password: 'Verify123456',
    firstName: 'Verify',
    lastName: 'Specialist',
    gender: 'female',
    phoneNumber: '+255712345686'
  }
];

// Tournament data
const TOURNAMENTS = [
  {
    name: "Daily Cash Tournament",
    description: "Daily tournament with cash prizes for all skill levels",
    entryFee: 10.00,
    maxPlayers: 32,
    startTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours from now
    seasonDuration: 1200 // 20 minutes
  },
  {
    name: "Weekly Championship",
    description: "Weekly championship tournament with higher stakes",
    entryFee: 50.00,
    maxPlayers: 64,
    startTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
    seasonDuration: 1200 // 20 minutes
  },
  {
    name: "Beginner's League",
    description: "Tournament specifically for new players",
    entryFee: 5.00,
    maxPlayers: 16,
    startTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), // 3 hours from now
    seasonDuration: 1200 // 20 minutes
  }
];

let authToken = null;

// Helper functions
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeAuthenticatedRequest(url, options = {}) {
  const config = {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${authToken}`
    }
  };
  return axios(url, config);
}

async function registerUser(userData) {
  try {
    console.log(`\n📝 Registering user: ${userData.username}`);
    
    const response = await axios.post(`${AUTH_SERVICE_URL}/register`, userData);
    
    if (response.data.success) {
      console.log(`✅ User registered successfully: ${userData.username}`);
      console.log(`   📧 Email: ${userData.email}`);
      console.log(`   🆔 UserID: ${response.data.data.user.userId}`);
      
      // Auto-verify in development (skip email verification)
      if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
        await delay(1000);
        try {
          await axios.post(`${AUTH_SERVICE_URL}/dev-auto-verify`, {
            userId: response.data.data.user.userId
          });
          console.log(`   ✅ User auto-verified: ${userData.username}`);
        } catch (verifyError) {
          console.log(`   ⚠️  Auto-verification failed for ${userData.username}:`, verifyError.response?.data?.error);
        }
      }
      
      return {
        success: true,
        userId: response.data.data.user.userId,
        userData: response.data.data.user
      };
    } else {
      console.log(`❌ Registration failed for ${userData.username}:`, response.data.error);
      return { success: false, error: response.data.error };
    }
  } catch (error) {
    if (error.response?.status === 400 && error.response?.data?.error?.includes('already exists')) {
      console.log(`⚠️  User ${userData.username} already exists`);
      return { success: false, error: 'User already exists' };
    }
    console.log(`❌ Error registering user ${userData.username}:`, error.response?.data?.error || error.message);
    return { success: false, error: error.message };
  }
}

async function loginUser(credentials) {
  try {
    console.log(`\n🔐 Logging in: ${credentials.username}`);
    
    const response = await axios.post(`${AUTH_SERVICE_URL}/login`, {
      identifier: credentials.email || credentials.username,
      password: credentials.password
    });
    
    if (response.data.success) {
      authToken = response.data.data.accessToken;
      console.log(`✅ Login successful: ${credentials.username}`);
      console.log(`   🎭 Role: ${response.data.data.user.role}`);
      return {
        success: true,
        user: response.data.data.user,
        token: response.data.data.accessToken
      };
    } else {
      console.log(`❌ Login failed for ${credentials.username}:`, response.data.error);
      return { success: false, error: response.data.error };
    }
  } catch (error) {
    console.log(`❌ Error logging in ${credentials.username}:`, error.response?.data?.error || error.message);
    return { success: false, error: error.message };
  }
}

async function updateUserRole(userId, newRole) {
  try {
    console.log(`\n👑 Updating user role to: ${newRole}`);
    
    const response = await makeAuthenticatedRequest(`${AUTH_SERVICE_URL}/users/${userId}`, {
      method: 'PUT',
      data: { role: newRole }
    });
    
    if (response.data.success) {
      console.log(`✅ User role updated to: ${newRole}`);
      return { success: true };
    } else {
      console.log(`❌ Role update failed:`, response.data.error);
      return { success: false, error: response.data.error };
    }
  } catch (error) {
    console.log(`❌ Error updating user role:`, error.response?.data?.error || error.message);
    return { success: false, error: error.message };
  }
}

async function createAdminUser(userId, role, permissions = {}) {
  try {
    console.log(`\n🛡️  Creating admin user with role: ${role}`);
    
    const response = await makeAuthenticatedRequest(`${ADMIN_SERVICE_URL}/admin`, {
      method: 'POST',
      data: {
        userId,
        role,
        permissions,
        createdBy: 'system'
      }
    });
    
    if (response.data.success) {
      console.log(`✅ Admin user created: ${role}`);
      return { success: true };
    } else {
      console.log(`❌ Admin creation failed:`, response.data.error);
      return { success: false, error: response.data.error };
    }
  } catch (error) {
    console.log(`❌ Error creating admin user:`, error.response?.data?.error || error.message);
    return { success: false, error: error.message };
  }
}

async function createTournament(tournamentData) {
  try {
    console.log(`\n🏆 Creating tournament: ${tournamentData.name}`);
    
    const response = await makeAuthenticatedRequest(`${TOURNAMENT_SERVICE_URL}/`, {
      method: 'POST',
      data: tournamentData
    });
    
    if (response.data.success) {
      console.log(`✅ Tournament created: ${tournamentData.name}`);
      console.log(`   💰 Entry Fee: $${tournamentData.entryFee}`);
      console.log(`   👥 Max Players: ${tournamentData.maxPlayers}`);
      console.log(`   🆔 Tournament ID: ${response.data.data.tournamentId}`);
      
      // Start the tournament
      await delay(1000);
      try {
        const startResponse = await makeAuthenticatedRequest(`${TOURNAMENT_SERVICE_URL}/${response.data.data.tournamentId}/start`, {
          method: 'POST'
        });
        
        if (startResponse.data.success) {
          console.log(`   🚀 Tournament started successfully`);
          console.log(`   📅 Season ID: ${startResponse.data.data.season.seasonId}`);
        }
      } catch (startError) {
        console.log(`   ⚠️  Failed to start tournament:`, startError.response?.data?.error);
      }
      
      return { success: true, tournamentId: response.data.data.tournamentId };
    } else {
      console.log(`❌ Tournament creation failed:`, response.data.error);
      return { success: false, error: response.data.error };
    }
  } catch (error) {
    console.log(`❌ Error creating tournament:`, error.response?.data?.error || error.message);
    return { success: false, error: error.message };
  }
}

// Main execution function
async function main() {
  console.log('🚀 Starting user and tournament setup...\n');
  
  // Step 1: Create and login as super admin
  console.log('=== STEP 1: Create Super Admin ===');
  const adminResult = await registerUser(ADMIN_CREDENTIALS);
  
  if (!adminResult.success && adminResult.error !== 'User already exists') {
    console.log('❌ Failed to create super admin, exiting...');
    process.exit(1);
  }
  
  // Login as admin
  const loginResult = await loginUser(ADMIN_CREDENTIALS);
  if (!loginResult.success) {
    console.log('❌ Failed to login as admin, exiting...');
    process.exit(1);
  }
  
  // Update admin role to super_admin
  await updateUserRole(loginResult.user.userId, 'super_admin');
  await createAdminUser(loginResult.user.userId, 'admin', { all: true });
  
  // Step 2: Create finance officers
  console.log('\n=== STEP 2: Create Finance Officers ===');
  const financeUserIds = [];
  
  for (const officer of FINANCE_OFFICERS) {
    const result = await registerUser(officer);
    if (result.success) {
      financeUserIds.push(result.userId);
      
      // Set role and create admin record
      const role = officer.username.includes('manager') ? 'finance_manager' : 'finance_officer';
      await updateUserRole(result.userId, role);
      await createAdminUser(result.userId, role, {
        financial_management: true,
        payout_approval: true,
        transaction_monitoring: true
      });
    }
    await delay(500);
  }
  
  // Step 3: Create game play users
  console.log('\n=== STEP 3: Create Game Play Users ===');
  const gamePlayUserIds = [];
  
  for (const player of GAME_PLAY_USERS) {
    const result = await registerUser(player);
    if (result.success) {
      gamePlayUserIds.push(result.userId);
      await updateUserRole(result.userId, 'player');
    }
    await delay(500);
  }
  
  // Step 4: Create check users
  console.log('\n=== STEP 4: Create Check/Audit Users ===');
  const checkUserIds = [];
  
  for (const checker of CHECK_USERS) {
    const result = await registerUser(checker);
    if (result.success) {
      checkUserIds.push(result.userId);
      
      // Set role based on username
      const role = checker.username.includes('audit') ? 'auditor' : 'verifier';
      await updateUserRole(result.userId, role);
      await createAdminUser(result.userId, role, {
        audit_access: true,
        verification_access: true,
        read_only: true
      });
    }
    await delay(500);
  }
  
  // Step 5: Create tournaments
  console.log('\n=== STEP 5: Create Tournaments ===');
  const tournamentIds = [];
  
  for (const tournament of TOURNAMENTS) {
    const result = await createTournament(tournament);
    if (result.success) {
      tournamentIds.push(result.tournamentId);
    }
    await delay(1000);
  }
  
  // Summary
  console.log('\n=== SETUP COMPLETE ===');
  console.log(`✅ Admin Users: 1 (super admin)`);
  console.log(`✅ Finance Officers: ${financeUserIds.length}`);
  console.log(`✅ Game Play Users: ${gamePlayUserIds.length}`);
  console.log(`✅ Check/Audit Users: ${checkUserIds.length}`);
  console.log(`✅ Tournaments: ${tournamentIds.length}`);
  
  console.log('\n=== LOGIN CREDENTIALS ===');
  console.log('Super Admin:');
  console.log(`  Username: ${ADMIN_CREDENTIALS.username}`);
  console.log(`  Email: ${ADMIN_CREDENTIALS.email}`);
  console.log(`  Password: ${ADMIN_CREDENTIALS.password}`);
  
  console.log('\nFinance Officers:');
  FINANCE_OFFICERS.forEach(officer => {
    console.log(`  ${officer.username}: ${officer.password}`);
  });
  
  console.log('\nGame Play Users:');
  GAME_PLAY_USERS.forEach(player => {
    console.log(`  ${player.username}: ${player.password}`);
  });
  
  console.log('\nCheck/Audit Users:');
  CHECK_USERS.forEach(checker => {
    console.log(`  ${checker.username}: ${checker.password}`);
  });
  
  console.log('\n🎉 Setup completed successfully!');
}

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Run the script
if (require.main === module) {
  main().catch(error => {
    console.error('Script failed:', error);
    process.exit(1);
  });
}

module.exports = {
  registerUser,
  loginUser,
  updateUserRole,
  createAdminUser,
  createTournament,
  FINANCE_OFFICERS,
  GAME_PLAY_USERS,
  CHECK_USERS,
  TOURNAMENTS
};
