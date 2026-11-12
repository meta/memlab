`memlab native-contexts` groups the heap by native context. A native context is a JavaScript realm: the main page and each iframe or worker realm has its own global object and built-ins.

- `owned` is the memory reachable only from that realm, and `share` is its part of the whole heap. `objects` is the number of objects it owns.
- `detached` marks a realm whose document is gone (for example, a removed iframe). Memory owned by a detached realm is usually a leak.
- `(shared by several realms)` is memory reachable from more than one realm, and `(no realm: engine internals)` belongs to the engine itself.

In this example, two realms have the page's URL: the page itself and an isolated realm that the browser automation (Puppeteer) adds to it. Neither is detached.
