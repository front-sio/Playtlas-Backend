const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');

router.post('/send', notificationController.sendNotification);
router.post('/send-bulk', notificationController.sendBulkNotifications);
router.get('/user/:userId', notificationController.getUserNotifications);
router.put('/:notificationId/read', notificationController.markAsRead);
router.get('/preferences/:userId', notificationController.getPreferences);
router.put('/preferences/:userId', notificationController.updatePreferences);

module.exports = router;
