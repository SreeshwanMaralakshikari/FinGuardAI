// tests/uploads.test.js — PATCH /customer-api/profile with a MOCKED Cloudinary (N-09).
// config/cloudinary.js is replaced before the app is imported (jest ESM:
// jest.unstable_mockModule + dynamic import), so no network is touched.
import { beforeAll, afterAll, beforeEach, describe, it, expect, jest } from '@jest/globals';
import supertest from 'supertest';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser } from './helpers/seedUser.js';
import UserModel from '../models/UserModel.js';
import AuditLogModel from '../models/AuditLogModel.js';

let imageCounter = 0;
const mockCloudinary = {
  uploader: {
    upload_stream: jest.fn(),
    destroy: jest.fn(),
  },
};
const urlFor = (n) => `https://res.cloudinary.com/demo/image/upload/v17000000${n}/finguardai/profiles/img${n}.png`;
const publicIdFor = (n) => `finguardai/profiles/img${n}`;

jest.unstable_mockModule('../config/cloudinary.js', () => ({ default: mockCloudinary }));
const { default: app } = await import('../app.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(200, 3)]);

let ipCounter = 0;
async function customerAgent() {
  ipCounter += 1;
  const { user, password } = await seedUser({ email: `up${Date.now()}_${ipCounter}@test.com` });
  const agent = supertest.agent(app).set('X-Forwarded-For', `198.18.0.${ipCounter}`);
  const login = await agent.post('/auth/login').send({ email: user.email, password });
  expect(login.status).toBe(200);
  return { user, agent };
}

const upload = (agent, buffer, { filename = 'me.png', contentType = 'image/png', name } = {}) => {
  let req = agent.patch('/customer-api/profile');
  if (name !== undefined) req = req.field('name', name);
  return req.attach('profileImage', buffer, { filename, contentType });
};

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => {
  await clearCollections();
  imageCounter = 0;
  mockCloudinary.uploader.upload_stream.mockReset().mockImplementation((options, callback) => ({
    end: () => {
      imageCounter += 1;
      callback(null, { secure_url: urlFor(imageCounter), public_id: publicIdFor(imageCounter) });
    },
  }));
  mockCloudinary.uploader.destroy.mockReset().mockResolvedValue({ result: 'ok' });
});

describe('profile image upload', () => {
  it('accepts real JPEG, PNG and WebP content and stores the Cloudinary URL', async () => {
    const { user, agent } = await customerAgent();
    for (const [buffer, filename, contentType] of [[PNG, 'a.png', 'image/png'], [JPEG, 'a.jpg', 'image/jpeg'], [WEBP, 'a.webp', 'image/webp']]) {
      const res = await upload(agent, buffer, { filename, contentType });
      expect(res.status).toBe(200);
      expect(res.body.data.profileImage).toBe(urlFor(imageCounter));
    }
    expect((await UserModel.findById(user._id)).profileImage).toBe(urlFor(3));
    expect(mockCloudinary.uploader.upload_stream).toHaveBeenCalledWith(expect.objectContaining({ folder: 'finguardai/profiles', resource_type: 'image' }), expect.any(Function));
    const profile = await agent.get('/customer-api/profile');
    expect(profile.status).toBe(200);
    expect(profile.body.data).not.toHaveProperty('password');
  });

  it('rejects a text file that merely CLAIMS to be an image (wrong magic bytes) — nothing reaches Cloudinary', async () => {
    const { user, agent } = await customerAgent();
    const res = await upload(agent, Buffer.from('this is just text, renamed to fake.png, sent as image/png'), { filename: 'fake.png' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Only JPG, PNG or WebP images are allowed.' });
    expect(mockCloudinary.uploader.upload_stream).not.toHaveBeenCalled();
    expect((await UserModel.findById(user._id)).profileImage).toBe('');
    // also: GIF content under an allowed MIME type, and an HTML payload
    expect((await upload(agent, Buffer.from('GIF89a' + 'x'.repeat(50)), { filename: 'a.png' })).status).toBe(400);
    expect((await upload(agent, Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'a.png' })).status).toBe(400);
    expect(mockCloudinary.uploader.upload_stream).not.toHaveBeenCalled();
  });

  it('still rejects a disallowed MIME type and an oversized file with 400', async () => {
    const { agent } = await customerAgent();
    const wrongType = await upload(agent, PNG, { filename: 'a.txt', contentType: 'text/plain' });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.message).toBe('Only JPG, PNG or WebP images are allowed.');
    const big = await upload(agent, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
    expect(big.status).toBe(400);
    expect(big.body.message).toBe('File is too large (max 2 MB).');
    expect(mockCloudinary.uploader.upload_stream).not.toHaveBeenCalled();
  });

  it('a Cloudinary failure is a 502 with a safe message (no SDK text, no 500) and changes nothing', async () => {
    const { user, agent } = await customerAgent();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockCloudinary.uploader.upload_stream.mockImplementation((options, callback) => ({
      end: () => callback({ message: 'Invalid api_key secret-key-123', http_code: 401 }),
    }));
    const res = await upload(agent, PNG, { name: 'Renamed User' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ success: false, message: 'Image upload failed. Please try again.' });
    expect(JSON.stringify(res.body)).not.toMatch(/secret-key/);
    const stored = await UserModel.findById(user._id);
    expect(stored.profileImage).toBe('');
    expect(stored.name).toBe('Test User'); // the rename was not applied either: the request failed as a whole
    expect(err.mock.calls.flat().join(' ')).toMatch(/Cloudinary upload failed/);
    err.mockRestore();
  });

  it('replacing the image deletes the previous one (public_id derived from its URL)', async () => {
    const { agent } = await customerAgent();
    await upload(agent, PNG);
    expect(mockCloudinary.uploader.destroy).not.toHaveBeenCalled(); // nothing to delete the first time
    const second = await upload(agent, JPEG, { filename: 'b.jpg', contentType: 'image/jpeg' });
    expect(second.status).toBe(200);
    expect(second.body.data.profileImage).toBe(urlFor(2));
    expect(mockCloudinary.uploader.destroy).toHaveBeenCalledTimes(1);
    expect(mockCloudinary.uploader.destroy).toHaveBeenCalledWith(publicIdFor(1), expect.objectContaining({ resource_type: 'image' }));
  });

  it('a failing delete of the old image never fails the request', async () => {
    const { user, agent } = await customerAgent();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await upload(agent, PNG);
    mockCloudinary.uploader.destroy.mockRejectedValue(new Error('cloudinary down'));
    const res = await upload(agent, PNG);
    expect(res.status).toBe(200);
    expect((await UserModel.findById(user._id)).profileImage).toBe(urlFor(2));
    expect(err.mock.calls.flat().join(' ')).toMatch(/Could not delete old image/);
    err.mockRestore();
  });

  it('only OUR uploads are ever deleted (foreign / empty URLs are ignored)', async () => {
    const { user, agent } = await customerAgent();
    await UserModel.updateOne({ _id: user._id }, { profileImage: 'https://example.com/avatar.png' });
    expect((await upload(agent, PNG)).status).toBe(200);
    expect(mockCloudinary.uploader.destroy).not.toHaveBeenCalled();
  });

  it('if saving the profile fails after the upload, the new image is removed again (no orphan)', async () => {
    const { user, agent } = await customerAgent();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spy = jest.spyOn(UserModel, 'findByIdAndUpdate')
      .mockImplementationOnce(() => ({ select: () => Promise.reject(new Error('db write failed')) }));
    const res = await upload(agent, PNG);
    spy.mockRestore(); err.mockRestore();
    expect(res.status).toBe(500);
    expect(mockCloudinary.uploader.destroy).toHaveBeenCalledWith(publicIdFor(1), expect.anything());
    expect((await UserModel.findById(user._id)).profileImage).toBe('');
  });

  it('name-only updates never touch Cloudinary; empty and invalid bodies are 400 / 422, not 500 (L-13)', async () => {
    const { user, agent } = await customerAgent();
    const renamed = await agent.patch('/customer-api/profile').send({ name: '  New Name  ' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('New Name');
    expect(mockCloudinary.uploader.upload_stream).not.toHaveBeenCalled();
    expect(mockCloudinary.uploader.destroy).not.toHaveBeenCalled();

    const none = await agent.patch('/customer-api/profile'); // no body at all
    expect(none.status).toBe(400);
    expect(none.body.message).toBe('No valid fields provided for update.');
    expect((await agent.patch('/customer-api/profile').send({})).status).toBe(400);
    expect((await agent.patch('/customer-api/profile').send({ name: 123 })).status).toBe(422);
    expect((await agent.patch('/customer-api/profile').send({ name: 'x' })).status).toBe(422);
    expect((await UserModel.findById(user._id)).name).toBe('New Name');
    const audit = await AuditLogModel.find({ action: 'PROFILE_UPDATED' });
    expect(audit).toHaveLength(1);
  });
});
