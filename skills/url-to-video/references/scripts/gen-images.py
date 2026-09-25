#!/usr/bin/env python3
"""Generate one still image per spot via MiniMax text-to-image, 3-way parallel.

Defaults match `examples/guangzhou-clone/gen-images.py`. Reads credentials
from `/opt/hypit/.env`. Saves under the project root's `assets/broll/`
directory. The caller supplies the project root and the list of (id, prompt)
pairs; this file does no creative direction — only transport.

Usage:
    python3 gen-images.py \\
        --project /opt/hypit/examples/<project> \\
        --jobs spot-01-cantontower="Canton Tower at dusk, ..." \\
               spot-02-baiyun="Baiyun Mountain cable car ..." \\
        --ratio 9:16 \\
        --workers 3

Each prompt is expected to already end with the conventions from
`references/conventions.md` (`no text, no watermark, vertical 9:16`). If a
spot is in `--text-free` mode (a name substring like "text-free"), the script
sets `prompt_optimizer: false` and re-renders up to 3 times.
"""
import argparse
import concurrent.futures
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ENV_FILE = "/opt/hypit/.env"
DEFAULT_TIMEOUT = 180
DEFAULT_WORKERS = 3
DEFAULT_RATIO = "9:16"


def load_env(path):
    env = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def fetch_one(env, slug, prompt, ratio, timeout, text_free):
    out_dir = Path(env["_PROJECT"]) / "assets" / "broll"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{slug}.jpg"
    if out_path.exists() and out_path.stat().st_size > 10_000:
        return f"[skip] {out_path.name} ({out_path.stat().st_size}B)"

    body = json.dumps({
        "model": env["MINIMAX_DEFAULT_MODEL"],
        "prompt": prompt,
        "aspect_ratio": ratio,
        "response_format": "url",
        "n": 1,
        "prompt_optimizer": not text_free,
    })
    url = env["MINIMAX_BASE_URL"].rstrip("/") + "/v1/image_generation"

    last_err = ""
    for attempt in range(1, 4 if text_free else 2):
        try:
            proc = subprocess.run(
                ["curl", "-sS", "-m", str(timeout), "-X", "POST", url,
                 "-H", f"Authorization: Bearer {env['MINIMAX_API_KEY']}",
                 "-H", "Content-Type: application/json",
                 "-d", body, "-w", "\n%{http_code}\t%{time_total}"],
                capture_output=True, text=True, timeout=timeout + 10,
            )
        except subprocess.TimeoutExpired:
            last_err = f"timeout after {timeout}s"
            time.sleep(2)
            continue
        raw = proc.stdout
        body_str, _, status_str = raw.rpartition("\n")
        parts = status_str.split("\t") if status_str else []
        http_code = parts[0] if parts else "?"
        elapsed = parts[1] if len(parts) > 1 else "?"
        try:
            j = json.loads(body_str)
        except Exception as e:
            last_err = f"bad-json: {e}"
            continue
        if j.get("base_resp", {}).get("status_code", 0) != 0:
            last_err = f"base_resp={j['base_resp']}"
            break  # business error — retrying won't help
        urls = j.get("data", {}).get("image_urls", []) or []
        if not urls:
            last_err = f"no-url success_count={j.get('metadata', {}).get('success_count')}"
            time.sleep(2)
            continue
        dl = subprocess.run(
            ["curl", "-sS", "-m", "60", "-L", "-o", str(out_path), urls[0]],
            capture_output=True, text=True, timeout=70,
        )
        if out_path.exists() and out_path.stat().st_size > 10_000:
            return (f"[ok]   {out_path.name} {out_path.stat().st_size}B "
                    f"http={http_code} elapsed={elapsed}s attempt={attempt}")
        last_err = "download-empty"
    return f"[fail] {slug} after retries: {last_err}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--jobs", nargs="+", required=True,
                    metavar="SLUG=PROMPT",
                    help="One per spot. SLUG becomes assets/broll/<SLUG>.jpg")
    ap.add_argument("--ratio", default=DEFAULT_RATIO)
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    ap.add_argument("--text-free", nargs="*", default=[],
                    help="Slugs that need prompt_optimizer=false and 3 retries")
    args = ap.parse_args()

    env = load_env(ENV_FILE)
    for k in ("MINIMAX_API_KEY", "MINIMAX_BASE_URL", "MINIMAX_DEFAULT_MODEL"):
        if not env.get(k):
            sys.exit(f"missing {k} in {ENV_FILE}")
    env["_PROJECT"] = args.project

    jobs = []
    for spec in args.jobs:
        if "=" not in spec:
            sys.exit(f"bad --jobs entry (need SLUG=PROMPT): {spec!r}")
        slug, prompt = spec.split("=", 1)
        jobs.append((slug.strip(), prompt.strip()))
    text_free = set(args.text_free)

    print(f"starting {len(jobs)} jobs on {args.workers} workers...", flush=True)
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {
            ex.submit(fetch_one, env, slug, prompt, args.ratio, args.timeout,
                      slug in text_free): slug
            for slug, prompt in jobs
        }
        for fut in concurrent.futures.as_completed(futs):
            print(fut.result(), flush=True)
    print(f"total wall: {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()