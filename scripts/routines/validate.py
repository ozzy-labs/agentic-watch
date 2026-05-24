#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6"]
# ///
"""Validate `.claude/routines/*.yaml` against the routine contract.

Run by Lefthook pre-push (see `lefthook.yaml`) and standalone:

    uv run scripts/routines/validate.py                 # all .claude/routines/*.yaml
    uv run scripts/routines/validate.py path/to/file.yaml ...

Checks (ADR-0020 / #280; mirrors `.claude/routines/README.md`):

  - required fields present: name, status, repositories, model, triggers,
    instructions, environment.setup_script
  - status is one of {active, draft}
  - status <-> routine_id integrity: an `active` routine must carry a
    non-empty routine_id; a `draft` may leave it empty
  - every scheduled trigger uses a 5-field cron with a >= 1-hour interval
    (Claude Routines reject sub-hourly schedules)

`_template.yaml` is skipped: it holds intentional `<placeholder>` values and a
`draft` status with empty routine_id, which is the documented template shape.

Exit code: 0 if all files valid, 1 if any file has >= 1 error.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

REQUIRED_FIELDS = ("name", "status", "repositories", "model", "triggers", "instructions")
VALID_STATUS = ("active", "draft")

# Per-token grammar for one cron field (mirrors isValidCron in
# src/cli/routine/generate-watch.ts): `*`, `n`, `n-m`, each with optional
# `/step`, comma-joined.
_CRON_TOKEN = __import__("re").compile(r"^(?:\*|\d+(?:-\d+)?)(?:/\d+)?$")


def is_valid_cron(expr: str) -> bool:
    """5-field POSIX cron, structural check (no range-bound enforcement)."""
    fields = expr.strip().split()
    if len(fields) != 5:
        return False
    for field in fields:
        if not field:
            return False
        for token in field.split(","):
            if not token or not _CRON_TOKEN.match(token):
                return False
    return True


def is_sub_hourly_cron(expr: str) -> bool:
    """True if the minute field would fire more than once per hour.

    Mirrors isSubHourlyCron in src/cli/routine/generate-watch.ts. Assumes
    is_valid_cron(expr) already passed.
    """
    minute = expr.strip().split()[0]
    if minute == "*":
        return True
    if "/" in minute:  # step => multiple firings/hour
        return True
    if "-" in minute:  # range => every minute in range
        return True
    return len({m for m in minute.split(",")}) > 1


def validate_file(path: Path) -> list[str]:
    """Return a list of human-readable error strings (empty == valid)."""
    errors: list[str] = []
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        return [f"YAML parse error: {exc}"]
    if not isinstance(data, dict):
        return ["top-level YAML must be a mapping"]

    for field in REQUIRED_FIELDS:
        if field not in data or data[field] in (None, "", []):
            errors.append(f"missing required field: {field}")

    env = data.get("environment")
    if not isinstance(env, dict) or not env.get("setup_script"):
        errors.append("missing required field: environment.setup_script")

    status = data.get("status")
    if status not in VALID_STATUS:
        errors.append(f"status must be one of {VALID_STATUS}, got {status!r}")

    # status <-> routine_id integrity.
    routine_id = data.get("routine_id") or ""
    if status == "active" and not str(routine_id).strip():
        errors.append("status is 'active' but routine_id is empty (set the issued trig_xxxx)")

    triggers = data.get("triggers")
    if isinstance(triggers, list):
        for i, trig in enumerate(triggers):
            if not isinstance(trig, dict):
                errors.append(f"triggers[{i}] must be a mapping")
                continue
            if trig.get("type") != "scheduled":
                continue
            cron = trig.get("cron")
            if not isinstance(cron, str) or not is_valid_cron(cron):
                errors.append(f"triggers[{i}].cron is not a valid 5-field cron: {cron!r}")
            elif is_sub_hourly_cron(cron):
                errors.append(
                    f"triggers[{i}].cron {cron!r} is sub-hourly; "
                    "Claude Routines require a >= 1-hour interval"
                )
    elif triggers not in (None, ""):
        errors.append("triggers must be a list")

    return errors


def collect_targets(argv: list[str]) -> list[Path]:
    if argv:
        return [Path(a) for a in argv]
    routines_dir = Path(".claude/routines")
    if not routines_dir.is_dir():
        return []
    return sorted(routines_dir.glob("*.yaml"))


def main(argv: list[str]) -> int:
    targets = collect_targets(argv)
    if not targets:
        print("routines/validate: no .claude/routines/*.yaml files to check")
        return 0

    had_error = False
    for path in targets:
        # _template.yaml carries intentional placeholders; skip it.
        if path.name == "_template.yaml":
            continue
        if not path.is_file():
            print(f"FAIL {path}: file not found")
            had_error = True
            continue
        errors = validate_file(path)
        if errors:
            had_error = True
            print(f"FAIL {path}:")
            for err in errors:
                print(f"  - {err}")
        else:
            print(f"OK   {path}")

    if had_error:
        print("\nroutines/validate: validation failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
