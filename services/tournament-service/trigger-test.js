
const { PrismaClient } = require('@prisma/client');
const { publishEvent, Topics } = require('../../shared/events');
const prisma = new PrismaClient();

async function triggerCorrectly() {
    try {
        // Find the latest season I created
        const season = await prisma.season.findFirst({
            where: { name: 'Test Season - Agent Assignment Demo' },
            orderBy: { createdAt: 'desc' }
        });

        if (!season) {
            console.error('Test season not found!');
            return;
        }

        const seasonId = season.seasonId;
        const tournamentId = season.tournamentId;
        const clubId = season.clubId;

        console.log(`Found Season: ${seasonId} for Tournament: ${tournamentId}`);

        // Get players
        const players = await prisma.tournamentPlayer.findMany({
            where: { seasonId, status: { not: 'eliminated' } },
            select: { playerId: true }
        });

        const playerIds = players.map(p => p.playerId);
        console.log(`Found ${playerIds.length} players for match generation`);

        if (playerIds.length < 2) {
            console.error('Not enough players found in DB for this season!');
            return;
        }

        console.log('\nPublishing GENERATE_MATCHES event...');

        await publishEvent(Topics.GENERATE_MATCHES, {
            tournamentId,
            seasonId,
            clubId,
            stage: 'semifinal',
            players: playerIds,
            matchDurationSeconds: 300,
            entryFee: 5000,
            startTime: new Date().toISOString(),
            gameType: 'multiplayer'
        });

        console.log('✅ GENERATE_MATCHES event published!');
        console.log('Waiting 5 seconds for matchmaking service to process...');
        await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await prisma.$disconnect();
    }
}

triggerCorrectly();
