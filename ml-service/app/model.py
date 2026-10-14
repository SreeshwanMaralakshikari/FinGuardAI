"""
model.py — loads the trained booster once and scores one payment at a time.

Explanations use XGBoost's own TreeSHAP (predict(pred_contribs=True)). It is the
same exact algorithm as shap.TreeExplainer, without shipping the shap, pandas
and scikit-learn packages to the server (tests/test_model.py proves the values
match). The contributions are in log-odds and add up exactly to the model's raw
output: baseValue + Σ contributions = logit(probability).
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass

import numpy as np
import xgboost as xgb

from app.features import (
    MODEL_COLUMNS,
    build_reason_details,
    group_contributions,
    probability_to_score,
    to_model_row,
)


class ModelLoadError(RuntimeError):
    pass


@dataclass(frozen=True)
class Prediction:
    probability: float
    score: int
    base_value: float
    contributions: list      # [{"feature", "value", "shap"}] sorted by |shap| desc
    reasons: list            # plain-language sentences, strongest first
    reason_features: list    # the contract feature behind each sentence (same order)


class FraudModel:
    def __init__(self, model_path: str, meta_path: str):
        try:
            with open(meta_path, encoding="utf-8") as fh:
                self.meta = json.load(fh)
            booster = xgb.Booster()
            booster.load_model(model_path)
        except (OSError, ValueError, xgb.core.XGBoostError) as exc:
            raise ModelLoadError(f"could not load model from {model_path}: {exc}") from exc

        # Fail at start-up, not on the first payment, if code and model disagree.
        if list(self.meta.get("modelColumns", [])) != list(MODEL_COLUMNS):
            raise ModelLoadError("model_meta.json columns do not match app.features.MODEL_COLUMNS")
        if booster.feature_names is not None and list(booster.feature_names) != list(MODEL_COLUMNS):
            raise ModelLoadError("booster feature names do not match app.features.MODEL_COLUMNS")

        booster.set_param({"nthread": 1})   # tiny inputs; avoid oversubscribing a small instance
        self._booster = booster
        self._lock = threading.Lock()       # serialise predict calls; each takes ~1 ms
        self.version = str(self.meta.get("modelVersion", "unknown"))

    def predict(self, clean: dict) -> Prediction:
        row = np.asarray([to_model_row(clean)], dtype=np.float32)
        dmatrix = xgb.DMatrix(row, feature_names=list(MODEL_COLUMNS))
        with self._lock:
            probability = float(self._booster.predict(dmatrix)[0])
            contribs = self._booster.predict(dmatrix, pred_contribs=True)[0]

        column_contribs = [float(v) for v in contribs[:-1]]
        base_value = float(contribs[-1])                       # last column is the bias
        grouped = group_contributions(column_contribs)

        contributions = sorted(
            (
                {
                    "feature": name,
                    "value": clean[name],
                    "shap": round(shap_value, 6),
                }
                for name, shap_value in grouped.items()
            ),
            key=lambda item: abs(item["shap"]),
            reverse=True,
        )
        details = build_reason_details(clean, grouped)
        return Prediction(
            probability=probability,
            score=probability_to_score(probability),
            base_value=base_value,
            contributions=contributions,
            reasons=[text for _, text in details],
            reason_features=[name for name, _ in details],
        )
