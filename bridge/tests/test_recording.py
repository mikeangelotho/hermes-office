"""The optional meter samples only disposable, already-observed workers."""
import builtins
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import time
import unittest
from contextlib import ExitStack, closing
from pathlib import Path
from unittest.mock import patch

from bridge import collect as bridge
from bridge.tests import test_collect, test_participants


class ReadAudit:
    """Observe real SQLite prepares, bound IDs, authorizer accesses and returned cells, all fixture-only."""
    def __init__(self):
        self.queries = []
        self.columns = set()
        self.meter_cells = []

    @property
    def probes(self):
        return [(uri, sql, args) for uri, sql, args in self.queries if "tool_call_count" in sql]

    def collect(self, home, now, *, recording=False, deny=None, on_probe=None):
        audit, connect = self, sqlite3.connect

        class AuditedDB(sqlite3.Connection):
            uri: str

            def set_authorizer(self, authorizer_callback):
                if authorizer_callback is None:
                    return super().set_authorizer(None)
                def inspect(action, tbl, col, db, via):
                    if action == sqlite3.SQLITE_READ:
                        audit.columns.add((tbl, col))
                        if self.uri == deny and (tbl, col) == ("sessions", "tool_call_count"):
                            return sqlite3.SQLITE_DENY
                    return authorizer_callback(action, tbl, col, db, via)
                super().set_authorizer(inspect)

            def execute(self, sql, args=()):
                sql_key = " ".join(sql.lower().split())
                audit.queries.append((self.uri, sql_key, tuple(args)))
                meter = "tool_call_count" in sql_key
                if meter and on_probe:
                    on_probe(self.uri, args)
                cur = super().execute(sql, args)
                if meter:
                    factory = cur.row_factory

                    def inspect(cursor, row):
                        audit.meter_cells.append(row)
                        return factory(cursor, row) if factory else row
                    cur.row_factory = inspect
                return cur

        def open_db(database, **opts):
            db = connect(database, factory=AuditedDB, **opts)
            db.uri = database
            return db

        with patch.object(bridge.sqlite3, "connect", open_db), patch.object(bridge.time, "time", return_value=now):
            return bridge.collect(home, recording=recording)


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.fx = test_participants.ParticipantTests()
        self.addCleanup(self.fx.doCleanups)
        self.fx.setUp()
        self.home = self.fx.home

    def cli(self, *flags):
        result = subprocess.run(
            [sys.executable, "-I", "-B", str(test_collect.COLLECTOR), *flags],
            env={**os.environ, "HERMES_HOME": str(self.home)},
            capture_output=True, text=True, timeout=8,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(len(result.stdout.splitlines()), 1)
        return json.loads(result.stdout)

    def counter_column(self, path=None):
        self.fx.store.execute(path or self.home, "ALTER TABLE sessions ADD COLUMN tool_call_count INTEGER")

    def set_counter(self, sid, value, path=None):
        self.fx.store.execute(path or self.home, "UPDATE sessions SET tool_call_count=? WHERE id=?", (value, sid))

    def test_recording_without_native_counter_keeps_the_connected_legacy_roster(self):
        self.fx.proven_pair()  # The legacy sessions table has no tool_call_count column.
        public = self.cli()
        packet = self.cli("--recording")
        self.assertEqual(set(packet), {"snapshot", "meters"})
        self.assertEqual(packet["meters"], {})
        snap = packet["snapshot"]
        self.assertEqual(self.fx.pair_ids(snap), self.fx.pair_ids(public))
        self.assertEqual((snap["sourceHealth"], snap["warnings"]), ("connected", public["warnings"]))
        self.assertNotIn("meters", public)
        strict = ReadAudit()
        strict.collect(self.home, self.fx.now)
        self.assertEqual(strict.probes, [], "even failed prepares against an old schema are outside the default contract")

    def test_same_native_id_in_two_profiles_maps_only_to_its_own_visible_alias(self):
        self.fx.proven_pair()
        self.fx.worker("PRIVATE_PARENT")  # A worker and a lease for one ID are one sample.
        self.fx.lease("PRIVATE_CHILD")
        self.counter_column()
        self.fx.store.execute(self.home, "UPDATE sessions SET profile_name=NULL WHERE id='PRIVATE_PARENT'")
        self.set_counter("PRIVATE_PARENT", 37)
        self.set_counter("PRIVATE_CHILD", 0)
        peer = self.fx.store.create_profile("dev-peer", "Peer")
        self.fx.session("PRIVATE_PARENT", "desktop", path=peer, profile="")
        self.fx.lease("PRIVATE_PARENT", path=peer)
        self.counter_column(peer)
        self.set_counter("PRIVATE_PARENT", 8, peer)

        public = self.cli()
        actors = {(p["profileId"], p["kind"]): p["id"] for p in public["participants"]}
        expected = {actors["default", "session"]: 37, actors["default", "subagent"]: 0, actors["dev-peer", "session"]: 8}
        self.assertEqual(len(expected), 3)
        packet = self.cli("--recording")
        self.assertEqual(packet["meters"], expected)
        self.assertEqual(set(expected), {p["id"] for p in packet["snapshot"]["participants"]})
        for key in expected:
            self.assertRegex(key, r"^p-[0-9a-f]{32}$")
        self.assertNotIn("PRIVATE_", json.dumps(packet))

    def test_mixed_storage_types_return_only_safe_integer_cells_not_even_text_for_python_to_filter(self):
        # No affinity, so an integer-looking string remains TEXT and an integral-looking BLOB remains a BLOB.
        self.fx.store.execute(self.home, "ALTER TABLE sessions ADD COLUMN tool_call_count")
        values = [9007199254740991, 0, 9007199254740992, -1, None, 1.5, "123", b"456", "PRIVATE_TOOL_TEXT"]
        for i, value in enumerate(values):
            sid = f"PRIVATE_MIX_{i}"
            self.fx.session(sid, "desktop")
            self.fx.lease(sid)
            self.set_counter(sid, value)
        self.fx.store.execute(self.home, "UPDATE sessions SET tool_call_count=CAST(X'FF' AS TEXT) WHERE id='PRIVATE_MIX_4'")
        self.fx.session("PRIVATE_NULL", "desktop")
        self.fx.lease("PRIVATE_NULL")

        audit = ReadAudit()
        packet = audit.collect(self.home, self.fx.now, recording=True)
        self.assertEqual(packet["snapshot"]["sourceHealth"], "connected")
        self.assertEqual(len(packet["snapshot"]["participants"]), len(values) + 1)
        self.assertEqual(sorted(packet["meters"].values()), [0, 9007199254740991])
        self.assertCountEqual(audit.meter_cells, [(0,), (9007199254740991,)])
        self.assertNotIn("PRIVATE_", json.dumps(packet))

    def test_only_bound_verified_visible_ids_are_queried_not_the_aggregate_or_history(self):
        self.counter_column()
        self.fx.proven_pair()
        self.fx.lease("PRIVATE_CHILD")
        self.fx.worker("PRIVATE_PARENT")
        self.fx.worker("PRIVATE_PARENT")
        self.fx.session("PRIVATE_HISTORY", "desktop")
        self.fx.session("PRIVATE_UNTYPED", None)
        self.fx.lease("PRIVATE_UNTYPED")
        for bad_id in (b"PRIVATE_BLOB_ID", "", "X" * 1025):
            self.fx.session(bad_id, "desktop")
            self.fx.lease(bad_id)
        self.fx.session("PRIVATE_FOREIGN", "desktop", profile="dev-elsewhere")
        self.fx.lease("PRIVATE_FOREIGN")
        self.fx.session("PRIVATE_EXPIRED", "desktop")
        self.fx.lease("PRIVATE_EXPIRED", expiry=self.fx.now - 1)
        self.fx.session("PRIVATE_UNVERIFIED", "desktop")
        self.fx.worker("PRIVATE_UNVERIFIED", epoch=99)
        self.fx.session("PRIVATE_ENDED", "desktop", ended=self.fx.now, reason="completed")
        self.fx.lease("PRIVATE_ENDED")
        self.fx.session("PRIVATE_ANCHOR", "desktop", ended=self.fx.now, reason="compression")
        self.fx.lease("PRIVATE_ANCHOR")
        self.fx.session("PRIVATE_CONTINUATION", "subagent", "PRIVATE_ANCHOR")
        self.fx.worker("PRIVATE_CONTINUATION")
        self.fx.session("PRIVATE_PENDING", "desktop")
        self.fx.store.execute(self.home, "INSERT INTO session_admissions VALUES (?,?,?,?,?)",
                              ("PRIVATE_PENDING", "queued", 1, 2, "PRIVATE_ARGS"))
        self.fx.store.execute(self.home, "UPDATE sessions SET tool_call_count=97")
        self.set_counter("PRIVATE_PARENT", 1)
        self.set_counter("PRIVATE_CHILD", 2)

        # Refusing the extra column even if it exists must not affect (or be noticed by) the legacy reader.
        uri = (self.home / "state.db").resolve().as_uri() + "?mode=ro"
        old, new = ReadAudit(), ReadAudit()
        public = old.collect(self.home, self.fx.now, deny=uri)
        packet = new.collect(self.home, self.fx.now, recording=True)
        self.assertEqual(packet["snapshot"], public)  # Identical timestamps, rows, warnings and health.
        self.assertEqual(public["sourceHealth"], "degraded")
        self.assertEqual(old.probes, [])  # Also catches speculative LIMIT 0 / failed prepares.
        self.assertNotIn(("sessions", "tool_call_count"), old.columns)
        self.assertEqual(new.columns - old.columns, {("sessions", "tool_call_count")})
        self.assertEqual(new.queries, old.queries + new.probes, "finish the normal evidence and roster reads first")
        self.assertSetEqual({sql for _, sql, _ in old.queries if " from sessions " in sql}, {
            "select max(last_activity_at) from sessions where profile_name is null or profile_name in ('', ?)",
            "select source from sessions limit 0", "select parent_session_id from sessions limit 0",
        })  # No standalone read enumerates session history.
        self.assertCountEqual([args[0] for _, _, args in new.probes], ["PRIVATE_PARENT", "PRIVATE_CHILD"])
        for target, sql, args in new.probes:
            self.assertEqual(target, uri)
            self.assertIn("default", args)
            self.assertIn("?", sql)
            self.assertNotIn("private_", sql)
            self.assertIn("ended_at is null", sql)
        self.assertEqual(set(packet["meters"]), {p["id"] for p in public["participants"]})
        self.assertCountEqual(new.meter_cells, [(1,), (2,)])
        self.assertNotIn("PRIVATE_", json.dumps(packet))

    def test_truncated_group_has_no_counter_prepares_even_when_a_sibling_is_visible(self):
        self.counter_column()
        peer = self.fx.store.create_profile("dev-visible", "Visible")
        self.counter_column(peer)
        self.fx.session("PRIVATE_VISIBLE", "desktop", path=peer, profile=peer.name)
        self.fx.lease("PRIVATE_VISIBLE", path=peer)
        self.set_counter("PRIVATE_VISIBLE", 5, peer)
        with closing(sqlite3.connect(self.home / "state.db")) as db:
            ids = [f"PRIVATE_OVERFLOW_{i}" for i in range(128)]
            db.executemany("INSERT INTO sessions (id,source,profile_name,tool_call_count) VALUES (?,'desktop','default',89)",
                           ((sid,) for sid in ids))
            db.executemany("INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                           ((sid, self.fx.holder, self.fx.now, self.fx.now + 300) for sid in ids))
            db.commit()
        audit = ReadAudit()
        packet = audit.collect(self.home, self.fx.now, recording=True)
        snap = packet["snapshot"]
        self.assertEqual((snap["agents"][0]["activeSessions"], snap["sourceHealth"]), (128, "degraded"))
        visible, = snap["participants"]
        self.assertEqual(visible["profileId"], "dev-visible")
        self.assertEqual(packet["meters"], {visible["id"]: 5})
        self.assertEqual([args[0] for _, _, args in audit.probes], ["PRIVATE_VISIBLE"])

    def test_denied_optional_source_does_not_cost_presence_or_a_peers_meter(self):
        self.fx.proven_pair()
        self.counter_column()
        peer = self.fx.store.create_profile("dev-readable", "Readable")
        self.counter_column(peer)
        self.fx.session("PRIVATE_CHILD", "desktop", path=peer, profile=peer.name)
        self.fx.lease("PRIVATE_CHILD", path=peer)
        self.set_counter("PRIVATE_CHILD", 36, peer)
        self.set_counter("PRIVATE_CHILD", 98)
        public = ReadAudit().collect(self.home, self.fx.now)
        self.assertEqual(public["sourceHealth"], "connected")
        uri = (self.home / "state.db").resolve().as_uri() + "?mode=ro"
        audit = ReadAudit()
        packet = audit.collect(self.home, self.fx.now, recording=True, deny=uri)
        self.assertEqual(packet["snapshot"], public)
        self.assertTrue(any(target == uri for target, _, _ in audit.probes))
        peer_id, = [p["id"] for p in public["participants"] if p["profileId"] == peer.name]
        self.assertEqual(packet["meters"], {peer_id: 36})

    def test_counter_reset_and_disappearance_are_raw_observations_without_local_state(self):
        self.fx.session("PRIVATE_LEASED", "desktop")
        self.fx.lease("PRIVATE_LEASED")
        self.counter_column()
        actor, = self.cli()["participants"]

        def fixture_digest():
            with (self.home / "state.db").open("rb") as stream:
                return hashlib.file_digest(stream, "sha256").digest()

        for value in (7, 11, 2, 0, None):
            with self.subTest(value=value):
                self.set_counter("PRIVATE_LEASED", value)
                before = fixture_digest()
                packet = self.cli("--recording")
                self.assertEqual(packet["meters"], {} if value is None else {actor["id"]: value})
                self.assertEqual(packet["snapshot"]["sourceHealth"], "connected")
                self.assertEqual(fixture_digest(), before)
                self.assertEqual(list(self.home.iterdir()), [self.home / "state.db"])

    def test_one_failed_lookup_does_not_hide_another_verified_worker_in_the_same_store(self):
        self.fx.proven_pair()
        self.counter_column()
        self.set_counter("PRIVATE_PARENT", 33)
        self.set_counter("PRIVATE_CHILD", 11)
        public = ReadAudit().collect(self.home, self.fx.now)
        _, child = self.fx.pair_ids(public)

        def one_bad_row(_uri, args):
            if args[0] == "PRIVATE_PARENT":
                raise sqlite3.OperationalError("PRIVATE_FIXTURE_READ_ERROR")

        packet = ReadAudit().collect(self.home, self.fx.now, recording=True, on_probe=one_bad_row)
        self.assertEqual(packet["snapshot"], public)
        self.assertEqual(packet["meters"], {child: 11})

    def test_meter_timeout_does_not_age_or_degrade_the_good_roster(self):
        self.fx.proven_pair()
        self.counter_column()
        self.fx.store.execute(self.home, "UPDATE sessions SET tool_call_count=3")
        public = ReadAudit().collect(self.home, self.fx.now)
        clock, elapsed = time.monotonic, 0

        def interrupt(_uri, _args):
            nonlocal elapsed
            elapsed = 10
            raise sqlite3.OperationalError("interrupted")

        audit = ReadAudit()
        with patch.object(bridge.time, "monotonic", lambda: clock() + elapsed):
            packet = audit.collect(self.home, self.fx.now, recording=True, on_probe=interrupt)
        self.assertEqual(len(audit.probes), 1)
        self.assertEqual(public["sourceHealth"], "connected")
        self.assertEqual(packet, {"snapshot": public, "meters": {}})

    def test_meter_and_worker_evidence_cannot_straddle_a_native_commit(self):
        self.fx.session("PRIVATE_ENDING", "desktop")
        self.fx.lease("PRIVATE_ENDING")
        self.counter_column()
        self.set_counter("PRIVATE_ENDING", 9)
        with closing(sqlite3.connect(self.home / "state.db")) as writer:
            self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            commits = []

            def end_before_probe(_uri, _args):
                writer.execute("UPDATE sessions SET ended_at=?, end_reason='completed', tool_call_count=43", (self.fx.now,))
                writer.commit()
                commits.append(True)

            packet = ReadAudit().collect(self.home, self.fx.now, recording=True, on_probe=end_before_probe)
        self.assertEqual(commits, [True])
        actor, = packet["snapshot"]["participants"]
        self.assertEqual(packet["meters"], {actor["id"]: 9})
        after = self.cli("--recording")
        self.assertNotIn("participants", after["snapshot"])
        self.assertEqual(after["meters"], {})

    def test_both_sql_policies_deny_actual_private_columns_and_no_default_counter_access(self):
        self.counter_column()
        with closing(sqlite3.connect(self.home / "state.db")) as writer:
            writer.executescript("""
                ALTER TABLE sessions ADD COLUMN tool_names TEXT;
                ALTER TABLE sessions ADD COLUMN prompt TEXT;
                CREATE TABLE tool_calls(name TEXT, args TEXT, result TEXT, path TEXT);
                INSERT INTO tool_calls VALUES ('PRIVATE_TOOL','PRIVATE_ARGS','PRIVATE_RESULT','PRIVATE_PATH');
                CREATE TABLE logs(content TEXT);
                INSERT INTO logs VALUES ('PRIVATE_LOG');
                INSERT INTO sessions (id,tool_names,prompt,tool_call_count) VALUES ('PRIVATE_ID','PRIVATE_NAMES','PRIVATE_PROMPT',4);
            """)
        with closing(bridge.open_readonly(self.home / "state.db", time.monotonic() + 2)) as db:
            counter = "SELECT tool_call_count FROM sessions WHERE id=?"
            with self.assertRaises(sqlite3.DatabaseError) as denied:
                db.execute(counter, ("PRIVATE_ID",))
            self.assertEqual(denied.exception.sqlite_errorcode, sqlite3.SQLITE_AUTH)
            for policy in (bridge.authorize_read, bridge.authorize_meter):
                db.set_authorizer(policy)
                for sql in ("SELECT tool_names FROM sessions", "SELECT prompt FROM sessions",
                            "SELECT system_prompt FROM sessions", "SELECT content FROM messages", "SELECT count(*) FROM messages",
                            "SELECT name,args,result,path FROM tool_calls", "SELECT content FROM logs",
                            "SELECT payload_json FROM session_admissions", "SELECT * FROM sessions", "SELECT sql FROM sqlite_schema",
                            "PRAGMA table_info(sessions)", "UPDATE sessions SET tool_call_count=0", "ATTACH ':memory:' AS extra"):
                    with self.subTest(policy=policy.__name__, sql=sql):
                        with self.assertRaises(sqlite3.DatabaseError) as denied:
                            db.execute(sql)
                        # SQLite uses SQLITE_ERROR for denial at the function boundary (e.g. count),
                        # SQLITE_AUTH for denied table/column access. Missing tables/columns don't pass.
                        self.assertTrue(denied.exception.sqlite_errorcode == sqlite3.SQLITE_AUTH
                                        or str(denied.exception).startswith("not authorized to use function:"))
            self.assertEqual(db.execute(counter, ("PRIVATE_ID",)).fetchone()[0], 4)  # Positive control for metering policy.

    def test_files_and_stores_are_allowlisted_even_when_private_logs_and_dumps_exist(self):
        self.fx.proven_pair()
        self.counter_column()
        self.set_counter("PRIVATE_CHILD", 12)
        peer = self.fx.store.create_profile("dev-visible", "Visible")
        status = self.home / "gateway_state.json"
        status.write_text(json.dumps({"kind": "hermes-gateway", "pid": os.getpid(),
                          "start_time": bridge.process_fingerprint(os.getpid()), "updated_at": self.fx.now,
                          "gateway_state": "running", "session_store": {"status": "ok"}, "hermes_home": str(self.home),
                          "argv": ["PRIVATE_COMMAND"], "active_agents": {"personal": "PRIVATE_TASK"}}), encoding="utf-8")
        for directory in (self.home, peer):
            for rel in (".env", "auth.json", "config.yaml", "gateway.log", "logs/gateway.log", "sessions/history.jsonl"):
                sentinel = directory / rel
                sentinel.parent.mkdir(parents=True, exist_ok=True)
                sentinel.write_text("PRIVATE_MUST_NOT_OPEN", encoding="utf-8")
        inputs, scans = set(), set()

        def watch(fn, seen):
            def call(path, *args, **kwargs):
                if not isinstance(path, int) and Path(path).is_relative_to(self.home):
                    seen.add(Path(path))  # Before opening: even swallowed errors count as an attempt.
                return fn(path, *args, **kwargs)
            return call

        audit = ReadAudit()
        with ExitStack() as hooks:
            for module, key, seen in ((io, "open", inputs), (builtins, "open", inputs), (os, "open", inputs),
                                      (os, "scandir", scans), (os, "listdir", scans)):
                hooks.enter_context(patch.object(module, key, watch(getattr(module, key), seen)))
            packet = audit.collect(self.home, self.fx.now, recording=True)
        self.assertEqual(inputs, {status, peer / "profile.yaml"})
        self.assertEqual(scans, {self.home / "profiles"})
        self.assertEqual({uri for uri, _, _ in audit.queries},
                         {(root / "state.db").resolve().as_uri() + "?mode=ro" for root in (peer, self.home)})
        self.assertEqual(packet["snapshot"]["sourceHealth"], "connected")
        self.assertEqual(list(packet["meters"].values()), [12])
        for private in ("PRIVATE_", "pid=", str(self.home)):
            self.assertNotIn(private, json.dumps(packet))
