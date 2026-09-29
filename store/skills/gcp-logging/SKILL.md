---
name: gcp-logging
description: Query application runtime logs from GCP Cloud Logging for apps running on OpenShift Container Platform (OCP). Use when investigating production/QA errors, searching for specific log codes, tracing requests, or checking API error rates.
---

# GCP Logging Skill

## Key Concept

OCP app logs are usually NOT in the default GCP bucket. They live in dedicated
OCP log buckets that MUST be specified with `--bucket`, `--location=global`,
and `--view=_AllLogs` flags. Ask the user (or check your project's runbook/
`gcloud logging buckets list --project=<GCP_PROJECT_ID>`) for the concrete
project ID and bucket name per environment before running queries - do not
guess them.

## Environment Reference (fill in for your app)

| Env  | GCP Project      | Bucket           |
|------|------------------|------------------|
| Prod | `<GCP_PROJECT_ID>` | `<PROD_BUCKET>` |
| QA   | `<GCP_PROJECT_ID>` | `<QA_BUCKET>`   |
| Stg  | `<GCP_PROJECT_ID>` | `<STG_BUCKET>`  |

## Command Template

```bash
gcloud logging read '<FILTER>' \
  --project=<GCP_PROJECT_ID> \
  --bucket=<BUCKET_NAME> \
  --location=global \
  --view=_AllLogs \
  --limit=<N> \
  --format=json \
  --freshness=<DURATION>
```

## Required Filters (ALWAYS include)

Scope every query to your app's namespace and workload, or results include
unrelated logs from the whole bucket:

- `jsonPayload.kubernetes.namespace_name="<K8S_NAMESPACE>"`
- `jsonPayload.kubernetes.labels.app_kubernetes_io_name="<APP_LABEL>"`

Alternative to the label filter: `jsonPayload.kubernetes.container_name="<CONTAINER_NAME>"`

## Additional Filters

- By log/error code: `jsonPayload.message=~"<CODE>"`
- By an app-specific identifier (order/cart/request ID): `jsonPayload.message=~"<ID_KEY>=<ID_VALUE>"`
- By API path: `jsonPayload.message=~"<PATH>"`
- By status: `jsonPayload.message=~""status":<CODE>"`
- Combine with AND: `filter1 AND filter2`

## Query Tips

- **Check whether `jsonPayload.message` is double-encoded** - some pino-style
  loggers stringify JSON into that field, so the human-readable text and any
  error code live in a NESTED `.message`. If so, extract with
  `jq '.jsonPayload.message | fromjson | .message'`.
- **Prefer `SEARCH("...")` over `jsonPayload.message=~"..."`** - `SEARCH()` is
  index-backed (fast even on zero matches) and covers all fields; the `=~`
  regex scans only that one field and can be far slower over long windows.
- **Severity is the top-level, indexed `severity` field** - use
  `severity>=ERROR` instead of a regex over the message.
- **Isolate app logs** - an OCP bucket often also holds non-application logs
  (e.g. k8s audit). Add `jsonPayload.log_type="application"` and/or
  `jsonPayload.log_source="container"` if present.
- **Confirm the right view** - `_AllLogs` is a common OCP view name, but
  verify it matches what your bucket actually exposes.
- Note any environment-suffix convention your namespaces/buckets use (e.g.
  separate bucket names per env) so prod/QA/stg queries don't get crossed.

Noisiest-codes one-liner (read-only, once you know your code prefix, e.g. `<CODE_PREFIX>`):

```bash
gcloud logging read '<FILTER> AND SEARCH("<CODE_PREFIX>")' \
  --project=<GCP_PROJECT_ID> --bucket=<BUCKET_NAME> --location=global --view=_AllLogs \
  --limit=1000 --format=json \
| jq -r '.[].jsonPayload.message | fromjson | .message' \
| grep -oE '<CODE_PREFIX>-[A-Z]+-[0-9]{3}' | sort | uniq -c | sort -rn
```

## Large Result Workflow

1. Save to file: append `> /tmp/logs_investigation.json`
2. Check truncation: if result count == `--limit`, there may be more
3. Parse with `jq` for patterns

## Auth Recovery

If queries fail with auth errors:
```bash
gcloud auth login --update-adc
gcloud config set project <GCP_PROJECT_ID>
```

## Example

```bash
gcloud logging read 'jsonPayload.message=~"<CODE>" AND jsonPayload.kubernetes.labels.app_kubernetes_io_name="<APP_LABEL>"' \
  --project=<GCP_PROJECT_ID> \
  --bucket=<QA_BUCKET> \
  --location=global --view=_AllLogs \
  --limit=10 --format=json --freshness=7d
```

## Rules

- Read-only - never modify GCP resources.
- Always include `--limit` to avoid pulling excessive data.
- Prefer QA/staging for investigation if the issue reproduces there.
- Bucket retention caps how far back `--freshness` can reach - confirm your bucket's retention window before assuming a longer lookback is possible.
