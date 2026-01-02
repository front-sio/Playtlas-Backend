// Aggregator for shared modules. Enables imports like:
//   const { env, createDb, KafkaTopics } = require('../shared');

module.exports = {
  // config
  ...require('./config/env'),
  ...require('./config/db'),
  ...require('./config/redis'),
  ...require('./config/kafka'),

  // middlewares
  ...require('./middlewares/authMiddleware'),
  ...require('./middlewares/errorMiddleware'),
  ...require('./middlewares/validationMiddleware'),

  // utils
  ...require('./utils/logger'),
  ...require('./utils/otp'),
  ...require('./utils/email'),
  ...require('./utils/sms'),
  ...require('./utils/wallet'),
  ...require('./utils/drizzleHelpers'),
  ...require('./utils/walletHelper'),
  ...require('./utils/notificationHelper'),

  // events
  ...require('./events'),

  // constants
  ...require('./constants/kafkaTopics'),
  ...require('./constants/queueNames'),
  ...require('./constants/statuses')
};
