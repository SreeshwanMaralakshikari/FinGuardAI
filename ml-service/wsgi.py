"""Entry point for gunicorn: `gunicorn -c gunicorn.conf.py wsgi:app`."""

from app.server import create_app

app = create_app()

if __name__ == "__main__":  # local development only: python wsgi.py
    app.run(host="127.0.0.1", port=5001, debug=False)
