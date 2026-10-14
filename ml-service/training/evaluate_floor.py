"""
evaluate_floor.py — measures the backend's "rule floor" on the same unseen test set as train.py.

The backend (services/scoringService.js) lets the ML model decide, except when the rule engine sees
a HARD (policy) signal — a blacklisted device, a merchant category on the admin's high-risk list, or
an amount above the admin's high-value threshold — and itself rates the payment MEDIUM or higher. Then the payment is raised to the rule score, capped just
below the HIGH band: a hard signal always produces an alert (e.g. a casino payment from a known
device: ML 0, rules 35 → 35, MEDIUM), but only the model can hold or block a payment.

Why capped ("alert-only"): an uncapped floor, max(ML, rules), was measured too. It let the rules hold
honest high-risk-merchant and high-value payments again: HIGH false alarms rose from 47 to 269 and
HIGH precision fell from 0.912 to 0.653 on this test set. Both variants are reported.

This script scores the test set four ways — ML only, rule engine only, ML with the alert-only floor
(what the backend does) and ML with the uncapped floor (rejected) — and writes
reports/rule_floor_metrics.json. It does not train or change the model.

    python -m training.evaluate_floor --data data/synthetic_transactions.csv
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd
import xgboost as xgb

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.features import MODEL_COLUMNS, probability_to_score
from training.rule_engine import DEFAULTS, rule_scores
from training.train import (
    evaluate_scores,
    per_scenario_recall,
    split_by_customer,
    to_matrix,
)


def hard_signal(df: pd.DataFrame, amount_threshold: float = DEFAULTS["amountThreshold"]) -> np.ndarray:
    """Same conditions as the backend's hardRuleSignals: blacklisted device, high-risk merchant, high-value amount."""
    return ((df["deviceIsBlacklisted"] == 1) | (df["isHighRiskMerchant"] == 1)
            | (df["amount"] > amount_threshold)).to_numpy()


def apply_rule_floor(ml_score: np.ndarray, rule_score: np.ndarray, hard: np.ndarray,
                     medium_min: float = DEFAULTS["mediumMin"], high_min: float = DEFAULTS["highMin"]) -> np.ndarray:
    """
    The backend's rule floor (scoringService.applyRuleFloor): where a hard signal fired and the rules
    rate the payment at least MEDIUM, the score becomes max(ML, min(rules, highMin - 1)).
    """
    floor = np.minimum(rule_score, high_min - 1)
    applies = hard & (rule_score >= medium_min) & (floor > ml_score)
    return np.where(applies, floor, ml_score)


def apply_uncapped_floor(ml_score: np.ndarray, rule_score: np.ndarray, hard: np.ndarray) -> np.ndarray:
    """The rejected variant: max(ML, rules) wherever a hard signal fired."""
    return np.where(hard, np.maximum(ml_score, rule_score), ml_score)


def main(argv=None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data/synthetic_transactions.csv")
    parser.add_argument("--model-dir", default="model")
    parser.add_argument("--report-dir", default="reports")
    args = parser.parse_args(argv)

    df = pd.read_csv(args.data)
    _, _, test = split_by_customer(df)

    booster = xgb.Booster()
    booster.load_model(os.path.join(args.model_dir, "fraud_model.json"))
    dtest = xgb.DMatrix(to_matrix(test), feature_names=list(MODEL_COLUMNS))
    prob = booster.predict(dtest)

    y = test["label"].to_numpy()
    ml_score = np.array([probability_to_score(float(p)) for p in prob], dtype=float)
    rule_score = rule_scores(test)
    hard = hard_signal(test)
    floored = apply_rule_floor(ml_score, rule_score, hard)
    uncapped = apply_uncapped_floor(ml_score, rule_score, hard)
    raised = floored != ml_score

    report = {
        "testPayments": len(test),
        "hardSignalPayments": int(hard.sum()),
        "scoresRaisedByFloor": int(raised.sum()),
        "raisedThatAreFraud": int(y[raised].sum()),
        "ml": evaluate_scores(y, ml_score),
        "mlWithRuleFloor": evaluate_scores(y, floored),
        "mlWithUncappedFloorRejected": evaluate_scores(y, uncapped),
        "ruleEngine": evaluate_scores(y, rule_score),
        "perScenarioCaughtAtHigh": {
            "ml": per_scenario_recall(test, ml_score, DEFAULTS["highMin"]),
            "mlWithRuleFloor": per_scenario_recall(test, floored, DEFAULTS["highMin"]),
        },
        "perScenarioCaughtAtMedium": {
            "ml": per_scenario_recall(test, ml_score, DEFAULTS["mediumMin"]),
            "mlWithRuleFloor": per_scenario_recall(test, floored, DEFAULTS["mediumMin"]),
        },
    }

    os.makedirs(args.report_dir, exist_ok=True)
    out = os.path.join(args.report_dir, "rule_floor_metrics.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)

    for name in ("ml", "mlWithRuleFloor", "mlWithUncappedFloorRejected", "ruleEngine"):
        m = report[name]
        print(f"{name:<28} ROC-AUC {m['rocAuc']:.3f}  PR-AUC {m['prAuc']:.3f}  "
              f"HIGH P/R {m['atHigh']['precision']:.3f}/{m['atHigh']['recall']:.3f} FP {m['atHigh']['fp']}  "
              f"MEDIUM FP {m['atMedium']['fp']} flagged {m['atMedium']['flaggedShare']:.2%}")
    print(f"hard-signal payments {report['hardSignalPayments']:,}; raised by the floor "
          f"{report['scoresRaisedByFloor']:,} (fraud {report['raisedThatAreFraud']:,}) → {out}")


if __name__ == "__main__":
    main()
