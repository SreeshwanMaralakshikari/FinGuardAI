"""
rule_engine.py — exact Python port of the backend's rule-based checkFraud()
(services/fraudDetectionService.js, Phase 5 + C-P5-01, default thresholds),
expressed over the ML feature contract.

Used only for evaluation: it scores the same test set as the ML model so the
two can be compared fairly. Every rule here reads a contract feature that the
Node feature builder derives with the same conditions the rule uses.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

DEFAULTS = {
    "amountThreshold": 50_000,
    "maxPerHour": 5,
    "maxPerDay": 20,
    "newDeviceWeight": 20,
    "mediumMin": 25,
    "highMin": 50,
    "criticalMin": 75,
}


def _js_round(x: float) -> int:
    """JavaScript Math.round (halves round up), not Python's banker's rounding."""
    return int(math.floor(x + 0.5))


def rule_score_row(r: dict, t: dict = DEFAULTS) -> int:
    velocity = (15 if r["txnsLastHour"] >= t["maxPerHour"] else 0) + \
               (10 if r["txnsLastDay"] >= t["maxPerDay"] else 0)
    velocity = min(velocity, 20)

    amount = 20 if r["amount"] > t["amountThreshold"] else 0
    # rule: avgAmount > 0 && amount > avg * 3  (avg > 0 exactly when hasProfile)
    if r["hasProfile"] == 1 and r["amountToAvgRatio"] > 3:
        amount += 15
    amount = min(amount, 35)

    location = 15 if r["isNewCity"] == 1 else 0

    device = t["newDeviceWeight"] if r["isNewDevice"] == 1 else 0
    rep = r["deviceReputationScore"]
    if rep < 50:
        device += _js_round((50 - rep) / 50 * 20)
    if r["deviceIsBlacklisted"] == 1:
        device += 30
    device = min(device, 50)

    time_pts = 10 if r["isUnusualHour"] == 1 else 0
    merchant = 35 if r["isHighRiskMerchant"] == 1 else 0

    return int(min(100, max(0, velocity + amount + location + device + time_pts + merchant)))


def rule_scores(df: pd.DataFrame) -> np.ndarray:
    return np.array([rule_score_row(r) for r in df.to_dict("records")], dtype=float)
