# Rule network-006

Reports when a release uses a deprecated form.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `info` |
| Limit | 4 |

## Fix

Change the release so it no longer uses a deprecated form, then run `beacon doctor` again.

```bash
beacon doctor --rule network-006
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
