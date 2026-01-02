import { PrismaClient } from '@prisma/client';
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

const prisma = new PrismaClient();

export class PayoutService {
  // Service to confirm or process a payout
  async confirmPayout(
    payoutId: string,
    status: PayoutStatus | string, // Use PayoutStatus enum if defined, otherwise string
    failureReason: string | null | undefined,
    processedByUserId: string
  ): Promise<any> {
    try {
      // 1. Fetch the Payout record from wallet-service DB
      const payout = await prisma.payout.findUnique({
        where: { payoutId },
        include: {
          wallet: true, // Include wallet to get ownerId, balance etc. if needed later
        },
      });

      if (!payout) {
        throw new Error(`Payout with ID ${payoutId} not found.`);
      }

      // Ensure payout is in a state that can be confirmed (e.g., 'pending')
      if (payout.status !== 'pending') {
        throw new Error(`Payout ${payoutId} is already in status: ${payout.status}. Cannot confirm.`);
      }

      // 2. Fetch User and PayoutMethod details from auth-service
      //    These are needed for confirmation details and potential external payment processing.
      //    We store IDs only in the Payout model, so we need to fetch the actual details.

      // Fetch Payout Method details
      const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001'; // Replace with actual URL
      const payoutMethodResponse = await axios.get<PayoutMethod>(`${authServiceUrl}/users/${payout.userId}/payout-methods/${payout.payoutMethodId}`, {
        headers: {
          // Add authentication headers if required for inter-service calls
        }
      });
      const payoutMethod = payoutMethodResponse.data;

      if (!payoutMethod) {
        throw new Error(`Payout method ${payout.payoutMethodId} not found for user ${payout.userId}.`);
      }

      // Fetch User details (initiator and processor)
      const userResponse = await axios.get<User>(`${authServiceUrl}/users/${payout.userId}`, {
        headers: { /* auth headers */ }
      });
      const user = userResponse.data; // User who initiated the payout

      let processorUser = null;
      if (payout.processedByUserId) {
        const processorUserResponse = await axios.get<User>(`${authServiceUrl}/users/${payout.processedByUserId}`, {
          headers: { /* auth headers */ }
        });
        processorUser = processorUserResponse.data;
      }

      // 3. Update Payout record status
      const updatedPayout = await prisma.payout.update({
        where: { payoutId },
        data: {
          status: status,
          failureReason: status === 'failed' ? failureReason : null,
          processedByUserId: processedByUserId,
          provider: payoutMethod.providerName, // Store quick reference
          accountNumber: payoutMethod.accountNumber, // Store quick reference
          // Note: Actual debit from wallet should happen BEFORE confirming/processing, or as part of it.
          // This logic might be better placed BEFORE updating status to 'completed' or 'failed'.
        },
        include: {
          wallet: true, // Include wallet to get updated balance if needed
          // Add other includes if necessary
        }
      });

      // 4. Handle wallet debit/reversal and final state updates
      if (status === 'completed') {
        // If payout is completed, the wallet should have been debited earlier.
        // Here, we might perform final checks or trigger external payment systems.
        // For now, we assume the debit happened or will happen based on status update.
        // A more robust flow would involve transactions and potentially two-phase commits or Sagas.
        console.log(`Payout ${payoutId} completed. Details: Provider=${payoutMethod.providerName}, Account=${payoutMethod.accountNumber}, Amount=${payout.amount}`);
        // In a real system, this is where you'd integrate with payment gateways.
      } else if (status === 'failed') {
        // If payout failed, we need to reverse the debit from the wallet.
        // This requires a transaction/saga to ensure atomicity.
        // For now, we'll just log the failure.
        console.error(`Payout ${payoutId} failed. Reason: ${failureReason}. User: ${user?.username}, PayoutMethod: ${payoutMethod.providerName} ${payoutMethod.accountNumber}`);
        // Re-credit wallet logic would go here if debit already happened.
      } else if (status === 'cancelled') {
        // If cancelled, also need to potentially reverse debit if it occurred.
        console.log(`Payout ${payoutId} was cancelled.`);
      }

      return updatedPayout;

    } catch (error: any) {
      console.error(`Error confirming payout ${payoutId}:`, error.message);
      // Log the error details, including inter-service communication errors.
      if (error.response) {
        console.error("Error response from external service:", error.response.data);
      }
      // Revert any partial changes if possible, or handle transaction rollback.
      throw new Error(`Failed to confirm payout ${payoutId}. ${error.message}`);
    }
  }
}
