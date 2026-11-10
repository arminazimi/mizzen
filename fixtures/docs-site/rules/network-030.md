# Rule network-030

Reports when a hook is duplicated.

## Details

| Property | Value |
| --- | --- |
| Category | `network` |
| Severity | `error` |
| Limit | 14 |

## Fix

Change the hook so it no longer is duplicated, then run `beacon doctor` again.

```bash
beacon doctor --rule network-030
```

See [all rules](./index.md) or the [doctor command](../reference/doctor.md).
