# Rule secrets-054

Reports when a manifest points at nothing.

## Details

| Property | Value |
| --- | --- |
| Category | `secrets` |
| Severity | `error` |
| Limit | 8 |

## Fix

Change the manifest so it no longer points at nothing, then run `beacon doctor` again.

```bash
beacon doctor --rule secrets-054
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
