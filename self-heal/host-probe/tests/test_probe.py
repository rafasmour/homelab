"""Unit tests for probe.py against a fake /proc and /sys tree.

Run: python -m unittest discover -s tests   (from host-probe/)
"""

import builtins
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import probe  # noqa: E402

CID_A = "a" * 64
CID_B = "0123456789abcdef" * 4
SECRET = "SUPERSECRET-api-key-123"

MEMINFO = """MemTotal:       15787736 kB
MemFree:          250180 kB
MemAvailable:    8976952 kB
Buffers:          596632 kB
Cached:          7836608 kB
SwapCached:       141636 kB
SwapTotal:       4194300 kB
SwapFree:           2160 kB
Dirty:              4328 kB
Shmem:            256404 kB
AnonPages:       4855176 kB
Mlocked:            9304 kB
CommitLimit:    12088168 kB
Committed_AS:   32231124 kB
HugePages_Total:       0
HugePages_Free:        0
HugePages_Rsvd:        0
HugePages_Surp:        0
Hugepagesize:       2048 kB
"""
PSI = """some avg10=1.50 avg60=0.20 avg300=0.00 total=58086219
full avg10=0.75 avg60=0.10 avg300=0.00 total=56634872
"""


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)


def status(name, rss_kb, swap_kb=0, threads=4):
    text = "Name:\t%s\nState:\tS (sleeping)\nThreads:\t%d\n" % (name, threads)
    if rss_kb is not None:
        text += ("VmRSS:\t%d kB\nRssAnon:\t%d kB\nRssFile:\t%d kB\nVmSwap:\t%d kB\n"
                 % (rss_kb, rss_kb - 10, 10, swap_kb))
    return text


class FakeHost(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.proc = os.path.join(root, "proc")
        self.sys = os.path.join(root, "sys")
        p, s = self.proc, self.sys
        write(p, "meminfo", MEMINFO)
        write(p, "swaps", "Filename\tType\tSize\tUsed\tPriority\n"
                          "/swap.img                               file\t\t4194300\t\t4192140\t\t-1\n")
        write(p, "vmstat", "pswpin 100\npswpout 200\npgmajfault 300\n")
        for kind in ("cpu", "io", "memory"):
            write(p, "pressure/" + kind, PSI)
        write(p, "loadavg", "1.25 0.80 0.50 3/1234 99999\n")
        write(p, "uptime", "12345.67 99999.00\n")
        write(p, "sys/kernel/osrelease", "7.0.0-38-generic\n")
        write(p, "sys/vm/swappiness", "60\n")
        write(p, "sys/vm/overcommit_memory", "0\n")
        # pid 10: big container process, pid 20: host process, pid 2: kthread
        write(p, "10/status", status("llama-server", 4_000_000, 500_000, 32))
        write(p, "10/comm", "llama-server-with-a-long-name\n")
        write(p, "10/cgroup", "0::/system.slice/docker-%s.scope\n" % CID_A)
        write(p, "20/status", status("dockerd", 100_000))
        write(p, "20/comm", "dockerd\n")
        write(p, "20/cgroup", "0::/system.slice/docker.service\n")
        write(p, "30/status", status("postgres", 50_000))
        write(p, "30/comm", "postgres\x1b[31m\n")
        write(p, "30/cgroup", "0::/docker/%s\n" % CID_B)
        write(p, "2/status", status("kthreadd", None))
        write(p, "2/comm", "kthreadd\n")
        for pid in ("10", "20", "30"):
            write(p, pid + "/cmdline", "llama-server --api-key " + SECRET)
            write(p, pid + "/environ", "API_KEY=" + SECRET)
            write(p, pid + "/maps", SECRET)
        write(s, "devices/system/cpu/online", "0-11,14\n")
        cg = "fs/cgroup/system.slice/docker-%s.scope/" % CID_A
        write(s, cg + "memory.current", "4096000000\n")
        write(s, cg + "memory.swap.current", "1000\n")
        write(s, cg + "memory.max", "max\n")
        write(s, cg + "memory.swap.max", "0\n")
        write(s, cg + "memory.events", "low 0\nhigh 1\nmax 2\noom 3\noom_kill 4\noom_group_kill 0\n")
        write(s, cg + "memory.pressure", PSI)
        write(s, "fs/cgroup/docker/%s/memory.current" % CID_B, "1000\n")
        write(s, "fs/cgroup/system.slice/docker.service/memory.current", "5\n")
        dev = "devices/pci0000:00/0000:03:00.0/"
        write(s, dev + "mem_info_vram_total", "17163091968\n")
        write(s, dev + "mem_info_vram_used", "1073741824\n")
        write(s, dev + "mem_info_gtt_total", "8000000000\n")
        write(s, dev + "mem_info_gtt_used", "100000\n")
        write(s, dev + "gpu_busy_percent", "7\n")
        write(s, dev + "hwmon/hwmon3/temp1_input", "45000\n")
        write(s, dev + "hwmon/hwmon3/temp1_label", "edge\n")
        write(s, dev + "hwmon/hwmon3/temp2_input", "52000\n")
        write(s, dev + "hwmon/hwmon3/power1_average", "35000000\n")
        write(s, dev + "hwmon/hwmon3/power1_cap", "200000000\n")
        os.makedirs(os.path.join(s, "class/drm"))
        # relative symlinks, as in real sysfs
        os.symlink("../../devices/pci0000:00/0000:03:00.0/drm_card1",
                   os.path.join(s, "class/drm/card1"))
        write(s, dev + "drm_card1/.keep", "")
        os.symlink("..", os.path.join(s, dev + "drm_card1/device"))
        os.makedirs(os.path.join(s, "class/drm/card1-DP-1"))
        probe.HOST_PROC, probe.HOST_SYS = self.proc, self.sys
        probe.VMSTAT_INTERVAL = 0.01

        self.opened = []
        real_open = builtins.open

        def spy(path, *args, **kwargs):
            self.opened.append(str(path))
            return real_open(path, *args, **kwargs)

        builtins.open = spy
        self.addCleanup(setattr, builtins, "open", real_open)

    def tearDown(self):
        self.tmp.cleanup()

    def assert_no_forbidden_opens(self):
        for path in self.opened:
            self.assertNotIn(os.path.basename(path), probe.FORBIDDEN_NAMES, path)

    def test_memory(self):
        out = probe.memory()
        self.assertEqual(out["meminfo"]["MemTotal"], 15787736 * 1024)
        self.assertEqual(out["meminfo"]["HugePages_Total"], 0)
        self.assertEqual(out["swaps"][0]["device"], "/swap.img")
        self.assertEqual(out["swaps"][0]["used_bytes"], 4192140 * 1024)
        self.assertEqual(out["pressure_memory"]["some"]["avg10"], 1.5)
        self.assertEqual(out["vmstat_rates"]["pswpin_per_s"], 0.0)
        self.assertIsNone(out["zram"])
        self.assert_no_forbidden_opens()

    def test_memory_zram(self):
        write(self.sys, "block/zram0/mm_stat", "100 50 60 0 70 1 0 2\n")
        write(self.sys, "block/zram0/disksize", "4096\n")
        out = probe.memory()
        self.assertEqual(out["zram"][0]["mm_stat"]["compr_data_size"], 50)

    def test_processes(self):
        out = probe.processes()
        rows = out["top_by_rss_plus_swap"]
        self.assertEqual([r["pid"] for r in rows], [10, 20, 30])
        self.assertEqual(rows[0]["comm"], "llama-server-wi")
        self.assertEqual(rows[0]["container_id"], CID_A)
        self.assertEqual(rows[0]["swap_bytes"], 500_000 * 1024)
        self.assertEqual(rows[0]["threads"], 32)
        self.assertIsNone(rows[1]["container_id"])
        self.assertEqual(rows[2]["container_id"], CID_B)
        self.assertNotIn("\x1b", rows[2]["comm"])
        self.assertNotIn(SECRET, json.dumps(out))
        self.assert_no_forbidden_opens()
        self.assertFalse(any("cmdline" in p or "environ" in p for p in self.opened))

    def test_container_id_formats(self):
        self.assertEqual(probe.parse_container_id(
            "0::/system.slice/docker-%s.scope/init\n" % CID_A), CID_A)
        self.assertEqual(probe.parse_container_id("12:memory:/docker/%s\n" % CID_B), CID_B)
        self.assertIsNone(probe.parse_container_id("0::/user.slice/x.scope\n"))
        self.assertIsNone(probe.parse_container_id("0::/docker-%s.scopeX\n" % ("a" * 63)))

    def test_cgroups(self):
        out = probe.cgroups()
        self.assertEqual(out["total"], 2)
        first = out["containers"][0]
        self.assertEqual(first["container_id"], CID_A)
        self.assertEqual(first["memory_max"], "max")
        self.assertEqual(first["memory_swap_max"], 0)
        self.assertEqual(first["memory_events"], {"high": 1, "max": 2, "oom": 3, "oom_kill": 4})
        second = out["containers"][1]
        self.assertIsNone(second["memory_pressure"])
        self.assertIsNone(second["memory_max"])

    def test_overview(self):
        out = probe.overview()
        self.assertEqual(out["nproc"], 13)
        self.assertEqual(out["loadavg"]["running"], 3)
        self.assertEqual(out["kernel"], "7.0.0-38-generic")
        self.assertEqual(out["vm_swappiness"], 60)
        self.assertEqual(out["pressure"]["io"]["full"]["avg10"], 0.75)

    def test_gpu(self):
        out = probe.gpu()
        self.assertEqual(len(out["cards"]), 1)
        card = out["cards"][0]
        self.assertEqual(card["vram_used_bytes"], 1073741824)
        self.assertEqual(card["temps_c"], {"edge": 45.0, "temp2": 52.0})
        self.assertEqual(card["power_w"], 35.0)
        self.assertIsNone(card["fan_rpm"])

    def test_missing_everything_is_null(self):
        probe.HOST_PROC = probe.HOST_SYS = os.path.join(self.tmp.name, "nothing")
        self.assertIsNone(probe.memory()["meminfo"]["MemTotal"])
        self.assertEqual(probe.processes()["top_by_rss_plus_swap"], [])
        self.assertEqual(probe.cgroups()["containers"], [])
        self.assertIsNone(probe.overview()["kernel"])
        self.assertEqual(probe.gpu()["cards"], [])

    def test_read_refuses_forbidden_and_escapes(self):
        self.assertIsNone(probe._read(self.proc, "10", "cmdline"))
        self.assertIsNone(probe._read(self.proc, "10", "environ"))
        self.assertIsNone(probe._read(self.proc, "..", "proc", "meminfo"))
        self.assertIsNone(probe._read(self.proc, "10/../meminfo"))
        os.symlink("/etc/hostname", os.path.join(self.proc, "escape"))
        self.assertIsNone(probe._read(self.proc, "escape"))
        os.symlink("10/cmdline", os.path.join(self.proc, "alias"))
        self.assertIsNone(probe._read(self.proc, "alias"))
        self.assert_no_forbidden_opens()


class ServerTest(FakeHost):
    TOKEN = "t" * 32

    def setUp(self):
        super().setUp()
        self.server = probe.make_server(self.TOKEN, host="127.0.0.1", port=0)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method, path, token=TOKEN):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Authorization": "Bearer " + token} if token is not None else {}
        conn.request(method, path, headers=headers)
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp.status, body

    def test_auth(self):
        self.assertEqual(self.request("GET", "/overview", token=None)[0], 401)
        self.assertEqual(self.request("GET", "/overview", token="wrong")[0], 401)
        self.assertEqual(self.request("GET", "/overview", token=self.TOKEN + "x")[0], 401)
        self.assertEqual(self.request("GET", "/overview")[0], 200)
        self.assertEqual(self.request("GET", "/healthz", token=None)[0], 200)

    def test_methods_and_paths(self):
        for method in ("POST", "PUT", "DELETE", "HEAD"):
            self.assertEqual(self.request(method, "/overview")[0], 405)
        self.assertEqual(self.request("GET", "/proc/10/cmdline")[0], 404)
        self.assertEqual(self.request("GET", "/memory/../processes")[0], 404)
        status_code, body = self.request("GET", "/processes?pid=10&file=cmdline")
        self.assertEqual(status_code, 200)
        self.assertNotIn(SECRET.encode(), body)
        for path in probe.ROUTES:
            code, body = self.request("GET", path)
            self.assertEqual(code, 200, path)
            json.loads(body)
            self.assertLess(len(body), 64 * 1024)
            self.assertNotIn(SECRET.encode(), body)
        self.assert_no_forbidden_opens()


if __name__ == "__main__":
    unittest.main()
