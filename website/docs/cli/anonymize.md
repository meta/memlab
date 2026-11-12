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

## Example output

```text
$ memlab anonymize --snapshot /tmp/memlab-example/leak/data/cur/s3.heapsnapshot --output /tmp/memlab-example/tmp/anonymized.heapsnapshot
Anonymized snapshot written
  from  /tmp/memlab-example/leak/data/cur/s3.heapsnapshot (3.3 MB)
  to    /tmp/memlab-example/tmp/anonymized.heapsnapshot (3.3 MB)
What was removed
  6,678 string values redacted   (the text your app stored — names, messages, tokens)
  55 more redacted because their CONTENT looked sensitive:
      dom-text           37
      digit-run          18
  3,595 entries split so a structural label could be kept readable
  out of 18,987 strings in the capture; mode "stable"
Still in the clear — review before sharing
  These are property names and labels, NOT string values — they were kept because
  they look like code identifiers. Any that is an identifier in YOUR application
  is a residual: anonymize again from the API with a `shouldRedact` callback.

  Grouped by SHAPE, where a=lowercase run, A=uppercase, d=digits — so "a$d"
  covers require$$99, module$42, and anything else like them.

    count  shape                 examples
      501  a a                   heap number, private symbol, set scrollbars
      340  a / Aa / AaAaAa (a)   system / Code / CallBoundFuncti..., system / Code / CallWrappedFunc..., system / Code / CallWithSpread ...
      238  a aAa                 get visualViewport, get lastParen, get parentNode
      236  a / AaAaAa / a        system / SharedFunctionInfo / c..., system / SharedFunctionInfo / c..., system / SharedFunctionInfo / v...
      232  a / Aa / AaAaAaAaAaA  system / Code / InterpreterForw..., system / Code / InterpreterPush..., system / Code / CallApiCallback...
      219  a / Aa / AaAaAaAa (a  system / Code / CallFunctionFor..., system / Code / ConstructForwar..., system / Code / InterpreterEnte...
      212  a / Aa / AaAaAaAa (a  system / Code / CallWithArrayLi..., system / Code / ConstructWithAr..., system / Code / StartMaglevOpti...
      207  a / Aa / AaAa (a)     system / Code / CallProxy (buil..., system / Code / CallVarargs (bu..., system / Code / ConstructFuncti...
      207  a / Aa / AaAaAaAaAa   system / Code / StringGreaterTh..., system / Code / OrderedHashTabl..., system / Code / InterpreterPush...
      194  a / AaAaAa / aAa      system / SharedFunctionInfo / c..., system / SharedFunctionInfo / v..., system / SharedFunctionInfo / g...
      127  a:AaAaAa              gin::PerContextData, blink::LongTaskDetector, blink::DevToolsSession
      123  a / AaAaAa / aAaAa    system / SharedFunctionInfo / t..., system / SharedFunctionInfo / a..., system / SharedFunctionInfo / r...
```

## How to read the output

`memlab anonymize` writes a copy of a snapshot with the string values replaced, so the snapshot can be shared without the data the app stored. The structure of the heap (objects, references, sizes) is kept, so the copy can still be analyzed.

- `What was removed` counts the redacted strings. Some are redacted because their content looks sensitive, like DOM text or long runs of digits.
- `Still in the clear` lists the property names and labels that were kept because they look like code identifiers, grouped by shape (`a` for a lowercase run, `A` for an uppercase run, `d` for digits). Review this list before sharing the file. If any of them is a name from your app that should not be shared, anonymize again from the API with a `shouldRedact` callback.

## Options

 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--output`**: set file path to write the anonymized heap snapshot to
 * **`--anonymize-mode`**: set how redacted text is generated: `stable` (default) keeps distinct values distinct so duplication analysis stays accurate, `uniform` replaces every character with ?
 * **`--anonymize-salt`**: set a salt for the replacement text. Without one the mapping is the same in every capture, which keeps a set of snapshots comparable but lets anyone holding a candidate value confirm it. Use the SAME salt for every file in a set
 * **`--audit-only`**: report what would be redacted and what would be left in the clear, without writing a file. Use it on a capture someone already anonymized to check whether anything was missed

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
