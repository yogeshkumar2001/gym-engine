'use strict';

const jwt = require('jsonwebtoken');
const { sendError } = require('../utils/response');

function verifyJWT(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return sendError(res, 'No token provided.', 401);
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'gym-renewal-engine',
      audience: 'owner-dashboard',
    });
    req.gymOwner = { owner_id: payload.owner_id, gym_id: payload.gym_id };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return sendError(res, 'Token expired.', 401);
    }
    return sendError(res, 'Invalid token.', 401);
  }
}

module.exports = verifyJWT;
