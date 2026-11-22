// Creates the repositories the real-viewer browser tests review. Run with
// `node --import tsx real-viewer-fixture.mjs <spec-json>`; prints their roots as JSON.
// The spec names the review home and, per repository, its title and the port
// its viewer will use, which the Markdown file links to. A review with
// `rename` instead has a stage that renames old.txt to new.txt and changes its
// second line.
import fs from "node:fs";
import path from "node:path";
import { beginStage, createRepository, finalizeStage, initializeImplementation, organizeStage } from "../helpers/repository.mjs";

const { home, reviews } = JSON.parse(process.argv[2]);
// The helper chooses its own review home; the viewers must use the spec's.
process.env.SEMANTIC_FLOW_HOME = home;
// The caller removes the repositories.
const owner = { after() {} };
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const roots = reviews.map(({ id, title, port, rename }) => {
  const repository = createRepository(owner, `real-viewer-${id}-`);
  if (rename) {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`);
    repository.commitFile("old.txt", lines.join(""), "Add file");
    initializeImplementation(repository, { implementationId: id, title });
    beginStage(repository);
    repository.git("mv", "old.txt", "new.txt");
    repository.commitFile("new.txt", lines.map((line, index) => index === 1 ? "line two\n" : line).join(""), "Rename and change file");
    organizeStage(repository);
    repository.semantic("stage", "finish", "--id", "implementation");
    repository.feedback("init");
    return repository.root;
  }
  initializeImplementation(repository, { implementationId: id, title });
  beginStage(repository);
  fs.writeFileSync(path.join(repository.root, "pixel.png"), pixel);
  repository.git("add", "pixel.png");
  finalizeStage(repository, {
    file: "guide.md",
    contents: `# Guide\n\n![Own address](http://127.0.0.1:${port}/api/whoami)\n\n![Mapped address](http://[::ffff:127.0.0.1]:${port}/api/whoami)\n\n![Dotted address](http://localhost.:${port}/api/whoami)\n\n![Pixel](pixel.png)\n\n[Own link](http://127.0.0.1:${port}/)\n`,
  });
  return repository.root;
});
console.log(JSON.stringify(roots));
