`memlab analyze object-shallow` finds objects with the same class and the same top-level keys and values, without comparing nested objects. Duplicated objects are candidates for sharing one instance.

- `All objects` gives the number and size of the objects compared, and how much of it is duplicated.
- `Top duplicated objects in count` shows `[number of copies, total size]` and the object, serialized. References to other objects appear as `REFERENCE_<id>`.
- `Top duplicated objects in size` shows `[total size, number of copies]` and some `node examples` to look at with [`memlab analyze object`](#memlab-analyze-object).

This small app has almost no duplication (0.06% of the size). The duplicated objects are empty objects and DOM wrappers.
