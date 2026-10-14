import pytest

from app.config import ConfigError, load_settings
from tests.conftest import ACCOUNT_TAKEOVER, TEST_KEY, valid_features


def post_predict(client, body, headers):
    return client.post("/predict", json=body, headers=headers)


class TestHealth:
    def test_health_needs_no_key(self, client, model):
        res = client.get("/health")
        assert res.status_code == 200
        assert res.get_json() == {"status": "ok", "modelVersion": model.version}
        assert res.headers["Cache-Control"] == "no-store"


class TestAuth:
    def test_missing_key(self, client):
        res = post_predict(client, {"features": valid_features()}, {})
        assert res.status_code == 401
        assert res.get_json()["error"]["code"] == "UNAUTHORIZED"

    def test_wrong_key(self, client):
        res = post_predict(client, {"features": valid_features()}, {"X-API-Key": TEST_KEY + "x"})
        assert res.status_code == 401

    def test_contract_needs_key(self, client, auth):
        assert client.get("/contract").status_code == 401
        res = client.get("/contract", headers=auth)
        assert res.status_code == 200
        assert len(res.get_json()["features"]) == 15


class TestPredict:
    def test_success_shape(self, client, auth, model):
        res = post_predict(client, {"features": valid_features(**ACCOUNT_TAKEOVER)}, auth)
        assert res.status_code == 200
        body = res.get_json()
        assert list(body) == ["modelVersion", "fraudProbability", "fraudScore",
                              "baseValue", "contributions", "reasons", "reasonFeatures"]
        assert body["modelVersion"] == model.version
        assert isinstance(body["fraudScore"], int) and body["fraudScore"] >= 75
        assert len(body["contributions"]) == 15
        assert set(body["contributions"][0]) == {"feature", "value", "shap"}
        assert body["reasons"]
        assert len(body["reasonFeatures"]) == len(body["reasons"])
        assert body["reasonFeatures"][0] == "isNewDevice"

    def test_score_matches_direct_model_call(self, client, auth, model):
        from app.features import validate_features
        payload = valid_features(isNewDevice=1, amountToAvgRatio=4.0, amount=3600.0)
        body = post_predict(client, {"features": payload}, auth).get_json()
        assert body["fraudScore"] == model.predict(validate_features(payload)).score

    def test_validation_errors_are_422_with_fields(self, client, auth):
        res = post_predict(client, {"features": valid_features(isNewCity=3, extra=1)}, auth)
        assert res.status_code == 422
        err = res.get_json()["error"]
        assert err["code"] == "INVALID_FEATURES"
        assert set(err["fields"]) == {"isNewCity", "extra"}

    def test_missing_features_object(self, client, auth):
        res = post_predict(client, {"feature": {}}, auth)
        assert res.status_code == 400

    def test_malformed_json(self, client, auth):
        res = client.post("/predict", data="{not json", headers={**auth, "Content-Type": "application/json"})
        assert res.status_code == 400
        assert res.get_json()["error"]["code"] == "BAD_REQUEST"

    def test_not_json(self, client, auth):
        res = client.post("/predict", data="a=1", headers={**auth, "Content-Type": "text/plain"})
        assert res.status_code == 415

    def test_body_too_large(self, client, auth):
        res = client.post("/predict", data="x" * 20_000, headers={**auth, "Content-Type": "application/json"})
        assert res.status_code == 413
        assert res.get_json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


class TestPlumbing:
    def test_request_id_is_echoed(self, client, auth):
        res = post_predict(client, {"features": valid_features()}, {**auth, "X-Request-Id": "TXN-2026-00042"})
        assert res.headers["X-Request-Id"] == "TXN-2026-00042"

    def test_oversized_request_id_is_replaced(self, client, auth):
        res = post_predict(client, {"features": valid_features()}, {**auth, "X-Request-Id": "a" * 200})
        assert len(res.headers["X-Request-Id"]) == 32

    def test_unknown_route_and_method_return_json(self, client):
        assert client.get("/nope").get_json()["error"]["code"] == "NOT_FOUND"
        res = client.get("/predict")
        assert res.status_code == 405
        assert res.get_json()["error"]["code"] == "METHOD_NOT_ALLOWED"


class TestConfig:
    @pytest.mark.parametrize("key", [None, "", "short-key", "x" * 31])
    def test_weak_or_missing_key_refuses_to_start(self, key):
        env = {} if key is None else {"ML_API_KEY": key}
        with pytest.raises(ConfigError):
            load_settings(env)

    def test_valid_key(self):
        settings = load_settings({"ML_API_KEY": "k" * 32, "LOG_LEVEL": "debug"})
        assert settings.log_level == "DEBUG"
        assert settings.model_path.endswith("fraud_model.json")
