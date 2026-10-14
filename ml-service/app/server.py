"""
FinGuardAI ML service — Flask application factory.

Endpoints
  GET  /health    no auth. Liveness + model version (Render health check and
                  the backend's wake-up ping).
  GET  /contract  X-API-Key. The feature contract the backend must send.
  POST /predict   X-API-Key. Body {"features": {...}} → score + SHAP explanation.

Every response is JSON, including errors: {"error": {"code", "message", ...}}.
"""

from __future__ import annotations

import hmac
import logging
import time
import uuid

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import HTTPException

from app.config import MAX_REQUEST_BYTES, Settings, load_settings
from app.features import FeatureValidationError, contract_description, validate_features
from app.model import FraudModel

log = logging.getLogger("finguardai.ml")


def _error(status: int, code: str, message: str, **extra):
    body = {"error": {"code": code, "message": message, **extra}}
    return jsonify(body), status


def create_app(settings: Settings | None = None, model: FraudModel | None = None) -> Flask:
    settings = settings or load_settings()
    logging.basicConfig(level=settings.log_level,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    model = model or FraudModel(settings.model_path, settings.meta_path)
    log.info("model %s loaded", model.version)

    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES
    app.json.sort_keys = False

    @app.before_request
    def _start():
        g.started = time.perf_counter()
        incoming = request.headers.get("X-Request-Id", "")
        # Accept the backend's id only if it is short and printable; else make one.
        g.request_id = incoming if 0 < len(incoming) <= 64 and incoming.isprintable() else uuid.uuid4().hex

    @app.after_request
    def _finish(response):
        response.headers["X-Request-Id"] = g.get("request_id", "")
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        if request.path != "/health":
            elapsed = (time.perf_counter() - g.get("started", time.perf_counter())) * 1000
            log.info("%s %s %s %.1fms id=%s", request.method, request.path,
                     response.status_code, elapsed, g.get("request_id"))
        return response

    def _authorised() -> bool:
        supplied = request.headers.get("X-API-Key", "")
        return hmac.compare_digest(supplied.encode(), settings.api_key.encode())

    @app.get("/health")
    def health():
        return jsonify({"status": "ok", "modelVersion": model.version})

    @app.get("/contract")
    def contract():
        if not _authorised():
            return _error(401, "UNAUTHORIZED", "Missing or invalid API key")
        return jsonify({"modelVersion": model.version, "features": contract_description()})

    @app.post("/predict")
    def predict():
        if not _authorised():
            return _error(401, "UNAUTHORIZED", "Missing or invalid API key")
        if not request.is_json:
            return _error(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json")
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or "features" not in body:
            return _error(400, "BAD_REQUEST", 'Body must be a JSON object with a "features" object')
        try:
            clean = validate_features(body["features"])
        except FeatureValidationError as exc:
            return _error(422, "INVALID_FEATURES", "Feature payload does not match the contract",
                          fields=exc.errors)

        result = model.predict(clean)
        return jsonify({
            "modelVersion": model.version,
            "fraudProbability": round(result.probability, 6),
            "fraudScore": result.score,
            "baseValue": round(result.base_value, 6),
            "contributions": result.contributions,
            "reasons": result.reasons,
            "reasonFeatures": result.reason_features,
        })

    @app.errorhandler(HTTPException)
    def _http_error(exc: HTTPException):
        codes = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 413: "PAYLOAD_TOO_LARGE"}
        return _error(exc.code or 500, codes.get(exc.code, "HTTP_ERROR"), exc.description or exc.name)

    @app.errorhandler(Exception)
    def _unexpected(exc: Exception):
        log.exception("unhandled error id=%s", g.get("request_id"))
        return _error(500, "INTERNAL_ERROR", "The ML service failed to score this request")

    return app
