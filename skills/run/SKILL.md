---
name: run
description: Run the taskforce loop until every task is merged or blocked — builders in worktrees, DoD gates, merge into the integration branch. Use when the user runs /taskforce:run or asks taskforce to start/continue working.
---

# Run the taskforce loop

Talk to the user in their language (Vietnamese if they write Vietnamese). Keep updates to one line each.

1. Say in one line what will happen: "Em bắt đầu chạy. Gõ `/tf` để xem dashboard, `/tf pause` để dừng gấp."
2. Call `tf` action `requeue` once (a previous run may have died mid-build).
3. Repeat until done:
   - Call `tf` action `next`.
   - **TF-BUILD** → call the Workflow tool with the given `name` and `args`, exactly as given. Wait for it to finish (you will be notified). Then call `tf` action `report` with `results` = the array the workflow returned, unchanged.
   - **TF-MERGE** → run the given Bash command exactly as written (no edits, no pipes). Then call `tf` action `report` with `results` = the JSON array it printed.
   - **TF-DONE** → stop the loop.
   - Never edit the ledger or the config file yourself, never fix code yourself, never skip a gate.
4. **If the user's usage limit or an error stops you**, say where things stand and that running `/taskforce:run` again continues from the ledger.
5. **Finish with a short summary in the user's language:**
   - đã xong: which tasks merged into the integration branch;
   - cần anh quyết định: each blocked task with its one-line reason, and `/tf retry <id>` to run it again;
   - bước tiếp: review the integration branch and merge it to the main branch yourself when satisfied.
