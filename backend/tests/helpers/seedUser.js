// tests/helpers/seedUser.js
import UserModel from '../../models/UserModel.js';

let counter = 0;

/** T-05: a unique e-mail from a process-wide counter plus random hex (Date.now() collides within one millisecond). */
export const uniqueEmail = (prefix = 'user') => {
  counter += 1;
  return `${prefix}${counter}_${Math.random().toString(16).slice(2, 10)}@test.com`;
};

/**
 * Create a user directly through the model (the pre-save hook hashes the password).
 * Roles are the Phase 3 enum values: 'CUSTOMER' | 'ANALYST' | 'ADMIN'.
 * @returns {Promise<{ user: import('mongoose').Document, password: string }>}
 */
export async function seedUser(overrides = {}) {
  counter += 1;
  const data = {
    name: 'Test User',
    email: uniqueEmail('user'),
    password: 'Password@123',
    role: 'CUSTOMER',
    ...overrides,
  };
  const user = await UserModel.create(data);
  return { user, password: data.password };
}

/** ADMIN can only be created directly — POST /auth/register rejects it (D-P8-03). */
export const seedAdmin = (overrides = {}) => seedUser({ role: 'ADMIN', ...overrides });
export const seedAnalyst = (overrides = {}) => seedUser({ role: 'ANALYST', ...overrides });
