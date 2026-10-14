"""
train.py — train, evaluate and export the FinGuardAI XGBoost fraud model.

Steps
  1. Load the synthetic dataset and split it 70/15/15 BY CUSTOMER, so the test
     set only contains customers the model never saw (no leakage of a person's
     habits between train and test).
  2. Train XGBoost with early stopping on validation PR-AUC. No class
     re-weighting: the output stays a calibrated probability, which the backend
     turns into fraudScore = round(100 × p) and maps with the admin thresholds.
  3. Evaluate on the test set, next to the current rule engine on the SAME rows.
  4. Export model/fraud_model.json (XGBoost native JSON, version-portable),
     model/model_meta.json, and reports/ (metrics JSON + SHAP summary plot).

Usage:
    python -m training.train --data data/synthetic_transactions.csv
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from datetime import datetime, UTC

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    roc_auc_score,
)
from sklearn.model_selection import GroupShuffleSplit

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.features import (  # noqa: E402
    CONTRACT_KEYS,
    MODEL_COLUMNS,
    contract_description,
    probability_to_score,
    to_model_row,
    validate_features,
)
from training.rule_engine import DEFAULTS, rule_scores  # noqa: E402

MODEL_VERSION = "fg-xgb-1.1.0"   # 1.1: monotonic constraints
SEED = 42

# Monotonic constraints (domain knowledge, as in credit-risk models): a riskier value of a feature may
# never LOWER the score — e.g. a larger amount-to-average ratio, more payments in the last hour, a new
# device, or a lower device trust score. Without them the trees learned data artefacts such as
# "17× the largest earlier payment lowers the risk", which would be shown to analysts as an explanation.
# 0 = unconstrained: amount (card testing uses tiny amounts), hour of day (night is riskier than both
# morning and evening), and the payment-method one-hot columns.
MONOTONE = {
    "amountToAvgRatio": 1, "amountToMaxRatio": 1, "txnsLastHour": 1, "txnsLastDay": 1,
    "isNewCity": 1, "isNewDevice": 1, "isNewPaymentMethod": 1, "isUnusualHour": 1,
    "deviceReputationScore": -1, "deviceIsBlacklisted": 1, "isHighRiskMerchant": 1, "hasProfile": -1,
}
MONOTONE_CONSTRAINTS = "(" + ",".join(str(MONOTONE.get(c, 0)) for c in MODEL_COLUMNS) + ")"

PARAMS = {
    "objective": "binary:logistic",
    "eval_metric": ["aucpr", "logloss"],
    "tree_method": "hist",
    "max_depth": 5,
    "learning_rate": 0.05,
    "min_child_weight": 5,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_lambda": 1.0,
    "monotone_constraints": MONOTONE_CONSTRAINTS,
    "seed": SEED,
    "nthread": 4,
}
NUM_BOOST_ROUND = 2000
EARLY_STOPPING = 100


def to_matrix(df: pd.DataFrame) -> np.ndarray:
    """Every row goes through the SAME validation + encoding the service uses."""
    rows = []
    for record in df[list(CONTRACT_KEYS)].to_dict("records"):
        rows.append(to_model_row(validate_features(record)))
    return np.asarray(rows, dtype=np.float32)


def split_by_customer(df: pd.DataFrame):
    outer = GroupShuffleSplit(n_splits=1, test_size=0.30, random_state=SEED)
    train_idx, rest_idx = next(outer.split(df, groups=df["customerId"]))
    rest = df.iloc[rest_idx]
    inner = GroupShuffleSplit(n_splits=1, test_size=0.50, random_state=SEED)
    val_idx, test_idx = next(inner.split(rest, groups=rest["customerId"]))
    return df.iloc[train_idx], rest.iloc[val_idx], rest.iloc[test_idx]


def threshold_metrics(y_true, score, cutoff) -> dict:
    pred = (score >= cutoff).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, pred, labels=[0, 1]).ravel()
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "cutoff": cutoff,
        "tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "falsePositiveRate": round(fp / (fp + tn), 5) if fp + tn else 0.0,
        "flaggedShare": round(float(pred.mean()), 5),
    }


def evaluate_scores(y, score_0_100: np.ndarray) -> dict:
    return {
        "rocAuc": round(float(roc_auc_score(y, score_0_100)), 4),
        "prAuc": round(float(average_precision_score(y, score_0_100)), 4),
        "atMedium": threshold_metrics(y, score_0_100, DEFAULTS["mediumMin"]),
        "atHigh": threshold_metrics(y, score_0_100, DEFAULTS["highMin"]),
        "atCritical": threshold_metrics(y, score_0_100, DEFAULTS["criticalMin"]),
    }


def per_scenario_recall(test: pd.DataFrame, score: np.ndarray, cutoff: float) -> dict:
    out = {}
    fraud = test["scenario"] != "legit"
    for name in sorted(test.loc[fraud, "scenario"].unique()):
        mask = (test["scenario"] == name).to_numpy()
        out[name] = {"payments": int(mask.sum()),
                     "caughtShare": round(float((score[mask] >= cutoff).mean()), 4)}
    return out


def calibration_table(y, prob, bins=(0, .05, .25, .5, .75, 1.0001)) -> list:
    table = []
    for lo, hi in zip(bins[:-1], bins[1:], strict=True):
        mask = (prob >= lo) & (prob < hi)
        if mask.sum():
            table.append({"range": f"{lo:.2f}-{min(hi, 1):.2f}", "payments": int(mask.sum()),
                          "meanPredicted": round(float(prob[mask].mean()), 4),
                          "observedFraudRate": round(float(y[mask].mean()), 4)})
    return table


def main(argv=None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data/synthetic_transactions.csv")
    parser.add_argument("--model-dir", default="model")
    parser.add_argument("--report-dir", default="reports")
    parser.add_argument("--no-plots", action="store_true")
    args = parser.parse_args(argv)

    df = pd.read_csv(args.data)
    train, val, test = split_by_customer(df)
    for name, part in (("train", train), ("val", val), ("test", test)):
        print(f"{name:<5} {len(part):>8,} payments  {part['customerId'].nunique():>5,} customers  "
              f"fraud {part['label'].mean():.3%}")
    assert not (set(train.customerId) & set(test.customerId)), "customer leakage"
    assert not (set(train.customerId) & set(val.customerId)), "customer leakage"

    X_train, X_val, X_test = to_matrix(train), to_matrix(val), to_matrix(test)
    y_train, y_val, y_test = (p["label"].to_numpy() for p in (train, val, test))

    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=list(MODEL_COLUMNS))
    dval = xgb.DMatrix(X_val, label=y_val, feature_names=list(MODEL_COLUMNS))
    dtest = xgb.DMatrix(X_test, label=y_test, feature_names=list(MODEL_COLUMNS))

    booster = xgb.train(
        PARAMS, dtrain, num_boost_round=NUM_BOOST_ROUND,
        evals=[(dtrain, "train"), (dval, "val")],
        early_stopping_rounds=EARLY_STOPPING, verbose_eval=200,
    )
    best_iter = booster.best_iteration
    print(f"best iteration: {best_iter}")
    # Keep only the trees up to the best iteration so serving needs no extra argument.
    booster = booster[: best_iter + 1]

    prob_test = booster.predict(dtest)
    # Exactly what the service returns and the backend stores as fraudScore.
    ml_score = np.array([probability_to_score(float(p)) for p in prob_test], dtype=float)
    rule_score = rule_scores(test)

    metrics = {
        "ml": {**evaluate_scores(y_test, ml_score),
               "brier": round(float(brier_score_loss(y_test, prob_test)), 6),
               "calibration": calibration_table(y_test, prob_test)},
        "ruleEngine": evaluate_scores(y_test, rule_score),
        "perScenarioCaughtAtHigh": {
            "ml": per_scenario_recall(test, ml_score, DEFAULTS["highMin"]),
            "ruleEngine": per_scenario_recall(test, rule_score, DEFAULTS["highMin"]),
        },
    }

    # Mean |SHAP| per model column via XGBoost's exact TreeSHAP.
    contribs = booster.predict(dtest, pred_contribs=True)[:, :-1]
    importance = dict(sorted(
        ((c, round(float(v), 4)) for c, v in zip(MODEL_COLUMNS, np.abs(contribs).mean(axis=0), strict=True)),
        key=lambda kv: kv[1], reverse=True))
    metrics["meanAbsShap"] = importance

    os.makedirs(args.model_dir, exist_ok=True)
    os.makedirs(args.report_dir, exist_ok=True)
    model_path = os.path.join(args.model_dir, "fraud_model.json")
    booster.save_model(model_path)

    meta = {
        "modelVersion": MODEL_VERSION,
        "trainedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "algorithm": "XGBoost gradient-boosted trees (binary:logistic)",
        "xgboostVersion": xgb.__version__,
        "pythonVersion": platform.python_version(),
        "bestIteration": int(best_iter),
        "params": {k: v for k, v in PARAMS.items() if k != "nthread"},
        "modelColumns": list(MODEL_COLUMNS),
        "contract": contract_description(),
        "scoreMapping": "fraudScore = round(100 × probability); riskLevel uses the admin thresholds in the backend",
        "dataset": {
            "source": "synthetic (training/generate_data.py) — not real bank data",
            "file": os.path.basename(args.data),
            "payments": int(len(df)),
            "customers": int(df["customerId"].nunique()),
            "fraudRate": round(float(df["label"].mean()), 5),
            "split": "70/15/15 by customer",
            "testPayments": int(len(test)),
        },
        "testMetrics": {k: metrics[k] for k in ("ml", "ruleEngine")},
    }
    with open(os.path.join(args.model_dir, "model_meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    with open(os.path.join(args.report_dir, "metrics.json"), "w", encoding="utf-8") as fh:
        json.dump(metrics, fh, indent=2)

    if not args.no_plots:
        _shap_plot(booster, X_test, y_test, args.report_dir)

    _print_summary(metrics)
    print(f"\nSaved {model_path} ({os.path.getsize(model_path) / 1024:.0f} KB) and model_meta.json")


def _shap_plot(booster, X_test, y_test, report_dir):
    """SHAP summary (beeswarm) for the report — uses the shap library, training only."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import shap

    rng = np.random.default_rng(SEED)
    fraud_idx = np.flatnonzero(y_test == 1)
    legit_idx = rng.choice(np.flatnonzero(y_test == 0), size=min(3000, (y_test == 0).sum()), replace=False)
    sample = X_test[np.concatenate([fraud_idx, legit_idx])]
    explainer = shap.TreeExplainer(booster)
    values = explainer.shap_values(sample)
    shap.summary_plot(values, sample, feature_names=list(MODEL_COLUMNS), show=False, max_display=18)
    plt.title("FinGuardAI model — SHAP summary (test sample: all fraud + 3,000 legit)")
    plt.tight_layout()
    plt.savefig(os.path.join(report_dir, "shap_summary.png"), dpi=150)
    plt.close()


def _print_summary(m: dict) -> None:
    def line(name, block):
        h = block["atHigh"]
        print(f"{name:<12} ROC-AUC {block['rocAuc']:.4f}  PR-AUC {block['prAuc']:.4f}  | at HIGH (≥50): "
              f"precision {h['precision']:.3f} recall {h['recall']:.3f} F1 {h['f1']:.3f} "
              f"FPR {h['falsePositiveRate']:.4%}")
    print()
    line("ML model", m["ml"])
    line("Rule engine", m["ruleEngine"])
    print("\nCaught at HIGH, per fraud scenario (ML | rules):")
    for k, v in m["perScenarioCaughtAtHigh"]["ml"].items():
        r = m["perScenarioCaughtAtHigh"]["ruleEngine"][k]
        print(f"  {k:<20} {v['caughtShare']:>6.1%} | {r['caughtShare']:>6.1%}   (n={v['payments']})")


if __name__ == "__main__":
    main()
