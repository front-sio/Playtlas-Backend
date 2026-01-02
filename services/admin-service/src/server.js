require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const adminRoutes = require('./routes/adminRoutes');
const approvalRoutes = require('./routes/tournamentApprovalRoutes');
const logger = require('./utils/logger');
const { errorHandler } = require('./middlewares/errorHandler');
const { startTournamentLifecycleConsumer } = require('./kafka/tournamentLifecycleConsumer');
const { startTournamentReadModelConsumer } = require('./kafka/tournamentReadModelConsumer');
const { startTournamentCommandResponseConsumer } = require('./kafka/tournamentCommandClient');
const { authMiddleware } = require('../../../shared/middlewares/authMiddleware');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/', authMiddleware, adminRoutes);
app.use('/approvals', authMiddleware, approvalRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'admin-service', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3070;
app.listen(PORT, () => {
  logger.info(`Admin Service running on port ${PORT}`);
  startTournamentLifecycleConsumer().catch((err) => {
    logger.error({ err }, '[admin-service] Failed to start tournament lifecycle consumer');
  });
  startTournamentReadModelConsumer().catch((err) => {
    logger.error({ err }, '[admin-service] Failed to start tournament read-model consumer');
  });
  startTournamentCommandResponseConsumer();
});

module.exports = app;
