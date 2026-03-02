'use strict';

const prisma = require('../lib/prisma');

const createGym = async (data) => {
  return prisma.gym.create({ data });
};

const getGymById = async (id) => {
  return prisma.gym.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      razorpay_key_id: true,
      razorpay_webhook_secret: true,
      whatsapp_phone_number_id: true,
      google_sheet_id: true,
      owner_phone: true,
      created_at: true,
      // razorpay_key_secret excluded (sensitive)
      // whatsapp_access_token excluded (sensitive)
    },
  });
};

module.exports = { createGym, getGymById };
