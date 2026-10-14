"""
config.py — settings for the ML service, read from environment variables.

  ML_API_KEY        required. Shared secret the Node backend sends in X-API-Key.
                    At least 32 characters. Render free services cannot use the
                    private network, so backend → ML traffic is public HTTPS and
                    this key is what keeps /predict private.
  MODEL_DIR         optional, default <service root>/model
  LOG_LEVEL         optional, default INFO
"""

from __future__ import annotations

import os
from dataclasses import dataclass

SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIN_API_KEY_LENGTH = 32
MAX_REQUEST_BYTES = 8 * 1024   # a feature payload is ~600 bytes


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    api_key: str
    model_dir: str
    log_level: str

    @property
    def model_path(self) -> str:
        return os.path.join(self.model_dir, "fraud_model.json")

    @property
    def meta_path(self) -> str:
        return os.path.join(self.model_dir, "model_meta.json")


def load_settings(env: dict | None = None) -> Settings:
    env = os.environ if env is None else env
    api_key = (env.get("ML_API_KEY") or "").strip()
    if len(api_key) < MIN_API_KEY_LENGTH:
        raise ConfigError(
            f"ML_API_KEY must be set to a random secret of at least {MIN_API_KEY_LENGTH} characters "
            "(generate one with: python -c \"import secrets; print(secrets.token_hex(32))\")"
        )
    return Settings(
        api_key=api_key,
        model_dir=env.get("MODEL_DIR") or os.path.join(SERVICE_ROOT, "model"),
        log_level=(env.get("LOG_LEVEL") or "INFO").upper(),
    )
