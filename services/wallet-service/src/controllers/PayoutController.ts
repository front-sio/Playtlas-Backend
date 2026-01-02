import { Router, Request, Response, NextFunction } from 'express';
import { PayoutService } from '../services/PayoutService';
import axios from 'axios'; // For inter-service communication
import { PayoutStatus } from '@prisma/client'; // Assuming PayoutStatus enum or string literals are used

// Types for external service responses (simplified)
interface User {
  userId: string;
  username: string;
  email: string;
  // other user fields...
}

interface PayoutMethod {
  payoutMethodId: string;
  userId: string;
  providerName: string;
  accountNumber: string;
  // other payout method fields...
}

const router = Router();
const payoutService = new PayoutService();

// POST /payouts/:payoutId/confirm
// Endpoint for office users to confirm or process a payout.
// Requires office role authentication.
router.post(
  '/:payoutId/confirm',
  authenticate, // Middleware to verify JWT and attach user to request
  authorize(['admin', 'staff', 'manager', 'director', 'superuser']), // Middleware to check role
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { payoutId } = req.params;
      const { status, failureReason } = req.body; // e.g., 'completed', 'failed', 'cancelled'
      const processedByUserId = req.user.userId; // The ID of the authenticated office user

      if (!payoutId) {
        return res.status(400).json({ message: "Payout ID is required in the path." });
      }
      if (!status) {
        return res.status(400).json({ message: "Status ('completed', 'failed', 'cancelled') is required in the request body." });
      }
      if (status === 'failed' && !failureReason) {
        return res.status(400).json({ message: "Failure reason is required when status is 'failed'." });
      }

      // Validate status
      const allowedStatuses = ['completed', 'failed', 'cancelled'];
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: `Invalid status. Allowed statuses are: ${allowedStatuses.join(', ')}.` });
      }

      const updatedPayout = await payoutService.confirmPayout(
        payoutId,
        status,
        failureReason,
        processedByUserId
      );

      res.status(200).json({
        message: `Payout ${payoutId} confirmed successfully with status: ${status}.`,
        payout: updatedPayout,
      });
    } catch (error: any) {
      console.error(`Error in POST /payouts/${req.params.payoutId}/confirm:`, error);
      res.status(500).json({ message: error.message || "Internal Server Error" });
    }
  }
);

// POST /payouts/initiate
// Endpoint for players to initiate a payout request.
// Requires player authentication.
router.post(
  '/initiate',
  authenticate, // Middleware to verify JWT and attach user to request
  authorize(['player', 'admin', 'staff', 'manager', 'director', 'superuser']), // Players and potentially admins can initiate payouts
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user.userId; // The ID of the authenticated user (player)
      const { payoutMethodId, amount } = req.body;

      if (!userId) {
        return res.status(400).json({ message: "User ID not found in authentication context." });
      }
      if (!payoutMethodId) {
        return res.status(400).json({ message: "Payout Method ID is required in the request body." });
      }
      // Type assertion for amount to number and check for positivity
      const numericAmount = Number(amount); // Ensure amount is treated as a number
      if (isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ message: "Valid positive payout amount is required in the request body." });
      }


      const initiatedPayout = await payoutService.initiatePayout(userId, payoutMethodId, numericAmount);

      res.status(201).json({
        message: "Payout initiated successfully.",
        payout: initiatedPayout,
      });
    } catch (error: any) {
      console.error(`Error in POST /payouts/initiate for user ${req.user.userId}:`, error);
      res.status(500).json({ message: error.message || "Internal Server Error" });
    }
  }
);

export default router;
