---
title: memlab help
sidebar_label: help
custom_edit_url: null
---

List all MemLab CLI commands or print helper text for a specific command

```bash
memlab help <COMMAND> [SUB-COMMANDS]
```

## Example output

```text
$ memlab help find-leaks

  memlab find-leaks
  Find memory leaks in heap snapshots

    There are three ways to specify inputs for the `memlab find-leaks` command:
     1. `--baseline`, `--target`, `--final` specifies each heap snapshot input individually;
     2. `--snapshot-dir` specifies the directory that contains all three heap snapshot files (MemLab will assign
    baseline, target, and final based on alphabetic order of the file);
     3. `--work-dir` specifies the output working directory of the `memlab run` or the `memlab snapshot` command;

    Please only use one of the three ways to specify the input.

    You can also manually take heap snapshots in Chrome Devtools, save them to disk.
    Then process them using this command with the CLI flags (either option 1
    or option 2 mentioned above).

  COMMAND LINE OPTIONS

                              --baseline set file path of the baseline heap snapshot

                                --target set file path of the target heap snapshot

                                 --final set file path of the final heap snapshot

                          --snapshot-dir set directory path containing all heap snapshots under analysis

                                --engine set the JavaScript engine (default to V8)

                           --leak-filter specify a definition JS file for leak filter

               --trace-object-size-above objects with retained size (bytes) bigger than the threshold will be considered
                                         as leaks

        --ignore-leak-cluster-size-below ignore memory leaks with aggregated retained size smaller than the threshold
                                         (in bytes)

                     --trace-all-objects dump retainer trace for all allocated objects (ignore the leak filter),
                                         available option modes: --trace-all-objects=selected-js-objects,
                                         --trace-all-objects=default

    --save-trace-as-unclassified-cluster dump each retainer trace as an unclassified trace cluster

                         --ml-clustering use machine learning algorithms for clustering leak traces (by default, traces
                                         are clustered by heuristics)

                   --ml-linkage-max-dist set linkage max distance value for clustering. The value should be between [0,
                                         1] inclusive.

                  --ml-clustering-max-df set percentage based max document frequency for limiting the terms that appear
                                         too often

                     --clean-up-snapshot clean up heap snapshots after running

                              --work-dir set the working directory of the current run

      --heap-parser-dict-fast-store-size the size threshold for switching from fast store to slower store in the heap
                                         snapshot parser. The default value is 5,000,000. If you get the `FATAL ERROR:
                                         invalid table size Allocation failed - JavaScript heap out of memory` error,
                                         try to decrease the threshold here

                              --help, -h print helper text

                           --verbose, -v show more details

                                    --sc set to continuous test mode

                                 --debug enable manual debugging

                            --silent, -s mute all terminal output
```

## Options

The [universal options](./CLI-commands.md#universal-options) (`--help`, `--verbose`, ...) work with this command too.
