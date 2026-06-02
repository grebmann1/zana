import * as fs from "node:fs";
import * as path from "node:path";

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function scaffold(name, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  const displayName = name
    .split("-")
    .map(capitalize)
    .join(" ");

  const pluginJson = {
    id: name,
    name: displayName,
    version: "0.1.0",
    main: "index.js",
  };

  const packageJson = {
    name: `swarm-plugin-${name}`,
    version: "0.1.0",
    main: "index.js",
    dependencies: {
      "@zana-ai/sdk": "^0.1.0",
    },
  };

  const indexJs = `const { definePlugin } = require("@zana-ai/sdk/plugin");

module.exports = definePlugin({
  id: "${name}",
  name: "${displayName}",
  version: "0.1.0",

  activate({ swarm, logger }) {
    logger.info("Plugin activated");

    return swarm.events.on("agent:spawned", (event) => {
      logger.info(\`Agent spawned: \${event.payload.profileName || event.source}\`);
    });
  },
});
`;

  fs.writeFileSync(path.join(targetDir, "plugin.json"), JSON.stringify(pluginJson, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(targetDir, "package.json"), JSON.stringify(packageJson, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(targetDir, "index.js"), indexJs, "utf8");
}

