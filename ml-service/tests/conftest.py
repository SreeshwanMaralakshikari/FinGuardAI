import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app.config import Settings
from app.model import FraudModel
from app.server import create_app

TEST_KEY = "test-key-" + "x" * 40
MODEL_DIR = os.path.join(ROOT, "model")


def valid_features(**overrides):
    """A normal, low-risk payment that satisfies the contract."""
    base = {
        "amount": 900.0,
        "amountToAvgRatio": 1.0,
        "amountToMaxRatio": 0.4,
        "txnsLastHour": 0,
        "txnsLastDay": 1,
        "isNewCity": 0,
        "isNewDevice": 0,
        "isNewPaymentMethod": 0,
        "isUnusualHour": 0,
        "hourOfDay": 14,
        "deviceReputationScore": 100.0,
        "deviceIsBlacklisted": 0,
        "isHighRiskMerchant": 0,
        "hasProfile": 1,
        "paymentMethod": "UPI",
    }
    base.update(overrides)
    return base


ACCOUNT_TAKEOVER = {
    "isNewDevice": 1, "isNewCity": 1, "amount": 9000.0, "amountToAvgRatio": 10.0,
    "amountToMaxRatio": 3.0, "hourOfDay": 3, "isUnusualHour": 1,
}


@pytest.fixture(scope="session")
def settings():
    return Settings(api_key=TEST_KEY, model_dir=MODEL_DIR, log_level="WARNING")


@pytest.fixture(scope="session")
def model(settings):
    return FraudModel(settings.model_path, settings.meta_path)


@pytest.fixture()
def client(settings, model):
    app = create_app(settings=settings, model=model)
    app.testing = True
    return app.test_client()


@pytest.fixture()
def auth():
    return {"X-API-Key": TEST_KEY}
