'use strict';

const { google } = require('googleapis');
const path = require('path');
const logger = require('../config/logger');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, '../config/googleServiceAccount.json');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const DEFAULT_RANGE = 'A1:Z1000';

async function getSheetRows(spreadsheetId) {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: SCOPES,
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Fetch sheet metadata to get the first sheet name
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const firstSheetTitle = meta.data.sheets[0].properties.title;

  const range = `${firstSheetTitle}!${DEFAULT_RANGE}`;
  logger.debug(`Fetching sheet range: ${spreadsheetId} / ${range}`);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return response.data.values || [];
}

module.exports = { getSheetRows };
