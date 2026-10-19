---
name: setup
description: Set up taskforce in the current git repo — find its build/test commands, propose the DoD gates and protected files, and write taskforce.json only after the user approves. Use when the user runs /taskforce:setup or asks to install/configure taskforce here.
---

# Set up taskforce in this repo

Talk to the user in their language (Vietnamese if they write Vietnamese). Short, plain sentences.

1. **Check the basics** (read-only): this must be a git repo (`git rev-parse --show-toplevel`), and note the current branch and whether the working tree is clean. If it is not a git repo, stop and say so; do not run `git init` without asking.
2. **Find how the repo is checked.** Look at the files that say it: `package.json` scripts, `pyproject.toml` / `setup.cfg` / `tox.ini`, `Makefile`, `go.mod`, `Cargo.toml`, CI files (`.github/workflows/*`), `CLAUDE.md`, `README`. Pick the commands that build, lint, type-check and test. Run each once to confirm it exits 0 on the current tree; drop or flag any that fail now.
3. **Propose the config as a short table and wait for the user's OK:**
   - `base`: the integration branch agents merge into (default `develop`; if it does not exist, propose creating it from the current branch).
   - `gates`: name → command, cheapest first. Only commands that exit non-zero on failure.
   - `locked`: globs the agents may read but never edit — existing tests that define behaviour, specs, fixtures, CI config, the gate scripts themselves.
   - `maxParallel`: 3 unless the test suite is slow or shares a database (then 1–2).
   Say in one line what each gate protects. Ask: "OK để em lưu không?"
4. **Only after the user agrees:** create the base branch if needed (`git branch <base>` then `git checkout <base>`), call the `tf` tool with action `init` and the agreed config, then commit `taskforce.json` and `.gitignore` with message `chore: set up taskforce`.
5. **End with the next step:** "Xong bước 1. Bước tiếp: gõ `/taskforce:plan <mô tả việc cần làm>`. Gõ `/tf` để xem dashboard."
