`memlab anonymize` writes a copy of a snapshot with the string values replaced, so the snapshot can be shared without the data the app stored. The structure of the heap (objects, references, sizes) is kept, so the copy can still be analyzed.

- `What was removed` counts the redacted strings. Some are redacted because their content looks sensitive, like DOM text or long runs of digits.
- `Still in the clear` lists the property names and labels that were kept because they look like code identifiers, grouped by shape (`a` for a lowercase run, `A` for an uppercase run, `d` for digits). Review this list before sharing the file. If any of them is a name from your app that should not be shared, anonymize again from the API with a `shouldRedact` callback.
