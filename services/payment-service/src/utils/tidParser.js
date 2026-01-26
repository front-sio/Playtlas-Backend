/**
 * TID Parser - Extracts and normalizes Transaction IDs from mobile money SMS messages
 */

class TidParser {
  // Common TID patterns for different providers
  static TID_PATTERNS = {
    // AIRTEL: MP260119.1639.R71104
    AIRTEL: /TID\s*[:=]?\s*([A-Z]{2}\d{6}\.\d{4}\.R\d{5})/i,
    // VODACOM: Similar pattern variations
    VODACOM: /TID\s*[:=]?\s*([A-Z]{2}\d{6}\.\d{4}\.R\d{5})/i,
    // Generic fallback for any pattern with dots and alphanumeric
    GENERIC: /TID\s*[:=]?\s*([A-Z0-9]{2,}\.[A-Z0-9]{2,}\.[A-Z0-9]{2,})/i
  };

  // Amount patterns
  static AMOUNT_PATTERNS = {
    // Matches: Tsh 4,500.00, TSH 4500, 4,500.00
    AMOUNT: /(?:tsh|tzs)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/gi,
    // Specifically for fees: Makato Tsh 200.00
    FEE: /makato\s+(?:tsh|tzs)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/gi,
    // Balance: Salio
    BALANCE: /salio\s+(?:tsh|tzs)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/gi
  };

  // Phone number patterns
  static PHONE_PATTERNS = {
    TANZANIAN: /(\+255|255|0)[67]\d{8}/g
  };

  /**
   * Extract TID from raw SMS text
   * @param {string} rawText - The raw SMS message text
   * @returns {string|null} - Normalized TID or null if not found
   */
  static extractTid(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;

    // Clean the text - handle newlines, extra spaces
    const cleanText = rawText.replace(/\n|\r/g, ' ').replace(/\s+/g, ' ').trim();

    // Try different TID patterns in order of specificity
    const patterns = [
      this.TID_PATTERNS.AIRTEL,
      this.TID_PATTERNS.VODACOM,
      this.TID_PATTERNS.GENERIC
    ];

    for (const pattern of patterns) {
      const match = cleanText.match(pattern);
      if (match) {
        // Normalize: uppercase, trim spaces
        return match[1].toUpperCase().trim();
      }
    }

    return null;
  }

  /**
   * Extract amounts from SMS text
   * @param {string} rawText - The raw SMS message text
   * @returns {Object} - Object with amount, fee, balance properties
   */
  static extractAmounts(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return { amount: null, fee: null, balance: null };
    }

    const cleanText = rawText.toLowerCase();
    
    // Extract fee first (more specific)
    let fee = null;
    const feeMatch = cleanText.match(this.AMOUNT_PATTERNS.FEE);
    if (feeMatch) {
      fee = this.parseAmount(feeMatch[0]);
    }

    // Extract balance
    let balance = null;
    const balanceMatch = cleanText.match(this.AMOUNT_PATTERNS.BALANCE);
    if (balanceMatch) {
      balance = this.parseAmount(balanceMatch[0]);
    }

    // Extract main amount (find all amounts and pick the largest that's not fee/balance)
    let amount = null;
    const amountMatches = [...cleanText.matchAll(this.AMOUNT_PATTERNS.AMOUNT)];
    if (amountMatches.length > 0) {
      const amounts = amountMatches
        .map(match => this.parseAmount(match[1]))
        .filter(amt => amt && amt !== fee && amt !== balance)
        .sort((a, b) => b - a); // Sort descending
      
      amount = amounts[0] || null;
    }

    return { amount, fee, balance };
  }

  /**
   * Extract phone numbers from SMS text
   * @param {string} rawText - The raw SMS message text
   * @returns {string[]} - Array of found phone numbers
   */
  static extractPhoneNumbers(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];

    const phones = [];
    const matches = rawText.matchAll(this.PHONE_PATTERNS.TANZANIAN);
    
    for (const match of matches) {
      phones.push(this.normalizePhoneNumber(match[0]));
    }

    return [...new Set(phones)]; // Remove duplicates
  }

  /**
   * Determine transaction direction from SMS content
   * @param {string} rawText - The raw SMS message text
   * @returns {string|null} - 'IN' or 'OUT' or null
   */
  static extractDirection(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;

    const lowerText = rawText.toLowerCase();
    
    // Keywords that suggest incoming money
    const incomingKeywords = ['received', 'credited', 'deposited', 'sent to you', 'incoming'];
    // Keywords that suggest outgoing money
    const outgoingKeywords = ['sent', 'debited', 'withdrawn', 'paid', 'transferred', 'outgoing'];

    const hasIncoming = incomingKeywords.some(keyword => lowerText.includes(keyword));
    const hasOutgoing = outgoingKeywords.some(keyword => lowerText.includes(keyword));

    if (hasIncoming && !hasOutgoing) return 'IN';
    if (hasOutgoing && !hasIncoming) return 'OUT';
    
    return null; // Ambiguous or not detected
  }

  /**
   * Detect provider from SMS content
   * @param {string} rawText - The raw SMS message text
   * @returns {string} - Provider name (AIRTEL, VODACOM, etc.)
   */
  static detectProvider(rawText) {
    if (!rawText || typeof rawText !== 'string') return 'UNKNOWN';

    const lowerText = rawText.toLowerCase();
    
    if (lowerText.includes('airtel') || lowerText.includes('airtel money')) {
      return 'AIRTEL';
    }
    if (lowerText.includes('vodacom') || lowerText.includes('m-pesa')) {
      return 'VODACOM';
    }
    if (lowerText.includes('tigo') || lowerText.includes('tigopesa')) {
      return 'TIGO';
    }
    if (lowerText.includes('halotel') || lowerText.includes('halopesa')) {
      return 'HALOTEL';
    }

    return 'UNKNOWN';
  }

  /**
   * Parse SMS message and extract all relevant information
   * @param {string} rawText - The raw SMS message text
   * @returns {Object} - Parsed message data
   */
  static parseMessage(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      throw new Error('Invalid SMS text provided');
    }

    const tid = this.extractTid(rawText);
    if (!tid) {
      throw new Error('No valid TID found in SMS message');
    }

    const { amount, fee, balance } = this.extractAmounts(rawText);
    const phoneNumbers = this.extractPhoneNumbers(rawText);
    const direction = this.extractDirection(rawText);
    const provider = this.detectProvider(rawText);

    return {
      tid,
      provider,
      amount,
      fee,
      balance,
      phoneNumbers,
      direction,
      msisdn: phoneNumbers[0] || null, // Primary phone number
      rawText: rawText.trim()
    };
  }

  /**
   * Normalize phone number to standard format
   * @param {string} phone - Raw phone number
   * @returns {string} - Normalized phone number
   */
  static normalizePhoneNumber(phone) {
    if (!phone) return null;
    
    // Remove all non-digit characters
    const cleaned = phone.replace(/\D/g, '');
    
    // Handle different formats
    if (cleaned.startsWith('255')) {
      return `+${cleaned}`;
    }
    if (cleaned.startsWith('0') && cleaned.length === 10) {
      return `+255${cleaned.substring(1)}`;
    }
    if (cleaned.length === 9) {
      return `+255${cleaned}`;
    }
    
    return phone; // Return original if can't normalize
  }

  /**
   * Parse amount string to number
   * @param {string} amountStr - Amount string (e.g., "4,500.00")
   * @returns {number|null} - Parsed amount or null
   */
  static parseAmount(amountStr) {
    if (!amountStr || typeof amountStr !== 'string') return null;
    
    // Remove currency symbols and normalize
    const cleaned = amountStr
      .replace(/[^\d.,]/g, '') // Keep only digits, commas, dots
      .replace(/,/g, ''); // Remove commas
    
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Validate TID format
   * @param {string} tid - Transaction ID to validate
   * @returns {boolean} - True if valid format
   */
  static isValidTid(tid) {
    if (!tid || typeof tid !== 'string') return false;
    
    // Basic validation: should have dots and alphanumeric characters
    const pattern = /^[A-Z0-9]+\.[A-Z0-9]+\.[A-Z0-9]+$/i;
    return pattern.test(tid.trim());
  }
}

module.exports = TidParser;