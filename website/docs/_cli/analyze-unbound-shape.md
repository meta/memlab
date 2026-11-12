`memlab analyze unbound-shape` compares a series of snapshots of the same page and lists the shapes (class and property names) whose total retained size keeps growing.

Each line is the shape, its number of objects and total retained size in each snapshot in order, and one example object id per snapshot. In this example, after the first time the dialog opens, strings grow by 240 every time it opens again: the dialog's row labels, which are still in memory after it closes.
