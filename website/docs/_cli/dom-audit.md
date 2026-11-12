`memlab dom-audit` counts the elements that are in the document in one snapshot, by tag.

- The first line gives the number and size of the attached elements, plus the per-element style and data objects the browser keeps for them. Detached elements are not counted. Use [`memlab analyze detached-DOM`](./analyze.md#memlab-analyze-detached-dom) for those.
- The first table counts elements by tag.
- `Elements repeated 20 or more times` lists elements that appear in large numbers. Long lists are candidates for virtualization, which renders only the rows on screen.

This snapshot was taken while the settings dialog was open. Its 240 rows make `div` the most common element, and they show up as a candidate for virtualization.
