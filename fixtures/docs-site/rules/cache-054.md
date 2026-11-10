# Rule cache-054

Reports when a release uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `cache` |
| Severity | `info` |
| Limit | 44 |

## Fix

Change the release so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule cache-054
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
