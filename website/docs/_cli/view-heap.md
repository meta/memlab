`memlab view-heap` opens an interactive viewer in the terminal. It starts with a list of objects worth a look: the detached DOM elements and the objects with the largest retained size. Press a number to move to a panel, the arrow keys to move within it, and Enter to select an object. The panels are:

1. **Referrers** of the selected object, i.e. what references it. Here these are the 240 rows, the close button, and other objects that point back to the dialog's `<div class="settings">`.
2. **Objects**, the starting list. Each entry is tagged with why it is listed, like `[Detached]`.
3. **Clustered Objects**, similar objects grouped together.
4. **References** of the selected object, i.e. what it references.
5. **Object**: details of the selected object, including its retained size, its numbers of references and referrers, and its dominator (the closest object that every path from a GC root goes through).
6. **Retainer Trace**: the chain of references that keeps the selected object alive. Here it goes through the global `openedDialogs` `Set`.

Selecting an object in panels 1, 4, or 6 makes it the selected object, so you can follow references in both directions.
