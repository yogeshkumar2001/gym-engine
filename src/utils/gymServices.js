'use strict';

/**
 * Default service configuration applied to all gyms.
 * Used as fallback when a gym has no services JSON (e.g. pre-migration rows).
 */
const DEFAULT_SERVICES = {
  payments:           true,
  invoice:            true,
  whatsapp_reminders: true,
  whatsapp_summary:   true,
  google_sheet_sync:  true,
  offers:             false,
};

const KNOWN_SERVICES = Object.keys(DEFAULT_SERVICES);

/**
 * Returns true if the given service is enabled for the gym.
 *
 * Falls back to DEFAULT_SERVICES when gym.services is null/undefined
 * (covers existing gyms created before the services column was added).
 *
 * @param {{ services: object|null }} gym
 * @param {string} serviceName
 * @returns {boolean}
 */
function gymHasService(gym, serviceName) {
  if (!gym.services) return DEFAULT_SERVICES[serviceName] ?? false;
  return gym.services[serviceName] === true;
}

module.exports = { gymHasService, DEFAULT_SERVICES, KNOWN_SERVICES };
