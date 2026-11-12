`memlab analyze unbound-object` compares a series of snapshots of the same page and lists the objects whose retained size keeps growing.

Each line is the object and its id, then its retained size in each snapshot in order. In this example, the global object grows once, between the first and the second snapshot, and then stays flat. That is one-time setup, not a leak. A leak keeps growing with every repetition of the same action.
