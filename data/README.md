# Local Secrets

This directory is used for local runtime data only.

- The default generic token path is `data/oauth-tokens.json`.
- Older Swiggy-based setups may still use `data/swiggy-oauth.json` for backward compatibility.
- That file is intentionally ignored and must never be committed or uploaded.
- If you need to recreate the token, start the bridge and complete `/admin/login` again.

Only this placeholder file should be tracked in Git.
