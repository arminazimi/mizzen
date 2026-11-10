# Rule secrets-027

Reports when a hook uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `warning` |
| Limit | 22 |

## Fix

Change the hook so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-027
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
