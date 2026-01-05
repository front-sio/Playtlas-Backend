const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const matchmakingRoutes = require('./routes/matchmaking.js');
const { setupSocketHandlers } = require('./controllers/socketController.js');
const { setIO } = require('./utils/socket');
const { startMatchScheduler } = require('./utils/matchScheduler.js');
const { startMatchTimeoutMonitor } = require('./utils/matchTimeouts.js');
const startCleanupJob = require('./jobs/cleanup.js');
const { initializeTournamentEventConsumer } = require('./controllers/matchCreationController');
const { PrismaClient } = require('@prisma/client');



dotenv.config();

const prisma = new PrismaClient(); // For matchmaking service

// Verify database connections
prisma.$connect()
  .then(() => console.log('✓ Matchmaking service database connected via Prisma'))
  .catch((err) => console.error('✗ Matchmaking service database connection failed', err));

// Tournament DB direct access removed: match generation is now triggered by Kafka event payloads.


const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? process.env.ALLOWED_ORIGINS?.split(',') : '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    service: 'matchmaking-service',
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/matchmaking', matchmakingRoutes);

// Socket.IO setup
setupSocketHandlers(io);
setIO(io);

// Make io accessible to routes
app.set('io', io);

// Start match scheduler (legacy queue-based matchmaking)
if (process.env.MATCH_QUEUE_ENABLED === 'true') {
  startMatchScheduler(io, prisma);
} else {
  console.log('ℹ️ Match queue scheduler disabled (set MATCH_QUEUE_ENABLED=true to enable)');
}

// Enforce match timeouts and auto-results
startMatchTimeoutMonitor(io, prisma);

// Start cleanup job
startCleanupJob(prisma).start(); // Pass prisma to cleanupJob

// Kafka consumer for fixture generation (event-driven)
initializeTournamentEventConsumer();



// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

const PORT = process.env.PORT || 3009;

httpServer.listen(PORT, () => {
  console.log(`🎮 Matchmaking Service running on port ${PORT}`);
  console.log(`🔌 Socket.IO server ready for connections`);
});

module.exports = { io };
