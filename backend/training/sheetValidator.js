'use strict';

/**
 * sheetValidator.js
 *
 * Canonical event sheet schema for the training corpus.
 * Accepts CSV or JSON uploads; emits a normalised array of events that matches
 * the shape produced by scanner.js / apkscanner.js recommendedEvents.
 *
 * CSV format (header row required):
 *   event_name,category,priority,trigger_description,properties,reason
 *
 *   - properties may be pipe-separated:  product_id|price|category
 *
 * JSON format:
 *   [
 *     {
 *       "eventName":           "Product Viewed",
 *       "category":            "Retention",
 *       "priority":            "must-have",
 *       "triggerDescription":  "User opens a product detail page",
 *       "suggestedProperties": ["product_id", "price", "category"],
 *       "reason":              "Core funnel signal for ecommerce"
 *     }
 *   ]
 *
 * Both forms produce the same internal shape:
 *   { eventName, category, priority, triggerDescription, suggestedProperties, reason }
 */

const { parse: parseCsvSync } = require('csv-parse/sync');

const CATEGORIES = ['Acquisition', 'Activation', 'Retention', 'Revenue', 'Referral'];
const PRIORITIES = ['must-have', 'recommended', 'nice-to-have'];

// Accept common header aliases so trainers don't have to memorise exact names.
const COLUMN_ALIASES = {
  eventName:           ['event_name', 'eventname', 'event', 'name'],
  category:            ['category', 'stage', 'lifecycle', 'lifecycle_stage'],
  priority:            ['priority', 'importance'],
  triggerDescription:  ['trigger_description', 'trigger', 'description', 'when', 'fires_when'],
  suggestedProperties: ['properties', 'suggested_properties', 'props', 'event_properties'],
  reason:              ['reason', 'why', 'rationale', 'notes'],
};

function normaliseKey(k) {
  return String(k || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')   // splits camelCase: triggerDescription → trigger_Description
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function resolveColumn(row, targetField) {
  const aliases = COLUMN_ALIASES[targetField];
  const rowKeys = Object.keys(row);
  for (const alias of aliases) {
    const hit = rowKeys.find((k) => normaliseKey(k) === alias);
    if (hit !== undefined) return row[hit];
  }
  return undefined;
}

function splitProperties(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(/[|,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normaliseCategory(value) {
  const v = String(value || '').trim();
  const hit = CATEGORIES.find((c) => c.toLowerCase() === v.toLowerCase());
  return hit || null;
}

function normalisePriority(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'must have' || v === 'must-have' || v === 'musthave' || v === 'critical') return 'must-have';
  if (v === 'recommended' || v === 'should-have' || v === 'important') return 'recommended';
  if (v === 'nice-to-have' || v === 'nice to have' || v === 'optional' || v === 'low') return 'nice-to-have';
  return null;
}

function validateRow(rawRow, index) {
  const errors = [];

  const eventName = String(resolveColumn(rawRow, 'eventName') ?? '').trim();
  if (!eventName) errors.push(`Row ${index + 1}: event_name is required`);

  const categoryRaw = resolveColumn(rawRow, 'category');
  const category = normaliseCategory(categoryRaw);
  if (!category) {
    errors.push(
      `Row ${index + 1}: category "${categoryRaw}" is not one of ${CATEGORIES.join(', ')}`
    );
  }

  const priorityRaw = resolveColumn(rawRow, 'priority');
  const priority = normalisePriority(priorityRaw);
  if (!priority) {
    errors.push(
      `Row ${index + 1}: priority "${priorityRaw}" is not one of ${PRIORITIES.join(', ')}`
    );
  }

  const triggerDescription = String(resolveColumn(rawRow, 'triggerDescription') ?? '').trim();
  if (!triggerDescription) errors.push(`Row ${index + 1}: trigger_description is required`);

  const suggestedProperties = splitProperties(resolveColumn(rawRow, 'suggestedProperties'));
  const reason = String(resolveColumn(rawRow, 'reason') ?? '').trim();

  if (errors.length) return { errors };

  return {
    event: {
      eventName,
      category,
      priority,
      triggerDescription,
      suggestedProperties,
      reason,
    },
    errors: [],
  };
}

function parseSheet({ buffer, originalname }) {
  const lowerName = String(originalname || '').toLowerCase();
  let rows;

  if (lowerName.endsWith('.json')) {
    try {
      const parsed = JSON.parse(buffer.toString('utf8'));
      if (!Array.isArray(parsed)) {
        throw new Error('JSON event sheet must be an array of event objects');
      }
      rows = parsed;
    } catch (err) {
      throw new Error(`Invalid JSON event sheet: ${err.message}`);
    }
  } else if (lowerName.endsWith('.csv') || lowerName.endsWith('.tsv') || lowerName.endsWith('.txt')) {
    try {
      rows = parseCsvSync(buffer, {
        columns: true,
        skip_empty_lines: true,
        skip_records_with_error: true,   // bad rows go to warnings, not a hard failure
        trim: true,
        bom: true,
        relax_column_count: true,        // tolerate rows with extra fields (commonly: an
                                         // unquoted comma in trigger_description). Extra
                                         // columns are dropped silently; short rows get
                                         // undefined cells which the per-row validator
                                         // then flags individually.
        relax_quotes: true,              // tolerate unbalanced/extra double quotes
        delimiter: lowerName.endsWith('.tsv') ? '\t' : [',', ';', '\t'],
      });
    } catch (err) {
      // csv-parse error objects include `lines` when the failure is row-scoped.
      const where = err.lines ? ` (around line ${err.lines})` : '';
      throw new Error(
        `Invalid CSV event sheet${where}: ${err.message}. ` +
        `Tip: cells that contain commas, quotes, or newlines must be wrapped in double quotes (e.g. "User taps Cart, then Checkout"). ` +
        `Multiple properties should be pipe-separated (product_id|price|category).`
      );
    }
  } else {
    throw new Error(
      `Unsupported event sheet format: "${originalname}". Use .csv, .json, .tsv, or .txt.`
    );
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Event sheet is empty.');
  }

  const events = [];
  const errors = [];
  rows.forEach((row, i) => {
    const { event, errors: rowErrors } = validateRow(row, i);
    if (rowErrors.length) {
      errors.push(...rowErrors);
    } else {
      events.push(event);
    }
  });

  if (events.length === 0) {
    throw new Error(`No valid events found in sheet. ${errors.slice(0, 3).join('; ')}`);
  }

  return { events, errors };
}

module.exports = {
  CATEGORIES,
  PRIORITIES,
  parseSheet,
};
