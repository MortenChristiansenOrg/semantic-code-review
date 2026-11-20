// Creates the repositories the real-viewer browser tests review. Run with
// `node --import tsx real-viewer-fixture.mjs <spec-json>`; prints their roots as JSON.
// The spec names the review home and, per repository, its title and the port
// its viewer will use, which the Markdown file links to.
import fs from "node:fs";
import path from "node:path";
import { beginStage, createRepository, finalizeStage, initializeImplementation } from "../helpers/repository.mjs";

const { home, reviews } = JSON.parse(process.argv[2]);
// The helper chooses its own review home; the viewers must use the spec's.
process.env.SEMANTIC_FLOW_HOME = home;
// The caller removes the repositories.
const owner = { after() {} };
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const roots = reviews.map(({ id, title, port }) => {
  const repository = createRepository(owner, `real-viewer-${id}-`);
  initializeImplementation(repository, { implementationId: id, title });
  beginStage(repository);
  fs.writeFileSync(path.join(repository.root, "pixel.png"), pixel);
  repository.git("add", "pixel.png");
  finalizeStage(repository, {
    file: "guide.md",
    contents: `# Guide\n\n![Own address](http://127.0.0.1:${port}/api/whoami)\n\n![Pixel](pixel.png)\n\n[Own link](http://127.0.0.1:${port}/)\n`,
  });
  return repository.root;
});
console.log(JSON.stringify(roots));
