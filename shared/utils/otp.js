// OTP generation and expiry helpers.

/**
 * Generate a numeric OTP string of given length.
 */
function generateOtp(length) {
  const size = length || 6;
  const digits = '0123456789';
  let code = '';
  for (let i = 0; i < size; i++) {
    code += digits[Math.floor(Math.random() * digits.length)];
  }
  return code;
}

/**
 * Get a Date object representing expiry time in N minutes from now.
 */
function getOtpExpiry(minutes) {
  const expiresInMinutes = minutes || 10;
  const now = new Date();
  now.setMinutes(now.getMinutes() + expiresInMinutes);
  return now;
}

/**
 * Check if an OTP has expired given its expiry Date.
 */
function isOtpExpired(expiresAt) {
  return new Date() > expiresAt;
}

module.exports = {
  generateOtp,
  getOtpExpiry,
  isOtpExpired
};