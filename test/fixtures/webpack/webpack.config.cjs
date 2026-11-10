const path = require("node:path");

module.exports = {
  mode: "production",
  entry: path.join(__dirname, "entry.js"),
  output: { path: path.join(__dirname, "out"), clean: true },
  target: "web",
};
