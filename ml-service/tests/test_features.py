import json
import math
import os

import pytest

from app.features import (
    CONTRACT_KEYS,
    MAX_AMOUNT,
    MODEL_COLUMNS,
    NUMERIC_FEATURE_NAMES,
    FeatureValidationError,
    _fmt_inr,
    _times,
    build_reason_details,
    build_reasons,
    contract_description,
    group_contributions,
    probability_to_score,
    to_model_row,
    validate_features,
)
from tests.conftest import MODEL_DIR, valid_features


def errors_for(payload):
    with pytest.raises(FeatureValidationError) as info:
        validate_features(payload)
    return info.value.errors


class TestContractShape:
    def test_contract_has_15_inputs_and_18_model_columns(self):
        assert len(CONTRACT_KEYS) == 15
        assert len(MODEL_COLUMNS) == 18
        assert len(set(MODEL_COLUMNS)) == 18

    def test_valid_payload_passes_and_types_are_normalised(self):
        clean = validate_features(valid_features(txnsLastHour=2.0, paymentMethod=" card "))
        assert clean["txnsLastHour"] == 2 and isinstance(clean["txnsLastHour"], int)
        assert isinstance(clean["amount"], float)
        assert clean["paymentMethod"] == "CARD"


class TestValidation:
    def test_missing_feature(self):
        payload = valid_features()
        del payload["isNewDevice"]
        assert errors_for(payload) == {"isNewDevice": "is required"}

    def test_unknown_feature_is_rejected_not_ignored(self):
        assert errors_for(valid_features(isNewDeviceId=1)) == {"isNewDeviceId": "unknown feature"}

    def test_boolean_is_not_accepted_as_number(self):
        assert errors_for(valid_features(isNewCity=True)) == {"isNewCity": "must be a number"}

    def test_numeric_string_is_rejected(self):
        assert errors_for(valid_features(amount="900")) == {"amount": "must be a number"}

    @pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
    def test_non_finite(self, bad):
        assert errors_for(valid_features(amount=bad)) == {"amount": "must be finite"}

    def test_binary_must_be_0_or_1(self):
        assert errors_for(valid_features(isNewDevice=2)) == {"isNewDevice": "must be 0 or 1"}

    def test_int_feature_rejects_fraction(self):
        assert errors_for(valid_features(txnsLastHour=1.5)) == {"txnsLastHour": "must be a whole number"}

    @pytest.mark.parametrize("name,value", [("amount", 0), ("hourOfDay", 24),
                                            ("deviceReputationScore", 100.5), ("txnsLastDay", -1)])
    def test_out_of_range(self, name, value):
        assert "must be between" in errors_for(valid_features(**{name: value}))[name]

    def test_amount_limit_is_100_crore_like_the_backend_and_form(self):
        # E-01: the backend validator and the form accept up to ₹100 crore; the contract must too,
        # or the largest payments are rejected (422) and can never be ML-scored.
        assert MAX_AMOUNT == 1_000_000_000
        assert validate_features(valid_features(amount=500_000_000.0))["amount"] == 500_000_000.0
        assert validate_features(valid_features(amount=1_000_000_000.0))["amount"] == 1_000_000_000.0
        assert "must be between" in errors_for(valid_features(amount=1_000_000_000.01))["amount"]

    def test_stored_contract_matches_the_code(self):
        # model_meta.json documents the contract the model ships with; it must never drift from the code.
        with open(os.path.join(MODEL_DIR, "model_meta.json"), encoding="utf-8") as fh:
            assert json.load(fh)["contract"] == contract_description()

    @pytest.mark.parametrize("bad", ["CASH", "", 3, None])
    def test_invalid_payment_method(self, bad):
        assert "must be one of" in errors_for(valid_features(paymentMethod=bad))["paymentMethod"]

    def test_non_object_payload(self):
        assert errors_for([1, 2, 3]) == {"features": "must be a JSON object"}

    def test_all_errors_are_reported_together(self):
        payload = valid_features(amount=-5, isNewCity=7, paymentMethod="CASH", extra=1)
        assert set(errors_for(payload)) == {"amount", "isNewCity", "paymentMethod", "extra"}


class TestEncoding:
    def test_row_order_and_one_hot(self):
        clean = validate_features(valid_features(paymentMethod="NET_BANKING", hourOfDay=7))
        row = to_model_row(clean)
        assert len(row) == len(MODEL_COLUMNS)
        assert row[MODEL_COLUMNS.index("hourOfDay")] == 7.0
        one_hot = row[len(NUMERIC_FEATURE_NAMES):]
        assert one_hot == [0.0, 0.0, 1.0, 0.0]

    def test_group_contributions_sums_payment_columns(self):
        values = [0.0] * len(MODEL_COLUMNS)
        values[MODEL_COLUMNS.index("paymentMethod_UPI")] = 0.25
        values[MODEL_COLUMNS.index("paymentMethod_CARD")] = -0.05
        values[MODEL_COLUMNS.index("amount")] = 1.5
        grouped = group_contributions(values)
        assert set(grouped) == set(CONTRACT_KEYS)
        assert grouped["paymentMethod"] == pytest.approx(0.20)
        assert grouped["amount"] == 1.5
        assert sum(grouped.values()) == pytest.approx(sum(values))

    def test_group_contributions_length_check(self):
        with pytest.raises(ValueError):
            group_contributions([0.0] * 5)


class TestScore:
    @pytest.mark.parametrize("p,score", [(0.0, 0), (0.004, 0), (0.005, 1), (0.125, 13),
                                         (0.495, 50), (0.4949, 49), (1.0, 100)])
    def test_rounds_half_up_like_javascript(self, p, score):
        assert probability_to_score(p) == score

    def test_clamped(self):
        assert probability_to_score(1.2) == 100
        assert probability_to_score(-0.1) == 0


class TestReasons:
    def test_only_positive_contributions_above_threshold(self):
        clean = validate_features(valid_features(isNewDevice=1, isNewCity=1))
        grouped = {k: 0.0 for k in CONTRACT_KEYS}
        grouped.update(isNewDevice=2.0, isNewCity=0.05, amount=-1.0)
        reasons = build_reasons(clean, grouped)
        assert reasons == ["Payment from a device the customer has not used before"]

    def test_benign_values_get_no_reason(self):
        clean = validate_features(valid_features())          # isNewDevice = 0
        grouped = {k: 0.0 for k in CONTRACT_KEYS}
        grouped["isNewDevice"] = 1.0
        assert build_reasons(clean, grouped) == []

    def test_at_most_five_reasons_strongest_first(self):
        clean = validate_features(valid_features(
            isNewDevice=1, isNewCity=1, isUnusualHour=1, isHighRiskMerchant=1,
            txnsLastHour=8, txnsLastDay=12, hourOfDay=2, amountToAvgRatio=9.0))
        grouped = {k: 0.0 for k in CONTRACT_KEYS}
        grouped.update(isNewDevice=3, isNewCity=2.5, isUnusualHour=2, isHighRiskMerchant=1.5,
                       txnsLastHour=1.2, txnsLastDay=1.1, hourOfDay=1.0)
        reasons = build_reasons(clean, grouped)
        assert len(reasons) == 5
        assert reasons[0].startswith("Payment from a device")

    def test_amount_is_formatted_in_rupees(self):
        clean = validate_features(valid_features(amount=50000.0))
        grouped = {k: 0.0 for k in CONTRACT_KEYS}
        grouped["amount"] = 1.0
        assert build_reasons(clean, grouped) == ["Payment amount of ₹50,000 raised the risk"]

    @pytest.mark.parametrize("value,text", [(21.74, "21.7×"), (1.0, "1.0×"), (543478.26, "5,43,478.3×")])
    def test_ratios_use_one_decimal_and_indian_grouping(self, value, text):
        assert _times(value) == text

    @pytest.mark.parametrize("value,text", [
        (100.0, "₹100"), (999.0, "₹999"), (1000.0, "₹1,000"), (50000.0, "₹50,000"),
        (150000.0, "₹1,50,000"), (1234.5, "₹1,234.5"), (12345678.5, "₹1,23,45,678.5"),
        (0.01, "₹0.01"), (1_000_000_000.0, "₹1,00,00,00,000"), (99999.999, "₹1,00,000"),
    ])
    def test_rupees_use_indian_grouping_like_the_backend(self, value, text):
        # E-05: same text as the backend's formatRupees (en-IN, at most 2 decimals), which labels the SHAP bars.
        assert _fmt_inr(value) == text


    def test_details_pair_each_sentence_with_its_feature(self):
        clean = validate_features(valid_features(isNewDevice=1, paymentMethod="CARD"))
        grouped = {k: 0.0 for k in CONTRACT_KEYS}
        grouped.update(isNewDevice=2.0, paymentMethod=0.5)
        assert build_reason_details(clean, grouped) == [
            ("isNewDevice", "Payment from a device the customer has not used before"),
            ("paymentMethod", "Payment method CARD raised the risk"),
        ]
