// tests/round4.insights.test.js — R4-08 GET /admin-api/model-insights and its helpers.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import jwt from 'jsonwebtoken';
import supertest from 'supertest';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAdmin, seedAnalyst, uniqueEmail } from './helpers/seedUser.js';
import { seedTransaction } from './helpers/seedTransaction.js';
import { seedConfig } from './helpers/seedConfig.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import { createWithSequentialId } from '../utils/generateSequentialId.js';
import { bandAgreement, meanAbsShap, modelScoreOf } from '../services/modelInsightsService.js';
import app from '../app.js';

const BANDS = { mediumMin: 25, highMin: 50, criticalMin: 75 };

describe('helpers', () => {
  it('bandAgreement counts the ML band against the rule band', () => {
    const out = bandAgreement([
      { ml: 0, rule: 10, count: 5 },   // LOW / LOW
      { ml: 81, rule: 65, count: 2 },  // CRITICAL / HIGH → ML higher
      { ml: 1, rule: 35, count: 3 },   // LOW / MEDIUM → rules higher
      { ml: null, rule: 10, count: 9 }, // ignored
    ], BANDS);
    expect(out).toMatchObject({ total: 10, agree: 5, mlHigher: 2, rulesHigher: 3 });
    expect(out.matrix.CRITICAL.HIGH).toBe(2);
    expect(out.matrix.LOW.MEDIUM).toBe(3);
  });

  it('meanAbsShap averages absolute pushes per feature, strongest first', () => {
    const out = meanAbsShap([
      { scoring: { shapValues: [{ feature: 'isNewDevice', label: 'New device', shap: 3 }, { feature: 'amount', label: 'Amount', shap: -1 }] } },
      { scoring: { shapValues: [{ feature: 'isNewDevice', label: 'New device', shap: -1 }, { feature: 'amount', label: 'Amount', shap: 0.5 }] } },
      { scoring: {} },
    ]);
    expect(out.payments).toBe(2);
    expect(out.features).toEqual([
      { feature: 'isNewDevice', label: 'New device', meanAbsShap: 2 },
      { feature: 'amount', label: 'Amount', meanAbsShap: 0.75 },
    ]);
  });

  it('modelScoreOf uses the model\'s own score when the floor raised the final one', () => {
    expect(modelScoreOf({ fraudScore: 49, scoring: { mlScore: 1 } })).toBe(1);
    expect(modelScoreOf({ fraudScore: 81, scoring: {} })).toBe(81);
  });
});

describe('GET /admin-api/model-insights', () => {
  beforeAll(connectTestDB);
  afterAll(disconnectTestDB);
  beforeEach(async () => { await clearCollections(); await seedConfig(); });

  const as = (user) => {
    const token = jwt.sign({ id: user._id, iatMs: Date.now() }, process.env.JWT_SECRET, { expiresIn: '1h' });
    return { get: (url) => supertest(app).get(url).set('Cookie', `token=${token}`) };
  };
  const shap = (pairs) => pairs.map(([feature, value]) => ({ feature, label: feature, value: '1', shap: value }));

  it('summarises engines, agreement, disagreements, influence and outcomes for the window', async () => {
    const { user } = await seedUser();
    const { user: admin } = await seedAdmin();
    const { user: analyst } = await seedAnalyst({ email: uniqueEmail('an') });
    const ml = (o) => seedTransaction({ userId: user._id, ...o });

    await ml({ fraudScore: 0, scoring: { engine: 'ML', ruleScore: 0, mlScore: 0, shapValues: shap([['amount', -0.4], ['isNewDevice', 0.2]]) } });
    const takeover = await ml({
      fraudScore: 81, riskLevel: 'CRITICAL', status: 'BLOCKED', recommendedAction: 'BLOCK',
      scoring: { engine: 'ML', ruleScore: 30, mlScore: 81, shapValues: shap([['isNewDevice', 3.2], ['amount', 0.4]]) },
      customerResponse: { answer: 'DISPUTED', note: '', respondedAt: new Date() },
    });
    await ml({ fraudScore: 49, riskLevel: 'MEDIUM', scoring: { engine: 'ML', ruleScore: 50, mlScore: 1, ruleFloor: true, shapValues: shap([['isHighRiskMerchant', 1.6]]) } });
    await ml({ fraudScore: 20, scoring: { engine: 'RULES', ruleScore: 20, fallbackReason: 'TIMEOUT' } });
    await ml({ fraudScore: 10 });                                            // before Phase 10
    await ml({ fraudScore: 90, timestamp: new Date(Date.now() - 60 * 24 * 3600 * 1000), scoring: { engine: 'ML', ruleScore: 0, mlScore: 90 } }); // outside 30 days

    const alert = await FraudAlertModel.create({ transactionId: takeover._id, userId: user._id, alertType: 'NEW_DEVICE', riskLevel: 'CRITICAL', fraudScore: 81, reasons: ['x'], status: 'REVIEWED' });
    await createWithSequentialId(FraudCaseModel, 'publicId', 'CASE', {
      fraudAlertId: alert._id, transactionId: takeover._id, userId: user._id, assignedAnalystId: analyst._id, status: 'RESOLVED', resolvedAt: new Date(),
    });

    const res = await as(admin).get('/admin-api/model-insights');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.windowDays).toBe(30);
    expect(d.engines).toEqual({ ML: 3, RULES: 1, LEGACY: 1 });
    expect(d.fallbacks).toEqual({ TIMEOUT: 1 });
    expect(d.floorRaised).toBe(1);
    expect(d.agreement).toMatchObject({ total: 3, agree: 1, mlHigher: 1, rulesHigher: 1 });
    expect(d.agreement.matrix.CRITICAL.MEDIUM).toBe(1);   // takeover: model 81, rules 30
    expect(d.agreement.matrix.LOW.CRITICAL).toBe(0);
    expect(d.agreement.matrix.LOW.HIGH).toBe(1);          // casino: model 1, rules 50
    expect(d.disagreements.map((x) => x.publicId)).toEqual([takeover.publicId, expect.any(String)]);
    expect(d.disagreements[0]).toMatchObject({ mlScore: 81, ruleScore: 30, mlBand: 'CRITICAL', ruleBand: 'MEDIUM' });
    expect(d.disagreements[1]).toMatchObject({ mlScore: 1, ruleScore: 50, ruleFloor: true, fraudScore: 49 });
    expect(d.influence.payments).toBe(3);
    // averaged over all 3 sampled payments: new device (0.2 + 3.2) / 3, high-risk merchant 1.6 / 3
    expect(d.influence.features.slice(0, 2)).toEqual([
      { feature: 'isNewDevice', label: 'isNewDevice', meanAbsShap: 1.1333 },
      { feature: 'isHighRiskMerchant', label: 'isHighRiskMerchant', meanAbsShap: 0.5333 },
    ]);
    expect(d.outcomes.ML).toEqual({ confirmed: 1, dismissed: 0 });
    expect(d.customerAnswers.DISPUTED).toEqual({ confirmed: 1, dismissed: 0 });
  });

  it('validates days and is admin-only', async () => {
    const { user: admin } = await seedAdmin();
    expect((await as(admin).get('/admin-api/model-insights?days=0')).status).toBe(422);
    expect((await as(admin).get('/admin-api/model-insights?days=abc')).status).toBe(422);
    const seven = await as(admin).get('/admin-api/model-insights?days=7');
    expect(seven.body.data).toMatchObject({ windowDays: 7, engines: { ML: 0, RULES: 0, LEGACY: 0 }, agreement: { total: 0 } });
    const { user } = await seedUser();
    expect((await as(user).get('/admin-api/model-insights')).status).toBe(403);
  });
});
