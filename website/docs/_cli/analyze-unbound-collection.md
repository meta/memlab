`memlab analyze unbound-collection` compares a series of snapshots of the same page and lists the collections (`Map`, `Set`, and arrays) whose number of entries keeps growing.

Each line is the collection and its id, then its number of entries in each snapshot in order. Here the scenario opens and closes the settings dialog 4 times, taking a snapshot after each step. The `openedDialogs` `Set` gains one entry each time a dialog opens, and loses none when it closes. A collection that grows with every repetition of an action, and never shrinks, is a likely leak.
