"""Participant telemetry runs against disposable stores, never the native writer."""
import json
import os
import sqlite3
import sys
import time
import unittest
from contextlib import closing
from unittest.mock import patch

from bridge.tests import test_collect


class ParticipantTests(unittest.TestCase):
    def setUp(self):
        self.store = test_collect.CollectorTests()
        self.addCleanup(self.store.doCleanups)
        self.store.setUp()
        self.home = self.store.home
        self.store.create_store(self.home)
        self.now = time.time()
        namespace = (":" + os.readlink("/proc/self/ns/pid").replace("pid:[", "pidns=").rstrip("]")
                     if sys.platform == "linux" else "")
        self.holder = f"pid={os.getpid()}{namespace}:turn=PRIVATE_HOLDER:platform=desktop"

    def session(self, sid, source, parent=None, *, path=None, profile="default", ended=None, reason=None):
        self.store.execute(path or self.home,
                           "INSERT INTO sessions (id,source,profile_name,parent_session_id,ended_at,end_reason,"
                           "last_activity_at,runtime_generation,title,system_prompt,last_activity_description) "
                           "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                           (sid, source, profile, parent, ended, reason, self.now, 2,
                            "PRIVATE_TITLE", "PRIVATE_PROMPT", "PRIVATE_OUTPUT"))

    def lease(self, sid, *, path=None, expiry=None, holder=None):
        self.store.execute(path or self.home, "INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                           (sid, holder or self.holder, self.now, self.now + 300 if expiry is None else expiry))

    def worker(self, sid, *, epoch=1):
        self.store.execute(self.home, "INSERT INTO worker_executions VALUES (?,?,?,?,?)",
                           (sid, "compute", epoch, 2, "running"))

    def heartbeat(self):
        self.store.execute(self.home, "INSERT INTO gateway_heartbeats VALUES (?,?,?,?,?,?)",
                           ("PRIVATE_BACKEND", os.getpid(), self.now, self.now, "default", "host"))

    def test_one_parent_and_two_proven_children_are_three_stable_workers(self):
        root, first, second = "PRIVATE_PARENT", "PRIVATE_CHILD_1", "PRIVATE_CHILD_2"
        self.heartbeat()
        self.session(root, "desktop")
        self.lease(root)
        for child in (first, second):
            self.session(child, "subagent", root)
            self.worker(child)
        self.lease(first)
        self.worker(first)  # two execution claims plus a lease still represent one child
        before = self.store.run_collector()
        people = before.get("participants", [])
        self.assertEqual(len(people), 3, "one observed parent and two observed children, not an extra profile")
        self.assertEqual([(a["id"], a["activeSessions"]) for a in before["agents"]], [("default", 3)])
        parent, = (p for p in people if p["kind"] == "session")
        children = [p for p in people if p["kind"] == "subagent"]
        self.assertNotIn("parentId", parent)
        self.assertEqual([p["parentId"] for p in children], [parent["id"], parent["id"]])
        self.assertEqual(len({p["id"] for p in people}), 3)
        for p in people:
            self.assertEqual((p["profileId"], p["team"], p["state"], p["observedAt"]),
                             ("default", "general", "working", before["observedAt"]))
            self.assertRegex(p["name"], r"^(Session|Subagent) [A-F0-9]{6}$")
            self.assertNotIn("activeSessions", p)
        for private in ("PRIVATE_", "pid=", "platform=", str(self.home)):
            self.assertNotIn(private, json.dumps(before))

        self.store.execute(self.home, "UPDATE sessions SET ended_at=?,end_reason='completed' WHERE id=?",
                           (self.now, first))  # retained lease and running rows must not resurrect the child
        after = self.store.run_collector()
        self.assertEqual(after["agents"][0]["activeSessions"], 2)
        remaining = {(p["id"], p["name"], p.get("parentId")) for p in after["participants"]}
        self.assertEqual(len(remaining), 2)
        self.assertIn((parent["id"], parent["name"], None), remaining)
        self.assertLess(remaining, {(p["id"], p["name"], p.get("parentId")) for p in people})

    def proven_pair(self):
        self.heartbeat()
        self.session("PRIVATE_PARENT", "desktop")
        self.lease("PRIVATE_PARENT")
        self.session("PRIVATE_CHILD", "subagent", "PRIVATE_PARENT")
        self.worker("PRIVATE_CHILD")

    def pair_ids(self, snapshot, *other_profiles):
        self.assertEqual([a["id"] for a in snapshot["agents"]], ["default", *other_profiles])
        agent = snapshot["agents"][0]
        self.assertEqual((agent["state"], agent["activeSessions"]), ("working", 2))
        people = snapshot["participants"]
        self.assertEqual(sorted(p["kind"] for p in people), ["session", "subagent"])
        parent, child = sorted(people, key=lambda p: p["kind"])
        self.assertNotEqual(parent["id"], child["id"])
        self.assertNotIn("parentId", parent)
        self.assertEqual(child["parentId"], parent["id"])
        self.assertNotIn("PRIVATE_", json.dumps(snapshot))
        return parent["id"], child["id"]

    def test_independent_unverified_worker_is_partial_but_overlapping_claims_are_not(self):
        self.proven_pair()
        self.worker("PRIVATE_PARENT", epoch=99)  # This session already has an independently verified lease.
        self.worker("PRIVATE_CHILD", epoch=99)  # A verified running execution also covers its own session.
        self.lease("PRIVATE_CHILD", holder="PRIVATE_UNVERIFIED_HOLDER")  # Lease read before its verified worker.
        self.session("PRIVATE_EXPIRED", "desktop")
        self.lease("PRIVATE_EXPIRED", expiry=self.now - 1)
        self.session("PRIVATE_OTHER", "subagent", "PRIVATE_PARENT")  # Retained history alone is not a claim.
        complete = self.store.run_collector()
        known = self.pair_ids(complete)
        self.assertEqual(complete["sourceHealth"], "connected")

        self.store.execute(self.home, "INSERT INTO worker_executions VALUES (?,?,?,?,?)",
                           ("PRIVATE_OTHER", "compute", 1, 2, "unknown"))
        partial = self.store.run_collector()
        self.assertEqual(self.pair_ids(partial), known)
        self.assertEqual(partial["sourceHealth"], "degraded", "a proven lease cannot cover a different worker")
        self.assertIn("Some participant details are unavailable; the roster may show aggregate or partial activity.",
                      partial["warnings"])

    def test_only_independent_open_matching_admissions_make_working_coverage_partial(self):
        self.proven_pair()
        self.session("PRIVATE_OTHER", "subagent", "PRIVATE_PARENT")
        self.session("PRIVATE_CLOSED", "desktop", ended=self.now, reason="completed")
        self.session("PRIVATE_FOREIGN", "desktop", profile="dev-other")
        for sid, status in [("PRIVATE_PARENT", "started"), ("PRIVATE_PARENT", "queued"), ("PRIVATE_CHILD", "unknown"),
                            ("PRIVATE_CLOSED", "queued"), ("PRIVATE_FOREIGN", "started"),
                            ("PRIVATE_MISSING", "unknown"), ("PRIVATE_OTHER", "expired")]:
            self.store.execute(self.home, "INSERT INTO session_admissions VALUES (?,?,?,?,?)",
                               (sid, status, 1, 2, "PRIVATE_PAYLOAD"))
        complete = self.store.run_collector()
        known = self.pair_ids(complete)
        self.assertEqual(complete["sourceHealth"], "connected")

        for status in ("queued", "started", "unknown"):
            with self.subTest(status=status):
                self.store.execute(self.home, "UPDATE session_admissions SET status=? WHERE target_session_id=?",
                                   (status, "PRIVATE_OTHER"))
                partial = self.store.run_collector()
                self.assertEqual(self.pair_ids(partial), known)
                self.assertEqual(partial["sourceHealth"], "degraded", "a pending admission is not another verified turn")
                self.assertIn("Some participant details are unavailable; the roster may show aggregate or partial activity.",
                              partial["warnings"])
        self.store.execute(self.home, "UPDATE sessions SET ended_at=?,end_reason='completed' WHERE id=?",
                           (self.now, "PRIVATE_OTHER"))
        closed = self.store.run_collector()
        self.assertEqual(self.pair_ids(closed), known)
        self.assertEqual(closed["sourceHealth"], "connected")

    def test_paused_profile_with_a_separate_unverified_claim_cannot_borrow_coverage(self):
        self.proven_pair()
        other = self.store.create_profile("dev-paused", "Paused")
        self.session("PRIVATE_PARENT", "desktop", path=other, profile=other.name)  # Same key, different store.
        (other / "ESTOP").touch()
        complete = self.store.run_collector()
        known = self.pair_ids(complete, "dev-paused")
        self.assertEqual(complete["sourceHealth"], "connected")
        self.lease("PRIVATE_PARENT", path=other, holder="PRIVATE_UNVERIFIED_HOLDER")
        partial = self.store.run_collector()
        self.assertEqual(self.pair_ids(partial, "dev-paused"), known)
        self.assertEqual(partial["agents"][1]["state"], "paused")
        self.assertEqual(partial["sourceHealth"], "degraded")

    def test_absent_optional_roster_is_complete_but_denied_enumeration_is_partial(self):
        from bridge.collect import collect
        self.proven_pair()
        profiles = self.home / "profiles"
        self.assertFalse(profiles.exists())
        missing = self.store.run_collector()
        known = self.pair_ids(missing)
        self.assertEqual(missing["sourceHealth"], "connected")
        self.store.create_profile("dev-present", "Present")
        accessible = self.store.run_collector()
        self.assertEqual([a["id"] for a in accessible["agents"]], ["default", "dev-present"])
        self.assertEqual(accessible["sourceHealth"], "connected")

        # A privileged test user may bypass real permission bits. Inject only the failed directory open.
        with patch("bridge.collect.os.scandir", side_effect=PermissionError("PRIVATE_DENIAL")) as scan:
            denied = collect(self.home)
        scan.assert_called_once_with(profiles)
        self.assertEqual(self.pair_ids(denied), known)
        self.assertEqual(denied["sourceHealth"], "degraded", "an unreadable roster is not an empty one")
        self.assertIn("Some status stores could not be read; results are partial.", denied["warnings"])

    def test_interrupted_roster_keeps_profiles_already_returned_by_the_directory(self):
        from bridge.collect import collect
        profile = self.store.create_profile("dev-seen", "Seen")
        self.session("PRIVATE_SEEN", "desktop", path=profile, profile=profile.name)
        self.lease("PRIVATE_SEEN", path=profile)
        complete = self.store.run_collector()
        known, = complete["participants"]
        self.assertEqual((complete["sourceHealth"], known["profileId"]), ("connected", "dev-seen"))

        with os.scandir(profile.parent) as directory:
            def interrupted():
                yield next(directory)
                raise FileNotFoundError("PRIVATE_ITERATION_ERROR")  # Not an absent optional roster.
            with patch("bridge.collect.os.scandir", return_value=closing(interrupted())) as scan:
                partial = collect(self.home)
        scan.assert_called_once_with(profile.parent)
        self.assertEqual(partial["sourceHealth"], "degraded")
        self.assertEqual([a["id"] for a in partial["agents"]], ["default", "dev-seen"])
        self.assertEqual([p["id"] for p in partial["participants"]], [known["id"]])
        self.assertIn("Some status stores could not be read; results are partial.", partial["warnings"])
        self.assertNotIn("PRIVATE_", json.dumps(partial))

    @staticmethod
    def link_directory(link, target):
        if os.name == "nt":
            import _winapi  # A real directory junction needs no symlink privilege on Windows.
            _winapi.CreateJunction(str(target), str(link))
        else:
            link.symlink_to(target, target_is_directory=True)

    def test_linked_roster_is_partial_and_its_target_is_not_observed(self):
        self.proven_pair()
        known = self.pair_ids(self.store.run_collector())
        self.store.create_profile("dev-foreign", "PRIVATE_LINK_TARGET")
        profiles = self.home / "profiles"
        target = profiles.rename(self.home.parent / "PRIVATE_ROSTER")
        self.link_directory(profiles, target)
        partial = self.store.run_collector()
        self.assertEqual(self.pair_ids(partial), known)
        self.assertEqual(partial["sourceHealth"], "degraded")
        self.assertIn("Some status stores could not be read; results are partial.", partial["warnings"])

    def test_a_linked_eligible_profile_is_partial_but_its_sibling_remains_observable(self):
        good = self.store.create_profile("dev-good", "Good")
        self.session("PRIVATE_GOOD", "desktop", path=good, profile=good.name)
        self.lease("PRIVATE_GOOD", path=good)
        complete = self.store.run_collector()
        known, = complete["participants"]
        self.assertEqual((complete["sourceHealth"], known["profileId"]), ("connected", "dev-good"))
        link = self.store.create_profile("dev-foreign", "PRIVATE_LINK_TARGET")
        self.link_directory(link, link.rename(self.home.parent / "PRIVATE_TARGET"))
        partial = self.store.run_collector()
        self.assertEqual([a["id"] for a in partial["agents"]], ["default", "dev-good"])
        self.assertEqual([p["id"] for p in partial["participants"]], [known["id"]])
        self.assertNotIn("PRIVATE_", json.dumps(partial))
        self.assertEqual(partial["sourceHealth"], "degraded")

    def test_only_verified_typed_turns_render_and_history_does_not_supply_a_parent(self):
        history = "PRIVATE_HISTORY"
        self.heartbeat()
        self.session(history, "desktop")
        self.session("PRIVATE_ORPHAN", "subagent", history)
        self.lease("PRIVATE_ORPHAN")
        self.session("PRIVATE_FORK", "desktop", history)
        self.lease("PRIVATE_FORK")  # separately leased; lineage alone is not delegation
        for sid in ("PRIVATE_EXPIRED", "PRIVATE_DEAD", "PRIVATE_UNVERIFIED", "PRIVATE_MISSING_SOURCE"):
            self.session(sid, None if sid == "PRIVATE_MISSING_SOURCE" else "subagent", history)
        self.lease("PRIVATE_EXPIRED", expiry=self.now - 1)
        self.lease("PRIVATE_DEAD", holder="pid=2147483647:turn=PRIVATE_DEAD_HOLDER")
        self.worker("PRIVATE_UNVERIFIED", epoch=98)
        self.lease("PRIVATE_MISSING_SOURCE")
        snap = self.store.run_collector()
        self.assertEqual(sorted(p["kind"] for p in snap.get("participants", [])), ["session", "subagent"])
        self.assertTrue(all("parentId" not in p for p in snap["participants"]))
        self.assertEqual(snap["agents"][0]["activeSessions"], 3, "legacy count still has the unclassified lease")
        self.assertEqual(snap["sourceHealth"], "degraded", "missing identity coverage is partial, not fully observed")
        self.assertTrue(any("participant" in w.lower() for w in snap["warnings"]))
        self.assertNotIn("PRIVATE_", json.dumps(snap))

    def test_large_group_remains_one_aggregate_not_a_silently_truncated_group(self):
        self.store.create_profile("dev-rest", "Rest")
        with closing(sqlite3.connect(self.home / "state.db")) as db:
            ids = [f"PRIVATE_{i}" for i in range(128)]
            db.executemany("INSERT INTO sessions (id,source,profile_name,last_activity_at) VALUES (?,'desktop','default',?)",
                           [(sid, self.now) for sid in ids])
            db.executemany("INSERT INTO session_turn_leases VALUES (?,?,?,?)",
                           [(sid, self.holder, self.now, self.now + 300) for sid in ids])
            db.commit()
        snap = self.store.run_collector()
        self.assertEqual(snap["agents"][0]["activeSessions"], 128)
        self.assertEqual(len(snap.get("participants", [])), 0, "128 sessions plus one other profile exceeds the render budget")
        self.assertEqual(snap["sourceHealth"], "degraded")
        self.assertTrue(any("participant" in w.lower() for w in snap["warnings"]))
        self.store.execute(self.home, "DELETE FROM session_turn_leases WHERE conversation_id=?", (ids[-1],))
        exact = self.store.run_collector()
        self.assertEqual(len(exact["participants"]), 127)
        self.assertEqual(exact["sourceHealth"], "connected")

    def test_independent_sessions_and_an_orphan_worker_stay_distinct_across_profiles(self):
        self.heartbeat()
        other = self.store.create_profile("dev-team", "Team")
        sid = "PRIVATE_REUSED_ID"
        for path, owner in [(self.home, "default"), (other, "dev-team")]:
            self.session(sid, "desktop", path=path, profile=owner)
            self.lease(sid, path=path)
        self.session("PRIVATE_SECOND_SESSION", "desktop")
        self.lease("PRIVATE_SECOND_SESSION")
        self.session("PRIVATE_CHILD", "subagent", "PRIVATE_ABSENT_PARENT")
        self.worker("PRIVATE_CHILD")  # verified execution, with no corresponding lease or observable parent
        snap = self.store.run_collector()
        people = snap.get("participants", [])
        self.assertEqual(len({p["id"] for p in people}), 4)
        self.assertEqual(sorted((p["profileId"], p["kind"]) for p in people),
                         [("default", "session"), ("default", "session"), ("default", "subagent"), ("dev-team", "session")])
        self.assertTrue(all("parentId" not in p for p in people))
        self.assertEqual(snap["agents"][0]["activeSessions"], 3)
        self.assertNotIn("PRIVATE_", json.dumps(snap))

    def test_unavailable_optional_source_keeps_verified_aggregate_not_a_guessed_kind(self):
        self.session("PRIVATE_SESSION", "desktop")
        self.lease("PRIVATE_SESSION")
        self.store.execute(self.home, "ALTER TABLE sessions DROP COLUMN source")
        snap = self.store.run_collector()
        self.assertEqual(snap["agents"][0]["state"], "working")
        self.assertEqual(snap["agents"][0]["activeSessions"], 1)
        self.assertEqual(snap.get("participants", []), [])
        self.assertEqual(snap["sourceHealth"], "degraded")

    def test_cyclic_native_links_do_not_invalidate_verified_people_or_other_teams(self):
        self.session("PRIVATE_A", "subagent", "PRIVATE_B")
        self.session("PRIVATE_B", "subagent", "PRIVATE_A")
        for sid in ("PRIVATE_A", "PRIVATE_B"):
            self.lease(sid)
        other = self.store.create_profile("dev-team", "Team")
        self.session("PRIVATE_SELF", "subagent", "PRIVATE_SELF", path=other, profile="dev-team")
        self.lease("PRIVATE_SELF", path=other)
        snap = self.store.run_collector()
        self.assertEqual(len(snap.get("participants", [])), 3)
        self.assertTrue(all("parentId" not in p for p in snap["participants"]), "drop unsafe edges, not real workers")
        self.assertEqual(snap["sourceHealth"], "degraded")

    def test_missing_parent_metadata_does_not_discard_independently_leased_turns(self):
        self.heartbeat()
        self.session("PRIVATE_PARENT", "desktop")
        self.session("PRIVATE_CHILD", "subagent", "PRIVATE_PARENT")
        self.lease("PRIVATE_PARENT")
        self.lease("PRIVATE_CHILD")
        self.session("PRIVATE_AMBIGUOUS", "desktop", "PRIVATE_PARENT")
        self.worker("PRIVATE_AMBIGUOUS")
        self.store.execute(self.home, "ALTER TABLE sessions DROP COLUMN parent_session_id")
        snap = self.store.run_collector()
        self.assertEqual(sorted(p["kind"] for p in snap.get("participants", [])), ["session", "subagent"])
        self.assertTrue(all("parentId" not in p for p in snap["participants"]))
        self.assertNotIn("activeSessions", snap["agents"][0], "worker lineage cannot be counted exactly")
        self.assertEqual(snap["sourceHealth"], "degraded")

    def test_compression_anchors_do_not_become_people_or_extra_subagents(self):
        self.heartbeat()
        self.session("PRIVATE_ANCHOR", "subagent", ended=self.now, reason="compression")
        self.lease("PRIVATE_ANCHOR")
        self.session("PRIVATE_CONTINUATION", "subagent", "PRIVATE_ANCHOR")
        self.worker("PRIVATE_CONTINUATION")
        self.session("PRIVATE_INDEPENDENT", "desktop")
        self.lease("PRIVATE_INDEPENDENT")
        snap = self.store.run_collector()
        self.assertEqual([p["kind"] for p in snap.get("participants", [])], ["session"])
        self.assertEqual(snap["agents"][0]["state"], "working")
        self.assertNotIn("activeSessions", snap["agents"][0])
        self.assertEqual(snap["sourceHealth"], "degraded")

    def test_same_native_key_on_a_replacement_installation_does_not_reuse_a_public_alias(self):
        def alias():
            self.session("PRIVATE_SHARED_ID", "desktop")
            self.lease("PRIVATE_SHARED_ID")
            return self.store.run_collector()["participants"][0]["id"]

        first = alias()
        self.home.rename(self.home.with_name("old-installation"))
        self.store.create_store(self.home)  # same path and session identifier, distinct local installation
        self.assertNotEqual(first, alias())
