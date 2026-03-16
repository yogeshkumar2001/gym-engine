'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');

// A dummy hash used during login to perform a constant-time compare even
// when the phone doesn't exist — prevents user enumeration via timing.
const DUMMY_HASH = '$2a$12$invalidhashfortimingsafetycheckxxxxxxxxxxxxxxxxxxxxxxxxxxx';

async function registerGym({ gym_name, owner_name, phone, pin }) {
  const passwordHash = await bcrypt.hash(pin, 12);
  const onboarding_token = uuidv4();

  const result = await prisma.$transaction(async (tx) => {
    const gym = await tx.gym.create({
      data: {
        name: gym_name,
        status: 'onboarding',
        onboarding_token,
        owner_phone: phone,
        // Credential placeholders — NOT NULL columns satisfied
        razorpay_key_id: 'PENDING',
        razorpay_key_secret: 'PENDING',
        razorpay_webhook_secret: 'PENDING',
        whatsapp_phone_number_id: 'PENDING',
        whatsapp_access_token: 'PENDING',
        google_sheet_id: 'PENDING',
        services: {
          payments:           true,
          invoice:            true,
          whatsapp_reminders: true,
          whatsapp_summary:   true,
          google_sheet_sync:  true,
          offers:             false,
        },
      },
    });

    const owner = await tx.gymOwner.create({
      data: {
        gym_id: gym.id,
        name: owner_name,
        phone,
        password: passwordHash,
      },
    });

    // Create junction entry for multi-gym support
    await tx.gymOwnerGym.create({
      data: { owner_id: owner.id, gym_id: gym.id, role: 'owner' },
    });

    return { gym_id: gym.id, owner_id: owner.id, onboarding_token };
  });

  const gym_ids = [result.gym_id];
  const token = jwt.sign(
    { owner_id: result.owner_id, gym_id: result.gym_id, gym_ids },
    process.env.JWT_SECRET,
    { expiresIn: '7d', issuer: 'gym-renewal-engine', audience: 'owner-dashboard' }
  );

  return { token, gym_id: result.gym_id, gym_ids, onboarding_token: result.onboarding_token };
}

async function loginGymOwner({ phone, pin }) {
  const owner = await prisma.gymOwner.findUnique({
    where: { phone },
  });

  // Always run bcrypt compare — timing-safe regardless of whether owner exists
  const hashToCompare = owner ? owner.password : DUMMY_HASH;
  const isValid = await bcrypt.compare(pin, hashToCompare);

  if (!owner || !isValid) {
    const err = new Error('Invalid phone or PIN.');
    err.status = 401;
    throw err;
  }

  // Load all gym IDs this owner can access via junction table
  const gymAccess = await prisma.gymOwnerGym.findMany({
    where: { owner_id: owner.id },
    select: { gym_id: true },
    orderBy: { created_at: 'asc' },
  });

  // Fall back to primary gym_id if no junction entries exist (legacy accounts)
  const gym_ids = gymAccess.length > 0
    ? gymAccess.map((g) => g.gym_id)
    : [owner.gym_id];

  const token = jwt.sign(
    { owner_id: owner.id, gym_id: gym_ids[0], gym_ids },
    process.env.JWT_SECRET,
    { expiresIn: '7d', issuer: 'gym-renewal-engine', audience: 'owner-dashboard' }
  );

  return { token, gym_id: gym_ids[0], gym_ids };
}

module.exports = { registerGym, loginGymOwner };
