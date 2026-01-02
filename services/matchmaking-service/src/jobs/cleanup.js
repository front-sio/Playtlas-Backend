const cron = require('node-cron');
const logger = require('../utils/logger');

module.exports = (prisma) => {
  // This job runs once a day at midnight
  const job = cron.schedule('0 0 * * *', async () => {
    logger.info('Running cleanup job for old matches...');
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const result = await prisma.match.deleteMany({
        where: {
          status: 'completed',
          updatedAt: {
            lt: sevenDaysAgo,
          },
        },
      });

      logger.info(`Cleanup job completed. Deleted ${result.count} old matches.`);
    } catch (error) {
      logger.error('Error running cleanup job:', error);
    }
  });
  return job;
};
