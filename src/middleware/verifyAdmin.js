'use strict';

const { timingSafeEqual } = require('crypto');
const { sendError } = require('../utils/response');

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_API_KEY || ADMIN_API_KEY.length < 32) {
  throw new Error(
    'ADMIN_API_KEY must be set to at least 32 characters. ' +
    'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

const EXPECTED_BUF = Buffer.from(ADMIN_API_KEY);

/**
 * Middleware: only allows requests carrying the correct X-Admin-Key header.
 * Uses a timing-safe comparison to prevent timing-attack enumeration.
 */
function verifyAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];

  if (!key) {
    return sendError(res, 'Admin key required.', 401);
  }

  let isValid = false;
  try {
    const provided = Buffer.from(key);
    isValid =
      provided.length === EXPECTED_BUF.length &&
      timingSafeEqual(EXPECTED_BUF, provided);
  } catch {
    isValid = false;
  }

  if (!isValid) {
    return sendError(res, 'Invalid admin key.', 403);
  }

  next();
}

module.exports = verifyAdmin;
