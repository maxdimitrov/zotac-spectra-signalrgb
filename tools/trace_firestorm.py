"""Spawn FireStorm under Frida, load nvapi_hook.js, log to a file.

Usage: python trace_firestorm.py <hook.js> <out.log>
Press Enter in the console to drop a MARK line into the log.
"""
import sys
import threading
import time
import json

import frida

EXE = r"C:\Program Files (x86)\ZotacFireStorm\FireStorm.exe"
CWD = r"C:\Program Files (x86)\ZotacFireStorm"

js_path, log_path = sys.argv[1], sys.argv[2]
log = open(log_path, "w", encoding="utf-8", buffering=1)
done = threading.Event()


def on_message(msg, data):
    if msg["type"] == "send":
        line = msg["payload"]
        log.write(line + "\n")
        if " I2C " in line or line.startswith("#"):
            print(line[:220])
    else:
        log.write("# ERROR " + json.dumps(msg) + "\n")
        print("# ERROR", msg.get("description"))


def on_detached(reason, crash):
    log.write(f"# detached: {reason}\n")
    done.set()


dev = frida.get_local_device()
pid = dev.spawn([EXE], cwd=CWD)
sess = dev.attach(pid)
sess.on("detached", on_detached)
script = sess.create_script(open(js_path, encoding="utf-8").read())
script.on("message", on_message)
script.load()
dev.resume(pid)
print(f"Tracing FireStorm pid {pid}. Log: {log_path}")
print("Press Enter right BEFORE each colour change (adds a MARK). Close FireStorm when done.")

marks = 0


def stdin_marks():
    global marks
    for _ in sys.stdin:
        marks += 1
        log.write(f"=== MARK {marks} at {time.strftime('%H:%M:%S')} ===\n")
        print(f"MARK {marks}")


threading.Thread(target=stdin_marks, daemon=True).start()
done.wait()
log.close()
print("FireStorm closed; trace saved.")
