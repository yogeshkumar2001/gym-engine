'use strict';

const { google } = require('googleapis');
const path = require('path');
const logger = require('../config/logger');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, '../config/googleServiceAccount.json');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

// Legacy cap that previously silently truncated large sheets — kept only for warning logic.
const LEGACY_ROW_CAP = 1000;

async function getSheetRows(spreadsheetId) {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: SCOPES,
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Fetch sheet metadata: first sheet name + actual row count.
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetProps = meta.data.sheets[0].properties;
  const firstSheetTitle = sheetProps.title;
  const totalRows = sheetProps.gridProperties?.rowCount ?? LEGACY_ROW_CAP;

  // Warn once if this sheet previously would have been silently truncated.
  if (totalRows > LEGACY_ROW_CAP) {
    logger.warn(
      `[getSheetRows] Sheet "${spreadsheetId}" has ${totalRows} rows — ` +
      `previously silently truncated at ${LEGACY_ROW_CAP}. Full sheet will now be fetched.`
    );
  }

  // Use the actual sheet row count to build an unbounded-in-practice range.
  const range = `${firstSheetTitle}!A1:Z${totalRows}`;
  logger.debug(`Fetching sheet range: ${spreadsheetId} / ${range}`);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return response.data.values || [];
}

module.exports = { getSheetRows };
