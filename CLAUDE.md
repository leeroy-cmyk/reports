# CLAUDE.md — W225 Rehab Reports Repo

This file tells Claude Code how to work in this repository.

## What This Repo Is

Static HTML reports site hosted at **leeroy-cmyk.github.io/reports** for McKay Property Management — Maintenance & Construction team. No build system, no dependencies. Every file is a self-contained HTML page.

## Your Primary Job Here

Update the **W225 renovation timeline** (`w225_timeline.html`) when dates change. Lee Roy will tell you things like:

> "Move plumbing 3rd floor to June 20"
> "Flooring starts July 7, done July 18"
> "Mark boiler install complete"
> "Push all paint floors back one week"

You find the task in the `SECTIONS` array, change the date, and push.

## How the Timeline File Works

All task data is in the `SECTIONS` array near the top of `w225_timeline.html`. Each section is a phase of the renovation. Each task inside it looks like this:

```js
{name:'Water Heater Install', start:null, end:'2026-06-30'},
```

### Field rules

| Field | What to put |
|-------|-------------|
| `start` | `'YYYY-MM-DD'` string, or `null` if unknown |
| `end` | `'YYYY-MM-DD'` string (due date), or `null` if unknown |
| `done` | `true` when the task is finished — turns the bar green with ✓ |
| `blockedBy` | Array of task name strings — informational only, doesn't auto-shift dates |
| `deps` | Array of task names this task blocks — informational only |

### Bar vs milestone vs TBD

- **start + end both set** → full colored bar spanning those dates
- **only end set** → diamond milestone on the due date
- **both null** → shows "date TBD" in gray

### When someone says "push X back N weeks"

Add `N * 7` days to both the `start` and `end` dates. If `start` is `null`, only update `end`.

### When someone says "mark X complete"

Add `done:true` to the task object.

## Making Changes

1. Read the current `w225_timeline.html` first
2. Find the task by name in the `SECTIONS` array (Ctrl+F / grep works fine)
3. Edit the date string(s)
4. Commit with a short message like `chore: update plumbing 3rd floor to Jun 20`
5. Push — site updates within ~60 seconds

## Git Workflow

- Branch: `main` — push directly, no PRs needed
- Always `git pull --rebase` before pushing to avoid conflicts (Lee Roy's Claude also pushes to this repo)
- If push is rejected, `git pull --rebase origin main && git push`

## Other Files in This Repo

You are only responsible for `w225_timeline.html` unless told otherwise. Do not modify other reports files (qbtime_report.html, turn_vac_report.html, etc.) without explicit instruction from Lee Roy.

## Contact

Lee Roy Phillips owns this repo. His email is LeeRoy@m5c7.com.
