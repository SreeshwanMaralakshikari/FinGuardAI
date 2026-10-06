// tests/helpers/seedUser.js
import UserModel from '../../models/UserModel.js';

let counter = 0;

/**
 * Create a user directly through the model (the pre-save hook hashes the password).
 * Roles are the Phase 3 enum values: 'CUSTOMER' | 'ANALYST' | 'ADMIN'.
 * @returns {Promise<{ user: import('mongoose').Document, password: string }>}
 */
export async function seedUser(overrides = {}) {
  counter += 1;
  const data = {
    name: 'Test User',
    email: `user${counter}_${Date.now()}@test.com`,
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
