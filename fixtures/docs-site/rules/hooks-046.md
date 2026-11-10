# Rule hooks-046

Reports when a cache entry uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `hooks` |
| Severity | `error` |
| Limit | 79 |

## Fix

Change the cache entry so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule hooks-046
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
