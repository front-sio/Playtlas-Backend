import pkg from 'pg';
const { Client } = pkg;

const databases = [
  'pool_game_auth',
  'pool_game_wallet',
  'pool_game_payment',
  'pool_game_admin',
  'pool_game_tournament',
  'pool_game_player',
  'pool_game_matchmaking',
  'pool_game_notifications'
];

async function createDatabases() {
  const client = new Client({
    user: 'postgres',
    password: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'postgres'
  });

  try {
    await client.connect();
    console.log('✓ Connected to PostgreSQL');
    console.log('\nCreating databases...\n');

    for (const db of databases) {
      try {
        await client.query(`CREATE DATABASE ${db}`);
        console.log(`✓ Created: ${db}`);
      } catch (err) {
        if (err.message.includes('already exists')) {
          console.log(`✓ Exists: ${db}`);
        } else {
          console.error(`✗ Error creating ${db}:`, err.message);
        }
      }
    }

    await client.end();
    console.log('\n✓ Database setup complete!');
  } catch (err) {
    console.error('✗ Connection failed:', err.message);
    process.exit(1);
  }
}

createDatabases();
