import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default prediction export path
const PREDICTION_EXPORT_PATH = process.env.PREDICTION_EXPORT_PATH 
  || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.polymarket', 'predictions.json');

/**
 * Write prediction data to JSON file for external consumption (e.g., Python arbitrage bot)
 * @param {Object} data - Prediction data
 * @param {number} data.timestamp - Unix timestamp
 * @param {string} data.marketSlug - Polymarket market slug
 * @param {number} data.modelUp - Model probability for UP (0-1)
 * @param {number} data.modelDown - Model probability for DOWN (0-1)
 * @param {number} data.marketYes - Market price for YES (0-1)
 * @param {number} data.marketNo - Market price for NO (0-1)
 * @param {Object} data.edge - Edge calculation results
 * @param {Object} data.decision - Decision object from decide()
 * @param {Object} data.indicators - Technical indicators values
 * @returns {boolean} Success
 */
export function exportPrediction(data) {
  try {
    // Ensure directory exists
    const dir = path.dirname(PREDICTION_EXPORT_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Read existing predictions if file exists
    let allPredictions = [];
    if (fs.existsSync(PREDICTION_EXPORT_PATH)) {
      try {
        const content = fs.readFileSync(PREDICTION_EXPORT_PATH, 'utf8');
        allPredictions = JSON.parse(content);
        // Keep only last 100 predictions to avoid file growing indefinitely
        if (Array.isArray(allPredictions)) {
          allPredictions = allPredictions.slice(-99);
        } else {
          allPredictions = [];
        }
      } catch (err) {
        console.warn('[Export] Failed to read existing predictions file:', err.message);
        allPredictions = [];
      }
    }

    // Add new prediction
    allPredictions.push({
      ...data,
      exportedAt: new Date().toISOString(),
    });

    // Write updated predictions
    fs.writeFileSync(PREDICTION_EXPORT_PATH, JSON.stringify(allPredictions, null, 2), 'utf8');
    console.log(`[Export] Prediction written to ${PREDICTION_EXPORT_PATH}`);
    return true;
  } catch (error) {
    console.error('[Export] Failed to export prediction:', error.message);
    return false;
  }
}

/**
 * Get the latest prediction from file
 * @returns {Object|null} Latest prediction or null
 */
export function getLatestPrediction() {
  try {
    if (!fs.existsSync(PREDICTION_EXPORT_PATH)) {
      return null;
    }
    const content = fs.readFileSync(PREDICTION_EXPORT_PATH, 'utf8');
    const allPredictions = JSON.parse(content);
    if (Array.isArray(allPredictions) && allPredictions.length > 0) {
      return allPredictions[allPredictions.length - 1];
    }
    return null;
  } catch (error) {
    console.error('[Export] Failed to read latest prediction:', error.message);
    return null;
  }
}