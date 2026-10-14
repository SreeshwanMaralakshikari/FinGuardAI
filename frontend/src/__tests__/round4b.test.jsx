// Round 4 (last round): model card (R4-09) and model insights (R4-08).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor, fireEvent } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderApp, ok } from '../tests/utils.jsx';

vi.mock('../api/serverHealth.js', async (orig) => ({ ...(await orig()), waitForServer: vi.fn(), pingServer: vi.fn() }));
vi.mock('../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import { pingServer } from '../api/serverHealth.js';
import api from '../api/axios.js';
import ModelInsights from '../pages/admin/ModelInsights.jsx';
import { ADMIN_NAV } from '../utils/navigation.js';
import { API_PATHS } from '../utils/constants.js';
import Root from '../Root.jsx';
import ModelCard from '../pages/public/ModelCard.jsx';
import { MODEL, DATASET, METRICS, SCENARIOS, CALIBRATION, IMPORTANCE } from '../components/modelcard/modelFacts.js';

beforeEach(() => { vi.clearAllMocks(); });

const mlFile = (rel) => {
  // vitest runs in frontend/; a `new URL(…, import.meta.url)` here would be bundled by Vite as an asset
  const path = resolve(process.cwd(), '..', 'ml-service', rel);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};

describe('model card (R4-09)', () => {
  it('"/model" is public: shown without the server wake gate', async () => {
    renderApp(<Root />, { route: '/model' });
    expect(await screen.findByRole('heading', { level: 1, name: `FinGuardAI fraud model ${MODEL.version}` })).toBeInTheDocument();
    expect(pingServer).not.toHaveBeenCalled();
  });

  it('states purpose, data, fairness and limits', () => {
    renderApp(<ModelCard />);
    for (const name of ['What it is for', 'Training data', 'How well it works', 'What the model looks at', 'Fairness and privacy', 'Limitations', 'How FinGuardAI uses it']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByText(/never sees a name, gender, age, religion, caste/)).toBeInTheDocument();
    expect(screen.getByText(/Real banking decisions/)).toBeInTheDocument();
    expect(screen.getAllByText('68 %', { selector: 'td' })).toHaveLength(2); // ML alone and ML + policy floor
  });

  it('every number matches the ML service\'s own reports (when the ml-service folder is present)', () => {
    const meta = mlFile('model/model_meta.json');
    const metrics = mlFile('reports/metrics.json');
    const floor = mlFile('reports/rule_floor_metrics.json');
    if (!meta || !metrics || !floor) return; // frontend checked out alone
    expect(MODEL.version).toBe(meta.modelVersion);
    expect(meta.trainedAt.startsWith(MODEL.trainedAt)).toBe(true);
    expect(MODEL.xgboostVersion).toBe(meta.xgboostVersion);
    expect(meta.modelColumns).toHaveLength(MODEL.modelColumns);
    expect(meta.contract).toHaveLength(MODEL.inputs);
    expect(MODEL.algorithm).toContain(`${meta.bestIteration + 1} trees`);
    expect(DATASET).toMatchObject({ payments: meta.dataset.payments, customers: meta.dataset.customers, fraudRate: meta.dataset.fraudRate, testPayments: meta.dataset.testPayments });

    const { ml, ruleEngine } = metrics;
    expect(METRICS.ml).toMatchObject({ rocAuc: ml.rocAuc, prAuc: ml.prAuc, brier: ml.brier });
    expect(METRICS.ml.high).toEqual({ precision: ml.atHigh.precision, recall: ml.atHigh.recall, fp: ml.atHigh.fp });
    expect(METRICS.ml.medium).toEqual({ precision: ml.atMedium.precision, recall: ml.atMedium.recall, fp: ml.atMedium.fp, flaggedShare: ml.atMedium.flaggedShare });
    expect(METRICS.rules).toMatchObject({ rocAuc: ruleEngine.rocAuc, prAuc: ruleEngine.prAuc });
    expect(METRICS.rules.high).toEqual({ precision: ruleEngine.atHigh.precision, recall: ruleEngine.atHigh.recall, fp: ruleEngine.atHigh.fp });
    expect(METRICS.rules.medium.flaggedShare).toBe(ruleEngine.atMedium.flaggedShare);
    expect(METRICS.floor.high).toEqual({ precision: floor.mlWithRuleFloor.atHigh.precision, recall: floor.mlWithRuleFloor.atHigh.recall, fp: floor.mlWithRuleFloor.atHigh.fp });
    expect(METRICS.floor.medium).toEqual({ fp: floor.mlWithRuleFloor.atMedium.fp, flaggedShare: floor.mlWithRuleFloor.atMedium.flaggedShare });

    for (const s of SCENARIOS) {
      expect(s.ml).toBe(metrics.perScenarioCaughtAtHigh.ml[s.key].caughtShare);
      expect(s.rules).toBe(metrics.perScenarioCaughtAtHigh.ruleEngine[s.key].caughtShare);
      expect(s.payments).toBe(metrics.perScenarioCaughtAtHigh.ml[s.key].payments);
    }
    expect(CALIBRATION.map((c) => [c.payments, c.predicted, c.observed])).toEqual(ml.calibration.map((c) => [c.payments, c.meanPredicted, c.observedFraudRate]));

    const shap = metrics.meanAbsShap;
    const methods = ['UPI', 'CARD', 'NET_BANKING', 'WALLET'].reduce((sum, m) => sum + shap[`paymentMethod_${m}`], 0);
    for (const f of IMPORTANCE) {
      const expected = f.feature === 'paymentMethod' ? methods : shap[f.feature];
      expect(f.value).toBeCloseTo(expected, 4);
    }
  });
});

const zero = () => ({ LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 });
const INSIGHTS = {
  windowDays: 30,
  since: '2026-09-15T00:00:00.000Z',
  bands: { mediumMin: 25, highMin: 50, criticalMin: 75 },
  engines: { ML: 3, RULES: 1, LEGACY: 0 },
  fallbacks: { TIMEOUT: 1 },
  floorRaised: 1,
  agreement: {
    matrix: { LOW: { ...zero(), LOW: 1, HIGH: 1 }, MEDIUM: zero(), HIGH: zero(), CRITICAL: { ...zero(), MEDIUM: 1 } },
    total: 3, agree: 1, mlHigher: 1, rulesHigher: 1,
  },
  disagreements: [
    { id: 't1', publicId: 'TXN-00000002', amount: 95000, merchantName: 'Gadget Hub', timestamp: '2026-10-14T10:00:00.000Z', status: 'BLOCKED', riskLevel: 'CRITICAL', fraudScore: 81, mlScore: 81, ruleScore: 30, ruleFloor: false, mlBand: 'CRITICAL', ruleBand: 'MEDIUM' },
    { id: 't2', publicId: 'TXN-00000003', amount: 12000, merchantName: 'Lucky Casino', timestamp: '2026-10-14T11:00:00.000Z', status: 'FLAGGED', riskLevel: 'MEDIUM', fraudScore: 49, mlScore: 1, ruleScore: 50, ruleFloor: true, mlBand: 'LOW', ruleBand: 'HIGH' },
  ],
  influence: { payments: 3, features: [{ feature: 'isNewDevice', label: 'New device', meanAbsShap: 1.1333 }, { feature: 'amount', label: 'Amount', meanAbsShap: 0.2667 }] },
  outcomes: { ML: { confirmed: 1, dismissed: 0 }, RULES: { confirmed: 0, dismissed: 0 }, LEGACY: { confirmed: 0, dismissed: 0 } },
  customerAnswers: { DISPUTED: { confirmed: 1, dismissed: 0 }, CONFIRMED: { confirmed: 0, dismissed: 0 }, NONE: { confirmed: 0, dismissed: 0 } },
};

describe('model insights (R4-08)', () => {
  it('is in the admin navigation after Trends', () => {
    const i = ADMIN_NAV.findIndex((n) => n.to === '/admin/model');
    expect(ADMIN_NAV[i]).toMatchObject({ label: 'Model insights' });
    expect(ADMIN_NAV[i - 1].label).toBe('Trends');
  });

  it('shows engines, agreement, disagreements, influence, fallbacks and outcomes', async () => {
    api.get.mockResolvedValue(ok(INSIGHTS));
    renderApp(<ModelInsights />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Model insights' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(API_PATHS.ADMIN.MODEL_INSIGHTS, expect.objectContaining({ params: { days: 30 } }));
    expect(screen.getByText('75 %')).toBeInTheDocument();            // 3 of 4 scored by the model
    expect(screen.getByText('3 of 4 payments in 30 days')).toBeInTheDocument();
    expect(screen.getByText('33 %')).toBeInTheDocument();            // 1 of 3 same band
    expect(screen.getByText('100 %')).toBeInTheDocument();           // 1 of 1 model hold confirmed

    const matrix = screen.getByRole('table', { name: /ML risk band \(rows\)/ });
    const critical = within(matrix).getByRole('row', { name: /^CRITICAL/ });
    expect(within(critical).getAllByRole('cell').map((c) => c.textContent)).toEqual(['0', '1', '0', '0']);
    expect(screen.getByText(/rated 1 payment higher than the rules and 1 lower/)).toBeInTheDocument();

    expect(screen.getByText('TXN-00000002')).toBeInTheDocument();
    expect(screen.getByText('81 · CRITICAL')).toBeInTheDocument();
    expect(screen.getByText('1 · LOW')).toBeInTheDocument();
    expect(screen.getByText('floor')).toBeInTheDocument();
    expect(screen.getByText('New device')).toBeInTheDocument();
    expect(screen.getByText('1.13')).toBeInTheDocument();
    expect(screen.getByText('The ML service did not answer in time')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'model card' })).toHaveAttribute('href', '/model');
  });

  it('the window picker refetches with the chosen number of days', async () => {
    api.get.mockResolvedValue(ok(INSIGHTS));
    renderApp(<ModelInsights />);
    await screen.findByText('TXN-00000002');
    const seven = screen.getByRole('button', { name: '7 days' });
    expect(seven).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(seven);
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(API_PATHS.ADMIN.MODEL_INSIGHTS, expect.objectContaining({ params: { days: 7 } })));
    expect(seven).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so when nothing was scored by the model, and offers a retry on failure', async () => {
    const empty = { ...INSIGHTS, engines: { ML: 0, RULES: 0, LEGACY: 0 }, fallbacks: {}, floorRaised: 0,
      agreement: { matrix: { LOW: zero(), MEDIUM: zero(), HIGH: zero(), CRITICAL: zero() }, total: 0, agree: 0, mlHigher: 0, rulesHigher: 0 },
      disagreements: [], influence: { payments: 0, features: [] } };
    api.get.mockResolvedValueOnce(ok(empty));
    renderApp(<ModelInsights />);
    expect(await screen.findByText('No model-scored payments in this period.')).toBeInTheDocument();
    expect(screen.getByText('No disagreements in this period.')).toBeInTheDocument();
    expect(screen.getByText('The model answered every payment it was asked about.')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
