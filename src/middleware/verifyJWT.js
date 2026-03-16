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

    // gym_ids: list of all gyms this owner can access (multi-gym support).
    // Falls back to single gym_id for tokens issued before multi-gym was added.
    const gymIds = Array.isArray(payload.gym_ids) && payload.gym_ids.length > 0
      ? payload.gym_ids
      : [payload.gym_id];

    // Resolve the active gym from the X-Gym-Id header. If the requested gym is
    // not in the owner's access list, default to their first gym.
    const requestedGymId = parseInt(req.headers['x-gym-id'], 10);
    const gymId = !isNaN(requestedGymId) && gymIds.includes(requestedGymId)
      ? requestedGymId
      : gymIds[0];

    req.gymOwner = { owner_id: payload.owner_id, gym_id: gymId, gym_ids: gymIds };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return sendError(res, 'Token expired.', 401);
    }
    return sendError(res, 'Invalid token.', 401);
  }
}

module.exports = verifyJWT;
