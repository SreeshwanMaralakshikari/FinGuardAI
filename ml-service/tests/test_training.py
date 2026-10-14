"""
The rule-engine port is checked against the expectations already written in the
backend's Jest suite (Phase 8 fraudDetectionService tests), so the ML-vs-rules
comparison in reports/metrics.json compares against the real rules.
"""

import pytest

from app.features import validate_features
from tests.conftest import valid_features
from training.generate_data import OUTPUT_COLUMNS, simulate
from training.rule_engine import _js_round, rule_score_row


def rules(**overrides):
    # A "safe" payment for the rules: no rule fires.
    return rule_score_row(valid_features(**overrides))


class TestRuleEnginePortMatchesJest:
    def test_safe_payment_scores_zero(self):
        assert rules() == 0

    def test_high_risk_merchant_is_35(self):
        assert rules(isHighRiskMerchant=1) == 35

    def test_amount_over_threshold_and_over_3x_average_is_35(self):
        assert rules(amount=60000.0, amountToAvgRatio=12.0) == 35

    def test_unknown_device_adds_20(self):
        assert rules(isNewDevice=1) == 20

    def test_low_reputation_and_blacklist_capped_at_50(self):
        assert rules(deviceReputationScore=0.0, deviceIsBlacklisted=1) == 50

    def test_unusual_city_adds_15(self):
        assert rules(isNewCity=1) == 15

    def test_unusual_hour_adds_10(self):
        assert rules(isUnusualHour=1) == 10

    def test_velocity_uses_greater_or_equal(self):     # C-P5-01
        assert rules(txnsLastHour=5) == 15
        assert rules(txnsLastHour=4) == 0
        assert rules(txnsLastHour=5, txnsLastDay=20) == 20

    def test_ratio_rule_needs_a_profile(self):
        assert rules(hasProfile=0, amountToAvgRatio=9.0) == 0

    def test_total_is_capped_at_100(self):
        assert rules(isHighRiskMerchant=1, amount=60000.0, amountToAvgRatio=9.0, isNewDevice=1,
                     deviceReputationScore=0.0, deviceIsBlacklisted=1, isNewCity=1, isUnusualHour=1) == 100

    @pytest.mark.parametrize("x,expected", [(4.5, 5), (5.5, 6), (2.5, 3), (4.49, 4)])
    def test_js_round_halves_up(self, x, expected):
        assert _js_round(x) == expected


class TestGenerator:
    def test_rows_match_contract_and_columns(self):
        rows = simulate(n_customers=80, days=20, seed=7)
        assert rows
        assert list(rows[0]) == OUTPUT_COLUMNS
        for row in rows:
            validate_features({k: row[k] for k in row if k not in
                               ("label", "scenario", "customerId", "dayIndex")})
            assert row["label"] in (0, 1)

    def test_same_seed_same_data(self):
        assert simulate(40, 15, seed=3) == simulate(40, 15, seed=3)

    def test_first_payment_of_a_customer_has_no_profile(self):
        rows = simulate(60, 20, seed=11)
        first = {}
        for row in rows:
            first.setdefault(row["customerId"], row)
        assert all(r["hasProfile"] == 0 and r["isNewDevice"] == 0 and r["amountToAvgRatio"] == 1.0
                   for r in first.values())


class TestRuleFloor:
    """training/evaluate_floor.py mirrors scoringService.applyRuleFloor (alert-only floor)."""

    def test_floor_matches_the_backend_cases(self):
        import numpy as np

        from training.evaluate_floor import apply_rule_floor
        ml = np.array([0, 0, 30, 40, 70, 0, 0], dtype=float)
        rule = np.array([35, 80, 35, 35, 90, 20, 60], dtype=float)
        hard = np.array([True, True, True, True, True, True, False])
        # same table as backend tests/ml.units.test.js → applyRuleFloor
        assert apply_rule_floor(ml, rule, hard).tolist() == [35, 49, 35, 40, 70, 0, 0]

    def test_hard_signal_is_blacklist_high_risk_merchant_or_high_value(self):
        import pandas as pd

        from training.evaluate_floor import hard_signal
        df = pd.DataFrame({
            "deviceIsBlacklisted": [0, 1, 0, 0, 0],
            "isHighRiskMerchant": [0, 0, 1, 0, 0],
            "amount": [900.0, 900.0, 900.0, 50_000.0, 50_000.01],   # strictly above ₹50,000, like the amount rule
        })
        assert hard_signal(df).tolist() == [False, True, True, False, True]
