"""Read-only, content-free projection of local Hermes runtime evidence.

No Hermes imports: those may initialize or migrate application-owned state.
"""
from __future__ import annotations

from collections.abc import Callable
from contextlib import ExitStack, closing
from datetime import datetime, timezone
import hashlib
import json
import math
from itertools import islice
import os
from pathlib import Path
import re
import socket
import sqlite3
import stat
import sys
import time

TEAM_PREFIXES = {"studio": "studio", "dev": "development", "game": "game", "science": "science"}
PROFILE_ID = re.compile(r"(studio|dev|game|science)-[a-z0-9]+(?:-[a-z0-9]+)*\Z")
MAX_RUNTIME_ROWS = 10000
MAX_ROSTER = 128
MAX_TOOL_COUNT = (1 << 53) - 1  # Largest losslessly representable JavaScript safe integer.
SAFE_COLUMNS = {
    "sessions": {"id", "source", "profile_name", "parent_session_id", "ended_at", "end_reason", "last_activity_at", "runtime_generation"},
    "gateway_heartbeats": {"pid", "started_at", "last_heartbeat", "profile", "host"},
    "session_turn_leases": {"conversation_id", "holder", "acquired_at", "expires_at"},
    "worker_executions": {"session_id", "kind", "owner_epoch", "generation", "status"},
    "runtime_epoch": {"singleton", "epoch"},
    "session_admissions": {"target_session_id", "status", "owner_epoch", "generation"},
}


def authorize_read(action, table, column, database, _trigger):
    if action == sqlite3.SQLITE_SELECT:
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_READ and database == "main" and table in SAFE_COLUMNS:
        return sqlite3.SQLITE_OK if column in SAFE_COLUMNS[table] or column == "" else sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and column in {"max", "count"}:
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_PRAGMA and table == "query_only" and column is None:
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def default_home() -> Path:
    configured = os.environ.get("HERMES_HOME")
    if configured:
        home = Path(configured).expanduser().resolve()
        return home.parent.parent if home.parent.name == "profiles" else home
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "hermes"
    return Path.home() / ".hermes"


def display_name(profile: Path) -> str:
    fallback = profile.name.replace("-", " ").title()
    metadata = profile / "profile.yaml"
    try:
        if metadata.is_symlink() or metadata.stat().st_size > 16384:
            return fallback
        with metadata.open(encoding="utf-8-sig") as stream:
            text = stream.read(16385)
        if len(text) > 16384:
            return fallback
        for line in text.splitlines():
            if not line.startswith("display_name:"):
                continue
            value = line.partition(":")[2].strip()
            if value.startswith('"'):
                value = json.loads(value)
            elif value.startswith("'") and value.endswith("'"):
                value = value[1:-1].replace("''", "'")
            else:
                value = value.split(" #", 1)[0].strip()
            if (isinstance(value, str) and 0 < len(value) <= 80
                    and all(c.isprintable() for c in value)
                    and not any(c in value for c in "\\/:<>{}[]@")):
                return value
    except (OSError, ValueError):
        pass
    return fallback


def process_alive(pid: int) -> bool | None:
    """Probe only. Never use os.kill(pid, 0) on Windows (it can signal a console)."""
    if not 0 < pid <= 2147483647:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel.GetExitCodeProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False if ctypes.get_last_error() == 87 else None
        try:
            code = wintypes.DWORD()
            return code.value == 259 if kernel.GetExitCodeProcess(handle, ctypes.byref(code)) else None
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except (OSError, OverflowError):
        return None


def process_fingerprint(pid: int) -> int | None:
    """Installed Hermes start_time units; process identity only, never argv."""
    if not isinstance(pid, int) or isinstance(pid, bool) or not 0 < pid <= 2147483647:
        return None
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            times = [wintypes.FILETIME() for _ in range(4)]
            if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
                return None
            ticks = (times[0].dwHighDateTime << 32) + times[0].dwLowDateTime
            return round((ticks / 10000000 - 11644473600) * 100)
        finally:
            kernel.CloseHandle(handle)
    try:
        return int(Path(f"/proc/{pid}/stat").read_bytes().rsplit(b")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def runtime_gateways(home: Path, now: float, deadline: float) -> tuple[set[str], set[str], bool]:
    """Project only status metadata. Fleet active_agents/argv are deliberately ignored.

    A multiplexer serves profiles without writing their own gateway heartbeats.
    This is availability evidence, never evidence of a currently executing turn.
    """
    path = home / "gateway_state.json"
    try:
        if time.monotonic() >= deadline or path.is_symlink() or path.is_junction():
            raise OSError("Runtime metadata unavailable")
        if path.stat().st_size > 262144:
            raise ValueError("Runtime metadata too large")
        fields = {"kind", "pid", "start_time", "hermes_home", "gateway_state", "updated_at", "served_profiles",
                  "session_store", "status"}
        with path.open(encoding="utf-8-sig") as stream:
            raw = stream.read(262145)
        if len(raw) > 262144:
            raise ValueError("Runtime metadata too large")
        status = json.loads(raw, object_pairs_hook=lambda pairs: {k: v for k, v in pairs if k in fields})
        if not isinstance(status, dict) or status.get("kind") != "hermes-gateway":
            raise ValueError("Unsupported runtime metadata")
        recorded_home = status.get("hermes_home")
        if (not isinstance(recorded_home, str)
                or os.path.normcase(str(Path(recorded_home).resolve())) != os.path.normcase(str(home.resolve()))):
            raise ValueError("Runtime metadata belongs to another home")
        profiles = status.get("served_profiles", ["default"])
        if not isinstance(profiles, list) or len(profiles) > 512 or not all(isinstance(p, str) for p in profiles):
            raise ValueError("Unsupported runtime roster")
        served = {p for p in profiles if p == "default" or PROFILE_ID.fullmatch(p)}
        updated = status.get("updated_at")
        if isinstance(updated, str):
            updated = datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp()
        if not isinstance(updated, (int, float)) or isinstance(updated, bool):
            raise ValueError("Unsupported runtime timestamp")
        age = now - float(updated)
        pid, start = status.get("pid"), status.get("start_time")
        identity = (isinstance(pid, int) and not isinstance(pid, bool)
                    and isinstance(start, int) and not isinstance(start, bool) and start > 0
                    and process_alive(pid) is True and process_fingerprint(pid) == start)
        store = status.get("session_store")
        if (identity and math.isfinite(age) and 0 <= age <= 120
                and status.get("gateway_state") in {"running", "draining"}
                and isinstance(store, dict) and store.get("status") == "ok"):
            return served, set(), False
        return set(), served, False
    except FileNotFoundError:
        return set(), set(), False
    except (OSError, ValueError, TypeError, OverflowError, RecursionError):
        return set(), set(), True


def open_readonly(path: Path, deadline: float):
    if path.is_symlink() or path.is_junction() or time.monotonic() >= deadline:
        raise OSError("Status storage unavailable")
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.03)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA trusted_schema=OFF")
    connection.execute("BEGIN")  # Consistent per-store snapshot; closing rolls back this read transaction.
    connection.row_factory = sqlite3.Row
    connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    connection.set_authorizer(authorize_read)
    return connection


def timestamp(value, now: float) -> str | None:
    try:
        numeric = float(value)
        if math.isfinite(numeric) and 0 < numeric <= now + 5:
            return datetime.fromtimestamp(numeric, timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError, OSError):
        pass
    return None


def fresh(value, now: float) -> bool:
    try:
        age = now - float(value)
        return math.isfinite(age) and 0 <= age <= 150
    except (TypeError, ValueError, OverflowError):
        return False


def lease_owner_verified(holder: str, acquired, now: float) -> bool:
    """Verify the local live PID predates lease acquisition; never inspect argv."""
    match = re.search(r"(?:^|:)pid=(\d+)(?::|$)", holder or "")
    if not match or timestamp(acquired, now) is None:
        return False
    if sys.platform == "linux":
        namespace = re.search(r"(?:^|:)pidns=(\d+)(?::|$)", holder)
        try:
            if not namespace or os.readlink("/proc/self/ns/pid") != f"pid:[{namespace.group(1)}]":
                return False
        except OSError:
            return False
    pid = int(match.group(1))
    if process_alive(pid) is not True:
        return False
    return process_started_by(pid, acquired, now)


def process_started_by(pid: int, acquired, now: float) -> bool:
    start = process_fingerprint(pid)
    if start is None:
        return False
    if os.name == "nt":
        born = start / 100
    elif sys.platform == "linux":
        try:
            uptime = float(Path("/proc/uptime").read_text().split()[0])
            born = now - uptime + start / os.sysconf("SC_CLK_TCK")
        except (OSError, ValueError, IndexError):
            return False
    else:
        return False  # Unsupported process-start observation is not proof of work.
    return born <= float(acquired) + 1 and float(acquired) <= now


def live_gateways(connection, now: float, scope: str | None = None) -> set[str]:
    local_hosts = {"", "host", socket.gethostname().lower()}
    result = set()
    for row in connection.execute(
        "SELECT pid, started_at, last_heartbeat, profile, host FROM gateway_heartbeats "
        "WHERE last_heartbeat>=? AND last_heartbeat<=? ORDER BY last_heartbeat DESC LIMIT 256",
        (now - 150, now),
    ):
        if (fresh(row["last_heartbeat"], now) and (row["host"] or "").lower() in local_hosts
                and process_alive(int(row["pid"])) is True
                and process_started_by(int(row["pid"]), row["started_at"], now)):
            result.add(row["profile"] or scope or "default")
    return result


ParticipantMeta = tuple[str, str | None]
ParticipantObserver = Callable[[ExitStack, sqlite3.Connection, dict[str, ParticipantMeta], bool], None]


def authorize_meter(action, table, column, database, via):
    # A separate, narrower policy for the final parameterized counter lookup only.
    if via is None and (action == sqlite3.SQLITE_SELECT
            or (action == sqlite3.SQLITE_READ and database == "main" and table == "sessions"
                and column in {"id", "profile_name", "ended_at", "tool_call_count"})
            or (action == sqlite3.SQLITE_FUNCTION and column == "typeof")):
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def _read_counter(db: sqlite3.Connection, profile_id: str, sid: str) -> int | None:
    # No text/blob cell reaches Python, no numeric coercion and no history-derived substitute.
    with closing(db.execute(
        "SELECT s.tool_call_count FROM main.sessions AS s WHERE s.id COLLATE BINARY=? "
        "AND s.ended_at IS NULL AND (s.profile_name IS NULL OR s.profile_name COLLATE BINARY IN ('', ?)) "
        "AND typeof(s.tool_call_count)='integer' AND s.tool_call_count BETWEEN 0 AND ? LIMIT 2",
        (sid, profile_id, MAX_TOOL_COUNT),
    )) as cursor:
        row = cursor.fetchone()
        return row[0] if row is not None and cursor.fetchone() is None else None


class RecordingReads(ExitStack):
    """Hold only admitted groups' read transactions until their normal roster is complete."""
    def __init__(self):
        super().__init__()
        self.groups: list[tuple[sqlite3.Connection, str, dict[str, str]]] = []

    def retain(self, store: ExitStack, db: sqlite3.Connection, profile_id: str, aliases: dict[str, str]):
        self.enter_context(store.pop_all())  # Same snapshot as the lease/worker proof; never reopen by path.
        self.groups.append((db, profile_id, aliases))

    def sample(self) -> dict[str, int]:
        meters = {}
        deadline = time.monotonic() + 0.25  # Optional reads never consume the roster's own budget.
        for db, profile_id, aliases in self.groups:
            # No more roster SQL runs on these handles. The stack closes them on every exit.
            try:
                db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
                db.set_authorizer(authorize_meter)
            except sqlite3.Error:
                continue
            for sid, alias in aliases.items():
                if time.monotonic() >= deadline:
                    return meters
                try:
                    value = _read_counter(db, profile_id, sid)
                except sqlite3.Error as error:
                    if (str(error) == "no such column: s.tool_call_count"
                            or getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_AUTH):
                        break  # The column is absent or denied for this entire store.
                    continue  # An unreadable cell is not a reason to suppress a different worker's meter.
                if value is not None:
                    meters[alias] = value
        return meters


def participant_columns(connection) -> tuple[str, str]:
    """Only fixed, allowlisted SQL fragments; never introspect a legacy store's private schema."""
    fields = []
    for name, probe, field in (("source", "SELECT source FROM sessions LIMIT 0", "s.source"),
                               ("parent_session_id", "SELECT parent_session_id FROM sessions LIMIT 0", "s.parent_session_id")):
        try:
            connection.execute(probe)
        except sqlite3.OperationalError as error:
            if str(error) != f"no such column: {name}":
                raise  # A timeout, denied read or failure is not evidence of an absent column.
            field = "NULL"
        fields.append(field)
    return fields[0], fields[1]


def participant_metadata(row) -> ParticipantMeta | None:
    if (not isinstance(row["id"], str) or not 0 < len(row["id"]) <= 1024
            or not isinstance(row["source"], str) or not row["source"].strip()):
        return None
    # A native parent pointer alone can also mean compression or fork, not delegation.
    if row["source"] == "subagent":
        return "subagent", row["parent_session_id"]
    return "session", None


def project_participants(profile: Path, profile_id: str, team: str, observed_at: str,
                         observed: dict[str, ParticipantMeta]) -> tuple[list[dict], bool, dict[str, str]]:
    # Stable across one-shot collector processes, scoped to this installation/profile.
    # No raw ID, holder token, profile path or per-user key file crosses the bridge.
    try:
        directory = profile.stat(follow_symlinks=False)
    except OSError:
        return [], True, {}  # The profile disappeared after its read; the aggregate remains usable.
    namespace = os.fsencode(os.path.normcase(os.path.abspath(profile))) + f"\0{directory.st_dev}:{directory.st_ino}".encode("ascii")
    scope = hashlib.blake2s(namespace).digest()
    keys = {sid: "p-" + hashlib.blake2s(sid.encode(), key=scope, digest_size=16).hexdigest() for sid in observed}
    # Only direct links between observed participants in this store. If native lineage is corrupt,
    # strip the cyclic edges, not their verified workers (or unrelated profiles in the snapshot).
    parents = {sid: parent for sid, (_, parent) in observed.items() if parent is not None and parent in keys}
    checked, cyclic = set(), set()
    for sid in parents:
        cursor, path = sid, {}
        while cursor in parents and cursor not in checked:
            if cursor in path:
                cyclic.update(list(path)[path[cursor]:])
                break
            path[cursor] = len(path)
            cursor = parents[cursor]
        checked.update(path)
    rows = []
    for sid, (kind, _) in observed.items():
        key = keys[sid]
        rows.append({"id": key, "profileId": profile_id, "kind": kind, "team": team,
                     "name": f"{kind.capitalize()} {key[2:8].upper()}",
                     "role": "Delegated subagent" if kind == "subagent" else "Active session",
                     "state": "working", "observedAt": observed_at, "activity": "Verified in-flight work.",
                     **({"parentId": keys[parents[sid]]} if sid in parents and sid not in cyclic else {})})
    return sorted(rows, key=lambda row: row["id"]), bool(cyclic), keys


def read_profile(profile: Path, now: float, deadline: float, gateways: set[str],
                 profile_id: str | None = None, stale_gateways: set[str] | None = None,
                 *, observe: ParticipantObserver | None = None) -> tuple[str, str | None, bool, int | None]:
    profile_id = profile_id or profile.name
    last_active = None
    try:
        with ExitStack() as store:
            connection = store.enter_context(closing(open_readonly(profile / "state.db", deadline)))
            latest = connection.execute(
                "SELECT MAX(last_activity_at) FROM sessions WHERE profile_name IS NULL OR profile_name IN ('', ?)",
                (profile_id,),
            ).fetchone()[0]
            last_active = timestamp(latest, now)
            stale_lease = False
            unverified = set()
            # Keys are used only inside this observation; values are eligible, unended participants.
            active_sessions = {}
            verified_work, count_complete = False, True
            gateways.update(live_gateways(connection, now, profile_id))
            source_field, parent_field = participant_columns(connection)
            leases = connection.execute(
                f"SELECT s.id, {source_field} AS source, {parent_field} AS parent_session_id, "
                "s.ended_at, l.holder, l.acquired_at, l.expires_at "
                "FROM session_turn_leases l "
                "JOIN sessions s ON s.id=l.conversation_id "
                "WHERE (s.profile_name IS NULL OR s.profile_name IN ('', ?)) "
                "AND (s.ended_at IS NULL OR s.end_reason='compression') LIMIT 10001",
                (profile_id,),
            ).fetchall()
            if len(leases) > MAX_RUNTIME_ROWS:
                raise ValueError("Runtime observation limit")
            for lease in leases:
                if time.monotonic() >= deadline:
                    raise OSError("Runtime observation deadline")
                expires = float(lease["expires_at"])
                current = math.isfinite(expires) and expires > now
                if current and lease_owner_verified(lease["holder"], lease["acquired_at"], now):
                    # A compression-root lease is still evidence for the legacy aggregate, not a live row.
                    active_sessions[lease["id"]] = participant_metadata(lease) if lease["ended_at"] is None else None
                    verified_work = True
                elif current and lease["ended_at"] is None:
                    unverified.add(lease["id"])
                else:
                    stale_lease = True
            workers = connection.execute(
                f"SELECT s.id,{source_field} AS source,{parent_field} AS parent_session_id,s.last_activity_at,s.runtime_generation,"
                "w.status,w.owner_epoch,w.generation,e.epoch, "
                "(p.end_reason IS NOT 'compression') AS distinct_parent "
                "FROM worker_executions w JOIN sessions s ON s.id=w.session_id "
                f"LEFT JOIN sessions p ON p.id={parent_field} "
                "LEFT JOIN runtime_epoch e ON e.singleton=1 "
                "WHERE w.status IN ('running','registered','unknown') AND s.ended_at IS NULL "
                "AND (s.profile_name IS NULL OR s.profile_name IN ('', ?)) LIMIT 10001",
                (profile_id,),
            ).fetchall()
            if len(workers) > MAX_RUNTIME_ROWS:
                raise ValueError("Runtime observation limit")
            for worker in workers:
                if time.monotonic() >= deadline:
                    raise OSError("Runtime observation deadline")
                if (profile_id in gateways and worker["status"] == "running"
                        and isinstance(worker["epoch"], int) and worker["epoch"] > 0
                        and isinstance(worker["generation"], int) and worker["generation"] >= 0
                        and worker["owner_epoch"] == worker["epoch"]
                        and worker["generation"] == worker["runtime_generation"]
                        and fresh(worker["last_activity_at"], now)):
                    verified_work = True
                    if worker["id"] not in active_sessions:
                        if parent_field == "NULL" or (worker["parent_session_id"] and not
                                (worker["source"] == "subagent" and worker["distinct_parent"])):
                            # Native fork/compression disambiguation reads model_config,
                            # outside this observer's allowlist. Omit the total, not a guess.
                            count_complete = False
                        else:
                            active_sessions[worker["id"]] = participant_metadata(worker)
                else:
                    unverified.add(worker["id"])
            if len(active_sessions) > MAX_RUNTIME_ROWS:
                raise ValueError("Runtime observation limit")
            # At most len(active_sessions) DISTINCT targets can already be covered.
            with closing(connection.execute(
                "SELECT DISTINCT s.id FROM session_admissions a JOIN sessions s ON s.id=a.target_session_id "
                "WHERE a.status IN ('queued','started','unknown') AND s.ended_at IS NULL "
                "AND (s.profile_name IS NULL OR s.profile_name IN ('', ?)) LIMIT ?",
                (profile_id, len(active_sessions) + 1),
            )) as admissions:
                pending = any(row[0] not in active_sessions for row in admissions)
            if observe is not None:
                typed = {sid: meta for sid, meta in active_sessions.items() if meta is not None}
                partial = (pending or not unverified.issubset(active_sessions)
                           or (verified_work and (not count_complete or len(active_sessions) != len(typed))))
                observe(store, connection, typed, partial)
            if verified_work:
                # activeSessions is a verified lower bound when other claims are unresolved.
                # With ambiguous fork/compression identity, even the deduplication is unknown: omit it.
                return "working", last_active, True, len(active_sessions) if count_complete else None
            if stale_lease or unverified or pending:
                return "offline", last_active, True, 0
            stale = profile_id in (stale_gateways or set()) and profile_id not in gateways
            return ("offline" if stale else "idle"), last_active, True, 0
    except (OSError, sqlite3.Error, ValueError, TypeError):
        return "offline", last_active, False, None


def paused(home: Path) -> bool:
    try:
        (home / "ESTOP").stat()
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return True  # The installed ESTOP contract fails safe on stat errors.


def native_directory(path: Path) -> bool:
    info = path.lstat()  # Path.is_dir() can silently turn a denied lookup into False.
    if stat.S_ISLNK(info.st_mode) or (os.name == "nt" and info.st_reparse_tag == stat.IO_REPARSE_TAG_MOUNT_POINT):
        raise OSError("Linked profile directory")
    return stat.S_ISDIR(info.st_mode)


def roster_entries(profiles: Path) -> tuple[list[Path], bool]:
    """Only a genuinely absent optional directory means a complete empty roster."""
    try:
        if not native_directory(profiles):
            return [], True
    except FileNotFoundError:
        return [], False
    except OSError:
        return [], True

    entries = []
    try:
        with os.scandir(profiles) as directory:
            entries.extend(Path(entry.path) for entry in islice(directory, 513))
    except OSError:
        return entries, True  # Even an interrupted iterator may have yielded real profiles.
    return entries, False


def _collect_snapshot(home: Path | None, reads: RecordingReads | None = None) -> dict:
    home = Path(home) if home is not None else default_home()
    now, deadline = time.time(), time.monotonic() + 6.0
    if home.is_symlink() or home.is_junction():
        # A linked native root must not lend status to a different installation.
        return {"schemaVersion": 1, "mode": "live", "source": "Local Hermes status bridge",
                "observedAt": timestamp(now, now), "pollIntervalMs": 30000, "sourceHealth": "unavailable",
                "agents": [], "warnings": ["Hermes status storage is unavailable."]}
    observed_at = datetime.fromtimestamp(now, timezone.utc).isoformat().replace("+00:00", "Z")
    agents, participants = [], []
    global_pause, any_pause = paused(home), False
    gateways, root_ok = set(), False
    try:
        with closing(open_readonly(home / "state.db", deadline)) as connection:
            gateways = live_gateways(connection, now)
            root_ok = True
    except (OSError, sqlite3.Error, ValueError, TypeError):
        pass
    runtime_live, stale_gateways, runtime_failed = runtime_gateways(home, now, deadline)
    gateways.update(runtime_live)
    supported_count = 0
    roster = []
    if home.is_dir() and not home.is_symlink() and not home.is_junction():
        roster.append((home, "default", "Hermes", "General assistant", "general"))
    entries, failed = roster_entries(home / "profiles")
    limited = len(entries) > 512
    for profile in sorted(entries[:512], key=lambda p: p.name):
        if len(profile.name) > 64 or not PROFILE_ID.fullmatch(profile.name):
            continue
        try:
            if not native_directory(profile):
                continue
        except OSError:
            failed = True
            continue
        if len(roster) >= MAX_ROSTER:
            limited = True
            break
        roster.append((profile, profile.name, display_name(profile),
                       profile.name.split("-", 1)[1].replace("-", " ").title(),
                       TEAM_PREFIXES[profile.name.split("-", 1)[0]]))
    # Each profile already occupies one slot. Admit whole groups within the rendered roster cap;
    # an oversized group keeps its aggregate and count rather than losing the rest silently.
    spare_slots, partial_details = MAX_ROSTER - len(roster), False
    for profile, profile_id, name, role, team in roster:
        def project_visible(store, connection, typed, partial):
            nonlocal spare_slots, partial_details
            partial_details |= partial
            if len(typed) > spare_slots + 1:
                partial_details = True
            elif typed:
                rows, invalid_links, aliases = project_participants(profile, profile_id, team, observed_at, typed)
                participants.extend(rows)
                partial_details |= invalid_links
                spare_slots -= max(0, len(rows) - 1)
                if reads is not None and aliases:
                    reads.retain(store, connection, profile_id, aliases)

        state, last_active, supported, active_sessions = read_profile(
            profile, now, deadline, gateways, profile_id, stale_gateways, observe=project_visible)
        failed |= not supported
        supported_count += int(supported)
        is_paused = global_pause or paused(profile)
        any_pause |= is_paused
        if is_paused and state != "working":
            state = "paused"
        activity = {
            "working": "Current turn lease or fresh running worker observed.",
            "idle": ("Fresh profile backend; no observed active turn." if profile_id in gateways
                     else "Native profile readable; no verified in-flight work."),
            "paused": "New work paused by ESTOP.",
            "offline": ("Stale or unverified runtime claims; activity uncertain." if supported
                        else "Runtime status unavailable; activity unverified."),
        }[state]
        if is_paused and state == "working":
            activity = "Current turn continues; new work paused by ESTOP."
        agents.append({
            "id": profile_id, "name": name, "role": role, "team": team,
            "state": state, "observedAt": observed_at, "lastActiveAt": last_active, "activity": activity,
            **({"activeSessions": active_sessions} if profile_id == "default" and active_sessions is not None else {}),
        })
    return {
        "schemaVersion": 1,
        "mode": "live",
        "source": "Local Hermes status bridge",
        "observedAt": observed_at,
        "pollIntervalMs": 30000,
        "sourceHealth": ("connected" if supported_count and not failed and not runtime_failed and not limited and not partial_details
                         and all(a["state"] != "offline" for a in agents)
                         else "degraded" if supported_count else "unavailable"),
        "agents": agents,
        **({"participants": participants} if participants else {}),
        "warnings": ["Input-waiting and blocked states are not inferred from stored messages." if agents
                     else "Hermes status storage is unavailable."]
                    + (["Some profiles have no fresh runtime evidence; offline means uncertain."]
                       if any(a["state"] == "offline" for a in agents) else [])
                    + (["Some status stores could not be read; results are partial."] if failed or (agents and not root_ok) else [])
                    + (["Some backend metadata could not be verified; availability is uncertain."] if runtime_failed else [])
                    + (["Active-session counts include only verified in-flight work; retained chats and open windows are excluded."] if agents else [])
                    + (["Some active-session totals are unavailable; no history-based estimate is used."]
                       if any(a["id"] == "default" and a["state"] == "working" and "activeSessions" not in a for a in agents) else [])
                    + (["Roster limit reached; additional profiles are not shown."] if limited else [])
                    + (["Some participant details are unavailable; the roster may show aggregate or partial activity."] if partial_details else [])
                    + (["Read time limit reached; some statuses are uncertain."] if time.monotonic() >= deadline else [])
                    + (["New work is paused; existing turns are not stopped by ESTOP."] if any_pause else []),
    }


def collect(home: Path | None = None, *, recording: bool = False) -> dict:
    if not recording:
        return _collect_snapshot(home)
    with RecordingReads() as reads:
        snapshot = _collect_snapshot(home, reads)
        return {"snapshot": snapshot, "meters": reads.sample()}


if __name__ == "__main__":
    print(json.dumps(collect(recording=sys.argv[1:] == ["--recording"]),
                     ensure_ascii=True, allow_nan=False, separators=(",", ":")))
