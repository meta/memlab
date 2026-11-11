---
title: memlab anonymize
sidebar_label: anonymize
custom_edit_url: null
---

Remove user data from a heap snapshot so it can be shared

```bash
memlab anonymize --snapshot <HEAP_SNAPSHOT_FILE> --output <OUTPUT_FILE>
```

## Examples

```bash
memlab anonymize --snapshot <HEAP_SNAPSHOT_FILE> --output <OUTPUT_FILE> --anonymize-salt <SALT>
memlab anonymize --snapshot <HEAP_SNAPSHOT_FILE> --audit-only
```

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--output`**: set file path to write the anonymized heap snapshot to
 * **`--anonymize-mode`**: set how redacted text is generated: `stable` (default) keeps distinct values distinct so duplication analysis stays accurate, `uniform` replaces every character with ?
 * **`--anonymize-salt`**: set a salt for the replacement text. Without one the mapping is the same in every capture, which keeps a set of snapshots comparable but lets anyone holding a candidate value confirm it. Use the SAME salt for every file in a set
 * **`--audit-only`**: report what would be redacted and what would be left in the clear, without writing a file. Use it on a capture someone already anonymized to check whether anything was missed

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
