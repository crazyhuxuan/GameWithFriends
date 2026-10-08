import hashlib
import ipaddress
import json
import re
import secrets
import sqlite3
import socket
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
DATABASE_PATH = Path(__file__).resolve().parent / "users.db"
HOST = "::"
PORT = 8000
SESSION_TTL = 7 * 24 * 60 * 60
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_]{3,20}$")
PBKDF2_ITERATIONS = 600_000
ADMIN_USERNAME = "GameAdmin"
ADMIN_PASSWORD = "12345678990"
LOGIN_FAILURE_LIMIT = 3
LOGIN_LOCKOUT_SECONDS = 60
_login_failure_counts = {}
_login_blocked_until = {}
_login_lock = threading.Lock()


def login_lockout_remaining(client_ip):
    now = time.monotonic()
    with _login_lock:
        blocked_until = _login_blocked_until.get(client_ip)
        if blocked_until is None:
            return 0
        remaining = blocked_until - now
        if remaining <= 0:
            _login_blocked_until.pop(client_ip, None)
            _login_failure_counts.pop(client_ip, None)
            return 0
        return remaining


def record_login_failure(client_ip):
    now = time.monotonic()
    with _login_lock:
        blocked_until = _login_blocked_until.get(client_ip)
        if blocked_until is not None and blocked_until > now:
            return blocked_until - now
        if blocked_until is not None:
            _login_blocked_until.pop(client_ip, None)
            _login_failure_counts.pop(client_ip, None)
        failures = _login_failure_counts.get(client_ip, 0) + 1
        if failures >= LOGIN_FAILURE_LIMIT:
            _login_failure_counts.pop(client_ip, None)
            _login_blocked_until[client_ip] = now + LOGIN_LOCKOUT_SECONDS
            return LOGIN_LOCKOUT_SECONDS
        _login_failure_counts[client_ip] = failures
        return 0


def clear_login_failures(client_ip):
    now = time.monotonic()
    with _login_lock:
        blocked_until = _login_blocked_until.get(client_ip)
        if blocked_until is not None and blocked_until > now:
            return blocked_until - now
        _login_blocked_until.pop(client_ip, None)
        _login_failure_counts.pop(client_ip, None)
        return 0


@contextmanager
def connect_database():
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
    except BaseException:
        connection.rollback()
        raise
    else:
        connection.commit()
    finally:
        connection.close()


def initialize_database():
    with connect_database() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_salt BLOB NOT NULL,
                password_hash BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'))
            )
            """
        )
        user_columns = {
            column["name"] for column in connection.execute("PRAGMA table_info(users)")
        }
        role_was_missing = "role" not in user_columns
        if role_was_missing:
            connection.execute(
                """
                ALTER TABLE users
                ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
                CHECK (role IN ('user', 'admin'))
                """
            )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)")
        legacy_admin = connection.execute(
            "SELECT id FROM users WHERE username = 'HuXuan' COLLATE NOCASE AND role = 'admin'"
        ).fetchone()
        if legacy_admin is not None:
            connection.execute(
                "UPDATE users SET role = 'user' WHERE id = ?", (legacy_admin["id"],)
            )
            connection.execute("DELETE FROM sessions WHERE user_id = ?", (legacy_admin["id"],))
        admin = connection.execute(
            "SELECT id, role FROM users WHERE username = ? COLLATE NOCASE",
            (ADMIN_USERNAME,),
        ).fetchone()
        if admin is None:
            salt = secrets.token_bytes(16)
            connection.execute(
                """
                INSERT INTO users (username, password_salt, password_hash, created_at, role)
                VALUES (?, ?, ?, ?, 'admin')
                """,
                (ADMIN_USERNAME, salt, hash_password(ADMIN_PASSWORD, salt), int(time.time())),
            )
        elif role_was_missing or admin["role"] != "admin":
            salt = secrets.token_bytes(16)
            connection.execute(
                """
                UPDATE users SET role = 'admin', password_salt = ?, password_hash = ?
                WHERE id = ?
                """,
                (salt, hash_password(ADMIN_PASSWORD, salt), admin["id"]),
            )
            connection.execute("DELETE FROM sessions WHERE user_id = ?", (admin["id"],))
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS billiards_rooms (
                room_code TEXT PRIMARY KEY,
                host_user_id INTEGER NOT NULL REFERENCES users(id),
                capacity INTEGER NOT NULL CHECK (capacity BETWEEN 2 AND 54),
                status TEXT NOT NULL CHECK (status IN ('lobby', 'playing')),
                is_open INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1)),
                created_at INTEGER NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS billiards_room_members (
                room_code TEXT NOT NULL REFERENCES billiards_rooms(room_code) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK (role IN ('player', 'referee')),
                ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
                cards TEXT NOT NULL DEFAULT '[]',
                score INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN -1000000000 AND 1000000000),
                score_version INTEGER NOT NULL DEFAULT 0 CHECK (score_version >= 0),
                active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
                joined_at INTEGER NOT NULL,
                PRIMARY KEY (room_code, user_id)
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS billiards_members_user ON billiards_room_members(user_id)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS billiards_potted_numbers (
                room_code TEXT NOT NULL REFERENCES billiards_rooms(room_code) ON DELETE CASCADE,
                number INTEGER NOT NULL CHECK (number BETWEEN 1 AND 15),
                potted_at INTEGER NOT NULL,
                potted_by INTEGER NOT NULL REFERENCES users(id),
                PRIMARY KEY (room_code, number)
            )
            """
        )
        room_columns = {
            column["name"]
            for column in connection.execute("PRAGMA table_info(billiards_rooms)")
        }
        if "is_open" not in room_columns:
            connection.execute(
                "ALTER TABLE billiards_rooms ADD COLUMN is_open INTEGER NOT NULL DEFAULT 1"
            )
        member_columns = {
            column["name"]
            for column in connection.execute("PRAGMA table_info(billiards_room_members)")
        }
        if "score" not in member_columns:
            connection.execute(
                """
                ALTER TABLE billiards_room_members
                ADD COLUMN score INTEGER NOT NULL DEFAULT 0
                CHECK (score BETWEEN -1000000000 AND 1000000000)
                """
            )
        if "score_version" not in member_columns:
            connection.execute(
                """
                ALTER TABLE billiards_room_members
                ADD COLUMN score_version INTEGER NOT NULL DEFAULT 0
                CHECK (score_version >= 0)
                """
            )
        if "active" not in member_columns:
            connection.execute(
                "ALTER TABLE billiards_room_members ADD COLUMN active INTEGER NOT NULL DEFAULT 1"
            )


def hash_password(password, salt):
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )


class AppHandler(BaseHTTPRequestHandler):
    server_version = "GameWithFriends/1.0"

    def _send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for name, value in extra_headers:
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)


    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("请求数据格式无效。") from error
        if length < 1 or length > 10_000:
            raise ValueError("请求数据无效或过大。")
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("请求数据格式无效。") from error
        if not isinstance(payload, dict):
            raise ValueError("请求数据格式无效。")
        return payload

    def _session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            return None
        morsel = cookie.get("gfw_session")
        return morsel.value if morsel else None

    def _login_client_ip(self):
        peer_ip = ipaddress.ip_address(self.client_address[0])
        if peer_ip.is_loopback:
            forwarded_ip = self.headers.get("CF-Connecting-IP", "").strip()
            if forwarded_ip:
                try:
                    return ipaddress.ip_address(forwarded_ip).compressed
                except ValueError:
                    pass
        return peer_ip.compressed

    def _send_login_locked_response(self, remaining):
        retry_after = max(1, int(remaining + 0.999))
        self._send_json(
            429,
            {"error": f"登录失败次数过多，请 {retry_after} 秒后重试。"},
            [("Retry-After", str(retry_after))],
        )

    def _authenticated_user(self):
        token = self._session_token()
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = int(time.time())
        with connect_database() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            return connection.execute(
                """
                SELECT users.id, users.username, users.role
                FROM sessions JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ? AND sessions.expires_at > ?
                """,
                (token_hash, now),
            ).fetchone()

    def _create_session(self, user_id):
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        expires_at = int(time.time()) + SESSION_TTL
        with connect_database() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
            connection.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (token_hash, user_id, expires_at),
            )
        return (
            "Set-Cookie",
            f"gfw_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}",
        )

    def do_GET(self):
        static_files = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/index.html": ("index.html", "text/html; charset=utf-8"),
            "/index.css": ("index.css", "text/css; charset=utf-8"),
            "/index.js": ("index.js", "text/javascript; charset=utf-8"),
        }
        if self.path in static_files:
            filename, content_type = static_files[self.path]
            try:
                body = (FRONTEND_DIR / filename).read_bytes()
            except OSError:
                self._send_json(500, {"error": "前端资源暂时无法读取。"})
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/api/me":
            user = self._authenticated_user()
            if user is None:
                self._send_json(401, {"error": "请先登录。"})
                return
            self._send_json(200, {"username": user["username"], "role": user["role"]})
            return

        if self.path == "/api/rooms/current":
            user = self._authenticated_user()
            if user is None:
                self._send_json(401, {"error": "请先登录。"})
                return
            with connect_database() as connection:
                membership = connection.execute(
                    """
                    SELECT room_code FROM billiards_room_members
                    WHERE user_id = ? AND active = 1 ORDER BY joined_at DESC LIMIT 1
                    """,
                    (user["id"],),
                ).fetchone()
                if membership is None:
                    self._send_json(200, {"room": None})
                    return
                room = self._room_snapshot(connection, membership["room_code"], user["id"])
            self._send_json(200, {"room": room})
            return

        self._send_json(404, {"error": "请求的地址不存在。"})

    def do_POST(self):
        routes = {
            "/api/login": self._login,
            "/api/admin/login": self._admin_login,
            "/api/admin/accounts": self._admin_create_account,
            "/api/logout": self._logout,
            "/api/billiards/rooms": self._billiards_create,
            "/api/billiards/join": self._billiards_join,
            "/api/billiards/referee": self._billiards_referee,
            "/api/billiards/ready": self._billiards_ready,
            "/api/billiards/start": self._billiards_start,
            "/api/billiards/draw": self._billiards_draw,
            "/api/billiards/draw-one-more": self._billiards_draw_one_more,
            "/api/billiards/set-pocketed": self._billiards_set_pocketed,
            "/api/billiards/restart": self._billiards_restart,
            "/api/billiards/score": self._billiards_score,
            "/api/billiards/leave": self._billiards_leave,
        }
        handler = routes.get(self.path)
        if handler is None:
            self._send_json(404, {"error": "请求的地址不存在。"})
            return
        try:
            if self.path.startswith("/api/billiards/") or self.path == "/api/admin/accounts":
                user = self._authenticated_user()
                if user is None:
                    self._send_json(401, {"error": "请先登录。"})
                    return
                self.current_user = user
            handler()
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
        except sqlite3.Error:
            self.log_error("Database operation failed")
            self._send_json(500, {"error": "数据库暂时不可用，请稍后再试。"})

    def _room_snapshot(self, connection, room_code, user_id):
        room = connection.execute(
            """
            SELECT r.room_code, r.host_user_id, r.capacity, r.status, r.is_open, r.created_at,
                   host.username AS host_username
            FROM billiards_rooms AS r JOIN users AS host ON host.id = r.host_user_id
            WHERE r.room_code = ?
            """,
            (room_code,),
        ).fetchone()
        if room is None or not room["is_open"]:
            return None
        members = connection.execute(
            """
            SELECT m.user_id, u.username, m.role, m.ready, m.cards, m.active,
                   m.score, m.score_version
            FROM billiards_room_members AS m JOIN users AS u ON u.id = m.user_id
            WHERE m.room_code = ?
              AND (m.active = 1 OR (m.role = 'player' AND m.cards != '[]'))
            ORDER BY m.joined_at, m.user_id
            """,
            (room_code,),
        ).fetchall()
        potted_numbers = [
            row["number"]
            for row in connection.execute(
                "SELECT number FROM billiards_potted_numbers WHERE room_code = ?",
                (room_code,),
            )
        ]
        own_member = next(
            (member for member in members if member["user_id"] == user_id and member["active"]),
            None,
        )
        if own_member is None:
            return None
        referee = own_member["role"] == "referee"
        players = []
        for member in members:
            cards = json.loads(member["cards"])
            entry = {
                "username": member["username"],
                "role": member["role"],
                "ready": bool(member["ready"]),
                "active": bool(member["active"]),
                "score": member["score"],
                "score_version": member["score_version"],
            }
            if member["role"] == "player":
                entry["unpotted_card_count"] = sum(
                    card["number"] not in potted_numbers for card in cards
                )
            if referee or member["user_id"] == user_id:
                entry["cards"] = cards
            players.append(entry)
        return {
            "room_code": room["room_code"],
            "capacity": room["capacity"],
            "status": room["status"],
            "host_username": room["host_username"],
            "is_host": room["host_user_id"] == user_id,
            "role": own_member["role"],
            "players": players,
            "potted_numbers": potted_numbers,
            "player_count": sum(
                member["role"] == "player" and member["active"] for member in members
            ),
            "drawn_count": sum(
                member["role"] == "player"
                and member["active"]
                and member["cards"] != "[]"
                for member in members
            ),
            "ready_count": sum(
                member["role"] == "player" and member["active"] and member["ready"]
                for member in members
            ),
        }

    def _room_input(self):
        payload = self._read_json()
        room_code = payload.get("room_code")
        if not isinstance(room_code, str) or not re.fullmatch(r"\d{10,}", room_code):
            raise ValueError("请输入有效的房间号。")
        return room_code

    def _billiards_create(self):
        payload = self._read_json()
        capacity = payload.get("capacity")
        if isinstance(capacity, bool) or not isinstance(capacity, int) or not 2 <= capacity <= 54:
            raise ValueError("房间人数需设置为 2–54 人。")
        now = int(time.time())
        date_prefix = datetime.now().strftime("%Y%m%d")
        with connect_database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing_room = connection.execute(
                """
                SELECT room_code FROM billiards_room_members
                WHERE user_id = ? AND active = 1
                """,
                (self.current_user["id"],),
            ).fetchone()
            if existing_room:
                self._send_json(409, {"error": f"你已在房间 {existing_room['room_code']} 中。"})
                return
            sequence = connection.execute(
                "SELECT COUNT(*) + 1 AS next_sequence FROM billiards_rooms WHERE room_code LIKE ?",
                (f"{date_prefix}%",),
            ).fetchone()["next_sequence"]
            room_code = f"{date_prefix}{sequence:02d}"
            connection.execute(
                """
                INSERT INTO billiards_rooms (room_code, host_user_id, capacity, status, created_at)
                VALUES (?, ?, ?, 'lobby', ?)
                """,
                (room_code, self.current_user["id"], capacity, now),
            )
            connection.execute(
                """
                INSERT INTO billiards_room_members (room_code, user_id, role, ready, joined_at)
                VALUES (?, ?, 'player', 0, ?)
                """,
                (room_code, self.current_user["id"], now),
            )
            room = self._room_snapshot(connection, room_code, self.current_user["id"])
        self._send_json(201, room)

    def _join_room(self, role):
        room_code = self._room_input()
        now = int(time.time())
        with connect_database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            room = connection.execute(
                "SELECT room_code, capacity, status, is_open FROM billiards_rooms WHERE room_code = ?",
                (room_code,),
            ).fetchone()
            if room is None:
                self._send_json(404, {"error": "找不到这个台球房间，请检查房间号。"})
                return
            existing_membership = connection.execute(
                """
                SELECT room_code FROM billiards_room_members
                WHERE user_id = ? AND active = 1
                """,
                (self.current_user["id"],),
            ).fetchone()
            if existing_membership:
                self._send_json(
                    409, {"error": f"你已在房间 {existing_membership['room_code']} 中。"}
                )
                return
            room_membership = connection.execute(
                """
                SELECT role, active FROM billiards_room_members
                WHERE room_code = ? AND user_id = ?
                """,
                (room_code, self.current_user["id"]),
            ).fetchone()
            is_returning_member = room_membership is not None
            if is_returning_member and room_membership["role"] != role:
                self._send_json(409, {"error": "你不能以不同身份重复加入同一个房间。"})
                return
            if not room["is_open"]:
                self._send_json(409, {"error": "这个房间已关闭。"})
                return
            if role == "player":
                if room["status"] != "lobby" and not is_returning_member:
                    self._send_json(409, {"error": "游戏已经开始，不能再加入玩家。"})
                    return
                player_count = connection.execute(
                    """
                    SELECT COUNT(*) AS count FROM billiards_room_members
                    WHERE room_code = ? AND role = 'player' AND active = 1
                    """,
                    (room_code,),
                ).fetchone()["count"]
                if player_count >= room["capacity"]:
                    self._send_json(409, {"error": "房间人数已满。"})
                    return
            if is_returning_member:
                if not room_membership["active"]:
                    connection.execute(
                        """
                        UPDATE billiards_room_members
                        SET active = 1,
                            ready = CASE
                                WHEN ? = 'lobby' AND role = 'player' THEN 0
                                ELSE ready
                            END
                        WHERE room_code = ? AND user_id = ?
                        """,
                        (room["status"], room_code, self.current_user["id"]),
                    )
            else:
                connection.execute(
                    """
                    INSERT INTO billiards_room_members (room_code, user_id, role, ready, joined_at)
                    VALUES (?, ?, ?, 0, ?)
                    """,
                    (room_code, self.current_user["id"], role, now),
                )
            snapshot = self._room_snapshot(connection, room_code, self.current_user["id"])
        self._send_json(200, snapshot)

    def _billiards_join(self):
        self._join_room("player")

    def _billiards_referee(self):
        self._join_room("referee")

    def _billiards_ready(self):
        payload = self._read_json()
        ready = payload.get("ready")
        if not isinstance(ready, bool):
            raise ValueError("准备状态无效。")
        with connect_database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            membership = connection.execute(
                """
                SELECT m.room_code, m.role, r.status
                FROM billiards_room_members AS m
                JOIN billiards_rooms AS r ON r.room_code = m.room_code
                WHERE m.user_id = ? AND m.active = 1
                """,
                (self.current_user["id"],),
            ).fetchone()
            if membership is None or membership["role"] != "player":
                self._send_json(403, {"error": "只有房间玩家可以准备。"})
                return
            if membership["status"] != "lobby":
                self._send_json(409, {"error": "游戏已经开始，不能更改准备状态。"})
                return
            connection.execute(
                """
                UPDATE billiards_room_members SET ready = ?
                WHERE room_code = ? AND user_id = ?
                """,
                (int(ready), membership["room_code"], self.current_user["id"]),
            )
            snapshot = self._room_snapshot(
                connection, membership["room_code"], self.current_user["id"]
            )
        self._send_json(200, snapshot)

    def _billiards_start(self):
        with connect_database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            membership = connection.execute(
                """
                SELECT r.room_code, r.status, r.host_user_id, r.capacity
                FROM billiards_rooms AS r
                JOIN billiards_room_members AS m ON m.room_code = r.room_code
                WHERE m.user_id = ? AND m.active = 1
                """,
                (self.current_user["id"],),
            ).fetchone()
            if membership is None or membership["host_user_id"] != self.current_user["id"]:
                self._send_json(403, {"error": "只有房主可以开始游戏。"})
                return
            if membership["status"] != "lobby":
                self._send_json(409, {"error": "游戏已经开始。"})
                return
            players = connection.execute(
                """
                SELECT ready FROM billiards_room_members
                WHERE room_code = ? AND role = 'player' AND active = 1
                """,
                (membership["room_code"],),
            ).fetchall()
            if len(players) < 2:
                self._send_json(409, {"error": "至少需要两名玩家才能开始。"})
                return
            if len(players) < membership["capacity"]:
                self._send_json(
                    409,
                    {"error": f"房间还未坐满，当前 {len(players)} / {membership['capacity']} 人。"},
                )
                return
            if not all(player["ready"] for player in players):
                self._send_json(409, {"error": "请等待所有玩家准备就绪。"})
                return
            connection.execute(
                "UPDATE billiards_rooms SET status = 'playing' WHERE room_code = ?",
                (membership["room_code"],),
            )
            snapshot = self._room_snapshot(
                connection, membership["room_code"], self.current_user["id"]
            )
        self._send_json(200, snapshot)

    def _billiards_draw(self):
        payload = self._read_json()
        count = payload.get("count")
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 15:
            raise ValueError("每位玩家的抽牌数量需设置为 1–15 张。")
        self._draw_cards(count, additional=False)

    def _billiards_draw_one_more(self):
        self._draw_cards(1, additional=True)

    def _draw_cards(self, count, additional):
        with connect_database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            membership = connection.execute(
                """
                SELECT m.room_code, m.role, m.cards, r.status
                FROM billiards_room_members AS m
                JOIN billiards_rooms AS r ON r.room_code = m.room_code
                WHERE m.user_id = ? AND m.active = 1
                """,
                (self.current_user["id"],),
            ).fetchone()
            if membership is None or membership["role"] != "player":
                self._send_json(403, {"error": "只有房间玩家可以抽牌。"})
                return
            if membership["status"] != "playing":
                self._send_json(409, {"error": "请等待房主开始游戏后再抽牌。"})
                return
            if additional and membership["cards"] == "[]":
                self._send_json(409, {"error": "请先进行首次抽牌。"})
                return
            if not additional and membership["cards"] != "[]":
                self._send_json(409, {"error": "你已经抽过牌了。"})
                return
            own_cards = json.loads(membership["cards"])
            drawn_cards = connection.execute(
                """
                SELECT cards FROM billiards_room_members
                WHERE room_code = ? AND role = 'player'
                """,
                (membership["room_code"],),
            ).fetchall()
            used_cards = {
                card["id"]
                for member in drawn_cards
                for card in json.loads(member["cards"])
            }
            rank_labels = {1: "A", 11: "J", 12: "Q", 13: "K"}
            deck = [
                {
                    "id": f"{suit}{rank}",
                    "label": f"{rank_labels.get(rank, rank)}{suit_name}",
                    "number": rank,
                }
                for suit, suit_name in (("S", "♠"), ("H", "♥"), ("C", "♣"), ("D", "♦"))
                for rank in range(1, 14)
            ]
            deck.extend(
                (
                    {"id": "JOKER-SMALL", "label": "小王", "number": 14},
                    {"id": "JOKER-BIG", "label": "大王", "number": 15},
                )
            )
            available = [card for card in deck if card["id"] not in used_cards]
            if count > len(available):
                self._send_json(409, {"error": f"牌堆只剩 {len(available)} 张未抽的牌。"})
                return
            drawn = secrets.SystemRandom().sample(available, count)
            if additional:
                for card in drawn:
                    card["extra_draw"] = True
            updated_cards = own_cards + drawn if additional else drawn
            connection.execute(
                """
                UPDATE billiards_room_members SET cards = ?
                WHERE room_code = ? AND user_id = ?
                """,
                (
                    json.dumps(updated_cards, ensure_ascii=False),
                    membership["room_code"],
                    self.current_user["id"],
                ),
            )
            snapshot = self._room_snapshot(
                connection, membership["room_code"], self.current_user["id"]
            )
        self._send_json(200, snapshot)

    def _billiards_set_pocketed(self):
        payload = self._read_json()
        number = payload.get("number")
        pocketed = payload.get("pocketed")
        if isinstance(number, bool) or not isinstance(number, int) or not 1 <= number <= 15:
            raise ValueError("台球号码必须是 1–15 之间的整数。")
        if not isinstance(pocketed, bool):
            raise ValueError("进球状态无效。")
        with connect_database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            membership = connection.execute(
                """
                SELECT m.room_code, m.role, r.status, m.cards
                FROM billiards_room_members AS m
                JOIN billiards_rooms AS r ON r.room_code = m.room_code
                WHERE m.user_id = ? AND m.active = 1
                """,
                (self.current_user["id"],),
            ).fetchone()
            if membership is None:
                self._send_json(403, {"error": "你当前不在台球房间中。"})
                return
            if membership["status"] != "playing":
                self._send_json(409, {"error": "游戏开始后才能更新进球状态。"})
                return
            if membership["role"] == "player":
                own_cards = json.loads(membership["cards"])
                if not any(card["number"] == number for card in own_cards):
                    self._send_json(403, {"error": "玩家只能更新自己抽到的台球号码。"})
                    return

            if pocketed:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO billiards_potted_numbers
                        (room_code, number, potted_at, potted_by)
                    VALUES (?, ?, ?, ?)
                    """,
                    (membership["room_code"], number, int(time.time()), self.current_user["id"]),
                )
            else:
                connection.execute(
                    """
                    DELETE FROM billiards_potted_numbers
                    WHERE room_code = ? AND number = ?
                    """,
                    (membership["room_code"], number),
                )
            snapshot = self._room_snapshot(
                connection, membership["room_code"], self.current_user["id"]
            )
        snapshot["last_pocketed_change"] = {"number": number, "pocketed": pocketed}
        self._send_json(200, snapshot)

    def _billiards_restart(self):
        with connect_database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            membership = connection.execute(
                """
                SELECT m.room_code, r.status, r.host_user_id
                FROM billiards_room_members AS m
                JOIN billiards_rooms AS r ON r.room_code = m.room_code
                WHERE m.user_id = ? AND m.active = 1
                """,
                (self.current_user["id"],),
            ).fetchone()
            if membership is None:
                self._send_json(403, {"error": "只有房间成员可以重新开局。"})
                return
            if membership["host_user_id"] != self.current_user["id"]:
                self._send_json(403, {"error": "只有房主可以重新开局。"})
                return
            if membership["status"] != "playing":
                self._send_json(409, {"error": "游戏尚未开始，暂时不能重新开局。"})
                return
            connection.execute(
                """
                UPDATE billiards_room_members SET cards = '[]'
                WHERE room_code = ? AND role = 'player'
                """,
                (membership["room_code"],),
            )
            connection.execute(
                "DELETE FROM billiards_potted_numbers WHERE room_code = ?",
                (membership["room_code"],),
            )
            snapshot = self._room_snapshot(
                connection, membership["room_code"], self.current_user["id"]
            )
        self._send_json(200, snapshot)

    def _billiards_score(self):
        payload = self._read_json()
        username = payload.get("username")
        score = payload.get("score")
        score_version = payload.get("score_version")
        if not isinstance(username, str) or not USERNAME_PATTERN.fullmatch(username):
            raise ValueError("玩家用户名无效。")
        if (
            isinstance(score, bool)
            or not isinstance(score, int)
            or not -1_000_000_000 <= score <= 1_000_000_000
        ):
            raise ValueError("分数必须是 -1,000,000,000 到 1,000,000,000 之间的整数。")
        if (
            isinstance(score_version, bool)
            or not isinstance(score_version, int)
            or score_version < 0
        ):
            raise ValueError("分数版本无效，请刷新后重试。")

        conflict_snapshot = None
        with connect_database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            actor = connection.execute(
                """
                SELECT m.room_code, m.role
                FROM billiards_room_members AS m
                WHERE m.user_id = ? AND m.active = 1
                """,
                (self.current_user["id"],),
            ).fetchone()
            if actor is None:
                self._send_json(403, {"error": "只有当前房间成员可以修改分数。"})
                return
            target = connection.execute(
                """
                SELECT m.user_id, m.role, m.score_version
                FROM billiards_room_members AS m
                JOIN users AS u ON u.id = m.user_id
                WHERE m.room_code = ? AND u.username = ? COLLATE NOCASE
                  AND m.role = 'player'
                """,
                (actor["room_code"], username),
            ).fetchone()
            if target is None:
                self._send_json(404, {"error": "找不到该房间玩家。"})
                return
            if actor["role"] != "referee" and target["user_id"] != self.current_user["id"]:
                self._send_json(403, {"error": "玩家只能修改自己的分数。"})
                return
            if target["score_version"] != score_version:
                conflict_snapshot = self._room_snapshot(
                    connection, actor["room_code"], self.current_user["id"]
                )
            else:
                connection.execute(
                    """
                    UPDATE billiards_room_members
                    SET score = ?, score_version = score_version + 1
                    WHERE room_code = ? AND user_id = ? AND score_version = ?
                    """,
                    (score, actor["room_code"], target["user_id"], score_version),
                )
                snapshot = self._room_snapshot(
                    connection, actor["room_code"], self.current_user["id"]
                )
        if conflict_snapshot is not None:
            self._send_json(
                409,
                {
                    "error": "分数已被其他人修改，已显示最新分数，请确认后重新编辑。",
                    "room": conflict_snapshot,
                },
            )
            return
        self._send_json(200, snapshot)

    def _billiards_leave(self):
        with connect_database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            membership = connection.execute(
                """
                SELECT r.room_code, r.host_user_id, r.status, m.role
                FROM billiards_room_members AS m
                JOIN billiards_rooms AS r ON r.room_code = m.room_code
                WHERE m.user_id = ? AND m.active = 1
                """,
                (self.current_user["id"],),
            ).fetchone()
            if membership is None:
                self._send_json(404, {"error": "你当前不在台球房间中。"})
                return
            room_code = membership["room_code"]
            connection.execute(
                """
                UPDATE billiards_room_members SET active = 0
                WHERE room_code = ? AND user_id = ?
                """,
                (room_code, self.current_user["id"]),
            )
            active_members = connection.execute(
                """
                SELECT COUNT(*) AS count FROM billiards_room_members
                WHERE room_code = ? AND active = 1
                """,
                (room_code,),
            ).fetchone()["count"]
            closed = active_members == 0
            if closed:
                connection.execute(
                    "UPDATE billiards_rooms SET is_open = 0 WHERE room_code = ?",
                    (room_code,),
                )
            elif (
                membership["host_user_id"] == self.current_user["id"]
                and membership["status"] == "lobby"
            ):
                next_host = connection.execute(
                    """
                    SELECT user_id FROM billiards_room_members
                    WHERE room_code = ? AND role = 'player' AND active = 1
                    ORDER BY joined_at, user_id LIMIT 1
                    """,
                    (room_code,),
                ).fetchone()
                if next_host is not None:
                    connection.execute(
                        """
                        UPDATE billiards_rooms SET host_user_id = ? WHERE room_code = ?
                        """,
                        (next_host["user_id"], room_code),
                    )
        self._send_json(
            200,
            {"room_closed": closed, "message": "已离开房间。" if not closed else "房间已关闭。"},
        )

    def _credentials(self):
        payload = self._read_json()
        username = payload.get("username")
        password = payload.get("password")
        if not isinstance(username, str) or not USERNAME_PATTERN.fullmatch(username):
            raise ValueError("用户名需为 3–20 位字母、数字或下划线。")
        if not isinstance(password, str) or not 8 <= len(password) <= 128:
            raise ValueError("密码长度需为 8–128 位。")
        return username, password

    def _admin_create_account(self):
        if self.current_user["role"] != "admin":
            self._send_json(403, {"error": "只有管理员可以创建账号。"})
            return
        username, password = self._credentials()
        salt = secrets.token_bytes(16)
        password_hash = hash_password(password, salt)
        try:
            with connect_database() as connection:
                connection.execute(
                    """
                    INSERT INTO users (username, password_salt, password_hash, created_at, role)
                    VALUES (?, ?, ?, ?, 'user')
                    """,
                    (username, salt, password_hash, int(time.time())),
                )
        except sqlite3.IntegrityError:
            self._send_json(409, {"error": "这个用户名已被注册，请换一个试试。"})
            return
        self._send_json(201, {"username": username, "message": "账号创建成功。"})

    def _login(self):
        client_ip = self._login_client_ip()
        remaining = login_lockout_remaining(client_ip)
        if remaining:
            self._send_login_locked_response(remaining)
            return
        username, password = self._credentials()
        with connect_database() as connection:
            user = connection.execute(
                """
                SELECT id, username, password_salt, password_hash, role
                FROM users WHERE username = ?
                """,
                (username,),
            ).fetchone()
        if user is None or not secrets.compare_digest(
            hash_password(password, user["password_salt"]), user["password_hash"]
        ):
            remaining = record_login_failure(client_ip)
            if remaining:
                self._send_login_locked_response(remaining)
            else:
                self._send_json(401, {"error": "用户名或密码不正确。"})
            return
        if user["role"] == "admin":
            remaining = record_login_failure(client_ip)
            if remaining:
                self._send_login_locked_response(remaining)
            else:
                self._send_json(403, {"error": "管理员请使用管理员登录入口。"})
            return
        remaining = clear_login_failures(client_ip)
        if remaining:
            self._send_login_locked_response(remaining)
            return
        cookie = self._create_session(user["id"])
        self._send_json(200, {"username": user["username"], "role": user["role"]}, [cookie])

    def _admin_login(self):
        client_ip = self._login_client_ip()
        remaining = login_lockout_remaining(client_ip)
        if remaining:
            self._send_login_locked_response(remaining)
            return
        username, password = self._credentials()
        with connect_database() as connection:
            user = connection.execute(
                """
                SELECT id, username, password_salt, password_hash, role
                FROM users WHERE username = ?
                """,
                (username,),
            ).fetchone()
        if (
            user is None
            or user["role"] != "admin"
            or not secrets.compare_digest(
                hash_password(password, user["password_salt"]), user["password_hash"]
            )
        ):
            remaining = record_login_failure(client_ip)
            if remaining:
                self._send_login_locked_response(remaining)
            else:
                self._send_json(401, {"error": "管理员账号或密码不正确。"})
            return
        remaining = clear_login_failures(client_ip)
        if remaining:
            self._send_login_locked_response(remaining)
            return
        cookie = self._create_session(user["id"])
        self._send_json(
            200, {"username": user["username"], "role": user["role"]}, [cookie]
        )

    def _logout(self):
        token = self._session_token()
        if token:
            token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
            with connect_database() as connection:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        self._send_json(
            200,
            {"message": "已退出登录。"},
            [("Set-Cookie", "gfw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")],
        )


class DualStackThreadingHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def main():
    initialize_database()
    server = DualStackThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"GameWithFriends 已启动：http://127.0.0.1:{PORT}")
    print(f"IPv6 访问地址：http://[::1]:{PORT}")
    print("同一局域网的好友可使用本机局域网 IP 访问此服务。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
