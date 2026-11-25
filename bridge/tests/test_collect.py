"""Hermetic fixtures only: never instantiate the Hermes runtime."""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

COLLECTOR = Path(__file__).resolve().parents[1] / "collect.py"


class CollectorTests(unittest.TestCase):
    def setUp(self):
        scratch = (Path(os.environ["LOCALAPPDATA"]) / "hermes" / "cache" / "scratch"
                   if os.name == "nt" else COLLECTOR.parent / ".local")
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="office-bridge-", dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "hermes"

    def run_collector(self):
        result = subprocess.run(
            [sys.executable, "-B", str(COLLECTOR)],
            env={**os.environ, "HERMES_HOME": str(self.home)},
            capture_output=True, text=True, timeout=8,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(len(result.stdout.splitlines()), 1)
        return json.loads(result.stdout)

    def create_store(self, path):
        path.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path / "state.db")
        connection.execute("PRAGMA synchronous=OFF")
        connection.executescript("""
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, source TEXT, profile_name TEXT,
                parent_session_id TEXT, ended_at REAL, end_reason TEXT,
                last_activity_at REAL, runtime_generation INTEGER DEFAULT 0,
                title TEXT, system_prompt TEXT, last_activity_description TEXT
            );
            CREATE TABLE gateway_heartbeats (
                backend_id TEXT PRIMARY KEY, pid INTEGER, started_at REAL,
                last_heartbeat REAL, profile TEXT, host TEXT
            );
            CREATE TABLE session_turn_leases (
                conversation_id TEXT PRIMARY KEY, holder TEXT, acquired_at REAL, expires_at REAL
            );
            CREATE TABLE session_admissions (
                target_session_id TEXT, status TEXT, owner_epoch INTEGER,
                generation INTEGER, payload_json TEXT
            );
            CREATE TABLE runtime_epoch (singleton INTEGER PRIMARY KEY, epoch INTEGER, instance_id TEXT);
            INSERT INTO runtime_epoch VALUES (1, 1, 'fixture');
            CREATE TABLE worker_executions (
                session_id TEXT, kind TEXT, owner_epoch INTEGER, generation INTEGER, status TEXT
            );
            CREATE TABLE messages (content TEXT);
            INSERT INTO messages VALUES ('PRIVATE_TRANSCRIPT_MUST_NOT_LEAK');
        """)
        connection.commit()
        connection.close()

    def create_profile(self, name, display_name):
        path = self.home / "profiles" / name
        self.create_store(path)
        (path / "profile.yaml").write_text(
            "description: PRIVATE_DESCRIPTION_MUST_NOT_LEAK\n"
            "ui_meta:\n  title: PRIVATE_TITLE_MUST_NOT_LEAK\n"
            f"display_name: {display_name}\n", encoding="utf-8",
        )
        return path

    def execute(self, path, sql, parameters=()):
        with closing(sqlite3.connect(path / "state.db")) as connection:
            connection.execute("PRAGMA synchronous=OFF")
            connection.execute(sql, parameters)
            connection.commit()

    def test_default_home_counts_only_verified_inflight_general_sessions(self):
        self.create_store(self.home)
        # A directory named profiles/default is NOT the native default home.
        self.create_profile("default", "Impostor")
        now = time.time()
        for sid, owner, ended in [
            ("turn-one", "default", None), ("turn-two", None, None),
            ("history-only", "default", None), ("ended", "default", now),
            ("expired", "default", None), ("other-profile", "dev-other", None),
        ]:
            self.execute(self.home, "INSERT INTO sessions (id,source,profile_name,last_activity_at,ended_at,title) VALUES (?,?,?,?,?,?)",
                         (sid, "desktop", owner, now, ended, "PRIVATE_TITLE"))
            if sid != "history-only":
                self.execute(self.home, "INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                             (sid, f"pid={os.getpid()}:turn=PRIVATE_TURN", now - 1,
                              now - 1 if sid == "expired" else now + 300))
        snapshot = self.run_collector()
        default = next((a for a in snapshot["agents"] if a["id"] == "default"), None)
        self.assertIsNotNone(default, "The native default home must be represented")
        self.assertEqual((default["name"], default["role"], default["team"]),
                         ("Hermes", "General assistant", "general"))
        self.assertEqual(default["state"], "working")
        self.assertEqual(default["activeSessions"], 2)
        self.assertEqual(len(snapshot["agents"]), 1)
        for private in ["PRIVATE_", "turn-one", "history-only", "pid=", str(self.home)]:
            self.assertNotIn(private, json.dumps(snapshot))

    def test_readable_inactive_native_profiles_are_not_disconnected(self):
        self.create_store(self.home)
        self.create_profile("dev-rest", "Rest")
        now = time.time()
        self.execute(self.home, "INSERT INTO sessions (id,source,profile_name,last_activity_at) VALUES (?,?,?,?)",
                     ("history-only", "desktop", "default", now))
        snapshot = self.run_collector()
        self.assertEqual({a["id"]: a["state"] for a in snapshot["agents"]},
                         {"default": "idle", "dev-rest": "idle"})
        self.assertEqual(snapshot["sourceHealth"], "connected")
        self.assertEqual(snapshot["agents"][0]["activeSessions"], 0)
        self.assertTrue(all(a["activity"] == "Native profile readable; no verified in-flight work."
                            for a in snapshot["agents"]))

    def test_multiplexer_status_is_scoped_fresh_and_incarnation_checked(self):
        from bridge.collect import collect
        from unittest.mock import patch
        self.create_store(self.home)
        self.create_profile("dev-shared", "Shared")
        self.create_profile("dev-cold", "Cold")
        now = time.time()
        status = {"kind": "hermes-gateway", "pid": os.getpid(), "start_time": 123,
                  "hermes_home": str(self.home), "gateway_state": "running",
                  "updated_at": now, "served_profiles": ["default", "dev-shared"],
                  "active_agents": 99, "argv": ["PRIVATE_ARGUMENT"],
                  "session_store": {"status": "ok"}}
        path = self.home / "gateway_state.json"
        with patch("bridge.collect.process_fingerprint", return_value=123, create=True):
            path.write_text(json.dumps(status), encoding="utf-8")
            snapshot = collect(self.home)
            by_id = {a["id"]: a for a in snapshot["agents"]}
            self.assertEqual(by_id["dev-shared"]["activity"], "Fresh profile backend; no observed active turn.")
            self.assertEqual(by_id["dev-cold"]["activity"], "Native profile readable; no verified in-flight work.")
            self.assertEqual(by_id["default"]["activeSessions"], 0, "Fleet-wide active_agents is not a default session count")
            self.assertNotIn("PRIVATE_", json.dumps(snapshot))
            for changes in [{"updated_at": now - 1000}, {"start_time": 124}, {"updated_at": now + 3600}]:
                with self.subTest(changes=changes):
                    path.write_text(json.dumps({**status, **changes}), encoding="utf-8")
                    snapshot = collect(self.home)
                    by_id = {a["id"]: a for a in snapshot["agents"]}
                    self.assertEqual(by_id["dev-shared"]["state"], "offline")
                    self.assertEqual(by_id["dev-cold"]["state"], "idle")
                    self.assertEqual(snapshot["sourceHealth"], "degraded")
            path.write_text(json.dumps({**status, "hermes_home": str(self.home / "another-root")}), encoding="utf-8")
            self.assertTrue(all(a["state"] != "working" for a in collect(self.home)["agents"]))

    def test_default_session_count_is_not_silently_truncated_to_128(self):
        self.create_store(self.home)
        now = time.time()
        with closing(sqlite3.connect(self.home / "state.db")) as connection:
            connection.executemany("INSERT INTO sessions (id,source,profile_name,last_activity_at) VALUES (?,?,?,?)",
                                   [(f"session-{i}", "desktop", "default", now) for i in range(130)])
            connection.executemany("INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                                   [(f"session-{i}", f"pid={os.getpid()}:turn=fixture", now, now + 300) for i in range(130)])
            connection.commit()
        self.assertEqual(self.run_collector()["agents"][0]["activeSessions"], 130)

    def test_worker_row_alone_is_not_live_and_session_evidence_is_deduplicated(self):
        self.create_store(self.home)
        now = time.time()
        self.execute(self.home, "INSERT INTO sessions (id,source,profile_name,last_activity_at,runtime_generation) VALUES (?,?,?,?,?)",
                     ("session", "desktop", "default", now, 2))
        self.execute(self.home, "INSERT INTO worker_executions VALUES (?,?,?,?,?)", ("session", "compute", 1, 2, "running"))
        self.assertEqual(self.run_collector()["agents"][0]["state"], "offline",
                         "Persisted running status plus recent history is not proof of a live worker")
        self.execute(self.home, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                     ("live", os.getpid(), now, now, "default", "host"))
        self.execute(self.home, "INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                     ("session", f"pid={os.getpid()}:turn=fixture", now, now + 300))
        self.execute(self.home, "INSERT INTO worker_executions VALUES (?,?,?,?,?)", ("session", "compute", 1, 2, "running"))
        agent = self.run_collector()["agents"][0]
        self.assertEqual(agent["state"], "working")
        self.assertEqual(agent["activeSessions"], 1)

    def test_lease_held_by_a_newer_process_incarnation_is_not_working(self):
        self.create_store(self.home)
        now = time.time()
        self.execute(self.home, "INSERT INTO sessions (id,source,profile_name,last_activity_at) VALUES (?,?,?,?)",
                     ("session", "desktop", "default", now))
        self.execute(self.home, "INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                     ("session", f"pid={os.getpid()}:turn=fixture", 1.0, now + 300))
        agent = self.run_collector()["agents"][0]
        self.assertEqual(agent["state"], "offline")
        self.assertEqual(agent["activeSessions"], 0)

    def test_ambiguous_worker_compression_lineage_omits_total_instead_of_double_counting(self):
        self.create_store(self.home)
        now = time.time()
        self.execute(self.home, "INSERT INTO sessions (id,profile_name,last_activity_at,ended_at,end_reason) VALUES (?,?,?,?,?)",
                     ("root", "default", now, now, "compression"))
        self.execute(self.home, "INSERT INTO sessions (id,profile_name,parent_session_id,last_activity_at,runtime_generation) VALUES (?,?,?,?,?)",
                     ("child", "default", "root", now, 2))
        self.execute(self.home, "INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                     ("root", f"pid={os.getpid()}:turn=fixture", now, now + 300))
        self.execute(self.home, "INSERT INTO worker_executions VALUES (?,?,?,?,?)", ("child", "compute", 1, 2, "running"))
        self.execute(self.home, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                     ("live", os.getpid(), now, now, "default", "host"))
        snapshot = self.run_collector()
        self.assertEqual(snapshot["agents"][0]["state"], "working")
        self.assertNotIn("activeSessions", snapshot["agents"][0],
                         "Exact fork/compression normalization needs disallowed model_config; never guess")
        self.assertTrue(any("totals are unavailable" in warning for warning in snapshot["warnings"]))

    def test_recycled_backend_pid_cannot_confirm_a_persisted_worker(self):
        self.create_store(self.home)
        now = time.time()
        self.execute(self.home, "INSERT INTO sessions (id,profile_name,last_activity_at,runtime_generation) VALUES (?,?,?,?)",
                     ("session", "default", now, 2))
        self.execute(self.home, "INSERT INTO worker_executions VALUES (?,?,?,?,?)", ("session", "compute", 1, 2, "running"))
        self.execute(self.home, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                     ("recycled", os.getpid(), 1.0, now, "default", "host"))
        self.assertEqual(self.run_collector()["agents"][0]["state"], "offline")

    def test_count_limit_omits_an_unverifiable_total_instead_of_capping_it(self):
        self.create_store(self.home)
        now = time.time()
        with closing(sqlite3.connect(self.home / "state.db")) as connection:
            connection.executemany("INSERT INTO sessions (id,profile_name,last_activity_at) VALUES (?,?,?)",
                                   [(f"session-{i}", "default", now) for i in range(10001)])
            connection.executemany("INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                                   [(f"session-{i}", f"pid={os.getpid()}:turn=fixture", now, now + 300) for i in range(10001)])
            connection.commit()
        snapshot = self.run_collector()
        self.assertEqual(snapshot["agents"][0]["state"], "offline")
        self.assertNotIn("activeSessions", snapshot["agents"][0])
        self.assertEqual(snapshot["sourceHealth"], "unavailable")
        self.assertTrue(any("partial" in warning for warning in snapshot["warnings"]))

    def test_default_pause_retains_verified_running_sessions(self):
        self.create_store(self.home)
        now = time.time()
        self.execute(self.home, "INSERT INTO sessions (id,profile_name,last_activity_at) VALUES (?,?,?)",
                     ("session", "default", now))
        self.execute(self.home, "INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                     ("session", f"pid={os.getpid()}:turn=fixture", now, now + 300))
        (self.home / "ESTOP").write_text("PRIVATE_REASON", encoding="utf-8")
        agent = self.run_collector()["agents"][0]
        self.assertEqual(agent["state"], "working")
        self.assertEqual(agent["activeSessions"], 1)
        self.assertEqual(agent["activity"], "Current turn continues; new work paused by ESTOP.")
        self.execute(self.home, "DELETE FROM session_turn_leases")
        agent = self.run_collector()["agents"][0]
        self.assertEqual(agent["state"], "paused")
        self.assertEqual(agent["activeSessions"], 0)

    def test_missing_root_store_does_not_publish_a_zero_active_session_claim(self):
        self.create_profile("dev-rest", "Rest")
        snapshot = self.run_collector()
        default = snapshot["agents"][0]
        self.assertEqual(default["state"], "offline")
        self.assertEqual(default["activity"], "Runtime status unavailable; activity unverified.")
        self.assertNotIn("activeSessions", default)
        self.assertEqual(snapshot["sourceHealth"], "degraded")
        self.assertFalse((self.home / "state.db").exists())

    def test_invalid_worker_epochs_never_confirm_work(self):
        self.create_store(self.home)
        now = time.time()
        self.execute(self.home, "INSERT INTO sessions (id,profile_name,last_activity_at,runtime_generation) VALUES (?,?,?,?)",
                     ("session", "default", now, 0))
        self.execute(self.home, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                     ("live", os.getpid(), now, now, "default", "host"))
        self.execute(self.home, "UPDATE runtime_epoch SET epoch=0")
        self.execute(self.home, "INSERT INTO worker_executions VALUES (?,?,?,?,?)", ("session", "compute", 0, 0, "running"))
        self.assertEqual(self.run_collector()["agents"][0]["state"], "offline")
        self.execute(self.home, "DELETE FROM runtime_epoch")
        self.execute(self.home, "UPDATE worker_executions SET owner_epoch=NULL")
        self.assertEqual(self.run_collector()["agents"][0]["state"], "offline")

    def test_truncated_readable_roster_is_degraded_not_fully_connected(self):
        self.create_store(self.home)
        for index in range(128):
            self.create_profile(f"dev-fixture-{index:03d}", f"Fixture {index}")
        snapshot = self.run_collector()
        self.assertEqual(len(snapshot["agents"]), 128)
        self.assertTrue(all(a["state"] == "idle" for a in snapshot["agents"]))
        self.assertEqual(snapshot["sourceHealth"], "degraded")

    def test_roster_limit_is_reported_without_dropping_existing_agents(self):
        self.create_store(self.home)
        for index in range(129):
            (self.home / "profiles" / f"dev-fixture-{index:03d}").mkdir(parents=True)
        snapshot = self.run_collector()
        self.assertEqual(len(snapshot["agents"]), 128)
        self.assertTrue(any("limit" in warning.lower() for warning in snapshot["warnings"]))

    def test_bad_profile_stores_are_isolated_and_never_created(self):
        self.create_store(self.home)
        good = self.create_profile("dev-good", "Good")
        missing = self.create_profile("dev-missing", "Missing")
        (missing / "state.db").unlink()
        corrupt = self.create_profile("dev-corrupt", "Corrupt")
        (corrupt / "state.db").write_text("PRIVATE_BROKEN_DATABASE", encoding="utf-8")
        legacy = self.create_profile("dev-legacy", "Legacy")
        self.execute(legacy, "DROP TABLE session_turn_leases")
        now = time.time()
        self.execute(good, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                     ("fixture", os.getpid(), now, now, "dev-good", "host"))
        snapshot = self.run_collector()
        self.assertEqual({a["id"]: a["state"] for a in snapshot["agents"]}, {
            "default": "idle",
            "dev-good": "idle", "dev-missing": "offline", "dev-corrupt": "offline", "dev-legacy": "offline",
        })
        self.assertEqual(snapshot["sourceHealth"], "degraded")
        self.assertFalse((missing / "state.db").exists())
        self.assertNotIn("PRIVATE_", json.dumps(snapshot))
        self.assertNotIn(str(self.home), json.dumps(snapshot))

    def test_local_estop_is_scoped_and_budget_expiry_is_safe(self):
        from bridge.collect import read_profile
        self.create_store(self.home)
        first = self.create_profile("dev-first", "First")
        second = self.create_profile("dev-second", "Second")
        (first / "ESTOP").touch()
        snapshot = self.run_collector()
        self.assertEqual({a["id"]: a["state"] for a in snapshot["agents"]}, {
            "default": "idle", "dev-first": "paused", "dev-second": "idle",
        })
        self.assertEqual(read_profile(second, time.time(), time.monotonic() - 1, set()), ("offline", None, False, None))

    def test_uncertain_claims_are_not_idle_despite_healthy_gateway(self):
        self.create_store(self.home)
        now = time.time()
        for name in ["dev-expired", "dev-admission", "dev-worker", "dev-ended", "dev-compressed"]:
            path = self.create_profile(name, name)
            self.execute(self.home, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                         (name, os.getpid(), now, now, name, "host"))
            ended = now if name in {"dev-ended", "dev-compressed"} else None
            self.execute(path, "INSERT INTO sessions (id,source,profile_name,last_activity_at,ended_at,end_reason) VALUES (?,?,?,?,?,?)",
                         ("session", "desktop", name, now, ended, "compression" if name == "dev-compressed" else "completed"))
            if name in {"dev-expired", "dev-ended", "dev-compressed"}:
                self.execute(path, "INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                             ("session", f"pid={os.getpid()}:turn=fixture", now, now - 1 if name == "dev-expired" else now + 300))
            elif name == "dev-admission":
                self.execute(path, "INSERT INTO session_admissions VALUES (?,?,?,?,?)", ("session", "unknown", 1, 0, "PRIVATE_PAYLOAD"))
            else:
                self.execute(path, "INSERT INTO worker_executions VALUES (?,?,?,?,?)", ("session", "compute", 99, 0, "running"))
        snapshot = self.run_collector()
        self.assertEqual({a["id"]: a["state"] for a in snapshot["agents"]}, {
            "default": "idle",
            "dev-expired": "offline", "dev-admission": "offline", "dev-worker": "offline",
            "dev-ended": "idle", "dev-compressed": "working",
        })

    def test_sql_reader_denies_private_columns_and_writes(self):
        from bridge.collect import open_readonly
        self.create_store(self.home)
        with closing(open_readonly(self.home / "state.db", time.monotonic() + 2)) as connection:
            self.assertEqual(connection.execute("PRAGMA query_only").fetchone()[0], 1)
            connection.execute("SELECT id, source, last_activity_at FROM sessions").fetchall()
            for sql in [
                "SELECT content FROM messages", "SELECT title FROM sessions",
                "SELECT system_prompt FROM sessions", "SELECT last_activity_description FROM sessions",
                "SELECT payload_json FROM session_admissions", "SELECT * FROM sessions",
                "UPDATE sessions SET last_activity_at=0", "PRAGMA query_only=OFF",
                "ATTACH DATABASE ':memory:' AS extra",
            ]:
                with self.subTest(sql=sql):
                    with self.assertRaises(sqlite3.DatabaseError):
                        connection.execute(sql).fetchall()

    def test_worker_needs_fresh_current_running_execution(self):
        self.create_store(self.home)
        now = time.time()
        cases = [
            ("dev-worker", "running", 1, 2, now, None, "working"),
            ("dev-stale", "running", 1, 2, now - 1000, None, "offline"),
            ("dev-epoch", "running", 99, 2, now, None, "offline"),
            ("dev-generation", "running", 1, 99, now, None, "offline"),
            ("dev-terminal", "terminal", 1, 2, now, None, "idle"),
            ("dev-ended", "running", 1, 2, now, now, "idle"),
            ("dev-unknown", "unknown", 1, 2, now, None, "offline"),
        ]
        for name, status, epoch, generation, heartbeat, ended, _ in cases:
            path = self.create_profile(name, name)
            self.execute(self.home, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                         (name, os.getpid(), now, now, name, "host"))
            self.execute(path, "INSERT INTO sessions (id,source,profile_name,last_activity_at,runtime_generation,ended_at) VALUES (?,?,?,?,?,?)",
                         ("session", "kanban", name, heartbeat, 2, ended))
            self.execute(path, "INSERT INTO worker_executions VALUES (?,?,?,?,?)",
                         ("session", "kanban", epoch, generation, status))
        snapshot = self.run_collector()
        self.assertEqual({a["id"]: a["state"] for a in snapshot["agents"]},
                         {"default": "idle", **{case[0]: case[-1] for case in cases}})

    def test_only_matching_fresh_live_gateway_proves_backend_presence(self):
        self.create_store(self.home)
        self.create_profile("dev-ready", "Ready")
        now = time.time()
        self.execute(self.home, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                     ("ready", os.getpid(), now, now, "dev-ready", "host"))
        snapshot = self.run_collector()
        ready = next(a for a in snapshot["agents"] if a["id"] == "dev-ready")
        self.assertEqual(ready["state"], "idle")
        self.assertEqual(ready["activity"], "Fresh profile backend; no observed active turn.")
        self.assertEqual(snapshot["sourceHealth"], "connected")
        for name, pid, observed in [
            ("dev-stale", os.getpid(), now - 1000),
            ("dev-dead", 2147483647, now),
            ("dev-future", os.getpid(), now + 3600),
            ("dev-unobserved", None, now),
        ]:
            self.create_profile(name, name)
            if pid:
                self.execute(self.home, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                             (name, pid, now - 10, observed, name, "host"))
        self.execute(self.home, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                     ("main", os.getpid(), now, now, "default", "host"))
        snapshot = self.run_collector()
        self.assertEqual({a["id"]: a["state"] for a in snapshot["agents"]}, {
            "default": "idle", "dev-ready": "idle", "dev-stale": "idle", "dev-dead": "idle",
            "dev-future": "idle", "dev-unobserved": "idle",
        })
        self.assertTrue(all(a["activity"] == "Native profile readable; no verified in-flight work."
                            for a in snapshot["agents"] if a["id"] not in {"default", "dev-ready"}))
        self.assertEqual(snapshot["sourceHealth"], "connected")

    def test_estop_pauses_new_work_but_not_existing_turn(self):
        self.create_store(self.home)
        active = self.create_profile("dev-active", "Active")
        self.create_profile("dev-rest", "Rest")
        now = time.time()
        self.execute(active, "INSERT INTO sessions (id,source,profile_name,last_activity_at) VALUES (?,?,?,?)",
                     ("session", "desktop", "dev-active", now))
        self.execute(active, "INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                     ("session", f"pid={os.getpid()}:turn=fixture", now, now + 300))
        (self.home / "ESTOP").write_text("PRIVATE_PAUSE_REASON", encoding="utf-8")
        snapshot = self.run_collector()
        self.assertEqual({a["id"]: a["state"] for a in snapshot["agents"]},
                         {"default": "paused", "dev-active": "working", "dev-rest": "paused"})
        self.assertTrue(any("paused" in warning.lower() for warning in snapshot["warnings"]))
        self.assertNotIn("PRIVATE_", json.dumps(snapshot))
        (self.home / "ESTOP").unlink()
        (active / "ESTOP").touch()
        snapshot = self.run_collector()
        self.assertEqual({a["id"]: a["state"] for a in snapshot["agents"]},
                         {"default": "idle", "dev-active": "working", "dev-rest": "idle"})

    def test_only_current_live_holder_lease_proves_working(self):
        self.create_store(self.home)
        now = time.time()
        for name, pid, expiry in [
            ("dev-active", os.getpid(), now + 300),
            ("dev-expired", os.getpid(), now - 1),
            ("dev-dead", 2147483647, now + 300),
            ("dev-human", None, None),
        ]:
            path = self.create_profile(name, name)
            self.execute(path, "INSERT INTO sessions (id,source,profile_name,last_activity_at,title,system_prompt,last_activity_description) VALUES (?,?,?,?,?,?,?)",
                         ("session", "desktop", name, now, "PRIVATE_TASK", "PRIVATE_PROMPT", "PRIVATE_ACTIVITY"))
            if pid:
                self.execute(path, "INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                             ("session", f"pid={pid}:turn=fixture", now, expiry))
        snapshot = self.run_collector()
        states = {a["id"]: a["state"] for a in snapshot["agents"]}
        self.assertEqual(states, {"default": "idle", "dev-active": "working", "dev-expired": "offline", "dev-dead": "offline", "dev-human": "idle"})
        self.assertNotIn("PRIVATE_", json.dumps(snapshot))
        self.assertTrue(all(a["lastActiveAt"] for a in snapshot["agents"] if a["id"] != "default"))

    def test_roster_is_safe_metadata_and_inactive_without_work_evidence(self):
        self.create_store(self.home)
        expected = {
            "studio-lead": ("'Studio Lead'", "Studio Lead", "studio"),
            "dev-web": ('"Web Engineer"', "Web Engineer", "development"),
            "game-art": ("Game Artist", "Game Artist", "game"),
            "science-reviewer": ("Science Reviewer", "Science Reviewer", "science"),
        }
        for name, (scalar, _, _) in expected.items():
            self.create_profile(name, scalar)
        self.create_profile("unrelated-personal", "Personal")
        before = {p: p.read_bytes() for p in self.home.rglob("*") if p.is_file()}
        snapshot = self.run_collector()
        self.assertEqual({a["id"] for a in snapshot["agents"]}, set(expected) | {"default"})
        for agent in (a for a in snapshot["agents"] if a["id"] != "default"):
            self.assertEqual(agent["name"], expected[agent["id"]][1])
            self.assertEqual(agent["team"], expected[agent["id"]][2])
            self.assertEqual(agent["state"], "idle")
            self.assertIsNone(agent["lastActiveAt"])
            self.assertEqual(set(agent), {
                "id", "name", "role", "team", "state", "observedAt", "lastActiveAt", "activity",
            })
        encoded = json.dumps(snapshot)
        self.assertNotIn("PRIVATE_", encoded)
        self.assertNotIn(str(self.home), encoded)
        self.assertEqual({p: p.read_bytes() for p in self.home.rglob("*") if p.is_file()}, before)

    def test_missing_home_is_unavailable_without_creating_it(self):
        snapshot = self.run_collector()
        self.assertEqual(set(snapshot), {
            "schemaVersion", "mode", "source", "observedAt", "pollIntervalMs",
            "sourceHealth", "agents", "warnings",
        })
        self.assertEqual(snapshot["schemaVersion"], 1)
        self.assertEqual(snapshot["mode"], "live")
        self.assertEqual(snapshot["pollIntervalMs"], 30000)
        self.assertEqual(snapshot["sourceHealth"], "unavailable")
        self.assertEqual(snapshot["agents"], [])
        self.assertTrue(snapshot["warnings"])
        self.assertNotIn(str(self.home), json.dumps(snapshot))
        self.assertFalse(self.home.exists())


if __name__ == "__main__":
    unittest.main()
