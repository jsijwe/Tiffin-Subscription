// ---------------------------------------------------------------------
// Small, dependency-free validation helpers.
//
// Kept deliberately simple (no zod/joi) so the whole validation surface
// is readable in one file, but centralized so every route reports errors
// the same way instead of ad-hoc `if` checks scattered through customers.js.
// ---------------------------------------------------------------------

const PHONE_RE = /^[0-9+][0-9\-\s]{6,14}$/; // allows leading + and separators, 7-15 digits worth
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateCustomerInput({ name, phone, planPrice }) {
  const errors = [];
  if (!isNonEmptyString(name)) errors.push('name is required');
  else if (name.trim().length > 100) errors.push('name must be under 100 characters');

  if (!isNonEmptyString(phone)) errors.push('phone is required');
  else if (!PHONE_RE.test(phone.trim())) errors.push('phone must be a valid phone number (7-15 digits)');

  const price = Number(planPrice);
  if (planPrice === undefined || planPrice === null || planPrice === '') errors.push('planPrice is required');
  else if (Number.isNaN(price) || price <= 0) errors.push('planPrice must be a positive number');
  else if (price > 1_000_000) errors.push('planPrice looks unreasonably large');

  return { valid: errors.length === 0, errors };
}

function validateDateInput(value, field) {
  if (value === undefined || value === null || value === '') return { valid: true }; // optional, defaults handled by caller
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    return { valid: false, errors: [`${field} must be a date in YYYY-MM-DD format`] };
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { valid: false, errors: [`${field} is not a valid calendar date`] };
  return { valid: true };
}

function validateBillQuery({ year, month }) {
  const errors = [];
  if (year !== undefined && (Number.isNaN(Number(year)) || Number(year) < 2000 || Number(year) > 2100)) {
    errors.push('year must be a 4-digit year between 2000 and 2100');
  }
  if (month !== undefined && (Number.isNaN(Number(month)) || Number(month) < 1 || Number(month) > 12)) {
    errors.push('month must be between 1 and 12');
  }
  return { valid: errors.length === 0, errors };
}

function validateAuthInput({ email, password }) {
  const errors = [];
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!isNonEmptyString(email) || !emailRe.test(email.trim())) errors.push('a valid email is required');
  if (!isNonEmptyString(password) || password.length < 6) errors.push('password must be at least 6 characters');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateCustomerInput,
  validateDateInput,
  validateBillQuery,
  validateAuthInput,
};
