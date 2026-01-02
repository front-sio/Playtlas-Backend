import cron from 'node-cron'; // Assuming node-cron is available as a dependency
// eslint-disable-next-line @typescript-eslint/no-var-requires
const commissionService = require('../services/commissionService');

// Schedule the commission calculation job
// This example runs the job every day at 3:00 AM.
// Adjust the cron schedule as needed.
// Note: Ensure node-cron is installed as a dependency in player-service's package.json.
// If node-cron is not available, an alternative scheduling mechanism or event-driven approach should be used.
const schedule = '0 3 * * *'; // Every day at 3:00 AM

export const startCommissionJob = () => {
  cron.schedule(schedule, async () => {
    console.log('Running scheduled commission calculation job...');
    try {
      await commissionService.calculateAndDistributeCommissionsForRecentActivity();
      console.log('Scheduled commission calculation job completed successfully.');
    } catch (error) {
      console.error('Error running scheduled commission calculation job:', error);
      // Implement error handling and alerting here
    }
  }, {
    scheduled: true,
    timezone: "UTC" // Specify timezone for consistency
  });

  console.log(`Commission calculation job scheduled to run daily at 3:00 AM UTC.`);
};

// You would typically call startCommissionJob() from your player-service's main entry point (e.g., server.js)
// Example:
// import { startCommissionJob } from './jobs/CommissionJob';
// ...
// startCommissionJob();
// ...
