"""
features.py — the FinGuardAI ML feature contract (single source of truth).

The Node backend builds ONE flat JSON object per payment from data it already
has at scoring time (the transaction being submitted, the customer's
BehaviorProfile, the DeviceReputation document and live velocity counts) and
POSTs it to /predict. This module:

  1. declares every input feature, its type, its allowed range and its meaning;
  2. validates an incoming payload strictly (unknown or missing keys are errors,
     so a renamed field in Node fails loudly instead of silently scoring 0);
  3. converts a validated payload into the model's column order
     (paymentMethod is one-hot encoded here, not in Node);
  4. turns per-feature SHAP contributions into plain-language reasons.

The same functions are used by the training pipeline and by the Flask service,
so training and serving can never disagree about column order or encoding.

Conventions the Node feature builder must follow (mirrors the rule engine):
  * "is new" flags are 1 only when the profile list is NON-EMPTY and the value
    is not in it. A customer with no history gets 0 and hasProfile = 0.
  * Ratios use the neutral value 1.0 when there is no profile average/max.
  * deviceReputationScore is 100 when the device has no DeviceReputation
    document yet (same default as fraudDetectionService.deviceCheck).
  * hourOfDay is the payment's local hour in India (Asia/Kolkata), 0-23.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

PAYMENT_METHODS: tuple[str, ...] = ("UPI", "CARD", "NET_BANKING", "WALLET")

# Largest payment the app accepts: ₹100 crore. MUST equal MAX_AMOUNT in the backend's
# validators/transactionValidators.js and the form limit in the frontend's
# SubmitTransaction.jsx (a test in each service pins the value). A smaller limit here made the
# service reject very large payments with 422, so they could never be ML-scored.
MAX_AMOUNT = 1_000_000_000


@dataclass(frozen=True)
class NumericFeature:
    name: str
    kind: str            # "float" | "int" | "binary"
    minimum: float
    maximum: float
    description: str
    # Builds a reason sentence from the feature value, or returns None when the
    # value is benign (a positive SHAP push on a benign value is not shown).
    reason: Callable[[float], str | None] | None = None


def _group_indian(digits: str) -> str:
    """'12345678' → '1,23,45,678' (Indian grouping: last three digits, then pairs)."""
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    pairs = []
    while len(head) > 2:
        pairs.insert(0, head[-2:])
        head = head[:-2]
    return ",".join([head, *pairs, tail])


def _fmt_inr(value: float) -> str:
    """
    Rupees with Indian digit grouping and at most 2 decimals, trailing zeros dropped —
    the same text the backend's formatRupees (en-IN) produces, so a reason and the SHAP
    value beside it show the amount identically: 150000 → '₹1,50,000', 1234.5 → '₹1,234.5'.
    """
    whole, _, fraction = f"{value:.2f}".partition(".")
    fraction = fraction.rstrip("0")
    return f"₹{_group_indian(whole)}" + (f".{fraction}" if fraction else "")


def _times(value: float) -> str:
    """'21.7×'; large ratios grouped like rupees: 543478.26 → '5,43,478.3×' (same as the backend's label)."""
    whole, _, fraction = f"{value:.1f}".partition(".")
    return f"{_group_indian(whole)}.{fraction}×"


NUMERIC_FEATURES: tuple[NumericFeature, ...] = (
    NumericFeature(
        "amount", "float", 0.01, MAX_AMOUNT,
        "Payment amount in rupees.",
        lambda v: f"Payment amount of {_fmt_inr(v)} raised the risk",
    ),
    NumericFeature(
        "amountToAvgRatio", "float", 0, 1_000_000,
        "amount / customer's rolling average amount (1.0 when no profile).",
        lambda v: f"Amount is {_times(v)} the customer's usual average" if v > 1.5 else None,
    ),
    NumericFeature(
        "amountToMaxRatio", "float", 0, 1_000_000,
        "amount / customer's largest previous amount (1.0 when no profile).",
        lambda v: f"Amount is {_times(v)} the customer's previous largest payment" if v > 1.0 else None,
    ),
    NumericFeature(
        "txnsLastHour", "int", 0, 100_000,
        "Customer's payments in the previous 60 minutes (current one excluded).",
        lambda v: f"{int(v)} payments in the last hour" if v >= 2 else None,
    ),
    NumericFeature(
        "txnsLastDay", "int", 0, 1_000_000,
        "Customer's payments in the previous 24 hours (current one excluded).",
        lambda v: f"{int(v)} payments in the last 24 hours" if v >= 5 else None,
    ),
    NumericFeature(
        "isNewCity", "binary", 0, 1,
        "1 when the city is not among the customer's usual cities.",
        lambda v: "Payment from a city the customer does not usually use" if v == 1 else None,
    ),
    NumericFeature(
        "isNewDevice", "binary", 0, 1,
        "1 when the device is not among the customer's known devices.",
        lambda v: "Payment from a device the customer has not used before" if v == 1 else None,
    ),
    NumericFeature(
        "isNewPaymentMethod", "binary", 0, 1,
        "1 when the payment method is not among the customer's usual methods.",
        lambda v: "Payment method the customer does not usually use" if v == 1 else None,
    ),
    NumericFeature(
        "isUnusualHour", "binary", 0, 1,
        "1 when the hour is not among the customer's usual hours.",
        lambda v: "Payment at an hour the customer does not usually pay" if v == 1 else None,
    ),
    NumericFeature(
        "hourOfDay", "int", 0, 23,
        "Local hour in India (Asia/Kolkata), 0-23.",
        lambda v: f"Payment made at {int(v):02d}:00, a high-risk time of day"
        if (v <= 5 or v >= 23) else None,
    ),
    NumericFeature(
        "deviceReputationScore", "float", 0, 100,
        "Device trust score 0-100 (100 when the device has no history).",
        lambda v: f"Low device trust score ({v:.0f}/100)" if v < 60 else None,
    ),
    NumericFeature(
        "deviceIsBlacklisted", "binary", 0, 1,
        "1 when the device is blacklisted.",
        lambda v: "Device is blacklisted" if v == 1 else None,
    ),
    NumericFeature(
        "isHighRiskMerchant", "binary", 0, 1,
        "1 when the merchant category is in the admin's high-risk list.",
        lambda v: "Merchant category is on the high-risk list" if v == 1 else None,
    ),
    NumericFeature(
        "hasProfile", "binary", 0, 1,
        "1 when the customer has a behaviour profile with at least one payment.",
        lambda v: "New customer with no payment history yet" if v == 0 else None,
    ),
)

NUMERIC_FEATURE_NAMES: tuple[str, ...] = tuple(f.name for f in NUMERIC_FEATURES)
CATEGORICAL_FEATURE = "paymentMethod"

# Every key the Node backend must send — no more, no fewer.
CONTRACT_KEYS: tuple[str, ...] = NUMERIC_FEATURE_NAMES + (CATEGORICAL_FEATURE,)

# Column order the model is trained and served with.
ONE_HOT_COLUMNS: tuple[str, ...] = tuple(f"paymentMethod_{m}" for m in PAYMENT_METHODS)
MODEL_COLUMNS: tuple[str, ...] = NUMERIC_FEATURE_NAMES + ONE_HOT_COLUMNS

_FEATURES_BY_NAME = {f.name: f for f in NUMERIC_FEATURES}


class FeatureValidationError(ValueError):
    """Raised when a payload does not match the contract. `errors` maps key → message."""

    def __init__(self, errors: dict[str, str]):
        self.errors = errors
        super().__init__("; ".join(f"{k}: {v}" for k, v in sorted(errors.items())))


def validate_features(payload: Any) -> dict[str, Any]:
    """Validate a raw payload and return a clean dict (numbers as float/int, method upper-case)."""
    if not isinstance(payload, dict):
        raise FeatureValidationError({"features": "must be a JSON object"})

    errors: dict[str, str] = {}

    for key in payload:
        if key not in CONTRACT_KEYS:
            errors[str(key)] = "unknown feature"

    clean: dict[str, Any] = {}
    for feature in NUMERIC_FEATURES:
        if feature.name not in payload:
            errors[feature.name] = "is required"
            continue
        value = payload[feature.name]
        # bool is a subclass of int in Python; reject it so true/false is never read as 1/0.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            errors[feature.name] = "must be a number"
            continue
        if not math.isfinite(value):
            errors[feature.name] = "must be finite"
            continue
        if feature.kind in ("int", "binary") and float(value) != int(value):
            errors[feature.name] = "must be a whole number"
            continue
        if feature.kind == "binary" and value not in (0, 1):
            errors[feature.name] = "must be 0 or 1"
            continue
        if value < feature.minimum or value > feature.maximum:
            errors[feature.name] = f"must be between {feature.minimum:g} and {feature.maximum:g}"
            continue
        clean[feature.name] = int(value) if feature.kind in ("int", "binary") else float(value)

    method = payload.get(CATEGORICAL_FEATURE)
    if CATEGORICAL_FEATURE not in payload:
        errors[CATEGORICAL_FEATURE] = "is required"
    elif not isinstance(method, str) or method.strip().upper() not in PAYMENT_METHODS:
        errors[CATEGORICAL_FEATURE] = f"must be one of {', '.join(PAYMENT_METHODS)}"
    else:
        clean[CATEGORICAL_FEATURE] = method.strip().upper()

    if errors:
        raise FeatureValidationError(errors)
    return clean


def to_model_row(clean: dict[str, Any]) -> list[float]:
    """Convert a validated payload into one row in MODEL_COLUMNS order."""
    row = [float(clean[name]) for name in NUMERIC_FEATURE_NAMES]
    row.extend(1.0 if clean[CATEGORICAL_FEATURE] == m else 0.0 for m in PAYMENT_METHODS)
    return row


def group_contributions(column_contribs: list[float]) -> dict[str, float]:
    """
    Fold per-column SHAP values back onto contract features.
    The four paymentMethod_* columns are summed into one 'paymentMethod' value
    (SHAP values are additive, so the sum is exact).
    """
    if len(column_contribs) != len(MODEL_COLUMNS):
        raise ValueError(f"expected {len(MODEL_COLUMNS)} contributions, got {len(column_contribs)}")
    grouped = {name: float(column_contribs[i]) for i, name in enumerate(NUMERIC_FEATURE_NAMES)}
    offset = len(NUMERIC_FEATURE_NAMES)
    grouped[CATEGORICAL_FEATURE] = float(sum(column_contribs[offset:]))
    return grouped


def probability_to_score(probability: float) -> int:
    """
    fraudScore = round(100 × p), rounding halves UP like JavaScript Math.round,
    so the score is identical whichever side computes it. Clamped to 0..100.
    """
    return int(min(100, max(0, math.floor(probability * 100 + 0.5))))


# A feature's push must be at least this large (in log-odds) to become a reason.
REASON_MIN_CONTRIBUTION = 0.10
MAX_REASONS = 5


def build_reason_details(clean: dict[str, Any], grouped: dict[str, float]) -> list[tuple[str, str]]:
    """
    (feature, sentence) pairs for the features that pushed the risk UP the most,
    strongest first. The feature name lets the backend classify the alert
    (e.g. isNewDevice → NEW_DEVICE) without parsing the sentence.
    """
    ranked = sorted(grouped.items(), key=lambda kv: kv[1], reverse=True)
    details: list[tuple[str, str]] = []
    for name, contribution in ranked:
        if contribution < REASON_MIN_CONTRIBUTION or len(details) >= MAX_REASONS:
            break
        if name == CATEGORICAL_FEATURE:
            text = f"Payment method {clean[CATEGORICAL_FEATURE]} raised the risk"
        else:
            template = _FEATURES_BY_NAME[name].reason
            text = template(clean[name]) if template else None
        if text:
            details.append((name, text))
    return details


def build_reasons(clean: dict[str, Any], grouped: dict[str, float]) -> list[str]:
    """Plain-language reasons only (see build_reason_details)."""
    return [text for _, text in build_reason_details(clean, grouped)]


def contract_description() -> list[dict[str, Any]]:
    """Machine-readable contract, served by GET /contract and stored in model_meta.json."""
    described = [
        {
            "name": f.name,
            "type": f.kind,
            "min": f.minimum,
            "max": f.maximum,
            "description": f.description,
        }
        for f in NUMERIC_FEATURES
    ]
    described.append({
        "name": CATEGORICAL_FEATURE,
        "type": "enum",
        "values": list(PAYMENT_METHODS),
        "description": "Transaction payment method.",
    })
    return described
