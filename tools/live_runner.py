#!/usr/bin/env python3
"""Runs the live publisher (live_publish.py) for one game server and uploads the pieces to the web server over SSH.

    python3 tools/live_runner.py --sftp "<bot folder>/.nost-data" --sftp-dir tacview \\
        --ssh-host vps --remote-dir /srv/nov-live/s2 --pvp-list "<bot folder>/no_mapvote_bot.py" --log <file>
    python3 tools/live_runner.py --watch-dir /home/container/tacview ...      (on the game server's own machine)

The recording is read from a local folder (--watch-dir), or over SFTP, read only, from a hosted game server (--sftp:
the bot's settings folder, whose config.json and secrets.json hold the login; read again on every reconnect, so a new
password is picked up; needs paramiko). --ssh-host is a host alias from ~/.ssh/config: the web server's address, user
and key live there, never in this repo. The upload uses the system's ssh, one connection kept open for the whole run,
and the web server needs only python3.

Fairness: --pvp-list points at the bot's no_mapvote_bot.py and its PVP_MISSIONS list is read out of the file (the bot
is never imported or run: that would start its own background work). A mission whose name, or whose name before
" - ", is on that list never goes out live; if the list can't be read, nothing goes out. --no-pvp-check is only for a
server that never runs PvP. Never prints hosts, passwords, keys or Steam IDs: error text is scrubbed.
"""
import argparse
import ast
import base64
import contextlib
import fcntl
import json
import logging
import logging.handlers
import os
import select
import shlex
import stat
import subprocess
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live_publish as lp  # noqa: E402

# Runs on the web server, under python3: does what SshOut asks inside its folder, one request at a time. A request is a
# JSON line (and for a write, that many bytes after it); every answer is one JSON line.
HELPER = r'''
import json, os, shutil, sys
root = os.path.abspath(sys.argv[1])
os.makedirs(root, mode=0o755, exist_ok=True)
inp, out = sys.stdin.buffer, sys.stdout
def path(rel):
    p = os.path.abspath(os.path.join(root, rel))
    if p != root and not p.startswith(root + os.sep):
        raise ValueError("outside the folder")
    return p
while True:
    line = inp.readline()
    if not line:
        break
    try:
        q = json.loads(line)
        data = inp.read(q["n"]) if q.get("n") else b""
        op, p, a = q["op"], path(q.get("path", "")), {"ok": True}
        if op == "write":
            os.makedirs(os.path.dirname(p), mode=0o755, exist_ok=True)
            with open(p + ".tmp", "wb") as f:
                f.write(data)
            os.chmod(p + ".tmp", 0o644)
            os.replace(p + ".tmp", p)
        elif op == "makedirs":
            os.makedirs(p, mode=0o755, exist_ok=True)
        elif op == "remove":
            try:
                os.remove(p)
            except FileNotFoundError:
                pass
        elif op == "rmtree":
            shutil.rmtree(p, ignore_errors=True)
        elif op == "list":
            a["items"] = [[e.name, e.is_dir(), e.stat().st_mtime] for e in os.scandir(p)]
        else:
            raise ValueError("unknown request")
    except Exception as e:
        a = {"ok": False, "err": "%s: %s" % (type(e).__name__, e)}
    out.write(json.dumps(a) + "\n")
    out.flush()
'''

TIMEOUT = 30          # seconds to wait for an answer before the connection counts as dead


class SshOut:
    """The web server's folder over one long lived ssh connection, the same contract as live_publish.LocalOut. A dead
    or stuck connection is dropped, and the next request opens a new one."""

    def __init__(self, host, root):
        self.host, self.root = host, root
        self.proc = None

    def _start(self):
        code = "import base64;exec(base64.b64decode(%r))" % base64.b64encode(HELPER.encode()).decode()
        remote = "python3 -u -c %s %s" % (shlex.quote(code), shlex.quote(self.root))
        self.proc = subprocess.Popen(
            ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
             "-o", "ConnectTimeout=15", self.host, remote],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def close(self):
        if self.proc:
            with contextlib.suppress(Exception):
                self.proc.kill()
                self.proc.wait(5)
        self.proc = None

    def _ask(self, op, rel="", data=b""):
        if self.proc is None or self.proc.poll() is not None:
            self.close()
            self._start()
        try:
            q = {"op": op, "path": rel}
            if data:
                q["n"] = len(data)
            self.proc.stdin.write(json.dumps(q).encode() + b"\n" + data)
            self.proc.stdin.flush()
            if not select.select([self.proc.stdout], [], [], TIMEOUT)[0]:
                raise TimeoutError("no answer from the web server")
            line = self.proc.stdout.readline()
            if not line:
                raise ConnectionError("the ssh connection closed")
            a = json.loads(line)
        except Exception:
            self.close()
            raise
        if not a.get("ok"):
            raise OSError(a.get("err", "failed"))
        return a

    def makedirs(self, rel):
        self._ask("makedirs", rel)

    def write(self, rel, data):
        self._ask("write", rel, data)

    def remove(self, rel):
        self._ask("remove", rel)

    def rmtree(self, rel):
        self._ask("rmtree", rel)

    def list(self):
        return [tuple(x) for x in self._ask("list")["items"]]


class SftpSource:
    """A hosted game server's recording folder, read only, over a session of our own that reconnects when it drops."""

    def __init__(self, settings, folder, known_hosts):
        self.settings, self.folder, self.known_hosts = settings, folder, known_hosts
        self.ssh = self.sftp = None

    def login(self):
        """(host, port, user, password) from the bot's settings; environment variables win, as in the bot."""
        def read(name):
            try:
                with open(os.path.join(self.settings, name), encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, ValueError):
                return {}
        cfg, sec = read("config.json"), read("secrets.json")
        srv = cfg.get("server") or {}
        return (os.environ.get("NO_SFTP_HOST") or srv.get("sftp_host") or "",
                int(os.environ.get("NO_SFTP_PORT") or srv.get("sftp_port") or 2022),
                os.environ.get("NO_SFTP_USER") or srv.get("sftp_user") or "",
                os.environ.get("NO_SFTP_PASS") or sec.get("sftp_pass") or "")

    def _s(self):
        if self.sftp is None:
            import paramiko
            host, port, user, password = self.login()
            if not (host and user and password):
                raise RuntimeError("no SFTP login in the bot's settings")
            ssh = paramiko.SSHClient()
            known = os.path.exists(self.known_hosts)
            if known:                          # only the game host seen the first time
                ssh.load_host_keys(self.known_hosts)
                ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
            else:
                ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                ssh.connect(host, port=port, username=user, password=password, timeout=10, banner_timeout=15,
                            auth_timeout=15, look_for_keys=False, allow_agent=False)
            except Exception:
                ssh.close()
                raise
            if not known:
                ssh.save_host_keys(self.known_hosts)
            ssh.get_transport().set_keepalive(15)
            self.ssh, self.sftp = ssh, ssh.open_sftp()
            self.sftp.get_channel().settimeout(25)
        return self.sftp

    def close(self):
        for x in (self.sftp, self.ssh):
            with contextlib.suppress(Exception):
                x and x.close()
        self.ssh = self.sftp = None

    def recordings(self):
        try:
            return [(a.filename, a.st_size, a.st_mtime) for a in self._s().listdir_attr(self.folder)
                    if a.filename.lower().endswith(".acmi") and stat.S_ISREG(a.st_mode or 0)]
        except Exception:
            self.close()
            raise

    def read(self, name, offset, limit=lp.BLOCK):
        try:
            with self._s().open(self.folder + "/" + name, "rb") as f:
                f.seek(offset)
                return f.read(limit)
        except FileNotFoundError:
            return None
        except Exception:
            self.close()
            raise


def pvp_names(bot_file):
    """The bot's PVP_MISSIONS list, read out of its source without running it."""
    with open(bot_file, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "PVP_MISSIONS" for t in node.targets):
            names = ast.literal_eval(node.value)
            if names and all(isinstance(n, str) for n in names):
                return set(names)
    raise ValueError("no PVP_MISSIONS list")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    where = ap.add_mutually_exclusive_group(required=True)
    where.add_argument("--watch-dir", help="local folder the game server's recorder writes the .acmi into")
    where.add_argument("--sftp", help="the bot's settings folder (.nost-data): read the recordings over SFTP")
    ap.add_argument("--sftp-dir", default="tacview", help="the recordings folder on the SFTP server (tacview)")
    ap.add_argument("--known-hosts", help="where the game host's key is kept (default: next to the lock file)")
    ap.add_argument("--ssh-host", required=True, help="host alias in ~/.ssh/config for the web server")
    ap.add_argument("--remote-dir", required=True, help="this server's live folder there, e.g. /srv/nov-live/s2")
    ap.add_argument("--pvp-list", help="the bot's no_mapvote_bot.py: its PVP_MISSIONS never go out live")
    ap.add_argument("--no-pvp-check", action="store_true", help="publish every mission (only for a PvE only server)")
    ap.add_argument("--log", help="log file (rotated at 1 MB, 3 kept); default: the console")
    ap.add_argument("--lock", help="lock file, so only one runs (default: next to the log, or none)")
    ap.add_argument("--once", action="store_true", help="one pass, then exit (tests)")
    a = ap.parse_args()

    logger = logging.getLogger("nov-live")
    h = (logging.handlers.RotatingFileHandler(a.log, maxBytes=1 << 20, backupCount=3, encoding="utf-8") if a.log
         else logging.StreamHandler(sys.stdout))
    h.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%m-%d %H:%M:%S"))
    logger.addHandler(h)
    logger.setLevel(logging.INFO)
    lp.log = logger.info

    lock_path = a.lock or (a.log + ".lock" if a.log else None)
    if lock_path:
        lock = open(lock_path, "a+")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            lp.log("another live runner is already running")
            return
    with contextlib.suppress(OSError):
        os.nice(10)                  # the game server always comes first

    if a.pvp_list:
        try:
            pvp = pvp_names(a.pvp_list)
        except Exception as e:       # noqa: BLE001 - no list, nothing goes out
            pvp = None
            lp.log("could not read the PvP mission list (%s): nothing goes out live" % type(e).__name__)

        def allow(title):            # PvP never goes out live (the bot's own is_pvp() rule)
            base = str(title or "").split(" - ", 1)[0].strip()
            ok = bool(pvp) and bool(title) and title not in pvp and base not in pvp
            lp.log("%s live: %s" % ("going out" if ok else "not going out", title))
            return ok
    elif a.no_pvp_check:
        allow = None
    else:
        def allow(title):
            lp.log("not going out live (no --pvp-list to check for PvP): %s" % title)
            return False

    if a.sftp:
        src = SftpSource(a.sftp, a.sftp_dir, a.known_hosts or os.path.join(os.path.dirname(lock_path or a.sftp),
                                                                           "gamehost_known_hosts"))
        scrub = [a.ssh_host, src.login()[0]]
    else:
        src = lp.LocalDir(a.watch_dir)
        scrub = [a.ssh_host]
    args = types.SimpleNamespace(watch_dir=a.watch_dir or "the game host (sftp, read only)", out="<web server>:<live folder>", piece=10, delay=45,
                                 keep=900, poll=1.0, active=180, idle_end=120, switch_quiet=10, cleanup=600,
                                 once=a.once)
    lp.run(args, src=src, out=SshOut(a.ssh_host, a.remote_dir), allow=allow, scrub=[x for x in scrub if x])


if __name__ == "__main__":
    try:
        main()
    except BaseException as e:       # noqa: BLE001 - the reason it stopped, without addresses
        if not isinstance(e, (KeyboardInterrupt, SystemExit)):
            lp.log("stopped: %s" % type(e).__name__)
        raise
