---
name: plan
description: Turn a plain-language description of work into small taskforce tasks with testable acceptance criteria, show them to the user for approval, then add them to the ledger. Use when the user runs /taskforce:plan <description> or asks to plan work for taskforce.
argument-hint: <mô tả việc cần làm>
---

# Plan work for taskforce

The work to plan: **$ARGUMENTS**

Talk to the user in their language (Vietnamese if they write Vietnamese).

1. **If the description is empty or too vague to test**, ask at most 3 short questions, then continue.
2. **Read just enough of the repo** to plan well: `CLAUDE.md`, `taskforce.json` (gates and locked files), the modules the work touches. Call `tf` action `status` to see existing task ids and avoid clashes.
3. **Split the work into tasks.** Rules:
   - One task = one small, complete piece a builder can finish and test alone (usually 1–3 files). 2–6 tasks for a feature.
   - Each task gets 2–4 acceptance criteria that a test or a check can prove. No vague words ("clean", "nice").
   - List the files each task will touch (`files`), so tasks that share a file never run at the same time.
   - Add `deps` only when a task truly needs another one merged first.
   - Ids short and stable: a prefix from the feature plus a number (`pay1`, `pay2`).
4. **Show the plan as a table and wait for the user's OK:** id · việc · tiêu chí hoàn thành · file · phụ thuộc. Below it, one line: how many tasks can run in parallel. Ask: "Anh duyệt plan này chứ? Muốn sửa gì cứ nói."
5. **Only after the user agrees**, call `tf` action `add` with the tasks (`id`, `title`, `goal`, `accept`, `files`, `deps`). Never write the ledger file directly.
6. **End with the next step:** "Đã thêm N task. Bước tiếp: gõ `/taskforce:run` để chạy. Gõ `/tf` để theo dõi."
