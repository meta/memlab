`memlab analyze object-size` lists the objects with the largest retained size. Objects retained by a larger object in the list are left out, so each line is a separate chunk of memory.

Each line is `@id type name: N edges, retained size, refs: [...]`, where `refs` lists the names of the references that point to the object. Here the top entry is an 800KB `Array` referenced as `history`: the history array of a settings dialog that was closed but is still in memory.
