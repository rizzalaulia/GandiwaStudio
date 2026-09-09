"""SQLAlchemy and SQLite runtime configuration."""

import sqlite3

from sqlalchemy import Engine, create_engine, event

from gandiwa_api.config import Settings


def create_sqlite_engine(settings: Settings) -> Engine:
    """Create an engine whose connections enforce the SQLite runtime contract."""
    engine = create_engine(settings.DATABASE_URL)

    @event.listens_for(engine, "connect")
    def configure_sqlite(
        dbapi_connection: sqlite3.Connection,
        _connection_record: object,
    ) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute(f"PRAGMA busy_timeout={settings.DATABASE_BUSY_TIMEOUT_MS}")
        finally:
            cursor.close()

    return engine
