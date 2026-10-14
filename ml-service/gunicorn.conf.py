"""
gunicorn settings tuned for a Render free instance (512 MB RAM, shared CPU).

One worker process keeps a single copy of the model in memory; four threads
let the health check and a few concurrent predictions overlap (predict calls
themselves are serialised by a lock and take about a millisecond).
"""

import os

bind = f"0.0.0.0:{os.environ.get('PORT', '10000')}"   # Render sets PORT
workers = 1
worker_class = "gthread"
threads = 4
timeout = 30
graceful_timeout = 20
keepalive = 5
preload_app = True          # load the model once, fail the deploy if it cannot load
accesslog = None            # the app logs its own one-line summaries
errorlog = "-"
loglevel = os.environ.get("LOG_LEVEL", "info").lower()
