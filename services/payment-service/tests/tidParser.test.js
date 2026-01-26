const TidParser = require('../src/utils/tidParser');

describe('TidParser', () => {
  describe('extractTid', () => {
    test('should extract TID from Airtel SMS', () => {
      const sms = `TID:MP260119.1639.R71104 Confirmed. On 26/01/19 at 4:39 PM Tsh 4,500.00 sent to +255754123456. New balance is Tsh 15,200.00. Transaction cost: Makato Tsh 200.00.`;
      expect(TidParser.extractTid(sms)).toBe('MP260119.1639.R71104');
    });

    test('should extract TID with spaces around colon', () => {
      const sms = `TID : MP260119.1639.R71104 Confirmed. Transaction successful.`;
      expect(TidParser.extractTid(sms)).toBe('MP260119.1639.R71104');
    });

    test('should extract TID with newlines', () => {
      const sms = `SMS Confirmation
      TID:MP260119.1639.R71104
      Amount: 4500.00`;
      expect(TidParser.extractTid(sms)).toBe('MP260119.1639.R71104');
    });

    test('should handle case insensitive TID', () => {
      const sms = `tid:mp260119.1639.r71104 confirmed`;
      expect(TidParser.extractTid(sms)).toBe('MP260119.1639.R71104');
    });

    test('should return null for invalid SMS', () => {
      expect(TidParser.extractTid('')).toBe(null);
      expect(TidParser.extractTid('No TID here')).toBe(null);
      expect(TidParser.extractTid(null)).toBe(null);
    });
  });

  describe('extractAmounts', () => {
    test('should extract amount, fee and balance from Airtel SMS', () => {
      const sms = `TID:MP260119.1639.R71104 Confirmed. Tsh 4,500.00 sent to +255754123456. New balance is Tsh 15,200.00. Transaction cost: Makato Tsh 200.00.`;
      const result = TidParser.extractAmounts(sms);
      
      expect(result.amount).toBe(4500);
      expect(result.fee).toBe(200);
      expect(result.balance).toBe(15200);
    });

    test('should handle different currency formats', () => {
      const sms = `Amount: TSH 2500, Fee: 50.00, Balance: TZS 10,000.50`;
      const result = TidParser.extractAmounts(sms);
      
      expect(result.amount).toBe(2500);
      expect(result.fee).toBe(50);
      expect(result.balance).toBe(10000.5);
    });

    test('should handle amounts without commas', () => {
      const sms = `Amount: 1500 Fee: 75 Balance: 8000`;
      const result = TidParser.extractAmounts(sms);
      
      expect(result.amount).toBe(1500);
      expect(result.fee).toBe(75);
      expect(result.balance).toBe(8000);
    });

    test('should return null for missing amounts', () => {
      const result = TidParser.extractAmounts('No amounts here');
      
      expect(result.amount).toBe(null);
      expect(result.fee).toBe(null);
      expect(result.balance).toBe(null);
    });
  });

  describe('extractPhoneNumbers', () => {
    test('should extract Tanzanian phone numbers', () => {
      const sms = `Sent to +255754123456 from 0754987654`;
      const result = TidParser.extractPhoneNumbers(sms);
      
      expect(result).toContain('+255754123456');
      expect(result).toContain('+255754987654');
    });

    test('should normalize phone numbers', () => {
      const sms = `Numbers: 0754123456, 255754987654, +255754111222`;
      const result = TidParser.extractPhoneNumbers(sms);
      
      expect(result).toContain('+255754123456');
      expect(result).toContain('+255754987654');
      expect(result).toContain('+255754111222');
    });

    test('should remove duplicates', () => {
      const sms = `Same number: +255754123456 and 0754123456`;
      const result = TidParser.extractPhoneNumbers(sms);
      
      expect(result.length).toBe(1);
      expect(result[0]).toBe('+255754123456');
    });
  });

  describe('extractDirection', () => {
    test('should detect incoming transaction', () => {
      const sms = `You have received Tsh 1000 from John`;
      expect(TidParser.extractDirection(sms)).toBe('IN');
    });

    test('should detect outgoing transaction', () => {
      const sms = `You have sent Tsh 1000 to Mary`;
      expect(TidParser.extractDirection(sms)).toBe('OUT');
    });

    test('should return null for ambiguous direction', () => {
      const sms = `Transaction completed successfully`;
      expect(TidParser.extractDirection(sms)).toBe(null);
    });
  });

  describe('detectProvider', () => {
    test('should detect Airtel', () => {
      expect(TidParser.detectProvider('Airtel Money transaction')).toBe('AIRTEL');
      expect(TidParser.detectProvider('AIRTEL confirmation')).toBe('AIRTEL');
    });

    test('should detect Vodacom', () => {
      expect(TidParser.detectProvider('M-Pesa transaction')).toBe('VODACOM');
      expect(TidParser.detectProvider('Vodacom payment')).toBe('VODACOM');
    });

    test('should detect Tigo', () => {
      expect(TidParser.detectProvider('TigoPesa sent')).toBe('TIGO');
      expect(TidParser.detectProvider('TIGO transfer')).toBe('TIGO');
    });

    test('should return UNKNOWN for unrecognized', () => {
      expect(TidParser.detectProvider('Unknown provider')).toBe('UNKNOWN');
    });
  });

  describe('parseMessage', () => {
    test('should parse complete Airtel SMS', () => {
      const sms = `TID:MP260119.1639.R71104 Confirmed. On 26/01/19 at 4:39 PM Tsh 4,500.00 sent to +255754123456. New balance is Tsh 15,200.00. Transaction cost: Makato Tsh 200.00.`;
      
      const result = TidParser.parseMessage(sms);
      
      expect(result.tid).toBe('MP260119.1639.R71104');
      expect(result.provider).toBe('UNKNOWN'); // No explicit provider mentioned
      expect(result.amount).toBe(4500);
      expect(result.fee).toBe(200);
      expect(result.balance).toBe(15200);
      expect(result.phoneNumbers).toContain('+255754123456');
      expect(result.direction).toBe('OUT');
      expect(result.rawText).toBe(sms);
    });

    test('should throw error for SMS without TID', () => {
      expect(() => {
        TidParser.parseMessage('No TID in this message');
      }).toThrow('No valid TID found in SMS message');
    });

    test('should throw error for invalid input', () => {
      expect(() => {
        TidParser.parseMessage(null);
      }).toThrow('Invalid SMS text provided');

      expect(() => {
        TidParser.parseMessage('');
      }).toThrow('Invalid SMS text provided');
    });
  });

  describe('isValidTid', () => {
    test('should validate correct TID format', () => {
      expect(TidParser.isValidTid('MP260119.1639.R71104')).toBe(true);
      expect(TidParser.isValidTid('AB123456.7890.C12345')).toBe(true);
    });

    test('should reject invalid TID format', () => {
      expect(TidParser.isValidTid('invalid-tid')).toBe(false);
      expect(TidParser.isValidTid('MP260119')).toBe(false);
      expect(TidParser.isValidTid('')).toBe(false);
      expect(TidParser.isValidTid(null)).toBe(false);
    });
  });

  describe('parseAmount', () => {
    test('should parse amounts with commas', () => {
      expect(TidParser.parseAmount('4,500.00')).toBe(4500);
      expect(TidParser.parseAmount('TSH 1,000,000.50')).toBe(1000000.5);
    });

    test('should parse simple amounts', () => {
      expect(TidParser.parseAmount('1500')).toBe(1500);
      expect(TidParser.parseAmount('75.50')).toBe(75.5);
    });

    test('should return null for invalid amounts', () => {
      expect(TidParser.parseAmount('invalid')).toBe(null);
      expect(TidParser.parseAmount('')).toBe(null);
      expect(TidParser.parseAmount(null)).toBe(null);
    });
  });

  describe('normalizePhoneNumber', () => {
    test('should normalize various phone formats', () => {
      expect(TidParser.normalizePhoneNumber('0754123456')).toBe('+255754123456');
      expect(TidParser.normalizePhoneNumber('255754123456')).toBe('+255754123456');
      expect(TidParser.normalizePhoneNumber('+255754123456')).toBe('+255754123456');
      expect(TidParser.normalizePhoneNumber('754123456')).toBe('+255754123456');
    });

    test('should handle edge cases', () => {
      expect(TidParser.normalizePhoneNumber('')).toBe(null);
      expect(TidParser.normalizePhoneNumber(null)).toBe(null);
      expect(TidParser.normalizePhoneNumber('invalid')).toBe('invalid');
    });
  });
});