---
name: confluence
description: "Read/write Confluence pages over REST using your account-scoped Atlassian token. Use this whenever a Confluence/wiki page or space is involved — works even when Confluence is on a different Atlassian site than Jira."
capabilities: [confluence]
profiles: [anchor, people-manager, engineering-manager, product-manager]
---

# Skill: Confluence

> Use for any Confluence/wiki page, space, or `/wiki/` URL. For Jira, use the `jira-workflow` skill.

## Why this skill (and the split-instance case)

Some orgs run Jira and Confluence on **different Atlassian sites**, and a single MCP OAuth grant only covers **one site**. So Confluence often can't be reached through the same MCP as Jira. The fix is simple: **Atlassian API tokens are account-scoped, not site-scoped** — the same token that authorizes Jira reaches Confluence over REST too. This skill always uses REST with that token, so it works in both the single-instance and split-instance cases.

> Routing rule: Jira → `jira-workflow`; Confluence → this skill. If `CONFLUENCE_URL` == `JIRA_URL`, you're single-instance and everything is on one site — this skill still works unchanged.

## Credentials

Confluence is **REST-only in Cortex** (no MCP server) — it uses the account-scoped
Atlassian token. `cortex setup` stores these in secure storage (macOS Keychain /
Windows DPAPI / else `~/.cortex/*.env` chmod 600) and your shell loads them:

```
ATLASSIAN_EMAIL        # your atlassian account email
ATLASSIAN_API_TOKEN    # https://id.atlassian.com/manage-profile/security/api-tokens (account-scoped)
CONFLUENCE_URL         # e.g. https://your-org.atlassian.net  (the /wiki path is added below)
HTTPS_PROXY            # optional — corporate proxy only
```

**Never print the token.** Build the header inline.

## Setup — start every operation with this

```bash
CONF="$CONFLUENCE_URL/wiki"
# base64 | tr -d '\n' — GNU base64 wraps at 76 chars, and Atlassian tokens are
# long enough to wrap, which would break the Authorization header on Linux.
AUTH=$(printf '%s:%s' "$ATLASSIAN_EMAIL" "$ATLASSIAN_API_TOKEN" | base64 | tr -d '\n')
conf_get() { curl -s --max-time 30 ${HTTPS_PROXY:+--proxy "$HTTPS_PROXY"} \
  -H "Authorization: Basic $AUTH" -H "Accept: application/json" "$@"; }

# verify
conf_get "$CONF/rest/api/user/current" | jq '.displayName, .accountId'
```

## Reads

```bash
# Page by ID (ID is the number in /pages/{id}/ in the URL), readable text:
conf_get "$CONF/api/v2/pages/{id}?body-format=storage" | jq '{id,title,version:.version.number,body:.body.storage.value}'

# Search with CQL (URL-encode first)
CQL='space = {SPACE} AND title ~ "release"'
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$CQL")
conf_get "$CONF/rest/api/search?cql=$ENC&limit=25" | jq '.results[] | {id:.content.id, title:.content.title, url:.url}'

# List spaces / pages in a space
conf_get "$CONF/api/v2/spaces?limit=50" | jq '.results[] | {id,key,name}'
conf_get "$CONF/api/v2/spaces/{spaceId}/pages?limit=100" | jq '.results[] | {id,title}'
```

Useful CQL: `space = {SPACE} AND type = page AND title ~ "..."`, `space = {SPACE} AND lastModified >= now("-14d")`, `text ~ "keyword"`, `ancestor = {pageId}`.

## Writes — confirm with the user first (bounded autonomy)

```bash
conf_post() { curl -s --max-time 30 ${HTTPS_PROXY:+--proxy "$HTTPS_PROXY"} \
  -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" "$@"; }

# Create a page
conf_post -X POST "$CONF/api/v2/pages" -d '{"spaceId":"{spaceId}","status":"current","title":"Title","body":{"representation":"storage","value":"<p>Hello</p>"}}' | jq '{id,title}'

# Update a page (must bump version)
VER=$(conf_get "$CONF/api/v2/pages/{id}" | jq .version.number)
conf_post -X PUT "$CONF/api/v2/pages/{id}" -d "{\"id\":\"{id}\",\"status\":\"current\",\"title\":\"Title\",\"body\":{\"representation\":\"storage\",\"value\":\"<p>Updated</p>\"},\"version\":{\"number\":$((VER+1)),\"message\":\"Edited via Cortex\"}}" | jq '{id,version:.version.number}'
```

## Errors

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| 401 | Bad/expired token | Regenerate at id.atlassian.com → API tokens; re-run `cortex setup-atlassian` |
| 403 | Account lacks access to this site's content | Request access (separate from any MCP grant) |
| 404 | Wrong page ID / space key | The ID is the number in `/pages/{id}/` |
| 409 on update | Stale version | Re-read version, bump, retry |
| timeout / HTTP 000 | Proxy / off-network | Set `HTTPS_PROXY`; or retry without `--proxy` |

## Rules

- Reads are free; **writes are confirmed** and idempotent. After a write, report the resulting page URL: `$CONFLUENCE_URL/wiki/spaces/{SPACE}/pages/{id}`.
- Confluence is your knowledge/wiki layer; the vault remains the source of truth for your own notes.
