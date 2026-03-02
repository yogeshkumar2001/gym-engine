'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');

// A dummy hash used during login to perform a constant-time compare even
// when the email doesn't exist — prevents user enumeration via timing.
const DUMMY_HASH = '$2a$12$invalidhashfortimingsafetycheckxxxxxxxxxxxxxxxxxxxxxxxxxxx';

async function registerGym({ gym_name, owner_name, email, phone, password }) {
  const passwordHash = await bcrypt.hash(password, 12);
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
      },
    });

    const owner = await tx.gymOwner.create({
      data: {
        gym_id: gym.id,
        name: owner_name,
        email: email.toLowerCase(),
        phone,
        password: passwordHash,
      },
    });

    return { gym_id: gym.id, onboarding_token };
  });

  return result;
}

async function loginGymOwner({ email, password }) {
  const owner = await prisma.gymOwner.findUnique({
    where: { email: email.toLowerCase() },
  });

  // Always run bcrypt compare — timing-safe regardless of whether owner exists
  const hashToCompare = owner ? owner.password : DUMMY_HASH;
  const isValid = await bcrypt.compare(password, hashToCompare);

  if (!owner || !isValid) {
    const err = new Error('Invalid email or password.');
    err.status = 401;
    throw err;
  }

  const token = jwt.sign(
    { owner_id: owner.id, gym_id: owner.gym_id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return { token, gym_id: owner.gym_id };
}

module.exports = { registerGym, loginGymOwner };
