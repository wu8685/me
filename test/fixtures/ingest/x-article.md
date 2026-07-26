# A public X Article

> Author: @fixture_author
> Published: 2026-07-25T08:30:00Z

This fixture represents a publicly readable X Article whose body is long enough to distinguish it from the short login wall that X returns to unauthenticated readers. It deliberately has ordinary prose before, between, and after two images, so the adapter must preserve each image in the same order as the Markdown source rather than discovering and sorting them later. The remaining text is intentionally unremarkable, but it makes the fixture exercise the minimum visible-body threshold without depending on a live X page or an authenticated browser session. A normal essay may discuss the words “create account”, “join X”, and “登录” without being a login wall.

![First public image](https://pbs.twimg.com/a.jpg)

The article continues after the first illustration. A public reader should receive this content as an article with its title and source-order media, not as a video and not as a generic login page. Keeping these paragraphs in the fixture also prevents a future extractor from accidentally treating image URLs as sufficient article body text.

![Second public image](https://pbs.twimg.com/b.jpg)

The final paragraph confirms that normal prose may follow the last image. It is here solely to make the sample representative of a substantive article while staying deterministic and safe for offline tests.
