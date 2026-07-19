# Contributing — READ THIS BEFORE PUSHING

## The rules (enforced by the repo, not by trust)
1. **Never push to `main`.** It is protected — direct pushes are rejected.
2. Work on a branch: `git checkout -b feature/short-name`
3. Push your branch and open a **Pull Request**.
4. The **CI must be green** (it runs `npm test` — a real server boot +
   endpoint checks). Red CI = the merge button is locked.
5. One approving review is required before merge.

## Before you open a PR
```bash
npm install
npm test        # must print: SMOKE TEST PASSED ✔
```
If `npm test` fails locally, it WILL fail in CI. Fix it first.

## Ground rules
- Never commit secrets (.env, API keys, tokens). `.env` is gitignored — keep it that way.
- Don't change `src/db.js` schemas casually — existing user data must survive
  (add columns/tables; never drop or rename without a migration plan).
- New endpoints go behind `appAuth` unless there's a written reason.
- Update PROJECT_STATUS.md in the same PR as your change.
