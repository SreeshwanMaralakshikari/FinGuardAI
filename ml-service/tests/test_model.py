import itertools
import json
import math
import os
import shutil

import numpy as np
import pytest
import xgboost as xgb

from app.features import CONTRACT_KEYS, MODEL_COLUMNS, validate_features
from app.model import FraudModel, ModelLoadError
from tests.conftest import ACCOUNT_TAKEOVER, MODEL_DIR, valid_features


def logit(p):
    return math.log(p / (1 - p))


def test_meta_matches_code(model):
    assert model.meta["modelColumns"] == list(MODEL_COLUMNS)
    assert model.version == model.meta["modelVersion"]
    assert model.meta["dataset"]["source"].startswith("synthetic")


def test_prediction_shape(model):
    result = model.predict(validate_features(valid_features()))
    assert 0.0 <= result.probability <= 1.0
    assert isinstance(result.score, int) and 0 <= result.score <= 100
    assert {c["feature"] for c in result.contributions} == set(CONTRACT_KEYS)
    shap_abs = [abs(c["shap"]) for c in result.contributions]
    assert shap_abs == sorted(shap_abs, reverse=True)


@pytest.mark.parametrize("overrides", [{}, ACCOUNT_TAKEOVER, {"hasProfile": 0, "paymentMethod": "WALLET"}])
def test_shap_values_add_up_to_model_output(model, overrides):
    """SHAP is exact: base value + Σ contributions = log-odds of the probability."""
    result = model.predict(validate_features(valid_features(**overrides)))
    total = result.base_value + sum(c["shap"] for c in result.contributions)
    p = min(max(result.probability, 1e-7), 1 - 1e-7)
    assert total == pytest.approx(logit(p), abs=1e-3)


def test_normal_payment_is_low_and_takeover_is_critical(model):
    normal = model.predict(validate_features(valid_features()))
    takeover = model.predict(validate_features(valid_features(**ACCOUNT_TAKEOVER)))
    assert normal.score < 25
    assert takeover.score >= 75
    assert "Payment from a device the customer has not used before" in takeover.reasons
    assert len(takeover.reason_features) == len(takeover.reasons)
    assert set(takeover.reason_features) <= set(CONTRACT_KEYS)


def test_single_weak_signals_stay_low(model):
    """Honest customers often use a new browser or travel; one signal alone must not hold a payment."""
    for overrides in ({"isNewDevice": 1}, {"isNewCity": 1}, {"isUnusualHour": 1}, {"hasProfile": 0}):
        assert model.predict(validate_features(valid_features(**overrides))).score < 25, overrides


def test_predictions_are_deterministic(model):
    clean = validate_features(valid_features(**ACCOUNT_TAKEOVER))
    first = model.predict(clean)
    assert all(model.predict(clean) == first for _ in range(5))


def test_xgboost_treeshap_matches_shap_library(model):
    """Serving uses XGBoost's pred_contribs; it must equal shap.TreeExplainer exactly."""
    shap = pytest.importorskip("shap")
    rng = np.random.default_rng(0)
    rows = []
    for _ in range(200):
        rows.append([
            rng.uniform(10, 60000), rng.uniform(0, 20), rng.uniform(0, 5), rng.integers(0, 12),
            rng.integers(0, 40), rng.integers(0, 2), rng.integers(0, 2), rng.integers(0, 2),
            rng.integers(0, 2), rng.integers(0, 24), rng.uniform(0, 100), rng.integers(0, 2),
            rng.integers(0, 2), rng.integers(0, 2), *np.eye(4)[rng.integers(0, 4)],
        ])
    X = np.asarray(rows, dtype=np.float32)
    booster = model._booster
    ours = booster.predict(xgb.DMatrix(X, feature_names=list(MODEL_COLUMNS)), pred_contribs=True)
    explainer = shap.TreeExplainer(booster)
    theirs = explainer.shap_values(X)
    np.testing.assert_allclose(ours[:, :-1], theirs, atol=1e-4)
    np.testing.assert_allclose(ours[0, -1], explainer.expected_value, atol=1e-4)


def test_mismatched_columns_fail_at_startup(tmp_path):
    shutil.copy(os.path.join(MODEL_DIR, "fraud_model.json"), tmp_path / "fraud_model.json")
    with open(os.path.join(MODEL_DIR, "model_meta.json"), encoding="utf-8") as fh:
        meta = json.load(fh)
    meta["modelColumns"] = meta["modelColumns"][::-1]
    (tmp_path / "model_meta.json").write_text(json.dumps(meta), encoding="utf-8")
    with pytest.raises(ModelLoadError, match="columns"):
        FraudModel(str(tmp_path / "fraud_model.json"), str(tmp_path / "model_meta.json"))


def test_missing_model_file_fails_clearly(tmp_path):
    with pytest.raises(ModelLoadError):
        FraudModel(str(tmp_path / "nope.json"), str(tmp_path / "nope_meta.json"))


def test_monotonic_constraints_hold(model):
    """A riskier value of a constrained feature never lowers the probability (training/train.py MONOTONE)."""
    from training.train import MONOTONE
    sweeps = {
        "amountToAvgRatio": [0.2, 1, 3, 8, 20, 60], "amountToMaxRatio": [0.2, 1, 2, 5, 20],
        "txnsLastHour": [0, 1, 3, 5, 10], "txnsLastDay": [0, 2, 8, 20, 40], "deviceReputationScore": [100, 80, 50, 30, 0],
        "isNewCity": [0, 1], "isNewDevice": [0, 1], "isNewPaymentMethod": [0, 1], "isUnusualHour": [0, 1],
        "deviceIsBlacklisted": [0, 1], "isHighRiskMerchant": [0, 1], "hasProfile": [1, 0],
    }
    assert set(sweeps) == set(MONOTONE)
    bases = [valid_features(), valid_features(**ACCOUNT_TAKEOVER), valid_features(paymentMethod="CARD", txnsLastHour=4)]
    for base in bases:
        for name, values in sweeps.items():    # values ordered from safer to riskier
            probs = [model.predict(validate_features({**base, name: v})).probability for v in values]
            assert all(b >= a - 1e-6 for a, b in itertools.pairwise(probs)), (name, base, probs)


def test_risky_daytime_payment_from_new_device_and_city_is_critical(model):
    """The end-to-end case: ₹20,000 = 21.7× the average, new device, new city, daytime, 5 payments this hour."""
    payment = valid_features(amount=20000.0, amountToAvgRatio=21.74, amountToMaxRatio=17.39, txnsLastHour=5, txnsLastDay=5,
                             isNewCity=1, isNewDevice=1, hourOfDay=8)
    result = model.predict(validate_features(payment))
    assert result.score >= 75
    by_feature = {c["feature"]: c["shap"] for c in result.contributions}
    for risky in ("amountToAvgRatio", "amountToMaxRatio", "txnsLastHour", "isNewCity", "isNewDevice"):
        assert by_feature[risky] >= 0, (risky, by_feature[risky])
