# tv-watchlist-builder
Build TradingView watchlists from JPX stocks with a previous close under 1,000 yen.

## AutoFix automation

`Build TradingView Watchlists` is manually triggered from GitHub Actions. When that workflow fails, `Auto Fix on Build Failure` automatically:

1. creates an `autofix/fix-*` branch;
2. commits `.autofix/failure_report.md` to that branch;
3. collects the failed run metadata, logs, and artifacts as an `autofix-context-*` workflow artifact;
4. opens an `autofix-needed` pull request and tracking issue.

GitHub Actions does not run Codex and does not need an OpenAI API key.

The actual repair is handled by a Codex app automation that checks every 30 minutes for open `autofix-needed` PRs or issues. Use `.github/codex/prompts/automation-autofix.md` as the automation prompt.

Optional repository variables/secrets:

- `AUTOFIX_AUTO_MERGE`: set to `true` to add the `autofix-auto-merge` label to new AutoFix PRs. Codex automation may merge only when this label is present and verification succeeds.
- `AUTOFIX_HELP_WEBHOOK_URL`: Discord webhook used when post-merge recovery retries fail.

After an AutoFix PR is merged, `Post AutoFix Build Trigger` reruns `Build TradingView Watchlists`. It retries up to 4 times within 1 hour and closes open `autofix-needed` issues when recovery succeeds.
