# Subfolder fixture

A small repository whose site lives in `docs/`, the layout Evergreen uses: the repository root holds `docs/`, and
`docs/` holds the config and the pages. Tests build `docs/` as the site root and read paths from the repository root.

This file is here so the repository root has a file of its own: nothing under `docs/` may describe it.
